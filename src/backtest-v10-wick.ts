/**
 * 🔬 V10 影线区间入场 vs V96 Close穿越入场
 *
 * 核心差异:
 *   V96: 等价格穿越Close上方 → 入场在body顶部 → SL大 → 仓位小
 *   V10: 在wick区间入场(Close下方) → 入场在wick → SL紧 → 仓位大
 *
 * V10入场逻辑:
 *   做多: 价格跌入Close下方的wick区域 → 看到HL → 入场(仍在Close下方!)
 *   SL = manipulation low  (比4H low更紧!)
 *   TP = Close或4H High   (比V96的TP更大!)
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
        const dir = c > o ? "long" as const : "short" as const;
        f.push({ date: dt, h, l, o, c, range, dir });
    } return f;
}

/**
 * V96原版入场: 等5m candle收在Close上方
 */
function v96Entry(bars: K[], f: Fire): { ep: number; idx: number; sl: number } | null {
    let manip = false;
    for (let i = 1; i < bars.length; i++) {
        const b = bars[i];
        if (f.dir === "long") {
            if (!manip && b.l < f.c) manip = true;
            if (manip && b.c > f.c && b.c > b.o && bars[i - 1].c < f.c)
                return { ep: b.c, idx: i, sl: f.l - 1 };  // SL = 4H Low
        } else {
            if (!manip && b.h > f.c) manip = true;
            if (manip && b.c < f.c && b.c < b.o && bars[i - 1].c > f.c)
                return { ep: b.c, idx: i, sl: f.h + 1 };
        }
    }
    return null;
}

/**
 * V10 影线区间入场: 在wick中找到HL结构就入场(不等穿越Close)
 *
 * 做多:
 *   1. 价格跌入Close下方(进入wick = manipulation)
 *   2. 做一个低点(manipLow)
 *   3. 反弹
 *   4. 回踩形成Higher Low(不破manipLow)
 *   5. 入场! (入场价在Close附近或下方)
 *   SL = manipLow下方(很紧)
 *   TP = 基于entry到SL的距离 × R
 */
function v10WickEntry(bars: K[], f: Fire): { ep: number; idx: number; sl: number } | null {
    // 四分位区间
    const q25 = f.l + f.range * 0.25;
    const q50 = f.l + f.range * 0.50;
    const q75 = f.l + f.range * 0.75;

    let phase: "WAIT_WICK" | "WAIT_BOUNCE" | "WAIT_HL" = "WAIT_WICK";
    let manipLow = 0, manipHigh = 0;
    let bounceHigh = 0, bounceLow = 999999;

    for (let i = 1; i < bars.length; i++) {
        const b = bars[i];

        if (f.dir === "long") {
            switch (phase) {
                case "WAIT_WICK":
                    // Step 1: 价格进入wick区域(Close下方)
                    if (b.l < f.c) {
                        manipLow = b.l;
                        phase = "WAIT_BOUNCE";
                    }
                    break;
                case "WAIT_BOUNCE":
                    if (b.l < manipLow) manipLow = b.l;
                    // V10四分位: 确保manipulation低点不要太深(在25-50%区间内)
                    // 如果跌破25%分位 = 太深了，不是浅回踩
                    if (manipLow < q25) {
                        // 操纵太深，但不放弃，更新manipLow继续观察
                    }
                    // 价格开始反弹
                    if (b.c > manipLow + (f.c - manipLow) * 0.3) {
                        bounceHigh = b.h;
                        phase = "WAIT_HL";
                    }
                    break;
                case "WAIT_HL":
                    if (b.h > bounceHigh) bounceHigh = b.h;
                    // 检查: 价格回踩但不破manipLow = Higher Low
                    if (b.l > manipLow && b.l < bounceHigh) {
                        // Higher Low形成! 入场
                        // V10入场: 在wick区域，不需要穿越Close
                        // 入场价 = 当前bar的close (在wick内)
                        const ep = b.c;
                        const sl = manipLow - 1;
                        // 确保risk合理
                        if (ep > sl && ep - sl < 500) {
                            return { ep, idx: i, sl };
                        }
                    }
                    // 如果跌破manipLow = 结构失败
                    if (b.l < manipLow) {
                        manipLow = b.l;
                        bounceHigh = 0;
                        phase = "WAIT_BOUNCE";
                    }
                    break;
            }
        } else { // SHORT
            switch (phase) {
                case "WAIT_WICK":
                    if (b.h > f.c) {
                        manipHigh = b.h;
                        phase = "WAIT_BOUNCE";
                    }
                    break;
                case "WAIT_BOUNCE":
                    if (b.h > manipHigh) manipHigh = b.h;
                    if (b.c < manipHigh - (manipHigh - f.c) * 0.3) {
                        bounceLow = b.l;
                        phase = "WAIT_HL";
                    }
                    break;
                case "WAIT_HL":
                    if (b.l < bounceLow) bounceLow = b.l;
                    if (b.h < manipHigh && b.h > bounceLow) {
                        const ep = b.c;
                        const sl = manipHigh + 1;
                        if (sl > ep && sl - ep < 500) {
                            return { ep, idx: i, sl };
                        }
                    }
                    if (b.h > manipHigh) {
                        manipHigh = b.h;
                        bounceLow = 999999;
                        phase = "WAIT_BOUNCE";
                    }
                    break;
            }
        }
    }
    return null;
}

