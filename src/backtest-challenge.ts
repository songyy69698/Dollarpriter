/**
 * 🔬 挑战版回测: 固定2ETH + 20pt SL + 5R + 4笔/天 + $150起 + 达$500停
 * CEO说得对: 入场不精准就爆仓，必须先验证
 */
const FEE = 0.0004, CAP = 150, QTY = 2.0, SL_PT = 20, TP_R = 5, MAX_T = 4, TARGET = 500;
interface K { ts: number; o: number; h: number; l: number; c: number; v: number; }
async function fetchK(s: string, iv: string, st: number, e: number): Promise<K[]> {
    const a: K[] = []; let c = st;
    while (c < e) { const u = `https://api.binance.com/api/v3/klines?symbol=${s}&interval=${iv}&startTime=${c}&endTime=${e}&limit=1500`;
        const r = await fetch(u); if (!r.ok) { await Bun.sleep(5000); continue; } const d = await r.json() as any[][]; if (!d.length) break;
        for (const k of d) a.push({ ts: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }); c = d[d.length - 1][6] + 1; await Bun.sleep(150); } return a; }

interface Fire { date: string; h: number; l: number; o: number; c: number; dir: "long" | "short"; bodyR: number; }
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
        f.push({ date: dt, h, l, o, c, dir: c > o ? "long" : "short", bodyR });
    } return f;
}

async function main() {
    console.log("═══════════════════════════════════════════════════════════════════════");
    console.log("  🔬 挑战版回测: 固定2ETH + 20pt SL + 5R + $150起 + 达$500停");
    console.log("═══════════════════════════════════════════════════════════════════════\n");
    const sMs = new Date("2026-01-01T00:00:00Z").getTime(), eMs = new Date("2026-03-23T00:00:00Z").getTime();
    console.log("📥 拉取数据...");
    const kl1h = await fetchK("ETHUSDT", "1h", sMs - 7 * 86400000, eMs);
    const kl5m = await fetchK("ETHUSDT", "5m", sMs, eMs);
    console.log(`  1h:${kl1h.length} 5m:${kl5m.length}`);
    const fires = findFires(kl1h);
    console.log(`  Fire Candles: ${fires.length}个\n`);

    let bal = CAP, maxB = CAP, maxDD = 0, totalTrades = 0, wins = 0;
    let stopped = false, stopDate = "";

    for (const f of fires) {
        if (stopped) break;

        const after = kl5m.filter(k => { const d = new Date(k.ts);
            return d.toISOString().slice(0, 10) === f.date && d.getUTCHours() >= 12 && d.getUTCHours() <= 20; });
        if (after.length < 10) continue;

        let dayTrades = 0, manipulated = false;

        for (let i = 1; i < after.length && dayTrades < MAX_T; i++) {
            const b = after[i], prev = after[i - 1];

            // Manipulation检测
            if (!manipulated) {
                if (f.dir === "long" && b.l < f.c) manipulated = true;
                if (f.dir === "short" && b.h > f.c) manipulated = true;
                continue;
            }

            // 入场确认
            let entry = false;
            if (f.dir === "long" && b.c > f.c && b.c > b.o && prev.c < f.c) entry = true;
            if (f.dir === "short" && b.c < f.c && b.c < b.o && prev.c > f.c) entry = true;
            if (!entry) continue;

            const ep = b.c;
            const sl = f.dir === "long" ? ep - SL_PT : ep + SL_PT;
            const tp = f.dir === "long" ? ep + SL_PT * TP_R : ep - SL_PT * TP_R;

            // 模拟出场
            const si = kl5m.indexOf(b);
            let exitP = 0, exitType = "";
            for (let j = si + 1; j < kl5m.length && j - si < 120; j++) {
                const tb = kl5m[j];
                if (f.dir === "long") {
                    if (tb.l <= sl) { exitP = sl; exitType = "SL"; break; }
                    if (tb.h >= tp) { exitP = tp; exitType = "TP"; break; }
                } else {
                    if (tb.h >= sl) { exitP = sl; exitType = "SL"; break; }
                    if (tb.l <= tp) { exitP = tp; exitType = "TP"; break; }
                }
            }
            if (exitP === 0) { exitP = kl5m[Math.min(si + 119, kl5m.length - 1)].c; exitType = "TO"; }

            const pt = f.dir === "long" ? exitP - ep : ep - exitP;
            const net = pt * QTY - (ep * QTY + exitP * QTY) * FEE;
            const prevBal = bal;
            bal += net;
            totalTrades++; dayTrades++;
            manipulated = false;
            if (net > 0) wins++;
            if (bal > maxB) maxB = bal;
            if (maxB - bal > maxDD) maxDD = maxB - bal;

            const emoji = exitType === "TP" ? "✅" : exitType === "SL" ? "❌" : "⏳";
            console.log(`  #${String(totalTrades).padStart(3)} ${f.date} ${f.dir.padEnd(5)} EP$${ep.toFixed(0)} ${emoji}${exitType} $${prevBal.toFixed(0)}→$${bal.toFixed(0)} ${net >= 0 ? "+" : ""}$${net.toFixed(0)}`);

            // 达标检测
            if (bal >= TARGET) {
                stopped = true;
                stopDate = f.date;
                console.log(`\n  🏆🏆🏆 达标! $${bal.toFixed(0)} ≥ $${TARGET} → ${f.date} 停止! 🏆🏆🏆\n`);
                break;
            }

            // 爆仓检测
            if (bal <= 0) {
                console.log(`\n  💀 爆仓! $${bal.toFixed(0)}\n`);
                stopped = true; break;
            }
        }
    }

    console.log(`\n${"═".repeat(70)}`);
    console.log(`  📊 挑战版回测总结`);
    console.log(`${"─".repeat(70)}`);
    console.log(`  总笔: ${totalTrades} | 赢: ${wins} | 胜率: ${totalTrades > 0 ? (wins/totalTrades*100).toFixed(0) : 0}%`);
    console.log(`  终值: $${bal.toFixed(0)} | 最大回撤: $${maxDD.toFixed(0)}`);
    if (stopDate) console.log(`  达标日: ${stopDate}`);
    console.log(`  每笔: 赢+$${(SL_PT * TP_R * QTY).toFixed(0)} | 输-$${(SL_PT * QTY).toFixed(0)}`);
    console.log(`${"═".repeat(70)}\n`);
}
main().catch(console.error);
export {};
