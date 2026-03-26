/**
 * 📊 V200 三触结构入场 回测
 * ═══════════════════════════════════════════
 * CEO 规格:
 * 1. 1H 结构确认方向
 * 2. 15m 内部盘整: 3次递高低点 (做多) 或 3次递低高点 (做空)
 * 3. 盘整结束后入场
 * 4. V104 出场 (保本/trailing/分批/全平)
 */

const FEE = 0.0004, CAP = 500, LEV = 150;

interface K { ts: number; o: number; h: number; l: number; c: number; v: number; }

async function fetchK(sym: string, iv: string, s: number, e: number): Promise<K[]> {
    const all: K[] = []; let cur = s;
    while (cur < e) {
        const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${iv}&startTime=${cur}&endTime=${e}&limit=1500`;
        const r = await fetch(url); if (!r.ok) { await Bun.sleep(3000); continue; }
        const d = (await r.json()) as any[][]; if (!d.length) break;
        for (const k of d) all.push({ ts: k[0] as number, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
        cur = (d[d.length - 1][6] as number) + 1; await Bun.sleep(200);
    }
    return all;
}

interface Trade {
    day: string; time: string; side: string; entry: number; exit: number;
    pt: number; net: number; reason: string; qty: number;
}

function utc8H(ts: number): number { return new Date(ts + 8 * 3600000).getUTCHours(); }
function utc8Date(ts: number): string { return new Date(ts + 8 * 3600000).toISOString().slice(0, 10); }
function utc8Time(ts: number): string { return new Date(ts + 8 * 3600000).toISOString().slice(11, 16); }

// ═══ 交易窗口 ═══
interface TW { name: string; startH: number; endH: number; isAsian: boolean; }
const WINDOWS: TW[] = [
    { name: "亚盘", startH: 9, endH: 10, isAsian: true },
    { name: "规律", startH: 15, endH: 16, isAsian: false },
    { name: "峰A", startH: 20, endH: 22, isAsian: false },
    { name: "峰B", startH: 22, endH: 24, isAsian: false },
];

// ═══════════════════════════════════════════════════
// 1H 方向: 看最近3根1H的结构
// ═══════════════════════════════════════════════════

function get1HDirection(k1h: K[], beforeTs: number): "long" | "short" | "" {
    const closed = k1h.filter(k => k.ts + 3600000 <= beforeTs);
    if (closed.length < 3) return "";
    const recent = closed.slice(-3);
    // 3根1H都是阳线 或 低点递高+收盘递高 → LONG
    const allBullish = recent.every(k => k.c > k.o);
    const higherLows = recent[1].l > recent[0].l && recent[2].l > recent[1].l;
    const higherCloses = recent[1].c > recent[0].c && recent[2].c > recent[1].c;
    
    const allBearish = recent.every(k => k.c < k.o);
    const lowerHighs = recent[1].h < recent[0].h && recent[2].h < recent[1].h;
    const lowerCloses = recent[1].c < recent[0].c && recent[2].c < recent[1].c;

    if ((allBullish || higherLows) && higherCloses) return "long";
    if ((allBearish || lowerHighs) && lowerCloses) return "short";
    return "";
}

// ═══════════════════════════════════════════════════
// 15m 三触结构检测 (用5m K线组装)
// ═══════════════════════════════════════════════════

interface SwingPoint { ts: number; price: number; type: "high" | "low"; }

/**
 * 从5m K线中提取 swing high/low
 * swing high: 当前bar的high > 前一根和后一根的high
 * swing low: 当前bar的low < 前一根和后一根的low
 */
function findSwings(k5m: K[], startIdx: number, endIdx: number): SwingPoint[] {
    const swings: SwingPoint[] = [];
    for (let i = Math.max(startIdx, 1); i < endIdx - 1; i++) {
        const prev = k5m[i - 1], curr = k5m[i], next = k5m[i + 1];
        if (curr.h > prev.h && curr.h > next.h) {
            swings.push({ ts: curr.ts, price: curr.h, type: "high" });
        }
        if (curr.l < prev.l && curr.l < next.l) {
            swings.push({ ts: curr.ts, price: curr.l, type: "low" });
        }
    }
    return swings;
}

/**
 * 检测三触递高/递低结构
 * 做多: 3个递高的 swing low (每个low > 前一个low)
 * 做空: 3个递低的 swing high (每个high < 前一个high)
 * 
 * 回看最近 60 分钟(12根5m) 的 swing 数据
 */
function detect3TouchStructure(k5m: K[], currentIdx: number, wantedDir: "long" | "short"): {
    found: boolean;
    swings: SwingPoint[];
} {
    // 回看最近 15 根5m (75分钟，约5根15m)
    const lookbackBars = 15;
    const startIdx = Math.max(0, currentIdx - lookbackBars);
    const swings = findSwings(k5m, startIdx, currentIdx + 1);

    if (wantedDir === "long") {
        // 找3个递高的 swing low
        const lows = swings.filter(s => s.type === "low");
        if (lows.length >= 3) {
            const last3 = lows.slice(-3);
            if (last3[1].price > last3[0].price && last3[2].price > last3[1].price) {
                return { found: true, swings: last3 };
            }
        }
    } else {
        // 找3个递低的 swing high
        const highs = swings.filter(s => s.type === "high");
        if (highs.length >= 3) {
            const last3 = highs.slice(-3);
            if (last3[1].price < last3[0].price && last3[2].price < last3[1].price) {
                return { found: true, swings: last3 };
            }
        }
    }
    return { found: false, swings: [] };
}

// ═══════════════════════════════════════════════════
// 回测引擎
// ═══════════════════════════════════════════════════

function runDay(dayStr: string, k5m: K[], k1h: K[]): { trades: Trade[]; log: string[] } {
    const trades: Trade[] = [];
    const log: string[] = [];
    let bal = CAP;
    const usedWindows = new Set<string>();

    // V104 出场参数
    const SL_PT = 20;
    const BREAKEVEN_PT = 6;
    const TRAILING_PT = 12;
    const PARTIAL_TP_PT = 35;
    const FULL_TP_PT = 100;
    const MAX_HOLD = 36; // 3H = 36根5m

    for (let i = 20; i < k5m.length; i++) {
        const bar = k5m[i];
        const h = utc8H(bar.ts);
        const day = utc8Date(bar.ts);
        if (day !== dayStr) continue;

        // 噪音过滤 08-09
        if (h >= 8 && h < 9) continue;

        // 窗口
        let activeW: TW | null = null;
        for (const w of WINDOWS) { if (h >= w.startH && h < w.endH) { activeW = w; break; } }
        if (!activeW) continue;
        const wk = `${day}_${activeW.name}`;
        if (usedWindows.has(wk)) continue;

        // ═══ 第1层: 1H 方向 ═══
        const dir1h = get1HDirection(k1h, bar.ts);
        if (!dir1h) continue;

        // ═══ 第2层: 15m 三触结构 ═══
        const structure = detect3TouchStructure(k5m, i, dir1h);
        if (!structure.found) continue;

        // ═══ 入场！ ═══
        const dir = dir1h;
        const entryPrice = bar.c;
        const qty = Math.floor((bal * 0.02 / SL_PT) * 10) / 10;
        if (qty < 0.1) continue;

        const swingDesc = structure.swings.map(s => 
            `${s.price.toFixed(0)}`
        ).join("→");
        log.push(`  ${utc8Time(bar.ts)} ✅ ${dir.toUpperCase()} @$${entryPrice.toFixed(1)} | 1H=${dir} | 三触: ${swingDesc} | ${qty}E`);

        // ═══ V104 出场 ═══
        let exitP = 0, reason = "";
        let breakevenHit = false;
        let trailingHigh = 0;
        let partialClosed = false;
        let remainQty = qty;
        let partialPnl = 0;

        for (let j = i + 1; j < k5m.length && j - i < MAX_HOLD; j++) {
            const b = k5m[j];
            const ptBest = dir === "long" ? b.h - entryPrice : entryPrice - b.l;
            const ptWorst = dir === "long" ? b.l - entryPrice : entryPrice - b.h;
            const pt = dir === "long" ? b.c - entryPrice : entryPrice - b.c;
            if (ptBest > trailingHigh) trailingHigh = ptBest;

            // SL
            if (!breakevenHit && ptWorst <= -SL_PT) {
                exitP = dir === "long" ? entryPrice - SL_PT : entryPrice + SL_PT;
                reason = "SL"; break;
            }
            // 保本
            if (!breakevenHit && ptBest >= BREAKEVEN_PT) breakevenHit = true;
            if (breakevenHit && ptWorst <= 0) {
                exitP = entryPrice; reason = "保本"; break;
            }
            // 分批TP
            if (!partialClosed && ptBest >= PARTIAL_TP_PT) {
                partialClosed = true;
                partialPnl = PARTIAL_TP_PT * (remainQty * 0.5);
                remainQty *= 0.5;
            }
            // Trailing
            if (breakevenHit && trailingHigh - pt >= TRAILING_PT && trailingHigh >= BREAKEVEN_PT) {
                exitP = dir === "long" ? entryPrice + (trailingHigh - TRAILING_PT) : entryPrice - (trailingHigh - TRAILING_PT);
                reason = `Trail(${trailingHigh.toFixed(0)})`;
                break;
            }
            // 全平
            if (pt >= FULL_TP_PT) { exitP = b.c; reason = "全平"; break; }
            // 亚盘12:00
            if (activeW.isAsian && utc8H(b.ts) >= 12) { exitP = b.c; reason = "NOON"; break; }
        }
        if (exitP === 0) {
            const jEnd = Math.min(i + MAX_HOLD - 1, k5m.length - 1);
            exitP = k5m[jEnd].c;
            reason = "3H超时";
        }

        usedWindows.add(wk);
        const pt = dir === "long" ? exitP - entryPrice : entryPrice - exitP;
        const remainPnlFinal = pt * remainQty;
        const grossPnl = partialPnl + remainPnlFinal;
        const fee = (entryPrice * qty + exitP * qty) * FEE;
        const net = grossPnl - fee;
        bal += net;

        trades.push({
            day, time: utc8Time(bar.ts), side: dir, entry: entryPrice, exit: exitP,
            pt, net, reason, qty,
        });
    }
    return { trades, log };
}

// ═══ 主程序 ═══
async function main() {
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log("  📊 三触结构入场 回测 — ETHUSDT");
    console.log("  1H方向 + 15m三次递高低点 + V104出场");
    console.log("═══════════════════════════════════════════════════════════════════\n");

    const days = ["2026-03-22", "2026-03-23", "2026-03-24", "2026-03-25", "2026-03-26"];
    const firstDay = new Date(days[0] + "T00:00:00Z").getTime();
    const lastDay = new Date(days[days.length - 1] + "T00:00:00Z").getTime() + 86400000;

    console.log("📥 拉取 5m K线...");
    const k5mAll = await fetchK("ETHUSDT", "5m", firstDay - 2 * 86400000, lastDay);
    console.log(`  5m: ${k5mAll.length} 根`);

    console.log("📥 拉取 1h K线...");
    const k1hAll = await fetchK("ETHUSDT", "1h", firstDay - 7 * 86400000, lastDay);
    console.log(`  1h: ${k1hAll.length} 根\n`);

    let totalTrades: Trade[] = [];
    let totalPnl = 0;

    for (const dayStr of days) {
        const dayTs = new Date(dayStr + "T00:00:00Z").getTime();
        const nextDayTs = dayTs + 86400000;
        const k5mDay = k5mAll.filter(k => k.ts >= dayTs - 2 * 3600000 && k.ts < nextDayTs);
        const k1hDay = k1hAll.filter(k => k.ts < nextDayTs);

        const { trades, log: dayLog } = runDay(dayStr, k5mDay, k1hDay);
        const dayM1 = k5mAll.filter(k => k.ts >= dayTs && k.ts < nextDayTs);
        const dayO = dayM1[0]?.o || 0, dayC = dayM1[dayM1.length - 1]?.c || 0;
        const dayH = Math.max(...dayM1.map(k => k.h));
        const dayL = Math.min(...dayM1.map(k => k.l));
        const dayPnl = trades.reduce((a, t) => a + t.net, 0);

        console.log("═══════════════════════════════════════════════════════════════════");
        console.log(`  📅 ${dayStr} | O=$${dayO.toFixed(0)} H=$${dayH.toFixed(0)} L=$${dayL.toFixed(0)} C=$${dayC.toFixed(0)} | ${dayC >= dayO ? "📈+" : "📉"}${(dayC - dayO).toFixed(0)}pt`);
        console.log("═══════════════════════════════════════════════════════════════════");

        for (const l of dayLog) console.log(l);

        if (trades.length > 0) {
            console.log(`\n  笔数: ${trades.length} | 净利: $${dayPnl >= 0 ? "+" : ""}${dayPnl.toFixed(1)}`);
            console.log("  时间  | 方向  | 仓位  | 入场      | 出场      | 点数     | 净盈亏    | 出场");
            console.log("  " + "─".repeat(85));
            for (const t of trades) {
                console.log(
                    `  ${t.time} | ${t.side.padEnd(5)} | ${t.qty.toFixed(1)}E | ` +
                    `$${t.entry.toFixed(1).padStart(7)} | $${t.exit.toFixed(1).padStart(7)} | ` +
                    `${(t.pt >= 0 ? "+" : "") + t.pt.toFixed(1).padStart(7)} | ` +
                    `$${(t.net >= 0 ? "+" : "") + t.net.toFixed(1).padStart(7)} | ${t.reason}`
                );
            }
        } else {
            console.log("  ⚠️ 无交易信号");
        }
        console.log();
        totalTrades.push(...trades);
        totalPnl += dayPnl;
    }

    // 汇总
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log(`  📊 ${days.length}日汇总`);
    console.log("═══════════════════════════════════════════════════════════════════");
    const wins = totalTrades.filter(t => t.net > 0);
    const losses = totalTrades.filter(t => t.net <= 0);
    const wr = totalTrades.length > 0 ? (wins.length / totalTrades.length * 100).toFixed(0) : "0";
    const avgW = wins.length > 0 ? wins.reduce((a, t) => a + t.net, 0) / wins.length : 0;
    const avgL = losses.length > 0 ? losses.reduce((a, t) => a + t.net, 0) / losses.length : 0;
    console.log(`  总笔数: ${totalTrades.length} | 胜: ${wins.length} 负: ${losses.length} | 胜率: ${wr}%`);
    console.log(`  总净利: $${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(1)}`);
    console.log(`  均盈: $${avgW >= 0 ? "+" : ""}${avgW.toFixed(1)} | 均亏: $${avgL.toFixed(1)}`);
    if (avgL !== 0) console.log(`  盈亏比: ${(Math.abs(avgW / avgL)).toFixed(2)}`);
    console.log("\n  ─── 每日 ───");
    for (const d of days) {
        const dt = totalTrades.filter(t => t.day === d);
        const dp = dt.reduce((a, t) => a + t.net, 0);
        console.log(`  ${d}: ${dt.length}笔 ${dt.filter(t => t.net > 0).length}胜${dt.filter(t => t.net <= 0).length}负 | $${dp >= 0 ? "+" : ""}${dp.toFixed(1)}`);
    }
    console.log(`\n${"═".repeat(67)}\n`);
}

main().catch(console.error);
export {};
