/**
 * 🎯 V4+V10 正确实现: 15m观察结构 + 5m入场
 *
 * V4明确教的:
 *   15m: 标出开盘区间高低点 → 观察结构(Swing HL)
 *   5m:  等收盘突破/跌破 → 确认方向
 *   1m:  精准入场
 *
 * 之前错误: 在5m上找Swing → 噪音太大 → SL=14pt被扫
 * 修正: 在15m上找Swing → 结构更清晰 → SL更合理
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

/** Swing Low on 15m (lookback=2 即前后2根15m确认) */
function swingLow15m(bars: K[], lb: number): { idx: number; price: number }[] {
    const s: { idx: number; price: number }[] = [];
    for (let i = lb; i < bars.length - lb; i++) {
        let ok = true;
        for (let j = i - lb; j <= i + lb; j++) { if (j !== i && bars[j].l <= bars[i].l) { ok = false; break; } }
        if (ok) s.push({ idx: i, price: bars[i].l });
    } return s;
}
function swingHigh15m(bars: K[], lb: number): { idx: number; price: number }[] {
    const s: { idx: number; price: number }[] = [];
    for (let i = lb; i < bars.length - lb; i++) {
        let ok = true;
        for (let j = i - lb; j <= i + lb; j++) { if (j !== i && bars[j].h >= bars[i].h) { ok = false; break; } }
        if (ok) s.push({ idx: i, price: bars[i].h });
    } return s;
}

/**
 * V4+V10 15m观察入场
 *
 * 做多:
 *   1. 在15m上: 找到Close下方的Swing Low (操纵低点)
 *   2. 在15m上: 价格反弹后形成Higher Low (不破操纵低点)
 *   3. 在5m上: 等一根阳线确认突破 → 入场
 *   SL = 15m Swing Low (比4H Low紧但比5m swing更稳定)
 */
function v10_15mEntry(k15: K[], k5: K[], f: Fire, lb: number):
    { ep: number; idx5m: number; sl: number } | null {

    // 获取当日12-20点的15m K线
    const after15 = k15.filter(k => { const d = new Date(k.ts);
        return d.toISOString().slice(0, 10) === f.date && d.getUTCHours() >= 12 && d.getUTCHours() <= 20; });
    if (after15.length < 8) return null;

    if (f.dir === "long") {
        // Step 1: 找15m上Close下方的Swing Low
        const sLows = swingLow15m(after15, lb);
        const manipLows = sLows.filter(s => s.price < f.c);
        if (manipLows.length === 0) return null;
        const manipLow = manipLows[0]; // 第一个操纵低点

        // Step 2: 操纵低点之后，看15m上是否形成HL结构
        // 找操纵后的swing high (反弹)
        const sHighs = swingHigh15m(after15, lb);
        const bounceHighs = sHighs.filter(s => s.idx > manipLow.idx);
        if (bounceHighs.length === 0) return null;
        const bounceHigh = bounceHighs[0];

        // 在bounceHigh之后，检查是否有回踩但不破manipLow的bar
        let hlBar = -1;
        for (let i = bounceHigh.idx + 1; i < after15.length; i++) {
            if (after15[i].l < manipLow.price) return null; // 破了 → 失败
            // 价格回踩到CE区间(manipLow到Close的50%)附近
            const ce50 = manipLow.price + (f.c - manipLow.price) * 0.5;
            if (after15[i].l <= ce50 && after15[i].c > after15[i].o) {
                hlBar = i;
                break;
            }
            // 如果价格强势直接突破bounceHigh也算
            if (after15[i].c > bounceHigh.price && after15[i].c > after15[i].o) {
                hlBar = i;
                break;
            }
        }
        if (hlBar < 0) return null;

        // Step 3: 切到5m，找到这个15m bar对应时间后的第一根阳线入场
        const hlTime = after15[hlBar].ts;
        const after5 = k5.filter(k => k.ts >= hlTime &&
            new Date(k.ts).toISOString().slice(0, 10) === f.date &&
            new Date(k.ts).getUTCHours() <= 20);

        for (let i = 1; i < Math.min(after5.length, 12); i++) { // 最多等1小时(12根5m)
            const b = after5[i];
            if (b.c > f.c && b.c > b.o) {
                // 5m阳线确认入场
                return {
                    ep: b.c,
                    idx5m: k5.indexOf(b),
                    sl: manipLow.price - 2
                };
            }
        }
    } else { // SHORT
        const sHighs = swingHigh15m(after15, lb);
        const manipHighs = sHighs.filter(s => s.price > f.c);
        if (manipHighs.length === 0) return null;
        const manipHigh = manipHighs[0];

        const sLows = swingLow15m(after15, lb);
        const bounceLows = sLows.filter(s => s.idx > manipHigh.idx);
        if (bounceLows.length === 0) return null;
        const bounceLow = bounceLows[0];

        let lhBar = -1;
        for (let i = bounceLow.idx + 1; i < after15.length; i++) {
            if (after15[i].h > manipHigh.price) return null;
            const ce50 = manipHigh.price - (manipHigh.price - f.c) * 0.5;
            if (after15[i].h >= ce50 && after15[i].c < after15[i].o) { lhBar = i; break; }
            if (after15[i].c < bounceLow.price && after15[i].c < after15[i].o) { lhBar = i; break; }
        }
        if (lhBar < 0) return null;

        const lhTime = after15[lhBar].ts;
        const after5 = k5.filter(k => k.ts >= lhTime &&
            new Date(k.ts).toISOString().slice(0, 10) === f.date &&
            new Date(k.ts).getUTCHours() <= 20);

        for (let i = 1; i < Math.min(after5.length, 12); i++) {
            const b = after5[i];
            if (b.c < f.c && b.c < b.o) {
                return { ep: b.c, idx5m: k5.indexOf(b), sl: manipHigh.price + 2 };
            }
        }
    }
    return null;
}

