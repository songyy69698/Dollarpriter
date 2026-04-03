#!/usr/bin/env node
/**
 * observer_v15_validation.js
 * Non-trading strategy observer / validator.
 * Usage:
 * node observer_v15_validation.js
 * node observer_v15_validation.js --json
 * node observer_v15_validation.js --audit-bars 500
 */

const https = require('https');
const SYMBOL = 'ETHUSDT';
const DEFAULT_AUDIT_BARS = Number(getArg('--audit-bars') || 500);
const JSON_MODE = hasArg('--json');

function hasArg(flag) { return process.argv.includes(flag); }
function getArg(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; }

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'oracle-observer/1.0' } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`Parse error: ${body.slice(0, 200)}`)); } });
    }).on('error', reject);
  });
}

async function fetchKlines(interval, limit) {
  const rows = await fetchJson(`https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL}&interval=${interval}&limit=${limit}`);
  return rows.map((k) => ({
    time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4],
    volume: +k[5], takerBuyBase: +k[9], takerSellBase: +k[5] - +k[9],
    delta: +k[9] - (+k[5] - +k[9]),
  }));
}

async function fetchFunding() {
  const rows = await fetchJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${SYMBOL}&limit=100`);
  return rows.map((x) => ({ time: +x.fundingTime, fundingRate: +x.fundingRate }));
}

async function fetchOI(limit) {
  const rows = await fetchJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${SYMBOL}&period=5m&limit=${limit}`);
  return rows.map((x) => ({ time: +x.timestamp, oi: +x.sumOpenInterest }));
}

async function fetchLS(limit) {
  const rows = await fetchJson(`https://fapi.binance.com/futures/data/topLongShortAccountRatio?symbol=${SYMBOL}&period=5m&limit=${limit}`);
  return rows.map((x) => ({ time: +x.timestamp, longShortRatio: +x.longShortRatio }));
}

function ema(arr, p) {
  const k = 2 / (p + 1); let prev = null;
  return arr.map((v) => { prev = prev == null ? v : v * k + prev * (1 - k); return prev; });
}

function gmmaState(data, idx) {
  const cl = data.map((x) => x.close);
  const sPs = [3,5,8,10,12,15], lPs = [30,35,40,45,50,60];
  if (!data._g) data._g = { s: sPs.map((p) => ema(cl, p)), l: lPs.map((p) => ema(cl, p)) };
  const sA = data._g.s.reduce((a, e) => a + (e[idx] ?? 0), 0) / sPs.length;
  const lA = data._g.l.reduce((a, e) => a + (e[idx] ?? 0), 0) / lPs.length;
  const pS = data._g.s.reduce((a, e) => a + (e[Math.max(0,idx-1)] ?? 0), 0) / sPs.length;
  const pL = data._g.l.reduce((a, e) => a + (e[Math.max(0,idx-1)] ?? 0), 0) / lPs.length;
  const sep = Math.abs(sA - lA) / Math.max(1e-9, data[idx].close);
  const exp = Math.abs(sA - lA) > Math.abs(pS - pL);
  return { up: sA > lA && exp, down: sA < lA && exp, tangled: sep < 0.0025 };
}

function volAvg(data, idx, n = 20) {
  const sl = data.slice(Math.max(0, idx - n), idx);
  return sl.length ? sl.reduce((a, b) => a + b.volume, 0) / sl.length : data[idx].volume;
}

function cvdArr(data) { let c = 0; return data.map((x) => { c += x.delta; return c; }); }

function poc(data, idx, bars = 18, bins = 24) {
  const win = data.slice(Math.max(0, idx - bars + 1), idx + 1);
  let lo = Math.min(...win.map((x) => x.low)), hi = Math.max(...win.map((x) => x.high));
  if (!(hi > lo)) return data[idx].close;
  const step = (hi - lo) / bins, bkt = Array(bins).fill(0);
  for (const k of win) { const bi = Math.max(0, Math.min(bins-1, Math.floor(((k.high+k.low+k.close)/3 - lo) / step))); bkt[bi] += k.volume; }
  let best = 0; for (let i = 1; i < bins; i++) if (bkt[i] > bkt[best]) best = i;
  return lo + step * (best + 0.5);
}

