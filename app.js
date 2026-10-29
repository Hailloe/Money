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

/* 每月打卡的选项和执行分 */
const CHOICES = {
  full: { t: '全部照做', s: 100 }, part: { t: '做了一部分', s: 60 }, none: { t: '这个月没操作', s: 40 },
  panic: { t: '跌了，我卖了', s: 0 }, chase: { t: '涨了，我多买了', s: 0 }
};

/* ================= 用户档案（保存在本机浏览器） ================= */
const LS = 'money.v1';
const EXAMPLE_MONTHLY = 2000;   // 示例数据按每月 2000 元算；新用户自己的金额默认是 0，要自己填
const EXAMPLE_ITEMS = [
  { code: '050025', amount: 3000, profit: 210 },
  { code: '007901', amount: 10000, profit: 185 },
  { code: '460300', amount: 15000, profit: 1620 },
  { code: '007466', amount: 6000, profit: 310 },
  { code: 'other-demo', name: '某白酒行业指数基金（示例）', cat: 'active', amount: 6000, profit: -1350 }
];
function newProfile(name) {
  return { name, example: true, monthly: 0, items: JSON.parse(JSON.stringify(EXAMPLE_ITEMS)),
    risk: null, prefs: { day: 10, noActive: false, avoid: [], overseasPct: 0 }, history: [], journal: [], sellPlans: {} };
}
/* 检查并修复一份档案数据：导入备份和读取本机数据都要过这一步，坏数据不会让页面卡死 */
const num = v => (typeof v === 'number' && isFinite(v)) ? v : (v === '' || v == null ? 0 : (isFinite(+v) ? +v : 0));
let CASH_DROPPED = false;
const CASH_NOTE = new WeakMap();   // 这次打开时，哪个用户的余额宝被移出了、移出多少（只提示一次）
function cleanProfile(p, fallbackName) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  let dropped = 0;
  const out = newProfile(typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 12) : fallbackName);
  out.example = p.example === true;
  out.monthly = Math.max(0, num(p.monthly));
  out.items = (Array.isArray(p.items) ? p.items : []).filter(i => i && typeof i === 'object' && typeof i.code === 'string')
    .filter((i, idx, arr) => arr.findIndex(x => x && x.code === i.code) === idx)
    .filter(i => { if (i.code === '000198' || i.cat === 'cash') { CASH_DROPPED = true; dropped += Math.max(0, num(i.amount)); return false; } return true; })   // 余额宝不再算进组合：旧数据里的直接移出持仓，不用卖
    .map(i => ({ code: i.code.slice(0, 40), name: typeof i.name === 'string' ? i.name.slice(0, 40) : undefined, cat: typeof i.cat === 'string' ? i.cat : undefined, amount: num(i.amount), profit: num(i.profit) }));
  out.history = (Array.isArray(p.history) ? p.history : []).filter(h => h && typeof h.d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(h.d)).map(h => ({ d: h.d, total: num(h.total), profit: num(h.profit), eq: num(h.eq) })).slice(-600);
  out.journal = (Array.isArray(p.journal) ? p.journal : []).filter(j => j && typeof j.m === 'string' && /^\d{4}-\d{2}$/.test(j.m) && CHOICES[j.choice]).map(j => ({ m: j.m, choice: j.choice, at: typeof j.at === 'string' ? j.at : '', res: isFinite(+j.res) ? Math.round(+j.res) : 0 }));
  out.reserve = Math.min(1e9, Math.max(0, Math.round(num(p.reserve))));
  out.monthPlan = cleanSnap(p.monthPlan);
  const pr = p.prefs && typeof p.prefs === 'object' ? p.prefs : {};
  out.prefs = { day: Math.min(28, Math.max(1, Math.round(num(pr.day) || 10))), noActive: pr.noActive === true,
    avoid: Array.isArray(pr.avoid) ? pr.avoid.filter(a => typeof a === 'string').slice(0, 20) : [], overseasPct: [20, 25].includes(pr.overseasPct) ? pr.overseasPct : 0, calDay: Number.isInteger(pr.calDay) && pr.calDay >= 1 && pr.calDay <= 28 ? pr.calDay : 0, trend: pr.trend === true };
  const r = p.risk;
  out.risk = r && typeof r === 'object' && Array.isArray(r.ans) && r.ans.length === C.quiz.length && r.ans.every(a => Number.isInteger(a) && a >= 0 && a <= 3)
    ? (q => q && { ans: r.ans, score: q.score, k: q.k, at: typeof r.at === 'string' ? r.at : '' })(quizLevel(r.ans)) : null;
  out.aiFail = typeof p.aiFail === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.aiFail) ? p.aiFail : '';
  out.aiReport = p.aiReport && typeof p.aiReport.text === 'string' && typeof p.aiReport.at === 'string' ? { text: p.aiReport.text.slice(0, 8000), at: p.aiReport.at, model: String(p.aiReport.model || ''), example: !!p.aiReport.example, fp: typeof p.aiReport.fp === 'string' ? p.aiReport.fp : '', day: typeof p.aiReport.day === 'string' ? p.aiReport.day : '' } : null;
  const lg = p.ledger;
  const validDay = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T00:00:00+08:00')) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
  out.ledger = lg && typeof lg === 'object' && validDay(lg.start) && lg.start <= today() && isFinite(+lg.startValue) && +lg.startValue >= 0 && +lg.startValue <= 1e10
    ? { start: lg.start, startValue: +lg.startValue, txns: (Array.isArray(lg.txns) ? lg.txns : []).filter(t => t && validDay(t.d) && ['in', 'out', 'buy', 'sell'].includes(t.type) && +t.amt > 0 && +t.amt <= 1e9)
        .map((t, i, arr) => ({ id: typeof t.id === 'string' && arr.findIndex(x => x && x.id === t.id) === i ? t.id.slice(0, 40) : 'imp' + i + '-' + Math.random().toString(36).slice(2, 7), d: t.d, type: t.type === 'buy' ? 'in' : t.type === 'sell' ? 'out' : t.type, amt: Math.round(+t.amt * 100) / 100, plan: typeof t.plan === 'string' ? t.plan : undefined })).slice(-2000) }
    : null;
  // 移出的余额宝按“转回银行卡”记一笔，不然年化记账会把它算成亏损
  if (dropped > 0 && out.ledger) out.ledger.txns.push({ id: 'cash-out-' + today(), d: today() < out.ledger.start ? out.ledger.start : today(), type: 'out', amt: Math.round(dropped * 100) / 100, plan: '余额宝移出组合' });
  if (dropped > 0) CASH_NOTE.set(out, { amt: dropped, ledger: !!out.ledger });
  out.sellPlans = {};
  if (p.sellPlans && typeof p.sellPlans === 'object') Object.entries(p.sellPlans).forEach(([k, v]) => { if (v && /^\d{4}-\d{2}$/.test(v.start)) out.sellPlans[k] = { start: v.start }; });
  return out;
}
function cleanStore(s) {
  if (!s || typeof s !== 'object' || !s.profiles || typeof s.profiles !== 'object') return null;
  const profiles = Object.create(null); let n = 0;
  Object.entries(s.profiles).forEach(([id, p]) => { const c = cleanProfile(p, '用户' + (++n)); if (c && /^[\w-]{1,40}$/.test(id)) profiles[id] = c; });
  const ids = Object.keys(profiles); if (!ids.length) return null;
  return { current: Object.prototype.hasOwnProperty.call(profiles, s.current) ? s.current : ids[0], profiles };
}
let STORE = null;
try { STORE = cleanStore(JSON.parse(localStorage.getItem(LS) || 'null')); } catch (e) { STORE = null; }
if (!STORE) STORE = { current: 'p1', profiles: { p1: newProfile('我') } };
if (CASH_DROPPED) try { localStorage.setItem(LS, JSON.stringify(STORE)); } catch (e) { /* 存不了就下次再移 */ }
let P = STORE.profiles[STORE.current];
let storageOk = true;
function save() {
  try { localStorage.setItem(LS, JSON.stringify(STORE)); storageOk = true; } catch (e) { storageOk = false; }
}
function touchPortfolio() {
  P.example = false;
  // 本月计划锁定以后、还没打卡记账时改了持仓：问一句是买完更新的，还是刚录入原来就有的
  if (P.monthPlan && P.monthPlan.m === monthKey() && !monthDone()) P.monthPlan.ask = true;
  // 每天最多记一个快照，用来画资产走势
  const A = analyze();
  const pt = { d: today(), total: Math.round(A.total), profit: Math.round(A.profit), eq: Math.round(A.eqW) };
  const h = P.history; if (h.length && h[h.length - 1].d === pt.d) h[h.length - 1] = pt; else h.push(pt);
  if (h.length > 600) h.splice(0, h.length - 600);
  save();
}

