#!/usr/bin/env python3
"""
每天自动更新 data/data.json。由 .github/workflows/update-data.yml 在交易日收盘后运行，也可以手动运行：
    python3 scripts/update_data.py

数据来源（都是公开网页接口，不需要账号）：
  - 天天基金 pingzhongdata：基金净值历史、规模、基金经理  → 算出近1年/近3年/今年以来收益、近3年最大回撤、逐年收益
  - 蛋卷基金 指数估值：沪深300、中证A500、红利低波、标普500、纳指100 的市盈率、估值百分位、股息率
  - 东方财富 数据中心：中国 10 年期国债收益率；FRED：美国 10 年期国债收益率
  - 东方财富 行情：指数月线 → 逐年涨跌

任何一个来源失败，都保留 data.json 里上一次的数字，不会把好数据覆盖成空。
不变的信息（费率、经理任职时间、公告提示）写在 data/seed.json 里，手动维护。
"""
import json, re, os, sys, time, datetime, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data', 'data.json')
SEED = os.path.join(ROOT, 'data', 'seed.json')
CONFIG = os.path.join(ROOT, 'config.js')

UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
TZ = datetime.timezone(datetime.timedelta(hours=8))
NOW = datetime.datetime.now(TZ)
status = {}


def get(url, referer=None, timeout=20):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Referer': referer or 'https://fund.eastmoney.com/'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode('utf-8', 'replace')
        except Exception as e:  # noqa: BLE001 - network errors of every kind
            last = e
            time.sleep(2 * (attempt + 1))
    raise last


