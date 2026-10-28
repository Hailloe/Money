/*
 * 稳健基金看板 — 主程序
 * 结构：数据加载 → 用户档案（本机保存）→ 规则引擎 analyze() → 各页面 view*() → 路由 render()
 * 规则阈值和基金名单在 config.js；每日数据在 data/data.json（由 scripts/update_data.py 自动生成）。
 */
(function () {
'use strict';
const C = window.CONFIG;
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 0) => v == null || isNaN(v) ? '—' : '¥' + Number(v).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (v, d = 0) => v == null || isNaN(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Number(v)).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v, d = 1) => v == null || isNaN(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Number(v)).toFixed(d) + '%';
const cls = v => v == null || isNaN(v) ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '';
const cnDate = s => { const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})/); return m ? `${+m[2]}月${+m[3]}日` : ''; };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

let DATA, M, FUNDS, FUND, CAT;

/* ================= 用户档案（保存在本机浏览器） ================= */
const LS = 'money.v1';
const EXAMPLE_ITEMS = [
  { code: '000198', amount: 8000, profit: 96 },
  { code: '007901', amount: 10000, profit: 185 },
  { code: '006131', amount: 15000, profit: 1620 },
  { code: '007466', amount: 6000, profit: 310 },
  { code: '161005', amount: 4000, profit: -260 },
  { code: 'other-demo', name: '某白酒行业指数基金（示例）', cat: 'active', amount: 6000, profit: -1350 }
];
function newProfile(name) {
  return { name, example: true, monthly: 2000, items: JSON.parse(JSON.stringify(EXAMPLE_ITEMS)),
    risk: null, prefs: { day: 10, noActive: false, avoid: [] }, history: [], journal: [] };
}
let STORE;
try { STORE = JSON.parse(localStorage.getItem(LS) || 'null'); } catch (e) { STORE = null; }
if (!STORE || !STORE.profiles) STORE = { current: 'p1', profiles: { p1: newProfile('我') } };
let P = STORE.profiles[STORE.current] || Object.values(STORE.profiles)[0];
let storageOk = true;
function save() {
  try { localStorage.setItem(LS, JSON.stringify(STORE)); storageOk = true; } catch (e) { storageOk = false; }
}
function touchPortfolio() {
  P.example = false;
  // 每天最多记一个快照，用来画资产走势
  const A = analyze();
  const pt = { d: today(), total: Math.round(A.total), profit: Math.round(A.profit), eq: Math.round(A.eqW) };
  const h = P.history; if (h.length && h[h.length - 1].d === pt.d) h[h.length - 1] = pt; else h.push(pt);
  if (h.length > 600) h.splice(0, h.length - 600);
  save();
}

/* ================= 规则：风险等级（问卷 + 从行为里学到的调整） ================= */
function levelIndex(k) { return Math.max(0, C.levels.findIndex(l => l.k === k)); }
function quizLevel(ans) {
  if (!ans || ans.length !== C.quiz.length || ans.some(a => a == null)) return null;
  const score = ans.reduce((a, b) => a + b + 1, 0);           // 每题 1–4 分，共 5–20 分
  let i = score <= 9 ? 0 : score <= 13 ? 1 : score <= 17 ? 2 : 3;
  if (ans[0] === 0) i = 0;                                    // 一年内要用的钱：只能保守
  if (ans[2] === 0) i = Math.min(i, 1);                       // 大跌会全部卖出：最多稳健
  return { score, i };
}
function learned() {
  const notes = []; const since = new Date(); since.setMonth(since.getMonth() - 12); const sinceK = monthKey(since);
  const recent = P.journal.filter(j => j.m >= sinceK);
  const panic = recent.filter(j => j.choice === 'panic').length;
  const chase = recent.filter(j => j.choice === 'chase').length;
  let shift = 0;
  if (panic >= 2) { shift = -1; notes.push({ k: 'sell', t: `过去 12 个月有 ${panic} 次在下跌时卖出。说明实际能扛的波动比问卷答的小，股票类比例已经自动调低一档。` }); }
  else if (panic === 1) notes.push({ k: 'wait', t: '过去 12 个月有 1 次在下跌时卖出。再有一次，系统会自动调低股票比例。' });
  if (chase >= 2) notes.push({ k: 'wait', t: `过去 12 个月有 ${chase} 次在上涨时追着买。规则会帮你在贵的时候少买，照着定投计划来就行。` });
  const real = P.history.filter(h => h.total > 0);
  if (real.length >= 2) {
    const first = real[0], last = real[real.length - 1];
    if (last.eq < first.eq - 15) notes.push({ k: 'wait', t: `你的股票类占比从 ${first.eq}% 降到了 ${last.eq}%。如果是卖出导致的，记得在“本月打卡”里如实记录。` });
  }
  return { shift, notes, panic, chase };
}
function currentLevel() {
  const q = P.risk && P.risk.i != null ? P.risk.i : levelIndex(C.defaultLevel);
  const L = learned();
  const i = Math.max(0, Math.min(C.levels.length - 1, q + L.shift));
  return { i, base: q, L, level: C.levels[i] };
}
function targets() {
  const t = Object.assign({}, currentLevel().level.target);
  if (P.prefs && P.prefs.noActive) { t.index += t.active; t.active = 0; }
  const want = P.prefs && P.prefs.overseasPct;
  if (want && want !== t.overseas) {
    // 海外比例调整时，只从宽基、红利低波、主动里匀，债券和货币不动
    const keys = ['index', 'div', 'active'], others = keys.reduce((a, k) => a + t[k], 0), room = others + t.overseas - want;
    if (room > 0) {
      keys.forEach(k => t[k] = Math.round(t[k] / others * room));
      t.overseas = want; t.index += 100 - Object.values(t).reduce((a, b) => a + b, 0);
    }
  }
  return t;
}

/* ================= 规则：估值信号 ================= */
function peSignal(p) {
  if (p == null) return { m: 1, t: '无数据', k: 'hold' };
  const r = C.rules.pe.find(x => p < x.below);
  return { m: r.m, t: r.t, k: r.m >= 1.5 ? 'cheap' : r.m === 1 ? 'hold' : r.m > 0 ? 'wait' : 'stop' };
}
function spreadSignal(s) {
  if (s == null) return { m: 1, t: '无数据', k: 'hold' };
  const r = C.rules.spread.find(x => s >= x.atLeast);
  return { m: r.m, t: r.t, k: r.m >= 1.5 ? 'cheap' : r.m === 1 ? 'hold' : r.m > 0 ? 'wait' : 'stop' };
}
let idxPct, spread, SIG, SIGV = {};
function computeSignals() {
  idxPct = M.hs300 && M.hs300.pePct10y != null ? M.hs300.pePct10y : null;
  spread = M.divLowVol && M.divLowVol.dy != null && M.cgb10y && M.cgb10y.yield != null ? +(M.divLowVol.dy - M.cgb10y.yield).toFixed(2) : null;
  const pe = peSignal(idxPct);
  SIGV = { sp500: peSignal(M.sp500 && M.sp500.pePct10y), ndx: peSignal(M.ndx && M.ndx.pePct10y) };
  SIG = { index: pe, active: pe, div: spreadSignal(spread), overseas: SIGV.sp500, bond: { m: 1, t: '照常', k: 'hold' }, cash: { m: 1, t: '照常', k: 'hold' } };
}
/* 海外基金按各自跟踪的指数估值；其他类别按类别 */
function sigOf(cat, f) { return cat === 'overseas' && f && f.val && SIGV[f.val] ? SIGV[f.val] : SIG[cat]; }
function valText(cat, f) {
  if (cat === 'div') return `息差 ${spread == null ? '—' : spread + ' 个点'}`;
  if (cat === 'overseas') { const k = f && f.val || 'sp500', m = M[k]; return `${k === 'ndx' ? '纳指100' : '标普500'}近10年 ${m && m.pePct10y != null ? Math.round(m.pePct10y) + '%' : '—'} 分位`; }
  return `沪深300近10年 ${idxPct == null ? '—' : Math.round(idxPct) + '%'} 分位`;
}

/* ================= 评分：只看长期质量，不看近1年涨幅 ================= */
const W = {
  index: { fee: .4, scale: .25, ret3y: .2, dd: .05, age: .1 },
  div: { fee: .35, scale: .25, ret3y: .25, dd: .1, age: .05 },
  bond: { dd: .35, ret3y: .3, scale: .2, fee: .15 },
  active: { ret3y: .3, dd: .25, tenure: .25, scale: .1, fee: .1 },
  overseas: { fee: .35, scale: .25, ret3y: .2, dd: .1, age: .1 },
  cash: { scale: 1 }
};
const MNAME = { fee: '费率', scale: '规模', ret3y: '近3年收益', dd: '最大回撤', age: '成立年限', tenure: '经理任职' };
const totalFee = f => (f.mgmtFee != null || f.custFee != null) ? +((f.mgmtFee || 0) + (f.custFee || 0) + (f.salesFee || 0)).toFixed(2) : null;
const yearsSince = d => { if (!d) return null; const t = Date.parse(String(d).length === 7 ? d + '-01' : d); return isNaN(t) ? null : (Date.now() - t) / 31557600000; };
function metric(f, key) {
  switch (key) {
    case 'fee': { const v = totalFee(f); return v == null ? null : -v; }
    case 'scale': return f.scaleYi == null ? null : (f.cat === 'active' ? -Math.abs(Math.log(Math.max(f.scaleYi, 1) / 80)) : Math.log(f.scaleYi + 1));
    case 'ret3y': return f.ret3y == null ? null : f.ret3y;
    case 'dd': return f.maxDd3y == null ? null : -Math.abs(f.maxDd3y);
    case 'age': return yearsSince(f.inception);
    case 'tenure': return yearsSince(f.managerSince);
  }
  return null;
}
function scoreAll() {
  C.cats.forEach(c => {
    const fs = FUNDS.filter(f => f.cat === c.k), w = W[c.k];
    fs.forEach(f => { f.score = 0; f.parts = {}; f.missing = []; });
    Object.keys(w).forEach(key => {
      const vals = fs.map(f => metric(f, key)).filter(v => v != null);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      fs.forEach(f => {
        const v = metric(f, key); let s;
        if (v == null) { s = .4; f.missing.push(MNAME[key]); } else s = hi === lo ? .8 : .15 + .85 * (v - lo) / (hi - lo);
        f.parts[key] = s; f.score += s * w[key] * 100;
      });
    });
    fs.forEach(f => f.score = Math.round(f.score));
    fs.slice().sort((a, b) => b.score - a.score).forEach((f, i) => { f.rank = i + 1; f.peers = fs.length; });
  });
}
const picksOf = k => FUNDS.filter(f => f.cat === k && f.pick);

