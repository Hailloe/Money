#!/usr/bin/env python3
"""
自动盯盘：每次数据更新后检查信号有没有“值得告诉你”的变化。
  - 没有变化：不调用 AI，只记录“已检查”的时间。
  - 有变化：才让 DeepSeek 写一条简短提醒（变了什么、意味着什么、要不要动），存进 data/ai-report.json 的历史里。
只用公开的市场数据（data/data.json），不涉及任何人的持仓。

触发提醒的变化（阈值来自 config.js 的 rules，和网页用的是同一套）：
  1. 估值档位变化：沪深300、标普500、纳指100 的市盈率分位跨过档位；红利低波的息差档位变化
  2. 红利低波的两个信号开始打架或不再打架（自身市盈率分位 ≥ divPeCap）
  3. 推荐基金从近一年最高点回撤超过提醒线（债券 3%、宽基和红利低波 15%、海外和主动 20%），之后每再加深一截才再提醒
  4. 数据断更超过 staleDays 天
第一次运行只记录当前状态，不发提醒。

AI 提醒需要仓库密钥 DEEPSEEK_API_KEY（Settings → Secrets and variables → Actions）。没有密钥时照样检查变化，
提醒内容用规则自动生成的文字，不调用 AI。
手动运行：DEEPSEEK_API_KEY=sk-xxx python3 scripts/ai_report.py
"""
import json, os, re, sys, datetime, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data', 'data.json')
OUT = os.path.join(ROOT, 'data', 'ai-report.json')
CONFIG = os.path.join(ROOT, 'config.js')
MODEL = os.environ.get('DEEPSEEK_MODEL', 'deepseek-chat')
TZ = datetime.timezone(datetime.timedelta(hours=8))
NOW = datetime.datetime.now(TZ)
KEEP = 60                      # 历史保留条数
PE_MARGIN, SPREAD_MARGIN = 2, 0.1   # 迟滞：估值分位要越过档位线 2 个百分点、息差越过 0.1 个百分点才算变化，防止在线附近来回提醒
# 回撤提醒：（提醒线 %，之后每再加深多少 % 再提醒）。债券跌 3% 对新手就是大事；海外和主动基金波动大，门槛高一些
DD_RULES = {'bond': (3, 2), 'index': (15, 10), 'div': (15, 10), 'overseas': (20, 10), 'active': (20, 10)}

SYSTEM = """你是一位冷静、不追涨杀跌的基金投资分析员。网站在后台持续盯盘，只有在信号真正变化时才会请你写一条提醒，读者是完全不懂投资的新手。
要求：
1. 只说给你的“变化”，不写市场综述、不编造新闻、不预测涨跌、不承诺收益。
2. 先用一句话说清楚变了什么，再说这对新手意味着什么、要不要动（以网站规则给出的买入倍数为准，不要给出和规则矛盾的建议）。
3. 语气平稳，不制造焦虑，不鼓励频繁交易。大多数时候正确的做法是“按计划执行，不用额外操作”，如果是这样就直说。
4. 不要给出新的买卖金额，不要使用“抄底、暴涨、机会来了、赶紧”等词。
5. 如果变化里有“数据没有更新”，提醒先别按页面建议操作，等数据恢复。
6. 150 字以内，不用标题，不用表格。"""


