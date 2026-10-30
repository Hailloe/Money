#!/usr/bin/env python3
"""
5 年回测：用 5 只推荐基金的真实复权净值，比较几种买法，结果写到 data/backtest.json。

在 GitHub Actions 里手动运行（Actions → “5 年回测” → Run workflow），沙盒和浏览器连不上数据源。
本地没网时可以加 --offline，用 data/data.json 里 3 年的周净值试跑（只用来检查代码）。

比较的买法（每月定投 1000 元，平衡档：宽基 37 / 红利低波 23 / 标普 10.5 / 纳指 4.5 / 债券 25）：
  cash      全放货币基金（年化按 1.5%）
  fixed     按比例每月定投，什么都不管
  rebal     按比例每月定投，每年再平衡一次
  rules     接近网站规则：估值分位定倍数、超配不买并分批减仓、很贵且赚 50% 分批止盈、
            少买的钱留在银行卡（年化 0.3%），攒多了每月最多投回一个月的定投额
  rules_cap 同上，但标普每月最多买 2000、纳指每月最多买 200（按现在的限购）
  lump      一开始把 60 个月的钱一次买进，每年再平衡
估值分位用蛋卷的历史市盈率，在每个月只用“当时以前”的数据算（不偷看未来）。
红利低波没有历史息差，用它自己的市盈率分位代替。拿不到估值历史时，rules 按 1 倍买（会在结果里注明）。
"""
import datetime
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import update_data as U  # noqa: E402  复用抓取、复权的代码

OUT = os.path.join(U.ROOT, 'data', 'backtest.json')
MONTHS = 60
MONTHLY = 1000.0
PICKS = [  # 代码, 类别, 在组合里的比例(%), 估值用哪个指数
    ('460300', 'index', 37.0, 'hs300'),
    ('007466', 'div', 23.0, 'divLowVol'),
    ('050025', 'overseas', 10.5, 'sp500'),
    ('161130', 'overseas', 4.5, 'ndx'),
    ('007901', 'bond', 25.0, None),
]
CAT_T = {'index': 37.0, 'div': 23.0, 'overseas': 15.0, 'bond': 25.0}
VAL_CODES = {'hs300': 'SH000300', 'divLowVol': 'CSIH30269', 'sp500': 'SP500', 'ndx': 'NDX'}
CAPS = {'050025': 2000.0, '161130': 200.0}
BUY_FEE = {'index': 0.0012, 'div': 0.0012, 'overseas': 0.0012, 'bond': 0.0008}
SELL_FEE = {'index': 0.0025, 'div': 0.0025, 'overseas': 0.0025, 'bond': 0.0}   # 持有一两年以上大多 0.25% 或更低
CASH_RATE, BANK_RATE = 0.015, 0.003
PE_TIERS = [(20, 2.0, False), (40, 1.5, False), (60, 1.0, False), (80, 0.5, False), (101, 0.5, True)]  # 和 config.js 一样


# ---------- 数据 ----------
def fetch_navs(offline):
    navs, notes = {}, []
    if offline:
        d = U.load(U.DATA, {})
        by = {f['code']: f for f in d.get('funds', [])}
        for code, *_ in PICKS:
            navs[code] = [(datetime.date.fromisoformat(a), float(b)) for a, b in by[code]['curve']]
        notes.append('离线试跑：只用了 data.json 里 3 年的周净值，结果不能当真')
        return navs, notes
    for code, *_ in PICKS:
        src = U.get(f'https://fund.eastmoney.com/pingzhongdata/{code}.js?v={int(datetime.datetime.now().timestamp())}')
        nav = U.js_var(src, 'Data_netWorthTrend') or []
        acc = U.js_var(src, 'Data_ACWorthTrend') or []
        navs[code] = U.adjusted_series(nav, acc)
    return navs, notes