/* ================= 规则引擎：持仓 → 每只基金的操作建议 ================= */
function analyze() {
  const T = targets(); const R = C.rules;
  const items = P.items.filter(i => (+i.amount || 0) > 0).map(i => {
    const f = FUND[i.code];
    return Object.assign({}, i, { fund: f || null, cat: f ? f.cat : (CAT[i.cat] ? i.cat : 'active'), name: f ? f.name : (i.name || '其他基金'), amount: +i.amount || 0, profit: +i.profit || 0 });
  });
  const total = items.reduce((a, i) => a + i.amount, 0);
  const profit = items.reduce((a, i) => a + i.profit, 0);
  const byCat = {}, pByCat = {}; C.cats.forEach(c => { byCat[c.k] = 0; pByCat[c.k] = 0; });
  items.forEach(i => { byCat[i.cat] += i.amount; pByCat[i.cat] += i.profit; });
  const w = {}, dev = {}; C.cats.forEach(c => { w[c.k] = total ? byCat[c.k] / total * 100 : 0; dev[c.k] = w[c.k] - T[c.k]; });
  const eqW = C.cats.filter(c => c.eq).reduce((a, c) => a + w[c.k], 0);
  const expRet = C.cats.reduce((a, c) => a + T[c.k] / 100 * c.ret, 0);
  const expDd = C.cats.reduce((a, c) => a + T[c.k] / 100 * c.dd, 0);
  const curDd = total ? C.cats.reduce((a, c) => a + w[c.k] / 100 * c.dd, 0) : expDd;

  // 本月定投计划（买推荐基金）
  const monthly = +P.monthly || 0, plan = []; let parked = 0;
  C.cats.forEach(c => {
    const base = monthly * T[c.k] / 100; if (!base) return;
    const ps = picksOf(c.k);
    ps.forEach(p => {
      const sig = sigOf(c.k, p); let m = sig.m;
      if (c.eq && dev[c.k] <= -R.catchUpBand && m > 0 && total > 0) m += 0.5;
      const b = base * (p.split || 1 / ps.length), amt = b * m;
      if (c.eq && amt < b) parked += b - amt;
      plan.push({ fund: p, cat: c.k, base: b, amt, m, sig });
    });
  });
  const cashPick = plan.find(p => p.cat === 'cash');
  if (cashPick) cashPick.amt += parked; else if (parked) plan.push({ fund: picksOf('cash')[0], cat: 'cash', base: 0, amt: parked, m: 1, sig: SIG.cash });
  const planTotal = plan.reduce((a, p) => a + p.amt, 0);
  // 便宜月份多买的部分，从余额宝里出
  const extra = Math.max(0, planTotal - monthly);

  const avoid = (P.prefs && P.prefs.avoid) || [];
  const adv = items.map(i => {
    const c = CAT[i.cat], f = i.fund, sig = sigOf(i.cat, f), cost = i.amount - i.profit, pp = cost > 0 ? i.profit / cost * 100 : 0;
    const share = byCat[i.cat] ? i.amount / byCat[i.cat] : 0;
    const best = picksOf(i.cat)[0];
    const bestName = best ? (best.short || best.name) : '同类推荐基金';
    const hit = avoid.find(a => (i.name || '').includes(a));
    let a = { k: 'hold', t: '持有', amt: 0, why: [] };
    const planFor = code => plan.find(x => x.fund && x.fund.code === code);
    if (!f) {
      if (hit) a = { k: 'sell', t: '分批卖出', amt: Math.round(i.amount / R.otherSellMonths), why: [`你在偏好里设置了不碰“${hit}”。`, `分 ${R.otherSellMonths} 个月卖完，钱换成 ${bestName}。`] };
      else if (i.cat === 'active' || dev[i.cat] >= R.rebalanceBand)
        a = { k: 'sell', t: '分批卖出', amt: Math.round(i.amount / R.otherSellMonths), why: ['不在选基名单里，看不到它的费率、回撤和经理数据，没法判断好坏。',
          `行业基金波动大${pp < 0 ? `，现在亏 ${Math.abs(pp).toFixed(0)}%，但不要因为亏了就一直拿着等回本` : ''}。分 ${R.otherSellMonths} 个月卖完，换成 ${bestName}。`] };
      else a = { k: 'swap', t: '考虑换掉', amt: 0, why: [`不在选基名单里，建议和同类推荐的 ${bestName} 对比一下费率和回撤。`] };
    } else if (!f.pick && best && best.score - f.score >= R.swapScoreGap) {
      a = { k: 'swap', t: '换成更好的', amt: i.amount, why: [`同类综合评分 ${f.score} 分，推荐的 ${bestName} 是 ${best.score} 分（看费率、规模、3年收益和回撤，不看短期涨幅）。`,
        sig.m === 0 ? '现在估值贵，卖出后先把钱放进余额宝，等估值回落再按计划买入推荐基金。' : `卖出后按计划买入 ${bestName}。持有不满 7 天卖出要交 1.5% 赎回费。`] };
    } else if (c.eq && sig.m === 0 && pp >= R.takeProfitPct) {
      a = { k: 'sell', t: '分批止盈', amt: Math.round(i.amount * R.takeProfitSlice), why: [`估值${sig.t}（${valText(i.cat, f)}），你这只赚了 ${pp.toFixed(0)}%。`,
        `这个月先卖 ${R.takeProfitSlice * 100}%，估值不降就每月再卖一次，钱转到债券。不一次卖光，防止卖早。`] };
    } else if (dev[i.cat] >= R.rebalanceBand) {
      const excess = Math.min(i.amount, (w[i.cat] - T[i.cat]) / 100 * total * share);
      a = i.cat === 'cash'
        ? { k: 'buy', t: '转出补仓', amt: Math.round(excess), why: [`余额宝里放了 ${w[i.cat].toFixed(0)}%，目标 ${T[i.cat]}%，闲置太多。`, `转出 ${fmt(excess)}，补到占比不够、估值不贵的类别。`] }
        : { k: 'sell', t: '减仓', amt: Math.round(excess), why: [`${c.n}现在占 ${w[i.cat].toFixed(0)}%，目标 ${T[i.cat]}%，超了 ${dev[i.cat].toFixed(0)} 个百分点。`, '卖出超出部分，钱补到占比不够的类别。'] };
    } else if (c.eq && sig.m === 0) {
      a = { k: 'stop', t: '暂停买入', amt: 0, why: [`估值${sig.t}（${valText(i.cat, f)}），拿着不动，这个月不再买。`, pp < R.takeProfitPct ? `目前赚 ${pp.toFixed(0)}%，没到 ${R.takeProfitPct}% 的止盈线，不用卖。` : ''] };
    } else {
      const p = planFor(i.code);
      const low = dev[i.cat] <= -R.rebalanceBand;
      if (p && p.amt > 0) a = { k: 'buy', t: low ? '加仓' : '按计划定投', amt: Math.round(p.amt), why: [low ? `${c.n}占 ${w[i.cat].toFixed(0)}%，比目标 ${T[i.cat]}% 少 ${Math.abs(dev[i.cat]).toFixed(0)} 个百分点，估值${sig.t}。` : `比例正常，估值${sig.t}。`, `本月买入 ${fmt(p.amt)}${p.m !== 1 ? `（平时的 ${p.m} 倍）` : ''}。`] };
      else a = { k: 'hold', t: '持有', amt: 0, why: [f.pick ? '比例正常，不用操作。' : '不是推荐基金，但和推荐的差距不大，可以继续拿着，新钱买推荐的那只。'] };
    }
    a.why = a.why.filter(Boolean);
    return Object.assign({}, i, { pp, adv: a });
  });
  const held = new Set(items.map(i => i.code));
  const missing = FUNDS.filter(f => f.pick && !held.has(f.code) && T[f.cat] > 0).map(f => {
    const sig = sigOf(f.cat, f), p = plan.find(x => x.fund && x.fund.code === f.code);
    const a = sig.m === 0 ? { k: 'stop', t: '先不买', amt: 0, why: [`估值${sig.t}（${valText(f.cat, f)}）。等估值回落再开始定投，这部分钱先放余额宝。`] }
      : { k: 'buy', t: '开始买入', amt: p ? Math.round(p.amt) : 0, why: [`组合里还没有${CAT[f.cat].n}这一块，估值${sig.t}，从本月开始定投。`] };
    return { code: f.code, fund: f, cat: f.cat, name: f.name, amount: 0, profit: 0, pp: 0, adv: a, notHeld: true };
  });
  const order = { sell: 0, swap: 1, buy: 2, stop: 3, wait: 3, hold: 4 };
  const advice = adv.concat(missing).sort((x, y) => order[x.adv.k] - order[y.adv.k] || y.amount - x.amount);
  return { T, items, total, profit, byCat, pByCat, w, dev, eqW, expRet, expDd, curDd, plan, parked, extra, planTotal, monthly, advice };
}

