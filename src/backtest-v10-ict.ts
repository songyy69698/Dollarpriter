/**
 * 🎯 V10 精准观察入场 — 基于ICT正确实现
 *
 * 网络学习到的3个关键修正:
 * 1. Swing HL: lookback ≥ 3根K线确认，而非连续2根比较
 * 2. Wick入场: 在manipulation wick的50%(Consequent Encroachment/CE)
 * 3. MSS确认: full-bodied candle突破swing，而非wick刺穿
 *
 * ICT Consequent Encroachment: wick的50%位置是最佳入场/反应点
 * 如果价格回踩超过wick的50%，表示该方向动能弱
 */
const FEE = 0.0004, CAP = 500;
interface K { ts: number; o: number; h: number; l: number; c: number; v: number; }
async function fetchK(s: string, iv: string, st: number, e: number): Promise<K[]> {
    const a: K[] = []; let c = st;
    while (c < e) { const u = `https://api.binance.com/api/v3/klines?symbol=${s}&interval=${iv}&startTime=${c}&endTime=${e}&limit=1500`;
        const r = await fetch(u); if (!r.ok) { await Bun.sleep(5000); continue; } const d = await r.json() as any[][]; if (!d.length) break;
        for (const k of d) a.push({ ts: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }); c = d[d.length - 1][6] + 1; await Bun.sleep(150); } return a; }

interface Fire { date: string; h: number; l: number; o: number; c: number; range: number; dir: "long" | "short"; }
function findFires(kl: K[]): Fire[] {
    const f: Fire[] = []; const dm = new Map<string, K[]>();
    for (const k of kl) { const d = new Date(k.ts).toISOString().slice(0, 10); if (!dm.has(d)) dm.set(d, []); dm.get(d)!.push(k); }
    for (const [dt, bars] of dm) {
        const w = bars.filter(k => { const h = new Date(k.ts).getUTCHours(); return h >= 8 && h < 12; });
        if (w.length < 2) continue;
        const o = w[0].o, c = w[w.length - 1].c, h = Math.max(...w.map(k => k.h)), l = Math.min(...w.map(k => k.l));
        const range = h - l; if (range < 3) continue;
        f.push({ date: dt, h, l, o, c, range, dir: c > o ? "long" : "short" });
    } return f;
}

/**
 * Swing Low检测 (ICT正确实现)
 * 一个bar是swing low: 它的low是前N根和后N根中最低的
 */
function findSwingLows(bars: K[], lookback: number): { idx: number; price: number }[] {
    const swings: { idx: number; price: number }[] = [];
    for (let i = lookback; i < bars.length - lookback; i++) {
        let isSwingLow = true;
        for (let j = i - lookback; j <= i + lookback; j++) {
            if (j === i) continue;
            if (bars[j].l <= bars[i].l) { isSwingLow = false; break; }
        }
        if (isSwingLow) swings.push({ idx: i, price: bars[i].l });
    }
    return swings;
}
function findSwingHighs(bars: K[], lookback: number): { idx: number; price: number }[] {
    const swings: { idx: number; price: number }[] = [];
    for (let i = lookback; i < bars.length - lookback; i++) {
        let isSwingHigh = true;
        for (let j = i - lookback; j <= i + lookback; j++) {
            if (j === i) continue;
            if (bars[j].h >= bars[i].h) { isSwingHigh = false; break; }
        }
        if (isSwingHigh) swings.push({ idx: i, price: bars[i].h });
    }
    return swings;
}

/**
 * V10精准入场 (ICT正确版)
 *
 * 做多:
 *   1. 价格跌入Close下方 (进入manipulation zone)
 *   2. 用Swing Low检测找到真正的操纵低点 (lookback=3,即前后3根确认)
 *   3. 价格反弹形成swing high
 *   4. 价格回踩到wick的CE(50%)位置但不破swing low → 入场
 *   SL = swing low 下方
 */
