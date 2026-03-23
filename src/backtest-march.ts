/**
 * 🎯 只用3月份数据回测 — 找适合当前行情的策略
 * CEO: 每月走势不同，只看3月
 */
const FEE = 0.0004, CAP = 150, TARGET = 500;
interface K { ts: number; o: number; h: number; l: number; c: number; v: number; }
async function fetchK(s: string, iv: string, st: number, e: number): Promise<K[]> {
    const a: K[] = []; let c = st;
    while (c < e) { const u = `https://api.binance.com/api/v3/klines?symbol=${s}&interval=${iv}&startTime=${c}&endTime=${e}&limit=1500`;
        const r = await fetch(u); if (!r.ok) { await Bun.sleep(5000); continue; } const d = await r.json() as any[][]; if (!d.length) break;
        for (const k of d) a.push({ ts: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }); c = d[d.length - 1][6] + 1; await Bun.sleep(150); } return a; }

interface Fire { date: string; h: number; l: number; o: number; c: number; dir: "long" | "short"; bodyR: number; range: number; }
function findFires(kl: K[]): Fire[] {
    const f: Fire[] = []; const dm = new Map<string, K[]>();
    for (const k of kl) { const d = new Date(k.ts).toISOString().slice(0, 10); if (!dm.has(d)) dm.set(d, []); dm.get(d)!.push(k); }
    for (const [dt, bars] of dm) {
        if (!dt.startsWith("2026-03")) continue; // 只看3月!
        const w = bars.filter(k => { const h = new Date(k.ts).getUTCHours(); return h >= 8 && h < 12; });
        if (w.length < 2) continue;
        const o = w[0].o, c = w[w.length - 1].c, h = Math.max(...w.map(k => k.h)), l = Math.min(...w.map(k => k.l));
        const range = h - l; if (range < 3) continue;
        const bodyR = Math.abs(c - o) / range;
        if (bodyR < 0.4) continue;
        f.push({ date: dt, h, l, o, c, dir: c > o ? "long" : "short", bodyR, range });
    } return f;
}

interface Cfg { name: string; slPt: number; tpR: number; qty: number; bodyMin: number; maxRange: number; smallQty: number; }

function run(k5: K[], fires: Fire[], cfg: Cfg) {
    let bal = CAP, maxB = CAP, maxDD = 0, totalT = 0, wins = 0;
    const log: string[] = [];

    for (const f of fires) {
        if (bal >= TARGET) { log.push(`  🏆 达标 $${bal.toFixed(0)}`); break; }
        if (bal <= 10) { log.push("  💀 爆仓"); break; }

        const after = k5.filter(k => { const d = new Date(k.ts);
            return d.toISOString().slice(0, 10) === f.date && d.getUTCHours() >= 12 && d.getUTCHours() <= 20; });
        if (after.length < 10) continue;

        const qty = f.range > cfg.maxRange ? cfg.smallQty : cfg.qty;
        let manipulated = false;

        for (let i = 1; i < after.length; i++) {
            const b = after[i], prev = after[i - 1];
            if (!manipulated) {
                if (f.dir === "long" && b.l < f.c) manipulated = true;
                if (f.dir === "short" && b.h > f.c) manipulated = true;
                continue;
            }

            let entry = false;
            if (f.dir === "long" && b.c > f.c && b.c > b.o && prev.c < f.c) entry = true;
            if (f.dir === "short" && b.c < f.c && b.c < b.o && prev.c > f.c) entry = true;
            if (!entry) continue;

            // Body过滤
            const cBody = Math.abs(b.c - b.o) / (b.h - b.l + 0.01);
            if (cBody < cfg.bodyMin) continue;

            const ep = b.c;
            const sl = f.dir === "long" ? ep - cfg.slPt : ep + cfg.slPt;
            const tp = f.dir === "long" ? ep + cfg.slPt * cfg.tpR : ep - cfg.slPt * cfg.tpR;

            const si = k5.indexOf(b);
            let exitP = 0, exitType = "";
            for (let j = si + 1; j < k5.length && j - si < 120; j++) {
                const tb = k5[j];
                if (f.dir === "long") {
                    if (tb.l <= sl) { exitP = sl; exitType = "SL"; break; }
                    if (tb.h >= tp) { exitP = tp; exitType = "TP"; break; }
                } else {
                    if (tb.h >= sl) { exitP = sl; exitType = "SL"; break; }
                    if (tb.l <= tp) { exitP = tp; exitType = "TP"; break; }
                }
            }
            if (exitP === 0) { exitP = k5[Math.min(si + 119, k5.length - 1)].c; exitType = "TO"; }

            const pt = f.dir === "long" ? exitP - ep : ep - exitP;
            const net = pt * qty - (ep * qty + exitP * qty) * FEE;
            const prev2 = bal;
            bal += net; totalT++;
            if (net > 0) wins++;
            if (bal > maxB) maxB = bal;
            if (maxB - bal > maxDD) maxDD = maxB - bal;

            const e = exitType === "TP" ? "✅" : exitType === "SL" ? "❌" : "⏳";
            log.push(`  #${String(totalT).padStart(2)} ${f.date} ${f.dir.padEnd(5)} ${qty}E rng${f.range.toFixed(0).padStart(3)} ${e}${exitType} $${prev2.toFixed(0)}→$${bal.toFixed(0)} ${net >= 0 ? "+" : ""}$${net.toFixed(0)}`);
            break; // 每天1笔
        }
    }
    const wr = totalT > 0 ? wins / totalT * 100 : 0;
    return { name: cfg.name, totalT, wins, wr, bal, maxDD, log };
}

function p(r: ReturnType<typeof run>) {
    console.log(`  ${r.name.padEnd(52)} | ${String(r.totalT).padStart(2)}笔 ${r.wr.toFixed(0).padStart(2)}% | $${CAP}→$${r.bal.toFixed(0).padStart(4)} DD=$${r.maxDD.toFixed(0).padStart(3)} | ${r.bal >= TARGET ? "🏆达标" : ""}`);
}

async function main() {
    console.log("═══════════════════════════════════════════════════════════════════════");
    console.log("  🎯 3月份单月回测 — 找适合当前行情的策略");
    console.log("═══════════════════════════════════════════════════════════════════════\n");
    const sMs = new Date("2026-02-25T00:00:00Z").getTime(), eMs = new Date("2026-03-23T00:00:00Z").getTime();
    console.log("📥 拉取数据(只拉3月份)...");
    const kl1h = await fetchK("ETHUSDT", "1h", sMs, eMs);
    const kl5m = await fetchK("ETHUSDT", "5m", new Date("2026-03-01T00:00:00Z").getTime(), eMs);
    console.log(`  1h:${kl1h.length} 5m:${kl5m.length}`);
    const fires = findFires(kl1h);
    console.log(`  3月Fire Candles: ${fires.length}个`);
    console.log(`  方向分布: ${fires.filter(f => f.dir === "long").length}多 ${fires.filter(f => f.dir === "short").length}空`);
    console.log(`  平均Range: ${(fires.reduce((a, f) => a + f.range, 0) / fires.length).toFixed(0)}pt\n`);

    const base: Cfg = { name: "", slPt: 20, tpR: 5, qty: 2, bodyMin: 0, maxRange: 9999, smallQty: 2 };

    console.log(`${"─".repeat(105)}`);
    console.log("  3月份: 不同SL×仓位×TP");
    console.log(`${"─".repeat(105)}`);

    const results = [
        // 不同SL
        run(kl5m, fires, { ...base, name: "A: 2ETH+15ptSL+5R" , slPt: 15 }),
        run(kl5m, fires, { ...base, name: "B: 2ETH+20ptSL+5R" }),
        run(kl5m, fires, { ...base, name: "C: 2ETH+25ptSL+5R", slPt: 25  }),
        run(kl5m, fires, { ...base, name: "D: 2ETH+30ptSL+5R", slPt: 30 }),

        // 不同TP
        run(kl5m, fires, { ...base, name: "E: 2ETH+20ptSL+3R", tpR: 3 }),
        run(kl5m, fires, { ...base, name: "F: 2ETH+20ptSL+4R", tpR: 4 }),
        run(kl5m, fires, { ...base, name: "G: 2ETH+25ptSL+3R", slPt: 25, tpR: 3 }),

        // 不同仓位
        run(kl5m, fires, { ...base, name: "H: 1.5ETH+20ptSL+3R", qty: 1.5, tpR: 3 }),
        run(kl5m, fires, { ...base, name: "I: 1.5ETH+25ptSL+3R", qty: 1.5, slPt: 25, tpR: 3 }),

        // Body过滤
        run(kl5m, fires, { ...base, name: "J: 2ETH+20ptSL+3R+body50%", tpR: 3, bodyMin: 0.5 }),
        run(kl5m, fires, { ...base, name: "K: 2ETH+25ptSL+3R+body50%", slPt: 25, tpR: 3, bodyMin: 0.5 }),

        // 大range降仓
        run(kl5m, fires, { ...base, name: "L: 2ETH+20ptSL+3R+range>80降1.5", tpR: 3, maxRange: 80, smallQty: 1.5 }),
        run(kl5m, fires, { ...base, name: "M: 2ETH+25ptSL+3R+body50%+rng降仓", slPt: 25, tpR: 3, bodyMin: 0.5, maxRange: 80, smallQty: 1.5 }),
    ];

    for (const r of results) p(r);

    // 找最好的
    const best = results.reduce((a, b) => {
        if (a.bal >= TARGET && b.bal < TARGET) return a;
        if (b.bal >= TARGET && a.bal < TARGET) return b;
        if (a.maxDD < b.maxDD && a.bal > CAP && b.bal > CAP) return a;
        return a.bal > b.bal ? a : b;
    });

    console.log(`\n${"─".repeat(105)}`);
    console.log(`  🏆 3月最佳: ${best.name}`);
    console.log(`${"─".repeat(105)}`);
    for (const l of best.log) console.log(l);

    // 也打每天的Fire Candle信息
    console.log(`\n${"─".repeat(105)}`);
    console.log("  📊 3月每日Fire Candle");
    console.log(`${"─".repeat(105)}`);
    for (const f of fires) {
        console.log(`  ${f.date} ${f.dir.padEnd(5)} O$${f.o.toFixed(0)} C$${f.c.toFixed(0)} Range=${f.range.toFixed(0).padStart(3)}pt body=${(f.bodyR*100).toFixed(0)}%`);
    }

    console.log(`\n${"═".repeat(105)}`);
}
main().catch(console.error);
export {};