/* ================= 实时估值（天天基金 JSONP，交易日 9:30–15:00 更新） ================= */
const LIVE = {}; let liveQueue = Promise.resolve();
function fetchLive(code) {
  if (LIVE[code] && Date.now() - LIVE[code].t < 60000) return Promise.resolve(LIVE[code]);
  // 天天基金的回调名固定是 jsonpgz，所以一次只能请求一只
  liveQueue = liveQueue.then(() => new Promise(resolve => {
    const s = document.createElement('script'); let done = false;
    const finish = v => { if (done) return; done = true; delete window.jsonpgz; s.remove(); resolve(v); };
    window.jsonpgz = d => finish(d && d.fundcode ? (LIVE[code] = Object.assign({ t: Date.now() }, d)) : null);
    s.onerror = () => finish(null); setTimeout(() => finish(null), 6000);
    s.src = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
    document.head.appendChild(s);
  }));
  return liveQueue;
}

/* ================= 图表 ================= */
function donut(segs, size, stroke, top, bot) {
  const r = (size - stroke) / 2, Cc = 2 * Math.PI * r, tot = segs.reduce((a, s) => a + s.v, 0) || 1; let off = 0;
  const live = segs.filter(s => s.v > 0); const gap = live.length > 1 ? 2 : 0;
  const arcs = live.map(s => { const len = s.v / tot * Cc; const d = `<circle r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="var(${s.c})" stroke-width="${stroke}" stroke-dasharray="${Math.max(0, len - gap)} ${Cc}" stroke-dashoffset="${-off}" data-tip="${esc(s.tip)}"/>`; off += len; return d; }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="资产配置环形图" style="flex:none;max-width:100%"><g transform="rotate(-90 ${size / 2} ${size / 2})"><circle r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="var(--fill)" stroke-width="${stroke}"/>${arcs}</g><text x="50%" y="46%" text-anchor="middle" style="fill:var(--muted);font-size:11px">${top}</text><text x="50%" y="61%" text-anchor="middle" style="fill:var(--fg);font-size:18px;font-weight:600">${bot}</text></svg>`;
}
function gaugeHTML(p, zones) {
  zones = zones || [['--brand', 40], ['--faint', 20], ['--warn', 20], ['--stop', 20]];
  return `<div class="gauge" role="img" aria-label="估值分位 ${p == null ? '无数据' : Math.round(p) + '%'}"><div class="gtrack">${zones.map(z => `<span style="flex:${z[1]};background:var(${z[0]});opacity:.5"></span>`).join('')}${p != null ? `<i class="gmark" style="left:${Math.max(0, Math.min(100, p))}%"></i>` : ''}</div><div class="glabels"><span>0 便宜</span><span>40</span><span>60</span><span>80</span><span>100 贵</span></div></div>`;
}
function yearBars(rows, h = 170) {
  rows = (rows || []).filter(r => r.ret != null); if (!rows.length) return '<p class="note">暂无逐年收益数据。</p>';
  const Wd = Math.max(300, rows.length * 64), pad = { l: 38, r: 8, t: 20, b: 24 }, iw = Wd - pad.l - pad.r, ih = h - pad.t - pad.b;
  const mx = Math.max(5, ...rows.map(r => r.ret)), mn = Math.min(-5, ...rows.map(r => r.ret));
  const step = (mx - mn) > 60 ? 20 : (mx - mn) > 30 ? 10 : 5, top = Math.ceil(mx / step) * step, bot = Math.floor(mn / step) * step;
  const y = v => pad.t + ih * (top - v) / (top - bot), slot = iw / rows.length, bw = Math.min(30, slot * .5);
  let g = '';
  for (let v = bot; v <= top; v += step) g += `<line x1="${pad.l}" x2="${Wd - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" ${v === 0 ? 'stroke-width="1.2"' : ''}/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end" style="fill:var(--faint)">${v}%</text>`;
  rows.forEach((r, i) => {
    const cx = pad.l + slot * (i + .5), y0 = y(0), y1 = y(r.ret), tp = Math.min(y0, y1), hh = Math.max(1, Math.abs(y1 - y0)), rx = Math.min(4, hh / 2);
    const x0 = cx - bw / 2, x1 = cx + bw / 2;
    const path = r.ret >= 0 ? `M${x0},${y0} V${tp + rx} Q${x0},${tp} ${x0 + rx},${tp} H${x1 - rx} Q${x1},${tp} ${x1},${tp + rx} V${y0} Z`
      : `M${x0},${y0} V${tp + hh - rx} Q${x0},${tp + hh} ${x0 + rx},${tp + hh} H${x1 - rx} Q${x1},${tp + hh} ${x1},${tp + hh - rx} V${y0} Z`;
    g += `<rect x="${cx - slot / 2}" y="${pad.t}" width="${slot}" height="${ih}" fill="transparent" data-tip="${esc((r.label || r.year) + '：' + pct(r.ret))}"/>`;
    g += `<path d="${path}" fill="${r.ret >= 0 ? 'var(--up)' : 'var(--down)'}" pointer-events="none"/>`;
    g += `<text x="${cx}" y="${r.ret >= 0 ? tp - 5 : tp + hh + 13}" text-anchor="middle" style="fill:var(--muted)" pointer-events="none">${pct(r.ret)}</text>`;
    g += `<text x="${cx}" y="${h - 6}" text-anchor="middle" style="fill:var(--faint)" pointer-events="none">${esc(r.label || r.year)}</text>`;
  });
  return `<div class="tbox"><svg viewBox="0 0 ${Wd} ${h}" style="width:100%;min-width:${Math.min(Wd, 300)}px;height:auto" role="img" aria-label="逐年收益柱状图，红色为上涨，绿色为下跌">${g}</svg></div>`;
}
/* 折线图：pts=[[label, value]]，带十字线提示 */
function lineChart(id, pts, opts) {
  opts = opts || {};
  if (!pts || pts.length < 2) return `<p class="note">${opts.empty || '数据还不够画曲线。'}</p>`;
  const Wd = 640, h = opts.h || 180, pad = { l: 46, r: 12, t: 12, b: 24 }, iw = Wd - pad.l - pad.r, ih = h - pad.t - pad.b;
  const vs = pts.map(p => p[1]); let lo = Math.min(...vs), hi = Math.max(...vs); if (hi === lo) { hi += 1; lo -= 1; }
  const span = hi - lo; lo -= span * .08; hi += span * .08;
  const x = i => pad.l + iw * i / (pts.length - 1), y = v => pad.t + ih * (hi - v) / (hi - lo);
  const ticks = 4; let g = '';
  for (let k = 0; k <= ticks; k++) { const v = lo + (hi - lo) * k / ticks; g += `<line x1="${pad.l}" x2="${Wd - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end" style="fill:var(--faint)">${opts.fmtY ? opts.fmtY(v) : v.toFixed(2)}</text>`; }
  [0, Math.floor((pts.length - 1) / 2), pts.length - 1].forEach((i, n) => g += `<text x="${x(i)}" y="${h - 6}" text-anchor="${n === 0 ? 'start' : n === 2 ? 'end' : 'middle'}" style="fill:var(--faint)">${esc(opts.fmtX ? opts.fmtX(pts[i][0]) : pts[i][0])}</text>`);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p[1]).toFixed(1)).join(' ');
  const col = opts.color || 'var(--brand)';
  g += `<path d="${d} L${x(pts.length - 1)} ${pad.t + ih} L${pad.l} ${pad.t + ih} Z" fill="${col}" fill-opacity=".10"/>`;
  g += `<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>`;
  g += `<circle cx="${x(pts.length - 1)}" cy="${y(pts[pts.length - 1][1])}" r="4" fill="${col}" stroke="var(--card)" stroke-width="2"/>`;
  g += `<g class="xh" style="display:none"><line y1="${pad.t}" y2="${pad.t + ih}" stroke="var(--faint)" stroke-dasharray="3 3"/><circle r="4" fill="${col}" stroke="var(--card)" stroke-width="2"/></g>`;
  g += `<rect x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" fill="transparent" class="hit"/>`;
  LINE[id] = { pts, x, y, pad, iw, Wd, fmt: opts.fmtTip };
  return `<div class="tbox"><svg id="${id}" class="line" viewBox="0 0 ${Wd} ${h}" style="width:100%;min-width:300px;height:auto" role="img" aria-label="${esc(opts.label || '走势图')}">${g}</svg></div>`;
}
const LINE = {};
function scoreBar(v, color) {
  return `<div class="sbar"><div><i style="width:${v}%;background:${color || 'var(--brand)'}"></i></div><span class="n">${v}</span></div>`;
}