/** V96原版 */
function v96Entry(k5: K[], f: Fire): { ep: number; idx5m: number; sl: number } | null {
    const after = k5.filter(k => { const d = new Date(k.ts); return d.toISOString().slice(0, 10) === f.date && d.getUTCHours() >= 12 && d.getUTCHours() <= 20; });
    if (after.length < 10) return null;
    let manip = false;
    for (let i = 1; i < after.length; i++) {
        const b = after[i];
        if (f.dir === "long") {
            if (!manip && b.l < f.c) manip = true;
            if (manip && b.c > f.c && b.c > b.o && after[i - 1].c < f.c)
                return { ep: b.c, idx5m: k5.indexOf(b), sl: f.l - 1 };
        } else {
            if (!manip && b.h > f.c) manip = true;
            if (manip && b.c < f.c && b.c < b.o && after[i - 1].c > f.c)
                return { ep: b.c, idx5m: k5.indexOf(b), sl: f.h + 1 };
        }
    }
    return null;
}

interface Res { name: string; t: number; w: number; pnl: number; wr: number; dd: number; pf: number; fb: number; m: Record<string, number>; avgSL: number; }
function run(k5: K[], fires: Fire[], entries: ({ ep: number; idx5m: number; sl: number; dir: string } | null)[], riskPct: number, tpR: number, name: string): Res {
    const trades: { net: number; sl: number }[] = []; let bal = CAP, maxB = CAP, maxDD = 0;
    const months: Record<string, number> = {};
    for (let fi = 0; fi < fires.length; fi++) {
        const e = entries[fi]; if (!e) continue;
        const f = fires[fi];
        const risk = f.dir === "long" ? e.ep - e.sl : e.sl - e.ep;
        if (risk <= 1 || risk > 500) continue;
        const tp = f.dir === "long" ? e.ep + risk * tpR : e.ep - risk * tpR;
        const rA = bal * riskPct; let qty = rA / risk; qty = Math.max(0.01, Math.round(qty * 1000) / 1000);
        let exitP = 0;
        for (let j = e.idx5m + 1; j < k5.length && j - e.idx5m < 120; j++) {
            const b = k5[j];
            if (f.dir === "long") { if (b.l <= e.sl) { exitP = e.sl; break; } if (b.h >= tp) { exitP = tp; break; } }
            else { if (b.h >= e.sl) { exitP = e.sl; break; } if (b.l <= tp) { exitP = tp; break; } }
        }
        if (exitP === 0) exitP = k5[Math.min(e.idx5m + 119, k5.length - 1)].c;
        const pt = f.dir === "long" ? exitP - e.ep : e.ep - exitP;
        const net = pt * qty - (e.ep * qty + exitP * qty) * FEE;
        bal += net; if (bal > maxB) maxB = bal; const dd = maxB - bal; if (dd > maxDD) maxDD = dd;
        months[f.date.slice(0, 7)] = (months[f.date.slice(0, 7)] || 0) + net;
        trades.push({ net, sl: risk });
    }
    const w = trades.filter(t => t.net > 0); const tW = w.reduce((a, t) => a + t.net, 0);
    const tL = Math.abs(trades.filter(t => t.net < 0).reduce((a, t) => a + t.net, 0));
    return { name, t: trades.length, w: w.length, pnl: trades.reduce((a, t) => a + t.net, 0),
        wr: trades.length > 0 ? w.length / trades.length * 100 : 0, dd: maxDD,
        pf: tL > 0 ? tW / tL : 999, fb: bal, m: months,
        avgSL: trades.length > 0 ? trades.reduce((a, t) => a + t.sl, 0) / trades.length : 0 };
}

