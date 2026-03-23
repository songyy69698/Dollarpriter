/**
 * 🔬 今天盘 × 固定1.5~2 ETH仓位 × $150
 * 测试不同仓位+不同SL策略
 */
const FEE = 0.0004, CAP = 150;
interface K { ts: number; o: number; h: number; l: number; c: number; v: number; }
async function fetchK(s: string, iv: string, st: number, e: number): Promise<K[]> {
    const a: K[] = []; let c = st;
    while (c < e) { const u = `https://api.binance.com/api/v3/klines?symbol=${s}&interval=${iv}&startTime=${c}&endTime=${e}&limit=1500`;
        const r = await fetch(u); if (!r.ok) { await Bun.sleep(2000); continue; } const d = await r.json() as any[][]; if (!d.length) break;
        for (const k of d) a.push({ ts: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }); c = d[d.length - 1][6] + 1; await Bun.sleep(100); } return a; }

function simToday(tradeBars: K[], fireC: number, fireH: number, fireL: number, dir: string,
    qty: number, slMode: string, slPt: number, tpR: number, label: string) {

    let bal = CAP, manipulated = false, tradeNum = 0;
    const trades: string[] = [];

    for (let i = 1; i < tradeBars.length && tradeNum < 4; i++) {
        const b = tradeBars[i], prev = tradeBars[i - 1];
        const time = new Date(b.ts).toISOString().slice(11, 16);

        if (!manipulated) {
            if (dir === "long" && b.l < fireC) manipulated = true;
            if (dir === "short" && b.h > fireC) manipulated = true;
            continue;
        }

        let entry = false;
        if (dir === "long" && b.c > fireC && b.c > b.o && prev.c < fireC) entry = true;
        if (dir === "short" && b.c < fireC && b.c < b.o && prev.c > fireC) entry = true;
        if (!entry) continue;

        const ep = b.c;
        let sl: number;
        if (slMode === "4H") {
            sl = dir === "long" ? fireL - 1 : fireH + 1;
        } else { // fixed pt SL
            sl = dir === "long" ? ep - slPt : ep + slPt;
        }
        const risk = dir === "long" ? ep - sl : sl - ep;
        if (risk <= 0) continue;

        const tp = dir === "long" ? ep + risk * tpR : ep - risk * tpR;
        const maxLoss = qty * risk;

        let exitP = 0, exitType = "";
        for (let j = i + 1; j < tradeBars.length; j++) {
            const tb = tradeBars[j];
            if (dir === "long") {
                if (tb.l <= sl) { exitP = sl; exitType = "❌SL"; break; }
                if (tb.h >= tp) { exitP = tp; exitType = "✅TP"; break; }
            } else {
                if (tb.h >= sl) { exitP = sl; exitType = "❌SL"; break; }
                if (tb.l <= tp) { exitP = tp; exitType = "✅TP"; break; }
            }
        }
        if (exitP === 0) { exitP = tradeBars[tradeBars.length - 1].c; exitType = "⏳持仓"; }

        const pt = dir === "long" ? exitP - ep : ep - exitP;
        const net = pt * qty - (ep * qty + exitP * qty) * FEE;
        const prevBal = bal;
        bal += net;
        tradeNum++;
        manipulated = false;

        trades.push(`    #${tradeNum} ${time} EP$${ep.toFixed(0)} SL$${sl.toFixed(0)}(${risk.toFixed(0)}pt) ${exitType} ${net >= 0 ? "+" : ""}$${net.toFixed(0)} → $${bal.toFixed(0)} [风险$${maxLoss.toFixed(0)}]`);
    }

    console.log(`  ${label.padEnd(45)} | ${tradeNum}笔 $${CAP}→$${bal.toFixed(0)}`);
    for (const t of trades) console.log(t);
}

async function main() {
    const today = "2026-03-23";
    const dayStart = new Date(`${today}T00:00:00Z`).getTime();
    const now = Date.now();

    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`  🔬 今天${today} × 不同仓位+SL策略`);
    console.log("═══════════════════════════════════════════════════════════════\n");

    const kl1h = await fetchK("ETHUSDT", "1h", dayStart, now);
    const kl5m = await fetchK("ETHUSDT", "5m", dayStart, now);

    const fireBars = kl1h.filter(k => new Date(k.ts).getUTCHours() >= 8 && new Date(k.ts).getUTCHours() < 12);
    const fireO = fireBars[0].o, fireC = fireBars[fireBars.length - 1].c;
    const fireH = Math.max(...fireBars.map(k => k.h)), fireL = Math.min(...fireBars.map(k => k.l));
    const dir = fireC > fireO ? "long" : "short";
    const range = fireH - fireL;

    console.log(`  🔥 Fire: O$${fireO.toFixed(0)} C$${fireC.toFixed(0)} H$${fireH.toFixed(0)} L$${fireL.toFixed(0)} | ${dir} | Range=${range.toFixed(0)}pt\n`);

    const tradeBars = kl5m.filter(k => new Date(k.ts).getUTCHours() >= 12 && new Date(k.ts).getUTCHours() <= 20);

    console.log("─".repeat(70));
    console.log("  方案A: 动态仓位(10%风险) + 4H Low SL");
    simToday(tradeBars, fireC, fireH, fireL, dir, 0, "4H", 0, 5, "动态仓位 + 4H SL + 5R");
    // 实际是动态的，用0.127ETH
    const dynRisk = CAP * 0.10;
    const dynSL = dir === "long" ? fireC + 10 - fireL + 1 : fireH + 1 - (fireC - 10);
    console.log(`  (实际: $15风险/${(range+10).toFixed(0)}pt = 0.127 ETH)\n`);

    console.log("─".repeat(70));
    console.log("  方案B: 固定1.5 ETH + 4H Low SL");
    simToday(tradeBars, fireC, fireH, fireL, dir, 1.5, "4H", 0, 5, "1.5 ETH + 4H SL + 5R");
    console.log(`  ⚠️ 单笔最大亏损: 1.5×${range.toFixed(0)} = $${(1.5*range).toFixed(0)}\n`);

    console.log("─".repeat(70));
    console.log("  方案C: 固定1.5 ETH + 固定20pt SL + 5R");
    simToday(tradeBars, fireC, fireH, fireL, dir, 1.5, "fixed", 20, 5, "1.5 ETH + 20pt SL + 5R");
    console.log(`  单笔最大亏损: 1.5×20 = $30\n`);

    console.log("─".repeat(70));
    console.log("  方案D: 固定2 ETH + 固定20pt SL + 3R");
    simToday(tradeBars, fireC, fireH, fireL, dir, 2, "fixed", 20, 3, "2 ETH + 20pt SL + 3R");
    console.log(`  单笔最大亏损: 2×20 = $40\n`);

    console.log("─".repeat(70));
    console.log("  方案E: 固定1.5 ETH + 固定15pt SL + 5R");
    simToday(tradeBars, fireC, fireH, fireL, dir, 1.5, "fixed", 15, 5, "1.5 ETH + 15pt SL + 5R");
    console.log(`  单笔最大亏损: 1.5×15 = $22.5\n`);

    console.log("─".repeat(70));
    console.log("  方案F: 固定2 ETH + 固定15pt SL + 5R");
    simToday(tradeBars, fireC, fireH, fireL, dir, 2, "fixed", 15, 5, "2 ETH + 15pt SL + 5R");
    console.log(`  单笔最大亏损: 2×15 = $30\n`);

    console.log(`${"═".repeat(70)}`);
}
main().catch(console.error);
export {};