def find_pe_points(obj):
    """蛋卷返回的结构可能变；在 JSON 里找带 pe 和 ts 的列表。"""
    if isinstance(obj, list) and obj and all(isinstance(x, dict) for x in obj[:5]):
        if all('pe' in x and 'ts' in x for x in obj[:5]):
            return obj
    if isinstance(obj, dict):
        for v in obj.values():
            r = find_pe_points(v)
            if r:
                return r
    if isinstance(obj, list):
        for v in obj:
            r = find_pe_points(v)
            if r:
                return r
    return None


def fetch_pe_hist(offline):
    hist, notes = {}, []
    if offline:
        notes.append('离线试跑：没有估值历史，规则版按 1 倍买')
        return hist, notes
    for k, code in VAL_CODES.items():
        try:
            src = U.get(f'https://danjuanfunds.com/djapi/index_eva/pe_history/{code}?day=all', referer='https://danjuanfunds.com/djmodule/value-center')
            pts = find_pe_points(json.loads(src))
            if not pts:
                raise ValueError('没找到 pe/ts 列表，返回开头：' + src[:200])
            s = sorted((U.ms_to_date(int(p['ts'])), float(p['pe'])) for p in pts if p.get('pe') not in (None, '') and float(p['pe']) > 0)
            if len(s) < 200:
                raise ValueError(f'只有 {len(s)} 个点')
            hist[k] = s
        except Exception as e:  # noqa: BLE001
            notes.append(f'{k} 估值历史没抓到（{str(e)[:120]}），规则版里这一类按 1 倍买')
    return hist, notes


def value_at(series, day):
    """当天或之前最近的值。"""
    lo, hi, v = 0, len(series) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        if series[mid][0] <= day:
            v = series[mid][1]
            lo = mid + 1
        else:
            hi = mid - 1
    return v


def pe_pct(hist, k, day):
    """day 当天的市盈率在过去最多 10 年里的分位（只用当时以前的数据，至少 3 年）。"""
    s = hist.get(k)
    if not s:
        return None
    start = day - datetime.timedelta(days=3652)
    past = [v for d, v in s if start <= d < day]   # 定投日当天收盘的估值还不知道，只用前一天及以前的
    if len(past) < 250 or (day - s[0][0]).days < 365 * 3:
        return None
    now = past[-1]
    return 100.0 * sum(1 for v in past if v < now) / len(past)


def mult(pct):
    if pct is None:
        return 1.0, False
    for below, m, top in PE_TIERS:
        if pct < below:
            return m, top
    return 0.5, True


# ---------- 账户 ----------
class Acct:
    def __init__(self):
        self.units = {c: 0.0 for c, *_ in PICKS}
        self.cost = {c: 0.0 for c, *_ in PICKS}
        self.bank = 0.0
        self.flows = []   # (date, -投入 / +取出)
        self.fees = 0.0

    def value(self, px):
        return sum(self.units[c] * px[c] for c in self.units)

    def buy(self, c, cat, amt, px):
        if amt <= 0.005:
            return
        fee = amt * BUY_FEE[cat] / (1 + BUY_FEE[cat])   # 申购费是外扣法
        self.units[c] += (amt - fee) / px[c]
        self.cost[c] += amt
        self.fees += fee

    def sell(self, c, cat, amt, px):
        amt = min(amt, self.units[c] * px[c])
        if amt <= 0.005:
            return 0.0
        frac = amt / (self.units[c] * px[c])
        self.units[c] -= amt / px[c]
        self.cost[c] *= (1 - frac)
        fee = amt * SELL_FEE[cat]
        self.fees += fee
        return amt - fee


def xirr(flows):
    """flows: [(date, amount)]，投入为负、期末市值为正。"""
    if not flows:
        return None
    d0 = flows[0][0]
    ts = [((d - d0).days / 365.0, v) for d, v in flows]
    f = lambda r: sum(v / (1 + r) ** t for t, v in ts)  # noqa: E731
    lo, hi = -0.95, 3.0
    if f(lo) * f(hi) > 0:
        return None
    for _ in range(200):
        mid = (lo + hi) / 2
        if f(lo) * f(mid) <= 0:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