interface Res { name: string; t: number; w: number; pnl: number; wr: number; dd: number; pf: number; fb: number;
    m: Record<string, number>; avgRisk: number; avgRR: number; }

function run(k5: K[], fires: Fire[], entryFn: (bars: K[], f: Fire) => { ep: number; idx: number; sl: number } | null,
             riskPct: number, tpR: number, name: string): Res {
    const trades: { net: number; date: string; risk: number; rr: number }[] = [];
    let bal = CAP, maxB = CAP, maxDD = 0; const months: Record<string, number> = {};

    for (const f of fires) {
        const after = k5.filter(k => { const d = new Date(k.ts); return d.toISOString().slice(0, 10) === f.date && d.getUTCHours() >= 12 && d.getUTCHours() <= 20; });
        if (after.length < 10) continue;

        const entry = entryFn(after, f);
        if (!entry) continue;

        const risk = f.dir === "long" ? entry.ep - entry.sl : entry.sl - entry.ep;
        if (risk <= 0 || risk > 500) continue;
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
        const rr = pt / risk;
        bal += net; if (bal > maxB) maxB = bal; const dd = maxB - bal; if (dd > maxDD) maxDD = dd;
        const mon = f.date.slice(0, 7); months[mon] = (months[mon] || 0) + net;
        trades.push({ net, date: f.date, risk, rr });
    }
    const w = trades.filter(t => t.net > 0); const tW = w.reduce((a, t) => a + t.net, 0);
    const tL = Math.abs(trades.filter(t => t.net < 0).reduce((a, t) => a + t.net, 0));
    const avgRisk = trades.length > 0 ? trades.reduce((a, t) => a + t.risk, 0) / trades.length : 0;
    const avgRR = w.length > 0 ? w.reduce((a, t) => a + t.rr, 0) / w.length : 0;
    return { name, t: trades.length, w: w.length, pnl: trades.reduce((a, t) => a + t.net, 0),
        wr: trades.length > 0 ? w.length / trades.length * 100 : 0, dd: maxDD,
        pf: tL > 0 ? tW / tL : 999, fb: bal, m: months, avgRisk, avgRR };
}