function v10PreciseEntry(bars: K[], f: Fire, swingLookback: number):
    { ep: number; idx: number; sl: number } | null {

    // Step 1: 找到操纵区域 — 价格跌入Close下方后的第一个有效Swing Low
    if (f.dir === "long") {
        // 找Close下方的swing lows
        const swL = findSwingLows(bars, swingLookback);
        const manipSwings = swL.filter(s => bars[s.idx].l < f.c);
        if (manipSwings.length === 0) return null;

        // 取第一个有效的swing low (操纵低点)
        const manipLow = manipSwings[0];

        // Step 2: 操纵后的swing high (反弹高点)
        const swH = findSwingHighs(bars, swingLookback);
        const bounceHighs = swH.filter(s => s.idx > manipLow.idx);
        if (bounceHighs.length === 0) return null;
        const bounceHigh = bounceHighs[0];

        // CE (Consequent Encroachment) = wick的50%
        // wick = manipLow到Close之间
        const wickLow = manipLow.price;
        const wickHigh = f.c; // 或bounceHigh.price
        const ce50 = wickLow + (wickHigh - wickLow) * 0.5;

        // Step 3: 回踩到CE附近但不破swing low
        for (let i = bounceHigh.idx + 1; i < bars.length; i++) {
            const b = bars[i];

            // 如果跌破swing low = 结构失败
            if (b.l < manipLow.price) return null;

            // 价格回踩到CE附近(到达CE50%区域) + full-bodied bullish candle确认
            if (b.l <= ce50 && b.c > b.o && (b.c - b.o) / (b.h - b.l + 0.01) > 0.3) {
                // MSS确认: 用body close而非wick
                return {
                    ep: b.c,
                    idx: i,
                    sl: manipLow.price - 2  // SL在swing low下方
                };
            }
        }
    } else { // SHORT
        const swH = findSwingHighs(bars, swingLookback);
        const manipSwings = swH.filter(s => bars[s.idx].h > f.c);
        if (manipSwings.length === 0) return null;
        const manipHigh = manipSwings[0];

        const swL = findSwingLows(bars, swingLookback);
        const bounceLows = swL.filter(s => s.idx > manipHigh.idx);
        if (bounceLows.length === 0) return null;
        const bounceLow = bounceLows[0];

        const wickHigh = manipHigh.price;
        const wickLow = f.c;
        const ce50 = wickHigh - (wickHigh - wickLow) * 0.5;

        for (let i = bounceLow.idx + 1; i < bars.length; i++) {
            const b = bars[i];
            if (b.h > manipHigh.price) return null;
            if (b.h >= ce50 && b.c < b.o && (b.o - b.c) / (b.h - b.l + 0.01) > 0.3) {
                return { ep: b.c, idx: i, sl: manipHigh.price + 2 };
            }
        }
    }
    return null;
}

/** V96原版入场 */
function v96Entry(bars: K[], f: Fire): { ep: number; idx: number; sl: number } | null {
    let manip = false;
    for (let i = 1; i < bars.length; i++) {
        const b = bars[i];
        if (f.dir === "long") {
            if (!manip && b.l < f.c) manip = true;
            if (manip && b.c > f.c && b.c > b.o && bars[i - 1].c < f.c)
                return { ep: b.c, idx: i, sl: f.l - 1 };
        } else {
            if (!manip && b.h > f.c) manip = true;
            if (manip && b.c < f.c && b.c < b.o && bars[i - 1].c > f.c)
                return { ep: b.c, idx: i, sl: f.h + 1 };
        }
    }
    return null;
}

interface Res { name: string; t: number; w: number; pnl: number; wr: number; dd: number; pf: number; fb: number;
    m: Record<string, number>; avgSL: number; }

function run(k5: K[], fires: Fire[], entryFn: (bars: K[], f: Fire) => { ep: number; idx: number; sl: number } | null,
    riskPct: number, tpR: number, name: string): Res {
    const trades: { net: number; sl: number }[] = []; let bal = CAP, maxB = CAP, maxDD = 0;
    const months: Record<string, number> = {};
    for (const f of fires) {
        const after = k5.filter(k => { const d = new Date(k.ts); return d.toISOString().slice(0, 10) === f.date && d.getUTCHours() >= 12 && d.getUTCHours() <= 20; });
        if (after.length < 15) continue;
        const entry = entryFn(after, f); if (!entry) continue;
        const risk = f.dir === "long" ? entry.ep - entry.sl : entry.sl - entry.ep;
        if (risk <= 1 || risk > 500) continue;
        const tp = f.dir === "long" ? entry.ep + risk * tpR : entry.ep - risk * tpR;
        const rA = bal * riskPct; let qty = rA / risk; qty = Math.max(0.01, Math.round(qty * 1000) / 1000);
        const si = k5.findIndex(k => k.ts === after[entry.idx].ts); if (si < 0) continue;
        let exitP = 0;
        for (let j = si + 1; j < k5.length && j - si < 120; j++) { const b = k5[j];
            if (f.dir === "long") { if (b.l <= entry.sl) { exitP = entry.sl; break; } if (b.h >= tp) { exitP = tp; break; } }
            else { if (b.h >= entry.sl) { exitP = entry.sl; break; } if (b.l <= tp) { exitP = tp; break; } } }
        if (exitP === 0) exitP = k5[Math.min(si + 119, k5.length - 1)].c;
        const pt = f.dir === "long" ? exitP - entry.ep : entry.ep - exitP;
        const net = pt * qty - (entry.ep * qty + exitP * qty) * FEE;
        bal += net; if (bal > maxB) maxB = bal; const dd = maxB - bal; if (dd > maxDD) maxDD = dd;
        const mon = f.date.slice(0, 7); months[mon] = (months[mon] || 0) + net;
        trades.push({ net, sl: risk });
    }
    const w = trades.filter(t => t.net > 0); const tW = w.reduce((a, t) => a + t.net, 0);
    const tL = Math.abs(trades.filter(t => t.net < 0).reduce((a, t) => a + t.net, 0));
    const avgSL = trades.length > 0 ? trades.reduce((a, t) => a + t.sl, 0) / trades.length : 0;
    return { name, t: trades.length, w: w.length, pnl: trades.reduce((a, t) => a + t.net, 0),
        wr: trades.length > 0 ? w.length / trades.length * 100 : 0, dd: maxDD,
        pf: tL > 0 ? tW / tL : 999, fb: bal, m: months, avgSL };
}

