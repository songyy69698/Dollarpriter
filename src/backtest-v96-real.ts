/**
 * 🚀 V96 实际参数回测
 * CEO确认: $500账户 | 只做ETH | 每笔最大亏$25-$50
 */
const FEE = 0.0004, CAP = 500;
interface K { ts: number; o: number; h: number; l: number; c: number; v: number; }
async function fetchK(s: string, iv: string, st: number, e: number): Promise<K[]> {
    const a: K[] = []; let c = st;
    while (c < e) { const u = `https://api.binance.com/api/v3/klines?symbol=${s}&interval=${iv}&startTime=${c}&endTime=${e}&limit=1500`;
        const r = await fetch(u); if (!r.ok) { await Bun.sleep(5000); continue; } const d = await r.json() as any[][]; if (!d.length) break;
        for (const k of d) a.push({ ts: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }); c = d[d.length - 1][6] + 1; await Bun.sleep(150); } return a; }

interface Fire { date: string; h: number; l: number; o: number; c: number; bodyR: number; range: number; dir: "long" | "short"; counterWick: number; }
function findFires(kl: K[], fS: number, fE: number): Fire[] {
    const f: Fire[] = []; const dm = new Map<string, K[]>();
    for (const k of kl) { const d = new Date(k.ts).toISOString().slice(0, 10); if (!dm.has(d)) dm.set(d, []); dm.get(d)!.push(k); }
    for (const [dt, bars] of dm) {
        const w = bars.filter(k => { const h = new Date(k.ts).getUTCHours(); return h >= fS && h < fE; });
        if (w.length < 2) continue;
        const o = w[0].o, c = w[w.length - 1].c, h = Math.max(...w.map(k => k.h)), l = Math.min(...w.map(k => k.l));
        const body = Math.abs(c - o), range = h - l; if (range < 3) continue;
        const dir = c > o ? "long" as const : "short" as const;
        const cW = dir === "long" ? (h - c) / range : (c - l) / range;
        f.push({ date: dt, h, l, o, c, bodyR: body / range, range, dir, counterWick: cW });
    } return f;
}

interface Cfg {
    name: string;
    // 过滤
    minRange: number; maxManipPct: number; maxCounterWick: number;
    // 仓位: 固定美元风险 or 动态%
    fixedRiskUSD: number;   // >0 = 固定美元风险
    riskPct: number;        // fixedRiskUSD=0时用这个
    tpR: number;
}
interface Res { cfg: Cfg; t: number; w: number; pnl: number; wr: number; dd: number; pf: number; fb: number; m: Record<string, number>; }

function run(k5: K[], fires: Fire[], cfg: Cfg): Res {
    const trades: number[] = []; let bal = CAP, maxB = CAP, maxDD = 0; const months: Record<string, number> = {};
    for (const f of fires) {
        if (f.range < cfg.minRange) continue;
        if (cfg.maxCounterWick < 1 && f.counterWick > cfg.maxCounterWick) continue;

        const after = k5.filter(k => { const d = new Date(k.ts); return d.toISOString().slice(0, 10) === f.date && d.getUTCHours() >= 12 && d.getUTCHours() <= 20; });
        if (after.length < 5) continue;

        let ep = 0, ei = -1, manip = false, manipExt = 0;
        for (let i = 1; i < after.length; i++) {
            const b = after[i]; if (ep > 0) break;
            if (f.dir === "long") {
                if (!manip && b.l < f.c) { manip = true; manipExt = b.l; }
                if (manip) { if (b.l < manipExt) manipExt = b.l;
                    if (cfg.maxManipPct < 1) { const d = (f.c - manipExt) / f.range; if (d > cfg.maxManipPct) continue; }
                    if (b.c > f.c && b.c > b.o && after[i - 1].c < f.c) { ep = b.c; ei = i; }
                }
            } else {
                if (!manip && b.h > f.c) { manip = true; manipExt = b.h; }
                if (manip) { if (b.h > manipExt) manipExt = b.h;
                    if (cfg.maxManipPct < 1) { const d = (manipExt - f.c) / f.range; if (d > cfg.maxManipPct) continue; }
                    if (b.c < f.c && b.c < b.o && after[i - 1].c > f.c) { ep = b.c; ei = i; }
                }
            }
        }
        if (ep === 0) continue;
        const sl = f.dir === "long" ? f.l - 1 : f.h + 1;
        const risk = f.dir === "long" ? ep - sl : sl - ep;
        if (risk <= 0 || risk > 500) continue;
        const tp = f.dir === "long" ? ep + risk * cfg.tpR : ep - risk * cfg.tpR;

        // 仓位计算
        let riskAmt: number;
        if (cfg.fixedRiskUSD > 0) {
            riskAmt = Math.min(cfg.fixedRiskUSD, bal * 0.5); // 固定美元，但不超过50%余额
        } else {
            riskAmt = bal * cfg.riskPct;
        }
        let qty = riskAmt / risk;
        qty = Math.max(0.01, Math.round(qty * 1000) / 1000);

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
        trades.push(net);
    }
    const w = trades.filter(t => t > 0); const tW = w.reduce((a, t) => a + t, 0);
    const tL = Math.abs(trades.filter(t => t < 0).reduce((a, t) => a + t, 0));
    return { cfg, t: trades.length, w: w.length, pnl: trades.reduce((a, t) => a + t, 0),
        wr: trades.length > 0 ? w.length / trades.length * 100 : 0, dd: maxDD,
        pf: tL > 0 ? tW / tL : 999, fb: bal, m: months };
}