def load(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return default


def parse_rules():
    """从 config.js 读出估值档位阈值，保证和网页用同一套规则。"""
    with open(CONFIG, encoding='utf-8') as f:
        cfg = f.read()
    pe = [(float(b), float(m), t) for b, m, t in re.findall(r"below:\s*([\d.]+),\s*m:\s*([\d.]+),\s*t:\s*'([^']+)'", cfg)]
    spread = [(float(a), float(m), t) for a, m, t in re.findall(r"atLeast:\s*(-?[\d.]+),\s*m:\s*([\d.]+),\s*t:\s*'([^']+)'", cfg)]
    cap = re.search(r'divPeCap:\s*([\d.]+)', cfg)
    stale = re.search(r'staleDays:\s*([\d.]+)', cfg)
    picks = re.findall(r"code:\s*'(\d{6})',\s*cat:\s*'(\w+)',\s*pick:\s*true[^}]*?short:\s*'([^']+)'", cfg)
    return pe, spread, float(cap.group(1)) if cap else 80, float(stale.group(1)) if stale else 4, picks


def pe_level(p, pe):
    if p is None:
        return None
    for below, m, t in pe:
        if p < below:
            return {'t': t, 'm': m}
    return None


def spread_level(s, spread):
    if s is None:
        return None
    for at_least, m, t in spread:
        if s >= at_least:
            return {'t': t, 'm': m}
    return None


def sticky(prev_t, value, level_fn, margin, higher_is_up):
    """迟滞：只有值越过档位线 margin 以上，才承认换档；否则沿用上次的档位。"""
    now = level_fn(value)
    if not now or prev_t is None or now['t'] == prev_t:
        return now
    a, b = level_fn(value - margin), level_fn(value + margin)
    if a and b and a['t'] == b['t'] == now['t']:
        return now
    return None   # 还在档位线附近，不算变化


def snapshot(data, prev=None):
    pe, spread, cap, stale, picks = parse_rules()
    psig = (prev or {}).get('sig', {})
    m = data.get('market', {})
    g = lambda k, f: (m.get(k) if isinstance(m.get(k), dict) else {}).get(f)
    sig = {}
    for key, name in (('hs300', '沪深300'), ('sp500', '标普500'), ('ndx', '纳指100')):
        v = g(key, 'pePct10y')
        lv = sticky((psig.get(key) or {}).get('t'), v, lambda x: pe_level(max(0, min(100, x)), pe), PE_MARGIN, True) if v is not None else None
        if v is not None and lv is None and psig.get(key):
            lv = {'t': psig[key]['t'], 'm': psig[key]['m']}   # 在档位线附近，沿用上次
        if lv:
            sig[key] = dict(lv, name=name, pct=v)
    dy, cn = g('divLowVol', 'dy'), g('cgb10y', 'yield')
    if dy is not None and cn is not None:
        sp = round(dy - cn, 2)
        pd = psig.get('divLowVol') or {}
        lv = sticky(pd.get('t'), sp, lambda x: spread_level(x, spread), SPREAD_MARGIN, True)
        if lv is None and pd:
            lv = {'t': pd['t'], 'm': pd.get('base_m', pd.get('m'))}
        if lv:
            dp = g('divLowVol', 'pePct10y') or 0
            # 冲突：≥ cap 开始，回落到 cap − 2 以下才解除
            was = pd.get('conflict', False)
            conflict = lv['m'] > 1 and (dp >= cap if not was else dp >= cap - PE_MARGIN)
            sig['divLowVol'] = dict(lv, name='红利低波', spread=sp, pct=dp, conflict=conflict, base_m=lv['m'],
                                    m=1 if conflict else lv['m'])
    # 推荐基金距近一年最高点的回撤（用复权净值曲线）
    dd = {}
    funds = {f['code']: f for f in data.get('funds', [])}
    for code, cat, short in picks:
        cur = (funds.get(code) or {}).get('curve') or []
        if cat not in DD_RULES or len(cur) < 10:
            continue
        last = cur[-1]
        cur = [p for p in cur if isinstance(p, list) and len(p) == 2 and isinstance(p[1], (int, float)) and p[1] > 0]
        if len(cur) < 10:
            continue
        last = cur[-1]
        year = [v for d, v in cur if d >= (datetime.date.fromisoformat(last[0]) - datetime.timedelta(days=365)).isoformat()]
        hi = max(year) if year else None
        if hi:
            dd[code] = {'name': short, 'cat': cat, 'dd': round((last[1] / hi - 1) * 100, 1)}
    # 这次没抓到的信号沿用上次的状态，避免数据恢复时漏报中间的变化
    for k, v in psig.items():
        sig.setdefault(k, v)
    navs = sorted(f.get('navDate') for c, cat, s in picks if (f := funds.get(c)) and cat != 'cash' and f.get('navDate'))
    nav_mid = navs[(len(navs) - 1) // 2] if navs else None
    stale_days = (NOW.date() - datetime.date.fromisoformat(nav_mid)).days if nav_mid else None
    return {'sig': sig, 'dd': dd, 'navDate': nav_mid, 'stale': stale_days is not None and stale_days > stale, 'staleDays': stale_days}


def dd_due(d, last_alert):
    line, step = DD_RULES.get(d.get('cat'), (15, 10))
    return d['dd'] <= -line and (last_alert is None or d['dd'] <= last_alert - step)


def diff(prev, cur):
    """对比上次和这次的状态，返回值得提醒的变化：[(类型, 中文)]。"""
    out = []
    for k, s in cur['sig'].items():
        p = prev.get('sig', {}).get(k)
        if not p:
            continue
        if p['t'] != s['t']:
            extra = f"（近10年 {int(s['pct'] + 0.5)}% 分位）" if k != 'divLowVol' and s.get('pct') is not None else (f"（息差 {s['spread']} 个百分点）" if k == 'divLowVol' else '')
            mult = f"（打开了估值规则的话，每月买入倍数从 {p['m']:g} 倍变为 {s['m']:g} 倍）" if p['m'] != s['m'] else ''
            out.append(('tier', f"{s['name']}估值从“{p['t']}”变成“{s['t']}”{extra}{mult}"))
        elif k == 'divLowVol' and p.get('conflict') != s.get('conflict'):
            out.append(('tier', f"红利低波自身估值分位{'升到' if s['conflict'] else '回落到'} {int((s['pct'] or 0) + 0.5)}%（打开了估值规则的话，{'买入倍数最多 1 倍' if s['conflict'] else '按息差恢复到 ' + format(s['m'], 'g') + ' 倍'}）"))
    alerted = prev.get('ddAlerted', {})
    for code, d in cur['dd'].items():
        if dd_due(d, alerted.get(code)):
            out.append(('ddbond' if d.get('cat') == 'bond' else 'dd', f"{d['name']}从近一年最高点下跌了 {abs(d['dd'])}%"))
    if cur['stale'] and not prev.get('stale'):
        out.append(('stale', f"基金净值已经 {cur['staleDays']} 天没有更新，数据可能不准"))
    return out


ENDINGS = {
    'stale': '数据可能不准，先别按页面建议操作，等数据恢复。',
    'tier': '默认按比例买，估值变化只是参考，不影响你的计划；打开了估值规则的，页面上的定投计划已经自动调整。照“本月定投计划”执行即可，不需要额外操作。',
    'dd': '这是正常波动，规则不变，照常定投，不用卖。',
    'ddbond': '债券基金很少跌这么多，先到天天基金看看这只基金有没有关于信用风险的公告，暂时不用卖。'
}


def rules_text(changes):
    kinds = [k for k, _ in changes]
    end = ' '.join(ENDINGS[k] for k in ('stale', 'ddbond', 'tier', 'dd') if k in kinds and not (k == 'dd' and 'stale' in kinds))
    return '；'.join(t for _, t in changes) + '。' + end


def ai_write(changes, data, key):
    m = data.get('market', {})
    payload = {'日期': NOW.strftime('%Y-%m-%d'), '变化': changes,
               '当前估值': {k: m.get(k) for k in ('hs300', 'divLowVol', 'sp500', 'ndx', 'cgb10y', 'ust10y')},
               '说明': '网站默认按比例每月定投，不看估值；用户可以在偏好里打开估值规则（估值越低买得越多，“很贵”时只买一半，很贵且赚 50% 分批止盈）。提醒里不要让用户自己改金额，照页面上的“本月定投计划”执行。'}
    body = json.dumps({'model': MODEL, 'temperature': 0.2, 'max_tokens': 500,
                       'messages': [{'role': 'system', 'content': SYSTEM},
                                    {'role': 'user', 'content': json.dumps(payload, ensure_ascii=False)}]}).encode()
    req = urllib.request.Request('https://api.deepseek.com/chat/completions', data=body, method='POST',
                                 headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())['choices'][0]['message']['content'].strip()


def main():
    data = load(DATA, None)
    if not data:
        print('没有 data.json，跳过')
        return 0
    report = load(OUT, {})
    prev = report.get('state')
    cur = snapshot(data, prev)
    report['checked'] = NOW.strftime('%Y-%m-%d %H:%M')
    report.setdefault('history', [])
    if prev is None:
        # 已经处在回撤里的基金记为“已提醒过”，之后只有继续明显加深才提醒
        cur['ddAlerted'] = {c: d['dd'] for c, d in cur['dd'].items() if d['dd'] <= -DD_RULES[d['cat']][0]}
        report['state'] = cur
        print('第一次运行：只记录当前状态，不发提醒')
    else:
        changes = diff(prev, cur)
        alerted = dict(prev.get('ddAlerted', {}))
        for code, d in cur['dd'].items():
            if dd_due(d, alerted.get(code)):
                alerted[code] = d['dd']
            elif d['dd'] > -DD_RULES[d['cat']][0] / 2:
                alerted.pop(code, None)   # 回撤修复到提醒线一半以内，下次再跌才重新提醒
        cur['ddAlerted'] = alerted
        report['state'] = cur
        if not changes:
            print('已检查，没有值得提醒的变化')
        else:
            key = os.environ.get('DEEPSEEK_API_KEY', '').strip()
            text, model = None, 'rules'
            if key:
                try:
                    text, model = ai_write([t for _, t in changes], data, key), MODEL
                except Exception as e:  # noqa: BLE001
                    print('AI 写提醒失败，改用规则文字：', e)
            if not text:
                text = rules_text(changes)
            report['history'].insert(0, {'date': NOW.strftime('%Y-%m-%d %H:%M'), 'changes': [t for _, t in changes], 'text': text, 'model': model})
            del report['history'][KEEP:]
            print('发出提醒：', [t for _, t in changes])
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    os.replace(tmp, OUT)
    return 0


if __name__ == '__main__':
    sys.exit(main())
