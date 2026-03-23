/**
 * 🎯 混合方案: 15m确认方向 + 5m入场 + 不同SL策略
 *
 * 测试: 15m方向确认 × {15m Swing SL, 4H Low SL} × {3R, 5R}
 * 另外: 15m确认能不能作为V96的过滤器(只在15m确认后做V96入场)
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

function swingLow(bars: K[], lb: number): { idx: number; price: number }[] {
    const s: { idx: number; price: number }[] = [];
    for (let i = lb; i < bars.length - lb; i++) {
        let ok = true;
        for (let j = i - lb; j <= i + lb; j++) { if (j !== i && bars[j].l <= bars[i].l) { ok = false; break; } }
        if (ok) s.push({ idx: i, price: bars[i].l });
    } return s;
}
function swingHigh(bars: K[], lb: number): { idx: number; price: number }[] {
    const s: { idx: number; price: number }[] = [];
    for (let i = lb; i < bars.length - lb; i++) {
        let ok = true;
        for (let j = i - lb; j <= i + lb; j++) { if (j !== i && bars[j].h >= bars[i].h) { ok = false; break; } }
        if (ok) s.push({ idx: i, price: bars[i].h });
    } return s;
}

/** 检查15m上是否有manipulation结构形成 */
function has15mManip(k15: K[], f: Fire, lb: number): { confirmed: boolean; swingPrice: number; confirmTime: number } {
    const after15 = k15.filter(k => { const d = new Date(k.ts);
        return d.toISOString().slice(0, 10) === f.date && d.getUTCHours() >= 12 && d.getUTCHours() <= 20; });
    if (after15.length < 5) return { confirmed: false, swingPrice: 0, confirmTime: 0 };

    if (f.dir === "long") {
        const sLows = swingLow(after15, lb);
        const ml = sLows.filter(s => s.price < f.c);
        if (ml.length === 0) return { confirmed: false, swingPrice: 0, confirmTime: 0 };
        return { confirmed: true, swingPrice: ml[0].price, confirmTime: after15[ml[0].idx + lb].ts };
    } else {
        const sHighs = swingHigh(after15, lb);
        const mh = sHighs.filter(s => s.price > f.c);
        if (mh.length === 0) return { confirmed: false, swingPrice: 0, confirmTime: 0 };
        return { confirmed: true, swingPrice: mh[0].price, confirmTime: after15[mh[0].idx + lb].ts };
    }
}

interface Entry { ep: number; sl: number; idx5m: number; }

/** 方案A: V96原版 (5m入场 + 4H SL) */
function stratA(k5: K[], f: Fire): Entry | null {
    const after = k5.filter(k => { const d = new Date(k.ts); return d.toISOString().slice(0, 10) === f.date && d.getUTCHours() >= 12 && d.getUTCHours() <= 20; });
    if (after.length < 10) return null;
    let manip = false;
    for (let i = 1; i < after.length; i++) {
        const b = after[i];
        if (f.dir === "long") {
            if (!manip && b.l < f.c) manip = true;
            if (manip && b.c > f.c && b.c > b.o && after[i - 1].c < f.c) return { ep: b.c, sl: f.l - 1, idx5m: k5.indexOf(b) };
        } else {
            if (!manip && b.h > f.c) manip = true;
            if (manip && b.c < f.c && b.c < b.o && after[i - 1].c > f.c) return { ep: b.c, sl: f.h + 1, idx5m: k5.indexOf(b) };
        }
    }
    return null;
}

/** 方案B: 15m确认 → 5m入场 + 15m Swing SL */
function stratB(k15: K[], k5: K[], f: Fire, lb: number): Entry | null {
    const m = has15mManip(k15, f, lb);
    if (!m.confirmed) return null;
    const after5 = k5.filter(k => k.ts >= m.confirmTime && new Date(k.ts).toISOString().slice(0, 10) === f.date && new Date(k.ts).getUTCHours() <= 20);
    for (let i = 1; i < after5.length; i++) {
        const b = after5[i], prev = after5[i - 1];
        if (f.dir === "long") {
            if (prev.c > f.c) continue;
            if (b.c > f.c && b.c > b.o) return { ep: b.c, sl: m.swingPrice - 2, idx5m: k5.indexOf(b) };
        } else {
            if (prev.c < f.c) continue;
            if (b.c < f.c && b.c < b.o) return { ep: b.c, sl: m.swingPrice + 2, idx5m: k5.indexOf(b) };
        }
    }
    return null;
}

/** 方案C: 15m确认 → 5m入场 + 4H Low SL (混合) */
function stratC(k15: K[], k5: K[], f: Fire, lb: number): Entry | null {
    const m = has15mManip(k15, f, lb);
    if (!m.confirmed) return null;
    const after5 = k5.filter(k => k.ts >= m.confirmTime && new Date(k.ts).toISOString().slice(0, 10) === f.date && new Date(k.ts).getUTCHours() <= 20);
    for (let i = 1; i < after5.length; i++) {
        const b = after5[i], prev = after5[i - 1];
        if (f.dir === "long") {
            if (prev.c > f.c) continue;
            if (b.c > f.c && b.c > b.o) return { ep: b.c, sl: f.l - 1, idx5m: k5.indexOf(b) }; // 4H Low SL!
        } else {
            if (prev.c < f.c) continue;
            if (b.c < f.c && b.c < b.o) return { ep: b.c, sl: f.h + 1, idx5m: k5.indexOf(b) };
        }
    }
    return null;
}

/** 方案D: V96入场 但只在15m确认的日子做 (15m做过滤器) */
function stratD(k15: K[], k5: K[], f: Fire, lb: number): Entry | null {
    const m = has15mManip(k15, f, lb);
    if (!m.confirmed) return null;
    // 确认后用V96的入场
    return stratA(k5, f);
}