function print(label: string, results: Res[]) {
    results.sort((a, b) => b.pnl - a.pnl);
    console.log(`\n${"─".repeat(110)}`);
    console.log(`  ${label}`);
    console.log(`${"─".repeat(110)}`);
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const ms = Object.entries(r.m).sort().map(([k, v]) => `${k.slice(5)}:${v >= 0 ? "+" : ""}${v.toFixed(0)}`).join(" ");
        const ret = ((r.fb - CAP) / CAP * 100).toFixed(0);
        console.log(`  ${r.cfg.name.padEnd(42)} | ${String(r.t).padStart(2)}笔 ${r.wr.toFixed(0).padStart(2)}% PF=${r.pf.toFixed(1).padStart(4)} | $${r.fb.toFixed(0).padStart(5)}(${ret.padStart(4)}%) DD=$${r.dd.toFixed(0).padStart(4)} | ${ms}${i === 0 ? " 🏆" : ""}`);
    }
}

async function main() {
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log("  🚀 V96 实际参数回测 — $500 | ETH | 每笔亏$25-50");
    console.log("═══════════════════════════════════════════════════════════════════\n");
    const sMs = new Date("2026-01-01T00:00:00Z").getTime(), eMs = new Date("2026-03-23T00:00:00Z").getTime();
    console.log("📥 拉取数据...");
    const kl1h = await fetchK("ETHUSDT", "1h", sMs - 7 * 86400000, eMs);
    const kl5m = await fetchK("ETHUSDT", "5m", sMs, eMs);
    console.log(`  1h:${kl1h.length} 5m:${kl5m.length}`);
    const fires = findFires(kl1h, 8, 12);

    const noFilter: Partial<Cfg> = { minRange: 0, maxManipPct: 99, maxCounterWick: 99 };
    const precise: Partial<Cfg> = { minRange: 30, maxManipPct: 0.3, maxCounterWick: 0.25 };

    // ═══ R1: 固定美元风险 (不复利) ═══
    print("🔬 R1: 固定美元风险 (不复利)", [
        run(kl5m, fires, { ...noFilter, name: "固定$25/笔+3R(全量)", fixedRiskUSD: 25, riskPct: 0, tpR: 3 } as Cfg),
        run(kl5m, fires, { ...noFilter, name: "固定$35/笔+3R(全量)", fixedRiskUSD: 35, riskPct: 0, tpR: 3 } as Cfg),
        run(kl5m, fires, { ...noFilter, name: "固定$50/笔+3R(全量)", fixedRiskUSD: 50, riskPct: 0, tpR: 3 } as Cfg),
        run(kl5m, fires, { ...noFilter, name: "固定$25/笔+5R(全量)", fixedRiskUSD: 25, riskPct: 0, tpR: 5 } as Cfg),
        run(kl5m, fires, { ...noFilter, name: "固定$50/笔+5R(全量)", fixedRiskUSD: 50, riskPct: 0, tpR: 5 } as Cfg),
    ]);

    // ═══ R2: 动态%(复利) ═══
    print("🔬 R2: 动态%风险 (复利滚雪球)", [
        run(kl5m, fires, { ...noFilter, name: "5%复利+3R(起步$25)", fixedRiskUSD: 0, riskPct: 0.05, tpR: 3 } as Cfg),
        run(kl5m, fires, { ...noFilter, name: "5%复利+5R", fixedRiskUSD: 0, riskPct: 0.05, tpR: 5 } as Cfg),
        run(kl5m, fires, { ...noFilter, name: "8%复利+3R(起步$40)", fixedRiskUSD: 0, riskPct: 0.08, tpR: 3 } as Cfg),
        run(kl5m, fires, { ...noFilter, name: "8%复利+5R", fixedRiskUSD: 0, riskPct: 0.08, tpR: 5 } as Cfg),
        run(kl5m, fires, { ...noFilter, name: "10%复利+3R(起步$50)", fixedRiskUSD: 0, riskPct: 0.10, tpR: 3 } as Cfg),
        run(kl5m, fires, { ...noFilter, name: "10%复利+5R", fixedRiskUSD: 0, riskPct: 0.10, tpR: 5 } as Cfg),
    ]);

    // ═══ R3: 精准过滤 + 大仓位 ═══
    print("🔬 R3: 精准过滤 + 大仓位", [
        run(kl5m, fires, { ...precise, name: "精准+5%复利+3R", fixedRiskUSD: 0, riskPct: 0.05, tpR: 3 } as Cfg),
        run(kl5m, fires, { ...precise, name: "精准+8%复利+3R", fixedRiskUSD: 0, riskPct: 0.08, tpR: 3 } as Cfg),
        run(kl5m, fires, { ...precise, name: "精准+10%复利+3R", fixedRiskUSD: 0, riskPct: 0.10, tpR: 3 } as Cfg),
        run(kl5m, fires, { ...precise, name: "精准+10%复利+5R", fixedRiskUSD: 0, riskPct: 0.10, tpR: 5 } as Cfg),
        run(kl5m, fires, { ...precise, name: "精准+固定$50+3R", fixedRiskUSD: 50, riskPct: 0, tpR: 3 } as Cfg),
        run(kl5m, fires, { ...precise, name: "精准+固定$50+5R", fixedRiskUSD: 50, riskPct: 0, tpR: 5 } as Cfg),
    ]);

    // ═══ R4: 终极对比 ═══
    print("🏆 R4: 终极对比 — $500起步3个月目标", [
        run(kl5m, fires, { ...noFilter, name: "之前的V96(1%+3R)", fixedRiskUSD: 0, riskPct: 0.01, tpR: 3 } as Cfg),
        run(kl5m, fires, { ...noFilter, name: "全量+10%复利+5R", fixedRiskUSD: 0, riskPct: 0.10, tpR: 5 } as Cfg),
        run(kl5m, fires, { ...noFilter, name: "全量+10%复利+3R", fixedRiskUSD: 0, riskPct: 0.10, tpR: 3 } as Cfg),
        run(kl5m, fires, { ...noFilter, name: "全量+8%复利+5R", fixedRiskUSD: 0, riskPct: 0.08, tpR: 5 } as Cfg),
        run(kl5m, fires, { ...noFilter, name: "全量+固定$50+5R", fixedRiskUSD: 50, riskPct: 0, tpR: 5 } as Cfg),
        run(kl5m, fires, { ...precise, name: "精准+10%复利+5R", fixedRiskUSD: 0, riskPct: 0.10, tpR: 5 } as Cfg),
        run(kl5m, fires, { ...precise, name: "精准+固定$50+5R", fixedRiskUSD: 50, riskPct: 0, tpR: 5 } as Cfg),
    ]);

    console.log(`\n${"═".repeat(110)}`);
    console.log("  🏁 完成");
    console.log(`${"═".repeat(110)}\n`);
}
main().catch(console.error);
export {};