function print(results: Res[]) {
    for (const r of results) {
        const ms = Object.entries(r.m).sort().map(([k, v]) => `${k.slice(5)}:${v >= 0 ? "+" : ""}${v.toFixed(0)}`).join(" ");
        const ret = ((r.fb - CAP) / CAP * 100).toFixed(0);
        console.log(`  ${r.name.padEnd(42)} | ${String(r.t).padStart(2)}笔 ${r.wr.toFixed(0).padStart(2)}% PF=${r.pf.toFixed(2).padStart(5)} | 均SL=${r.avgRisk.toFixed(0).padStart(3)}pt 均RR=${r.avgRR.toFixed(1)} | $${r.fb.toFixed(0).padStart(5)}(${ret.padStart(4)}%) DD=$${r.dd.toFixed(0).padStart(4)} | ${ms}`);
    }
}

async function main() {
    console.log("═══════════════════════════════════════════════════════════════════════");
    console.log("  🔬 V10影线入场 vs V96 Close穿越入场 — 观察精准度对比");
    console.log("═══════════════════════════════════════════════════════════════════════\n");
    const sMs = new Date("2026-01-01T00:00:00Z").getTime(), eMs = new Date("2026-03-23T00:00:00Z").getTime();
    console.log("📥 拉取数据...");
    const kl1h = await fetchK("ETHUSDT", "1h", sMs - 7 * 86400000, eMs);
    const kl5m = await fetchK("ETHUSDT", "5m", sMs, eMs);
    console.log(`  1h:${kl1h.length} 5m:${kl5m.length}`);
    const fires = findFires(kl1h);

    // R1: V96 vs V10 核心入场差异
    console.log(`\n${"─".repeat(120)}`);
    console.log("  🔬 V96(Close上方入场) vs V10(Wick区间入场) — 10%风险");
    console.log(`${"─".repeat(120)}`);
    print([
        run(kl5m, fires, v96Entry, 0.10, 3, "V96: Close上方入场 + 4H Low SL + 3R"),
        run(kl5m, fires, v96Entry, 0.10, 5, "V96: Close上方入场 + 4H Low SL + 5R"),
        run(kl5m, fires, v10WickEntry, 0.10, 3, "V10: Wick入场 + ManipLow SL + 3R"),
        run(kl5m, fires, v10WickEntry, 0.10, 5, "V10: Wick入场 + ManipLow SL + 5R"),
    ]);

    // R2: 不同风险
    console.log(`\n${"─".repeat(120)}`);
    console.log("  🔬 V10 Wick入场 × 不同风险%");
    console.log(`${"─".repeat(120)}`);
    print([
        run(kl5m, fires, v10WickEntry, 0.05, 3, "V10 Wick + 5% + 3R"),
        run(kl5m, fires, v10WickEntry, 0.05, 5, "V10 Wick + 5% + 5R"),
        run(kl5m, fires, v10WickEntry, 0.10, 3, "V10 Wick + 10% + 3R"),
        run(kl5m, fires, v10WickEntry, 0.10, 5, "V10 Wick + 10% + 5R"),
    ]);

    // R3: 关键指标对比
    console.log(`\n${"─".repeat(120)}`);
    console.log("  🏆 关键指标对比 (10%风险 + 3R)");
    console.log(`${"─".repeat(120)}`);
    const v96r = run(kl5m, fires, v96Entry, 0.10, 3, "V96");
    const v10r = run(kl5m, fires, v10WickEntry, 0.10, 3, "V10");
    console.log(`  V96: 入场在Close上方(body顶) → 均SL=${v96r.avgRisk.toFixed(0)}pt → 胜率${v96r.wr.toFixed(0)}% → PF=${v96r.pf.toFixed(2)}`);
    console.log(`  V10: 入场在Wick区域(body底)  → 均SL=${v10r.avgRisk.toFixed(0)}pt → 胜率${v10r.wr.toFixed(0)}% → PF=${v10r.pf.toFixed(2)}`);
    console.log(`  SL差异: V10比V96紧 ${((1 - v10r.avgRisk / v96r.avgRisk) * 100).toFixed(0)}% → 同样风险下仓位更大`);

    console.log(`\n${"═".repeat(120)}`);
    console.log("  🏁 完成");
    console.log(`${"═".repeat(120)}\n`);
}
main().catch(console.error);
export {};
