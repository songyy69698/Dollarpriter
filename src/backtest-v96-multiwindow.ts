/**
 * 🔥 V96 多窗口回测 — 解锁全部赚钱机会
 *
 * 核心洞察: V10说「每根4H K线都有AMD循环」
 * V96现在只交易UTC 08-12一根 → 一天6根4H K线 = 6倍机会
 *
 * 测试:
 * A) 原版: 仅UTC 08-12 → 12-20交易
 * B) 多窗口: 每根完成的4H K线都可能成为Fire Candle
 * C) 允许多笔: 每天>1笔
 * D) 仓位提升: 2%风险 vs 1%
 */

const FEE = 0.0004, CAP = 500;
interface K { ts: number; o: number; h: number; l: number; c: number; v: number; }

async function fetchK(sym: string, iv: string, s: number, e: number): Promise<K[]> {
    const all: K[] = []; let cur = s;
    while (cur < e) {
        const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${iv}&startTime=${cur}&endTime=${e}&limit=1500`;
        const r = await fetch(url); if (!r.ok) { await Bun.sleep(5000); continue; }
        const d = (await r.json()) as any[][]; if (!d.length) break;
        for (const k of d) all.push({ ts: k[0] as number, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
        cur = (d[d.length - 1][6] as number) + 1; await Bun.sleep(150);
    }
    return all;
}

interface Fire {
    date: string; startH: number; h: number; l: number; o: number; c: number;
    body: number; range: number; bodyR: number; dir: "long" | "short" | "skip";
}

/** 找每天所有4H窗口的Fire Candle */
function findAllFires(kl4h: K[], minBodyR: number): Fire[] {
    const fires: Fire[] = [];
    for (const k of kl4h) {
        const d = new Date(k.ts);
        const date = d.toISOString().slice(0, 10);
        const startH = d.getUTCHours();
        const body = Math.abs(k.c - k.o), range = k.h - k.l;
        if (range < 5) continue;
        const bodyR = body / range;
        let dir: "long" | "short" | "skip" = "skip";
        if (bodyR >= minBodyR) { dir = k.c > k.o ? "long" : "short"; }
        fires.push({ date, startH, h: k.h, l: k.l, o: k.o, c: k.c, body, range, bodyR, dir });
    }
    return fires;
}

/** 找特定窗口的Fire Candle (V96原版逻辑用1h合成) */
function findFiresOriginal(kl1h: K[], fS: number, fE: number, minBodyR: number): Fire[] {
    const fires: Fire[] = [];
    const dm = new Map<string, K[]>();
    for (const k of kl1h) { const d = new Date(k.ts).toISOString().slice(0, 10); if (!dm.has(d)) dm.set(d, []); dm.get(d)!.push(k); }
    for (const [date, bars] of dm) {
        const win = bars.filter(k => { const h = new Date(k.ts).getUTCHours(); return h >= fS && h < fE; });
        if (win.length < 2) continue;
        const o = win[0].o, c = win[win.length - 1].c;
        const h = Math.max(...win.map(k => k.h)), l = Math.min(...win.map(k => k.l));
        const body = Math.abs(c - o), range = h - l; if (range < 1) continue;
        const bodyR = body / range;
        let dir: "long" | "short" | "skip" = "skip";
        if (bodyR >= minBodyR) { dir = c > o ? "long" : "short"; }
        fires.push({ date, startH: fS, h, l, o, c, body, range, bodyR, dir });
    }
    return fires;
}

interface Cfg {
    name: string;
    minBodyR: number; tpR: number; maxHold: number;
    maxTradesPerDay: number;       // 每天最多几笔
    riskPct: number;               // 每笔风险%
    tradeAfterHours: number;       // Fire Candle后几小时内交易
    useMultiWindow: boolean;       // 是否用多窗口
}

interface Trade { date: string; fireH: number; side: string; entry: number; sl: number; tp: number; exit: number; net: number; reason: string; }
interface Res { cfg: Cfg; trades: number; wins: number; pnl: number; wr: number; dd: number; pf: number; months: Record<string, number>; finalBal: number; }

function run(kl5m: K[], fires: Fire[], cfg: Cfg): Res {
    const trades: Trade[] = [];
    let bal = CAP, maxB = CAP, maxDD = 0;
    const months: Record<string, number> = {};
    const dailyCount: Record<string, number> = {};

    for (const f of fires) {
        if (f.dir === "skip") continue;

        // 每天交易次数限制
        const dc = dailyCount[f.date] || 0;
        if (dc >= cfg.maxTradesPerDay) continue;

        // 交易窗口: Fire Candle结束后的N小时
        const fireEndH = f.startH + 4;
        const tradeEndH = fireEndH + cfg.tradeAfterHours;
        
        const after = kl5m.filter(k => {
            const d = new Date(k.ts);
            const kd = d.toISOString().slice(0, 10);
            const kh = d.getUTCHours();
            // 多窗口模式: 用Fire Candle结束后的小时数
            if (cfg.useMultiWindow) {
                return kd === f.date && kh >= fireEndH && kh < tradeEndH;
            }
            // 原版: 固定UTC 12-20
            return kd === f.date && kh >= 12 && kh <= 20;
        });
        if (after.length < 5) continue;

        // 找入场 (V96逻辑)
        let ep = 0, entryIdx = -1, manipulated = false;
        for (let i = 1; i < after.length; i++) {
            const bar = after[i];
            if (ep > 0) break;
            if (f.dir === "long") {
                if (!manipulated && bar.l < f.c) manipulated = true;
                if (manipulated && bar.c > f.c && bar.c > bar.o && after[i-1].c < f.c) {
                    ep = bar.c; entryIdx = i;
                }
            } else {
                if (!manipulated && bar.h > f.c) manipulated = true;
                if (manipulated && bar.c < f.c && bar.c < bar.o && after[i-1].c > f.c) {
                    ep = bar.c; entryIdx = i;
                }
            }
        }
        if (ep === 0) continue;

        // SL/TP
        const sl = f.dir === "long" ? f.l - 1 : f.h + 1;
        const risk = f.dir === "long" ? ep - sl : sl - ep;
        if (risk <= 0 || risk > 500) continue;
        const tp = f.dir === "long" ? ep + risk * cfg.tpR : ep - risk * cfg.tpR;

        // 动态仓位
        const riskAmt = bal * cfg.riskPct;
        let qty = riskAmt / risk;
        qty = Math.max(0.01, Math.round(qty * 1000) / 1000);

        // 模拟持仓
        const startIdx = kl5m.findIndex(k => k.ts === after[entryIdx].ts);
        if (startIdx < 0) continue;
        let exitP = 0, reason = "";
        for (let j = startIdx + 1; j < kl5m.length && j - startIdx < cfg.maxHold; j++) {
            const bar = kl5m[j];
            if (f.dir === "long") {
                if (bar.l <= sl) { exitP = sl; reason = "SL"; break; }
                if (bar.h >= tp) { exitP = tp; reason = "TP"; break; }
            } else {
                if (bar.h >= sl) { exitP = sl; reason = "SL"; break; }
                if (bar.l <= tp) { exitP = tp; reason = "TP"; break; }
            }
        }
        if (exitP === 0) {
            exitP = kl5m[Math.min(startIdx + cfg.maxHold - 1, kl5m.length - 1)].c;
            reason = "TIMEOUT";
        }

        const pt = f.dir === "long" ? exitP - ep : ep - exitP;
        const fee = (ep * qty + exitP * qty) * FEE;
        const net = pt * qty - fee;
        bal += net; if (bal > maxB) maxB = bal;
        const dd = maxB - bal; if (dd > maxDD) maxDD = dd;
        const mon = f.date.slice(0, 7);
        months[mon] = (months[mon] || 0) + net;
        dailyCount[f.date] = dc + 1;
        trades.push({ date: f.date, fireH: f.startH, side: f.dir, entry: ep, sl, tp, exit: exitP, net, reason });
    }

    const w = trades.filter(t => t.net > 0);
    const tW = w.reduce((a, t) => a + t.net, 0);
    const tL = Math.abs(trades.filter(t => t.net < 0).reduce((a, t) => a + t.net, 0));
    return {
        cfg, trades: trades.length, wins: w.length,
        pnl: trades.reduce((a, t) => a + t.net, 0),
        wr: trades.length > 0 ? w.length / trades.length * 100 : 0,
        dd: maxDD, pf: tL > 0 ? tW / tL : 999, months, finalBal: bal
    };
}

function printTable(label: string, results: Res[]) {
    results.sort((a, b) => b.pnl - a.pnl);
    console.log(`\n${"─".repeat(80)}`);
    console.log(`  ${label}`);
    console.log(`${"─".repeat(80)}`);
    console.log(`  ${"方案".padEnd(30)} | 笔数 | 胜率  | 净利      | 回撤    | PF    | 余额`);
    console.log(`  ${"-".repeat(75)}`);
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const mark = i === 0 ? " 🏆" : "";
        console.log(
            `  ${r.cfg.name.padEnd(30)} | ${String(r.trades).padStart(4)} | ${r.wr.toFixed(0).padStart(4)}% | $${(r.pnl >= 0 ? "+" : "") + r.pnl.toFixed(0).padStart(7)} | $${r.dd.toFixed(0).padStart(6)} | ${r.pf.toFixed(2).padStart(5)} | $${r.finalBal.toFixed(0)}${mark}`
        );
    }
    const ms = Object.entries(results[0].months).sort().map(([m, v]) => `${m.slice(5)}:${v >= 0 ? "+" : ""}${v.toFixed(0)}`).join(" | ");
    console.log(`  → 冠军: ${results[0].cfg.name} | 月度: ${ms}`);
}

async function main() {
    console.log("═══════════════════════════════════════════════════════════");
    console.log("  🔥 V96 多窗口回测 — 解锁全部AMD机会");
    console.log("  ETHUSDT | $500起 | 2026.01-03 | 动态仓位复利");
    console.log("═══════════════════════════════════════════════════════════\n");

    const sMs = new Date("2026-01-01T00:00:00Z").getTime();
    const eMs = new Date("2026-03-23T00:00:00Z").getTime();

    console.log("📥 拉取数据...");
    const kl1h = await fetchK("ETHUSDT", "1h", sMs - 7 * 86400000, eMs);
    const kl4h = await fetchK("ETHUSDT", "4h", sMs - 7 * 86400000, eMs);
    const kl5m = await fetchK("ETHUSDT", "5m", sMs, eMs);
    console.log(`  1h:${kl1h.length} 4h:${kl4h.length} 5m:${kl5m.length}`);

    const firesOrig = findFiresOriginal(kl1h, 8, 12, 0.4);
    const firesAll = findAllFires(kl4h, 0.4);

    const base: Cfg = {
        name: "", minBodyR: 0.4, tpR: 3, maxHold: 120,
        maxTradesPerDay: 1, riskPct: 0.01, tradeAfterHours: 8,
        useMultiWindow: false
    };

    // ═══ Round 1: 原版 vs 多窗口 (固定1%风险) ═══
    const r1: Res[] = [
        run(kl5m, firesOrig, { ...base, name: "V96原版(08-12→12-20,1笔)" }),
        run(kl5m, firesAll, { ...base, name: "多窗口(所有4H,1笔/天)", useMultiWindow: true }),
        run(kl5m, firesAll, { ...base, name: "多窗口+2笔/天", useMultiWindow: true, maxTradesPerDay: 2 }),
        run(kl5m, firesAll, { ...base, name: "多窗口+3笔/天", useMultiWindow: true, maxTradesPerDay: 3 }),
        run(kl5m, firesAll, { ...base, name: "多窗口+不限笔数", useMultiWindow: true, maxTradesPerDay: 99 }),
    ];
    printTable("🔬 Round 1: 交易频率 (1%风险)", r1);

    // ═══ Round 2: 仓位提升 (原版窗口) ═══
    const r2: Res[] = [
        run(kl5m, firesOrig, { ...base, name: "V96 1%风险" }),
        run(kl5m, firesOrig, { ...base, name: "V96 1.5%风险", riskPct: 0.015 }),
        run(kl5m, firesOrig, { ...base, name: "V96 2%风险", riskPct: 0.02 }),
        run(kl5m, firesOrig, { ...base, name: "V96 3%风险", riskPct: 0.03 }),
        run(kl5m, firesOrig, { ...base, name: "V96 5%风险", riskPct: 0.05 }),
    ];
    printTable("🔬 Round 2: 仓位大小 (原版窗口)", r2);

    // ═══ Round 3: TP倍数 ═══
    const r3: Res[] = [
        run(kl5m, firesOrig, { ...base, name: "TP=2R", tpR: 2 }),
        run(kl5m, firesOrig, { ...base, name: "TP=3R(原版)", tpR: 3 }),
        run(kl5m, firesOrig, { ...base, name: "TP=4R", tpR: 4 }),
        run(kl5m, firesOrig, { ...base, name: "TP=5R", tpR: 5 }),
    ];
    printTable("🔬 Round 3: TP倍数", r3);

    // ═══ Round 4: 最优组合 ═══
    const r4: Res[] = [
        run(kl5m, firesOrig, { ...base, name: "V96原版(1%,1笔,3R)" }),
        // 多窗口+提升仓位组合
        run(kl5m, firesAll, { ...base, name: "多窗口+2%+2笔", useMultiWindow: true, maxTradesPerDay: 2, riskPct: 0.02 }),
        run(kl5m, firesAll, { ...base, name: "多窗口+2%+3笔", useMultiWindow: true, maxTradesPerDay: 3, riskPct: 0.02 }),
        run(kl5m, firesAll, { ...base, name: "多窗口+3%+2笔", useMultiWindow: true, maxTradesPerDay: 2, riskPct: 0.03 }),
        run(kl5m, firesAll, { ...base, name: "多窗口+1.5%+2笔+2R", useMultiWindow: true, maxTradesPerDay: 2, riskPct: 0.015, tpR: 2 }),
        run(kl5m, firesAll, { ...base, name: "多窗口+2%+不限+3R", useMultiWindow: true, maxTradesPerDay: 99, riskPct: 0.02 }),
        run(kl5m, firesOrig, { ...base, name: "原窗口+2%", riskPct: 0.02 }),
        run(kl5m, firesOrig, { ...base, name: "原窗口+3%", riskPct: 0.03 }),
    ];
    printTable("🏆 Round 4: 最优组合", r4);

    console.log(`\n${"═".repeat(80)}`);
    console.log("  🏁 回测完成！");
    console.log(`${"═".repeat(80)}\n`);
}

main().catch(console.error);
export {};