interface Res { name: string; t: number; w: number; wr: number; pf: number; fb: number; dd: number; avgSL: number; m: Record<string, number>; }
function run(k5: K[], fires: Fire[], entries: (Entry | null)[], rPct: number, tpR: number, name: string): Res {
    const trades: { net: number; sl: number }[] = []; let bal = CAP, maxB = CAP, dd = 0; const ms: Record<string, number> = {};
    for (let i = 0; i < fires.length; i++) {
        const e = entries[i]; if (!e) continue; const f = fires[i];
        const risk = f.dir === "long" ? e.ep - e.sl : e.sl - e.ep;
        if (risk <= 1 || risk > 500) continue;
        const tp = f.dir === "long" ? e.ep + risk * tpR : e.ep - risk * tpR;
        const rA = bal * rPct; let qty = rA / risk; qty = Math.max(0.01, Math.round(qty * 1000) / 1000);
        let exitP = 0;
        for (let j = e.idx5m + 1; j < k5.length && j - e.idx5m < 120; j++) { const b = k5[j];
            if (f.dir === "long") { if (b.l <= e.sl) { exitP = e.sl; break; } if (b.h >= tp) { exitP = tp; break; } }
            else { if (b.h >= e.sl) { exitP = e.sl; break; } if (b.l <= tp) { exitP = tp; break; } } }
        if (exitP === 0) exitP = k5[Math.min(e.idx5m + 119, k5.length - 1)].c;
        const pt = f.dir === "long" ? exitP - e.ep : e.ep - exitP;
        const net = pt * qty - (e.ep * qty + exitP * qty) * FEE;
        bal += net; if (bal > maxB) maxB = bal; if (maxB - bal > dd) dd = maxB - bal;
        ms[f.date.slice(0, 7)] = (ms[f.date.slice(0, 7)] || 0) + net;
        trades.push({ net, sl: risk });
    }
    const w = trades.filter(t => t.net > 0); const tW = w.reduce((a, t) => a + t.net, 0);
    const tL = Math.abs(trades.filter(t => t.net < 0).reduce((a, t) => a + t.net, 0));
    return { name, t: trades.length, w: w.length, wr: trades.length > 0 ? w.length / trades.length * 100 : 0,
        pf: tL > 0 ? tW / tL : 999, fb: bal, dd, avgSL: trades.length > 0 ? trades.reduce((a, t) => a + t.sl, 0) / trades.length : 0, m: ms };
}
function p(r: Res) {
    const ms = Object.entries(r.m).sort().map(([k, v]) => `${k.slice(5)}:${v >= 0 ? "+" : ""}${v.toFixed(0)}`).join(" ");
    console.log(`  ${r.name.padEnd(50)} | ${String(r.t).padStart(2)}笔 ${r.wr.toFixed(0).padStart(2)}% PF=${r.pf.toFixed(2).padStart(5)} | SL=${r.avgSL.toFixed(0).padStart(3)}pt | $${r.fb.toFixed(0).padStart(5)}(${((r.fb - CAP) / CAP * 100).toFixed(0).padStart(4)}%) DD=$${r.dd.toFixed(0).padStart(4)} | ${ms}`);
}

async function main() {
    console.log("═══════════════════════════════════════════════════════════════════════════");
    console.log("  🎯 4种方案对比: 15m确认+5m入场的不同SL策略");
    console.log("═══════════════════════════════════════════════════════════════════════════\n");
    const sMs = new Date("2026-01-01T00:00:00Z").getTime(), eMs = new Date("2026-03-23T00:00:00Z").getTime();
    console.log("📥 拉取数据...");
    const kl1h = await fetchK("ETHUSDT", "1h", sMs - 7 * 86400000, eMs);
    const kl15m = await fetchK("ETHUSDT", "15m", sMs, eMs);
    const kl5m = await fetchK("ETHUSDT", "5m", sMs, eMs);
    console.log(`  1h:${kl1h.length} 15m:${kl15m.length} 5m:${kl5m.length}`);
    const fires = findFires(kl1h);

    const eA = fires.map(f => stratA(kl5m, f));
    const eB = fires.map(f => stratB(kl15m, kl5m, f, 2));
    const eC = fires.map(f => stratC(kl15m, kl5m, f, 2));
    const eD = fires.map(f => stratD(kl15m, kl5m, f, 2));

    console.log(`\n${"─".repeat(130)}`);
    console.log("  🏆 4种方案 × 10%风险");
    console.log(`${"─".repeat(130)}`);
    [
        run(kl5m, fires, eA, 0.10, 3, "A: V96纯5m + 4H SL + 3R"),
        run(kl5m, fires, eA, 0.10, 5, "A: V96纯5m + 4H SL + 5R"),
        run(kl5m, fires, eB, 0.10, 3, "B: 15m确认 + 5m入 + 15m Swing SL + 3R"),
        run(kl5m, fires, eB, 0.10, 5, "B: 15m确认 + 5m入 + 15m Swing SL + 5R"),
        run(kl5m, fires, eC, 0.10, 3, "C: 15m确认 + 5m入 + 4H SL + 3R"),
        run(kl5m, fires, eC, 0.10, 5, "C: 15m确认 + 5m入 + 4H SL + 5R"),
        run(kl5m, fires, eD, 0.10, 3, "D: 15m过滤器 + V96入场 + 4H SL + 3R"),
        run(kl5m, fires, eD, 0.10, 5, "D: 15m过滤器 + V96入场 + 4H SL + 5R"),
    ].forEach(p);

    console.log(`\n${"═".repeat(130)}`);
    console.log("  🏁 完成"); console.log(`${"═".repeat(130)}\n`);
}
main().catch(console.error);
export {};