# ---------- 模拟 ----------
def trading_days(navs):
    """以沪深300联接的交易日为准；海外基金净值晚一天公布，用当天或之前最近的净值。"""
    first = max(s[0][0] for s in navs.values())
    return [d for d, _ in navs['460300'] if d >= first]


def run(kind, navs, hist, days, start_idx, same_flows=None, months=None, stop=None):
    months = months or MONTHS
    a = Acct()
    sim_days = days[start_idx:]
    month_days, seen = [], set()
    for d in sim_days:  # 每月 10 号或之后第一个交易日定投
        key = (d.year, d.month)
        if key not in seen and d.day >= 10:
            seen.add(key)
            month_days.append(d)
    month_days = month_days[:months]
    mset = set(month_days)
    last_rebal, curve = None, []
    cash_val = 0.0
    prev = None
    for d in sim_days:
        if stop and d > stop:
            break
        px = {c: value_at(navs[c], d) for c in navs}
        # 银行卡、货币基金按天计息
        if prev:
            dt = (d - prev).days / 365.0
            a.bank *= (1 + BANK_RATE) ** dt
            cash_val *= (1 + CASH_RATE) ** dt
        prev = d
        if d in mset:
            i = month_days.index(d)
            if kind == 'cash':
                cash_val += MONTHLY
                a.flows.append((d, -MONTHLY))
            elif kind == 'lump':
                if i == 0:
                    tot = MONTHLY * len(month_days)  # noqa
                    a.flows.append((d, -tot))
                    for c, cat, w, _ in PICKS:
                        a.buy(c, cat, tot * w / 100, px)
                    last_rebal = d
            elif kind == 'fixed_same':
                amt = same_flows.get(d, 0.0)
                a.flows.append((d, -amt))
                for c, cat, w, _ in PICKS:
                    a.buy(c, cat, amt * w / 100, px)
            elif kind in ('fixed', 'rebal'):
                a.flows.append((d, -MONTHLY))
                for c, cat, w, _ in PICKS:
                    a.buy(c, cat, MONTHLY * w / 100, px)
                if last_rebal is None:
                    last_rebal = d
            else:
                rules_month(a, d, px, hist, kind == 'rules_cap', i)
            if kind in ('rebal', 'lump') and last_rebal and (d - last_rebal).days >= 360:
                rebalance(a, px)
                last_rebal = d
        v = cash_val if kind == 'cash' else a.value(px) + a.bank
        curve.append((d, v))
    end = curve[-1]
    flows = a.flows + [(end[0], end[1])]
    invested = -sum(v for _, v in a.flows)
    r = summarize(kind, curve, flows, invested, a, end)
    r['months'] = len(month_days)
    r['flowsRaw'] = [(d, -v) for d, v in a.flows]
    return r


def rebalance(a, px):
    tot = a.value(px)
    for c, cat, w, _ in PICKS:
        want = tot * w / 100
        have = a.units[c] * px[c]
        if have > want:
            a.bank += a.sell(c, cat, have - want, px)
    for c, cat, w, _ in PICKS:
        want = tot * w / 100
        have = a.units[c] * px[c]
        if want > have and a.bank > 0:
            amt = min(a.bank, want - have)
            a.bank -= amt
            a.buy(c, cat, amt, px)