/* ================= 规则：风险等级（问卷 + 从行为里学到的调整） ================= */
function levelIndex(k) { const i = C.levels.findIndex(l => l.k === k); return i >= 0 ? i : C.levels.findIndex(l => l.k === C.defaultLevel); }
function quizLevel(ans) {
  if (!ans || ans.length !== C.quiz.length || ans.some(a => a == null)) return null;
  const score = ans.reduce((a, b) => a + b + 1, 0);           // 每题 1–4 分，共 5–20 分
  let k = score <= 9 ? 'conservative' : score <= 13 ? 'steady' : score <= 17 ? 'balanced' : 'growth';
  if (ans[2] === 0 && levelIndex(k) > levelIndex('steady')) k = 'steady';  // 大跌会全部卖出：最多稳健
  if (ans[0] === 0) k = 'short';                              // 一年内要用的钱：不放股票
  return { score, k };
}
function learned() {
  const notes = []; const since = new Date(); since.setMonth(since.getMonth() - 12); const sinceK = monthKey(since);
  const recent = P.journal.filter(j => j.m > sinceK);
  const panic = recent.filter(j => j.choice === 'panic').length;
  const chase = recent.filter(j => j.choice === 'chase').length;
  let shift = 0;
  if (panic >= 2) {
    shift = -1;
    const q = levelIndex(P.risk && P.risk.k || C.defaultLevel), atFloor = q <= levelIndex('conservative');
    notes.push({ k: atFloor ? 'wait' : 'sell', t: atFloor ? `过去 12 个月有 ${panic} 次在下跌时卖出。你已经是最稳的档位，没法再调低了。下跌时先别动，打开看板看看估值，便宜的时候反而该多买。` : `过去 12 个月有 ${panic} 次在下跌时卖出。说明实际能扛的波动比问卷答的小，股票类比例已经自动调低一档。` });
  }
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
  const q = levelIndex(P.risk && P.risk.k || C.defaultLevel);
  const L = learned();
  // 行为调整最多降到“保守”，“短期”只由问卷第 1 题决定
  const floor = q === levelIndex('short') ? q : levelIndex('conservative');
  const i = Math.max(floor, Math.min(C.levels.length - 1, q + L.shift));
  return { i, base: q, L, level: C.levels[i], short: C.levels[i].k === 'short' };
}
function targets() {
  const t = Object.assign({}, currentLevel().level.target);
  if (P.prefs && P.prefs.noActive) { t.index += t.active; t.active = 0; }
  const eqTotal = t.index + t.div + t.overseas + t.active;
  // 海外最多占股票类的 40%；短期档没有股票类，偏好不生效
  const want = P.prefs && P.prefs.overseasPct ? Math.min(P.prefs.overseasPct, Math.floor(eqTotal * 0.4)) : 0;
  if (want && want > t.overseas) {
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
  return { m: r.m, t: r.t, top: !!r.top, k: r.top ? 'stop' : r.m >= 1.5 ? 'cheap' : r.m === 1 ? 'hold' : 'wait' };
}
function spreadSignal(s) {
  if (s == null) return { m: 1, t: '无数据', k: 'hold' };
  const r = C.rules.spread.find(x => s >= x.atLeast);
  return { m: r.m, t: r.t, top: !!r.top, k: r.top ? 'stop' : r.m >= 1.5 ? 'cheap' : r.m === 1 ? 'hold' : 'wait' };
}
let idxPct, spread, divPct, SIG, SIGV = {};
function computeSignals() {
  idxPct = M.hs300 && M.hs300.pePct10y != null ? M.hs300.pePct10y : null;
  spread = M.divLowVol && M.divLowVol.dy != null && M.cgb10y && M.cgb10y.yield != null ? +(M.divLowVol.dy - M.cgb10y.yield).toFixed(2) : null;
  divPct = M.divLowVol && M.divLowVol.pePct10y != null ? M.divLowVol.pePct10y : null;
  const pe = peSignal(idxPct);
  let div = spreadSignal(spread);
  // 红利低波：息差说便宜、但自身市盈率分位很高时，两个信号打架，取保守的，最多买 1 倍
  if (divPct != null && divPct >= C.rules.divPeCap && div.m > 1) div = Object.assign({}, div, { m: 1, t: '合理', k: 'hold', conflict: true });
  SIGV = { sp500: peSignal(M.sp500 && M.sp500.pePct10y), ndx: peSignal(M.ndx && M.ndx.pePct10y) };
  if (M.a500 && M.a500.pePct10y != null) SIGV.a500 = peSignal(M.a500.pePct10y);   // 有中证A500 估值时，A500 基金看自己的
  SIG = { index: pe, active: pe, div, overseas: SIGV.sp500, bond: { m: 1, t: '照常', k: 'hold' }, cash: { m: 1, t: '照常', k: 'hold' } };
}
/* 海外基金按各自跟踪的指数估值；其他类别按类别 */
function sigOf(cat, f) {
  if (f && f.val && SIGV[f.val] && (cat === 'overseas' || cat === 'index')) return SIGV[f.val];
  return SIG[cat];
}
function valText(cat, f) {
  if (cat === 'div') return `息差 ${spread == null ? '—' : spread.toFixed(2) + ' 个百分点'}${divPct != null ? `，自身市盈率近10年 ${Math.round(divPct)}% 分位` : ''}`;
  if (cat === 'overseas') { const k = f && f.val || 'sp500', m = M[k]; return `${k === 'ndx' ? '纳指100' : '标普500'}近10年 ${m && m.pePct10y != null ? Math.round(m.pePct10y) + '%' : '—'} 分位`; }
  if (cat === 'index' && f && f.val && M[f.val] && M[f.val].pePct10y != null && SIGV[f.val]) return `${f.index || f.val}近10年 ${Math.round(M[f.val].pePct10y)}% 分位`;
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
/* 评分分组：海外按跟踪的指数分开比（标普500 只和标普500 比），避免拿不同指数的历史涨幅互相比 */
const groupOf = f => f.cat === 'overseas' ? 'overseas:' + (f.val || '') : f.cat;
function scoreAll() {
  [...new Set(FUNDS.map(groupOf))].forEach(g => {
    const fs = FUNDS.filter(f => groupOf(f) === g), w = W[fs[0].cat];
    fs.forEach(f => { f.score = 0; f.parts = {}; f.missing = []; });
    Object.keys(w).forEach(key => {
      const vals = fs.map(f => metric(f, key)).filter(v => v != null);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      fs.forEach(f => {
        const v = metric(f, key); let s;
        if (v == null) { s = .5; f.missing.push(MNAME[key]); } else s = hi === lo ? .8 : .15 + .85 * (v - lo) / (hi - lo);
        f.parts[key] = s; f.score += s * w[key] * 100;
      });
    });
    fs.forEach(f => f.score = Math.round(f.score));
    fs.slice().sort((a, b) => b.score - a.score).forEach((f, i) => { f.rank = i + 1; f.peers = fs.length; });
  });
}
const picksOf = k => FUNDS.filter(f => f.cat === k && f.pick);

/* ================= 规则引擎：持仓 → 每只基金的操作建议 ================= */
function monthsBetween(a, b) { const [y1, m1] = a.split('-').map(Number), [y2, m2] = b.split('-').map(Number); return (y2 - y1) * 12 + (m2 - m1); }
/* 分批卖出：第一次建议卖出的月份记在 P.sellPlans 里，3 个月内卖完（每月卖“剩余 ÷ 剩余月数”） */
function sliceSell(code, amount) {
  const n = C.rules.sellMonths, sp = (P.sellPlans || {})[code], mk = monthKey();
  const done = sp ? Math.max(0, monthsBetween(sp.start, mk)) : 0, left = Math.max(1, n - done);
  return { amt: Math.round(amount / left), left, step: Math.min(n, done + 1) };
}
const KEYDATA = ['fee', 'ret3y', 'dd'];
/* 趋势：价格在约 40 周均线之上、均线比 4 周前高 → 'up'；在均线之下 → 'down'；数据不够 → null */
const TREND_CACHE = {};
function trendOf(f) {
  if (!f) return null; if (f.code in TREND_CACHE) return TREND_CACHE[f.code];
  const tr = C.rules.trend || { ma: 40, slope: 4 }, c = curvePoints(f).map(p => p[1]);
  let r = null;
  if (c.length >= tr.ma + tr.slope) {
    const avg = (end) => c.slice(end - tr.ma, end).reduce((a, b) => a + b, 0) / tr.ma;
    const now = avg(c.length), before = avg(c.length - tr.slope), last = c[c.length - 1];
    r = last > now && now > before ? 'up' : last < now ? 'down' : 'flat';
  }
  return (TREND_CACHE[f.code] = r);
}
const trendOn = () => !!(P.prefs && P.prefs.trend);
/* 这只基金对应的估值分位（宽基看沪深300，海外看自己的指数，红利低波看自身分位） */
function valPct(cat, f) {
  if (cat === 'overseas') { const k = f && f.val; return k && M[k] ? M[k].pePct10y : null; }
  if (cat === 'div') return divPct;
  if (cat === 'index' || cat === 'active') { if (cat === 'index' && f && f.val && M[f.val] && M[f.val].pePct10y != null) return M[f.val].pePct10y; return idxPct; }
  return null;
}
/* 限购：一个月按约 20 个交易日算，每天最多买 buyCap 元。暂停申购又没有限额的，当作这个月买不了 */
const TRADE_DAYS = 20;
const BIG_CAP = 10000;   // 每天能买 1 万以上的“限大额”，对正常定投没有影响
const monthCap = f => f && f.buyCap > 0 ? (f.buyCap >= BIG_CAP ? Infinity : f.buyCap * TRADE_DAYS) : (f && f.buyStatus === '暂停申购' ? 0 : Infinity);
const tightCap = f => f && f.buyCap > 0 && f.buyCap < BIG_CAP;
const dailyAmt = (f, total) => Math.min(f.buyCap, Math.ceil(total / TRADE_DAYS));
const MIN_BUY = 10;   // 支付宝很多基金一次最少买 10 元（也有 1 元起的，以支付宝显示为准）
/* 限购基金这个月怎么买：每日定投金额够 10 元就设每日定投；不够就分几天手动买，每次 10 元 */
function buyHow(f, tot) {
  const cap = f.buyCap;
  if (tot <= cap) return `一次买 ${fmt(Math.ceil(tot))} 就行`;
  const d = dailyAmt(f, tot);
  if (d >= MIN_BUY) return `在支付宝设“每日定投” ${fmt(d)} 就行，一个月大约买 ${fmt(d * TRADE_DAYS)}`;
  if (cap < MIN_BUY) return `每天最多只能买 ${fmt(cap)}，以支付宝显示的起购金额为准；买不进就算了`;
  // 每天摊下来不到 10 元：能用每周定投就用（一个月约 4 次），不然就按每天额度分几天手动买
  const wk = Math.ceil(tot / 4);
  if (wk >= MIN_BUY && wk <= cap) return `每天摊下来不到 ${MIN_BUY} 元，支付宝可能设不了每日定投：设“每周定投” ${fmt(wk)}，一个月大约买 ${fmt(wk * 4)}（以支付宝显示的起购金额为准）`;
  const days = Math.ceil(tot / cap), per = Math.min(cap, Math.max(MIN_BUY, Math.ceil(tot / days)));
  return `这个月分 ${days} 天手动买，每次 ${fmt(per)}（每天最多 ${fmt(cap)}），买不进的就算了`;
}
const capNote = (f, amt) => tightCap(f) && amt > f.buyCap ? `每天最多买 ${fmt(f.buyCap)}：${buyHow(f, amt)}` : '';
const DAILY_HOWTO = '<details class="pickfrom"><summary>“每日定投”怎么设</summary><ol class="howto"><li>支付宝搜基金代码，进基金页</li><li>点“定投”，频率选“每日”</li><li>填金额，确认</li></ol><p class="note">只在交易日扣款，周末和节假日不扣，一个月大约扣 20 次，设好就不用管。</p></details>';
function analyze() {
  const T = targets(); const R = C.rules;
  const items = P.items.filter(i => i && (+i.amount || 0) > 0).map(i => {
    const f = FUND[i.code];
    return Object.assign({}, i, { fund: f || null, cat: f ? f.cat : (CAT[i.cat] ? i.cat : 'active'), name: f ? f.name : (i.name || '其他基金'), amount: +i.amount || 0, profit: +i.profit || 0 });
  });
  const zeroItems = P.items.filter(i => i && !((+i.amount || 0) > 0)).length;
  const total = items.reduce((a, i) => a + i.amount, 0);
  const profit = items.reduce((a, i) => a + i.profit, 0);
  const byCat = {}, pByCat = {}; C.cats.forEach(c => { byCat[c.k] = 0; pByCat[c.k] = 0; });
  items.forEach(i => { byCat[i.cat] += i.amount; pByCat[i.cat] += i.profit; });
  const w = {}, dev = {}; C.cats.forEach(c => { w[c.k] = total ? byCat[c.k] / total * 100 : 0; dev[c.k] = w[c.k] - T[c.k]; });
  const overRaw = k => total > 0 && dev[k] >= R.rebalanceBand;
  const eqW = C.cats.filter(c => c.eq).reduce((a, c) => a + w[c.k], 0);
  const expRet = C.cats.reduce((a, c) => a + T[c.k] / 100 * c.ret, 0);
  const expDd = C.cats.reduce((a, c) => a + T[c.k] / 100 * c.dd, 0);
  const curDd = total ? C.cats.reduce((a, c) => a + w[c.k] / 100 * c.dd, 0) : expDd;
  const avoid = Array.isArray(P.prefs && P.prefs.avoid) ? P.prefs.avoid : [];
  const noActive = false;   // 主动基金已经不在组合里（目标 0%），保留这个变量只为兼容旧逻辑

  // 第一步：找出要整只卖掉、钱会离开这一类的基金（名单外、不想碰的行业、目标为 0 的类别、超过 5 只）
  const exitWhy = i => {
    const f = i.fund, hit = avoid.find(a => (i.name || '').includes(a));
    if (!f && hit) return 'avoid:' + hit;
    if (T[i.cat] === 0) return 'zero';
    if (!f && (i.cat === 'active' || overRaw(i.cat))) return 'unlisted';
    return null;
  };
  items.forEach(i => { i.exit = exitWhy(i); });
  // 最多 5 只：算上“本月要开始买的推荐基金”，超过 5 只时：
  //   1. 先合并重复的（同一个指数拿了两只、名单外的），从金额小的开始；
  //   2. 还超过，就让你手里那只备选继续当这一类的代表，新钱买它，不再多开一只推荐基金。
  // 同一指数的推荐基金限购时，卖了也买不回去：这种先拿着（over5）
  const maxN = C.maxFunds || 5;
  const needG = new Set(FUNDS.filter(f => f.pick && T[f.cat] > 0).map(groupOf));
  const gOf = i => i.fund ? groupOf(i.fund) : 'x:' + i.code, isPick = i => !!(i.fund && i.fund.pick);
  const redirect = {};
  const projected = () => { const k = items.filter(i => !i.exit), gs = new Set(k.map(gOf)); let n = k.length;
    needG.forEach(g => { if (!gs.has(g) || (!redirect[g] && !k.some(i => gOf(i) === g && isPick(i)))) n++; }); return n; };
  const mergeTo = i => { const g = gOf(i), k = items.filter(j => j !== i && !j.exit && gOf(j) === g);
    const kp = k.find(isPick); if (kp) return kp.fund; const big = k.sort((x, y) => y.amount - x.amount)[0]; return big ? big.fund : (i.fund ? picksOf(i.cat).find(p => groupOf(p) === g) : null); };
  const stuck = i => { if (overRaw(i.cat)) return false; const b = mergeTo(i); return !!(b && b.pick && isFinite(monthCap(b))); };   // 这一类本来就超配，卖了不用买回
  const n0 = projected();
  for (let guard = 0; guard < 20 && projected() > maxN; guard++) {
    const k = items.filter(i => !i.exit && !i.over5);
    const dup = i => !isPick(i) && (!needG.has(gOf(i)) || k.some(j => j !== i && gOf(j) === gOf(i) && (isPick(j) || j.amount > i.amount || (j.amount === i.amount && j.code < i.code))));
    const c = k.filter(dup).sort((x, y) => (stuck(x) - stuck(y)) || x.amount - y.amount)[0];
    if (c) { if (stuck(c)) c.over5 = true; else c.exit = 'max5'; continue; }
    const g = [...needG].find(g => !redirect[g] && k.some(i => gOf(i) === g) && !k.some(i => gOf(i) === g && isPick(i)));
    if (!g) break;
    // 备选自己暂停申购时不让它当代表（这一类就一分钱都买不了），合并到推荐那只
    const alts = k.filter(i => gOf(i) === g).sort((x, y) => y.amount - x.amount), ok = alts.find(i => monthCap(i.fund) > 0);
    if (ok) redirect[g] = ok.fund; else alts.forEach(i => { i.exit = 'max5'; });
  }
  // 还超过（比如限购的那只只能先拿着）：本来要新开的推荐基金先不买，钱留在银行卡，保证不超过 5 只
  const full = {};
  if (projected() > maxN) {
    const k = items.filter(i => !i.exit), opens = [...needG].filter(g => !redirect[g] && !k.some(i => gOf(i) === g && isPick(i)))
      .map(g => ({ g, w: FUNDS.filter(f => f.pick && groupOf(f) === g).reduce((a, f) => a + T[f.cat] * (f.split || 1), 0) })).sort((x, y) => x.w - y.w);
    for (const o of opens) { if (projected() - Object.keys(full).length <= maxN) break; full[o.g] = true; }
  }
  const buyAs = p => redirect[groupOf(p)] || p;   // 这一类实际买哪只
  const nHeld = items.length, countWhy = nHeld > maxN ? `你持有 ${nHeld} 只基金，超过了 ${maxN} 只。` : `加上本月要开始买的推荐基金，一共会有 ${n0} 只，超过了 ${maxN} 只。`;
  // 算超配时先扣掉正在整只卖出的基金，避免这边减仓、等那只卖完又要买回来
  const byCat2 = {}; C.cats.forEach(c => byCat2[c.k] = 0); items.forEach(i => { if (!i.exit) byCat2[i.cat] += i.amount; });
  const w2 = {}, dev2 = {}; C.cats.forEach(c => { w2[c.k] = total ? byCat2[c.k] / total * 100 : 0; dev2[c.k] = w2[c.k] - T[c.k]; });
  const over = k => total > 0 && dev2[k] >= R.rebalanceBand;
  // 占比不够、而且推荐基金现在能买（估值不是“很贵”）的类别：卖出的钱只往这里去
  // under()（占比不够、能买的类别）在定投计划算完以后定义，见下面 needOf
  const bestOf = (k, f) => { const ps = picksOf(k); const same = f ? ps.find(p => groupOf(p) === groupOf(f)) : null; if (same) return same; if (ps.length) return ps[0]; return k === 'active' ? picksOf('index')[0] : null; };

  // 第二步：本月定投计划（只买推荐基金）。超配不买，估值贵少买；少买的钱留在你的银行卡里
  // 这个月要分批止盈（或趋势持有、本该止盈）的基金，计划里不再买它：不能同一个月又卖又买
  const noBuy = new Set(items.filter(i => !i.exit && i.fund && CAT[i.cat].eq && sigOf(i.cat, i.fund).top && i.amount - i.profit > 0 && i.profit / (i.amount - i.profit) * 100 >= R.takeProfitPct).map(i => i.code));
  const monthly = +P.monthly || (P.example ? EXAMPLE_MONTHLY : 0), plan = []; let parked = 0, bonus = 0; const parkedWhy = [];
  C.cats.forEach(c => {
    const base = monthly * T[c.k] / 100; if (!base || c.k === 'cash') return;
    const ps = picksOf(c.k);
    if (!ps.length) { parked += base; parkedWhy.push(`${c.n}没有推荐基金`); return; }
    ps.forEach(p0 => {
      const p = buyAs(p0), b = base * (p0.split || 1 / ps.length), sig = sigOf(c.k, p);
      let m = sig.m, note = p !== p0 ? '用你已有的' : '';
      if (full[groupOf(p0)]) { m = 0; note = `已满 ${maxN} 只`; }
      else if (noBuy.has(p.code)) { m = 0; note = '止盈中'; }
      else if (over(c.k)) { m = 0; note = '已超配'; }
      else if (c.eq && dev2[c.k] <= -R.catchUpBand && m >= 1 && total > 0 && !sig.conflict) { m += 0.5; note = '低配补仓'; }
      let amt = b * m; const want = amt;
      // 估值决定少买（留在银行卡）还是多买；限购买不进的部分另算，这个月转去买其他缺的类别
      if (amt < b) parked += b - amt; else bonus += amt - b;
      const mc = monthCap(p); let capped = 0;
      if (amt > mc) { capped = amt - mc; note = mc === 0 ? '暂停申购' : '限购'; amt = mc; }
      plan.push({ fund: p, cat: c.k, base: b, amt, want, m, sig, note, capped });
    });
  });
  const capWhy = [];
  plan.filter(r => r.capped >= 50).forEach(r => capWhy.push(r.note === '暂停申购' ? `${r.fund.short || r.fund.name}暂停申购，这个月该买的 ${fmt(r.capped)} 转去买其他缺的类别` : `${r.fund.short || r.fund.name}每天只能买 ${fmt(r.fund.buyCap)}，一个月最多 ${fmt(monthCap(r.fund))}，多出来的 ${fmt(r.capped)} 这个月转去买其他缺的类别。这不是你做错了什么，是基金公司额度用完了`));
  // 不再配余额宝：少买的钱留在银行卡；便宜月份多买的钱，用之前留在银行卡里的钱（手头紧就按平时金额买）
  const cashFund = null, cashBase = 0, cashOver = false;
  const avail = Infinity;
  if (bonus > avail) {
    let cut = bonus - avail;
    const trim = rows => { const tot = rows.reduce((a, r) => a + (r.amt - r.base), 0); if (tot <= 0) return; const k = Math.min(1, cut / tot);
      rows.forEach(r => { const d = (r.amt - r.base) * k; r.amt -= d; r.m = +(r.amt / r.base).toFixed(2); cut -= d; }); };
    trim(plan.filter(r => r.note === '低配补仓' && r.amt > r.base));
    if (cut > 0.5) trim(plan.filter(r => r.amt > r.base));
    bonus = plan.reduce((a, r) => a + Math.max(0, r.amt - r.base), 0);
  }
  const capPool = plan.reduce((a, r) => a + (r.capped || 0), 0);
  const cashNet = parked - bonus;
  const bankVal = Math.max(0, cashNet);                           // 估值贵少投、留在银行卡的钱（限购剩下的在第四步加上）
  const extra = Math.max(0, -cashNet);                           // 便宜月份比平时多投的钱
  // 银行卡里“等着投的钱”：超过总资产的 5% 就分批投回去，不让钱一直闲着（多买的部分先用它）
  const jm = P.journal.find(j => j.m === monthKey());   // 本月打卡时已经记进去的不算，打卡前后本月计划一样
  const reserve = Math.max(0, (+P.reserve || 0) - (jm && jm.res || 0)), resLeft = Math.max(0, reserve - extra);
  const resThr = Math.max(100, (R.reserveDeployPct || 5) / 100 * (total + reserve));
  const deploy = reserve >= resThr ? Math.min(resLeft, Math.max(monthly, 500), Math.max(reserve / R.sellMonths, Math.min(reserve, 500))) : 0;   // 一个月最多投回一个月的定投额，慢慢来
  if (cashFund) plan.push({ fund: cashFund, cat: 'cash', base: cashBase, amt: cashOver ? 0 : Math.max(0, cashNet), m: cashOver ? 0 : 1, sig: SIG.cash, note: cashOver ? '已超配' : (parked > bonus ? '含少买的钱' : '') });
  const planTotal = plan.reduce((a, p) => a + p.amt, 0);
  const planFor = code => plan.find(x => x.fund && x.fund.code === code);
  // 每类还缺多少：按“这个月投完以后”的总额算目标（新进来的钱 = 定投 + 限购转出来的 + 银行卡投回去的），
  // 这样银行卡里的钱在各类都刚好达标时也能按比例投回去
  const newMoney = planTotal + capPool + deploy;
  // 估值贵少买、止盈中不买的部分算作“已经补过”，不然银行卡的钱又会把它买回来，估值规则就白设了；只有限购买不进的才算缺口
  const planCat = k => plan.filter(r => r.cat === k).reduce((a, r) => a + r.amt + Math.max(0, r.base - r.want), 0);
  const catM = k => { const ps = picksOf(k).filter(p => !sigOf(k, p).top); const sp = ps.reduce((a, p) => a + (p.split || 1), 0); return sp ? ps.reduce((a, p) => a + Math.min(1, sigOf(k, p).m) * (p.split || 1), 0) / sp : 0; };
  // 偏贵的类别只补一部分缺口（按买入倍数打折），不让投回、限购转来的钱把“偏贵少买”抵消掉
  const needOf = k => Math.max(0, T[k] / 100 * (total + newMoney) - byCat2[k] - planCat(k)) * catM(k);
  const under = exclude => C.cats.filter(x => x.k !== exclude && T[x.k] > 0 && !over(x.k) && needOf(x.k) >= 1 && picksOf(x.k).some(p => !sigOf(x.k, p).top)).sort((x, y) => needOf(y.k) - needOf(x.k));

  // 第三步：每只持仓的建议
  const sched = {};
  const adv = items.map(i => {
    const c = CAT[i.cat], f = i.fund, sig = sigOf(i.cat, f), cost = i.amount - i.profit, pp = cost > 0 ? i.profit / cost * 100 : 0;
    const share = byCat2[i.cat] ? i.amount / byCat2[i.cat] : 0;
    const best = (noActive && i.cat === 'active') ? picksOf('index')[0] : bestOf(i.cat, f);
    const und = under(i.cat).filter(x => picksOf(x.k).some(p => { const q = buyAs(p); return !full[groupOf(p)] && !sigOf(x.k, q).top && monthCap(q) - ((planFor(q.code) || {}).amt || 0) >= 1; })).map(x => x.n).slice(0, 2);   // 限购买满的类别不写进去向
    const dest = (i.exit || over(i.cat)) ? (und.length ? `占比不够的${und.join('、')}` : '银行卡，等能买的时候再买') : best ? (best.short || best.name) : '银行卡，等能买的时候再买';
    const sell = (t, why, tail) => { const s = sliceSell(i.code, i.amount); sched[i.code] = true; return { k: t === '换成更好的' ? 'swap' : 'sell', t, amt: s.amt, why: why.concat(`第 ${s.step}/${R.sellMonths} 个月：这个月卖 ${fmt(s.amt)}${s.left > 1 ? `，剩下的分 ${s.left - 1} 个月卖完` : '，这是最后一次'}。${tail || ''}`) }; };
    let a;
    if (i.exit === 'zero') a = sell(i.cat === 'cash' ? '分批转出' : '分批卖出', [i.cat === 'cash' ? '余额宝不在组合里。如果这是应急钱，直接从持仓里删掉就行，不用卖；如果是闲钱，分批转去买组合里的基金。'
      : currentLevel().short && c.eq ? '这笔钱 1 年内要用，不该放在股票类基金里。' : !f ? `不在选基名单里，看不到它的费率和回撤，没法判断好坏。${i.cat === 'active' ? '行业、主题基金波动大，不适合新手长期拿。' : ''}` : i.cat === 'active' ? '规则调整：组合改成只拿 5 只指数基金，不再配主动基金（费用高，一年约 1.4%，还要看基金经理）。不是因为它最近表现差。分 3 个月慢慢卖，不急。' : `${c.n}在你现在的配置里目标是 0%。`], `钱放进${dest}。`);
    else if (i.exit === 'max5') { const m5 = mergeTo(i), why5 = `${countWhy}新手只拿 ${maxN} 只就够，多了反而管不过来，而且很多基金持有的公司是重叠的。`;
      a = m5 && !over(i.cat) && !isFinite(monthCap(m5)) ? sell('换成更好的', [why5, `它和${m5.pick ? '推荐的' : '你已有的'} ${m5.short || m5.name} 是同一类，合并过去就行，买的东西差不多。`], `卖出的钱买 ${m5.short || m5.name}。`) : sell('分批卖出', [why5], `钱放进${dest}。`); }
    else if (i.over5) { const m5 = mergeTo(i);
      a = { k: 'hold', t: '先拿着', amt: 0, why: [`${countWhy}这只本来该合并到 ${m5.short || m5.name}，但那只${monthCap(m5) === 0 ? '暂停申购' : `限购（每天最多 ${fmt(m5.buyCap || 0)}）`}，卖出来也买不回去。先拿着，不再往里加钱；等限购放开再合并。`] }; }
    else if (i.exit && i.exit.startsWith('avoid:')) a = sell('分批卖出', [`你在偏好里设置了不碰“${i.exit.slice(6)}”。`], `钱放进${dest}。`);
    else if (i.exit === 'unlisted') a = sell('分批卖出', ['不在选基名单里，看不到它的费率、回撤和经理数据，没法判断好坏。', `${i.cat === 'active' ? '行业基金波动大' : `${c.n}已经超配`}${pp < 0 ? `。现在亏 ${Math.abs(pp).toFixed(0)}%，但不要因为亏了就一直拿着等回本` : ''}。`], `钱放进${dest}。`);
    else if (!f) a = { k: 'swap', t: '考虑换掉', amt: 0, why: [`不在选基名单里。对比一下同类推荐的 ${best ? best.short || best.name : '基金'} 的费率和回撤，差得多就换。`] };
    else if (!f.pick && redirect[groupOf(f)] !== f && best && groupOf(best) === groupOf(f) && isFinite(monthCap(best)) && best.score - f.score >= R.swapScoreGap && !over(i.cat))
      a = { k: 'hold', t: '持有', amt: 0, why: [`推荐的 ${best.short || best.name} 更好，但它现在${monthCap(best) === 0 ? '暂停申购' : `限购（每天最多 ${fmt(best.buyCap || 0)}）`}，换不过去。这只先拿着，跟踪的是同一个指数，效果差不多；新钱按“本月定投计划”买推荐的那只。`] };
    else if (!f.pick && redirect[groupOf(f)] !== f && best && best.score - f.score >= R.swapScoreGap && groupOf(best) === groupOf(f) && !KEYDATA.some(k => (f.missing || []).includes(MNAME[k]) || (best.missing || []).includes(MNAME[k])))
      a = sell('换成更好的', [`跟踪同一个指数的基金里，它的综合评分 ${f.score} 分，推荐的 ${best.short || best.name} 是 ${best.score} 分（看费率、规模、3年收益和回撤，不看短期涨幅）。`], `卖出的钱买 ${best.short || best.name}。`);
    else if (c.eq && sig.top && pp >= R.takeProfitPct && trendOn() && trendOf(f) === 'up' && !((valPct(i.cat, f) ?? 0) >= C.rules.trend.hardPct) && !(dev2[i.cat] >= C.rules.trend.widen))
      a = { k: 'hold', t: '趋势持有', amt: 0, why: [`估值${sig.t}，你这只赚了 ${pp.toFixed(0)}%，本来该分批止盈。但涨势还在（价格在长期均线之上，均线还在往上走），你打开了趋势规则，所以先拿着。`, `等价格跌破长期均线，或者估值到近10年 ${C.rules.trend.hardPct}% 分位，再按规则分批卖。这个月不再买这只，这份钱留在银行卡。`] };
    else if (c.eq && sig.top && pp >= R.takeProfitPct) {
      const tp = und.length ? `占比不够的${und.join('、')}` : '银行卡，等能买的时候再买';
      a = { k: 'sell', t: '分批止盈', amt: Math.round(i.amount * R.takeProfitSlice), why: [`估值${sig.t}（${valText(i.cat, f)}），你这只赚了 ${pp.toFixed(0)}%。`, `这个月先卖 ${R.takeProfitSlice * 100}%，钱转到${tp}。估值不降就每月再卖一次，不一次卖光，防止卖早。正在止盈，本月也不再定投这只，这份钱留在银行卡。`] };
    } else if (over(i.cat) && c.eq && trendOn() && trendOf(f) === 'up' && dev2[i.cat] < C.rules.trend.widen && !((valPct(i.cat, f) ?? 0) >= C.rules.trend.hardPct)) {
      a = { k: 'hold', t: '趋势持有', amt: 0, why: [`${c.n}超配了 ${dev2[i.cat].toFixed(0)} 个百分点，平时超过 ${R.rebalanceBand} 个点就该减仓。但涨势还在，你打开了趋势规则，放宽到 ${C.rules.trend.widen} 个点再减。`, '这个月不再买这一类，用新钱补其他类别。'] };
    } else if (over(i.cat) && c.eq && sig.m >= 1.5) {
      a = { k: 'hold', t: '持有不买', amt: 0, why: [`${c.n}超配了 ${dev2[i.cat].toFixed(0)} 个百分点，但现在估值${sig.t}，便宜的时候不卖。本月不再买这一类，用新钱补其他类别。`] };
    } else if (over(i.cat)) {
      const excess = Math.min(i.amount, dev2[i.cat] / 100 * total * share);
      const amt = Math.round(excess / R.sellMonths);
      a = i.cat === 'cash'
        ? { k: 'move', t: '转出补仓', amt, excess, why: [`余额宝里放了 ${w2.cash.toFixed(0)}%，目标 ${T.cash}%，闲置太多。`] }   // 金额在下面按“能买多少”再定
        : { k: 'sell', t: '减仓', amt, why: [`${c.n}${dev2[i.cat] < dev[i.cat] - 0.5 ? '（扣掉正在卖出的基金后）' : ''}占 ${w2[i.cat].toFixed(0)}%，目标 ${T[i.cat]}%，超了 ${dev2[i.cat].toFixed(0)} 个百分点。本月不再买这一类。`, `超出的共 ${fmt(excess)}，分 ${R.sellMonths} 个月卖，这个月卖 ${fmt(amt)}，钱按下面“本月多出来的钱怎么买”去买。`] };
    } else if (c.eq && sig.top && !((planFor(i.code) || {}).amt >= 1)) {
      a = { k: 'stop', t: '暂停买入', amt: 0, why: [`这个月计划里买不了它（限购、暂停申购或已经满 ${maxN} 只），拿着不动。现在估值${sig.t}（${valText(i.cat, f)}）。`, pp < R.takeProfitPct ? (pp < 0 ? `目前亏 ${Math.abs(pp).toFixed(0)}%，不要在贵的时候加仓摊低成本，拿着等。` : `目前赚 ${pp.toFixed(0)}%，没到 ${R.takeProfitPct}% 的止盈线，不用卖。`) : ''] };
    } else {
      const p = planFor(i.code), low = dev2[i.cat] <= -R.rebalanceBand;
      if (p && Math.round(p.amt) >= 1 && i.cat !== 'cash') a = { k: 'buy', t: low ? '加仓' : '按计划定投', amt: Math.round(p.amt), why: [low ? `${c.n}占 ${w2[i.cat].toFixed(0)}%，比目标 ${T[i.cat]}% 少 ${Math.abs(dev2[i.cat]).toFixed(0)} 个百分点，估值${sig.t}。` : `比例正常，估值${sig.t}。`, `本月买入 ${fmt(p.amt)}${p.m !== 1 && p.note !== '限购' ? `（平时的 ${p.m} 倍）` : ''}。${tightCap(f) ? `这只限购，每天最多买 ${fmt(f.buyCap)}，怎么买看“本月定投计划”里这只基金下面的说明。` : ''}`] };
      else if (i.cat === 'cash') a = { k: 'hold', t: '持有', amt: 0, why: [extra > 0 ? `本月便宜的类别要多买，从余额宝里取 ${fmt(extra)}。` : p && Math.round(p.amt) >= 1 ? `本月存入 ${fmt(p.amt)}。` : '比例正常，不用操作。'] };

      else a = { k: 'hold', t: '持有', amt: 0, why: [f.pick ? '比例正常，不用操作。' : redirect[groupOf(f)] === f ? `你已经有 ${maxN} 只了，这一类就用它，不再多开一只推荐基金。比例正常，不用操作。` : `不是推荐基金，但和推荐的 ${best ? best.short || best.name : ''} 差距不大，可以继续拿着，新钱买推荐的那只。`] };
    }
    if ((a.k === 'sell' || a.k === 'swap') && a.amt >= 1) a.why.push(`卖出前看一眼：持有不满 7 天卖要交 1.5% 赎回费，7 天以上一般在 0.5% 以内（以支付宝显示为准）。${i.cat === 'overseas' ? '海外基金卖出后大约 5–8 个工作日才到账' : '一般 1–3 个工作日到账'}（以支付宝卖出页面显示的预计到账日期为准），到账后再按建议买。`);
    if (a.k === 'buy' && sig.top) a.why.push('估值很贵时只买平时的一半：不追高，也不完全停。估值可能贵好几年，完全停买会让钱一直闲着。');
    if (f && i.cat === 'div' && sig.conflict && a.k === 'buy') a.why.push(`注意：息差显示偏便宜，但红利低波自身估值在近10年 ${Math.round(divPct)}% 分位，已经不低，所以最多按 1 倍买。`);
    a.why = a.why.filter(Boolean);
    return Object.assign({}, i, { pp, adv: a });
  });

  // 余额宝转出多少：只转“能买进去”的部分。其他卖出的钱先用掉买入空间，剩下的空间才从余额宝补；没有空间就不转
  const sellFreed = adv.filter(x => x.adv.k === 'sell').reduce((a, x) => a + x.adv.amt, 0);
  adv.filter(x => x.adv.t === '转出补仓').forEach(x => {
    // 不超过：超出部分的三分之一、能买进去的空间、余额宝余额扣掉本月定投要取的部分
    // 能买进去的空间：每个缺的类别，取“缺多少”和“推荐基金扣掉本月定投后还能买多少”（限购）中较小的
    const capacity = under(null).reduce((a, c2) => {
      const roomCat = picksOf(c2.k).filter(p => sigOf(c2.k, p).m > 0).reduce((r, p) => r + Math.max(0, monthCap(p) - ((planFor(p.code) || {}).amt || 0)), 0);
      return a + Math.min(-dev2[c2.k] / 100 * total, roomCat);
    }, 0);
    const room = Math.max(0, capacity - sellFreed), amt = Math.round(Math.max(0, Math.min(x.adv.excess / R.sellMonths, room, x.amount - extra)));
    if (amt < 1) x.adv = extra >= 1
      ? { k: 'move', t: '取出定投', amt: Math.round(Math.min(extra, x.amount)), why: [`本月定投多买的部分从余额宝里取 ${fmt(Math.min(extra, x.amount))}。`, '余额宝比目标多，但现在占比不够的类别要么估值很贵、要么已经补满，剩下的先放着。'] }
      : { k: 'hold', t: '持有', amt: 0, why: [`余额宝放了 ${w2.cash.toFixed(0)}%，比目标多，但现在占比不够的类别要么估值很贵、要么已经补满，先放着，等能买的时候再转出。`] };
    else x.adv = { k: 'move', t: '转出补仓', amt: Math.round(amt + extra), why: x.adv.why.concat(extra > 0
      ? `这个月一共从余额宝取 ${fmt(amt + extra)}：其中 ${fmt(amt)} 按下面“本月多出来的钱怎么买”去买，${fmt(extra)} 用在本月定投多买的部分。`
      : `这个月转出 ${fmt(amt)}，按下面“本月多出来的钱怎么买”去买。`) };
  });
  // 第四步：本月卖出的钱怎么买 —— 按各类缺多少分给推荐基金；估值很贵的类别不买，剩下的留在银行卡
  const sellAmt = adv.filter(x => x.adv.k === 'sell').reduce((a, x) => a + x.adv.amt, 0);
  const freed = sellAmt + capPool + deploy;   // 卖出的钱 + 限购买不进的定投钱 + 银行卡里该投回去的钱
  const reinvest = [], capHit = []; let freedLeft = freed;
  if (freed > 0) {
    // 按缺口比例分给各类，限购基金买满后，多出来的再分给还有空间的类别（最多分 6 轮）
    const cands = under(null).map(x => ({ c: x, need: needOf(x.k), ps: picksOf(x.k).filter(p => !sigOf(x.k, p).top && !full[groupOf(p)]).map(buyAs).map(p => ({ p, room: Math.max(0, monthCap(p) - ((planFor(p.code) || {}).amt || 0)), got: 0 })), got: 0 }))
      .filter(x => x.ps.length && x.need > 0);
    let left = freed;
    for (let round = 0; round < 6 && left >= 1; round++) {
      const open = cands.filter(x => x.got < x.need - 0.5 && x.ps.some(q => q.got < q.room - 0.5)); if (!open.length) break;
      const needSum = open.reduce((a, x) => a + (x.need - x.got), 0), pot = left;
      open.forEach(x => {
        let give = Math.min(x.need - x.got, pot * (x.need - x.got) / needSum);
        for (let r2 = 0; r2 < 3 && give >= 0.5; r2++) {   // 类里按 split 分，限购的买满后给同类其他基金
          const qs = x.ps.filter(q => q.got < q.room - 0.5); if (!qs.length) break;
          const sp = qs.reduce((a, q) => a + (q.p.split || 1), 0); let used = 0;
          qs.forEach(q => { const v = Math.min(q.room - q.got, give * (q.p.split || 1) / sp); q.got += v; used += v; });
          x.got += used; left -= used; give -= used;
        }
      });
    }
    cands.forEach(x => x.ps.forEach(q => {
      if (q.got >= 1) reinvest.push({ fund: q.p, cat: x.c.k, amt: q.got, why: dev2[x.c.k] <= -1 ? `${x.c.n}比目标少 ${Math.abs(dev2[x.c.k]).toFixed(0)} 个点` : `按比例补${x.c.n}，投完以后回到目标` });
      if (q.room < Infinity && q.got >= q.room - 0.5 && x.got < x.need - 0.5) capHit.push(q.p.short || q.p.name);
    }));
    freedLeft = left;
    freedLeft = Math.max(0, freedLeft);
  }
  // 先用卖出的钱，再用限购剩下的钱，最后用银行卡里的钱；没用完的回到银行卡
  const used = freed - freedLeft, fromSells = Math.min(sellAmt, used), capUsed = Math.min(capPool, used - fromSells), deployUsed = Math.max(0, used - fromSells - capUsed);
  const sellLeft = sellAmt - fromSells, capLeft = capPool - capUsed;
  const bank = bankVal + capLeft;                                  // 这个月该投、但留在银行卡的钱
  const transferIn = planTotal + capUsed + deployUsed;             // 这个月从银行卡转进支付宝的钱
  const reserveDelta = bank - extra - deployUsed + sellLeft;       // 打卡“全部照做”后，银行卡里等着投的钱的变化
  const swaps = adv.filter(x => x.adv.t === '换成更好的');   // 换基的钱直接买同类推荐，不在上面分配

  const held = new Set(items.map(i => i.code));
  const missing = FUNDS.filter(f => f.pick && !held.has(f.code) && T[f.cat] > 0 && !(noActive && f.cat === 'active')).map(f => {
    const sig = sigOf(f.cat, f), p = planFor(f.code), heldSame = items.some(i => i.cat === f.cat && !i.exit);
    let a;
    if (f.cat === 'cash') a = p && Math.round(p.amt) >= 1 ? { k: 'buy', t: '开始存入', amt: Math.round(p.amt), why: [`还没有余额宝。它是组合的应急钱和“弹药库”，本月存入 ${fmt(p.amt)}。`] } : { k: 'hold', t: '先不存', amt: 0, why: ['还没有余额宝。这个月的钱都用在买基金上了，下个月再开始存。'] };
    else if (redirect[groupOf(f)]) { const r = redirect[groupOf(f)]; a = { k: 'hold', t: '不用买', amt: 0, why: [`你已经有 ${maxN} 只了。${r.short || r.name} 和它跟踪同一个指数，这一类的钱继续买 ${r.short || r.name}，不再多开一只。`] }; }
    else if (full[groupOf(f)]) a = { k: 'hold', t: '先不买', amt: 0, why: [`你手里的基金已经够 ${maxN} 只了，这只先不买，这份钱留在银行卡。等“买卖分析”里要合并的那只合并完，再开始买。`] };
    else if (!monthly) a = { k: 'hold', t: '待设置', amt: 0, why: ['还没设置每月定投金额。到“我的 → 偏好”里填上，系统才能算出每只买多少。'] };
    else if (over(f.cat)) a = { k: 'hold', t: '先不买', amt: 0, why: [`${CAT[f.cat].n}已经超配，本月不买。等比例回到目标附近再开始定投。`] };
    else if (!p || Math.round(p.amt) < 1) a = { k: 'stop', t: '先不买', amt: 0, why: [`估值${sig.t}（${valText(f.cat, f)}）。等估值回落再开始定投，这部分钱先留在银行卡里。`] };
    else a = { k: 'buy', t: '开始买入', amt: Math.round(p.amt), why: [`组合里还没有这只${heldSame ? '' : `，也还没有${CAT[f.cat].n}这一类`}。估值${sig.t}，从本月开始定投 ${fmt(p.amt)}。`] };
    if (a.k === 'buy' && tightCap(f)) a.why.push(`这只限购，每天最多买 ${fmt(f.buyCap)}。金额够的话设成支付宝“每日定投”最省事，具体怎么买看“本月定投计划”。`);
    return { code: f.code, fund: f, cat: f.cat, name: f.name, amount: 0, profit: 0, pp: 0, adv: a, notHeld: true };
  });
  const order = { sell: 0, swap: 1, move: 2, buy: 2, stop: 3, wait: 3, hold: 4 };
  const advice = adv.concat(missing).sort((x, y) => order[x.adv.k] - order[y.adv.k] || y.amount - x.amount);
  // 每只限购基金本月一共要买多少（定投 + 卖出再买），只给一个每日定投金额
  const capTotal = {};
  plan.concat(reinvest).forEach(r => { if (r.fund && tightCap(r.fund) && r.amt >= 1) capTotal[r.fund.code] = (capTotal[r.fund.code] || 0) + r.amt; });
  return { T, items, zeroItems, total, profit, byCat, pByCat, w, dev, w2, dev2, eqW, expRet, expDd, curDd, plan, parked, bonus, parkedWhy, cashOver, bank, extra, planTotal, monthly, advice, sched, freed, reinvest, freedLeft, swaps, capTotal, capHit, capWhy, sellAmt, capPool, deploy, reserve, sellLeft, capLeft, capUsed, deployUsed, transferIn, reserveDelta };
}
/* ================= 本月计划锁定 =================
   每个月第一次打开时，把本月的计划和建议存下来。之后你在支付宝买完、更新持仓、打卡，
   本月的金额都不会再变，避免“更新完持仓又提示再买一遍”。月初如果持仓还没录好，可以点“按最新持仓重算”。 */
const SNAP_NUMS = ['planTotal', 'parked', 'bonus', 'bank', 'extra', 'freed', 'freedLeft', 'sellAmt', 'capPool', 'deploy', 'reserve', 'sellLeft', 'capLeft', 'capUsed', 'deployUsed', 'transferIn', 'reserveDelta', 'monthly'];
function safeTxt(t) { return String(t == null ? '' : t).replace(/[<>&"]/g, c => ({ '<': '＜', '>': '＞', '&': '＆', '"': '＂' }[c])).slice(0, 600); }
function makeSnap(A) {
  const sg = x => x ? { m: +x.m || 0, t: safeTxt(x.t), k: safeTxt(x.k), top: !!x.top, conflict: !!x.conflict } : null;
  const n = {}; SNAP_NUMS.forEach(k => { n[k] = Math.round((+A[k] || 0) * 100) / 100; });
  const buys = {}; A.plan.concat(A.reinvest).forEach(r => { if (r.fund) buys[r.fund.code] = (buys[r.fund.code] || 0) + (+r.amt || 0); });
  return { m: monthKey(), at: today(), n, held: Object.fromEntries(P.items.filter(i => +i.amount > 0).map(i => [safeTxt(i.code), +i.amount || 0])), buys,
    plan: A.plan.map(r => ({ code: r.fund.code, cat: r.cat, base: r.base, amt: r.amt, m: r.m, note: safeTxt(r.note), capped: r.capped || 0, sig: sg(r.sig) })),
    reinvest: A.reinvest.map(r => ({ code: r.fund.code, cat: r.cat, amt: r.amt, why: safeTxt(r.why) })),
    advice: A.advice.map(x => ({ code: safeTxt(x.code), cat: x.cat, name: safeTxt(x.name), amount: +x.amount || 0, pp: +x.pp || 0, notHeld: !!x.notHeld,
      adv: { k: safeTxt(x.adv.k), t: safeTxt(x.adv.t), amt: +x.adv.amt || 0, why: (x.adv.why || []).map(safeTxt).slice(0, 8) } })),
    parkedWhy: A.parkedWhy.map(safeTxt).slice(0, 12), capWhy: (A.capWhy || []).map(safeTxt).slice(0, 8), capHit: A.capHit.map(safeTxt).slice(0, 8) };
}
function cleanSnap(sn) {
  if (!sn || typeof sn !== 'object' || sn.m !== monthKey() || !Array.isArray(sn.plan) || !Array.isArray(sn.advice) || !sn.n) return null;
  try { return JSON.parse(JSON.stringify(sn, (k, v) => typeof v === 'string' ? safeTxt(v) : v)); } catch (e) { return null; }
}
function applySnap(A, sn) {
  const ok = c => FUND[c];
  if (!sn.plan.every(r => ok(r.code)) || !(sn.reinvest || []).every(r => ok(r.code))) return A;
  const B = Object.assign({}, A, { live: A, locked: sn.at });
  SNAP_NUMS.forEach(k => { B[k] = +sn.n[k] || 0; });
  B.plan = sn.plan.map(r => Object.assign({}, r, { fund: FUND[r.code], sig: r.sig || sigOf(r.cat, FUND[r.code]) }));
  B.reinvest = (sn.reinvest || []).map(r => Object.assign({}, r, { fund: FUND[r.code] }));
  B.advice = sn.advice.map(x => Object.assign({}, x, { fund: FUND[x.code] || null, cat: CAT[x.cat] ? x.cat : 'active', profit: 0 }));
  B.parkedWhy = sn.parkedWhy || []; B.capWhy = sn.capWhy || []; B.capHit = sn.capHit || [];
  B.swaps = B.advice.filter(x => x.adv.t === '换成更好的');
  B.capTotal = {}; B.plan.concat(B.reinvest).forEach(r => { if (r.fund && tightCap(r.fund) && r.amt >= 1) B.capTotal[r.fund.code] = (B.capTotal[r.fund.code] || 0) + r.amt; });
  return B;
}
/* 页面和打卡、记账用这个：本月锁定过就用锁定的计划，没锁定就现在锁 */
function monthView(A) {
  if (P.example || !(+P.monthly > 0)) return A;
  let sn = cleanSnap(P.monthPlan);
  if (sn && !monthDone() && !heldExplained(sn)) sn = null;
  if (!sn) { sn = makeSnap(A); P.monthPlan = sn; save(); }
  const B = applySnap(A, sn); B.askHeld = !!sn.ask && !monthDone(); return B;
}
function analyzeM() { return monthView(analyze()); }
/* 本月已经打卡“全部照做”或一键记过账：计划不再变 */
function monthDone() { const mk = monthKey(), j = P.journal.find(x => x.m === mk); return !!(j && j.choice === 'full') || !!(P.ledger && P.ledger.txns.some(t => t.plan === mk)); }
/* 锁定以后持仓的变化，能不能用“照着本月计划买卖了”来解释：
   新增的基金金额不超过计划买它的 1.5 倍（加 100 元），删掉的基金是计划要卖的 → 照常锁定；
   否则多半是刚录入已有的持仓，按最新持仓重算 */
function heldExplained(sn) {
  const held = sn.held || {}, buys = sn.buys || {}, now = P.items.filter(i => +i.amount > 0);
  const sells = new Set(sn.advice.filter(x => ['sell', 'swap'].includes(x.adv.k)).map(x => x.code));
  if (now.some(i => !(i.code in held) && +i.amount > 1.5 * (buys[i.code] || 0) + 100)) return false;
  if (Object.keys(held).some(c => !now.some(i => i.code === c) && !sells.has(c))) return false;
  return true;
}
/* 改了每月金额、测评、银行卡里的钱以后，本月还没打卡的话，计划按新设置重算 */
function unlockMonth() { if (!monthDone()) P.monthPlan = null; }
/* 基金代码 + 复制按钮：在支付宝搜简称会出来几十只，用代码搜最准 */
const codeChip = c => /^\d{6}$/.test(c || '') ? `<span class="codechip"><span class="n">${c}</span><button type="button" class="copybtn" data-copy="${c}" aria-label="复制代码 ${c}">复制</button></span>` : '';
const heldLine = (A, x) => { const it = (A.live || A).items.find(i => i.code === x.code); if (!it) return ''; const c = it.amount - it.profit, q = c > 0 ? it.profit / c * 100 : 0; return `持有 ${fmt(it.amount)} · <span class="${cls(q)}">${pct(q)}</span>`; };
const askBar = A => A.askHeld ? `<div class="banner ask"><span><b>你刚更新了持仓。</b>这是：</span><div class="btnrow"><button class="btn sm" type="button" data-ask="keep">照本月计划买完后更新的</button><button class="btn sm ghost" type="button" data-ask="relock">录入原来就有的持仓</button></div><span class="note">选第一个，本月计划保持不变，不会重复买；选第二个，按最新持仓重新算本月计划。</span></div>` : '';
const lockNote = A => A.locked ? `<p class="note lock">本月计划在 ${esc(cnDate(A.locked) || A.locked)} 生成，已经锁定：在支付宝买完、更新持仓以后，本月的金额不会再变，不用担心重复买。${monthDone() ? '' : '<br>如果这个月还没买，只是刚录入已有的持仓，可以 <button class="linkbtn" type="button" data-relock>按最新数据重算</button>。'}</p>` : '';

/* 记录分批卖出的开始月份；不再需要卖的清掉 */
function syncSellPlans(A) {
  P.sellPlans = P.sellPlans || {}; let changed = false; const mk = monthKey();
  Object.keys(A.sched).forEach(code => { if (!P.sellPlans[code]) { P.sellPlans[code] = { start: mk }; changed = true; } });
  Object.keys(P.sellPlans).forEach(code => { if (!A.sched[code]) { delete P.sellPlans[code]; changed = true; } });
  if (changed && !P.example) save();
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
  const verb = a.k === 'move' ? '取出' : a.k === 'buy' ? (a.t === '开始存入' ? '存入' : '买入') : a.k === 'sell' ? '卖出' : a.k === 'swap' ? '换掉' : '';
  return `<span class="n ${a.k === 'buy' ? 'up' : a.k === 'sell' ? 'down' : ''}">${verb} ${fmt(a.amt)}</span>`;
}
const exampleBanner = () => P.example ? `<div class="banner"><span>现在显示的是<b>示例持仓</b>，不是你的。录入你在支付宝里的持仓后，所有分析都会换成你自己的。</span><a class="btn sm" href="#holdings">录入我的持仓</a></div>` : '';
const riskBanner = () => !P.risk ? `<div class="banner"><span>还没做风险测评，目前按“平衡”型配置。花 1 分钟答 5 道题，比例会更适合你。</span><a class="btn sm" href="#me-quiz">去测评</a></div>` : '';
/* 用最新一只基金的净值日期判断数据是否过期（不看脚本运行时间，避免抓取失败却显示“刚更新”） */
/* 数据是否过期：看推荐基金（不含余额宝）净值日期的中位数，以及沪深300 估值日期，取较旧的那个 */
function dataDate() {
  const navs = FUNDS.filter(f => f.pick && f.cat !== 'cash').map(f => f.navDate).filter(Boolean).sort();
  const med = navs.length ? navs[Math.floor((navs.length - 1) / 2)] : null;
  const val = M.hs300 && /^\d{4}-\d{2}-\d{2}$/.test(M.hs300.date || '') ? M.hs300.date : null;
  return [med, val].filter(Boolean).sort()[0] || null;
}
function dataAge() {
  const nd = dataDate(); const d = nd ? Date.parse(nd + 'T15:00:00+08:00') : NaN;
  if (isNaN(d)) return '<div class="banner warn"><span>没有读到基金净值或估值数据。操作前请在天天基金或支付宝核对。</span></div>';
  // 按工作日算：周末不算，避免周一早上误报；国庆、春节最多 5 个工作日
  let wd = 0; for (let t = new Date(d); t.setDate(t.getDate() + 1) && t <= new Date();) { const k = t.getDay(); if (k !== 0 && k !== 6) wd++; }
  return wd > (C.rules.staleWeekdays || 5) ? `<div class="banner warn"><span>净值和估值数据停在 ${cnDate(nd)}，已经 ${wd} 个工作日没更新。如果不是长假，可能是自动更新出了问题，操作前请在天天基金核对。</span></div>` : '';
}
/* 限购基金只给一个每日定投金额：同时出现在定投计划和“卖出的钱怎么买”时，只在后一张表写合计 */
function capLine(A, f, where) {
  if (!f || !tightCap(f)) return '';
  const tot = A.capTotal[f.code] || 0; if (tot < 1) return '';
  const inRe = A.reinvest.some(r => r.fund.code === f.code && r.amt >= 1), planAmt = ((A.plan.find(p => p.fund.code === f.code) || {}).amt) || 0;
  if (where === 'plan' && inRe) return `<div class="sub">限购，每日定投金额见下面“本月多出来的钱怎么买”</div>`;
  if (tot <= f.buyCap) return `<div class="sub">每天最多买 ${fmt(f.buyCap)}，一次买完就行</div>`;
  return `<div class="sub">${where === 'reinvest' && planAmt >= 1 ? `本月合计要买 ${fmt(tot)}（已含定投计划的 ${fmt(planAmt)}）。` : ''}${buyHow(f, tot)}</div>`;
}
function planNote(A) {
  const out = [];
  if (A.extra > 0) out.push(`估值便宜的类别多买，比平时多出 ${fmt(A.extra)}：用之前贵的月份留在银行卡里的钱；手头紧就只按平时金额买，不用勉强。`);
  if (A.capPool >= 1) out.push(`${(A.capWhy || []).length ? A.capWhy.join('。') + '。' : `限购（或暂停申购）买不进 ${fmt(A.capPool)}。`}${A.capUsed >= A.capPool - 1 ? '买什么见“本月多出来的钱怎么买”。' : A.capUsed >= 1 ? `其中 ${fmt(A.capUsed)} 见“本月多出来的钱怎么买”，剩下的 ${fmt(A.capPool - A.capUsed)} 其他类别不缺、太贵或者额度也满了，先留在银行卡。` : '这个月其他类别不缺、太贵或者额度也满了，先留在银行卡。'}`);
  if (A.deploy >= 1) out.push(`${A.locked ? '本月开始时，' : ''}你银行卡里等着投的钱有 ${fmt(A.reserve)}，攒得比较多了（超过持仓加这笔钱的 ${C.rules.reserveDeployPct || 5}%），${A.deployUsed >= 1 ? `这个月投回去 ${fmt(A.deployUsed)}` : '但这个月没有缺的类别能买，先放着'}。钱一直闲着会拉低收益；一个月最多投回一个月的定投额，慢慢来。`);
  if (A.bank > 0) { const j = P.journal.find(x => x.m === monthKey()); out.push(`这个月有 ${fmt(A.bank)} 没投出去，留在你的银行卡里。${j && j.choice === 'full' ? '已经记到“持仓 → 银行卡里等着投的钱”。' : '打卡“全部照做”时系统会记到“银行卡里等着投的钱”，攒多了再分批投回去。'}`); }
  if (A.parkedWhy.length) out.push(A.parkedWhy.join('。') + '。这些钱留在银行卡里。');
  if (A.plan.some(p => p.cat === 'overseas' && p.note === '限购')) out.push('目前海外基金额度很紧（每天 10–100 元），海外比例会长期低于目标，这是正常的，不用想办法绕开，也不用换高价渠道。股票部分其他类别照常买。');
  const moreUsed = A.freed - A.freedLeft;
  if (moreUsed >= 1) out.push(`另外本月多出来的 ${fmt(moreUsed)}（${[A.sellAmt >= 1 ? '卖出的钱' : '', A.capUsed >= 1 ? '限购转过来的' : '', A.deployUsed >= 1 ? '银行卡里投回的' : ''].filter(Boolean).join('、')}）买哪几只，见“买卖分析 → 本月多出来的钱怎么买”。`);
  else if (A.sellAmt > 0) out.push(`另外本月卖出共 ${fmt(A.sellAmt)}，见“买卖分析”。`);
  if (A.transferIn >= 1 && Math.round(A.transferIn) !== Math.round(A.planTotal)) out.push(`这个月一共从银行卡转进支付宝 ${fmt(A.transferIn)}（定投 ${fmt(A.planTotal)}${A.capUsed >= 1 ? ` + 限购转去买别的 ${fmt(A.capUsed)}` : ''}${A.deployUsed >= 1 ? ` + 银行卡里投回 ${fmt(A.deployUsed)}` : ''}）${A.sellAmt - A.sellLeft >= 1 ? `；卖出再买的 ${fmt(A.sellAmt - A.sellLeft)} 已经在支付宝里，不用转` : ''}。`);
  return out.map(t => `<p class="note">${t}</p>`).join('') + (A.plan.some(p => tightCap(p.fund) && p.amt >= 1) ? DAILY_HOWTO : '');
}
const shortBanner = () => currentLevel().short ? '<div class="banner warn"><span>你在测评里选了“这笔钱 1 年内要用”。一年内要用的钱不该放股票基金，所以系统只安排债券基金。</span></div>' : '';
const zeroHint = A => A.zeroItems ? `<p class="note">有 ${A.zeroItems} 只基金金额是 0，没有算进分析。去“持仓”页填上金额。</p>` : '';
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
  ${dataAge()}${importHint()}${exampleBanner()}${askBar(A)}${quizLaterBanner()}${riskNotice(A)}${riskBanner()}${shortBanner()}${backupWarn(false)}
  ${!P.example && calmAlerts(A).some(x => x.held) ? (riskNotice(A) ? '<a class="banner calmmini" href="#analysis-calm"><span>正在下跌，先别慌 ›</span></a>' : `<div class="grid3">${calmCard(A, true)}</div>`) : ''}
  <div class="grid3">
    <section class="hero span2" aria-label="资产总览">
      <div class="hero-top"><span class="lbl">总资产（元）</span><span class="pill">${lv.level.n}型 · 长期估算年化约 ${A.expRet.toFixed(1)}%</span></div>
      <div class="big n">${fmt(A.total, 2).slice(1)}</div>
      ${(+P.reserve || 0) >= 1 && !P.example ? `<div class="sub">另有银行卡里等着投的 ${fmt(P.reserve)}（不算在上面）</div>` : ''}
      <div class="hero-row">
        <div><div class="lbl">持有收益</div><div class="v n ${cls(A.profit)}">${signed(A.profit)}</div></div>
        <div><div class="lbl">收益率</div><div class="v n ${cls(pp)}">${pct(pp, 2)}</div></div>
        <div><div class="lbl">熊市浮亏(按现在持仓估)</div><div class="v n">约 −${Math.round(A.curDd)}%</div></div>
      </div>
      ${A.total ? `<div class="stack" aria-hidden="true">${C.cats.filter(c => A.byCat[c.k] > 0).map(c => `<span style="flex:${A.byCat[c.k]};background:var(--s-${c.k})" data-tip="${c.n} ${A.w[c.k].toFixed(1)}%"></span>`).join('')}</div>
` : '<p class="note">还没有持仓。去“持仓”页添加第一只基金。</p>'}
      ${zeroHint(A)}
    </section>
    <section class="card" aria-label="本月要做的事">
      <div class="card-h"><h3>本月要做的事</h3><a class="more" href="#analysis">全部 ›</a></div>
      ${checked && ['full', 'part'].includes(checked.choice) && !P.example ? `<div class="donebox">${checked.choice === 'full' ? '<b>✓ 本月已完成</b>（全部照做）。这个月不用再买，也不用天天打开，等下个定投日就行。' + (daysSince(lsGet('money.exp')) > 25 ? ' <button class="linkbtn" type="button" data-export>顺手导出一份备份</button>' : '') : '<b>本月已打卡</b>（做了一部分）。没做的部分在下个定投日前补上就行，不用下个月买双倍。没投出去的钱，可以到“持仓 → 银行卡里等着投的钱”自己加上。'}</div>
      <details class="pickfrom"><summary>再看一眼本月的建议</summary>` : ''}
      <div class="chiprow">${cnt('sell') ? `<span class="act sell">卖出 ${cnt('sell')}</span>` : ''}${cnt('swap') ? `<span class="act swap">换基 ${cnt('swap')}</span>` : ''}${cnt('move') ? `<span class="act move">转出 ${cnt('move')}</span>` : ''}${cnt('buy') ? `<span class="act buy">买入 ${cnt('buy')}</span>` : ''}${cnt('stop') ? `<span class="act stop">暂停 ${cnt('stop')}</span>` : ''}${cnt('hold') ? `<span class="act hold">持有 ${cnt('hold')}</span>` : ''}</div>
      <div class="rows">${todo.slice(0, 5).map(x => `<div class="row static"><div class="t">${dot(x.cat)}<a class="ell plain" href="${x.fund ? '#fund-' + x.fund.code : '#analysis'}">${esc(x.fund && x.fund.short || x.name)}</a><span class="codeline">${codeChip(x.code)}</span></div><div class="r">${actChip(x.adv)}</div>${x.adv.amt ? `<div class="s">${amtLine(x.adv)}</div>` : ''}</div>`).join('') || '<p class="muted">这个月不用操作。</p>'}</div>
      ${A.freed - A.freedLeft >= 1 ? `<p class="note">另外多出来的 ${fmt(A.freed - A.freedLeft)} 要买哪几只：<a class="more" href="#analysis">买卖分析 → 本月多出来的钱怎么买 ›</a></p>` : ''}
      ${checked && ['full', 'part'].includes(checked.choice) && !P.example ? '</details>' : ''}
      <p class="note">下次定投日：每月 ${di.day} 号，${di.n === 0 ? '就是今天' : `还有 ${di.n} 天`}。${P.prefs.calDay === di.day ? '' : ` <a class="more" href="#me-cal">${P.prefs.calDay ? '定投日改了，重新加日历提醒 ›' : '加到手机日历，到日子提醒我 ›'}</a>`}</p>
    </section>
  </div>

  <div class="grid2">
    <section class="card" aria-label="本月定投">
      <div class="card-h"><h3>本月定投 <span class="n">${fmt(A.planTotal)}</span></h3><a class="more" href="#analysis-plan">明细 ›</a></div>
      <p class="note">每只买多少见上面“本月要做的事”，或者点“明细”。</p>
      ${planNote(A)}
    </section>
    <section class="card" aria-label="本月打卡">
      <div class="card-h"><h3>本月打卡</h3><a class="more" href="#me">执行记录 ›</a></div>
      ${checked ? `<p>这个月已打卡：<b>${esc(CHOICES[checked.choice].t)}</b>。</p>${P.prefs.calDay ? '' : '<p class="note">下个月想被提醒？<a class="more" href="#me-cal">加到手机日历 ›</a></p>'}<p class="note">系统会根据打卡记录学习你的习惯，调整股票比例和提醒。</p><button class="btn ghost sm" type="button" data-uncheck>改一下</button>`
        : P.example ? '<p class="muted" style="font-size:13px">录入你自己的持仓以后，每月在这里打卡。</p>' : `<p class="muted" style="font-size:13px">这个月你按建议操作了吗？如实选，系统靠它了解你的习惯。</p><div class="checkin">${Object.entries(CHOICES).map(([k, v]) => `<button class="btn ghost" type="button" data-checkin="${k}">${v.t}</button>`).join('')}</div>`}
    </section>
  </div>
  <details class="more-sec" id="home-more" ${homeMore ? 'open' : ''}><summary>更多：资产配置、市场温度、资产走势、年化目标</summary><div class="more-in">
  <div class="grid3">
    <section class="card" aria-label="资产配置">
      <div class="card-h"><h3>资产配置</h3><span class="sub">现在 / 目标</span></div>
      <div class="donutwrap">${donut(segs, 136, 18, '股票类', Math.round(A.eqW) + '%')}
        <div class="legend">${C.cats.filter(c => A.T[c.k] > 0 || A.byCat[c.k] > 0).map(c => `<div class="li">${dot(c.k)}<span>${c.n}</span><span class="n">${A.w[c.k].toFixed(0)}%</span><span class="n faint">${A.T[c.k]}%</span></div>`).join('')}</div></div>
      ${(() => { const off = C.cats.filter(c => Math.abs(A.dev[c.k]) >= C.rules.rebalanceBand); return A.total ? (off.length ? `<p class="note">偏离目标超过 ${C.rules.rebalanceBand} 个百分点：${off.map(c => `${c.n}${A.dev[c.k] > 0 ? '多' : '少'} ${Math.abs(A.dev[c.k]).toFixed(0)} 个点`).join('，')}。</p>` : '<p class="note">各类比例都在目标附近。</p>') : ''; })()}
      ${A.total ? `<div class="tbox"><table><thead><tr><th>类别</th><th class="r">金额</th><th class="r">占比</th><th class="r">目标</th><th class="r">持有收益</th></tr></thead><tbody>${C.cats.filter(c => A.byCat[c.k] > 0 || A.T[c.k] > 0).map(c => `<tr><td>${dot(c.k)} ${c.n}</td><td class="r">${fmt(A.byCat[c.k])}</td><td class="r">${A.w[c.k].toFixed(1)}%</td><td class="r faint">${A.T[c.k]}%</td><td class="r ${cls(A.pByCat[c.k])}">${signed(A.pByCat[c.k])}</td></tr>`).join('')}</tbody></table></div>` : ''}
    </section>
    <section class="card" aria-label="市场温度">
      <div class="card-h"><h3>市场温度</h3><a class="more" href="#analysis-market">详情 ›</a></div>
      <div class="temp"><span>沪深300 估值分位</span>${sigChip(SIG.index)}<span class="v n">${idxPct == null ? '—' : Math.round(idxPct) + '%'}</span><span class="sub">${cnDate(M.hs300 && M.hs300.date)}</span></div>
      ${gaugeHTML(idxPct)}
      <div class="temp"><span>红利低波 股息率比国债高</span>${sigChip(SIG.div)}<span class="v n">${spread == null ? '—' : spread.toFixed(2) + ' 个百分点'}</span><span class="sub">${divPct != null ? `自身估值 ${Math.round(divPct)}% 分位` : ''} ${cnDate(M.divLowVol && M.divLowVol.date)}</span></div>
      ${SIG.div.conflict ? '<p class="note">息差显示便宜，但红利低波自身估值已经很高，两个信号打架，按 1 倍买。</p>' : ''}
      <div class="us">${[['sp500', '标普500'], ['ndx', '纳指100']].map(([k, n]) => `<div class="temp"><span>${n} 估值分位</span>${sigChip(SIGV[k])}<span class="v n">${M[k] && M[k].pePct10y != null ? Math.round(M[k].pePct10y) + '%' : '—'}</span><span class="sub">${cnDate(M[k] && M[k].date)}</span></div>`).join('')}</div>
    </section>
    <section class="card" aria-label="资产走势">
      <div class="card-h"><h3>资产走势</h3><span class="sub">每次更新持仓自动记录</span></div>
      ${lineChart('hist', hist, { label: '总资产走势', fmtY: v => (v / 10000).toFixed(1) + '万', fmtX: cnDate, fmtTip: p => `${cnDate(p[0])}：${fmt(p[1])}`, empty: P.example ? '录入你的真实持仓后，这里会画出总资产的变化。' : '更新两次以上持仓后，这里会画出总资产的变化。建议每月定投后更新一次。' })}
    </section>
  </div>
  <div class="grid3">${goalCard(A)}${aiCardHome()}</div>
  </div>  </details>
  ${riskFoot()}
  </div>`;
}

const doneBanner = () => { const j = P.journal.find(x => x.m === monthKey()); return j && ['full', 'part'].includes(j.choice) && !P.example ? '<div class="banner"><span>✓ 这个月已经打卡“' + esc(CHOICES[j.choice].t) + '”。下面是本月的建议，已经照着做过的不用再做一遍。</span></div>' : ''; };
function viewAnalysis(A) {
  return `<div class="view">
  ${dataAge()}${exampleBanner()}${askBar(A)}${doneBanner()}${shortBanner()}
  <section class="card" id="sec-advice">
    <div class="card-h"><h3>每只基金的操作建议</h3><span class="sub">最需要处理的排在前面</span></div>
    <div class="rows">${A.advice.map(x => `
      <div class="row static">
        <div class="t">${dot(x.cat)}${x.fund ? `<a href="#fund-${x.fund.code}" class="plain">${esc(x.fund.short || x.name)}</a>` : esc(x.name)}${codeChip(x.code)}${x.notHeld ? '<span class="tag">未持有</span>' : ''}${x.fund && x.fund.pick ? '<span class="tag pick">推荐</span>' : ''}</div>
        <div class="r">${actChip(x.adv)}</div>
        <div class="s why">${x.adv.why.map(w => `<span>${esc(w)}</span>`).join('')}</div>
        <div class="s n">${heldLine(A, x)}</div>
        <div class="r strong">${amtLine(x.adv)}</div>
      </div>`).join('')}</div>
    ${zeroHint(A)}<p class="note">处理顺序：先卖掉不该拿的，再换掉差的，再处理超配和估值过高的，最后按计划买。卖出、换基都分 ${C.rules.sellMonths} 个月做完，不一次清仓；估值便宜时不减仓。</p>
  </section>
  ${calmCard(A, false)}
  ${A.freed - (A.deploy - A.deployUsed) >= 1 ? `<section class="card" id="sec-reinvest">
    <div class="card-h"><h3>本月多出来的钱怎么买</h3><span class="sub">共 ${fmt(A.freed - (A.deploy - A.deployUsed))}</span></div>
    <p class="note">${[A.sellAmt >= 1 ? `卖出 ${fmt(A.sellAmt)}` : '', A.capPool >= 1 ? `限购买不进的定投钱 ${fmt(A.capPool)}` : '', A.deployUsed >= 1 ? `银行卡里投回 ${fmt(A.deployUsed)}` : ''].filter(Boolean).join(' + ')}。${A.deploy - A.deployUsed >= 1 ? `银行卡里另有 ${fmt(A.deploy - A.deployUsed)} 这个月没地方投，继续留着。` : ''}</p>
    <div class="tbox"><table><thead><tr><th>买入</th><th>原因</th><th class="r">金额</th></tr></thead><tbody>
      ${A.reinvest.filter(r => r.amt >= 1).map(r => `<tr><td><span class="cellname">${dot(r.cat)}<a href="#fund-${r.fund.code}" class="plain">${esc(r.fund.short || r.fund.name)}</a></span><div class="sub codeline">${codeChip(r.fund.code)}</div>${capLine(A, r.fund, 'reinvest')}</td><td class="muted">${esc(r.why || '')}</td><td class="r strong">${fmt(r.amt)}</td></tr>`).join('')}
      ${A.sellLeft + A.capLeft >= 1 ? `<tr><td><span class="cellname"><span>先不买，留在银行卡</span></span></td><td class="muted">${A.capHit.length ? `${esc(A.capHit.join('、'))}本月额度已用完；` : ''}其他类别不缺，或者估值太贵，等能买的时候再用</td><td class="r strong">${fmt(A.sellLeft + A.capLeft)}</td></tr>` : ''}
      <tr><td colspan="2"><b>合计</b></td><td class="r strong">${fmt(A.freed - (A.deploy - A.deployUsed))}</td></tr></tbody></table></div>
    <p class="note">按各类比目标少多少来分，缺得多的多买；估值“很贵”的类别不买，限购的买满额度为止。这笔钱和每月定投分开算。${A.swaps.length ? '换基的钱直接买同类推荐基金，不在这张表里。' : ''}</p>
  </section>` : ''}
  <section class="card" id="sec-plan">
    <div class="card-h"><h3>本月定投计划</h3><span class="sub">每月基础 ${fmt(A.monthly)}</span></div>
    ${lockNote(A)}
    <div class="tbox"><table><thead><tr><th>基金</th><th>估值信号</th><th class="r">倍数</th><th class="r">金额</th></tr></thead><tbody>
      ${A.plan.map(p => `<tr><td><span class="cellname">${dot(p.cat)}<a href="#fund-${p.fund.code}" class="plain">${esc(p.fund.short || p.fund.name)}</a>${p.note ? `<span class="tag">${esc(p.note)}</span>` : ''}</span><div class="sub codeline">${codeChip(p.fund.code)}</div>${capLine(A, p.fund, 'plan')}</td><td>${p.note === '已超配' ? '<span class="act hold">不买</span>' : sigChip(p.sig)}</td><td class="r">${p.cat === 'cash' ? (A.extra > 0 ? `取出 ${fmt(A.extra)}` : '净额') : p.note === '限购' ? '买满' : p.note === '暂停申购' ? '暂停' : p.m + '×'}</td><td class="r strong">${fmt(p.amt)}</td></tr>`).join('')}
      <tr><td colspan="3"><b>合计</b></td><td class="r strong">${fmt(A.planTotal)}</td></tr></tbody></table></div>
    ${P.ledger && !P.example ? `<div class="btnrow"><button class="btn ghost" type="button" data-ledger="plan">在支付宝买完了，按计划一键记账</button></div>` : ''}
    ${planNote(A)}<p class="note">规则：便宜的类别多买，贵的少买（很贵也买一半，不完全停），限购或暂停申购的买不进，已经超配的本月不买；某类比目标少 ${C.rules.catchUpBand} 个点以上且不贵时，额外多买 0.5 倍。</p>
  </section>
  ${stressCard(A)}
  <details class="more-sec" id="ana-more"><summary>更多：AI 解读、市场估值、逐年涨跌、同类对比</summary><div class="more-in">
  <section class="card" id="sec-ai">
    <div class="card-h"><h3>AI 解读</h3><span class="sub">DeepSeek · 只解释，不改规则</span></div>
    ${AIS.key ? `<div class="btnrow"><button class="btn" type="button" data-ai="review">${P.aiReport ? '重新解读本月建议' : '让 AI 解读本月建议'}</button><button class="btn ghost" type="button" data-ai="stop" id="ai-stop" hidden>停止</button></div>
    <div id="ai-out" class="ai-text" ${P.aiReport ? '' : 'hidden'}>${P.aiReport ? aiReportHTML(P.aiReport) : ''}</div>
    <div class="addrow"><label class="field">有问题直接问（比如：为什么让我卖富国天惠？）<input id="ai-q" type="text" class="txt" maxlength="200" placeholder="输入问题，按回车"></label><button class="btn ghost" type="button" data-ai="ask">提问</button></div>
    <div id="ai-ans" class="ai-text" hidden></div>
    <p class="note">提问时会把你的持仓金额和本页的建议发给 DeepSeek，不发名字。</p>`
    : '<p class="muted" style="font-size:13px">填上 DeepSeek API key，就能让 AI 用大白话解读本月建议，也能直接提问。</p><a class="btn sm" href="#me-ai">去设置</a>'}
    <details class="pickfrom"><summary>盯盘历史提醒（${marketAlerts(3650).length} 条）</summary>${marketAlerts(3650).slice(0, 20).map(alertHTML).join('') || '<p class="note">还没有提醒。只有估值档位变化、明显回撤或数据断更时才会提醒。</p>'}</details>
  </section>
  <section class="card" id="sec-market">
    <div class="card-h"><h3>市场估值</h3><span class="sub">决定每月买多少</span></div>
    <div class="temp"><span>沪深300 市盈率分位（近10年）</span>${sigChip(SIG.index)}<span class="v n">${idxPct == null ? '—' : Math.round(idxPct) + '%'}</span><span class="sub">市盈率 ${M.hs300 && M.hs300.pe != null ? M.hs300.pe : '—'} · ${cnDate(M.hs300 && M.hs300.date)}</span></div>
    ${gaugeHTML(idxPct)}
    <p class="note">${idxPct == null ? '' : `分位 ${Math.round(idxPct)}% 的意思是：过去 10 年里有 ${Math.round(idxPct)}% 的时间比现在便宜。`}低于 40% 多买，高于 80% 只买平时的一半。</p>
    <div class="stats">
      <div class="stat"><span class="k">红利低波股息率</span><span class="v n">${M.divLowVol && M.divLowVol.dy != null ? M.divLowVol.dy + '%' : '—'}</span></div>
      <div class="stat"><span class="k">10年国债收益率</span><span class="v n">${M.cgb10y && M.cgb10y.yield != null ? (+M.cgb10y.yield).toFixed(2) + '%' : '—'}</span></div>
      <div class="stat"><span class="k">息差（百分点）</span><span class="v n">${spread == null ? '—' : spread.toFixed(2)}</span></div>
      <div class="stat"><span class="k">红利低波自身估值分位</span><span class="v n">${divPct == null ? '—' : Math.round(divPct) + '%'}</span></div>
    </div>
    <p class="note">息差大于 2 个百分点说明红利低波相对便宜，小于 1 个说明贵了。但它自身市盈率分位到 ${C.rules.divPeCap}% 以上时，最多按 1 倍买${SIG.div.conflict ? '，现在就是这种情况' : ''}。${esc(M.bondNote || '')}</p>
    <div class="stats">
      <div class="stat"><span class="k">标普500 估值分位</span><span class="v n">${M.sp500 && M.sp500.pePct10y != null ? Math.round(M.sp500.pePct10y) + '%' : '—'}</span></div>
      <div class="stat"><span class="k">纳指100 估值分位</span><span class="v n">${M.ndx && M.ndx.pePct10y != null ? Math.round(M.ndx.pePct10y) + '%' : '—'}</span></div>
      <div class="stat"><span class="k">美国10年国债</span><span class="v n">${M.ust10y && M.ust10y.yield != null ? M.ust10y.yield + '%' : '—'}</span></div>
    </div>
    <p class="note">海外按标普500、纳指100 各自的估值分位决定买多少，规则和 A 股一样。QDII 基金常有限购，买不满的部分留在银行卡。</p>
  </section>
  ${(M.hs300Hist && M.hs300Hist.length) || (M.divLowVolHist && M.divLowVolHist.length) ? `<div class="grid2">
    <section class="card"><div class="card-h"><h3>沪深300 逐年涨跌</h3><span class="sub">${M.hs300HistSrc === '联接基金净值' ? '按联接基金净值' : '指数'}，红涨绿跌</span></div>${yearBars(M.hs300Hist)}</section>
    <section class="card"><div class="card-h"><h3>红利低波 逐年涨跌</h3><span class="sub">${M.divLowVolHistSrc === '联接基金净值' ? '按联接基金净值' : '指数'}，红涨绿跌</span></div>${yearBars(M.divLowVolHist)}</section></div>` : ''}
  <section class="card" id="sec-compare">
    <div class="card-h"><h3>同类对比：哪只更好</h3><span class="sub">评分不看近1年涨幅</span></div>
    <div class="seg" role="group" aria-label="选择类别">${C.cats.filter(c => C.levels.some(l => l.target[c.k] > 0)).map(c => `<button class="segbtn" type="button" data-cmp="${c.k}" aria-pressed="${cmpCat === c.k}">${c.n}</button>`).join('')}</div>
    <div id="cmp">${compareTable(cmpCat)}</div>
  </section>
  </div>  </details>
  ${riskFoot()}
  </div>`;
}
let cmpCat = 'index';
function compareTable(k) {
  const fs = FUNDS.filter(f => f.cat === k).sort((a, b) => groupOf(a).localeCompare(groupOf(b)) || a.rank - b.rank);
  const wk = Object.keys(W[k]).map(x => MNAME[x] + ' ' + Math.round(W[k][x] * 100) + '%').join(' · ');
  const note = k === 'overseas' ? '海外按跟踪的指数分组打分：标普500 只和标普500 比，纳指100 只和纳指100 比。' : '';
  return `<div class="tbox"><table><thead><tr><th>基金</th><th style="min-width:120px">评分</th><th class="r">年费率</th><th class="r">规模(亿)</th><th class="r">近3年</th><th class="r">最大回撤</th></tr></thead><tbody>
    ${fs.map(f => `<tr class="${f.pick ? 'best' : ''}"><td><a href="#fund-${f.code}" class="plain strong">${esc(f.short || f.name)}</a> ${f.pick ? '<span class="tag pick">推荐</span>' : ''}<div class="sub n">${f.code}</div></td><td>${scoreBar(f.score)}</td><td class="r">${totalFee(f) == null ? '—' : totalFee(f).toFixed(2) + '%'}</td><td class="r">${f.scaleYi == null ? '—' : f.scaleYi.toFixed(0)}</td><td class="r ${cls(f.ret3y)}">${pct(f.ret3y)}</td><td class="r">${f.maxDd3y == null ? '—' : '−' + Math.abs(f.maxDd3y).toFixed(1) + '%'}</td></tr>`).join('')}
  </tbody></table></div><p class="note">${note}年费率＝管理费＋托管费＋销售服务费，每天从净值里扣，不用另付。A 类买入时收一次申购费、没有销售服务费，C 类相反；打算拿一年以上选 A 更省。</p><p class="note">评分权重：${wk}。缺数据的项按中间分计。推荐基金不一定分数最高，理由见基金详情里的“我的判断”。</p>`;
}

let fundFilter = 'all';
function viewFunds() {
  const order = c => C.cats.findIndex(x => x.k === c);
  const list = FUNDS.filter(f => fundFilter === 'all' ? true : fundFilter === 'pick' ? f.pick : f.cat === fundFilter)
    .sort((a, b) => (!!b.pick - !!a.pick) || order(a.cat) - order(b.cat) || a.rank - b.rank);
  return `<div class="view">
  <div class="seg" role="group" aria-label="筛选">${[['all', '全部'], ['pick', '推荐组合'], ...C.cats.filter(c => FUNDS.some(f => f.cat === c.k)).map(c => [c.k, c.n])].map(([k, n]) => `<button class="segbtn" type="button" data-ff="${k}" aria-pressed="${fundFilter === k}">${n}</button>`).join('')}</div>
  <section class="card"><div class="rows">${list.map(f => `
    <a class="row" href="#fund-${f.code}">
      <div class="t">${dot(f.cat)}<span class="ell">${esc(f.short || f.name)}</span>${f.pick ? '<span class="tag pick">推荐</span>' : ''}</div>
      <div class="r"><div class="v n">${f.score} 分</div></div>
      <div class="s n">${f.code} · ${CAT[f.cat].n} · 同类第 ${f.rank}/${f.peers}${totalFee(f) != null ? ` · 年费率 ${totalFee(f)}%` : ''}</div>
      <div class="s rt">评分</div>
    </a>`).join('')}</div></section>
  <p class="note">评分是同一类基金之间的相对打分（同类第一不一定很好，最后一名也不一定差），只看费率、规模、长期收益和回撤，不看最近涨了多少。过去涨得多，不代表以后还会涨，也不是多买的理由。数据截至 ${esc(DATA.updated)}，点进基金可以看收益、回撤和盘中实时估值。</p>
  </div>`;
}

function viewFund(code, A) {
  const f = FUND[code]; if (!f) return `<div class="view"><button class="back" type="button" data-back>‹ 返回</button><p>没有找到这只基金。</p></div>`;
  const c = CAT[f.cat], sig = sigOf(f.cat, f), hold = A.advice.find(x => x.code === code);
  const peers = FUNDS.filter(x => groupOf(x) === groupOf(f)).sort((a, b) => a.rank - b.rank);
  const parts = Object.keys(W[f.cat]).map(k => `<div class="part"><span class="muted">${MNAME[k]}</span>${scoreBar(Math.round(f.parts[k] * 100), `var(--s-${f.cat})`)}</div>`).join('');
  return `<div class="view">
  <button class="back" type="button" data-back>‹ 返回</button>
  <section class="card">
    <div class="fhead">
      <div class="fname"><h2>${esc(f.name || f.short)}</h2><div class="sub n">${f.code} · ${c.n}${f.index ? ' · 跟踪' + esc(f.index) : ''}${f.manager ? ' · 经理 ' + esc(f.manager) : ''}</div>
        <div class="chiprow">${f.pick ? '<span class="tag pick">推荐组合</span>' : '<span class="tag">备选</span>'}<span class="tag">评分 ${f.score} · 同类第 ${f.rank}/${f.peers}</span>${trendOn() && hold && !hold.notHeld && f.cat !== 'bond' && trendOf(f) === 'up' ? '<span class="tag" data-tip="趋势规则只影响卖出时机，不是买入信号">涨势还在 · 晚一点卖</span>' : ''}${hold ? actChip(hold.adv) : ''}</div></div>
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
    ${c.eq ? `<p class="note">近 3 年的收益只代表过去这一段${f.cat === 'overseas' ? '（美股这几年涨得特别多）' : ''}，不代表以后。涨得多不是多买的理由：${CAT[f.cat].n}在组合里的比例是固定的（现在目标 ${A.T[f.cat]}%）。历史上的大熊市里，这一类跌过约 ${c.dd}%。</p>` : ''}
    <div class="btnrow">
      <a class="btn" href="https://fund.eastmoney.com/${f.code}.html" target="_blank" rel="noopener">在天天基金查看 ↗</a>
      <button class="btn ghost" type="button" data-copy="${f.code}">复制代码，去支付宝搜</button>
      ${AIS.key ? `<button class="btn ghost" type="button" data-ai="fund" data-code="${f.code}">问 AI 这只基金</button>` : ''}
    </div>
    <div id="ai-fund" class="ai-text" hidden></div>
    <p class="note">收益和回撤按复权净值计算（分红算作再投资，口径接近支付宝，可能略有差异），截至 ${esc(cnDate(f.retDate) || '—')}；规模截至 ${esc(f.scaleDate || '—')}。</p>
  </section>
  ${f.curve && f.curve.length > 2 ? `<section class="card"><div class="card-h"><h3>近3年走势（复权净值）</h3><span class="sub">按周</span></div>${lineChart('nav', f.curve, { label: '近3年复权净值走势（看相对涨跌，数值和支付宝的单位净值不同）', fmtX: s => s.slice(0, 7), fmtTip: p => `${cnDate(p[0])}：${p[1].toFixed(4)}`, color: `var(--s-${f.cat})` })}</section>` : ''}
  <div class="grid2">
    <section class="card"><div class="card-h"><h3>我的判断</h3>${f.pick ? '<span class="tag pick">入选理由</span>' : '<span class="tag">备选</span>'}</div>
      <div class="thesis"><div><b>为什么${f.pick ? '选它' : '看它'}</b><span>${esc(f.why || '—')}</span></div><div><b>主要风险</b><span>${esc(f.risk || '—')}</span></div><div><b>什么时候卖</b><span>${esc(f.exit || '—')}</span></div></div>
      ${f.notes ? `<p class="note">公告提示：${esc(f.notes)}</p>` : ''}
    </section>
    <section class="card"><div class="card-h"><h3>现在该怎么做</h3>${hold ? actChip(hold.adv) : sigChip(sig)}</div>
      ${hold ? `<div class="why">${hold.adv.why.map(w => `<span>${esc(w)}</span>`).join('')}</div>${hold.adv.amt ? `<div class="bigamt">${amtLine(hold.adv)}</div>` : ''}`
        : `<p>你没有持有它，它也不在推荐组合里。${sig.top ? '现在估值很贵，不建议买。' : '要买同类的话，优先买推荐的那只。'}</p>`}
      ${f.cat === 'index' || f.cat === 'active' ? (() => { const own = f.cat === 'index' && f.val && SIGV[f.val] && M[f.val] ? M[f.val].pePct10y : idxPct; return `<div class="temp"><span>${esc(valText(f.cat, f))}</span>${sigChip(sig)}</div>${gaugeHTML(own)}`; })() : f.cat === 'div' ? `<div class="temp"><span>息差 ${spread == null ? '—' : spread.toFixed(2) + ' 个点'}</span>${sigChip(sig)}</div>` : f.cat === 'overseas' ? `<div class="temp"><span>${valText('overseas', f)}</span>${sigChip(sig)}</div>${gaugeHTML(M[f.val] && M[f.val].pePct10y)}` : ''}
      ${f.buyCap >= BIG_CAP ? `<p class="note">每天最多买 ${fmt(f.buyCap)}，正常定投不受影响。</p>` : tightCap(f) ? `<p class="note">限购：每天最多买 ${fmt(f.buyCap)}（天天基金，${esc(f.feeDate || '')} 查到），一个月大约最多 ${fmt(monthCap(f))}，买不进去的钱这个月转去买其他缺的类别。支付宝里的额度可能和这里不一样，以支付宝显示为准。${(A.capTotal[f.code] || 0) >= 1 ? `本月：<b>${A.capTotal[f.code] <= f.buyCap ? `一次买 ${fmt(A.capTotal[f.code])} 就行` : buyHow(f, A.capTotal[f.code])}</b>。` : ''}</p>${DAILY_HOWTO}` : f.buyStatus === '暂停申购' ? '<p class="note">这只现在暂停申购，买不了。等基金公司恢复，每天的数据更新会自动发现。</p>' : ''}
    </section>
  </div>
  <div class="grid2">
    <section class="card"><div class="card-h"><h3>逐年收益</h3><span class="sub">红涨绿跌</span></div>${yearBars(f.yearRets)}</section>
    <section class="card"><div class="card-h"><h3>评分拆解</h3><span class="n strong">${f.score} 分</span></div>${parts}${f.missing.length ? `<p class="note">缺少数据：${f.missing.join('、')}，这几项按中间分计；缺费率、收益或回撤时，不会建议你换基。</p>` : ''}</section>
  </div>
  <section class="card"><div class="card-h"><h3>同类对比</h3><span class="sub">${f.cat === 'overseas' ? (f.index || c.n) : c.n}</span></div>
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

const catOptions = sel => C.cats.map(c => `<option value="${c.k}" ${c.k === sel ? 'selected' : ''}>${c.n}${c.k === 'active' ? '（含行业主题）' : ''}</option>`).join('');
/* 按基金名称猜类别，猜不准时用户可以改 */
function guessCat(name) {
  const n = name || '';
  if (/货币|现金|余额|天天利|宝$/.test(n)) return 'cash';
  if (/标普|纳斯达克|纳指|道琼斯|美国|全球|QDII|海外|恒生|港股|日经|德国|法国|越南|印度/.test(n)) return 'overseas';
  if (/红利|股息|高息/.test(n)) return 'div';
  if (/债|利率|信用|同业存单|政金/.test(n) && !/可转债|转债/.test(n)) return 'bond';
  if (/沪深300|中证500|中证1000|A500|中证800|上证50|创业板|科创50|中证全指|宽基|MSCI中国/.test(n) && /指数|ETF|联接/.test(n)) return 'index';
  return 'active';
}
/* 用基金代码查名称：先试天天基金实时估值接口，货币基金等没有估值的再试净值数据接口 */
let lookupQueue = Promise.resolve();
function loadScript(src, ms) {
  return new Promise(resolve => { const s = document.createElement('script'); let done = false; const fin = ok => { if (done) return; done = true; s.remove(); resolve(ok); };
    s.onload = () => fin(true); s.onerror = () => fin(false); setTimeout(() => fin(false), ms || 8000); s.src = src; document.head.appendChild(s); });
}
function lookupFund(code) {
  const run = async () => {
    const live = await fetchLive(code);
    if (live && live.name) return { code, name: live.name };
    window.fS_name = undefined; window.fS_code = undefined;
    const ok = await loadScript(`https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`, 10000);
    if (ok && window.fS_code === code && window.fS_name) return { code, name: String(window.fS_name) };
    return null;
  };
  lookupQueue = lookupQueue.then(run, run);
  return lookupQueue;
}
/* 持仓、测评、偏好都做成“清单 + 编辑/删除”：平时只读、收起来，改动只有点“保存”才生效 */
let resWarn = 0, resEdit = false, holdEdit = null, holdDel = null, holdOpen = false, meEdit = null, prefsOpen = false, savedMsg = {};
/* 草稿：编辑到一半切去别的页面，回来时填过的内容还在，直到点“保存”或“取消” */
let DRAFT = {};
const DRAFT_SEL = '#res-amt,#hold-list .editing input,#code-result input,#code-result select,#code-input,#pname,#quiz input,#prefs-form input,#prefs-form select';
document.addEventListener('input', e => { const el = e.target; if (!el.id || !el.matches || !el.matches(DRAFT_SEL)) return;
  if (el.type === 'radio') document.querySelectorAll(`input[name="${el.name}"]`).forEach(r => { DRAFT[r.id] = r.checked; });
  else DRAFT[el.id] = el.type === 'checkbox' ? el.checked : el.value; });
document.addEventListener('change', e => { const el = e.target; if (el.type === 'radio' || el.type === 'checkbox' || el.tagName === 'SELECT') el.dispatchEvent(new Event('input', { bubbles: true })); });
function restoreDrafts() { Object.entries(DRAFT).forEach(([id, v]) => { const el = document.getElementById(id); if (!el || !el.matches(DRAFT_SEL)) return; if (typeof v === 'boolean') el.checked = v; else el.value = v; }); }
const dropDraft = (...pre) => { Object.keys(DRAFT).forEach(k => { if (pre.some(p => k.startsWith(p))) delete DRAFT[k]; }); };
const unsavedTag = '<span class="tag warn">还没保存</span>';
const realCount = () => P.example ? 0 : P.items.length;
const stamp = k => { savedMsg[k] = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }); };
const savedTag = k => storageOk ? `<span class="sync ok">${savedMsg[k] ? '已保存 ' + savedMsg[k] : '已保存在这台设备'}</span>` : '<span class="sync">无法保存：浏览器禁止了本地存储</span>';
function amountFields(pre, it) {
  return `<label class="field">金额（元）<input type="number" inputmode="decimal" id="${pre}-amt" value="${it && it.amount ? it.amount : ''}" placeholder="支付宝里的“金额”"></label>
    <label class="field">持有收益（元）<input type="number" inputmode="decimal" id="${pre}-pro" value="${it && it.profit ? it.profit : ''}" placeholder="亏损填负数，如 -350"></label>`;
}
function readAmounts(pre) {
  const ai = $('#' + pre + '-amt'), pi = $('#' + pre + '-pro');
  for (const el of [ai, pi]) if (el.validity && el.validity.badInput) { toast('只能填数字，不要加逗号或“元”'); el.focus(); return null; }
  const amount = ai.value.trim() === '' ? NaN : Number(ai.value), profit = pi.value.trim() === '' ? 0 : Number(pi.value);
  if (!isFinite(amount) || amount <= 0) { toast('金额要填大于 0 的数字'); ai.focus(); return null; }
  if (!isFinite(profit)) { toast('持有收益要填数字，亏损填负数'); pi.focus(); return null; }
  if (profit >= amount) { toast('持有收益不会比现在的金额还多，核对一下'); pi.focus(); return null; }
  return { amount: Math.round(amount * 100) / 100, profit: Math.round(profit * 100) / 100 };
}
let found = null;
function showFound() {
  const box = $('#code-result'); if (!box) return;
  if (!found) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  if (found.state === 'busy') { box.innerHTML = `<p class="note">正在查找 ${esc(found.code)}…</p>`; return; }
  if (found.state === 'none') { box.innerHTML = `<p class="note">没有找到代码 ${esc(found.code)} 的基金。核对一下是不是 6 位数字；网络不好时可以过一会再试。</p>`; return; }
  const f = FUND[found.code];
  box.innerHTML = `<div class="found">
    <div class="nm">${dot(found.cat)} <b>${esc(found.name)}</b><span class="sub n">${/^\d{6}$/.test(found.code) ? esc(found.code) + ' · ' : ''}${f ? (f.pick ? '在 5 只推荐组合里' : '不在 5 只组合里（备选）') : '不在选基名单里'}</span></div>
    ${f ? '' : `<label class="field">属于哪一类（按名称猜的，不对就改）<select id="found-cat">${catOptions(found.cat)}</select></label>
    <p class="note">名单外的基金，系统看不到它的费率和回撤，只能按类别给建议。</p>`}
    <div class="twocol">${amountFields('fa')}</div>
    <div class="btnrow"><button class="btn" type="button" id="found-add">保存到持仓</button><button class="btn ghost" type="button" id="found-cancel">取消</button></div></div>`;
}
async function findCode() {
  const inp = $('#code-input'); const code = (inp.value || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(code)) { toast('基金代码是 6 位数字'); inp.focus(); return; }
  if (!P.example && P.items.some(i => i.code === code)) { toast('这只已经在持仓里了，要改金额点它后面的“编辑”'); return; }
  dropDraft('fa-', 'found-');
  if (code === '000198') { toast('余额宝不算进组合。应急钱留在支付宝里就行，不用录进来'); return; }
  if (FUND[code]) { found = { code, name: FUND[code].name || FUND[code].short, cat: FUND[code].cat, state: 'ok' }; showFound(); $('#fa-amt')?.focus(); return; }
  found = { code, state: 'busy' }; showFound();
  const r = await lookupFund(code);
  if (!found || found.code !== code) return;
  found = r ? { code, name: r.name, cat: guessCat(r.name), state: 'ok' } : { code, state: 'none' };
  if (found.state === 'ok' && found.cat === 'cash') { found = null; showFound(); toast('这是货币基金（和余额宝一样），不算进组合。应急钱放着就行，不用录进来'); return; }
  showFound(); $('#fa-amt')?.focus();
}
function addFound() {
  if (!found || found.state !== 'ok') return;
  if (realCount() >= (C.maxFunds || 5)) { toast(`最多 ${C.maxFunds || 5} 只。先删掉一只再添加`); return; }
  if (!P.example && P.items.some(i => i.code === found.code)) { toast('这只已经在持仓里了'); return; }
  const v = readAmounts('fa'); if (!v) return;
  if (P.example) P.items = [];
  const f = FUND[found.code];
  P.items.push(f ? { code: found.code, amount: v.amount, profit: v.profit } : { code: found.code, name: found.name.slice(0, 40), cat: ($('#found-cat') || {}).value || found.cat, amount: v.amount, profit: v.profit });
  found = null; holdOpen = true; holdEdit = null; holdDel = null; dropDraft('fa-', 'found-', 'code-input');
  touchPortfolio(); stamp('hold'); render(true); toast(!storageOk ? '浏览器禁止了本地存储，刷新后会丢失' : P.monthPlan && P.monthPlan.ask ? '已保存到持仓。本月计划要不要重算，看页面顶部的提示' : '已保存到持仓');
}
function holdRow(it) {
  const f = FUND[it.code], c = esc(it.code), nm = f ? esc(f.short || f.name) : esc(it.name || '其他基金');
  const head = `<div class="nm"><span>${dot(f ? f.cat : CAT[it.cat] ? it.cat : 'active')} ${nm}</span><span class="sub n">${f ? f.code : (/^\d{6}$/.test(it.code) ? c + ' · ' : '') + '不在名单里 · ' + esc((CAT[it.cat] || CAT.active).n)}</span></div>`;
  if (holdEdit === it.code) return `<div class="hold-item editing">${head}${amountFields('he', it)}
    <div class="btnrow"><button class="btn sm" type="button" data-hold="save" data-code="${c}">保存</button><button class="btn sm ghost" type="button" data-hold="cancel">取消</button></div></div>`;
  return `<div class="hold-item ro">${head}<div class="hv n">${fmt(it.amount)}<span class="sub ${cls(it.profit)}">收益 ${signed(it.profit)}</span></div>
    <div class="btnrow">${P.example ? '' : holdDel === it.code
      ? `<button class="btn sm danger" type="button" data-hold="delok" data-code="${c}">确认删除</button><button class="btn sm ghost" type="button" data-hold="cancel">取消</button>`
      : `<button class="btn sm ghost" type="button" data-hold="edit" data-code="${c}" aria-label="编辑 ${nm}">编辑</button><button class="btn sm ghost" type="button" data-hold="del" data-code="${c}" aria-label="删除 ${nm}">删除</button>`}</div></div>`;
}
function holdAction(act, t) {
  const code = t.dataset.code, it = code && P.items.find(i => i.code === code);
  if (act === 'edit') { dropDraft('he-'); holdEdit = code; holdDel = null; holdOpen = true; render(true); $('#he-amt')?.focus(); }
  else if (act === 'del') { holdDel = code; holdEdit = null; render(true); }
  else if (act === 'resedit') { resEdit = true; render(true); $('#res-amt')?.focus(); }
  else if (act === 'rescancel') { resWarn = 0; resEdit = false; dropDraft('res-'); render(true); }
  else if (act === 'ressave') { const el = $('#res-amt'), v = el.value.trim() === '' ? 0 : Number(el.value);
    if ((el.validity && el.validity.badInput) || !isFinite(v) || v < 0) { toast('填 0 或正数，不要加逗号'); el.focus(); return; }
    const big = Math.max(3 * (+P.monthly || 0), 3000); if (v > big && resWarn !== Math.round(v)) { resWarn = Math.round(v); render(true); return; }
    resWarn = 0;
    P.reserve = Math.round(v); resEdit = false; dropDraft('res-'); unlockMonth(); save(); stamp('hold'); render(true); toast(storageOk ? '已保存' : '浏览器禁止了本地存储，刷新后会丢失'); }
  else if (act === 'cancel') { holdEdit = null; holdDel = null; dropDraft('he-'); render(true); }
  else if (act === 'save' && it) { const v = readAmounts('he'); if (!v) return; it.amount = v.amount; it.profit = v.profit; holdEdit = null; dropDraft('he-'); touchPortfolio(); stamp('hold'); render(true); toast(storageOk ? '已保存' : '浏览器禁止了本地存储，刷新后会丢失'); }
  else if (act === 'delok' && it) { P.items = P.items.filter(i => i !== it); holdDel = null; touchPortfolio(); stamp('hold'); render(true); toast('已删除'); }
}
function viewHoldings(A) {
  const max = C.maxFunds || 5, n = realCount(), full = n >= max;
  // 下拉只放组合会用到的类别（不放余额宝和主动基金）；名单外的基金用代码查找
  const opts = C.cats.filter(c => C.levels.some(l => l.target[c.k] > 0)).map(c => `<optgroup label="${c.n}">${FUNDS.filter(f => f.cat === c.k).sort((a, b) => (b.pick ? 1 : 0) - (a.pick ? 1 : 0)).map(f => `<option value="${f.code}">${esc(f.short || f.name)} ${f.code}${f.pick ? '（推荐）' : '（备选）'}</option>`).join('')}</optgroup>`).join('') + '<option value="__other">其他基金（不在名单里）</option>';
  const sum = P.items.reduce((a, i) => a + (+i.amount || 0), 0);
  return `<div class="view">
  <section class="card">
    <div class="card-h"><h3>${esc(P.name)}的持仓</h3>${P.example ? '<span class="tag">示例</span>' : holdEdit ? unsavedTag : savedTag('hold')}</div>
    <p class="note">打开支付宝 → 理财 → 基金 → 持有，把每只基金的“金额”和“持有收益”抄过来。每月定投后，点那只基金后面的“编辑”更新一次。最多 ${max} 只。</p>
    ${askBar(A)}
    ${CASH_NOTE.has(P) ? `<div class="banner"><span>余额宝不再算进组合，已经从持仓里移出（${fmt(CASH_NOTE.get(P).amt)}）。它是你的应急钱，留在支付宝里就行，不用卖。${CASH_NOTE.get(P).ledger ? '年化记账里已经自动记了一笔同样金额的“转出”，所以收益不会被算错。' : ''}</span></div>` : ''}
    ${P.example ? '<div class="banner"><span>下面是示例数据，不是你的。添加第一只自己的基金时，示例会自动清掉。</span><button class="btn sm ghost" type="button" data-clear>清空示例</button></div>' : ''}
    ${P.items.length ? `<details class="fold" id="hold-fold" ${holdOpen || holdEdit || holdDel ? 'open' : ''}><summary><span>持仓清单</span><span class="sub n">${P.example ? '示例 · ' : ''}${P.items.length > max ? `${P.items.length} 只（上限 ${max} 只）` : `${P.items.length}/${max} 只`} · 合计 ${fmt(sum)}</span></summary>
      <div id="hold-list">${P.items.map(holdRow).join('')}</div></details>` : '<p class="muted pad">还没有持仓，从下面添加第一只基金。</p>'}
    ${P.example ? '' : `<div class="resbox" id="res-box">${resEdit
      ? `<div class="field"><label for="res-amt">银行卡里等着投的钱（元）</label><div class="inline"><input id="res-amt" type="number" inputmode="decimal" min="0" value="${P.reserve || ''}" placeholder="没有就填 0"><button class="btn sm" type="button" data-hold="ressave">${resWarn ? '确认保存' : '保存'}</button><button class="btn sm ghost" type="button" data-hold="rescancel">取消</button></div></div>${resWarn ? `<div class="banner warn"><span>${fmt(resWarn)} 比较多：这笔钱会在接下来几个月陆续投进基金（每月最多一个月的定投额）。确认它是 3 年内不用、准备拿来投资的钱吗？生活费和应急钱（建议留 3–6 个月开支）不要填。确认就再点一次“确认保存”。</span></div>` : ''}`
      : `<div class="kvrow"><span class="muted">银行卡里等着投的钱</span><b class="n">${fmt(P.reserve || 0)}</b><button class="btn sm ghost" type="button" data-hold="resedit">编辑</button></div>`}
      <p class="note">估值贵少买、限购买不进、卖出后没地方买的钱。每月打卡“全部照做”时自动记在这里；攒得比较多时（超过持仓加这笔钱的 ${C.rules.reserveDeployPct || 5}%），系统每月投回一部分，一个月最多一个月的定投额。<b>只算准备拿来投资、3 年内不用的钱；生活费和应急钱（建议留 3–6 个月开支）不要算进来。</b></p></div>`}
  </section>
  <section class="card">
    <div class="card-h"><h3>添加基金</h3><span class="sub n">${P.example ? '示例不算' : n > max ? `${n} 只（上限 ${max} 只）` : `${n}/${max} 只`}</span></div>
    ${full ? `<p class="note">${n > max ? `现在有 ${n} 只，超过了 ${max} 只（可能是导入的旧数据）。“买卖分析”会告诉你合并哪只，合并完再删掉。` : `已经有 ${max} 只了，最多 ${max} 只。`}新手拿 5 只就够分散：沪深300、红利低波、标普500、纳指100、中短债。想换一只，先在上面的清单里删掉一只。</p>` : `
    <div class="addrow"><label class="field">输入基金代码（6 位数字，支付宝基金详情页名称下面那串数字）<input id="code-input" type="text" inputmode="numeric" maxlength="6" placeholder="比如 460300" autocomplete="off"></label><button class="btn" type="button" id="code-find">查找</button></div>
    <details class="pickfrom"><summary>或者从推荐名单里选</summary>
      <div class="addrow"><label class="field">选择基金<select id="add-code">${opts}</select></label><button class="btn ghost" type="button" id="add-btn">下一步</button></div>
      <div id="other-box" class="twocol" hidden>
        <label class="field">基金名称<input id="other-name" type="text" placeholder="比如 某某医药ETF联接" class="txt"></label>
        <label class="field">属于哪一类<select id="other-cat">${catOptions('active')}</select></label>
      </div>
    </details>
    <div id="code-result" hidden></div>`}
  </section>
  ${ledgerSection(A)}
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
    <div class="twocol">${meEdit === 'name'
      ? `<div class="field"><label for="pname">当前用户的名字</label><div class="inline"><input id="pname" type="text" class="txt" value="${esc(P.name)}" maxlength="12"><button class="btn sm" type="button" data-me="savename">保存</button><button class="btn sm ghost" type="button" data-me="cancel">取消</button></div></div>`
      : `<div class="field"><span>当前用户的名字</span><div class="kvrow"><b>${esc(P.name)}</b><button class="btn sm ghost" type="button" data-me="name">编辑</button></div></div>`}
      <div class="field"><span>&nbsp;</span>${Object.keys(STORE.profiles).length > 1 ? (delArm ? `<div class="btnrow"><button class="btn danger" type="button" data-deluser>确认删除“${esc(P.name)}”</button><button class="btn ghost" type="button" data-delcancel>取消</button></div>` : `<button class="btn ghost" type="button" data-delask>删除这个用户</button>`) : ''}</div></div>
  </section>

  <div class="grid2">
  <section class="card" id="me-quiz">
    <div class="card-h"><h3>风险测评</h3>${meEdit === 'quiz' ? unsavedTag : P.risk ? `<span class="tag pick">${C.levels[lv.base].n}型 · ${P.risk.score} 分</span>` : '<span class="tag">未测评</span>'}</div>
    ${lsGet('money.quizLater') && daysSince(lsGet('money.quizLater')) >= 7 && meEdit !== 'quiz' ? '<div class="banner"><span>一周前你想改测评。现在冷静下来还想改吗？想改就点“重新测评”如实答；不想改就点“不改了”。</span><div class="btnrow"><button class="btn sm ghost" type="button" data-quizlaterdone>不改了</button></div></div>' : ''}
    ${P.risk && meEdit !== 'quiz' ? `<p>你的结果：<b>${C.levels[lv.base].n}型</b>，${P.risk.score} 分（满分 20）${P.risk.at && !isNaN(Date.parse(P.risk.at)) ? `，${new Date(P.risk.at).toLocaleDateString('zh-CN')} 测评` : ''}。${savedTag('quiz')}</p>
    ${(() => { const okLoss = [5, 10, 20, 30][ans[1]]; if (okLoss == null || lv.short) return '';
      const loss = f => Math.round(C.cats.reduce((a2, c) => a2 + T[c.k] / 100 * (f[c.k] || 0), 0)), big = loss(STRESS[1].f), bear = loss(STRESS[2].f);
      return `<p class="note">你说一年里最多能接受亏 ${okLoss}%${okLoss >= 30 ? ' 以上' : ''}。按这个档位：几年一次的明显下跌，大约浮亏 ${big}%；遇到 2008 年那样的大熊市，大约浮亏 ${bear}%。${okLoss >= 30 || big <= okLoss ? '和你说的差不多，要做好心理准备。' : `明显下跌时就会超过你说的。如果真遇到会睡不着，${P.prefs.overseasPct ? '在“偏好”里把海外比例调回默认，或者' : ''}重新测评时第 2 题如实选，宁可少赚。`}</p>`; })()}
    <details class="fold"><summary><span>查看我的答案</span><span class="sub">${C.quiz.length} 题</span></summary>
      <ol class="answers">${C.quiz.map((q, qi) => `<li><span class="muted">${esc(q.q)}</span><b>${esc(q.a[ans[qi]] || '—')}</b></li>`).join('')}</ol></details>
    <div class="btnrow"><button class="btn ghost" type="button" data-me="quiz">重新测评</button><span class="note">收入、用钱计划变了再重做。重做会改变系统给你的比例。</span></div>`
    : `<form id="quiz" class="quiz">${C.quiz.map((q, qi) => `<fieldset><legend>${qi + 1}. ${esc(q.q)}</legend><div class="opts">${q.a.map((a, ai) => `<label class="opt"><input type="radio" name="q${qi}" id="q${qi}-${ai}" value="${ai}" ${ans[qi] === ai ? 'checked' : ''}><span>${esc(a)}</span></label>`).join('')}</div></fieldset>`).join('')}
      <div id="quiz-warn" class="banner warn quizwarn" hidden></div>
      <div class="btnrow"><button class="btn" type="submit">保存测评</button>${P.risk ? '<button class="btn ghost" type="button" data-me="cancel">取消</button>' : ''}<span class="note" id="quiz-msg"></span></div></form>`}
  </section>
  <div class="view">
  <section class="card">
    <div class="card-h"><h3>系统为你定的比例</h3><span class="tag pick">${lv.level.n}型</span></div>
    <div class="stack big" aria-hidden="true">${C.cats.filter(c => T[c.k] > 0).map(c => `<span style="flex:${T[c.k]};background:var(--s-${c.k})"></span>`).join('')}</div>
    <div class="legend">${C.cats.filter(c => T[c.k] > 0).map(c => `<div class="li">${dot(c.k)}<span>${c.n}</span><span class="n">${T[c.k]}%</span><span></span></div>`).join('')}</div>
    <p class="note">粗略估计：长期年化约 ${C.cats.reduce((a, c) => a + T[c.k] / 100 * c.ret, 0).toFixed(1)}%；遇到 2008 年那样的大熊市，最多可能浮亏约 ${Math.round(C.cats.reduce((a, c) => a + T[c.k] / 100 * c.dd, 0))}%。不是保证。</p>
  </section>
  <section class="card">
    <div class="card-h"><h3>系统学到的</h3><span class="sub">来自打卡和持仓记录</span></div>
    ${L.notes.length ? `<div class="rows">${L.notes.map(n => `<div class="row static"><div class="t"><span class="act ${n.k}">${n.k === 'sell' ? '已调整' : '提醒'}</span></div><div></div><div class="s why">${esc(n.t)}</div></div>`).join('')}</div>` : '<p class="muted">还没有发现需要调整的习惯。坚持每月打卡，系统会越来越了解你。</p>'}
  </section>
  </div>
  </div>

  <div class="grid2">
  <section class="card">
    <div class="card-h"><h3>偏好</h3>${meEdit === 'prefs' ? unsavedTag : savedTag('prefs')}</div>
    ${meEdit === 'prefs' ? prefsForm() : `${P.monthly ? '' : P.example ? `<div class="banner"><span>示例按每月 ${fmt(EXAMPLE_MONTHLY)} 算；填上你自己的金额后，按你的算。</span></div>` : '<div class="banner"><span>还没填每月定投金额，系统算不出每只买多少。点下面的“编辑偏好”填上。</span></div>'}
    <details class="fold" id="prefs-fold" ${prefsOpen ? 'open' : ''}><summary><span>我的偏好</span><span class="sub n">每月 ${P.monthly ? fmt(P.monthly) : '未填'} · ${P.prefs.day || 10} 号</span></summary>
      <dl class="kvlist">${prefRows().map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl></details>
    <div class="btnrow"><button class="btn ghost" type="button" data-me="prefs">编辑偏好</button></div>`}
    <div class="calrow" id="me-cal"><button class="btn ghost" type="button" data-cal>加到手机日历</button><span class="note">每月 ${P.prefs.day || 10} 号 9:30 提醒你定投，每年 1 月 15 日提醒一次年度体检。点按钮后：iPhone 和 iPad 选“添加全部”（如果文件先存进了“文件”App，就点开它再添加）；安卓手机打开下载好的文件，选“日历”。在微信里打不开的话，先用浏览器打开本页。${P.prefs.calDay ? `<br>上次加的是每月 ${P.prefs.calDay} 号${P.prefs.calDay !== (P.prefs.day || 10) ? '，和现在的定投日不一样：先在日历里删掉旧的“定投日”提醒，再点一次按钮。' : '。'}` : ''}</span></div>
  </section>
  <section class="card">
    <div class="card-h"><h3>执行记录</h3>${exec != null ? `<span class="tag ${exec >= 70 ? 'pick' : ''}">近 6 个月执行分 ${exec}</span>` : ''}</div>
    ${P.journal.length ? `<div class="rows">${P.journal.slice().reverse().slice(0, 12).map(j => `<div class="row static"><div class="t n">${esc(j.m.replace('-', ' 年 '))} 月</div><div class="r"><span class="act ${CHOICES[j.choice].s >= 60 ? 'hold' : CHOICES[j.choice].s ? 'wait' : 'sell'}">${esc(CHOICES[j.choice].t)}</span></div></div>`).join('')}</div>` : '<p class="muted">还没有记录。每月在看板上的“本月打卡”选一下就行。</p>'}
    <p class="note">执行分：全部照做 100，做了一部分 60，没操作 40，追涨或割肉 0。</p>
  </section>
  </div>

  <section class="card" id="me-backup">
    <div class="card-h"><h3>备份与换设备</h3><span class="sub">数据只存在这台设备的浏览器里</span></div>
    ${backupWarn(true)}
    <p class="note">换手机、换 iPad，或者清理浏览器之前，先导出一份。到新设备上导入，就能接着用。导出内容包括所有用户。</p>
    <div class="btnrow"><button class="btn" type="button" data-export>导出备份</button><button class="btn ghost" type="button" data-import>导入备份</button><input type="file" id="import-file" accept=".json,application/json" hidden></div>
    <textarea id="backup-text" class="backup" hidden readonly aria-label="备份内容"></textarea>
  </section>
  <details class="more-sec" id="me-more"><summary>高级设置：AI 助手（DeepSeek）</summary><div class="more-in">
  <section class="card" id="me-ai">
    <div class="card-h"><h3>AI 助手（DeepSeek）</h3>${AIS.key ? '<span class="tag pick">已设置</span>' : '<span class="tag">未设置</span>'}</div>
    <p class="note">到 platform.deepseek.com 注册 → API keys → 创建，把 key 粘贴到下面。key 只保存在这台设备的浏览器里，不会进备份文件，也不会上传到 GitHub。建议在 DeepSeek 后台设置用量上限。<b>不要把 key 发给任何人。</b></p>
    <div class="twocol">
      <label class="field">API key<input id="ai-key" type="password" class="txt" autocomplete="off" placeholder="${AIS.key ? '已保存（' + esc(AIS.key.slice(0, 5)) + '…），重新粘贴可替换' : 'sk-…'}"></label>
      <label class="field">模型<select id="ai-model">${C.ai.models.map(m => `<option value="${m.id}" ${AIS.model === m.id ? 'selected' : ''}>${esc(m.n)}</option>`).join('')}</select></label>
    </div>
    <label class="field">自动解读<select id="ai-auto">${[['change', '建议有变化或到定投日时（推荐）'], ['off', '关闭，只在我点按钮时解读']].map(([v, n]) => `<option value="${v}" ${AIS.auto === v ? 'selected' : ''}>${n}</option>`).join('')}</select><span>打开网站时检查：只有你的操作建议变了，或者到了每月定投日，才会让 AI 重新解读，不会天天发。自动解读时也会把持仓金额和建议发给 DeepSeek。</span></label>
    <p class="note">后台盯盘不需要这个 key 也能运行（用规则文字提醒）。想让盯盘提醒也由 AI 来写：打开 GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret，Name 填 <b>DEEPSEEK_API_KEY</b>，Secret 填同一个 key，保存。</p>
    <div class="btnrow"><button class="btn" type="button" data-ai="savekey">保存</button>${AIS.key ? '<button class="btn ghost" type="button" data-ai="testkey">测试连接</button><button class="btn ghost" type="button" data-ai="delkey">删除 key</button>' : ''}</div>
    <div id="ai-test" class="note" hidden></div>
  </section>
  </div></details>
  </div>`;
}
let delArm = false, resetArm = false, homeMore = false, quizWarn = '';
const MORE_OPEN = {};   // “更多/高级设置”展开过就保持展开，重新渲染不收起
/* 防丢数据：数据只在这台设备的浏览器里。iPhone 的 Safari 标签页一周不打开可能被清掉；隔一个月提醒导出一次备份 */
const LS_MEM = {};   // 浏览器不让存时，至少这次打开期间记住
const lsGet = k => { try { return localStorage.getItem(k) || LS_MEM[k] || ''; } catch (e) { return LS_MEM[k] || ''; } };
const lsSet = (k, v) => { LS_MEM[k] = v; try { localStorage.setItem(k, v); } catch (e) { /* 存不了就算了 */ } };
const iosTab = () => { const ua = navigator.userAgent || ''; const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  let sa = false; try { sa = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches; } catch (e) { sa = false; } return ios && !sa; };
const daysSince = d => /^\d{4}-\d{2}-\d{2}$/.test(d) ? Math.floor((Date.parse(today()) - Date.parse(d)) / 86400000) : Infinity;
/* 风险说明：第一次用时完整说一遍，点“我知道了”以后只在页面底部留一行 */
function riskNotice(A) {
  if (lsGet('money.riskAck')) return '';
  const T = A.T, eq = Math.round(C.cats.filter(c => c.eq).reduce((a, c) => a + T[c.k], 0)), bear = Math.round(C.cats.reduce((a, c) => a + T[c.k] / 100 * c.dd, 0));
  const items = currentLevel().short ? [
    '这不是理财产品，<b>不保本</b>。',
    '你选了“1 年内要用”，组合只放债券基金：波动小，但收益也低，长期大约 2%–3%，这时候不追求 5%–10%。',
    '这里的建议是固定规则算出来的参考，<b>不构成投资建议</b>，买不买、卖不卖由你自己决定。'
  ] : [
    '这不是理财产品，<b>不保本，也不保证收益</b>。',
    `你的组合里股票基金大约占 ${eq}%，长期估算年化约 ${A.expRet.toFixed(1)}%（只是估算）。有的年份会亏，股票越多越常见，大约每 3–4 年会遇到一次。`,
    `按目标比例算，遇到 2008 年那样的大熊市，可能浮亏约 ${bear}%，要一两年甚至更久才回来。`,
    '5%–10% 是拿 5 年以上的<b>平均</b>，不是每年都稳定这么多。',
    '这里的建议是固定规则算出来的参考，<b>不构成投资建议</b>，买不买、卖不卖由你自己决定。'
  ];
  return `<section class="card risk-card"><div class="card-h"><h3>先说清楚</h3></div>
    <ul class="calm-list">${items.map(t => `<li>${t}</li>`).join('')}</ul>
    <div class="btnrow"><button class="btn" type="button" data-riskack>我知道了</button></div></section>`;
}
const riskFoot = () => '<p class="note riskfoot">不保本 · 长期平均不是每年稳定 · 规则算出来的参考，不构成投资建议</p>';
const quizLaterBanner = () => lsGet('money.quizLater') && daysSince(lsGet('money.quizLater')) >= 7 ? '<div class="banner"><span>一周前你想改风险测评。现在还想改吗？</span><div class="btnrow"><a class="btn sm ghost" href="#me-quiz">去看看</a><button class="btn sm ghost" type="button" data-quizlaterdone>不改了</button></div></div>' : '';
const standalone = () => { try { return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches; } catch (e) { return false; } };
const importHint = () => P.example && standalone() && Object.keys(STORE.profiles).length === 1 && !lsGet('money.impHint') ? '<div class="banner"><span>从主屏幕打开的网站，和 Safari 里的数据是分开的。如果你之前在 Safari 里录过持仓，先在 Safari 里“导出备份”，再到这里导入。</span><div class="btnrow"><a class="btn sm" href="#me-backup">去导入备份</a><button class="btn sm ghost" type="button" data-imphint>我是第一次用</button></div></div>' : '';
function backupWarn(inMe) {
  const last = lsGet('money.exp'), age = daysSince(last), stale = age > 30;
  const first = (P.history[0] || {}).d || today(), waited = daysSince(first) >= (iosTab() ? 1 : 7);   // 刚开始录持仓时先不提醒
  if (!inMe && (P.example || !P.items.length || !waited || !(stale || iosTab()) || daysSince(lsGet('money.expSnooze')) < 7)) return '';
  const parts = [];
  if (iosTab()) parts.push('你是在 Safari 里打开的：一周不打开本网站，iPhone 可能会自动清掉这里的数据。从主屏幕打开更安全，但主屏幕上的和 Safari 里的数据是分开的，所以按这个顺序做：① 先点“导出备份” ② 再点“分享 → 添加到主屏幕” ③ 从主屏幕打开，到“我的 → 备份与换设备 → 导入备份”导入一次。');
  parts.push(last && /^\d{4}-\d{2}-\d{2}$/.test(last) ? `上次导出备份是 ${cnDate(last)}${stale ? `，已经 ${age} 天了，建议再导出一份` : ''}。` : '还没导出过备份。数据只在这台设备上，清理浏览器、换手机就没了。');
  if (inMe) return `<p class="note${stale || iosTab() ? ' warnline' : ''}">${parts.join('')}</p>`;
  return `<div class="banner warn"><span>${parts.join('')}</span><div class="btnrow"><button class="btn sm" type="button" data-export>导出备份（30 秒）</button><button class="btn sm ghost" type="button" data-snooze>以后再说</button></div></div>`;
}
const TREND_NOTE = () => { const tr = C.rules.trend; return `打开后，某类基金涨得多、占比超过目标时，系统会多等一等再卖（最多等到超出 ${tr.widen} 个点），很贵的时候也先不卖一部分，等涨势停了（价格跌回长期平均线以下）再按平常规则卖。贵到近 10 年最贵的 ${100 - tr.hardPct}% 那段时，照常卖。<br>好处：不会太早卖掉还在涨的。代价有两个：一是跌回来时，可能把赚到的一部分还回去；二是这段时间股票占比会比测评定的高，遇到大跌时亏得也更多。它不会让你多买任何东西。拿不准就别开。`; };
function prefRows() {
  const pr = P.prefs, short = currentLevel().short;
  return [
    ['每月定投金额', P.monthly ? fmt(P.monthly) : P.example ? `<span class="muted">还没填（示例按 ${fmt(EXAMPLE_MONTHLY)} 算）</span>` : '<span class="muted">还没填</span>'],
    ['每月定投日', `${pr.day || 10} 号`],
    ...(short ? [] : [['海外比例', pr.overseasPct ? pr.overseasPct + '%' : `按风险档位（现在 ${targets().overseas}%）`]]),
    ['趋势规则', pr.trend ? '<b>已打开</b>：涨势还在时晚一点卖' : '关闭（按估值和比例卖）'],
    ['不想碰的行业', (pr.avoid || []).length ? pr.avoid.map(esc).join('、') : '<span class="muted">没有</span>']
  ];
}
function prefsForm() {
  const pr = P.prefs, avoid = pr.avoid || [];
  return `<form id="prefs-form">
    <div class="twocol">
      <label class="field">每月定投金额（元）<input type="number" inputmode="decimal" id="pref-monthly" min="0" value="${P.monthly || ''}" placeholder="比如 2000"></label>
      <label class="field">每月几号定投（1–28）<input type="number" inputmode="numeric" id="pref-day" min="1" max="28" value="${pr.day || 10}"></label>
    </div>
    ${currentLevel().short ? '' : `<label class="field">海外比例（标普500 : 纳指100 = 7 : 3）<select id="pref-overseas">${[[0, `按风险档位（${currentLevel().level.target.overseas}%）`], [20, '20%'], [25, '25%（建议上限）']].map(([v, n]) => `<option value="${v}" ${(+pr.overseasPct || 0) === v ? 'selected' : ''}>${n}</option>`).join('')}</select><span>海外最多占股票类的 40%，档位低时会自动按上限算。</span></label>`}
    <label class="switch"><input type="checkbox" id="pref-trend" ${pr.trend ? 'checked' : ''}><span>趋势规则（可选，默认关）：涨势还在时，晚一点卖</span></label>
    <p class="note">${TREND_NOTE()}</p>
    <div class="field"><span>不想碰的行业（名单外的基金名字里有这些字，会建议卖出）</span><div class="opts wrap">${C.avoidOptions.map((a, ai) => `<label class="opt"><input type="checkbox" id="pref-av-${ai}" data-avoid="${esc(a)}" ${avoid.includes(a) ? 'checked' : ''}><span>${esc(a)}</span></label>`).join('')}</div></div>
    <div class="btnrow"><button class="btn" type="submit">保存偏好</button><button class="btn ghost" type="button" data-me="cancel">取消</button></div>
  </form>`;
}
function meAction(act) {
  if (act === 'name' || act === 'quiz' || act === 'prefs') { dropDraft('pname', 'q', 'pref-'); meEdit = act; render(true); if (act === 'name') $('#pname')?.select(); else document.getElementById(act === 'quiz' ? 'me-quiz' : 'prefs-form')?.scrollIntoView({ block: 'start' }); }
  else if (act === 'cancel') { meEdit = null; quizWarn = ''; dropDraft('pname', 'q', 'pref-'); render(true); }
  else if (act === 'savename') { P.name = ($('#pname').value || '').trim().slice(0, 12) || '我'; meEdit = null; dropDraft('pname'); save(); render(true); toast(storageOk ? '已保存' : '浏览器禁止了本地存储，刷新后会丢失'); }
}
function savePrefs() {
  for (const el of [$('#pref-monthly'), $('#pref-day')]) if (el.validity && el.validity.badInput) { toast('只能填数字，不要加逗号或“元”'); el.focus(); return; }
  const mv = $('#pref-monthly').value.trim(), m = mv === '' ? 0 : Number(mv);
  if (!isFinite(m) || m < 0) { toast('每月定投金额要填 0 或正数'); $('#pref-monthly').focus(); return; }
  const dv = Number($('#pref-day').value);
  if (!Number.isInteger(dv) || dv < 1 || dv > 28) { toast('定投日填 1 到 28 之间的整数'); $('#pref-day').focus(); return; }
  const oldDay = P.prefs.day || 10;
  P.monthly = Math.round(m * 100) / 100; P.prefs.day = dv;
  if ($('#pref-overseas')) P.prefs.overseasPct = +$('#pref-overseas').value || 0;
  P.prefs.trend = $('#pref-trend').checked;
  P.prefs.avoid = [...document.querySelectorAll('[data-avoid]:checked')].map(x => x.dataset.avoid);
  meEdit = null; prefsOpen = true; dropDraft('pref-'); unlockMonth(); save(); stamp('prefs'); render(true);
  toast(!storageOk ? '浏览器禁止了本地存储，刷新后会丢失' : oldDay !== dv && P.prefs.calDay ? '已保存。之前加过日历提醒：先在日历里删掉旧的“定投日”，再点一次“加到手机日历”' : '已保存');
}

/* ================= 下跌时的冷静助手 =================
 * 1. 压力测试：按你的真实持仓，算三种下跌情况下账户剩多少（跌之前就想清楚能不能扛住）
 * 2. 真跌的时候：推荐基金从近一年高点跌过提醒线，就用这只基金自己过去 3 年的真实净值，
 *    算出历史上跌这么多的次数、最深跌到多少、多久回到高点，再告诉你该做什么、不该做什么
 * 3. “我很想卖掉”：卖之前的冷静清单
 */
const DD_LINE = { bond: 3, index: 15, div: 15, overseas: 20, active: 20 };   // 和后台盯盘的提醒线一致
const STRESS = [
  { n: '小跌', d: '比较常见的回调', f: { index: 10, div: 7, overseas: 10, active: 12, bond: 0, cash: 0 } },
  { n: '大跌', d: '几年一次的明显下跌', f: { index: 25, div: 18, overseas: 25, active: 30, bond: 2, cash: 0 } },
  { n: '熊市', d: '十年一两次的大熊市，按各类历史上的大跌幅度', f: Object.fromEntries(C.cats.map(c => [c.k, c.dd])) }
];
function curvePoints(f) { return (f && Array.isArray(f.curve) ? f.curve : []).filter(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p[0]) && !isNaN(Date.parse(p[0])) && Number.isFinite(p[1]) && p[1] > 0); }
/* 更长的历史（常识，不来自本站数据）：大跌时给人一点底气，但不承诺多久回本 */
const LONG_HIST = {
  index: '沪深300 在 2008 年跌过约 70%，2015 年约 45%，2021–2024 年约 45%，每次之后都涨回来过，但有的要等好几年。下跌时坚持定投，买到的份额更便宜。',
  div: '红利类股票在 2008 年那样的大熊市里也跌过 40% 以上，之后靠分红和反弹慢慢回来。下跌时坚持定投，买到的份额更便宜。',
  overseas: '标普500 在 2008 年跌过约 55%，2022 年约 25%；纳指100 在 2000 年前后跌过约 80%，2022 年约 35%，之后都涨回来过，但 2000 年那次用了十几年。所以海外只占组合的一部分。',
  bond: '债券基金平时很少跌这么多，如果跌了要看看是不是持有的债券出了问题。'
};
/* 当前距近一年最高点的回撤 */
function currentDrawdown(f) {
  const c = curvePoints(f); if (c.length < 10) return null;
  const last = c[c.length - 1], from = new Date(Date.parse(last[0]) - 365 * 86400000).toISOString().slice(0, 10);
  const hi = Math.max(...c.filter(p => p[0] >= from).map(p => p[1]));
  return { dd: Math.round((last[1] / hi - 1) * 1000) / 10, date: last[0] };   // 和后台盯盘一样保留 1 位小数再比较
}
/* 过去 3 年里，跌幅超过 line% 的几段下跌：最深跌多少、多久回到原来的高点 */
function drawdownEpisodes(f, line) {
  const c = curvePoints(f), eps = []; if (c.length < 10) return eps;
  let peak = c[0], ep = null;
  for (const p of c) {
    if (p[1] >= peak[1]) { if (ep) { ep.recover = p[0]; eps.push(ep); ep = null; } peak = p; continue; }
    const dd = (p[1] / peak[1] - 1) * 100;
    if (!ep && dd <= -line) ep = { peak: peak[0], deepest: dd, bottom: p[0], recover: null };
    if (ep && dd < ep.deepest) { ep.deepest = dd; ep.bottom = p[0]; }
  }
  if (ep) eps.push(ep);
  return eps;
}
const monthsBetweenDates = (a, b) => Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / (30.44 * 86400000)));
function stressCard(A) {
  if (!A.total) return '';
  const rows = STRESS.map(s => { const loss = C.cats.reduce((a, c) => a + A.byCat[c.k] * (s.f[c.k] || 0) / 100, 0); return { s, loss, left: A.total - loss, pct: loss / A.total * 100 }; });
  const bear = rows[rows.length - 1];
  const lossCell = r => r.loss < 1 ? '几乎不亏' : `−${fmt(r.loss)}（${r.pct.toFixed(0)}%）`;
  const advice = A.eqW < 10 ? '你的持仓基本没有股票类，大跌影响很小。'
    : `熊市时，账户可能从 ${fmt(A.total)} 跌到大约 ${fmt(bear.left)}。现在就想一想：看到这个数字，你会不会想全部卖掉？如果会，说明现在的配置对你太激进了，到“我的 → 风险测评”里如实重做一次，系统会降低股票比例。宁可少赚一点，也不要在最低点卖出。`;
  return `<section class="card" id="sec-stress">
    <div class="card-h"><h3>压力测试：大跌时你会怎样</h3><span class="sub">按你现在的持仓</span></div>
    <div class="tbox"><table><thead><tr><th>情况</th><th class="r">可能亏</th><th class="r">账户剩</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td><b>${r.s.n}</b><div class="sub">${r.s.d}</div></td><td class="r ${r.loss >= 1 ? 'down' : ''}">${lossCell(r)}</td><td class="r">${fmt(r.left)}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="note">${P.example ? '这是示例持仓的结果。' : ''}${advice}</p>
    <p class="note">这些跌幅是按各类基金历史上常见的下跌估算的，不是预测；真实的下跌可能更小，也可能更大。</p>
  </section>`;
}
function calmAlerts(A) {
  const held = new Set(A.items.map(i => i.code));
  return FUNDS.filter(f => (held.has(f.code) || (f.pick && A.T[f.cat] > 0 && !(P.prefs.noActive && f.cat === 'active'))) && DD_LINE[f.cat]).map(f => ({ f, cur: currentDrawdown(f), held: held.has(f.code), adv: (A.advice.find(x => x.code === f.code) || {}).adv }))
    .filter(x => x.cur && x.cur.dd <= -DD_LINE[x.f.cat]).sort((a, b) => (b.held - a.held) || (a.cur.dd - b.cur.dd));
}
/* 一只正在下跌的基金：历史记录 + 该做什么（和规则引擎的建议保持一致） */
function calmFund(x, A) {
  const f = x.f, line = DD_LINE[f.cat], name = esc(f.short || f.name);
  const c = curvePoints(f), years = c.length ? Math.max(1, Math.round((Date.parse(c[c.length - 1][0]) - Date.parse(c[0][0])) / (365.25 * 86400000))) : 0;
  const eps = drawdownEpisodes(f, line), done = eps.filter(e => e.recover), ongoing = eps.find(e => !e.recover);
  let hist;
  if (!done.length) hist = `过去 ${years} 年的数据里，${name}还没有过跌超 ${line}% 又涨回来的完整记录。看更长的历史：${LONG_HIST[f.cat] || '大跌在长期投资里很常见，坚持定投的人最后多数都回来了。'}`;
  else {
    const ms = done.map(e => monthsBetweenDates(e.peak, e.recover));
    hist = done.length === 1 ? `过去 ${years} 年里，${name}有 1 次跌超 ${line}%（最深 ${Math.abs(done[0].deepest).toFixed(0)}%），从开始下跌到回到高点用了约 ${ms[0]} 个月。`
      : `过去 ${years} 年里，${name}有 ${done.length} 次跌超 ${line}% 后又回到了原来的高点：最深一次跌了 ${Math.abs(Math.min(...done.map(e => e.deepest))).toFixed(0)}%，回到高点最快 ${Math.min(...ms)} 个月、最慢 ${Math.max(...ms)} 个月。`;
    hist += ' 过去回得来，不代表这次也一定按同样的时间回来。';
  }
  if (ongoing && done.length && ongoing.deepest < Math.min(...done.map(e => e.deepest))) hist += ' <b>这次已经比它过去任何一次都跌得深，风险是真实的；正因为这样，更要按比例分批，不要加码，也不要一次卖光。</b>';
  const short = currentLevel().short, a = x.adv;
  let todo;
  const ruleSells = x.held && a && (a.k === 'sell' || a.k === 'swap');
  if (!x.held) todo = [`你还没买，按定投计划买就行${sigOf(f.cat, f).top ? '（现在估值很贵，计划里只买平时的一半）' : ''}。`];
  else if (ruleSells) {
    todo = [`<b>该做的：</b>按“本月要做的事”${/分批/.test(a.t) ? esc(a.t) : '分批' + esc(a.t)}。这是配置或规则的原因，不是因为下跌，也不是恐慌卖出；分 ${C.rules.sellMonths} 个月做完，不一次卖光。`, '<b>不该做的：</b>因为害怕而一次性全卖、停掉其他基金的定投、每天看好几次。'];
    if (f.cat === 'bond') todo.push('另外，债券基金很少跌这么多，可能是持有的债券出了问题（信用风险）。去基金详情看看最新公告和经理有没有变化。');
  }
  else if (f.cat === 'bond') todo = ['债券基金很少跌这么多，可能是持有的债券出了问题（信用风险），这和股票基金的正常波动不一样。', '这个月先暂停加仓，去基金详情看最新公告和经理有没有变化；拿不准就先不动，等下个月数据。不要一次性全卖。'];
  else if (a && a.k === 'stop') todo = ['<b>该做的：</b>按“本月要做的事”暂停买入、拿着不动。这是因为估值，不是因为下跌。', '<b>不该做的：</b>因为害怕而卖出、停掉其他基金的定投、每天看好几次。'];
  else { const sig = sigOf(f.cat, f); todo = [`<b>该做的：</b>按“本月定投计划”照常买。${sig.m > 1 ? `现在估值${sig.t}，规则已经让你多买（${sig.m} 倍），跌下来的时候买到的份额更多。` : '规则会根据估值自动调整买多少，不用自己加减。'}`, '<b>不该做的：</b>割肉卖出、停止定投、每天打开看好几次。在低点卖掉，等于把账面亏损变成真亏。'];
    if (!short) todo.push('<b>可以做的：</b>关掉网页，下个定投日再打开。想清楚这笔钱 5 年内不用，就不必理会这段下跌。'); }
  return { hist, todo, ongoing, ruleSells };
}
function calmCard(A, compact) {
  const al = calmAlerts(A), heldAl = al.filter(x => x.held);
  if (compact) {
    if (!heldAl.length) return '';
    const x = heldAl[0], cf = calmFund(x, A);
    return `<section class="card calm-card span2" aria-label="下跌时的冷静助手">
      <div class="card-h"><h3>正在下跌，先别慌</h3><a class="more" href="#analysis-calm">看详情 ›</a></div>
      <p><b>${esc(x.f.short || x.f.name)}</b> 从近一年高点跌了 <b class="n">${Math.abs(x.cur.dd).toFixed(1)}%</b>${heldAl.length > 1 ? `，你持有的另外 ${heldAl.length - 1} 只也跌过了提醒线` : ''}。</p>
      <p class="note">${cf.todo[0]}${x.f.cat === 'bond' && cf.ruleSells ? ' 另外，债券基金很少跌这么多，可能有信用风险，看详情。' : ''}</p></section>`;
  }
  if (!al.length) return '';
  const firstHeld = heldAl[0];
  return `<section class="card calm-card" id="sec-calm">
    <div class="card-h"><h3>下跌时的冷静助手</h3><span class="sub">用真实净值算</span></div>
    ${(() => { const seen = new Set(); return al.map(x => { const cf = calmFund(x, A), todo = cf.todo.filter(t => !seen.has(t)); todo.forEach(t => seen.add(t)); const lh = LONG_HIST[x.f.cat] || '', hist = lh && seen.has(lh) ? cf.hist.replace('看更长的历史：' + lh, '更长的历史见上面。') : cf.hist; if (lh) seen.add(lh); return `<div class="calm-fund">
      <a class="row" href="#fund-${x.f.code}"><div class="t">${dot(x.f.cat)}<span class="ell">${esc(x.f.short || x.f.name)}</span>${x.held ? '' : '<span class="tag">未持有</span>'}</div><div class="r n down strong">−${Math.abs(x.cur.dd).toFixed(1)}%</div><div class="s">从近一年最高点算，截至 ${fullDate(x.cur.date)}（提醒线 ${DD_LINE[x.f.cat]}%）</div></a>
      ${hist ? `<p class="note">${hist}</p>` : ''}
      ${todo.length ? `<ul class="calm-list">${todo.map(t => `<li>${t}</li>`).join('')}</ul>` : '<p class="note">该怎么做同上。</p>'}</div>`; }).join(''); })()}
    <p class="note">${al.some(x => calmFund(x, A).ruleSells) ? '按规则分批卖这一部分没问题；要避免的是因为害怕把剩下的也一次卖光。' : '真正决定结果的，是你能不能在下跌时继续按计划执行、不在低点卖出。'}</p>
    ${firstHeld ? `<button class="btn ghost" type="button" data-calm="want" data-code="${firstHeld.f.code}">我很想卖掉</button><div id="calm-check" hidden></div>` : ''}
  </section>`;
}
function calmChecklist(A, code) {
  const it = A.items.find(i => i.code === code); if (!it) return '';
  const name = esc(it.fund ? it.fund.short || it.fund.name : it.name), loss = Math.min(0, it.profit);
  const adv = (A.advice.find(x => x.code === code) || {}).adv;
  const ruleSell = adv && (adv.k === 'sell' || adv.k === 'swap') && adv.amt ? `<p class="calm-rule">规则这个月本来就让你${esc(adv.t)} ${fmt(adv.amt)}，照做没问题；下面的问题是给“想全部卖掉”的时候用的。</p>` : '';
  const q1 = it.cat === 'bond' ? '这笔钱 3 年内要用吗？债券基金平时波动不大，这次跌得多，先看公告；要用的话，到“我的 → 风险测评”重做，系统会调整配置，按需分批取，不用一次全卖。'
    : `这笔钱 3 年内要用吗？不用的话，现在的下跌和你没有关系；要用的话，这笔钱本就不该放在股票基金里：到“我的 → 风险测评”重做，系统会分 ${C.rules.sellMonths} 个月转到债券基金。`;
  return `<div class="checklist">
    ${ruleSell}<p><b>卖掉${name}之前，先回答 3 个问题：</b></p>
    <ol><li>${q1}</li>
      <li>买它的理由变了吗？（看基金详情里的“我的判断”）理由没变，就不该因为价格下跌而卖。</li>
      <li>如果再跌 10%，你会更想卖还是更想买？如果是更想卖，问题在配置太激进，而不在这只基金。</li></ol>
    ${loss < 0 ? `<p>现在卖掉，等于把 <b class="down">${fmt(-loss)}</b> 的账面亏损变成真亏；如果以后涨回来，也和你没关系了。</p>` : '<p>这只现在还没亏，但卖掉就错过了以后便宜价位的定投。</p>'}
    <p><b>建议：先等 24 小时。</b>只是这几天害怕，就先不动。是真的承受不了这种波动、睡不着觉，再去“我的 → 风险测评”如实重做，系统会分批调整，比一次性卖光好。只是要用其中一部分钱，就直接在支付宝卖这一部分，再去“持仓”改金额，不用改测评。</p>
    <p class="note">如果最后还是卖了，记得在看板上“本月打卡”如实选“跌了，我卖了”，系统会据此调整你的配置。</p></div>`;
}
/* ================= 定投日历提醒 =================
 * 生成一个 .ics 日历文件：每月定投日 9:30 提醒，每年 1 月一次年度体检。手机日历打开就能添加，不需要账号。
 */
function icsText(day) {
  const pad = n => String(n).padStart(2, '0'), now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  // 从下一个定投日开始
  let first = new Date(now.getFullYear(), now.getMonth(), day); if (first < new Date(now.getFullYear(), now.getMonth(), now.getDate())) first = new Date(now.getFullYear(), now.getMonth() + 1, day);
  const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const url = location.href.split('#')[0];
  const fold = line => { const out = []; let cur = ''; for (const ch of line) { if (new TextEncoder().encode(cur + ch).length > 73) { out.push(cur); cur = ' ' + ch; } else cur += ch; } out.push(cur); return out.join('\r\n'); };
  const ev = (uid, start, rule, title, desc, link) => ['BEGIN:VEVENT', `UID:${uid}@money-dashboard`, `DTSTAMP:${stamp}`, `DTSTART;TZID=Asia/Shanghai:${start}T093000`, `DTEND;TZID=Asia/Shanghai:${start}T094500`, `RRULE:${rule}`,
    `SUMMARY:${title}`, `DESCRIPTION:${desc.replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, '\\n')}`, `URL:${link}`, 'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${title}`, 'TRIGGER:-PT0M', 'END:VALARM', 'END:VEVENT'];
  const nextJan = new Date(now.getFullYear() + (now.getMonth() === 0 && now.getDate() <= 15 ? 0 : 1), 0, 15);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//money-dashboard//CN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:稳健基金',
    'BEGIN:VTIMEZONE', 'TZID:Asia/Shanghai', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0800', 'TZOFFSETTO:+0800', 'TZNAME:CST', 'END:STANDARD', 'END:VTIMEZONE',
    ...ev('monthly-invest-' + STORE.current, ymd(first), `FREQ=MONTHLY;BYMONTHDAY=${day}`, '定投日：打开稳健基金看板',
      `今天是每月定投日。\n1. 打开看板，看“本月要做的事”和“本月定投计划”\n2. 在支付宝按计划买入\n3. 回到看板：按计划一键记账、更新持仓、本月打卡\n涨了跌了都照计划买，不用看新闻。\n${url}#analysis`, url + '#analysis'),
    ...ev('yearly-checkup-' + STORE.current, ymd(nextJan), 'FREQ=YEARLY', '年度体检：稳健基金看板',
      `一年一次的检查，大约 15 分钟：\n1. 重新做一次风险测评（收入、用钱计划有没有变）\n2. 看“买卖分析”里有没有基金被标成“换成更好的”，拿不准就先不动\n3. 看看年化收益进度，和余额宝比一比\n4. 导出一份备份\n${url}#me`, url + '#me'),
    'END:VCALENDAR'];
  return lines.map(fold).join('\r\n') + '\r\n';
}
function downloadCalendar() {
  const day = Math.min(28, Math.max(1, +(P.prefs && P.prefs.day) || 10));
  const blob = new Blob([icsText(day)], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `money-invest-day${day}.ics`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  P.prefs.calDay = day; save(); render(true);
  toast('已生成日历文件，按页面上的步骤添加');
}

/* ================= 年化收益进度 =================
 * 只记“进出整个账户的钱”：从银行卡转进支付宝买基金记“转入”，卖出后转回银行卡记“转出”。
 * 基金之间换（卖一只、马上买另一只），钱没离开账户，不用记。
 * P.ledger = { start: 'YYYY-MM-DD', startValue: 起点那天的总资产, txns: [{ id, d, type: 'in'|'out', amt, plan? }] }
 * 年化用资金加权收益率（XIRR）：起点资产和每笔转入算投入，每笔转出和今天的总资产算收回。
 */
const GOAL = { lo: 5, hi: 10 };   // 你的目标：年化 5%–10%
function xirr(flows) {
  // flows: [{ t: 距起点的年数, v: 金额（投入为负，收回为正） }]
  if (!flows.some(f => f.v < 0) || !flows.some(f => f.v > 0)) return null;
  const npv = r => flows.reduce((a, f) => a + f.v / Math.pow(1 + r, f.t), 0);
  const bisect = (lo, hi) => { let fl = npv(lo); for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2, fm = npv(mid); if (Math.abs(fm) < 1e-9) return mid; if (fl * fm < 0) hi = mid; else { lo = mid; fl = fm; } } return (lo + hi) / 2; };
  // 在 ln(1+r) 上均匀扫描 −99.99% 到 +9900%，找出所有变号区间；有多个解时取最接近 0 的那个
  const roots = []; const N = 600, a0 = Math.log(0.0001), a1 = Math.log(100);
  let pr = Math.exp(a0) - 1, pv = npv(pr);
  for (let k = 1; k <= N; k++) {
    const r = Math.exp(a0 + (a1 - a0) * k / N) - 1, v = npv(r);
    if (isFinite(pv) && isFinite(v) && pv * v <= 0) roots.push(bisect(pr, r));
    pr = r; pv = v;
  }
  if (!roots.length) return null;
  return roots.sort((x, y) => Math.abs(x) - Math.abs(y))[0];
}
const dayNum = s => Math.floor(Date.parse(s + 'T00:00:00+08:00') / 86400000);
const fullDate = s => { const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}年${+m[2]}月${+m[3]}日` : ''; };
const pctN = (v, d = 1) => v == null || isNaN(v) ? '—' : Math.abs(v) < 0.5 * Math.pow(10, -d) ? (0).toFixed(d) + '%' : pct(v, d);
const LS_CACHE = new WeakMap();   // 同一次刷新里看板和记账页都要用，只算一次
function ledgerStats(A) {
  if (LS_CACHE.has(A)) return LS_CACHE.get(A);
  const r = ledgerStatsInner(A); LS_CACHE.set(A, r); return r;
}
function ledgerStatsInner(A) {
  const L = P.ledger; if (!L || !L.start) return null;
  const end = today(), days = dayNum(end) - dayNum(L.start);
  const txns = (L.txns || []).filter(t => t.d >= L.start && t.d <= end);
  const ins = txns.filter(t => t.type === 'in').reduce((a, t) => a + t.amt, 0);
  const outs = txns.filter(t => t.type === 'out').reduce((a, t) => a + t.amt, 0);
  const invested = L.startValue + ins - outs;            // 净投入
  const gain = A.total - invested;
  const flows = [{ t: 0, v: -L.startValue }].concat(txns.map(t => ({ t: (dayNum(t.d) - dayNum(L.start)) / 365, v: t.type === 'in' ? -t.amt : t.amt })), [{ t: days / 365, v: A.total }]);
  const r = days >= 90 ? xirr(flows) : null;
  // 同期如果全放余额宝：每笔钱按余额宝收益率复利到今天
  const cashRate = (CAT.cash && CAT.cash.ret || 1.3) / 100;
  const cashVal = flows.slice(0, -1).reduce((a, f) => a - f.v * Math.pow(1 + cashRate, days / 365 - f.t), 0);
  return { L, days, ins, outs, invested, gain, gainPct: invested > 0 ? gain / invested * 100 : null, irr: r == null ? null : r * 100, txns, cashVal };
}
function goalGauge(v) {
  const pos = x => Math.max(0, Math.min(100, x / 15 * 100));
  return `<div class="goal" role="img" aria-label="年化 ${v == null ? '未知' : v.toFixed(1) + '%'}，目标 5% 到 10%">
    <div class="goaltrack"><span class="band" style="left:${pos(GOAL.lo)}%;width:${pos(GOAL.hi) - pos(GOAL.lo)}%"></span>${v != null ? `<i class="gmark" style="left:${pos(v)}%"></i>` : ''}</div>
    <div class="glabels"><span>0%</span><span>绿色区域是目标 5%–10%</span><span>15%+</span></div></div>`;
}
function futureTable(monthly, start, exp) {
  const yrs = [5, 10];
  // 月收益率用 (1+年化)^(1/12)−1，和上面的年化同一口径
  const fv = (r, y) => { const m = Math.pow(1 + r / 100, 1 / 12) - 1, n = y * 12; return start * Math.pow(1 + m, n) + (m ? monthly * (Math.pow(1 + m, n) - 1) / m : monthly * n); };
  const rows = [['不顺的十年（2%）', 2], [`你的配置估算（${exp.toFixed(1)}%）`, exp], ['目标下沿（5%）', 5]];
  return `<div class="tbox"><table><thead><tr><th>假设年化</th>${yrs.map(y => `<th class="r">${y} 年后</th>`).join('')}</tr></thead><tbody>
    ${rows.map(([n, r]) => `<tr><td>${n}</td>${yrs.map(y => `<td class="r">${fmt(Math.round(fv(r, y) / 100) * 100)}</td>`).join('')}</tr>`).join('')}
    <tr><td class="muted">只存不投</td>${yrs.map(y => `<td class="r muted">${fmt(start + monthly * y * 12)}</td>`).join('')}</tr></tbody></table></div>`;
}
function goalCard(A) {
  const st = ledgerStats(A), lv = currentLevel(), exp = A.expRet;
  const expNote = lv.short ? `你选了“1 年内要用”，这笔钱只放债券基金，长期估算约 ${exp.toFixed(1)}%，达不到 5% 是正常的：短期要用的钱，安全比收益重要。`
    : exp < GOAL.lo ? `按你现在的“${lv.level.n}”配置，长期估算年化约 ${exp.toFixed(1)}%，低于 5% 的目标。想提高就要多配股票类基金，大跌时的浮亏也会比现在的约 ${Math.round(A.expDd)}% 更大。能接受的话，可以重新做风险测评。`
    : exp < GOAL.lo + 0.5 ? `按你现在的“${lv.level.n}”配置，长期估算年化约 ${exp.toFixed(1)}%，刚好在目标下沿，不顺的年份会低于 5%。遇到大熊市可能浮亏约 ${Math.round(A.expDd)}%。`
    : `按你现在的“${lv.level.n}”配置，长期估算年化约 ${exp.toFixed(1)}%，在 5%–10% 的目标里。代价是遇到大熊市可能浮亏约 ${Math.round(A.expDd)}%，要拿得住。`;
  let body;
  if (P.example) body = '<p class="note">录入真实持仓后，点“开始记录”，系统会从那天起算你的真实年化收益。</p>';
  else if (!st) body = `<p style="font-size:13px">想知道自己实际赚了年化多少？从今天开始记录：系统把今天的总资产 ${fmt(A.total)} 记为起点，以后每次从银行卡转钱进来、或者转回银行卡时记一笔就行。</p><div class="btnrow"><button class="btn" type="button" data-ledger="start" ${A.total > 0 ? '' : 'disabled'}>开始记录年化</button></div>${A.total > 0 ? '' : '<p class="note">先在“持仓”页填上金额。</p>'}`;
  else if (st.irr == null && st.days >= 90) body = `<div class="stats"><div class="stat"><span class="k">记账以来</span><span class="v n">${st.days} 天</span></div><div class="stat"><span class="k">累计收益</span><span class="v n ${cls(Math.round(st.gain))}">${signed(Math.round(st.gain))}</span></div><div class="stat"><span class="k">累计收益率</span><span class="v n ${cls(st.gainPct)}">${pctN(st.gainPct, 2)}</span></div></div>
      <p class="note">这段时间的进出记录比较特殊（比如中途转出了大部分钱，或者账户几乎清空），算不出有意义的年化，只看累计收益。如果是记错了，到“持仓 → 记账”里检查一下。</p>`;
  else if (st.irr == null) body = `<div class="stats"><div class="stat"><span class="k">记账以来</span><span class="v n">${st.days} 天</span></div><div class="stat"><span class="k">累计收益</span><span class="v n ${cls(Math.round(st.gain))}">${signed(Math.round(st.gain))}</span></div><div class="stat"><span class="k">累计收益率</span><span class="v n ${cls(st.gainPct)}">${pctN(st.gainPct, 2)}</span></div></div>
      <p class="note">记满 3 个月（还差 ${Math.max(0, 90 - st.days)} 天）才显示年化。时间太短，年化数字会被一两天的涨跌放大，没有参考意义。</p>`;
  else if (Math.abs(st.irr) > 40 || (st.gainPct != null && st.gainPct < -40)) body = `<div class="temp"><span>你的真实年化（从 ${fullDate(st.L.start)} 起）</span><span class="act wait">需要核对</span><span class="v n">${pctN(st.irr, 1)}</span><span class="sub">累计 ${signed(Math.round(st.gain))}</span></div>
      <p class="note">这个数字不太正常，多半是记账和持仓金额没对上：比如转入了钱没记，或者记了却没更新持仓。先到“持仓 → 记账”核对一下，再看年化。</p>`;
  else {
    const inGoal = st.irr >= GOAL.lo && st.irr <= GOAL.hi, above = st.irr > GOAL.hi;
    body = `<div class="temp"><span>你的真实年化（从 ${fullDate(st.L.start)} 起）</span><span class="act ${above ? 'wait' : 'hold'}">${inGoal ? '在目标里' : above ? '高于目标' : '暂时低于目标'}</span><span class="v n ${cls(st.irr)}">${pctN(st.irr, 1)}</span><span class="sub">累计 ${signed(Math.round(st.gain))}</span></div>
      <p class="note">“年化”相当于每年平均赚多少，已经考虑了钱是分批投进来的。</p>
      ${goalGauge(st.irr)}
      ${st.days >= 365 ? `<p class="note">同一段时间，如果这些钱全放余额宝，现在大约是 ${fmt(st.cashVal)}；你现在是 ${fmt(A.total)}，${A.total >= st.cashVal ? `多了 ${fmt(A.total - st.cashVal)}` : `少了 ${fmt(st.cashVal - A.total)}`}。</p>` : ''}
      <p class="note">${above ? '高于 10% 通常是碰上了好行情，不代表以后也这样。别因此加大股票比例，也别因为赚得多就加大每月金额或追买涨得多的基金。' : !inGoal ? (st.days < 730 ? '不到两年，低于目标很常见：股票类基金要经过一轮涨跌才能体现收益。这时候最不该做的是停投或卖出，坚持按计划定投。' : '两年以上仍低于目标。先看看有没有在大跌时停投或卖出，这是最常见的原因；配置没问题就继续按计划，别在低点卖掉。') : '在目标里，继续按计划执行。'}</p>`;
  }
  return `<section class="card span2" aria-label="年化目标">
    <div class="card-h"><h3>年化目标 5%–10%</h3>${st ? '<a class="more" href="#holdings-ledger">记账 ›</a>' : ''}</div>
    ${body}
    <p class="note">${expNote}</p>
    <details class="pickfrom"><summary>按每月 ${fmt(A.monthly)} 定投，以后大概有多少</summary>${futureTable(A.monthly, A.total, exp)}<p class="note">按现在总资产 ${fmt(A.total)} 加上每月定投估算。这些都不是承诺：坏的年份可能亏 20% 以上，碰上不顺的十年，年化可能只有 2% 左右。</p></details>
  </section>`;
}
function ledgerSection(A) {
  const st = ledgerStats(A);
  if (P.example) return '';
  if (!st) return `<section class="card" id="sec-ledger"><h3>记账（用来算年化）</h3><p class="note">还没开始记录。到“看板 → 年化目标”点“开始记录年化”。</p></section>`;
  const all = st.L.txns.slice().sort((a, b) => b.d.localeCompare(a.d) || b.id.localeCompare(a.id));
  const row = t => `<div class="row static"><div class="t"><span class="n faint">${esc(t.d)}</span><span>${t.type === 'in' ? '从银行卡转入' : '转回银行卡'}${t.plan ? (/^\d{4}-\d{2}$/.test(t.plan) ? '<span class="tag">按计划</span>' : `<span class="tag">${esc(t.plan.slice(0, 12))}</span>`) : ''}</span></div><div class="r"><span class="n strong">${fmt(t.amt, 2)}</span> <button class="icon-btn sm" type="button" data-ledger="del" data-id="${esc(t.id)}" aria-label="删除这笔记录">${delTxn === t.id ? '确认' : '✕'}</button></div></div>`;
  return `<section class="card" id="sec-ledger">
    <div class="card-h"><h3>记账（用来算年化）</h3><span class="sub">起点 ${fullDate(st.L.start)} · ${fmt(st.L.startValue)}</span></div>
    <p class="note">只记从银行卡转进去买基金的钱，和卖出后转回银行卡的钱。基金之间换（卖一只、马上买另一只），钱没离开账户，不用记。记完后到上面更新各基金的金额。</p>
    <div class="ledgerform">
      <label class="field">日期<input type="date" id="lg-d" value="${today()}" min="${st.L.start}" max="${today()}"></label>
      <label class="field">方向<select id="lg-type"><option value="in">从银行卡转入</option><option value="out">转回银行卡</option></select></label>
      <label class="field">金额（元）<input type="number" inputmode="decimal" id="lg-amt" min="0" step="0.01"></label>
      <button class="btn" type="button" data-ledger="add">记一笔</button>
    </div>
    <div class="rows">${all.slice(0, 5).map(row).join('') || '<p class="muted pad">还没有记录。</p>'}</div>
    ${all.length > 5 ? `<details class="pickfrom"><summary>全部 ${all.length} 笔</summary><div class="rows">${all.slice(5, 300).map(row).join('')}</div></details>` : ''}
    <details class="pickfrom"><summary>重新设定起点</summary><p class="note">把今天的总资产 ${fmt(A.total)} 设为新起点，之前的记账会清空。</p><button class="btn danger" type="button" data-ledger="restart">${ledgerArm ? '再点一次确认' : '重新开始记录'}</button></details>
  </section>`;
}
let ledgerArm = false, delTxn = null;
function ledgerAction(act, t) {
  const A = analyzeM();
  if (act === 'start' || (act === 'restart' && ledgerArm)) { P.ledger = { start: today(), startValue: Math.round(A.total * 100) / 100, txns: [] }; ledgerArm = false; save(); render(true); toast('已开始记录，起点是今天的总资产'); }
  else if (act === 'restart') { ledgerArm = true; render(true); }
  else if (act === 'add') {
    const d = $('#lg-d').value, type = $('#lg-type').value, amt = Math.round(Number($('#lg-amt').value) * 100) / 100;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < P.ledger.start || d > today()) { toast('日期要在起点和今天之间'); return; }
    if (!(amt > 0) || amt > 1e9) { toast('金额要大于 0'); $('#lg-amt').focus(); return; }
    if (type !== 'in' && type !== 'out') return;
    P.ledger.txns.push({ id: 't' + Date.now(), d, type, amt });
    save(); render(true); toast('已记一笔。别忘了在上面更新各基金的金额');
  }
  else if (act === 'del') {
    if (delTxn !== t.dataset.id) { delTxn = t.dataset.id; render(true); return; }
    P.ledger.txns = P.ledger.txns.filter(x => x.id !== delTxn); delTxn = null; save(); render(true); toast('已删除');
  }
  else if (act === 'plan') {
    if (!P.ledger) { toast('先在看板上点“开始记录年化”'); return; }
    const mk = monthKey(); if (P.ledger.txns.some(x => x.plan === mk)) { toast('这个月的计划已经记过了'); return; }
    // 本月从银行卡转进来的钱 = 定投计划 + 限购转去买别的 + 银行卡里投回去的；卖出后没地方买的钱转回银行卡
    const amt = Math.round(A.transferIn), back = Math.round(A.sellLeft);
    if (amt < 1 && back < 1) { toast('这个月计划里没有进出银行卡的钱'); return; }
    if (amt >= 1) P.ledger.txns.push({ id: 't' + Date.now(), d: today(), type: 'in', amt, plan: mk });
    if (back >= 1) P.ledger.txns.push({ id: 'o' + Date.now(), d: today(), type: 'out', amt: back, plan: mk });
    save(); render(true); toast(`已记账：${amt >= 1 ? `从银行卡转入 ${fmt(amt)}` : ''}${amt >= 1 && back >= 1 ? '，' : ''}${back >= 1 ? `转回银行卡 ${fmt(back)}` : ''}。去“持仓”页更新各基金金额`);
  }
}
/* ================= AI 助手（DeepSeek） =================
 * key 只存在这台设备的浏览器里（localStorage 的 money.ai），不进备份文件，不上传到 GitHub。
 * AI 只负责解释规则引擎算出来的建议，不改规则、不编数据。
 */
const AI_LS = 'money.ai';
let AIS = { key: '', model: C.ai.defaultModel, auto: 'change' };
try { const a = JSON.parse(localStorage.getItem(AI_LS) || 'null'); if (a && typeof a === 'object') AIS = Object.assign(AIS, { key: typeof a.key === 'string' ? a.key : '', model: C.ai.models.some(m => m.id === a.model) ? a.model : C.ai.defaultModel, auto: a.auto === 'off' ? 'off' : 'change' }); } catch (e) { /* 读不到就当没设置 */ }
const saveAI = () => { try { localStorage.setItem(AI_LS, JSON.stringify(AIS)); } catch (e) { toast('浏览器不允许保存设置'); } };
let MARKET_AI = null;   // data/ai-report.json：GitHub 盯盘结果（checked 上次检查时间，history 变化提醒）
const AI_SYSTEM = `你是一位冷静、不追涨杀跌的基金投资顾问，用简单的中文给完全不懂投资的新手讲解。
规则：
1. 买卖建议由页面固定规则算出，你只负责解释原因。不要推翻规则，不要建议规则之外的加仓、减仓、换基或择时。
2. 只使用用户给你的数据，不要编造净值、收益、新闻或预测具体涨跌。数据不全时直接说不知道。
3. 不追热点，不鼓励频繁交易，不承诺收益。提醒风险时具体、平实，不吓人。
4. 回答简短：先一句话结论，再分点说明，每点一两句。不用表格。总长度控制在 400 字以内。
5. 如果用户问涨跌预测、热点或“现在要不要抄底/卖掉”，直接说无法预测，并把话题引回本月计划。不要使用“抄底、暴涨、机会来了、赶紧”等词。大多数时候结论就是“按计划执行，不用额外操作”，是这样就直说。`;
function aiContext(A) {
  const lv = currentLevel();
  const sig = (k, f) => { const s = sigOf(k, f); return `${s.t}（买入倍数 ${s.m}）`; };
  return {
    今天: today(), 数据日期: dataDate(), 风险档位: lv.level.n, 是否示例持仓: !!P.example,
    目标比例: A.T, 当前比例: Object.fromEntries(C.cats.map(c => [c.n, +A.w[c.k].toFixed(1)])),
    总资产: Math.round(A.total), 持有收益: Math.round(A.profit), 每月定投: A.monthly,
    市场: { 沪深300估值分位: idxPct, 标普500估值分位: M.sp500 && M.sp500.pePct10y, 纳指100估值分位: M.ndx && M.ndx.pePct10y,
      红利低波股息率: M.divLowVol && M.divLowVol.dy, 红利低波自身估值分位: divPct, 中国10年国债: M.cgb10y && M.cgb10y.yield, 美国10年国债: M.ust10y && M.ust10y.yield,
      信号: { 宽基: sig('index'), 红利低波: sig('div'), 标普500: SIGV.sp500 && SIGV.sp500.t, 纳指100: SIGV.ndx && SIGV.ndx.t } },
    持仓: A.items.map(i => ({ 名称: i.fund ? i.fund.short || i.fund.name : i.name, 代码: /^\d{6}$/.test(i.code) ? i.code : '', 类别: CAT[i.cat].n, 在推荐名单: !!(i.fund && i.fund.pick), 金额: Math.round(i.amount), 收益率: +((i.amount - i.profit) > 0 ? i.profit / (i.amount - i.profit) * 100 : 0).toFixed(1) })),
    规则给出的建议: A.advice.map(x => ({ 基金: x.fund ? x.fund.short || x.fund.name : x.name, 操作: x.adv.t, 金额: x.adv.amt || 0, 理由: x.adv.why.join(' ') })),
    本月定投计划: A.plan.filter(p => p.amt >= 1).map(p => ({ 基金: p.fund.short || p.fund.name, 金额: Math.round(p.amt) })),
    本月多出来的钱怎么买: { 来源: { 卖出: Math.round(A.sellAmt), 限购买不进转过来: Math.round(A.capPool), 银行卡里投回: Math.round(A.deployUsed) }, 买入: A.reinvest.filter(r => r.amt >= 1).map(r => ({ 基金: r.fund.short || r.fund.name, 金额: Math.round(r.amt) })) },
    银行卡里等着投的钱: Math.round(+P.reserve || 0), 本月从银行卡转进支付宝: Math.round(A.transferIn)
  };
}
function fundContext(f) {
  return { 名称: f.name, 代码: f.code, 类别: CAT[f.cat].n, 跟踪: f.index || '', 推荐: !!f.pick, 评分: f.score, 同类排名: `${f.rank}/${f.peers}`,
    近1年: f.ret1y, 近3年: f.ret3y, 近3年最大回撤: f.maxDd3y, 规模亿: f.scaleYi, 年费率: totalFee(f), 估值信号: sigOf(f.cat, f).t, 逐年收益: f.yearRets,
    我的判断: { 为什么: f.why, 风险: f.risk, 何时卖: f.exit } };
}
/* 调用 DeepSeek（OpenAI 兼容接口），流式返回 */
async function callAI(messages, onText, signal) {
  if (!AIS.key) throw { code: 'nokey' };
  let res;
  try {
    res = await fetch(C.ai.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AIS.key },
      body: JSON.stringify({ model: AIS.model, messages, stream: true, max_tokens: C.ai.maxTokens, temperature: 0.3 })
    });
  } catch (e) { if (e && e.name === 'AbortError') throw { code: 'abort' }; throw { code: 'network' }; }
  if (!res.ok) { let msg = ''; try { msg = (await res.json()).error.message; } catch (e) { /* 没有错误详情 */ } throw { code: res.status, msg }; }
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '', text = '', thinking = '';
  for (;;) {
    let chunk;
    try { chunk = await reader.read(); }
    catch (e) { throw { code: e && e.name === 'AbortError' ? 'abort' : 'network', partial: text }; }
    const { value, done } = chunk; if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      const t = line.trim(); if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim(); if (data === '[DONE]') continue;
      try { const d = JSON.parse(data).choices[0].delta || {}; if (d.reasoning_content) thinking += d.reasoning_content; if (d.content) text += d.content; onText(text, thinking); } catch (e) { /* 半行数据，等下一段 */ }
    }
  }
  return text;
}
function aiError(e) {
  if (!e) return 'AI 调用失败。';
  if (e.code === 'nokey') return '还没填 DeepSeek API key。到“我的 → AI 助手”里填写。';
  if (e.code === 'network' && !e.partial) return '连不上 DeepSeek：可能是网络问题，或者浏览器拦截了请求。稍后再试；一直连不上，可以先把“自动解读”关掉，免得每次打开都白试一次。';
  if (e.code === 401) return 'API key 不对或已失效。到 DeepSeek 开放平台重新生成一个，再填到“我的 → AI 助手”。';
  if (e.code === 402) return 'DeepSeek 账户余额不足，充值后再试。';
  if (e.code === 429) return '请求太频繁，等一分钟再试。';
  if (e.code === 'abort') return e.partial ? '（已停止，上面是停止前生成的部分）' : '已停止。';
  if (e.code === 'network' && e.partial) return '（网络中断，上面是中断前生成的部分）';
  return typeof e.code === 'number' ? `AI 调用失败（错误码 ${e.code}${e.msg ? '：' + esc(e.msg) : ''}）。` : 'AI 调用失败，请稍后再试。';
}
/* 把 AI 的回答转成简单排版：加粗、分点、换行。先转义，防止插入网页代码 */
function mdLite(t) {
  return esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/^#{1,4}\s*(.+)$/gm, '<b>$1</b>')
    .split(/\n{2,}/).map(par => /^\s*([-*•]|\d+[.、])\s/m.test(par)
      ? '<ul>' + par.split('\n').filter(Boolean).map(l => `<li>${l.replace(/^\s*([-*•]|\d+[.、])\s*/, '')}</li>`).join('') + '</ul>'
      : `<p>${par.replace(/\n/g, '<br>')}</p>`).join('');
}
let aiBusy = null;   // 正在进行的 AI 请求的 AbortController
async function runAI(kind, opts) {
  opts = opts || {};
  const box = (!opts.silent && document.getElementById(opts.box || 'ai-out')) || document.createElement('div');
  if (aiBusy) aiBusy.abort();
  const ctl = new AbortController(); aiBusy = ctl;
  const A = analyzeM();
  let user;
  if (kind === 'review') user = `请根据下面的数据，用新手听得懂的话解读本月该怎么做：先一句话总结，然后说明最重要的 2–4 件事和原因。如果有真正需要注意的风险，说一条；没有就写“本月没有特别需要注意的”。\n数据：${JSON.stringify(aiContext(A))}`;
  else if (kind === 'fund') user = `请用新手听得懂的话点评这只基金：它在组合里起什么作用、现在估值情况、主要风险，以及按规则现在对它的操作是什么、为什么。\n这只基金：${JSON.stringify(fundContext(FUND[opts.code]))}\n我的整体情况：${JSON.stringify(aiContext(A))}`;
  else user = `我的问题：${opts.q}\n参考数据：${JSON.stringify(aiContext(A))}`;
  box.hidden = false; box.innerHTML = '<p class="note">AI 正在分析…</p>';
  const stopBtn = document.getElementById(opts.stop || 'ai-stop'); if (stopBtn) stopBtn.hidden = false;
  try {
    const text = await callAI([{ role: 'system', content: AI_SYSTEM }, { role: 'user', content: user }], (t, th) => {
      box.innerHTML = t ? mdLite(t) : `<p class="note">AI 正在思考…${th ? `（已想了 ${th.length} 字）` : ''}</p>`;
    }, ctl.signal);
    box.innerHTML = mdLite(text) + `<p class="note">AI 生成，仅供参考；具体操作以上面的规则建议为准。${esc(AIS.model)} · ${new Date().toLocaleString('zh-CN', { hour12: false })}</p>`;
    if (kind === 'review') { P.aiReport = { at: new Date().toISOString(), day: today(), text, model: AIS.model, example: !!P.example, fp: adviceFingerprint(A) }; save(); if (opts.silent) { toast('AI 已更新持仓解读'); if ((location.hash || '#home') === '#home') render(true); } }
  } catch (e) {
    box.innerHTML = (e && e.partial ? mdLite(e.partial) : '') + `<p class="note err">${aiError(e)}</p>`;
    if (opts.silent && !(e && e.code === 'abort')) { P.aiFail = today(); save(); }
  }
  finally { if (aiBusy === ctl) aiBusy = null; if (stopBtn) stopBtn.hidden = true; }
}
/* 按变化触发：只有你的操作建议变了（比如某只从“持有”变成“止盈”），或者到了每月定投日，才让 AI 重新解读 */
function adviceFingerprint(A) { return A.advice.map(x => `${x.code}:${x.adv.t}`).sort().join('|'); }
function aiDue() {
  if (!AIS.key || AIS.auto === 'off' || P.example) return false;
  const r = P.aiReport; if (!r || !r.at || r.example) return true;
  if (r.fp !== adviceFingerprint(analyzeM())) return true;
  return daysToInvest().n === 0 && (r.day || '') !== today();
}
function aiReportHTML(r) {
  if (!r) return '';
  return `<div class="ai-body">${mdLite(r.text)}</div><p class="note">${esc(new Date(r.at).toLocaleString('zh-CN', { hour12: false }))} 生成 · ${esc(r.model)}。AI 只做解读，操作以规则建议为准。</p>`;
}
function marketAlerts(days) {
  const h = MARKET_AI && Array.isArray(MARKET_AI.history) ? MARKET_AI.history : [];
  const since = Date.now() - days * 86400000;
  return h.filter(x => x && typeof x.text === 'string' && Date.parse(String(x.date).replace(' ', 'T') + ':00+08:00') >= since);
}
function monitorStatus() {
  const checked = MARKET_AI && MARKET_AI.checked;
  if (!checked) return '<p class="calm warnbox">还没有盯盘记录。GitHub 的自动任务可能还没运行，这期间请自己留意估值变化。</p>';
  const days = Math.floor((Date.now() - Date.parse(checked.replace(' ', 'T') + ':00+08:00')) / 86400000);
  if (days > 3) return `<p class="calm warnbox">盯盘已经 ${days} 天没有检查了（上次 ${esc(checked)}），自动任务可能停了。</p>`;
  return `<p class="calm">持续盯盘中，上次检查 ${esc(checked)}。最近 30 天没有需要你注意的变化，按计划执行就好。<span class="sub">盯盘只看公开的市场数据，看不到你的持仓。</span></p>`;
}
function alertHTML(x) { return `<div class="alert"><div class="sub n">${esc(x.date)} · ${x.model === 'rules' ? '规则提醒' : 'AI 提醒'}</div><div class="ai-text">${mdLite(x.text)}</div></div>`; }
function aiCardHome() {
  const mine = P.aiReport && !P.aiReport.example ? P.aiReport : null;
  const recent = marketAlerts(30), checked = MARKET_AI && MARKET_AI.checked;
  return `<section class="card span2" aria-label="盯盘与 AI 解读">
    <div class="card-h"><h3>盯盘</h3><a class="more" href="#analysis-ai">${AIS.key ? '问 AI ›' : '历史提醒 ›'}</a></div>
    ${recent.length ? `<h4 class="ai-h">最近的变化提醒</h4>${alertHTML(recent[0])}${recent.length > 1 ? `<p class="note">近 30 天共 ${recent.length} 条提醒，全部记录在“买卖分析”页。</p>` : ''}`
      : monitorStatus()}
    ${mine ? `<h4 class="ai-h">你的持仓解读</h4>${aiReportHTML(mine)}` : AIS.key ? '<p class="note">录入真实持仓后，建议有变化或到了定投日，AI 会自动解读一次。</p>' : '<p class="note">在“我的 → AI 助手”填上 DeepSeek key，建议有变化时 AI 会用大白话给你解读。</p>'}
  </section>`;
}

/* ================= 路由 ================= */
let curView = '';
function render(force) {
  try { renderInner(force); }
  catch (err) {
    console.error(err);
    $('#main').innerHTML = `<div class="card"><h3>页面出错了</h3><p class="note">可能是保存的数据损坏。可以先“导出备份”留一份，再重置数据。</p><div class="btnrow"><button class="btn ghost" type="button" data-export>导出备份</button><button class="btn danger" type="button" data-reset>重置所有数据</button></div><p class="note">${esc(err && err.message)}</p></div>`;
  }
}
function renderInner(force) {
  const h = (location.hash || '#home').slice(1);
  const A0 = analyze(); syncSellPlans(A0); const A = monthView(A0);
  let html, tab = h.split('-')[0];
  if (h.startsWith('fund-')) { html = viewFund(h.slice(5), A); tab = 'funds'; }
  else if (tab === 'analysis') html = viewAnalysis(A);
  else if (tab === 'funds') html = viewFunds();
  else if (tab === 'holdings') html = viewHoldings(A);
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
    const anchor = { 'analysis-calm': 'sec-calm', 'analysis-stress': 'sec-stress', 'me-cal': 'me-cal', 'analysis-plan': 'sec-plan', 'analysis-market': 'sec-market', 'analysis-ai': 'sec-ai', 'me-quiz': 'me-quiz', 'me-ai': 'me-ai', 'me-backup': 'me-backup', 'holdings-ledger': 'sec-ledger' }[h];
    const el = anchor && document.getElementById(anchor);
    if (el) { let d = el.closest('details'); while (d) { d.open = true; d = d.parentElement && d.parentElement.closest('details'); } el.scrollIntoView(); } else window.scrollTo(0, 0);
  }
  if (h.startsWith('fund-')) loadLive(h.slice(5));
  const hm = $('#home-more'); if (hm) hm.addEventListener('toggle', () => { homeMore = hm.open; });
  ['ana-more', 'me-more'].forEach(id => { const d = document.getElementById(id); if (!d) return; if (MORE_OPEN[id]) d.open = true; d.addEventListener('toggle', () => { MORE_OPEN[id] = d.open; }); });
  if (tab === 'holdings') bindHoldings();
  if (tab === 'analysis' && $('#ai-q')) $('#ai-q').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); aiAction('ask'); } });
  if (tab === 'me') bindMe();
}
window.addEventListener('hashchange', () => { delArm = false; holdDel = null; delTxn = null; ledgerArm = false; if (aiBusy) aiBusy.abort(); render(); });

/* ================= 交互 ================= */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-cmp],[data-ff],[data-copy],[data-back],[data-hold],[data-me],[data-relock],[data-ask],[data-clear],#add-btn,[data-checkin],[data-uncheck],[data-user],[data-adduser],[data-delask],[data-delcancel],[data-deluser],[data-export],[data-snooze],[data-riskack],[data-imphint],[data-quizlater],[data-quizlaterdone],[data-import],[data-reset],[data-ai],[data-ledger],[data-cal],[data-calm]');
  if (!t) return;
  const d = t.dataset;
  if (d.cmp) { cmpCat = d.cmp; document.querySelectorAll('[data-cmp]').forEach(b => b.setAttribute('aria-pressed', b === t)); $('#cmp').innerHTML = compareTable(cmpCat); }
  else if (d.ff) { fundFilter = d.ff; render(true); }
  else if (d.copy) { e.preventDefault(); copyText(d.copy, '已复制 ' + d.copy + '，去支付宝搜索框粘贴'); }
  else if ('back' in d) { if (history.length > 1) history.back(); else location.hash = '#funds'; }
  else if (d.ask) { if (!P.monthPlan) return; if (d.ask === 'keep') { P.monthPlan.ask = false; save(); render(true); toast('好的，本月计划不变'); } else { P.monthPlan = null; save(); render(true); toast('已按最新持仓重算本月计划'); } }
  else if ('relock' in d) { if (monthDone()) { toast('这个月已经打卡或记过账了，计划不再变'); return; } P.monthPlan = null; save(); render(true); toast('已按最新数据重算本月计划'); }
  else if (d.hold) holdAction(d.hold, t);
  else if (d.me) meAction(d.me);
  else if ('clear' in d) { P.items = []; holdEdit = holdDel = null; touchPortfolio(); render(true); }
  else if (t.id === 'add-btn') {
    const code = $('#add-code').value;
    if (code === '__other') {
      const nm = $('#other-name').value.trim(); if (!nm) { toast('先填基金名称'); $('#other-name').focus(); return; }
      dropDraft('fa-', 'found-');
      found = { code: 'other-' + Date.now(), name: nm.slice(0, 40), cat: $('#other-cat').value, state: 'ok' };
    } else {
      if (!P.example && P.items.some(i => i.code === code)) { toast('这只已经在持仓里了，要改金额点它后面的“编辑”'); return; }
      dropDraft('fa-', 'found-');
      found = { code, name: FUND[code].name || FUND[code].short, cat: FUND[code].cat, state: 'ok' };
    }
    showFound(); $('#fa-amt')?.focus();
  }
  else if (d.checkin) { const mk = monthKey(), old = P.journal.find(j => j.m === mk);
    // 全部照做：把这个月留在银行卡的钱记下来（改打卡时先撤回上次记的）
    const base = Math.max(0, (+P.reserve || 0) - (old ? old.res || 0 : 0)); let res = 0;
    if (d.checkin === 'full' && !P.example) { const A0 = analyzeM(); res = Math.max(-base, Math.round(A0.reserveDelta)); }
    P.reserve = base + res;
    P.journal = P.journal.filter(j => j.m !== mk); P.journal.push({ m: mk, choice: d.checkin, at: new Date().toISOString(), res }); P.journal.sort((a, b) => a.m < b.m ? -1 : 1); save(); render(true); toast(d.checkin === 'panic' || d.checkin === 'chase' ? '已记录。如实记录才能帮你改掉习惯。' : res > 0 ? `已打卡。本月少投的 ${fmt(res)} 记到了“银行卡里等着投的钱”（现在 ${fmt(P.reserve)}）` : res < 0 ? `已打卡。“银行卡里等着投的钱”用掉 ${fmt(-res)}（现在 ${fmt(P.reserve)}）` : '已打卡'); }
  else if ('uncheck' in d) { const mk = monthKey(), old = P.journal.find(j => j.m === mk); if (old && old.res) P.reserve = Math.max(0, (+P.reserve || 0) - old.res); P.journal = P.journal.filter(j => j.m !== mk); save(); render(true); }
  else if (d.user) { STORE.current = d.user; P = STORE.profiles[d.user]; delArm = false; holdEdit = holdDel = meEdit = null; resEdit = false; holdOpen = prefsOpen = false; found = null; savedMsg = {}; DRAFT = {}; ledgerArm = false; delTxn = null; save(); render(true); toast('已切换到 ' + P.name); }
  else if ('adduser' in d) { const id = 'p' + Date.now(); STORE.profiles[id] = newProfile('用户' + Object.keys(STORE.profiles).length); STORE.current = id; P = STORE.profiles[id]; holdEdit = holdDel = null; found = null; savedMsg = {}; DRAFT = {}; meEdit = 'name'; save(); render(true); $('#pname')?.select(); toast('已添加新用户，先改个名字'); }
  else if ('delask' in d) { delArm = true; render(true); }
  else if ('delcancel' in d) { delArm = false; render(true); }
  else if ('deluser' in d) { delete STORE.profiles[STORE.current]; STORE.current = Object.keys(STORE.profiles)[0]; P = STORE.profiles[STORE.current]; delArm = false; holdEdit = holdDel = meEdit = null; resEdit = false; savedMsg = {}; DRAFT = {}; found = null; save(); render(true); toast('已删除'); }
  else if (d.ai) aiAction(d.ai, t);
  else if (d.ledger) ledgerAction(d.ledger, t);
  else if ('cal' in d) downloadCalendar();
  else if (d.calm === 'want') { const box = $('#calm-check'); box.hidden = !box.hidden; if (!box.hidden) box.innerHTML = calmChecklist(analyze(), d.code); }
  else if ('export' in d) exportBackup();
  else if ('quizlater' in d) { lsSet('money.quizLater', today()); meEdit = null; quizWarn = ''; dropDraft('q'); render(true); toast('好的，一周后再问你。这期间先不动'); }
  else if ('quizlaterdone' in d) { lsSet('money.quizLater', ''); render(true); }
  else if ('imphint' in d) { lsSet('money.impHint', today()); render(true); }
  else if ('riskack' in d) { lsSet('money.riskAck', today()); render(true); }
  else if ('snooze' in d) { lsSet('money.expSnooze', today()); render(true); }
  else if ('reset' in d) { if (!resetArm) { resetArm = true; t.textContent = '再点一次，确认清空'; return; } STORE = { current: 'p1', profiles: { p1: newProfile('我') } }; P = STORE.profiles.p1; resetArm = false; holdEdit = holdDel = meEdit = null; resEdit = false; holdOpen = prefsOpen = false; savedMsg = {}; DRAFT = {}; found = null; save(); render(true); toast('已重置'); }
  else if ('import' in d) $('#import-file').click();
});
function aiAction(act, t) {
  if (act === 'review') runAI('review', { box: 'ai-out' });
  else if (act === 'stop') { if (aiBusy) aiBusy.abort(); }
  else if (act === 'ask') { const q = ($('#ai-q').value || '').trim(); if (!q) { toast('先输入问题'); $('#ai-q').focus(); return; } runAI('ask', { q, box: 'ai-ans' }); }
  else if (act === 'fund') runAI('fund', { code: t.dataset.code, box: 'ai-fund', stop: 'none' });
  else if (act === 'savekey') {
    const k = ($('#ai-key').value || '').trim();
    if (k && !/^sk-[A-Za-z0-9_-]{10,}$/.test(k)) { toast('key 的格式不对，一般是 sk- 开头'); return; }
    if (k) AIS.key = k; AIS.model = $('#ai-model').value; AIS.auto = $('#ai-auto').value; saveAI(); render(true); toast(AIS.key ? '已保存' : '已保存设置（还没有 key）');
  }
  else if (act === 'delkey') { AIS.key = ''; saveAI(); render(true); toast('已删除 key'); }
  else if (act === 'testkey') {
    const box = $('#ai-test'); box.hidden = false; box.textContent = '正在测试…';
    callAI([{ role: 'user', content: '请只回复两个字：正常' }], tx => { box.textContent = '收到回复：' + tx; })
      .then(tx => { box.textContent = `连接正常（${AIS.model} 回复：${tx.slice(0, 20)}）。`; })
      .catch(e => { box.innerHTML = aiError(e); });
  }
}
function bindHoldings() {
  const fold = $('#hold-fold'); if (fold) fold.addEventListener('toggle', () => { holdOpen = fold.open; });
  const ci = $('#code-input');
  if (ci) {
    ci.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); findCode(); } });
    ci.addEventListener('input', () => { ci.value = ci.value.replace(/\D/g, '').slice(0, 6); });
    $('#code-find').addEventListener('click', findCode);
    $('#code-result').addEventListener('click', e => { if (e.target.id === 'found-add') addFound(); else if (e.target.id === 'found-cancel') { found = null; dropDraft('fa-', 'found-', 'code-input'); showFound(); ci.value = ''; } });
    $('#code-result').addEventListener('change', e => { if (e.target.id === 'found-cat' && found) found.cat = e.target.value; });
    $('#code-result').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); addFound(); } });
    const sel = $('#add-code'), box = $('#other-box');
    sel.addEventListener('change', () => { box.hidden = sel.value !== '__other'; });
  } else found = null;
  showFound(); restoreDrafts();
  const hl = $('#hold-list');
  if (hl) hl.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); const b = hl.querySelector('[data-hold="save"]'); if (b) holdAction('save', b); } });
}
function bindMe() {
  $('#ai-key').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); aiAction('savekey'); } });
  $('#pname') && $('#pname').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); meAction('savename'); } });
  const pf = $('#prefs-fold'); if (pf) pf.addEventListener('toggle', () => { prefsOpen = pf.open; });
  restoreDrafts();
  $('#prefs-form') && $('#prefs-form').addEventListener('submit', e => { e.preventDefault(); savePrefs(); });
  $('#quiz') && $('#quiz').addEventListener('submit', e => {
    e.preventDefault();
    const ans = C.quiz.map((_, i) => { const c = document.querySelector(`input[name="q${i}"]:checked`); return c ? +c.value : null; });
    const r = quizLevel(ans);
    if (!r) { $('#quiz-msg').textContent = '还有题没选。'; return; }
    // 降档（尤其是改成“1 年内要用”）会让系统分批卖出股票基金。大跌时最容易冲动这么改，所以多问一次
    const old = P.risk, key = ans.join('');
    const warnShown = $('#quiz-warn') && !$('#quiz-warn').hidden;
    if (old && levelIndex(r.k) < levelIndex(old.k) && !(quizWarn === key && warnShown)) {
      quizWarn = key; const falling = calmAlerts(analyze()).some(x => x.held);
      const box = $('#quiz-warn'); box.hidden = false;
      box.innerHTML = `<p><b>${r.k === 'short' ? '改成“1 年内要用”，系统会让你在 3 个月内把股票基金都卖掉，换成债券。' : `这样会从“${C.levels[levelIndex(old.k)].n}”降到“${C.levels[levelIndex(r.k)].n}”，系统会分批卖出一部分股票基金。`}</b></p>
        <p>${falling ? '你的基金最近正在下跌。' : ''}你是真的${r.k === 'short' ? '一年内要用这笔钱' : '收入、用钱计划变了'}，还是因为${falling ? '最近在跌，' : ''}心里害怕？如果只是害怕，请保持原来的答案：跌的时候卖，最容易把浮亏变成真亏。</p>
        <p>只是要用其中一部分钱：不用改测评，直接在支付宝卖这一部分，再去“持仓”改金额就行。</p>
        <div class="btnrow"><button class="btn danger" type="submit">确实变了，确认修改</button><button class="btn ghost" type="button" data-me="cancel">保持原来的答案</button><button class="btn ghost" type="button" data-quizlater>一周后再提醒我</button></div>`;
      box.scrollIntoView({ block: 'nearest' }); return;
    }
    quizWarn = ''; lsSet('money.quizLater', '');
    P.risk = { ans, score: r.score, k: r.k, at: new Date().toISOString() }; meEdit = null; dropDraft('q'); unlockMonth(); save(); stamp('quiz'); render(true);
    toast(`测评完成：${C.levels[levelIndex(r.k)].n}型`);
  });
  $('#import-file').addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const rd = new FileReader();
    rd.onload = () => {
      let s = null;
      try { s = cleanStore(JSON.parse(rd.result)); } catch (err) { s = null; }
      if (!s) { toast('这个文件不是本看板导出的备份，没有导入'); e.target.value = ''; return; }
      const prev = STORE; STORE = s; P = STORE.profiles[STORE.current];
      try { analyze(); } catch (err) { STORE = prev; P = STORE.profiles[STORE.current]; toast('备份内容有问题，没有导入'); e.target.value = ''; return; }
      e.target.value = '';
      holdEdit = holdDel = meEdit = null; resEdit = false; holdOpen = prefsOpen = false; found = null; savedMsg = {}; DRAFT = {}; save(); render(true); toast(`导入成功：${Object.keys(STORE.profiles).length} 个用户`);
    };
    rd.readAsText(file);
  });
}
function exportBackup() {
  const txt = JSON.stringify(Object.assign({ app: 'money', exportedAt: new Date().toISOString() }, STORE), null, 1);
  try {
    const blob = new Blob([txt], { type: 'application/json' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `money-backup-${today()}.json`; document.body.appendChild(a); a.click(); a.remove(); lsSet('money.exp', today()); setTimeout(() => render(true), 300);
    setTimeout(() => URL.revokeObjectURL(a.href), 2000); toast('已导出。iPhone 上会存到“文件”App；如果下载被取消了，再点一次');
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
  try { const r2 = await fetch('data/ai-report.json?v=' + Math.floor(Date.now() / 600000), { cache: 'no-cache' }); if (r2.ok) { const j = await r2.json(); if (j && typeof j === 'object' && (Array.isArray(j.history) || typeof j.checked === 'string')) MARKET_AI = { checked: typeof j.checked === 'string' ? j.checked : '', history: Array.isArray(j.history) ? j.history : [] }; } } catch (e) { /* 还没有市场点评 */ }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* 不支持就算了 */ }
  computeSignals(); scoreAll();
  $('#datestamp').textContent = '数据更新：' + (DATA.updated || '—');
  $('#sidefoot').textContent = `数据更新：${DATA.updated || '—'}。净值、估值每个交易日自动更新，基金详情页显示盘中实时估值。`;
  render(true);
  if (aiDue() && P.aiFail !== today()) setTimeout(() => runAI('review', { silent: true }), 1500);   // 定时分析
}
boot();
})();
