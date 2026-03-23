/**
 * 🚀 V96 最大化盈利 — 多窗口精准交易 + 复利 + 让利润奔跑
 *
 * 思路: 对每天所有6根4H K线都应用精准过滤
 * 精准的单 → 敢下大仓位 → 让利润跑 → 复利滚雪球
 */
const FEE = 0.0004, CAP = 500;
interface K { ts: number; o: number; h: number; l: number; c: number; v: number; }
async function fetchK(s: string, iv: string, st: number, e: number): Promise<K[]> {
    const a: K[] = []; let c = st;
    while (c < e) { const u = `https://api.binance.com/api/v3/klines?symbol=${s}&interval=${iv}&startTime=${c}&endTime=${e}&limit=1500`;
        const r = await fetch(u); if (!r.ok) { await Bun.sleep(5000); continue; } const d = await r.json() as any[][]; if (!d.length) break;
        for (const k of d) a.push({ ts: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }); c = d[d.length - 1][6] + 1; await Bun.sleep(150); } return a; }

interface Fire {
    date: string; startH: number; h: number; l: number; o: number; c: number;
    bodyR: number; range: number; dir: "long" | "short";
    counterWick: number;
}

/** 从4h K线direct取所有Fire */
function findFires4h(kl4h: K[]): Fire[] {
    const f: Fire[] = [];
    for (const k of kl4h) {
        const d = new Date(k.ts), date = d.toISOString().slice(0, 10), startH = d.getUTCHours();
        const body = Math.abs(k.c - k.o), range = k.h - k.l; if (range < 3) continue;
        const dir = k.c > k.o ? "long" as const : "short" as const;
        const cW = dir === "long" ? (k.h - k.c) / range : (k.c - k.l) / range;
        f.push({ date, startH, h: k.h, l: k.l, o: k.o, c: k.c, bodyR: body / range, range, dir, counterWick: cW });
    }
    return f;
}

/** 从1h合成特定窗口 */
function findFires1h(kl1h: K[], fS: number, fE: number): Fire[] {
    const f: Fire[] = []; const dm = new Map<string, K[]>();
    for (const k of kl1h) { const d = new Date(k.ts).toISOString().slice(0, 10); if (!dm.has(d)) dm.set(d, []); dm.get(d)!.push(k); }
    for (const [dt, bars] of dm) {
        const w = bars.filter(k => { const h = new Date(k.ts).getUTCHours(); return h >= fS && h < fE; });
        if (w.length < 2) continue;
        const o = w[0].o, c = w[w.length - 1].c, h = Math.max(...w.map(k => k.h)), l = Math.min(...w.map(k => k.l));
        const body = Math.abs(c - o), range = h - l; if (range < 3) continue;
        const dir = c > o ? "long" as const : "short" as const;
        const cW = dir === "long" ? (h - c) / range : (c - l) / range;
        f.push({ date: dt, startH: fS, h, l, o, c, bodyR: body / range, range, dir, counterWick: cW });
    }
    return f;
}

interface Cfg {
    name: string;
    minRange: number; maxManipPct: number; maxCounterWick: number;
    riskPct: number; tpR: number; maxTradesDay: number;
    useTrail: boolean; trailActivateR: number; trailDist: number;
    tradeWindowH: number; // 每根Fire后几小时内交易
}
interface Res { cfg: Cfg; t: number; w: number; pnl: number; wr: number; dd: number; pf: number; fb: number; m: Record<string, number>; d: number; }

