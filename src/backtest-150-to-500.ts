/**
 * 🎯 $150 → $500 需要多久？
 * V96 + 10%复利 + 5R
 */
const FEE = 0.0004, CAP = 150;
interface K { ts: number; o: number; h: number; l: number; c: number; v: number; }
async function fetchK(s: string, iv: string, st: number, e: number): Promise<K[]> {
    const a: K[] = []; let c = st;
    while (c < e) { const u = `https://api.binance.com/api/v3/klines?symbol=${s}&interval=${iv}&startTime=${c}&endTime=${e}&limit=1500`;
        const r = await fetch(u); if (!r.ok) { await Bun.sleep(5000); continue; } const d = await r.json() as any[][]; if (!d.length) break;
        for (const k of d) a.push({ ts: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }); c = d[d.length - 1][6] + 1; await Bun.sleep(150); } return a; }

interface Fire { date: string; h: number; l: number; o: number; c: number; dir: "long" | "short"; }
function findFires(kl: K[]): Fire[] {
    const f: Fire[] = []; const dm = new Map<string, K[]>();
    for (const k of kl) { const d = new Date(k.ts).toISOString().slice(0, 10); if (!dm.has(d)) dm.set(d, []); dm.get(d)!.push(k); }
    for (const [dt, bars] of dm) {
        const w = bars.filter(k => { const h = new Date(k.ts).getUTCHours(); return h >= 8 && h < 12; });
        if (w.length < 2) continue;
        const o = w[0].o, c = w[w.length - 1].c, h = Math.max(...w.map(k => k.h)), l = Math.min(...w.map(k => k.l));
        if (h - l < 3) continue;
        f.push({ date: dt, h, l, o, c, dir: c > o ? "long" : "short" });
    } return f;
}

function runWithLog(k5: K[], fires: Fire[], rPct: number, tpR: number, name: string) {
    let bal = CAP, maxB = CAP, maxDD = 0, reached500 = "", firstLoss = "";
    const log: string[] = [];
    let tradeNum = 0;

    for (const f of fires) {
        const after = k5.filter(k => { const d = new Date(k.ts); return d.toISOString().slice(0, 10) === f.date && d.getUTCHours() >= 12 && d.getUTCHours() <= 20; });
        if (after.length < 10) continue;
        let manip = false, entry: any = null;
        for (let i = 1; i < after.length; i++) {
            const b = after[i];
            if (f.dir === "long") {
                if (!manip && b.l < f.c) manip = true;
                if (manip && b.c > f.c && b.c > b.o && after[i - 1].c < f.c) { entry = { ep: b.c, idx: i, sl: f.l - 1 }; break; }
            } else {
                if (!manip && b.h > f.c) manip = true;
                if (manip && b.c < f.c && b.c < b.o && after[i - 1].c > f.c) { entry = { ep: b.c, idx: i, sl: f.h + 1 }; break; }
            }
        }
        if (!entry) continue;
        const risk = f.dir === "long" ? entry.ep - entry.sl : entry.sl - entry.ep;
        if (risk <= 0 || risk > 500) continue;
        const tp = f.dir === "long" ? entry.ep + risk * tpR : entry.ep - risk * tpR;
        const rA = bal * rPct; let qty = rA / risk; qty = Math.max(0.01, Math.round(qty * 1000) / 1000);
        const si = k5.findIndex(k => k.ts === after[entry.idx].ts); if (si < 0) continue;
        let exitP = 0;
        for (let j = si + 1; j < k5.length && j - si < 120; j++) { const b = k5[j];
            if (f.dir === "long") { if (b.l <= entry.sl) { exitP = entry.sl; break; } if (b.h >= tp) { exitP = tp; break; } }
            else { if (b.h >= entry.sl) { exitP = entry.sl; break; } if (b.l <= tp) { exitP = tp; break; } } }
        if (exitP === 0) exitP = k5[Math.min(si + 119, k5.length - 1)].c;
        const pt = f.dir === "long" ? exitP - entry.ep : entry.ep - exitP;
        const net = pt * qty - (entry.ep * qty + exitP * qty) * FEE;
        const prevBal = bal;
        bal += net; tradeNum++;
        if (bal > maxB) maxB = bal; if (maxB - bal > maxDD) maxDD = maxB - bal;
        const win = net > 0;
        const emoji = win ? "✅" : "❌";

        log.push(`  #${String(tradeNum).padStart(2)} ${f.date} ${f.dir.padEnd(5)} ${emoji} $${prevBal.toFixed(0).padStart(5)}→$${bal.toFixed(0).padStart(5)} ${net >= 0 ? "+" : ""}$${net.toFixed(0).padStart(4)} risk=$${rA.toFixed(0)}`);

        if (!reached500 && bal >= 500) {
            reached500 = f.date;
            log.push(`  🎯 ========== $500达成! 第${tradeNum}笔 ${f.date} ==========`);
        }
        if (bal <= 0) { log.push("  💀 爆仓"); break; }
    }

    console.log(`\n  📊 ${name}`);
    console.log(`  起始: $${CAP} | 风险: ${(rPct * 100).toFixed(0)}% | TP: ${tpR}R`);
    console.log(`  ─────────────────────────────────────────────────`);
    for (const l of log) console.log(l);
    console.log(`  ─────────────────────────────────────────────────`);
    console.log(`  终值: $${bal.toFixed(0)} | 最大回撤: $${maxDD.toFixed(0)} | 总笔: ${tradeNum}`);
    if (reached500) console.log(`  🎯 $500达成时间: ${reached500} (第${log.findIndex(l => l.includes("$500达成"))! + 1}行)`);
    else console.log(`  ⚠️ 未达成$500`);
}

async function main() {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  🧪 测试: $150 → $500 需要多久?");
    console.log("═══════════════════════════════════════════════════════════════");
    const sMs = new Date("2026-01-01T00:00:00Z").getTime(), eMs = new Date("2026-03-23T00:00:00Z").getTime();
    console.log("\n📥 拉取数据...");
    const kl1h = await fetchK("ETHUSDT", "1h", sMs - 7 * 86400000, eMs);
    const kl5m = await fetchK("ETHUSDT", "5m", sMs, eMs);
    console.log(`  1h:${kl1h.length} 5m:${kl5m.length}`);
    const fires = findFires(kl1h);

    // 10% + 5R (最强方案)
    runWithLog(kl5m, fires, 0.10, 5, "V96 + 10%复利 + 5R");

    // 10% + 3R
    runWithLog(kl5m, fires, 0.10, 3, "V96 + 10%复利 + 3R");

    // 5% + 5R (保守一点)
    runWithLog(kl5m, fires, 0.05, 5, "V96 + 5%复利 + 5R");

    console.log(`\n${"═".repeat(60)}`);
}
main().catch(console.error);
export {};