def rules_month(a, d, px, hist, capped, i):
    """接近 app.js analyze() 的简化版。"""
    fv = {c: a.units[c] * px[c] for c in a.units}
    total = sum(fv.values())
    catv = {k: 0.0 for k in CAT_T}
    for c, cat, *_ in PICKS:
        catv[cat] += fv[c]
    dev = {k: (catv[k] / total * 100 - CAT_T[k]) if total > 0 else 0.0 for k in CAT_T}
    sig = {}
    for c, cat, w, vk in PICKS:
        sig[c] = (1.0, False) if cat == 'bond' else mult(pe_pct(hist, vk, d))
    gain = {c: (fv[c] / a.cost[c] - 1) * 100 if a.cost[c] > 0 else 0.0 for c in a.units}
    no_buy = {c for c, cat, *_ in PICKS if cat != 'bond' and sig[c][1] and gain[c] >= 50}
    # 第二步：定投计划
    plan, parked, bonus, cap_pool, short = {}, 0.0, 0.0, 0.0, {k: 0.0 for k in CAT_T}
    reserve0 = a.bank   # 月初银行卡里等着投的钱（和网站一样，不含本月少买的）
    for c, cat, w, _ in PICKS:
        b = MONTHLY * w / 100
        m = sig[c][0]
        if c in no_buy or (total > 0 and dev[cat] >= 5):
            m = 0.0
        elif cat != 'bond' and total > 0 and dev[cat] <= -10 and m >= 1:
            m += 0.5
        amt = b * m
        if amt < b:
            parked += b - amt
            short[cat] += b - amt   # 估值贵少买、止盈中不买的缺口：本月不让多出来的钱补回
        else:
            bonus += amt - b
        if capped and c in CAPS and amt > CAPS[c]:
            cap_pool += amt - CAPS[c]
            amt = CAPS[c]
        plan[c] = amt
    extra = max(0.0, bonus - parked)
    from_bank = min(a.bank, extra)
    a.bank -= from_bank
    pocket = MONTHLY + (extra - from_bank)          # 便宜月份多买、银行卡里不够的部分，算你自己另外掏的钱
    a.flows.append((d, -pocket))
    for c, cat, *_ in PICKS:
        a.buy(c, cat, plan[c], px)
    a.bank += max(0.0, parked - bonus)
    # 第三步：止盈、减仓（每月卖当前超出的三分之一）
    sold = 0.0
    for c, cat, w, _ in PICKS:
        if cat != 'bond' and sig[c][1] and gain[c] >= 50:
            sold += a.sell(c, cat, fv[c] * 0.10, px)
        elif total > 0 and dev[cat] >= 5 and sig[c][0] < 1.5:
            share = fv[c] / catv[cat] if catv[cat] else 0
            sold += a.sell(c, cat, dev[cat] / 100 * total * share / 3, px)
    # 第四步：卖出的钱 + 限购剩下的 + 银行卡里该投回的，按缺口分给不贵的类别（偏贵的按倍数打折）
    reserve = max(0.0, reserve0 - from_bank)
    deploy = 0.0
    fund_total = a.value(px)
    if reserve0 >= max(100.0, 0.05 * (fund_total + reserve0)):
        deploy = min(reserve, max(MONTHLY, 500.0), max(reserve0 / 3, min(reserve0, 500.0)))
    pool = sold + cap_pool + deploy
    if pool > 0.5:
        fv2 = {c: a.units[c] * px[c] for c in a.units}
        tot2 = sum(fv2.values()) + pool
        needs = {}
        for c, cat, w, _ in PICKS:
            if sig[c][1] or c in no_buy:
                continue
            cat_have = sum(fv2[x] for x, k, *_ in PICKS if k == cat)
            cat_need = max(0.0, CAT_T[cat] / 100 * tot2 - cat_have - short[cat])
            split = w / CAT_T[cat]
            room = (CAPS[c] - plan[c]) if capped and c in CAPS else float('inf')
            needs[c] = (min(cat_need * split * min(1.0, sig[c][0]), room), cat)
        want = sum(n for n, _ in needs.values())
        used = 0.0
        if want > 0:
            k = min(1.0, pool / want)
            for c, (n, cat) in needs.items():
                amt = n * k
                a.buy(c, cat, amt, px)
                used += amt
        left = pool - used
        # 先用卖出的钱，再用限购剩下的，最后用银行卡的；没用完的回到银行卡
        from_sells = min(sold, used)
        rest = used - from_sells
        cap_used = min(cap_pool, rest)
        dep_used = rest - cap_used
        a.bank -= dep_used
        a.bank += (sold - from_sells)
        a.bank += (cap_pool - cap_used)
        # 限购剩下的钱本来就是这个月的定投钱，没用掉就留在银行卡
        del left
    a.bank = max(0.0, a.bank)


def summarize(kind, curve, flows, invested, a, end):
    r = xirr(flows)
    # 按“份额净值”算最大回撤：扣掉每次投入的影响
    nav, units, peak, mdd = 1.0, 0.0, 1.0, 0.0
    fl = {d: -v for d, v in flows[:-1]}
    tw, prev_v = [], None
    for d, v in curve:
        inflow = fl.get(d, 0.0)
        if prev_v is not None and prev_v > 0:
            nav *= (v - inflow) / prev_v
        prev_v = v
        tw.append((d, nav))
        peak = max(peak, nav)
        mdd = min(mdd, nav / peak - 1)
    worst12 = None
    for i, (d, v) in enumerate(tw):
        j = next((k for k in range(i, len(tw)) if (tw[k][0] - d).days >= 365), None)
        if j is not None:
            x = tw[j][1] / v - 1
            worst12 = x if worst12 is None else min(worst12, x)
    # 账户最多浮亏（市值比累计投入少多少）
    acc_in, worst_float = 0.0, 0.0
    for d, v in curve:
        acc_in += fl.get(d, 0.0)
        if acc_in > 0:
            worst_float = min(worst_float, v / acc_in - 1)
    years = {}
    for d, v in tw:
        years.setdefault(d.year, [v, v])[1] = v
    yr, base = {}, 1.0
    for y in sorted(years):   # 用上一年最后一天做基数，不漏掉跨年那天的涨跌
        yr[y] = round((years[y][1] / base - 1) * 100, 1)
        base = years[y][1]
    span = (tw[-1][0] - tw[0][0]).days / 365.25 if len(tw) > 1 else 0
    twr = (tw[-1][1] ** (1 / span) - 1) * 100 if span > 0 else None
    # 期末总财富：假设所有要投的钱一开始都在货币基金里，没投出去之前按 1.5% 计息（这样一次性买入和定投才能比）
    t0 = flows[0][0]
    wait_interest = sum(-v * ((1 + CASH_RATE) ** ((d - t0).days / 365.0) - 1) for d, v in flows[:-1])
    return {
        'kind': kind,
        'xirr': None if r is None else round(r * 100, 2),
        'invested': round(invested),
        'final': round(end[1]),
        'gain': round(end[1] - invested),
        'maxDd': round(mdd * 100, 1),
        'worst12m': None if worst12 is None else round(worst12 * 100, 1),
        'worstFloat': round(worst_float * 100, 1),
        'bankEnd': round(a.bank),
        'bankShare': round(a.bank / end[1] * 100, 1) if end[1] else 0,
        'fees': round(a.fees),
        'twrAnnual': None if twr is None else round(twr, 2),
        'wealth': round(end[1] + wait_interest),
        'years': yr,
        'curve': [[d.isoformat(), round(v)] for d, v in (curve[::5] + ([curve[-1]] if (len(curve) - 1) % 5 else []))],
    }


def main():
    offline = '--offline' in sys.argv
    navs, n1 = fetch_navs(offline)
    hist, n2 = fetch_pe_hist(offline)
    days = trading_days(navs)
    if len(days) < 100:
        raise SystemExit('净值数据太少，没法回测')
    # 从最后一天往前数 MONTHS 个月开始（数据不够就从最早的共同日期开始）
    last = days[-1]
    want = datetime.date(last.year - (MONTHS // 12), last.month, 1)
    start_idx = next((i for i, d in enumerate(days) if d >= want), 0)
    notes = n1 + n2

    res = {k: run(k, navs, hist, days, start_idx) for k in ['cash', 'fixed', 'rebal', 'rules', 'rules_cap', 'lump']}
    # 公平对比：和规则版同一天、投同样多的钱，只是按固定比例买
    same = {}
    for d, v in res['rules']['flowsRaw']:
        same[d] = same.get(d, 0.0) + v
    res['fixed_same'] = run('fixed_same', navs, hist, days, start_idx, same)
    for r in res.values():
        r.pop('flowsRaw', None)
    # 滚动回测：每个季度换一个起点，各跑 3 年，看规则版和“同样的钱死定投”谁赚得多（只看一条 5 年路径不够）
    rolling = []
    y, m = days[0].year, ((days[0].month - 1) // 3) * 3 + 1
    while True:
        st = datetime.date(y, m, 1)
        stop = datetime.date(y + 3, m, 1)
        if stop > last:
            break
        si = next((i for i, d in enumerate(days) if d >= st), None)
        if si is None:
            break
        r1 = run('rules', navs, hist, days, si, months=36, stop=stop)
        sm = {}
        for d, v in r1['flowsRaw']:
            sm[d] = sm.get(d, 0.0) + v
        r2 = run('fixed_same', navs, hist, days, si, sm, months=36, stop=stop)
        rolling.append({'start': st.isoformat(), 'rules': r1['final'], 'fixedSame': r2['final'], 'invested': r1['invested'],
                        'rulesXirr': r1['xirr'], 'fixedXirr': r2['xirr'], 'diff': r1['final'] - r2['final']})
        m += 3
        if m > 12:
            y, m = y + 1, m - 12
    nm = res['fixed']['months']
    if nm < MONTHS:
        notes.append(f'数据不够，只定投了 {nm} 个月（计划 {MONTHS} 个月）')
    notes.append('逐年收益里，第一年只有开始以后的几个月，最后一年只到数据最后一天')
    funds = {}
    for c, cat, *_ in PICKS:
        s = [(d, v) for d, v in navs[c] if d >= days[start_idx]]
        if len(s) > 2:
            yrs = (s[-1][0] - s[0][0]).days / 365.25
            funds[c] = {'annual': round(((s[-1][1] / s[0][1]) ** (1 / yrs) - 1) * 100, 1), 'maxDd': U.max_drawdown(s)}
    pe_now = {k: (round(pe_pct(hist, k, last), 1) if hist.get(k) else None) for k in VAL_CODES}
    out = {'generated': U.NOW.strftime('%Y-%m-%d %H:%M'), 'start': days[start_idx].isoformat(), 'end': last.isoformat(),
           'months': MONTHS, 'monthly': MONTHLY, 'weights': {c: w for c, _, w, _ in PICKS}, 'notes': notes,
           'peHistory': {k: [hist[k][0][0].isoformat(), hist[k][-1][0].isoformat(), len(hist[k])] for k in hist}, 'pePctNow': pe_now,
           'results': res, 'funds': funds, 'rolling3y': rolling}
    path = OUT if not offline else OUT.replace('.json', '-offline.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"回测 {out['start']} ~ {out['end']}，每月 {MONTHLY:.0f} 元")
    for n in notes:
        print('注意：', n)
    print(f"{'买法':<11}{'年化XIRR':>9}{'组合年化':>9}{'期末总财富':>10}{'投入':>9}{'期末':>9}{'最大回撤':>9}{'最差12月':>9}{'最多浮亏':>9}{'银行卡占比':>10}")
    for k, r in res.items():
        print(f"{k:<11}{str(r['xirr']):>9}{str(r['twrAnnual']):>9}{r['wealth']:>10}{r['invested']:>9}{r['final']:>9}{r['maxDd']:>9}{str(r['worst12m']):>9}{r['worstFloat']:>9}{r['bankShare']:>10}")
    for c, v in funds.items():
        print(c, v)
    print('估值历史：', out['peHistory'], '现在分位：', pe_now)
    if rolling:
        wins = sum(1 for r in rolling if r['diff'] > 0)
        print(f"滚动 3 年：{len(rolling)} 个起点，规则版赢 {wins} 次；差额 {min(r['diff'] for r in rolling)} ~ {max(r['diff'] for r in rolling)} 元")


if __name__ == '__main__':
    main()