/* ================= 页面 ================= */
const ICON = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3.5" y="3.5" width="7" height="8.5" rx="2"/><rect x="13.5" y="3.5" width="7" height="5" rx="2"/><rect x="13.5" y="11.5" width="7" height="9" rx="2"/><rect x="3.5" y="15" width="7" height="5.5" rx="2"/></svg>',
  analysis: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 19.5V5M4 19.5h16"/><path d="M8 15l3.2-4 3 2.2L19 7"/></svg>',
  funds: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5V12l6 5"/></svg>',
  holdings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="6.5" width="18" height="13.5" rx="2.5"/><path d="M3 10.5h18M8.5 6.5V4.5h7v2"/></svg>',
  me: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.2-3.6 4.1-5.3 7.5-5.3s6.3 1.7 7.5 5.3"/></svg>'
};
const TABS = [['home', '看板'], ['analysis', '买卖分析'], ['funds', '基金'], ['holdings', '持仓'], ['me', '我的']];
const TITLES = { home: '看板', analysis: '买卖分析', funds: '基金', holdings: '我的持仓', me: '我的' };
const navHTML = cur => TABS.map(([k, n]) => `<a href="#${k}" ${cur === k ? 'aria-current="page"' : ''}>${ICON[k]}<span>${n}</span></a>`).join('');
const dot = k => `<span class="dot" style="background:var(--s-${k})"></span>`;
const ACTLABEL = { sell: '卖出', swap: '换基', buy: '买入', stop: '暂停', wait: '暂停', hold: '持有' };
const actChip = a => `<span class="act ${a.k}">${esc(a.t)}</span>`;
const sigChip = s => `<span class="act ${s.k}">${esc(s.t)}</span>`;
function amtLine(a) {
  if (!a.amt) return '';
  const verb = a.t === '转出补仓' ? '转出' : a.k === 'buy' ? '买入' : a.k === 'sell' ? '卖出' : a.k === 'swap' ? '换掉' : '';
  return `<span class="n ${a.k === 'buy' && a.t !== '转出补仓' ? 'up' : a.k === 'sell' ? 'down' : ''}">${verb} ${fmt(a.amt)}</span>`;
}
const exampleBanner = () => P.example ? `<div class="banner"><span>现在显示的是<b>示例持仓</b>，不是你的。录入你在支付宝里的持仓后，所有分析都会换成你自己的。</span><a class="btn sm" href="#holdings">录入我的持仓</a></div>` : '';
const riskBanner = () => !P.risk ? `<div class="banner"><span>还没做风险测评，目前按“平衡”型配置。花 1 分钟答 5 道题，比例会更适合你。</span><a class="btn sm" href="#me-quiz">去测评</a></div>` : '';
function dataAge() {
  const d = DATA.updated ? Date.parse(DATA.updated.replace(' ', 'T') + ':00+08:00') : NaN;
  if (isNaN(d)) return '';
  const days = Math.floor((Date.now() - d) / 86400000);
  return days > 4 ? `<div class="banner warn"><span>数据已经 ${days} 天没有更新了，自动更新可能出了问题。估值和收益仅供参考，操作前请在天天基金核对。</span></div>` : '';
}
function daysToInvest() {
  const day = Math.min(28, Math.max(1, +(P.prefs && P.prefs.day) || 10)); const now = new Date();
  let next = new Date(now.getFullYear(), now.getMonth(), day); if (next < new Date(now.getFullYear(), now.getMonth(), now.getDate())) next = new Date(now.getFullYear(), now.getMonth() + 1, day);
  return { day, n: Math.round((next - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000) };
}

function viewHome(A) {
  const segs = C.cats.map(c => ({ v: A.byCat[c.k], c: '--s-' + c.k, tip: `${c.n}：${fmt(A.byCat[c.k])}（${A.w[c.k].toFixed(1)}%）` }));
  const cost = A.total - A.profit, pp = cost > 0 ? A.profit / cost * 100 : 0;
  const todo = A.advice.filter(x => x.adv.k !== 'hold');
  const cnt = k => A.advice.filter(x => (k === 'stop' ? ['stop', 'wait'].includes(x.adv.k) : x.adv.k === k)).length;
  const lv = currentLevel(); const di = daysToInvest(); const mk = monthKey();
  const checked = P.journal.find(j => j.m === mk);
  const hist = P.history.filter(h => h.total > 0).map(h => [h.d, h.total]);
  return `<div class="view">
  ${dataAge()}${exampleBanner()}${riskBanner()}
  <div class="grid3">
    <section class="hero span2" aria-label="资产总览">
      <div class="hero-top"><span class="lbl">总资产（元）</span><span class="pill">${lv.level.n}型 · 目标年化约 ${A.expRet.toFixed(1)}%</span></div>
      <div class="big n">${fmt(A.total, 2).slice(1)}</div>
      <div class="hero-row">
        <div><div class="lbl">持有收益</div><div class="v n ${cls(A.profit)}">${signed(A.profit)}</div></div>
        <div><div class="lbl">收益率</div><div class="v n ${cls(pp)}">${pct(pp, 2)}</div></div>
        <div><div class="lbl">大跌时最多浮亏（估）</div><div class="v n">约 −${Math.round(A.curDd)}%</div></div>
      </div>
      ${A.total ? `<div class="stack" aria-hidden="true">${C.cats.filter(c => A.byCat[c.k] > 0).map(c => `<span style="flex:${A.byCat[c.k]};background:var(--s-${c.k})" data-tip="${c.n} ${A.w[c.k].toFixed(1)}%"></span>`).join('')}</div>
      <div class="tbox"><table><thead><tr><th>类别</th><th class="r">金额</th><th class="r">占比</th><th class="r">目标</th><th class="r">持有收益</th></tr></thead><tbody>${C.cats.filter(c => A.byCat[c.k] > 0 || A.T[c.k] > 0).map(c => `<tr><td>${dot(c.k)} ${c.n}</td><td class="r">${fmt(A.byCat[c.k])}</td><td class="r">${A.w[c.k].toFixed(1)}%</td><td class="r faint">${A.T[c.k]}%</td><td class="r ${cls(A.pByCat[c.k])}">${signed(A.pByCat[c.k])}</td></tr>`).join('')}</tbody></table></div>` : '<p class="note">还没有持仓。去“持仓”页添加第一只基金。</p>'}
    </section>
    <section class="card" aria-label="本月要做的事">
      <div class="card-h"><h3>本月要做的事</h3><a class="more" href="#analysis">全部 ›</a></div>
      <div class="chiprow">${cnt('sell') ? `<span class="act sell">卖出 ${cnt('sell')}</span>` : ''}${cnt('swap') ? `<span class="act swap">换基 ${cnt('swap')}</span>` : ''}${cnt('buy') ? `<span class="act buy">买入 ${cnt('buy')}</span>` : ''}${cnt('stop') ? `<span class="act stop">暂停 ${cnt('stop')}</span>` : ''}${cnt('hold') ? `<span class="act hold">持有 ${cnt('hold')}</span>` : ''}</div>
      <div class="rows">${todo.slice(0, 5).map(x => `<a class="row" href="${x.fund ? '#fund-' + x.fund.code : '#analysis'}"><div class="t">${dot(x.cat)}<span class="ell">${esc(x.fund && x.fund.short || x.name)}</span></div><div class="r">${actChip(x.adv)}</div>${x.adv.amt ? `<div class="s">${amtLine(x.adv)}</div>` : ''}</a>`).join('') || '<p class="muted">这个月不用操作。</p>'}</div>
      <p class="note">下次定投日：每月 ${di.day} 号，${di.n === 0 ? '就是今天' : `还有 ${di.n} 天`}。</p>
    </section>
  </div>

  <div class="grid3">
    <section class="card" aria-label="资产配置">
      <div class="card-h"><h3>资产配置</h3><span class="sub">现在 / 目标</span></div>
      <div class="donutwrap">${donut(segs, 136, 18, '股票类', Math.round(A.eqW) + '%')}
        <div class="legend">${C.cats.map(c => `<div class="li">${dot(c.k)}<span>${c.n}</span><span class="n">${A.w[c.k].toFixed(0)}%</span><span class="n faint">${A.T[c.k]}%</span></div>`).join('')}</div></div>
      ${(() => { const off = C.cats.filter(c => Math.abs(A.dev[c.k]) >= C.rules.rebalanceBand); return A.total ? (off.length ? `<p class="note">偏离目标超过 ${C.rules.rebalanceBand} 个百分点：${off.map(c => `${c.n}${A.dev[c.k] > 0 ? '多' : '少'} ${Math.abs(A.dev[c.k]).toFixed(0)} 个点`).join('，')}。</p>` : '<p class="note">各类比例都在目标附近。</p>') : ''; })()}
    </section>
    <section class="card" aria-label="市场温度">
      <div class="card-h"><h3>市场温度</h3><a class="more" href="#analysis-market">详情 ›</a></div>
      <div class="temp"><span>沪深300 估值分位</span>${sigChip(SIG.index)}<span class="v n">${idxPct == null ? '—' : Math.round(idxPct) + '%'}</span><span class="sub">${cnDate(M.hs300 && M.hs300.date)}</span></div>
      ${gaugeHTML(idxPct)}
      <div class="temp"><span>红利低波 比国债多赚</span>${sigChip(SIG.div)}<span class="v n">${spread == null ? '—' : spread.toFixed(2) + ' 个点'}</span><span class="sub">${cnDate(M.divLowVol && M.divLowVol.date)}</span></div>
      <div class="us">${[['sp500', '标普500'], ['ndx', '纳指100']].map(([k, n]) => `<div class="temp"><span>${n} 估值分位</span>${sigChip(SIGV[k])}<span class="v n">${M[k] && M[k].pePct10y != null ? Math.round(M[k].pePct10y) + '%' : '—'}</span><span class="sub">${cnDate(M[k] && M[k].date)}</span></div>`).join('')}</div>
    </section>
    <section class="card" aria-label="本月定投">
      <div class="card-h"><h3>本月定投 <span class="n">${fmt(A.planTotal)}</span></h3><a class="more" href="#analysis-plan">明细 ›</a></div>
      <div class="rows">${A.plan.map(p => `<a class="row" href="#fund-${p.fund.code}"><div class="t">${dot(p.cat)}<span class="ell">${esc(p.fund.short || p.fund.name)}</span></div><div class="r n strong">${fmt(p.amt)}</div></a>`).join('')}</div>
      ${A.parked > 0 ? `<p class="note">估值贵的类别少买了 ${fmt(A.parked)}，已经算进余额宝，等便宜时再用。</p>` : ''}${A.extra > 0 ? `<p class="note">便宜的类别多买的 ${fmt(A.extra)}，从余额宝里出。</p>` : ''}
    </section>
  </div>

  <div class="grid3">
    <section class="card span2" aria-label="资产走势">
      <div class="card-h"><h3>资产走势</h3><span class="sub">每次更新持仓自动记录</span></div>
      ${lineChart('hist', hist, { label: '总资产走势', fmtY: v => (v / 10000).toFixed(1) + '万', fmtX: cnDate, fmtTip: p => `${cnDate(p[0])}：${fmt(p[1])}`, empty: P.example ? '录入你的真实持仓后，这里会画出总资产的变化。' : '更新两次以上持仓后，这里会画出总资产的变化。建议每月定投后更新一次。' })}
    </section>
    <section class="card" aria-label="本月打卡">
      <div class="card-h"><h3>本月打卡</h3><a class="more" href="#me">执行记录 ›</a></div>
      ${checked ? `<p>这个月已打卡：<b>${esc(CHOICES[checked.choice].t)}</b>。</p><p class="note">系统会根据打卡记录学习你的习惯，调整股票比例和提醒。</p><button class="btn ghost sm" type="button" data-uncheck>改一下</button>`
        : `<p class="muted" style="font-size:13px">这个月你按建议操作了吗？如实选，系统靠它了解你的习惯。</p><div class="checkin">${Object.entries(CHOICES).map(([k, v]) => `<button class="btn ghost" type="button" data-checkin="${k}">${v.t}</button>`).join('')}</div>`}
    </section>
  </div>
  </div>`;
}
const CHOICES = {
  full: { t: '全部照做', s: 100 }, part: { t: '做了一部分', s: 60 }, none: { t: '这个月没操作', s: 40 },
  panic: { t: '跌了，我卖了', s: 0 }, chase: { t: '涨了，我多买了', s: 0 }
};

function viewAnalysis(A) {
  return `<div class="view">
  ${dataAge()}${exampleBanner()}
  <section class="card" id="sec-advice">
    <div class="card-h"><h3>每只基金的操作建议</h3><span class="sub">最需要处理的排在前面</span></div>
    <div class="rows">${A.advice.map(x => `
      <div class="row static">
        <div class="t">${dot(x.cat)}${x.fund ? `<a href="#fund-${x.fund.code}" class="plain">${esc(x.fund.short || x.name)}</a>` : esc(x.name)}${x.notHeld ? '<span class="tag">未持有</span>' : ''}${x.fund && x.fund.pick ? '<span class="tag pick">推荐</span>' : ''}</div>
        <div class="r">${actChip(x.adv)}</div>
        <div class="s why">${x.adv.why.map(w => `<span>${esc(w)}</span>`).join('')}</div>
        <div class="s n">${x.amount ? `持有 ${fmt(x.amount)} · <span class="${cls(x.pp)}">${pct(x.pp)}</span>` : ''}</div>
        <div class="r strong">${amtLine(x.adv)}</div>
      </div>`).join('')}</div>
    <p class="note">处理顺序：先换掉差的，再处理超配和估值过高的，最后按计划买。卖出都分批进行，不一次清仓。</p>
  </section>
  <div class="grid2">
  <section class="card" id="sec-plan">
    <div class="card-h"><h3>本月定投计划</h3><span class="sub">每月基础 ${fmt(A.monthly)}</span></div>
    <div class="tbox"><table><thead><tr><th>基金</th><th>估值信号</th><th class="r">倍数</th><th class="r">金额</th></tr></thead><tbody>
      ${A.plan.map(p => `<tr><td>${dot(p.cat)} <a href="#fund-${p.fund.code}" class="plain">${esc(p.fund.short || p.fund.name)}</a></td><td>${sigChip(p.sig)}</td><td class="r">${p.cat === 'cash' && A.parked > 0 ? '含转入' : p.m + '×'}</td><td class="r strong">${fmt(p.amt)}</td></tr>`).join('')}
      <tr><td colspan="3"><b>合计</b></td><td class="r strong">${fmt(A.planTotal)}</td></tr></tbody></table></div>
    <p class="note">便宜的类别多买，贵的少买或暂停，少买的钱进余额宝。某类比目标少 ${C.rules.catchUpBand} 个点以上且不贵时，额外多买 0.5 倍。${A.extra > 0 ? `本月比平时多出的 ${fmt(A.extra)} 从余额宝里出，不够就按 1 倍买。` : ''}</p>
  </section>
  <section class="card" id="sec-market">
    <div class="card-h"><h3>市场估值</h3><span class="sub">决定每月买多少</span></div>
    <div class="temp"><span>沪深300 市盈率分位（近10年）</span>${sigChip(SIG.index)}<span class="v n">${idxPct == null ? '—' : Math.round(idxPct) + '%'}</span><span class="sub">市盈率 ${M.hs300 && M.hs300.pe != null ? M.hs300.pe : '—'} · ${cnDate(M.hs300 && M.hs300.date)}</span></div>
    ${gaugeHTML(idxPct)}
    <p class="note">${idxPct == null ? '' : `分位 ${Math.round(idxPct)}% 的意思是：过去 10 年里有 ${Math.round(idxPct)}% 的时间比现在便宜。`}低于 40% 多买，高于 80% 暂停。</p>
    <div class="stats">
      <div class="stat"><span class="k">红利低波股息率</span><span class="v n">${M.divLowVol && M.divLowVol.dy != null ? M.divLowVol.dy + '%' : '—'}</span></div>
      <div class="stat"><span class="k">10年国债收益率</span><span class="v n">${M.cgb10y && M.cgb10y.yield != null ? M.cgb10y.yield + '%' : '—'}</span></div>
      <div class="stat"><span class="k">息差</span><span class="v n">${spread == null ? '—' : spread.toFixed(2)}</span></div>
    </div>
    <p class="note">息差大于 2 个点说明红利低波相对便宜，小于 1 个点说明贵了。${esc(M.bondNote || '')}</p>
    <div class="stats">
      <div class="stat"><span class="k">标普500 估值分位</span><span class="v n">${M.sp500 && M.sp500.pePct10y != null ? Math.round(M.sp500.pePct10y) + '%' : '—'}</span></div>
      <div class="stat"><span class="k">纳指100 估值分位</span><span class="v n">${M.ndx && M.ndx.pePct10y != null ? Math.round(M.ndx.pePct10y) + '%' : '—'}</span></div>
      <div class="stat"><span class="k">美国10年国债</span><span class="v n">${M.ust10y && M.ust10y.yield != null ? M.ust10y.yield + '%' : '—'}</span></div>
    </div>
    <p class="note">海外按标普500、纳指100 各自的估值分位决定买多少，规则和 A 股一样。QDII 基金常有限购，买不满的部分留在余额宝。</p>
  </section>
  </div>
  ${(M.hs300Hist && M.hs300Hist.length) || (M.divLowVolHist && M.divLowVolHist.length) ? `<div class="grid2">
    <section class="card"><div class="card-h"><h3>沪深300 逐年涨跌</h3><span class="sub">指数，红涨绿跌</span></div>${yearBars(M.hs300Hist)}</section>
    <section class="card"><div class="card-h"><h3>红利低波 逐年涨跌</h3><span class="sub">指数，红涨绿跌</span></div>${yearBars(M.divLowVolHist)}</section></div>` : ''}
  <section class="card" id="sec-compare">
    <div class="card-h"><h3>同类对比：哪只更好</h3><span class="sub">评分不看近1年涨幅</span></div>
    <div class="seg" role="group" aria-label="选择类别">${C.cats.filter(c => c.k !== 'cash').map(c => `<button class="segbtn" type="button" data-cmp="${c.k}" aria-pressed="${cmpCat === c.k}">${c.n}</button>`).join('')}</div>
    <div id="cmp">${compareTable(cmpCat)}</div>
  </section>
  </div>`;
}
let cmpCat = 'index';
function compareTable(k) {
  const fs = FUNDS.filter(f => f.cat === k).sort((a, b) => a.rank - b.rank);
  const wk = Object.keys(W[k]).map(x => MNAME[x] + ' ' + Math.round(W[k][x] * 100) + '%').join(' · ');
  return `<div class="tbox"><table><thead><tr><th>基金</th><th style="min-width:120px">评分</th><th class="r">年费率</th><th class="r">规模(亿)</th><th class="r">近3年</th><th class="r">最大回撤</th></tr></thead><tbody>
    ${fs.map(f => `<tr class="${f.pick ? 'best' : ''}"><td><a href="#fund-${f.code}" class="plain strong">${esc(f.short || f.name)}</a> ${f.pick ? '<span class="tag pick">推荐</span>' : ''}<div class="sub n">${f.code}</div></td><td>${scoreBar(f.score)}</td><td class="r">${totalFee(f) == null ? '—' : totalFee(f).toFixed(2) + '%'}</td><td class="r">${f.scaleYi == null ? '—' : f.scaleYi.toFixed(0)}</td><td class="r ${cls(f.ret3y)}">${pct(f.ret3y)}</td><td class="r">${f.maxDd3y == null ? '—' : '−' + Math.abs(f.maxDd3y).toFixed(1) + '%'}</td></tr>`).join('')}
  </tbody></table></div><p class="note">评分权重：${wk}。缺数据的项按偏低分计。推荐基金不一定分数最高，理由见基金详情里的“我的判断”。</p>`;
}

let fundFilter = 'all';
function viewFunds() {
  const order = c => C.cats.findIndex(x => x.k === c);
  const list = FUNDS.filter(f => fundFilter === 'all' ? true : fundFilter === 'pick' ? f.pick : f.cat === fundFilter)
    .sort((a, b) => (!!b.pick - !!a.pick) || order(a.cat) - order(b.cat) || a.rank - b.rank);
  return `<div class="view">
  <div class="seg" role="group" aria-label="筛选">${[['all', '全部'], ['pick', '推荐组合'], ...C.cats.map(c => [c.k, c.n])].map(([k, n]) => `<button class="segbtn" type="button" data-ff="${k}" aria-pressed="${fundFilter === k}">${n}</button>`).join('')}</div>
  <section class="card"><div class="rows">${list.map(f => `
    <a class="row" href="#fund-${f.code}">
      <div class="t">${dot(f.cat)}<span class="ell">${esc(f.short || f.name)}</span>${f.pick ? '<span class="tag pick">推荐</span>' : ''}</div>
      <div class="r"><div class="v n ${cls(f.cat === 'cash' ? null : f.ret3y)}">${f.cat === 'cash' ? (f.yield7d != null ? f.yield7d.toFixed(2) + '%' : '—') : pct(f.ret3y)}</div></div>
      <div class="s n">${f.code} · ${CAT[f.cat].n} · 评分 ${f.score}（同类第 ${f.rank}/${f.peers}）</div>
      <div class="s rt">${f.cat === 'cash' ? '七日年化' : '近3年'}</div>
    </a>`).join('')}</div></section>
  <p class="note">数据截至 ${esc(DATA.updated)}。点进基金可以看当天盘中的实时估值。</p>
  </div>`;
}

function viewFund(code, A) {
  const f = FUND[code]; if (!f) return `<div class="view"><button class="back" type="button" data-back>‹ 返回</button><p>没有找到这只基金。</p></div>`;
  const c = CAT[f.cat], sig = sigOf(f.cat, f), hold = A.advice.find(x => x.code === code);
  const peers = FUNDS.filter(x => x.cat === f.cat).sort((a, b) => a.rank - b.rank);
  const parts = Object.keys(W[f.cat]).map(k => `<div class="part"><span class="muted">${MNAME[k]}</span>${scoreBar(Math.round(f.parts[k] * 100), `var(--s-${f.cat})`)}</div>`).join('');
  return `<div class="view">
  <button class="back" type="button" data-back>‹ 返回</button>
  <section class="card">
    <div class="fhead">
      <div class="fname"><h2>${esc(f.name || f.short)}</h2><div class="sub n">${f.code} · ${c.n}${f.index ? ' · 跟踪' + esc(f.index) : ''}${f.manager ? ' · 经理 ' + esc(f.manager) : ''}</div>
        <div class="chiprow">${f.pick ? '<span class="tag pick">推荐组合</span>' : '<span class="tag">备选</span>'}<span class="tag">评分 ${f.score} · 同类第 ${f.rank}/${f.peers}</span>${hold ? actChip(hold.adv) : ''}</div></div>
      <div class="live" id="live" aria-live="polite">
        <div class="sub">${f.cat === 'cash' ? '七日年化' : '单位净值'} · ${cnDate(f.navDate) || '—'}</div>
        <div class="n bigv">${f.cat === 'cash' ? (f.yield7d != null ? f.yield7d.toFixed(3) + '%' : '—') : (f.nav != null ? f.nav.toFixed(4) : '—')}</div>
        ${f.cat === 'cash' ? '' : '<div class="sub" id="live-est">正在读取实时估值…</div>'}
      </div>
    </div>
    <div class="stats">
      <div class="stat"><span class="k">今年以来</span><span class="v n ${cls(f.retYtd)}">${pct(f.retYtd)}</span></div>
      <div class="stat"><span class="k">近1年</span><span class="v n ${cls(f.ret1y)}">${pct(f.ret1y)}</span></div>
      <div class="stat"><span class="k">近3年</span><span class="v n ${cls(f.ret3y)}">${pct(f.ret3y)}</span></div>
      <div class="stat"><span class="k">近3年最大回撤</span><span class="v n">${f.maxDd3y == null ? '—' : '−' + Math.abs(f.maxDd3y).toFixed(1) + '%'}</span></div>
      <div class="stat"><span class="k">规模</span><span class="v n">${f.scaleYi == null ? '—' : f.scaleYi.toFixed(1) + ' 亿'}</span></div>
      <div class="stat"><span class="k">年费率合计</span><span class="v n">${totalFee(f) == null ? '—' : totalFee(f).toFixed(2) + '%'}</span></div>
    </div>
    <div class="btnrow">
      <a class="btn" href="https://fund.eastmoney.com/${f.code}.html" target="_blank" rel="noopener">在天天基金查看 ↗</a>
      <button class="btn ghost" type="button" data-copy="${f.code}">复制代码，去支付宝搜</button>
    </div>
    <p class="note">收益和回撤按累计净值计算，截至 ${esc(cnDate(f.retDate) || '—')}；规模截至 ${esc(f.scaleDate || '—')}。</p>
  </section>
  ${f.curve && f.curve.length > 2 ? `<section class="card"><div class="card-h"><h3>近3年累计净值</h3><span class="sub">按周</span></div>${lineChart('nav', f.curve, { label: '近3年累计净值走势', fmtX: s => s.slice(0, 7), fmtTip: p => `${cnDate(p[0])}：${p[1].toFixed(4)}`, color: `var(--s-${f.cat})` })}</section>` : ''}
  <div class="grid2">
    <section class="card"><div class="card-h"><h3>我的判断</h3>${f.pick ? '<span class="tag pick">入选理由</span>' : '<span class="tag">备选</span>'}</div>
      <div class="thesis"><div><b>为什么${f.pick ? '选它' : '看它'}</b><span>${esc(f.why || '—')}</span></div><div><b>主要风险</b><span>${esc(f.risk || '—')}</span></div><div><b>什么时候卖</b><span>${esc(f.exit || '—')}</span></div></div>
      ${f.notes ? `<p class="note">公告提示：${esc(f.notes)}</p>` : ''}
    </section>
    <section class="card"><div class="card-h"><h3>现在该怎么做</h3>${hold ? actChip(hold.adv) : sigChip(sig)}</div>
      ${hold ? `<div class="why">${hold.adv.why.map(w => `<span>${esc(w)}</span>`).join('')}</div>${hold.adv.amt ? `<div class="bigamt">${amtLine(hold.adv)}</div>` : ''}`
        : `<p>你没有持有它，它也不在推荐组合里。${sig.m === 0 ? '现在估值贵，不建议买。' : '要买同类的话，优先买推荐的那只。'}</p>`}
      ${f.cat === 'index' || f.cat === 'active' ? `<div class="temp"><span>沪深300 估值分位 ${idxPct == null ? '—' : Math.round(idxPct) + '%'}</span>${sigChip(sig)}</div>${gaugeHTML(idxPct)}` : f.cat === 'div' ? `<div class="temp"><span>息差 ${spread == null ? '—' : spread.toFixed(2) + ' 个点'}</span>${sigChip(sig)}</div>` : f.cat === 'overseas' ? `<div class="temp"><span>${valText('overseas', f)}</span>${sigChip(sig)}</div>${gaugeHTML(M[f.val] && M[f.val].pePct10y)}` : ''}
      ${f.limit ? `<p class="note">限购：${esc(f.limit)}${f.limitDate ? `（${esc(f.limitDate)} 公告）` : ''}。买不进去时，多出来的钱先放余额宝，下个月再买。</p>` : ''}
    </section>
  </div>
  <div class="grid2">
    <section class="card"><div class="card-h"><h3>逐年收益</h3><span class="sub">红涨绿跌</span></div>${yearBars(f.yearRets)}</section>
    <section class="card"><div class="card-h"><h3>评分拆解</h3><span class="n strong">${f.score} 分</span></div>${parts}${f.missing.length ? `<p class="note">缺少数据：${f.missing.join('、')}，按偏低分计。</p>` : ''}</section>
  </div>
  <section class="card"><div class="card-h"><h3>同类对比</h3><span class="sub">${c.n}</span></div>
    <div class="rows">${peers.map(p => `<a class="row ${p.code === code ? 'cur' : ''}" href="#fund-${p.code}"><div class="t"><span class="n faint">${p.rank}</span><span class="ell">${esc(p.short || p.name)}</span>${p.pick ? '<span class="tag pick">推荐</span>' : ''}</div><div class="r n strong">${p.score}</div><div class="s n">费率 ${totalFee(p) == null ? '—' : totalFee(p).toFixed(2) + '%'} · 规模 ${p.scaleYi == null ? '—' : p.scaleYi.toFixed(0) + '亿'} · 近3年 ${pct(p.ret3y)}</div></a>`).join('')}</div>
  </section>
  </div>`;
}
function loadLive(code) {
  const el = $('#live-est'); if (!el) return;
  fetchLive(code).then(d => {
    const e = $('#live-est'); if (!e || location.hash !== '#fund-' + code) return;
    if (!d || d.gsz == null) { e.textContent = '暂时读不到实时估值，点“在天天基金查看”。'; return; }
    const ch = parseFloat(d.gszzl);
    e.innerHTML = `实时估值 <b class="n ${cls(ch)}">${(+d.gsz).toFixed(4)}（${pct(ch, 2)}）</b> · ${esc(String(d.gztime || '').slice(5))}`;
  });
}

function viewHoldings() {
  const opts = C.cats.map(c => `<optgroup label="${c.n}">${FUNDS.filter(f => f.cat === c.k).map(f => `<option value="${f.code}">${esc(f.short || f.name)} ${f.code}</option>`).join('')}</optgroup>`).join('') + '<option value="__other">其他基金（不在名单里）</option>';
  return `<div class="view">
  <section class="card">
    <div class="card-h"><h3>${esc(P.name)}的持仓</h3><span class="sync ${storageOk ? 'ok' : ''}">${storageOk ? '已保存在这台设备' : '无法保存：浏览器禁止了本地存储'}</span></div>
    <p class="note">打开支付宝 → 理财 → 基金 → 持有，把每只基金的“金额”和“持有收益”抄过来。亏损填负数，比如 -350。每月定投后更新一次。</p>
    ${P.example ? '<div class="banner"><span>下面是示例数据。改任何一个数字，就开始保存你自己的持仓。</span><button class="btn sm ghost" type="button" data-clear>清空示例</button></div>' : ''}
    <div id="hold-list">${P.items.map((it, idx) => { const f = FUND[it.code]; return `<div class="hold-item">
      <div class="nm">${f ? dot(f.cat) + ' ' + esc(f.short || f.name) : dot(CAT[it.cat] ? it.cat : 'active') + ' ' + esc(it.name || '其他基金')}<span class="sub n">${f ? f.code : '不在名单里 · ' + esc((CAT[it.cat] || CAT.active).n)}</span></div>
      <label class="field">金额（元）<input type="number" inputmode="decimal" id="h-amt-${idx}" data-i="${idx}" data-f="amount" value="${it.amount ?? ''}"></label>
      <label class="field">持有收益（元）<input type="number" inputmode="decimal" id="h-pro-${idx}" data-i="${idx}" data-f="profit" value="${it.profit ?? ''}"></label>
      <button class="icon-btn" type="button" data-del="${idx}" aria-label="删除 ${esc(f ? f.short || f.name : it.name)}">✕</button></div>`; }).join('') || '<p class="muted pad">还没有持仓，从下面添加第一只基金。</p>'}</div>
  </section>
  <section class="card">
    <h3>添加基金</h3>
    <div class="addrow"><label class="field">选择基金<select id="add-code">${opts}</select></label><button class="btn" type="button" id="add-btn">添加</button></div>
    <div id="other-box" class="twocol" hidden>
      <label class="field">基金名称<input id="other-name" type="text" placeholder="比如 某某医药ETF联接" class="txt"></label>
      <label class="field">属于哪一类<select id="other-cat">${C.cats.map(c => `<option value="${c.k}" ${c.k === 'active' ? 'selected' : ''}>${c.n}${c.k === 'active' ? '（含行业主题）' : ''}</option>`).join('')}</select></label>
    </div>
  </section>
  </div>`;
}

function viewMe() {
  const lv = currentLevel(), T = targets(), L = lv.L;
  const ans = (P.risk && P.risk.ans) || [];
  const scores = P.journal.slice(-6).map(j => CHOICES[j.choice] ? CHOICES[j.choice].s : 0);
  const exec = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  const avoid = P.prefs.avoid || [];
  return `<div class="view">
  <section class="card">
    <div class="card-h"><h3>用户</h3><span class="sub">每个人的持仓、测评和记录分开保存</span></div>
    <div class="users">${Object.entries(STORE.profiles).map(([id, p]) => `<button type="button" class="user ${id === STORE.current ? 'on' : ''}" data-user="${id}" aria-pressed="${id === STORE.current}"><span class="avatar">${esc((p.name || '?').slice(0, 1))}</span><span>${esc(p.name)}</span></button>`).join('')}
      <button type="button" class="user add" data-adduser><span class="avatar">＋</span><span>添加用户</span></button></div>
    <div class="twocol"><label class="field">当前用户的名字<input id="pname" type="text" class="txt" value="${esc(P.name)}" maxlength="12"></label>
      <div class="field"><span>&nbsp;</span>${Object.keys(STORE.profiles).length > 1 ? (delArm ? `<div class="btnrow"><button class="btn danger" type="button" data-deluser>确认删除“${esc(P.name)}”</button><button class="btn ghost" type="button" data-delcancel>取消</button></div>` : `<button class="btn ghost" type="button" data-delask>删除这个用户</button>`) : ''}</div></div>
  </section>

  <div class="grid2">
  <section class="card" id="me-quiz">
    <div class="card-h"><h3>风险测评</h3>${P.risk ? `<span class="tag pick">${C.levels[lv.base].n}型 · ${P.risk.score} 分</span>` : '<span class="tag">未测评</span>'}</div>
    <form id="quiz" class="quiz">${C.quiz.map((q, qi) => `<fieldset><legend>${qi + 1}. ${esc(q.q)}</legend><div class="opts">${q.a.map((a, ai) => `<label class="opt"><input type="radio" name="q${qi}" id="q${qi}-${ai}" value="${ai}" ${ans[qi] === ai ? 'checked' : ''}><span>${esc(a)}</span></label>`).join('')}</div></fieldset>`).join('')}
      <div class="btnrow"><button class="btn" type="submit">${P.risk ? '重新测评' : '提交测评'}</button><span class="note" id="quiz-msg"></span></div></form>
  </section>
  <div class="view">
  <section class="card">
    <div class="card-h"><h3>系统为你定的比例</h3><span class="tag pick">${lv.level.n}型</span></div>
    <div class="stack big" aria-hidden="true">${C.cats.filter(c => T[c.k] > 0).map(c => `<span style="flex:${T[c.k]};background:var(--s-${c.k})"></span>`).join('')}</div>
    <div class="legend">${C.cats.map(c => `<div class="li">${dot(c.k)}<span>${c.n}</span><span class="n">${T[c.k]}%</span><span></span></div>`).join('')}</div>
    <p class="note">粗略估计：长期年化约 ${C.cats.reduce((a, c) => a + T[c.k] / 100 * c.ret, 0).toFixed(1)}%，大跌时最多浮亏约 ${Math.round(C.cats.reduce((a, c) => a + T[c.k] / 100 * c.dd, 0))}%。不是保证。</p>
  </section>
  <section class="card">
    <div class="card-h"><h3>系统学到的</h3><span class="sub">来自打卡和持仓记录</span></div>
    ${L.notes.length ? `<div class="rows">${L.notes.map(n => `<div class="row static"><div class="t"><span class="act ${n.k}">${n.k === 'sell' ? '已调整' : '提醒'}</span></div><div></div><div class="s why">${esc(n.t)}</div></div>`).join('')}</div>` : '<p class="muted">还没有发现需要调整的习惯。坚持每月打卡，系统会越来越了解你。</p>'}
  </section>
  </div>
  </div>

  <div class="grid2">
  <section class="card">
    <h3>偏好</h3>
    <div class="twocol">
      <label class="field">每月定投金额（元）<input type="number" inputmode="decimal" id="pref-monthly" value="${P.monthly || ''}"></label>
      <label class="field">每月几号定投<input type="number" inputmode="numeric" id="pref-day" min="1" max="28" value="${P.prefs.day || 10}"></label>
    </div>
    <label class="field">海外比例（标普500 : 纳指100 = 7 : 3）<select id="pref-overseas">${[[0, `按风险档位（${currentLevel().level.target.overseas}%）`], [20, '20%'], [25, '25%（建议上限）']].map(([v, n]) => `<option value="${v}" ${(+P.prefs.overseasPct || 0) === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <label class="switch"><input type="checkbox" id="pref-noactive" ${P.prefs.noActive ? 'checked' : ''}><span>不买主动基金（全部用指数基金）</span></label>
    <div class="field"><span>不想碰的行业（名单外的基金名字里有这些字，会建议卖出）</span><div class="opts wrap">${C.avoidOptions.map(a => `<label class="opt"><input type="checkbox" data-avoid="${esc(a)}" ${avoid.includes(a) ? 'checked' : ''}><span>${esc(a)}</span></label>`).join('')}</div></div>
  </section>
  <section class="card">
    <div class="card-h"><h3>执行记录</h3>${exec != null ? `<span class="tag ${exec >= 70 ? 'pick' : ''}">近 6 个月执行分 ${exec}</span>` : ''}</div>
    ${P.journal.length ? `<div class="rows">${P.journal.slice().reverse().slice(0, 12).map(j => `<div class="row static"><div class="t n">${esc(j.m.replace('-', ' 年 '))} 月</div><div class="r"><span class="act ${CHOICES[j.choice].s >= 60 ? 'hold' : CHOICES[j.choice].s ? 'wait' : 'sell'}">${esc(CHOICES[j.choice].t)}</span></div></div>`).join('')}</div>` : '<p class="muted">还没有记录。每月在看板上的“本月打卡”选一下就行。</p>'}
    <p class="note">执行分：全部照做 100，做了一部分 60，没操作 40，追涨或割肉 0。</p>
  </section>
  </div>

  <section class="card">
    <div class="card-h"><h3>备份与换设备</h3><span class="sub">数据只存在这台设备的浏览器里</span></div>
    <p class="note">换手机、换 iPad，或者清理浏览器之前，先导出一份。到新设备上导入，就能接着用。导出内容包括所有用户。</p>
    <div class="btnrow"><button class="btn" type="button" data-export>导出备份</button><button class="btn ghost" type="button" data-import>导入备份</button><input type="file" id="import-file" accept=".json,application/json" hidden></div>
    <textarea id="backup-text" class="backup" hidden readonly aria-label="备份内容"></textarea>
  </section>
  </div>`;
}
let delArm = false;

/* ================= 路由 ================= */
let curView = '';
function render(force) {
  const h = (location.hash || '#home').slice(1);
  const A = analyze();
  let html, tab = h.split('-')[0];
  if (h.startsWith('fund-')) { html = viewFund(h.slice(5), A); tab = 'funds'; }
  else if (tab === 'analysis') html = viewAnalysis(A);
  else if (tab === 'funds') html = viewFunds();
  else if (tab === 'holdings') html = viewHoldings();
  else if (tab === 'me') html = viewMe();
  else { html = viewHome(A); tab = 'home'; }
  const main = $('#main'), same = curView === h, y = window.scrollY;
  if (!force && same && main.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  main.innerHTML = html; curView = h;
  $('#vtitle').textContent = h.startsWith('fund-') ? ((FUND[h.slice(5)] || {}).short || '基金') : TITLES[tab];
  document.title = $('#vtitle').textContent + ' · 稳健基金看板';
  document.querySelectorAll('.navtabs').forEach(n => n.innerHTML = navHTML(tab));
  $('#who').textContent = P.name; $('#who-i').textContent = (P.name || '我').slice(0, 1);
  if (same) window.scrollTo(0, y);
  else {
    const anchor = { 'analysis-plan': 'sec-plan', 'analysis-market': 'sec-market', 'me-quiz': 'me-quiz' }[h];
    if (anchor) document.getElementById(anchor)?.scrollIntoView(); else window.scrollTo(0, 0);
  }
  if (h.startsWith('fund-')) loadLive(h.slice(5));
  if (tab === 'holdings') bindHoldings();
  if (tab === 'me') bindMe();
}
window.addEventListener('hashchange', () => { delArm = false; render(); });

/* ================= 交互 ================= */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-cmp],[data-ff],[data-copy],[data-back],[data-del],[data-clear],#add-btn,[data-checkin],[data-uncheck],[data-user],[data-adduser],[data-delask],[data-delcancel],[data-deluser],[data-export],[data-import]');
  if (!t) return;
  const d = t.dataset;
  if (d.cmp) { cmpCat = d.cmp; document.querySelectorAll('[data-cmp]').forEach(b => b.setAttribute('aria-pressed', b === t)); $('#cmp').innerHTML = compareTable(cmpCat); }
  else if (d.ff) { fundFilter = d.ff; render(true); }
  else if (d.copy) copyText(d.copy, '已复制 ' + d.copy + '，去支付宝搜索框粘贴');
  else if ('back' in d) { if (history.length > 1) history.back(); else location.hash = '#funds'; }
  else if (d.del != null) { P.items.splice(+d.del, 1); touchPortfolio(); render(true); toast('已删除'); }
  else if ('clear' in d) { P.items = []; touchPortfolio(); render(true); }
  else if (t.id === 'add-btn') {
    const code = $('#add-code').value;
    if (P.example) P.items = [];
    if (code === '__other') {
      const nm = $('#other-name').value.trim(); if (!nm) { toast('先填基金名称'); $('#other-name').focus(); return; }
      P.items.push({ code: 'other-' + Date.now(), name: nm.slice(0, 40), cat: $('#other-cat').value, amount: 0, profit: 0 });
    } else { if (P.items.some(i => i.code === code)) { toast('这只已经在持仓里了'); return; } P.items.push({ code, amount: 0, profit: 0 }); }
    touchPortfolio(); render(true); toast('已添加，填上金额和收益');
    const last = document.getElementById('h-amt-' + (P.items.length - 1)); if (last) last.focus();
  }
  else if (d.checkin) { const mk = monthKey(); P.journal = P.journal.filter(j => j.m !== mk); P.journal.push({ m: mk, choice: d.checkin, at: new Date().toISOString() }); P.journal.sort((a, b) => a.m < b.m ? -1 : 1); save(); render(true); toast(d.checkin === 'panic' || d.checkin === 'chase' ? '已记录。如实记录才能帮你改掉习惯。' : '已打卡'); }
  else if ('uncheck' in d) { const mk = monthKey(); P.journal = P.journal.filter(j => j.m !== mk); save(); render(true); }
  else if (d.user) { STORE.current = d.user; P = STORE.profiles[d.user]; delArm = false; save(); render(true); toast('已切换到 ' + P.name); }
  else if ('adduser' in d) { const id = 'p' + Date.now(); STORE.profiles[id] = newProfile('用户' + Object.keys(STORE.profiles).length); STORE.current = id; P = STORE.profiles[id]; save(); render(true); $('#pname')?.select(); toast('已添加新用户，先改个名字'); }
  else if ('delask' in d) { delArm = true; render(true); }
  else if ('delcancel' in d) { delArm = false; render(true); }
  else if ('deluser' in d) { delete STORE.profiles[STORE.current]; STORE.current = Object.keys(STORE.profiles)[0]; P = STORE.profiles[STORE.current]; delArm = false; save(); render(true); toast('已删除'); }
  else if ('export' in d) exportBackup();
  else if ('import' in d) $('#import-file').click();
});
function bindHoldings() {
  const sel = $('#add-code'), box = $('#other-box');
  sel.addEventListener('change', () => { box.hidden = sel.value !== '__other'; });
  document.querySelectorAll('#hold-list input').forEach(inp => {
    inp.addEventListener('input', () => { const it = P.items[+inp.dataset.i]; if (!it) return; const v = inp.value === '' ? 0 : Number(inp.value); if (isNaN(v)) return; it[inp.dataset.f] = v; P.example = false; save(); });
    inp.addEventListener('change', () => { touchPortfolio(); });
  });
}
function bindMe() {
  $('#pname').addEventListener('change', e => { P.name = e.target.value.trim().slice(0, 12) || '我'; save(); render(true); });
  $('#pref-monthly').addEventListener('change', e => { const v = Math.max(0, Number(e.target.value) || 0); P.monthly = v; save(); toast('已保存'); });
  $('#pref-day').addEventListener('change', e => { const v = Math.min(28, Math.max(1, Math.round(Number(e.target.value) || 10))); P.prefs.day = v; e.target.value = v; save(); toast('已保存'); });
  $('#pref-overseas').addEventListener('change', e => { P.prefs.overseasPct = +e.target.value || 0; save(); render(true); toast('已调整海外比例'); });
  $('#pref-noactive').addEventListener('change', e => { P.prefs.noActive = e.target.checked; save(); render(true); });
  document.querySelectorAll('[data-avoid]').forEach(cb => cb.addEventListener('change', () => { P.prefs.avoid = [...document.querySelectorAll('[data-avoid]:checked')].map(x => x.dataset.avoid); save(); }));
  $('#quiz').addEventListener('submit', e => {
    e.preventDefault();
    const ans = C.quiz.map((_, i) => { const c = document.querySelector(`input[name="q${i}"]:checked`); return c ? +c.value : null; });
    const r = quizLevel(ans);
    if (!r) { $('#quiz-msg').textContent = '还有题没选。'; return; }
    P.risk = { ans, score: r.score, i: r.i, at: new Date().toISOString() }; save(); render(true);
    toast(`测评完成：${C.levels[r.i].n}型`);
  });
  $('#import-file').addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const s = JSON.parse(rd.result);
        if (!s || !s.profiles || typeof s.profiles !== 'object') throw new Error('bad');
        Object.values(s.profiles).forEach(p => { p.items = Array.isArray(p.items) ? p.items : []; p.history = Array.isArray(p.history) ? p.history : []; p.journal = Array.isArray(p.journal) ? p.journal.filter(j => CHOICES[j.choice]) : []; p.prefs = Object.assign({ day: 10, noActive: false, avoid: [] }, p.prefs || {}); });
        STORE = s; if (!STORE.profiles[STORE.current]) STORE.current = Object.keys(STORE.profiles)[0];
        P = STORE.profiles[STORE.current]; save(); render(true); toast('导入成功');
      } catch (err) { toast('这个文件不是本看板导出的备份'); }
    };
    rd.readAsText(file);
  });
}
function exportBackup() {
  const txt = JSON.stringify(Object.assign({ app: 'money', exportedAt: new Date().toISOString() }, STORE), null, 1);
  try {
    const blob = new Blob([txt], { type: 'application/json' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `基金看板备份-${today()}.json`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000); toast('已导出。iPhone 上会存到“文件”App');
  } catch (e) { const ta = $('#backup-text'); ta.hidden = false; ta.value = txt; ta.select(); toast('下载不了，内容已显示在下面，可以全选复制'); }
}
function copyText(text, ok) {
  const fb = () => toast('代码：' + text);
  try { navigator.clipboard.writeText(text).then(() => toast(ok), fb); } catch (e) { fb(); }
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 2400); }

/* 提示框 + 折线十字线 */
const tip = $('#tip');
function showTip(text, cx, cy) { tip.textContent = text; tip.style.opacity = 1; const x = Math.min(window.innerWidth - tip.offsetWidth - 8, cx + 12), y = Math.max(8, cy - tip.offsetHeight - 12); tip.style.left = x + 'px'; tip.style.top = y + 'px'; }
document.addEventListener('pointermove', e => {
  const svg = e.target.closest && e.target.closest('svg.line');
  if (svg && LINE[svg.id]) {
    const L = LINE[svg.id], r = svg.getBoundingClientRect(), sx = (e.clientX - r.left) * (L.Wd / r.width);
    const i = Math.max(0, Math.min(L.pts.length - 1, Math.round((sx - L.pad.l) / L.iw * (L.pts.length - 1))));
    const g = svg.querySelector('.xh'); g.style.display = ''; const px = L.x(i), py = L.y(L.pts[i][1]);
    g.querySelector('line').setAttribute('x1', px); g.querySelector('line').setAttribute('x2', px); g.querySelector('circle').setAttribute('cx', px); g.querySelector('circle').setAttribute('cy', py);
    showTip(L.fmt ? L.fmt(L.pts[i]) : `${L.pts[i][0]}：${L.pts[i][1]}`, e.clientX, e.clientY); return;
  }
  document.querySelectorAll('svg.line .xh').forEach(g => g.style.display = 'none');
  const el = e.target.closest && e.target.closest('[data-tip]');
  if (!el) { tip.style.opacity = 0; return; }
  showTip(el.getAttribute('data-tip'), e.clientX, e.clientY);
});
document.addEventListener('pointerdown', e => { if (!e.target.closest('[data-tip],svg.line')) tip.style.opacity = 0; });

/* ================= 启动 ================= */
async function boot() {
  try {
    const r = await fetch('data/data.json?v=' + Math.floor(Date.now() / 600000), { cache: 'no-cache' });
    DATA = await r.json();
  } catch (e) { $('#main').innerHTML = '<div class="card"><h3>数据加载失败</h3><p class="note">请检查网络后刷新页面。</p></div>'; return; }
  M = DATA.market || {};
  const byCode = Object.fromEntries((DATA.funds || []).map(f => [f.code, f]));
  FUNDS = C.funds.map(cf => Object.assign({ code: cf.code }, byCode[cf.code] || {}, cf));
  FUND = Object.fromEntries(FUNDS.map(f => [f.code, f]));
  CAT = Object.fromEntries(C.cats.map(c => [c.k, c]));
  Object.values(STORE.profiles).forEach(p => { p.prefs = Object.assign({ day: 10, noActive: false, avoid: [] }, p.prefs || {}); p.history = p.history || []; p.journal = (p.journal || []).filter(j => CHOICES[j.choice]); p.items = p.items || []; });
  computeSignals(); scoreAll();
  $('#datestamp').textContent = '数据更新：' + (DATA.updated || '—');
  $('#sidefoot').textContent = `数据更新：${DATA.updated || '—'}。净值、估值每个交易日自动更新，基金详情页显示盘中实时估值。`;
  render(true);
}
boot();
})();