function run(k5: K[], fires: Fire[], cfg: Cfg): Res {
    const trades: { net: number; date: string }[] = []; let bal = CAP, maxB = CAP, maxDD = 0;
    const months: Record<string, number> = {}; const dailyCount: Record<string, number> = {};

    for (const f of fires) {
        const dc = dailyCount[f.date] || 0;
        if (dc >= cfg.maxTradesDay) continue;
        if (f.range < cfg.minRange) continue;
        if (f.counterWick > cfg.maxCounterWick) continue;

        const fireEndH = f.startH + 4;
        const after = k5.filter(k => {
            const d = new Date(k.ts), kd = d.toISOString().slice(0, 10), kh = d.getUTCHours();
            return kd === f.date && kh >= fireEndH && kh < fireEndH + cfg.tradeWindowH;
        });
        if (after.length < 5) continue;

        let ep = 0, ei = -1, manip = false, manipExt = 0;
        for (let i = 1; i < after.length; i++) {
            const b = after[i]; if (ep > 0) break;
            if (f.dir === "long") {
                if (!manip && b.l < f.c) { manip = true; manipExt = b.l; }
                if (manip) { if (b.l < manipExt) manipExt = b.l;
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
        let exitP = 0, bestPt = 0;
        for (let j = si + 1; j < k5.length && j - si < 120; j++) {
            const b = k5[j];
            const pt = f.dir === "long" ? b.c - ep : ep - b.c;
            if (pt > bestPt) bestPt = pt;
            if (f.dir === "long") { if (b.l <= sl) { exitP = sl; break; } if (b.h >= tp) { exitP = tp; break; } }
            else { if (b.h >= sl) { exitP = sl; break; } if (b.l <= tp) { exitP = tp; break; } }
            // Trailing stop
            if (cfg.useTrail && bestPt > risk * cfg.trailActivateR) {
                const ts = f.dir === "long" ? ep + bestPt - cfg.trailDist : ep - bestPt + cfg.trailDist;
                if ((f.dir === "long" && b.c <= ts) || (f.dir === "short" && b.c >= ts)) { exitP = b.c; break; }
            }
        }
        if (exitP === 0) exitP = k5[Math.min(si + 119, k5.length - 1)].c;
        const pt = f.dir === "long" ? exitP - ep : ep - exitP;
        const net = pt * qty - (ep * qty + exitP * qty) * FEE;
        bal += net; if (bal > maxB) maxB = bal; const dd = maxB - bal; if (dd > maxDD) maxDD = dd;
        const mon = f.date.slice(0, 7); months[mon] = (months[mon] || 0) + net;
        dailyCount[f.date] = dc + 1;
        trades.push({ net, date: f.date });
    }
    const w = trades.filter(t => t.net > 0); const tW = w.reduce((a, t) => a + t.net, 0);
    const tL = Math.abs(trades.filter(t => t.net < 0).reduce((a, t) => a + t.net, 0));
    return { cfg, t: trades.length, w: w.length, pnl: trades.reduce((a, t) => a + t.net, 0),
        wr: trades.length > 0 ? w.length / trades.length * 100 : 0, dd: maxDD,
        pf: tL > 0 ? tW / tL : 999, fb: bal, m: months, d: new Set(trades.map(t => t.date)).size };
}

function print(label: string, results: Res[]) {
    results.sort((a, b) => b.pnl - a.pnl);
    console.log(`\n${"─".repeat(105)}`);
    console.log(`  ${label}`);
    console.log(`${"─".repeat(105)}`);
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const ms = Object.entries(r.m).sort().map(([k, v]) => `${k.slice(5)}:${v >= 0 ? "+" : ""}${v.toFixed(0)}`).join(" ");
        console.log(`  ${r.cfg.name.padEnd(40)} | ${String(r.t).padStart(3)}笔 ${String(r.d).padStart(2)}天 | ${r.wr.toFixed(0).padStart(2)}% PF=${r.pf.toFixed(1).padStart(4)} | $${(r.pnl >= 0 ? "+" : "") + r.pnl.toFixed(0).padStart(6)} DD=$${r.dd.toFixed(0).padStart(4)} | $${r.fb.toFixed(0)} | ${ms}${i === 0 ? " 🏆" : ""}`);
    }
}

async function main() {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  🚀 V96 最大化盈利 — $500起步目标翻倍+");
    console.log("═══════════════════════════════════════════════════════════════\n");
    const sMs = new Date("2026-01-01T00:00:00Z").getTime(), eMs = new Date("2026-03-23T00:00:00Z").getTime();
    console.log("📥 拉取数据...");
    const kl1h = await fetchK("ETHUSDT", "1h", sMs - 7 * 86400000, eMs);
    const kl4h = await fetchK("ETHUSDT", "4h", sMs - 7 * 86400000, eMs);
    const kl5m = await fetchK("ETHUSDT", "5m", sMs, eMs);
    console.log(`  1h:${kl1h.length} 4h:${kl4h.length} 5m:${kl5m.length}`);

    const fires1h = findFires1h(kl1h, 8, 12);
    const fires4h = findFires4h(kl4h);

    const precise: Partial<Cfg> = { minRange: 30, maxManipPct: 0.3, maxCounterWick: 0.25 };
    const loose: Partial<Cfg> = { minRange: 20, maxManipPct: 0.5, maxCounterWick: 0.30 };
    const base: Cfg = { name: "", minRange: 0, maxManipPct: 1.0, maxCounterWick: 1.0,
        riskPct: 0.03, tpR: 3, maxTradesDay: 1, useTrail: false, trailActivateR: 2, trailDist: 15, tradeWindowH: 8 };

    // R1: 单窗口 vs 多窗口 (精准过滤)
    print("🔬 R1: 单窗口 vs 多窗口 (精准过滤+3%)", [
        run(kl5m, fires1h, { ...base, ...precise, name: "单窗08-12精准+1笔" }),
        run(kl5m, fires4h, { ...base, ...precise, name: "多窗4H精准+1笔/天", maxTradesDay: 1 }),
        run(kl5m, fires4h, { ...base, ...precise, name: "多窗4H精准+2笔/天", maxTradesDay: 2 }),
        run(kl5m, fires4h, { ...base, ...precise, name: "多窗4H精准+3笔/天", maxTradesDay: 3 }),
        run(kl5m, fires4h, { ...base, ...loose, name: "多窗4H宽松+2笔/天", maxTradesDay: 2 }),
        run(kl5m, fires4h, { ...base, ...loose, name: "多窗4H宽松+3笔/天", maxTradesDay: 3 }),
    ]);

    // R2: 仓位+TP组合
    print("🔬 R2: 精准多窗口 × 仓位+TP", [
        run(kl5m, fires4h, { ...base, ...precise, name: "精准多窗+3%+3R+2笔", maxTradesDay: 2 }),
        run(kl5m, fires4h, { ...base, ...precise, name: "精准多窗+5%+3R+2笔", maxTradesDay: 2, riskPct: 0.05 }),
        run(kl5m, fires4h, { ...base, ...precise, name: "精准多窗+5%+5R+2笔", maxTradesDay: 2, riskPct: 0.05, tpR: 5 }),
        run(kl5m, fires4h, { ...base, ...precise, name: "精准多窗+5%+5R+3笔", maxTradesDay: 3, riskPct: 0.05, tpR: 5 }),
        run(kl5m, fires4h, { ...base, ...loose, name: "宽松多窗+5%+3R+3笔", maxTradesDay: 3, riskPct: 0.05 }),
        run(kl5m, fires4h, { ...base, ...loose, name: "宽松多窗+5%+5R+3笔", maxTradesDay: 3, riskPct: 0.05, tpR: 5 }),
    ]);

    // R3: 加Trailing让利润跑
    print("🔬 R3: + Trailing Stop (让利润跑)", [
        run(kl5m, fires4h, { ...base, ...precise, name: "精准5%+5R+2笔(无trail)", maxTradesDay: 2, riskPct: 0.05, tpR: 5 }),
        run(kl5m, fires4h, { ...base, ...precise, name: "精准5%+5R+trail15@2R", maxTradesDay: 2, riskPct: 0.05, tpR: 5, useTrail: true, trailDist: 15 }),
        run(kl5m, fires4h, { ...base, ...precise, name: "精准5%+5R+trail20@2R", maxTradesDay: 2, riskPct: 0.05, tpR: 5, useTrail: true, trailDist: 20 }),
        run(kl5m, fires4h, { ...base, ...precise, name: "精准5%+无限TP+trail15", maxTradesDay: 2, riskPct: 0.05, tpR: 99, useTrail: true, trailDist: 15 }),
        run(kl5m, fires4h, { ...base, ...loose, name: "宽松5%+5R+trail15+3笔", maxTradesDay: 3, riskPct: 0.05, tpR: 5, useTrail: true, trailDist: 15 }),
    ]);

    // R4: 终极组合
    print("🏆 R4: 终极组合", [
        run(kl5m, fires1h, { ...base, name: "V96原版基线(3%+3R+1笔)" }),
        run(kl5m, fires4h, { ...base, ...precise, name: "精准多窗5%+5R+2笔", maxTradesDay: 2, riskPct: 0.05, tpR: 5 }),
        run(kl5m, fires4h, { ...base, ...precise, name: "精准多窗5%+5R+trail15", maxTradesDay: 2, riskPct: 0.05, tpR: 5, useTrail: true, trailDist: 15 }),
        run(kl5m, fires4h, { ...base, ...loose, name: "宽松多窗5%+5R+trail15+3笔", maxTradesDay: 3, riskPct: 0.05, tpR: 5, useTrail: true, trailDist: 15 }),
        run(kl5m, fires4h, { ...base, ...loose, name: "宽松多窗5%+3R+3笔", maxTradesDay: 3, riskPct: 0.05 }),
        run(kl5m, fires4h, { ...base, ...loose, name: "宽松多窗3%+5R+无限笔", maxTradesDay: 99, riskPct: 0.03, tpR: 5 }),
    ]);

    console.log(`\n${"═".repeat(105)}`);
    console.log("  🏁 完成");
    console.log(`${"═".repeat(105)}\n`);
}
main().catch(console.error);
export {};