function sweepSignal(data, idx) {
  const s = Math.max(2, idx - 30); const highs = [], lows = [];
  for (let i = s; i < idx - 2; i++) {
    if (data[i].high >= data[i-1].high && data[i].high >= data[i+1].high) highs.push(data[i].high);
    if (data[i].low <= data[i-1].low && data[i].low <= data[i+1].low) lows.push(data[i].low);
  }
  function cluster(arr) {
    const out = [];
    for (const p of arr) { const h = out.find((x) => Math.abs(x.p - p) / p <= 0.0015); if (!h) out.push({ p, n: 1 }); else { h.p = (h.p*h.n+p)/(h.n+1); h.n++; } }
    return out.sort((a,b) => b.n - a.n);
  }
  const k = data[idx];
  const top = cluster(highs).find((x) => x.n >= 2 && k.high > x.p && k.close < x.p);
  const bot = cluster(lows).find((x) => x.n >= 2 && k.low < x.p && k.close > x.p);
  if (top) return { dir: 'SHORT', strength: top.n, level: top.p };
  if (bot) return { dir: 'LONG', strength: bot.n, level: bot.p };
  return null;
}

function absorption(data, idx) {
  const k = data[idx];
  const br = k.takerBuyBase / Math.max(1e-9, k.volume), sr = k.takerSellBase / Math.max(1e-9, k.volume);
  const body = (k.close - k.open) / Math.max(1e-9, k.open);
  return { bull: sr > 0.6 && body > -0.0008 && k.close >= k.open, bear: br > 0.6 && body < 0.0008 && k.close <= k.open };
}

function deltaDiv(data, idx) {
  if (idx < 6) return { bull: false, bear: false };
  const prev = data.slice(idx-6, idx), k = data[idx];
  const pLow = Math.min(...prev.map((x) => x.low)), pHigh = Math.max(...prev.map((x) => x.high));
  const avgD = prev.reduce((a, b) => a + b.delta, 0) / prev.length;
  return {
    bull: k.low <= pLow * 1.001 && k.delta > 0 && k.delta > Math.abs(avgD) * 0.35,
    bear: k.high >= pHigh * 0.999 && k.delta < 0 && Math.abs(k.delta) > Math.abs(avgD) * 0.35,
  };
}

function nearest(rows, t) { let b = null; for (const r of rows) { if (r.time <= t) b = r; else break; } return b; }

function ok(name, d) { return { name, s: '✅', d }; }
function bad(name, d) { return { name, s: '❌', d }; }
function neu(name, d) { return { name, s: '⚪', d }; }

function scoreSide({ side, envBias, g30, g5, ve, sweep, dd, abs, cvd3, cvd8, ls, fr, oiCh, k }) {
  let score = 0; const marks = [];
  const cLong = ls && ls.longShortRatio > 1.45 && fr >= 0;
  const cShort = ls && ls.longShortRatio < 0.75 && fr <= 0;
  const liqL = oiCh < -0.15 && k.close < k.open;
  const liqS = oiCh < -0.15 && k.close > k.open;
  const lsr = ls?.longShortRatio?.toFixed(2) ?? 'n/a';

  if (sweep && sweep.dir === side) { score += 2; if (sweep.strength >= 3) score += 1; marks.push(ok('LIQUIDITY', `${side} sweep str=${sweep.strength}`)); }
  else marks.push(neu('LIQUIDITY', 'no sweep'));

  if (ve > 1.8) { score += 1; marks.push(ok('VOLUME', `${ve.toFixed(1)}x`)); }
  else if (ve < 0.8) { score -= 1; marks.push(bad('VOLUME', `${ve.toFixed(1)}x weak`)); }
  else marks.push(neu('VOLUME', `${ve.toFixed(1)}x`));

  if (side === 'LONG') {
    if (envBias === 1) { score += 1; marks.push(ok('4H_GMMA+POC', 'bull confirmed')); }
    else if (envBias === 0) marks.push(bad('4H_GMMA+POC', 'neutral'));
    else marks.push(neu('4H_GMMA+POC', 'bear weight vs long'));

    if (g30.up) { score += 1; marks.push(ok('30M_GMMA', 'aligned up')); } else marks.push(bad('30M_GMMA', 'not up'));
    if (g5.up) { score += 1; marks.push(ok('5M_GMMA', 'trigger up')); } else marks.push(neu('5M_GMMA', 'not triggered'));
    if (dd.bull) { score += 2; marks.push(ok('DELTA', 'deltaDivBull')); } else marks.push(neu('DELTA', `d=${k.delta.toFixed(0)}`));
    if (abs.bull) { score += 1; marks.push(ok('ABSORPTION', 'bull')); } else marks.push(neu('ABSORPTION', 'none'));
    if (cvd3 > 0 && cvd8 > 0) { score += 1; marks.push(ok('CVD', `c3=${cvd3.toFixed(0)} c8=${cvd8.toFixed(0)}`)); } else marks.push(neu('CVD', `c3=${cvd3.toFixed(0)}`));
    if (cShort || liqL) { score += 1; marks.push(ok('CFD', `lsr=${lsr} oi=${oiCh.toFixed(3)}%`)); } else marks.push(neu('CFD', `lsr=${lsr}`));
  } else {
    if (envBias === -1) { score += 1; marks.push(ok('4H_GMMA+POC', 'bear confirmed')); }
    else if (envBias === 0) marks.push(bad('4H_GMMA+POC', 'neutral'));
    else marks.push(neu('4H_GMMA+POC', 'bull weight vs short'));

    if (g30.down) { score += 1; marks.push(ok('30M_GMMA', 'aligned down')); } else marks.push(bad('30M_GMMA', 'not down'));
    if (g5.down) { score += 1; marks.push(ok('5M_GMMA', 'trigger down')); } else marks.push(neu('5M_GMMA', 'not triggered'));
    if (dd.bear) { score += 2; marks.push(ok('DELTA', 'deltaDivBear')); } else marks.push(neu('DELTA', `d=${k.delta.toFixed(0)}`));
    if (abs.bear) { score += 1; marks.push(ok('ABSORPTION', 'bear')); } else marks.push(neu('ABSORPTION', 'none'));
    if (cvd3 < 0 && cvd8 < 0) { score += 1; marks.push(ok('CVD', `c3=${cvd3.toFixed(0)} c8=${cvd8.toFixed(0)}`)); } else marks.push(neu('CVD', `c3=${cvd3.toFixed(0)}`));
    if (cLong || liqS) { score += 1; marks.push(ok('CFD', `lsr=${lsr} oi=${oiCh.toFixed(3)}%`)); } else marks.push(neu('CFD', `lsr=${lsr}`));
  }

  const slip = ve > 3.0 ? 'HIGH' : ve > 1.8 ? 'MEDIUM' : 'LOW';
  marks.push(slip === 'HIGH' ? bad('SLIPPAGE', slip) : slip === 'MEDIUM' ? neu('SLIPPAGE', slip) : ok('SLIPPAGE', slip));
  return { score, marks };
}

