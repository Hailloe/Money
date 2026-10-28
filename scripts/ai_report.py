#!/usr/bin/env python3
"""
自动盯盘：每次数据更新后检查信号有没有“值得告诉你”的变化。
  - 没有变化：不调用 AI，只记录“已检查”的时间。
  - 有变化：才让 DeepSeek 写一条简短提醒（变了什么、意味着什么、要不要动），存进 data/ai-report.json 的历史里。
只用公开的市场数据（data/data.json），不涉及任何人的持仓。

触发提醒的变化（阈值来自 config.js 的 rules，和网页用的是同一套）：
  1. 估值档位变化：沪深300、标普500、纳指100 的市盈率分位跨过档位；红利低波的息差档位变化
  2. 红利低波的两个信号开始打架或不再打架（自身市盈率分位 ≥ divPeCap）
  3. 推荐基金从近一年最高点回撤超过 15%，或者回撤比上次提醒时又加深 10 个百分点
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
DD_ALERT, DD_STEP, KEEP = 15, 10, 60   # 回撤提醒线、再次提醒的加深幅度、历史保留条数

SYSTEM = """你是一位冷静、不追涨杀跌的基金投资分析员。网站在后台持续盯盘，只有在信号真正变化时才会请你写一条提醒，读者是完全不懂投资的新手。
要求：
1. 只说给你的“变化”，不写市场综述、不编造新闻、不预测涨跌、不承诺收益。
2. 先用一句话说清楚变了什么，再说这对新手意味着什么、要不要动（以网站规则给出的买入倍数为准，不要给出和规则矛盾的建议）。
3. 语气平稳，不制造焦虑，不鼓励频繁交易。大多数时候正确的做法是“按计划执行，不用额外操作”，如果是这样就直说。
4. 150 字以内，不用标题，不用表格。"""


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


def snapshot(data):
    pe, spread, cap, stale, picks = parse_rules()
    m = data.get('market', {})
    g = lambda k, f: (m.get(k) or {}).get(f)
    sig = {}
    for key, name in (('hs300', '沪深300'), ('sp500', '标普500'), ('ndx', '纳指100')):
        lv = pe_level(g(key, 'pePct10y'), pe)
        if lv:
            sig[key] = dict(lv, name=name, pct=g(key, 'pePct10y'))
    dy, cn = g('divLowVol', 'dy'), g('cgb10y', 'yield')
    if dy is not None and cn is not None:
        sp = round(dy - cn, 2)
        lv = spread_level(sp, spread)
        if lv:
            conflict = (g('divLowVol', 'pePct10y') or 0) >= cap and lv['m'] > 1
            sig['divLowVol'] = dict(lv, name='红利低波', spread=sp, pct=g('divLowVol', 'pePct10y'), conflict=conflict,
                                    m=1 if conflict else lv['m'])
    # 推荐基金距近一年最高点的回撤（用累计净值曲线）
    dd = {}
    funds = {f['code']: f for f in data.get('funds', [])}
    for code, cat, short in picks:
        cur = (funds.get(code) or {}).get('curve') or []
        if cat == 'cash' or len(cur) < 10:
            continue
        last = cur[-1]
        year = [v for d, v in cur if d >= (datetime.date.fromisoformat(last[0]) - datetime.timedelta(days=365)).isoformat()]
        hi = max(year) if year else None
        if hi:
            dd[code] = {'name': short, 'dd': round((last[1] / hi - 1) * 100, 1)}
    navs = sorted(f.get('navDate') for c, cat, s in picks if (f := funds.get(c)) and cat != 'cash' and f.get('navDate'))
    nav_mid = navs[(len(navs) - 1) // 2] if navs else None
    stale_days = (NOW.date() - datetime.date.fromisoformat(nav_mid)).days if nav_mid else None
    return {'sig': sig, 'dd': dd, 'navDate': nav_mid, 'stale': stale_days is not None and stale_days > stale, 'staleDays': stale_days}


def diff(prev, cur):
    """对比上次和这次的状态，返回值得提醒的变化列表（中文）。"""
    out = []
    for k, s in cur['sig'].items():
        p = prev.get('sig', {}).get(k)
        if not p:
            continue
        if p['t'] != s['t'] or p['m'] != s['m']:
            extra = f"（近10年 {round(s['pct'])}% 分位）" if s.get('pct') is not None and k != 'divLowVol' else (f"（息差 {s['spread']} 个百分点）" if k == 'divLowVol' else '')
            out.append(f"{s['name']}估值从“{p['t']}”变成“{s['t']}”{extra}，每月买入倍数从 {p['m']:g} 倍变为 {s['m']:g} 倍")
        if k == 'divLowVol' and p.get('conflict') != s.get('conflict'):
            out.append(f"红利低波自身估值分位{'升到' if s['conflict'] else '回落到'} {round(s['pct'] or 0)}%，两个信号{'开始打架，最多按 1 倍买' if s['conflict'] else '不再打架，按息差正常买'}")
    alerted = prev.get('ddAlerted', {})
    for code, d in cur['dd'].items():
        last_alert = alerted.get(code)
        if d['dd'] <= -DD_ALERT and (last_alert is None or d['dd'] <= last_alert - DD_STEP):
            out.append(f"{d['name']}从近一年最高点下跌了 {abs(d['dd'])}%")
    if cur['stale'] and not prev.get('stale'):
        out.append(f"基金净值已经 {cur['staleDays']} 天没有更新，自动抓数据可能出了问题")
    return out


def ai_write(changes, data, key):
    m = data.get('market', {})
    payload = {'日期': NOW.strftime('%Y-%m-%d'), '变化': changes,
               '当前估值': {k: m.get(k) for k in ('hs300', 'divLowVol', 'sp500', 'ndx', 'cgb10y', 'ust10y')},
               '说明': '买入倍数由网站规则决定：估值越低买得越多，“很贵”时暂停；分批卖出、止盈也由规则决定。'}
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
    cur = snapshot(data)
    report['checked'] = NOW.strftime('%Y-%m-%d %H:%M')
    report.setdefault('history', [])
    if prev is None:
        # 已经处在回撤里的基金记为“已提醒过”，之后只有继续明显加深才提醒
        cur['ddAlerted'] = {c: d['dd'] for c, d in cur['dd'].items() if d['dd'] <= -DD_ALERT}
        report['state'] = cur
        print('第一次运行：只记录当前状态，不发提醒')
    else:
        changes = diff(prev, cur)
        alerted = dict(prev.get('ddAlerted', {}))
        for code, d in cur['dd'].items():
            if d['dd'] <= -DD_ALERT and (alerted.get(code) is None or d['dd'] <= alerted[code] - DD_STEP):
                alerted[code] = d['dd']
            elif d['dd'] > -DD_ALERT / 2:
                alerted.pop(code, None)   # 回撤修复到一半以内，下次再跌才重新提醒
        cur['ddAlerted'] = alerted
        report['state'] = cur
        if not changes:
            print('已检查，没有值得提醒的变化')
        else:
            key = os.environ.get('DEEPSEEK_API_KEY', '').strip()
            text, model = None, 'rules'
            if key:
                try:
                    text, model = ai_write(changes, data, key), MODEL
                except Exception as e:  # noqa: BLE001
                    print('AI 写提醒失败，改用规则文字：', e)
            if not text:
                text = '；'.join(changes) + '。买入金额已按规则自动调整，照“本月定投计划”执行即可，不需要额外操作。'
            report['history'].insert(0, {'date': NOW.strftime('%Y-%m-%d %H:%M'), 'changes': changes, 'text': text, 'model': model})
            del report['history'][KEEP:]
            print('发出提醒：', changes)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    return 0


if __name__ == '__main__':
    sys.exit(main())
