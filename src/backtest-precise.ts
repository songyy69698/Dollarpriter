/**
 * 🎯 精准版回测: 加入智能过滤提升胜率
 *
 * 过滤器:
 * F1: 止损后当天停止 (不追已证伪的方向)
 * F2: 5m确认K线实体>50% (弱确认跳过)
 * F3: Fire Range>100pt时用1.5ETH (大range降仓)
 * F4: 两日连续SL → 第3天跳过
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
        const w = bars.filter(k => { const h = new Date(k.ts).getUTCHours(); return h >= 8 && h < 12; });
        if (w.length < 2) continue;
        const o = w[0].o, c = w[w.length - 1].c, h = Math.max(...w.map(k => k.h)), l = Math.min(...w.map(k => k.l));
        const range = h - l; if (range < 3) continue;
        const bodyR = Math.abs(c - o) / range;
        if (bodyR < 0.4) continue;
        f.push({ date: dt, h, l, o, c, dir: c > o ? "long" : "short", bodyR, range });
    } return f;
}

interface RunCfg {
    name: string;
    slPt: number; tpR: number; qty: number;
    slStopDay: boolean;      // F1: SL后当天停
    bodyFilter: number;      // F2: 5m K线body占比min
    rangeCap: number;        // F3: range超过此值用小仓
    rangeSmallQty: number;   // F3: 小仓数量
    coolAfterSL: number;     // F4: 连续SL天后冷却几天
}

function run(k5: K[], fires: Fire[], cfg: RunCfg) {
    const SL = cfg.slPt, TPR = cfg.tpR;
    let bal = CAP, maxB = CAP, maxDD = 0, totalT = 0, wins = 0;
    let stopped = false, stopDate = "";
    let consecSLDays = 0;
    const log: string[] = [];

    for (const f of fires) {
        if (stopped) break;

        // F4: 连续SL天后冷却
        if (cfg.coolAfterSL > 0 && consecSLDays >= cfg.coolAfterSL) {
            consecSLDays = 0; // 冷却1天后重置
            continue;
        }

        const after = k5.filter(k => { const d = new Date(k.ts);
            return d.toISOString().slice(0, 10) === f.date && d.getUTCHours() >= 12 && d.getUTCHours() <= 20; });
        if (after.length < 10) continue;

        // F3: 大range降仓
        const qty = f.range > cfg.rangeCap ? cfg.rangeSmallQty : cfg.qty;

        let manipulated = false, daySL = false;

        for (let i = 1; i < after.length; i++) {
            if (daySL && cfg.slStopDay) break; // F1

            const b = after[i], prev = after[i - 1];

            if (!manipulated) {
                if (f.dir === "long" && b.l < f.c) manipulated = true;
                if (f.dir === "short" && b.h > f.c) manipulated = true;
                continue;
            }

            // 入场检查
            let entry = false;
            if (f.dir === "long" && b.c > f.c && b.c > b.o && prev.c < f.c) entry = true;
            if (f.dir === "short" && b.c < f.c && b.c < b.o && prev.c > f.c) entry = true;
            if (!entry) continue;

            // F2: 确认K线质量
            const cBody = Math.abs(b.c - b.o) / (b.h - b.l + 0.01);
            if (cBody < cfg.bodyFilter) continue;

            const ep = b.c;
            const sl = f.dir === "long" ? ep - SL : ep + SL;
            const tp = f.dir === "long" ? ep + SL * TPR : ep - SL * TPR;

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
            bal += net; totalT++;
            if (net > 0) wins++;
            if (bal > maxB) maxB = bal;
            if (maxB - bal > maxDD) maxDD = maxB - bal;

            if (exitType === "SL") { daySL = true; }

            const e = exitType === "TP" ? "✅" : exitType === "SL" ? "❌" : "⏳";
            log.push(`  #${String(totalT).padStart(2)} ${f.date} ${f.dir.padEnd(5)} ${qty}ETH ${e}${exitType} $${(bal - net).toFixed(0)}→$${bal.toFixed(0)} ${net >= 0 ? "+" : ""}$${net.toFixed(0)}`);

            if (bal >= TARGET) {
                stopped = true; stopDate = f.date;
                log.push(`  🏆 达标! $${bal.toFixed(0)} → ${f.date}`);
                break;
            }
            if (bal <= 0) { stopped = true; log.push("  💀 爆仓"); break; }
            break; // 每天只做1笔入场确认后就停(后续可以改)
        }

        // 记录连续SL天
        if (daySL) consecSLDays++;
        else consecSLDays = 0;
    }

    const wr = totalT > 0 ? (wins / totalT * 100) : 0;
    const pf = totalT > 0 ? (() => {
        const tW = log.filter(l => l.includes("✅")).length;
        const gross = tW * cfg.slPt * cfg.tpR * cfg.qty;
        const loss = (totalT - tW) * cfg.slPt * cfg.qty;
        return loss > 0 ? gross / loss : 999;
    })() : 0;

    return { name: cfg.name, totalT, wins, wr, bal, maxDD, stopDate, log, pf };
}

function p(r: ReturnType<typeof run>) {
    console.log(`  ${r.name.padEnd(50)} | ${String(r.totalT).padStart(2)}笔 ${r.wr.toFixed(0).padStart(2)}% | $${CAP}→$${r.bal.toFixed(0).padStart(4)} DD=$${r.maxDD.toFixed(0).padStart(3)} | ${r.stopDate || "未达标"}`);
}

async function main() {
    console.log("═══════════════════════════════════════════════════════════════════════");
    console.log("  🎯 精准版: 不同过滤器组合对比");
    console.log("═══════════════════════════════════════════════════════════════════════\n");
    const sMs = new Date("2026-01-01T00:00:00Z").getTime(), eMs = new Date("2026-03-23T00:00:00Z").getTime();
    console.log("📥 拉取数据...");
    const kl1h = await fetchK("ETHUSDT", "1h", sMs - 7 * 86400000, eMs);
    const kl5m = await fetchK("ETHUSDT", "5m", sMs, eMs);
    console.log(`  1h:${kl1h.length} 5m:${kl5m.length}`);
    const fires = findFires(kl1h);

    const base: RunCfg = { name: "", slPt: 20, tpR: 5, qty: 2, slStopDay: false, bodyFilter: 0, rangeCap: 9999, rangeSmallQty: 2, coolAfterSL: 0 };

    console.log(`\n${"─".repeat(100)}`);
    console.log("  原版 vs 各种过滤");
    console.log(`${"─".repeat(100)}`);

    const results = [
        // 原版(无过滤,每天只1笔)
        run(kl5m, fires, { ...base, name: "A: 原版 2ETH+20ptSL+5R (每天1笔)" }),

        // F1: SL后当天停(其实每天就1笔所以一样)
        // F2: 5m body过滤
        run(kl5m, fires, { ...base, name: "B: +5m body>40%", bodyFilter: 0.4 }),
        run(kl5m, fires, { ...base, name: "C: +5m body>50%", bodyFilter: 0.5 }),
        run(kl5m, fires, { ...base, name: "D: +5m body>60%", bodyFilter: 0.6 }),

        // F3: 大range降仓
        run(kl5m, fires, { ...base, name: "E: +range>100pt降1.5ETH", rangeCap: 100, rangeSmallQty: 1.5 }),
        run(kl5m, fires, { ...base, name: "F: +range>100pt降1ETH", rangeCap: 100, rangeSmallQty: 1 }),

        // F4: 连续SL冷却
        run(kl5m, fires, { ...base, name: "G: +连续2天SL后冷却1天", coolAfterSL: 2 }),

        // 组合过滤
        run(kl5m, fires, { ...base, name: "H: body>50%+range降仓+SL冷却", bodyFilter: 0.5, rangeCap: 100, rangeSmallQty: 1.5, coolAfterSL: 2 }),
        run(kl5m, fires, { ...base, name: "I: body>40%+range降1.5+SL冷却", bodyFilter: 0.4, rangeCap: 100, rangeSmallQty: 1.5, coolAfterSL: 2 }),

        // 改TP
        run(kl5m, fires, { ...base, name: "J: 3R代替5R", tpR: 3 }),
        run(kl5m, fires, { ...base, name: "K: 3R+body>50%+降仓+冷却", tpR: 3, bodyFilter: 0.5, rangeCap: 100, rangeSmallQty: 1.5, coolAfterSL: 2 }),
    ];

    for (const r of results) p(r);

    // 打印最好的方案详细
    const best = results.reduce((a, b) => a.bal > b.bal ? a : b);
    console.log(`\n${"─".repeat(100)}`);
    console.log(`  🏆 最佳: ${best.name}`);
    console.log(`${"─".repeat(100)}`);
    for (const l of best.log) console.log(l);

    console.log(`\n${"═".repeat(100)}`);
}
main().catch(console.error);
export {};