async function main() {
  const N = Math.max(DEFAULT_AUDIT_BARS, 240);
  const [k5, k30, k4, funding, oiH, lsH] = await Promise.all([
    fetchKlines('5m', N), fetchKlines('30m', 240), fetchKlines('4h', 240),
    fetchFunding(), fetchOI(N), fetchLS(N),
  ]);
  const CVD = cvdArr(k5);
  const li = k5.length - 1, l30 = k30.length - 1, l4 = k4.length - 1;
  const latest = k5[li];
  const g4 = gmmaState(k4, l4), p4 = poc(k4, l4);
  const envBias = g4.up && k4[l4].close > p4 && !g4.tangled ? 1 : g4.down && k4[l4].close < p4 && !g4.tangled ? -1 : 0;
  const g30 = gmmaState(k30, l30), g5 = gmmaState(k5, li);
  const ve = latest.volume / Math.max(1e-9, volAvg(k5, li));
  const sw = sweepSignal(k5, li), dd = deltaDiv(k5, li), ab = absorption(k5, li);
  const cvd3 = CVD[li] - CVD[Math.max(0, li-3)], cvd8 = CVD[li] - CVD[Math.max(0, li-8)];
  const oiN = nearest(oiH, latest.time), oiP = nearest(oiH, latest.time - 900000);
  const oiCh = oiN && oiP ? (oiN.oi - oiP.oi) / oiP.oi * 100 : 0;
  const ls = nearest(lsH, latest.time), fr = nearest(funding, latest.time)?.fundingRate ?? 0;
  const args = { g30, g5, ve, sweep: sw, dd, abs: ab, cvd3, cvd8, ls, fr, oiCh, k: latest, envBias };
  const L = scoreSide({ side: 'LONG', ...args });
  const S = scoreSide({ side: 'SHORT', ...args });
  const active = L.score === S.score ? 'NEUTRAL' : L.score > S.score ? 'LONG' : 'SHORT';

  // Audit
  const audit = { total: 0, g4: [0,0], g30: [0,0], liq: [0,0], of: [0,0], score: [0,0] };
  const start = Math.max(120, k5.length - DEFAULT_AUDIT_BARS);
  for (let i = start; i < k5.length; i++) {
    const i4 = Math.min(k4.length-1, Math.floor(i/48)), i30 = Math.min(k30.length-1, Math.floor(i/6));
    const sg4 = gmmaState(k4, i4), sp4 = poc(k4, i4);
    const sEB = sg4.up && k4[i4].close > sp4 && !sg4.tangled ? 1 : sg4.down && k4[i4].close < sp4 && !sg4.tangled ? -1 : 0;
    const sg30 = gmmaState(k30, i30), sg5 = gmmaState(k5, i);
    const sve = k5[i].volume / Math.max(1e-9, volAvg(k5, i));
    const ssw = sweepSignal(k5, i), sdd = deltaDiv(k5, i), sab = absorption(k5, i);
    const sc3 = CVD[i]-CVD[Math.max(0,i-3)], sc8 = CVD[i]-CVD[Math.max(0,i-8)];
    const soiN = nearest(oiH, k5[i].time), soiP = nearest(oiH, k5[i].time-900000);
    const soiCh = soiN && soiP ? (soiN.oi-soiP.oi)/soiP.oi*100 : 0;
    const sls = nearest(lsH, k5[i].time), sfr = nearest(funding, k5[i].time)?.fundingRate ?? 0;
    const sA = { g30: sg30, g5: sg5, ve: sve, sweep: ssw, dd: sdd, abs: sab, cvd3: sc3, cvd8: sc8, ls: sls, fr: sfr, oiCh: soiCh, k: k5[i], envBias: sEB };
    const lA = scoreSide({ side: 'LONG', ...sA }), sAA = scoreSide({ side: 'SHORT', ...sA });
    audit.total++;
    audit.g4[0]++; if (sEB === 0) audit.g4[1]++;
    audit.g30[0]++; if (sg30.tangled) audit.g30[1]++;
    audit.liq[0]++; if (!ssw) audit.liq[1]++;
    const ofPass = sdd.bull||sdd.bear||sab.bull||sab.bear||(sc3>0&&sc8>0)||(sc3<0&&sc8<0);
    audit.of[0]++; if (!ofPass) audit.of[1]++;
    audit.score[0]++; if (Math.max(lA.score, sAA.score) < 6) audit.score[1]++;
  }

  if (JSON_MODE) { console.log(JSON.stringify({ symbol: SYMBOL, mode: 'observe-only', noTrading: true, ts: new Date().toISOString(), price: latest.close, envBias, fr, oiCh: +oiCh.toFixed(3), lsr: ls?.longShortRatio ?? null, active, long: { score: L.score, checks: L.marks }, short: { score: S.score, checks: S.marks }, audit }, null, 2)); return; }

  const out = [
    '🔮 8-Layer Dual Observation [OBSERVE ONLY]',
    '──────────',
    `📈 LONG: ${L.score}/8 ${active==='LONG'?'← ACTIVE':''}`.trim(),
    `📉 SHORT: ${S.score}/8 ${active==='SHORT'?'← ACTIVE':''}`.trim(),
    '──────────',
    `Price=${latest.close} FR=${fr.toFixed(5)} OIΔ=${oiCh.toFixed(3)}% L/S=${ls?ls.longShortRatio.toFixed(2):'n/a'}`,
    '',
    '📊 LONG 詳情:',
    ...L.marks.map((m) => `${m.s} ${m.name}\n ${m.d}`),
    '',
    '📊 SHORT 詳情:',
    ...S.marks.map((m) => `${m.s} ${m.name}\n ${m.d}`),
    '',
    `Decision: ${active} | LONG ${L.score}/8 | SHORT ${S.score}/8`,
    '',
    `═ GATE AUDIT (${audit.total} bars) ═`,
    ` 4H_GMMA+POC : rej=${audit.g4[1]}/${audit.g4[0]} (${(audit.g4[1]/Math.max(1,audit.g4[0])*100).toFixed(1)}%)`,
    ` 30M_GMMA : rej=${audit.g30[1]}/${audit.g30[0]} (${(audit.g30[1]/Math.max(1,audit.g30[0])*100).toFixed(1)}%)`,
    ` liquidity : rej=${audit.liq[1]}/${audit.liq[0]} (${(audit.liq[1]/Math.max(1,audit.liq[0])*100).toFixed(1)}%)`,
    ` order_flow : rej=${audit.of[1]}/${audit.of[0]} (${(audit.of[1]/Math.max(1,audit.of[0])*100).toFixed(1)}%)`,
    ` score<6 : rej=${audit.score[1]}/${audit.score[0]} (${(audit.score[1]/Math.max(1,audit.score[0])*100).toFixed(1)}%)`,
  ];
  console.log(out.join('\n'));
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });
