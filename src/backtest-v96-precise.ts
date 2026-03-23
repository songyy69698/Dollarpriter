/**
 * 🎯 V96 精准过滤组合回测
 * 基于逐笔分析发现的4个高质量因素:
 *   1. 4H区间≥30pt (73%胜率@60pt+)
 *   2. 回踩深度<30% (64%胜率@<10%)
 *   3. 反向影线<25% (71%胜率@<10%)
 *   4. 入场UTC 12-14 (贡献$865/70笔)
 */
const FEE = 0.0004, CAP = 500;
interface K { ts: number; o: number; h: number; l: number; c: number; v: number; }
async function fetchK(s: string, iv: string, st: number, e: number): Promise<K[]> {
    const a: K[] = []; let c = st;
    while (c < e) { const u = `https://api.binance.com/api/v3/klines?symbol=${s}&interval=${iv}&startTime=${c}&endTime=${e}&limit=1500`;
        const r = await fetch(u); if (!r.ok) { await Bun.sleep(5000); continue; } const d = await r.json() as any[][]; if (!d.length) break;
        for (const k of d) a.push({ ts: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }); c = d[d.length - 1][6] + 1; await Bun.sleep(150); } return a; }

interface Fire {
    date: string; h: number; l: number; o: number; c: number;
    bodyR: number; range: number; dir: "long" | "short";
    upperWick: number; lowerWick: number;
}
function findFires(kl: K[]): Fire[] {
    const f: Fire[] = []; const dm = new Map<string, K[]>();
    for (const k of kl) { const d = new Date(k.ts).toISOString().slice(0, 10); if (!dm.has(d)) dm.set(d, []); dm.get(d)!.push(k); }
    for (const [dt, bars] of dm) {
        const w = bars.filter(k => { const h = new Date(k.ts).getUTCHours(); return h >= 8 && h < 12; });
        if (w.length < 2) continue;
        const o = w[0].o, c = w[w.length - 1].c, h = Math.max(...w.map(k => k.h)), l = Math.min(...w.map(k => k.l));
        const body = Math.abs(c - o), range = h - l; if (range < 3) continue;
        const dir = c > o ? "long" as const : "short" as const;
        const uW = dir === "long" ? (h - c) / range : (h - o) / range;
        const lW = dir === "long" ? (o - l) / range : (c - l) / range;
        f.push({ date: dt, h, l, o, c, bodyR: body / range, range, dir, upperWick: uW, lowerWick: lW });
    } return f;
}

interface Cfg {
    name: string;
    minRange: number;       // 最小4H区间(pt)
    maxManipPct: number;    // 最大回踩深度(占区间%)
    maxCounterWick: number; // 最大反向影线比
    tradeEndH: number;      // 交易窗口结束(UTC)
    riskPct: number; tpR: number;
}
interface Res { cfg: Cfg; t: number; w: number; pnl: number; wr: number; dd: number; pf: number; fb: number; m: Record<string, number>; d: number; }

function run(k5: K[], fires: Fire[], cfg: Cfg): Res {
    const trades: { net: number; date: string }[] = [];
    let bal = CAP, maxB = CAP, maxDD = 0; const months: Record<string, number> = {};
    for (const f of fires) {
        // 精准过滤1: 最小区间
        if (f.range < cfg.minRange) continue;
        // 精准过滤3: 反向影线
        const counterWick = f.dir === "long" ? f.upperWick : f.lowerWick;
        if (counterWick > cfg.maxCounterWick) continue;

        const after = k5.filter(k => {
            const d = new Date(k.ts); return d.toISOString().slice(0, 10) === f.date && d.getUTCHours() >= 12 && d.getUTCHours() <= cfg.tradeEndH;
        });
        if (after.length < 5) continue;
        let ep = 0, ei = -1, manip = false, manipExt = 0;
        for (let i = 1; i < after.length; i++) {
            const b = after[i]; if (ep > 0) break;
            if (f.dir === "long") {
                if (!manip && b.l < f.c) { manip = true; manipExt = b.l; }
                if (manip) { if (b.l < manipExt) manipExt = b.l;
                    // 精准过滤2: 回踩深度
                    const depth = (f.c - manipExt) / f.range;
                    if (depth > cfg.maxManipPct) continue;
                    if (b.c > f.c && b.c > b.o && after[i - 1].c < f.c) { ep = b.c; ei = i; }
                }
            } else {
                if (!manip && b.h > f.c) { manip = true; manipExt = b.h; }
                if (manip) { if (b.h > manipExt) manipExt = b.h;
                    const depth = (manipExt - f.c) / f.range;
                    if (depth > cfg.maxManipPct) continue;
                    if (b.c < f.c && b.c < b.o && after[i - 1].c > f.c) { ep = b.c; ei = i; }
                }
            }
        }
        if (ep === 0) continue;
        const sl = f.dir === "long" ? f.l - 1 : f.h + 1;
        const risk = f.dir === "long" ? ep - sl : sl - ep;
        if (risk <= 0 || risk > 500) continue;
        const tp = f.dir === "long" ? ep + risk * cfg.tpR : ep - risk * cfg.tpR;
        const rA = bal * cfg.riskPct; let qty = rA / risk; qty = Math.max(0.01, Math.round(qty * 1000) / 1000);
        const si = k5.findIndex(k => k.ts === after[ei].ts); if (si < 0) continue;
        let exitP = 0;
        for (let j = si + 1; j < k5.length && j - si < 120; j++) { const b = k5[j];
            if (f.dir === "long") { if (b.l <= sl) { exitP = sl; break; } if (b.h >= tp) { exitP = tp; break; } }
            else { if (b.h >= sl) { exitP = sl; break; } if (b.l <= tp) { exitP = tp; break; } } }
        if (exitP === 0) exitP = k5[Math.min(si + 119, k5.length - 1)].c;
        const pt = f.dir === "long" ? exitP - ep : ep - exitP;
        const net = pt * qty - (ep * qty + exitP * qty) * FEE;
        bal += net; if (bal > maxB) maxB = bal; const dd = maxB - bal; if (dd > maxDD) maxDD = dd;
        const mon = f.date.slice(0, 7); months[mon] = (months[mon] || 0) + net;
        trades.push({ net, date: f.date });
    }
    const w = trades.filter(t => t.net > 0);
    const tW = w.reduce((a, t) => a + t.net, 0), tL = Math.abs(trades.filter(t => t.net < 0).reduce((a, t) => a + t.net, 0));
    return { cfg, t: trades.length, w: w.length, pnl: trades.reduce((a, t) => a + t.net, 0),
        wr: trades.length > 0 ? w.length / trades.length * 100 : 0, dd: maxDD, pf: tL > 0 ? tW / tL : 999,
        fb: bal, m: months, d: new Set(trades.map(t => t.date)).size };
}

function print(label: string, results: Res[]) {
    results.sort((a, b) => b.pnl - a.pnl);
    console.log(`\n${"─".repeat(100)}`);
    console.log(`  ${label}`);
    console.log(`${"─".repeat(100)}`);
    console.log(`  ${"方案".padEnd(35)} | 笔 | 天 | 胜率 | 净利     | 回撤   | PF   | 余额  | 月度`);
    console.log(`  ${"-".repeat(95)}`);
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const ms = Object.entries(r.m).sort().map(([k, v]) => `${k.slice(5)}:${v >= 0 ? "+" : ""}${v.toFixed(0)}`).join(" ");
        console.log(`  ${r.cfg.name.padEnd(35)} | ${String(r.t).padStart(2)} | ${String(r.d).padStart(2)} | ${r.wr.toFixed(0).padStart(3)}% | $${(r.pnl >= 0 ? "+" : "") + r.pnl.toFixed(0).padStart(6)} | $${r.dd.toFixed(0).padStart(5)} | ${r.pf.toFixed(2).padStart(4)} | $${r.fb.toFixed(0).padStart(4)} | ${ms}${i === 0 ? " 🏆" : ""}`);
    }
}

async function main() {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  🎯 V96 精准过滤组合回测 — 每笔交易做到精准");
    console.log("═══════════════════════════════════════════════════════════════\n");
    const sMs = new Date("2026-01-01T00:00:00Z").getTime(), eMs = new Date("2026-03-23T00:00:00Z").getTime();
    console.log("📥 拉取数据...");
    const kl1h = await fetchK("ETHUSDT", "1h", sMs - 7 * 86400000, eMs);
    const kl5m = await fetchK("ETHUSDT", "5m", sMs, eMs);
    console.log(`  1h:${kl1h.length} 5m:${kl5m.length}`);
    const fires = findFires(kl1h);

    const base: Cfg = { name: "", minRange: 0, maxManipPct: 1.0, maxCounterWick: 1.0, tradeEndH: 20, riskPct: 0.02, tpR: 3 };

    // ═══ Round 1: 单因素最优 ═══
    print("🔬 R1: 最小区间", [
        run(kl5m, fires, { ...base, name: "不限(全量)", minRange: 0 }),
        run(kl5m, fires, { ...base, name: "≥20pt", minRange: 20 }),
        run(kl5m, fires, { ...base, name: "≥30pt", minRange: 30 }),
        run(kl5m, fires, { ...base, name: "≥40pt", minRange: 40 }),
        run(kl5m, fires, { ...base, name: "≥50pt", minRange: 50 }),
    ]);
    print("🔬 R2: 最大回踩", [
        run(kl5m, fires, { ...base, name: "不限", maxManipPct: 1.0 }),
        run(kl5m, fires, { ...base, name: "≤50%", maxManipPct: 0.5 }),
        run(kl5m, fires, { ...base, name: "≤30%", maxManipPct: 0.3 }),
        run(kl5m, fires, { ...base, name: "≤20%", maxManipPct: 0.2 }),
    ]);
    print("🔬 R3: 反向影线", [
        run(kl5m, fires, { ...base, name: "不限", maxCounterWick: 1.0 }),
        run(kl5m, fires, { ...base, name: "≤30%", maxCounterWick: 0.3 }),
        run(kl5m, fires, { ...base, name: "≤20%", maxCounterWick: 0.2 }),
        run(kl5m, fires, { ...base, name: "≤10%", maxCounterWick: 0.1 }),
    ]);

    // ═══ Round 2: 双因素组合 ═══
    print("🔬 R4: 区间+回踩 组合", [
        run(kl5m, fires, { ...base, name: "V96原版(bodyR≥40%全量)", minRange: 0 }),
        run(kl5m, fires, { ...base, name: "≥30pt+回踩≤30%", minRange: 30, maxManipPct: 0.3 }),
        run(kl5m, fires, { ...base, name: "≥30pt+回踩≤50%", minRange: 30, maxManipPct: 0.5 }),
        run(kl5m, fires, { ...base, name: "≥40pt+回踩≤30%", minRange: 40, maxManipPct: 0.3 }),
        run(kl5m, fires, { ...base, name: "≥50pt+回踩≤50%", minRange: 50, maxManipPct: 0.5 }),
    ]);
    print("🔬 R5: 区间+影线 组合", [
        run(kl5m, fires, { ...base, name: "全量", minRange: 0 }),
        run(kl5m, fires, { ...base, name: "≥30pt+影线≤25%", minRange: 30, maxCounterWick: 0.25 }),
        run(kl5m, fires, { ...base, name: "≥30pt+影线≤20%", minRange: 30, maxCounterWick: 0.2 }),
        run(kl5m, fires, { ...base, name: "≥40pt+影线≤25%", minRange: 40, maxCounterWick: 0.25 }),
    ]);

    // ═══ Round 3: 三因素黄金组合 ═══
    print("🏆 R6: 三因素黄金组合 (2%风险)", [
        run(kl5m, fires, { ...base, name: "全量无过滤" }),
        run(kl5m, fires, { ...base, name: "≥30pt+回踩≤30%+影线≤25%", minRange: 30, maxManipPct: 0.3, maxCounterWick: 0.25 }),
        run(kl5m, fires, { ...base, name: "≥30pt+回踩≤50%+影线≤25%", minRange: 30, maxManipPct: 0.5, maxCounterWick: 0.25 }),
        run(kl5m, fires, { ...base, name: "≥40pt+回踩≤30%+影线≤25%", minRange: 40, maxManipPct: 0.3, maxCounterWick: 0.25 }),
        run(kl5m, fires, { ...base, name: "≥40pt+回踩≤50%+影线≤20%", minRange: 40, maxManipPct: 0.5, maxCounterWick: 0.2 }),
    ]);

    // ═══ Round 4: 黄金组合 × 风险% × TP ═══
    print("🏆 R7: 最优组合 × 不同风险+TP", [
        run(kl5m, fires, { ...base, name: "全量+2%+3R" }),
        run(kl5m, fires, { ...base, name: "精准+2%+3R", minRange: 30, maxManipPct: 0.3, maxCounterWick: 0.25 }),
        run(kl5m, fires, { ...base, name: "精准+3%+3R", minRange: 30, maxManipPct: 0.3, maxCounterWick: 0.25, riskPct: 0.03 }),
        run(kl5m, fires, { ...base, name: "精准+3%+5R", minRange: 30, maxManipPct: 0.3, maxCounterWick: 0.25, riskPct: 0.03, tpR: 5 }),
        run(kl5m, fires, { ...base, name: "精准+5%+3R", minRange: 30, maxManipPct: 0.3, maxCounterWick: 0.25, riskPct: 0.05 }),
        run(kl5m, fires, { ...base, name: "精准+5%+5R", minRange: 30, maxManipPct: 0.3, maxCounterWick: 0.25, riskPct: 0.05, tpR: 5 }),
        run(kl5m, fires, { ...base, name: "宽松+3%+3R", minRange: 30, maxManipPct: 0.5, maxCounterWick: 0.25, riskPct: 0.03 }),
        run(kl5m, fires, { ...base, name: "宽松+3%+5R", minRange: 30, maxManipPct: 0.5, maxCounterWick: 0.25, riskPct: 0.03, tpR: 5 }),
    ]);

    console.log(`\n${"═".repeat(100)}`);
    console.log("  🏁 完成");
    console.log(`${"═".repeat(100)}\n`);
}
main().catch(console.error);
export {};