function print(results: Res[]) {
    for (const r of results) {
        const ms = Object.entries(r.m).sort().map(([k, v]) => `${k.slice(5)}:${v >= 0 ? "+" : ""}${v.toFixed(0)}`).join(" ");
        console.log(`  ${r.name.padEnd(45)} | ${String(r.t).padStart(2)}笔 ${r.wr.toFixed(0).padStart(2)}% PF=${r.pf.toFixed(2).padStart(5)} | 均SL=${r.avgSL.toFixed(0).padStart(3)}pt | $${r.fb.toFixed(0).padStart(5)}(${((r.fb - CAP) / CAP * 100).toFixed(0).padStart(4)}%) DD=$${r.dd.toFixed(0).padStart(4)} | ${ms}`);
    }
}

async function main() {
    console.log("═══════════════════════════════════════════════════════════════════════");
    console.log("  🎯 V4+V10: 15m观察结构 + 5m入场");
    console.log("═══════════════════════════════════════════════════════════════════════\n");
    const sMs = new Date("2026-01-01T00:00:00Z").getTime(), eMs = new Date("2026-03-23T00:00:00Z").getTime();
    console.log("📥 拉取数据...");
    const kl1h = await fetchK("ETHUSDT", "1h", sMs - 7 * 86400000, eMs);
    const kl15m = await fetchK("ETHUSDT", "15m", sMs, eMs);
    const kl5m = await fetchK("ETHUSDT", "5m", sMs, eMs);
    console.log(`  1h:${kl1h.length} 15m:${kl15m.length} 5m:${kl5m.length}`);
    const fires = findFires(kl1h);

    // 预计算入场
    const v96Entries = fires.map(f => { const e = v96Entry(kl5m, f); return e ? { ...e, dir: f.dir } : null; });
    const v10_lb2 = fires.map(f => { const e = v10_15mEntry(kl15m, kl5m, f, 2); return e ? { ...e, dir: f.dir } : null; });
    const v10_lb3 = fires.map(f => { const e = v10_15mEntry(kl15m, kl5m, f, 3); return e ? { ...e, dir: f.dir } : null; });

    // R1: V96 vs V10 15m
    console.log(`\n${"─".repeat(120)}`);
    console.log("  🔬 R1: V96 vs V10(15m观察) — 10%风险");
    console.log(`${"─".repeat(120)}`);
    print([
        run(kl5m, fires, v96Entries, 0.10, 3, "V96(5m入场+4H SL) + 3R"),
        run(kl5m, fires, v96Entries, 0.10, 5, "V96(5m入场+4H SL) + 5R"),
        run(kl5m, fires, v10_lb2, 0.10, 3, "V10(15m Swing lb=2 + CE50%) + 3R"),
        run(kl5m, fires, v10_lb2, 0.10, 5, "V10(15m Swing lb=2 + CE50%) + 5R"),
        run(kl5m, fires, v10_lb3, 0.10, 3, "V10(15m Swing lb=3 + CE50%) + 3R"),
        run(kl5m, fires, v10_lb3, 0.10, 5, "V10(15m Swing lb=3 + CE50%) + 5R"),
    ]);

    // R2: 不同风险
    console.log(`\n${"─".repeat(120)}`);
    console.log("  🔬 R2: V10 15m × 不同风险%");
    console.log(`${"─".repeat(120)}`);
    print([
        run(kl5m, fires, v10_lb2, 0.05, 3, "V10 15m lb=2 + 5% + 3R"),
        run(kl5m, fires, v10_lb2, 0.05, 5, "V10 15m lb=2 + 5% + 5R"),
        run(kl5m, fires, v10_lb2, 0.10, 3, "V10 15m lb=2 + 10% + 3R"),
        run(kl5m, fires, v10_lb2, 0.10, 5, "V10 15m lb=2 + 10% + 5R"),
    ]);

    console.log(`\n${"═".repeat(120)}`);
    console.log("  🏁 完成"); console.log(`${"═".repeat(120)}\n`);
}
main().catch(console.error);
export {};