function print(results: Res[]) {
    for (const r of results) {
        const ms = Object.entries(r.m).sort().map(([k, v]) => `${k.slice(5)}:${v >= 0 ? "+" : ""}${v.toFixed(0)}`).join(" ");
        console.log(`  ${r.name.padEnd(42)} | ${String(r.t).padStart(2)}笔 ${r.wr.toFixed(0).padStart(2)}% PF=${r.pf.toFixed(2).padStart(5)} | 均SL=${r.avgSL.toFixed(0).padStart(3)}pt | $${r.fb.toFixed(0).padStart(5)}(${((r.fb - CAP) / CAP * 100).toFixed(0).padStart(4)}%) DD=$${r.dd.toFixed(0).padStart(4)} | ${ms}`);
    }
}

async function main() {
    console.log("═══════════════════════════════════════════════════════════════════════");
    console.log("  🎯 V10 ICT精准入场 — Swing检测+CE50%入场+MSS确认");
    console.log("═══════════════════════════════════════════════════════════════════════\n");
    const sMs = new Date("2026-01-01T00:00:00Z").getTime(), eMs = new Date("2026-03-23T00:00:00Z").getTime();
    console.log("📥 拉取数据...");
    const kl1h = await fetchK("ETHUSDT", "1h", sMs - 7 * 86400000, eMs);
    const kl5m = await fetchK("ETHUSDT", "5m", sMs, eMs);
    console.log(`  1h:${kl1h.length} 5m:${kl5m.length}`);
    const fires = findFires(kl1h);

    // R1: 不同Swing lookback比较
    console.log(`\n${"─".repeat(115)}`);
    console.log("  🔬 R1: Swing lookback期间比较 (10%风险, 3R)");
    console.log(`${"─".repeat(115)}`);
    print([
        run(kl5m, fires, v96Entry, 0.10, 3, "V96基线(Close穿越+4H SL)"),
        run(kl5m, fires, (b, f) => v10PreciseEntry(b, f, 2), 0.10, 3, "V10 ICT lookback=2 + CE50% + 3R"),
        run(kl5m, fires, (b, f) => v10PreciseEntry(b, f, 3), 0.10, 3, "V10 ICT lookback=3 + CE50% + 3R"),
        run(kl5m, fires, (b, f) => v10PreciseEntry(b, f, 5), 0.10, 3, "V10 ICT lookback=5 + CE50% + 3R"),
    ]);

    // R2: 最优lookback × TP
    console.log(`\n${"─".repeat(115)}`);
    console.log("  🔬 R2: 最优lookback × TP (10%风险)");
    console.log(`${"─".repeat(115)}`);
    print([
        run(kl5m, fires, (b, f) => v10PreciseEntry(b, f, 3), 0.10, 2, "V10 ICT lb=3 + 2R"),
        run(kl5m, fires, (b, f) => v10PreciseEntry(b, f, 3), 0.10, 3, "V10 ICT lb=3 + 3R"),
        run(kl5m, fires, (b, f) => v10PreciseEntry(b, f, 3), 0.10, 5, "V10 ICT lb=3 + 5R"),
    ]);

    // R3: 终极对比
    console.log(`\n${"─".repeat(115)}`);
    console.log("  🏆 R3: 终极对比 (10%风险)");
    console.log(`${"─".repeat(115)}`);
    print([
        run(kl5m, fires, v96Entry, 0.10, 3, "V96(Close穿越+4H SL)"),
        run(kl5m, fires, v96Entry, 0.10, 5, "V96 + 5R"),
        run(kl5m, fires, (b, f) => v10PreciseEntry(b, f, 3), 0.10, 3, "V10 ICT精准(CE50%+SwingSL) + 3R"),
        run(kl5m, fires, (b, f) => v10PreciseEntry(b, f, 3), 0.10, 5, "V10 ICT精准(CE50%+SwingSL) + 5R"),
    ]);

    console.log(`\n${"═".repeat(115)}`);
    console.log("  🏁 完成"); console.log(`${"═".repeat(115)}\n`);
}
main().catch(console.error);
export {};