def load(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return default


def fund_codes():
    """读 config.js 里的基金代码，保证名单只在一个地方维护。"""
    with open(CONFIG, encoding='utf-8') as f:
        return re.findall(r"code:\s*'(\d{6})'", f.read())


# ---------- 基金 ----------
def js_var(src, name):
    m = re.search(r'var\s+' + re.escape(name) + r'\s*=\s*(.*?);\s*(?:/\*|var\s|$)', src, re.S)
    if not m:
        return None
    raw = m.group(1).strip()
    try:
        return json.loads(raw)
    except Exception:  # noqa: BLE001
        return raw.strip('"')


def ms_to_date(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, TZ).date()


def value_on_or_before(series, day):
    """series: [(date, value)] 升序。返回 day 当天或之前最近的值。"""
    v = None
    for d, x in series:
        if d > day:
            break
        v = x
    return v


def pct(a, b):
    return None if a is None or b in (None, 0) else round((a / b - 1) * 100, 2)


def max_drawdown(series):
    peak, mdd = None, 0.0
    for _, v in series:
        peak = v if peak is None or v > peak else peak
        if peak:
            mdd = min(mdd, v / peak - 1)
    return round(mdd * 100, 2)


def fetch_fund(code):
    src = get(f'https://fund.eastmoney.com/pingzhongdata/{code}.js?v={int(time.time())}')
    out = {'code': code}
    name = js_var(src, 'fS_name')
    if name:
        out['name'] = name

    nav = js_var(src, 'Data_netWorthTrend') or []
    acc = js_var(src, 'Data_ACWorthTrend') or []
    if nav:
        last = nav[-1]
        out['nav'] = round(float(last['y']), 4)
        out['navDate'] = ms_to_date(last['x']).isoformat()

    # 用累计净值算收益（分红已经加回去了）
    series = [(ms_to_date(p[0]), float(p[1])) for p in acc if p and p[1] is not None]
    if not series and nav:
        series = [(ms_to_date(p['x']), float(p['y'])) for p in nav]

    money = js_var(src, 'Data_sevenDaysYearIncome')
    if money and not series:  # 货币基金：只有七日年化
        last = money[-1]
        out['yield7d'] = round(float(last[1]), 3)
        out['navDate'] = ms_to_date(last[0]).isoformat()

    if series:
        end_d, end_v = series[-1]
        def back(days=0, years=0):
            d = end_d.replace(year=end_d.year - years) if years else end_d - datetime.timedelta(days=days)
            return value_on_or_before(series, d) if series[0][0] <= d else None
        out['ret1y'] = pct(end_v, back(years=1))
        out['ret3y'] = pct(end_v, back(years=3))
        ytd_base = value_on_or_before(series, datetime.date(end_d.year - 1, 12, 31))
        out['retYtd'] = pct(end_v, ytd_base)
        three = [p for p in series if p[0] >= end_d.replace(year=end_d.year - 3)]
        out['maxDd3y'] = max_drawdown(three) if len(three) > 30 else None
        out['retDate'] = end_d.isoformat()
        out['inception'] = series[0][0].isoformat()
        # 逐年收益（完整年份 + 今年以来）
        yr = []
        for y in range(max(series[0][0].year + 1, end_d.year - 5), end_d.year + 1):
            b = value_on_or_before(series, datetime.date(y - 1, 12, 31))
            e = value_on_or_before(series, datetime.date(y, 12, 31))
            if b and e:
                yr.append({'year': y, 'ret': pct(e, b), **({'label': f'{y}至今', 'note': '今年以来'} if y == end_d.year else {})})
        out['yearRets'] = yr
        # 近3年净值走势，按周抽样，用于详情页曲线
        pts, last_week = [], None
        for d, v in three:
            wk = d.isocalendar()[:2]
            if wk != last_week:
                pts.append([d.isoformat(), round(v, 4)])
                last_week = wk
            else:
                pts[-1] = [d.isoformat(), round(v, 4)]
        out['curve'] = pts

    scale = js_var(src, 'Data_fluctuationScale')
    if isinstance(scale, dict) and scale.get('series'):
        out['scaleYi'] = round(float(scale['series'][-1]['y']), 2)
        cats = scale.get('categories') or []
        if cats:
            out['scaleDate'] = cats[-1]

    mgr = js_var(src, 'Data_currentFundManager')
    if isinstance(mgr, list) and mgr:
        out['manager'] = '、'.join(m.get('name', '') for m in mgr if m.get('name'))
    return {k: v for k, v in out.items() if v is not None}


# ---------- 市场 ----------
def fetch_valuations():
    src = get('https://danjuanfunds.com/djapi/index_eva/dj', referer='https://danjuanfunds.com/djmodule/value-center')
    items = json.loads(src)['data']['items']
    want = {'SH000300': 'hs300', 'CSI000510': 'a500', 'SH000510': 'a500', 'CSIH30269': 'divLowVol', 'SP500': 'sp500', 'NDX': 'ndx'}
    out = {}
    for it in items:
        key = want.get(it.get('index_code'))
        if not key:
            continue
        date = it.get('date') or NOW.date().isoformat()
        if isinstance(date, (int, float)):
            date = ms_to_date(date).isoformat()
        elif re.fullmatch(r'\d{2}-\d{2}', str(date)):  # 蛋卷只给“月-日”，补上年份（跨年时用去年）
            mo = int(str(date)[:2])
            date = f'{NOW.year - (1 if mo > NOW.month else 0)}-{date}'
        if key in out:
            continue
        out[key] = {
            'pe': round(float(it['pe']), 2) if it.get('pe') is not None else None,
            'pePct10y': round(float(it['pe_percentile']) * 100, 1) if it.get('pe_percentile') is not None else None,
            'dy': round(float(it['yeild']) * 100, 2) if it.get('yeild') is not None else None,
            'date': date, 'src': 'https://danjuanfunds.com/djmodule/value-center'
        }
    status['valuationCodes'] = ','.join(sorted(str(it.get('index_code')) for it in items))[:2000]
    return out


def fetch_ust10y():
    """美国 10 年期国债收益率。先试美国财政部官网的每日收益率曲线（CSV），不行再试 FRED 的 DGS10。"""
    errors = []
    for year in (NOW.year, NOW.year - 1):
        try:
            url = ('https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/'
                   f'{year}/all?type=daily_treasury_yield_curve&field_tdr_date_value={year}&page&_format=csv')
            lines = get(url, referer='https://home.treasury.gov/', timeout=45).strip().splitlines()
            head = [h.strip().strip('"') for h in lines[0].split(',')]
            i = head.index('10 Yr')
            best = None
            for line in lines[1:]:  # 不假设排序，取日期最新的一行
                row = [c.strip().strip('"') for c in line.split(',')]
                try:
                    m, d, y = row[0].split('/')
                    key = f'{y}-{int(m):02d}-{int(d):02d}'
                    val = float(row[i])
                except (ValueError, IndexError):
                    continue
                if best is None or key > best[0]:
                    best = (key, val)
            if not best:
                raise ValueError('no rows')
            return {'yield': round(best[1], 2), 'date': best[0],
                    'src': 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates'}
        except Exception as e:  # noqa: BLE001
            errors.append(f'treasury {year}: {e}')
    try:
        rows = [l.split(',') for l in get('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10', referer='https://fred.stlouisfed.org/', timeout=45).strip().splitlines()[1:]]
        rows = [r for r in rows if len(r) == 2 and r[1] not in ('.', '')]
        d, v = rows[-1]
        return {'yield': round(float(v), 2), 'date': d, 'src': 'https://fred.stlouisfed.org/series/DGS10'}
    except Exception as e:  # noqa: BLE001
        errors.append(f'fred: {e}')
    raise RuntimeError('; '.join(errors))


def fetch_cgb10y():
    url = ('https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_TREASURYYIELD'
           '&columns=SOLAR_DATE,EMM00166466&sortColumns=SOLAR_DATE&sortTypes=-1&pageSize=1&pageNumber=1')
    row = json.loads(get(url, referer='https://data.eastmoney.com/cjsj/zmgzsyl.html'))['result']['data'][0]
    src = 'https://data.eastmoney.com/cjsj/zmgzsyl.html'
    cn = {'yield': round(float(row['EMM00166466']), 3), 'date': row['SOLAR_DATE'][:10], 'src': src}
    return cn


def fetch_index_years(secid):
    url = (f'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={secid}&fields1=f1,f2,f3'
           '&fields2=f51,f53&klt=103&fqt=1&beg=20150101&end=20500101')
    kl = json.loads(get(url, referer='https://quote.eastmoney.com/'))['data']['klines']
    closes = {}
    for line in kl:
        d, c = line.split(',')[:2]
        closes[int(d[:4])] = float(c)  # 每年最后一个月的收盘价
    years = sorted(closes)
    out = []
    for y in years[1:][-6:]:
        out.append({'year': y, 'ret': pct(closes[y], closes[y - 1]),
                    **({'label': f'{y}至今', 'note': '今年以来'} if y == NOW.year else {})})
    return out


def merge(old, new):
    """新数据覆盖旧数据，但 None 和空列表不覆盖（防止一次抓取失败把好数据清空）。"""
    res = dict(old or {})
    for k, v in (new or {}).items():
        if v is None or (isinstance(v, list) and not v):
            continue
        res[k] = v
    return res


def main():
    prev = load(DATA, {'market': {}, 'funds': []})
    seed = load(SEED, {'market': {}, 'funds': []})
    prev_funds = {f['code']: f for f in prev.get('funds', [])}
    seed_funds = {f['code']: f for f in seed.get('funds', [])}

    funds = []
    for code in fund_codes():
        base = merge(seed_funds.get(code), prev_funds.get(code))
        try:
            fresh = fetch_fund(code)
            status[f'fund:{code}'] = 'ok'
        except Exception as e:  # noqa: BLE001
            fresh = {}
            status[f'fund:{code}'] = f'failed: {e}'
        f = merge(base, fresh)
        # 静态字段始终以 seed 为准（费率、任职、公告提示由人维护）
        for k in ('mgmtFee', 'custFee', 'salesFee', 'managerSince', 'index', 'notes', 'share', 'limit', 'limitDate'):
            if k in seed_funds.get(code, {}):
                f[k] = seed_funds[code][k]
        f['code'] = code
        funds.append(f)
        time.sleep(0.5)

    market = merge(seed.get('market'), prev.get('market'))
    try:
        val = fetch_valuations()
        for k, v in val.items():
            market[k] = merge(market.get(k), v)
        status['valuation'] = 'ok' if val else 'failed: empty'
    except Exception as e:  # noqa: BLE001
        status['valuation'] = f'failed: {e}'
    try:
        market['cgb10y'] = merge(market.get('cgb10y'), fetch_cgb10y())
        status['cgb10y'] = 'ok'
    except Exception as e:  # noqa: BLE001
        status['cgb10y'] = f'failed: {e}'
    try:
        market['ust10y'] = merge(market.get('ust10y'), fetch_ust10y())
        status['ust10y'] = 'ok'
    except Exception as e:  # noqa: BLE001
        status['ust10y'] = f'failed: {e}'
    by_code = {f['code']: f for f in funds}
    for key, secid, proxy in (('hs300Hist', '1.000300', '006131'), ('divLowVolHist', '2.H30269', '007466')):
        try:
            hist = fetch_index_years(secid)
            if hist:
                market[key] = hist
                market[key + 'Src'] = '指数'
            status[key] = 'ok'
        except Exception as e:  # noqa: BLE001
            # 行情接口不通时，用对应联接基金的净值涨跌代替（含费用，略低于指数）
            if by_code.get(proxy, {}).get('yearRets'):
                market[key] = by_code[proxy]['yearRets']
                market[key + 'Src'] = '联接基金净值'
            status[key] = f'failed (用联接基金代替): {e}'

    out = {
        'updated': NOW.strftime('%Y-%m-%d %H:%M'),
        'market': market,
        'funds': funds,
        'status': status
    }
    os.makedirs(os.path.dirname(DATA), exist_ok=True)
    with open(DATA, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    ok = sum(1 for k, v in status.items() if v == 'ok')
    fund_ok = sum(1 for k, v in status.items() if k.startswith('fund:') and v == 'ok')
    print(f'updated {DATA}: {ok}/{len(status)} sources ok, funds {fund_ok}/{len(funds)}')
    for k, v in status.items():
        if v != 'ok' and k != 'valuationCodes':
            print(' ', k, v)
    # 一只基金都没抓到，或者估值没抓到，都算失败：GitHub 会发邮件提醒仓库主人
    sys.exit(0 if fund_ok and status.get('valuation') == 'ok' else 1)


if __name__ == '__main__':
    main()
