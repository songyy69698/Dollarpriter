/**
 * 📊 交易配对分析器 — 从 Bitunix 历史数据计算真实 PnL
 * ═══════════════════════════════════════════════════════
 * 用 reduceOnly 区分 OPEN/CLOSE，配对计算盈亏
 * 用法: bun src/analyze-trades.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const INPUT_FILE = join(DATA_DIR, "trades-history.jsonl");
const OUTPUT_FILE = join(DATA_DIR, "analysis-report.json");

interface RawTrade {
    type: string;
    tradeId: string;
    orderId: string;
    symbol: string;
    side: string;       // BUY / SELL
    price: number;
    qty: number;
    fee: number;
    realizedPnl: number;
    ts: number;
    date: string;
    raw: {
        reduceOnly: boolean;
        clientId: string | null;
        leverage: number;
        orderType: string;
        fee: string;
        price: string;
    };
}

interface CompleteTrade {
    openTs: number;
    closeTs: number;
    openDate: string;
    closeDate: string;
    direction: "LONG" | "SHORT";  // BUY开=LONG, SELL开=SHORT
    entryPrice: number;
    exitPrice: number;
    qty: number;
    openFee: number;
    closeFee: number;
    totalFee: number;
    grossPnlPt: number;     // 点数
    grossPnlU: number;      // USDT
    netPnlU: number;        // 扣手续费后
    holdMinutes: number;
    leverage: number;
    isBot: boolean;          // clientId 含 D66_
    dayOfWeek: number;
    hour: number;            // UTC+8 开仓小时
}

function main() {
    console.log("═══════════════════════════════════════");
    console.log("  📊 交易配对分析器");
    console.log("═══════════════════════════════════════\n");

    if (!existsSync(INPUT_FILE)) {
        console.error("❌ 找不到 data/trades-history.jsonl，请先运行 pull-trades.ts");
        process.exit(1);
    }

    const lines = readFileSync(INPUT_FILE, "utf-8").trim().split("\n");
    console.log(`📁 读取 ${lines.length} 行数据`);

    // 解析所有交易记录
    const trades: RawTrade[] = [];
    for (const line of lines) {
        try { trades.push(JSON.parse(line)); } catch {}
    }

    // 按时间排序（从旧到新）
    trades.sort((a, b) => a.ts - b.ts);

    // ═══ 配对逻辑 ═══
    // reduceOnly=false → OPEN (开仓)
    // reduceOnly=true  → CLOSE (平仓)
    // BUY + reduceOnly=false = 开多
    // SELL + reduceOnly=false = 开空
    // SELL + reduceOnly=true = 平多
    // BUY + reduceOnly=true = 平空

    interface OpenPosition {
        side: "LONG" | "SHORT";
        entries: { price: number; qty: number; fee: number; ts: number; date: string; isBot: boolean; leverage: number }[];
        totalQty: number;
        avgPrice: number;
        totalFee: number;
    }

    let currentPos: OpenPosition | null = null;
    const completeTrades: CompleteTrade[] = [];

    for (const t of trades) {
        const isOpen = t.raw.reduceOnly === false;
        const isClose = t.raw.reduceOnly === true;
        const price = t.price || (t.fee > 0 && t.qty > 0 ? t.fee / t.qty / 0.0004 : 0); // 反推价格
        const isBot = (t.raw.clientId || "").includes("D66_");

        if (isOpen) {
            const dir: "LONG" | "SHORT" = t.side === "BUY" ? "LONG" : "SHORT";

            if (!currentPos || currentPos.side !== dir) {
                // 如果有未平仓的反向仓位，先标记为丢失
                if (currentPos && currentPos.totalQty > 0) {
                    // 忽略残留的部分仓位
                }
                // 新建仓位
                currentPos = {
                    side: dir,
                    entries: [],
                    totalQty: 0,
                    avgPrice: 0,
                    totalFee: 0,
                };
            }

            // 累积开仓
            currentPos.entries.push({
                price, qty: t.qty, fee: t.fee, ts: t.ts, date: t.date, isBot, leverage: t.raw.leverage,
            });
            const oldVal = currentPos.avgPrice * currentPos.totalQty;
            currentPos.totalQty += t.qty;
            currentPos.avgPrice = currentPos.totalQty > 0 ? (oldVal + price * t.qty) / currentPos.totalQty : 0;
            currentPos.totalFee += t.fee;
        }

        if (isClose && currentPos && currentPos.totalQty > 0) {
            // 验证方向匹配: 平多用SELL, 平空用BUY
            const expectedCloseSide = currentPos.side === "LONG" ? "SELL" : "BUY";
            if (t.side !== expectedCloseSide) continue;

            const closeQty = Math.min(t.qty, currentPos.totalQty);
            if (closeQty <= 0) continue;

            const openDate = currentPos.entries[0]?.date || "";
            const openTs = currentPos.entries[0]?.ts || 0;

            const grossPnlPt = currentPos.side === "LONG"
                ? price - currentPos.avgPrice
                : currentPos.avgPrice - price;
            const grossPnlU = grossPnlPt * closeQty;
            const closeFee = t.fee * (closeQty / t.qty);
            const openFeeShare = currentPos.totalFee * (closeQty / currentPos.totalQty);
            const netPnlU = grossPnlU - openFeeShare - closeFee;

            const holdMin = (t.ts - openTs) / 60_000;
            const openDt = new Date(openTs);
            const utc8H = (openDt.getUTCHours() + 8) % 24;

            completeTrades.push({
                openTs,
                closeTs: t.ts,
                openDate,
                closeDate: t.date,
                direction: currentPos.side,
                entryPrice: currentPos.avgPrice,
                exitPrice: price,
                qty: closeQty,
                openFee: openFeeShare,
                closeFee,
                totalFee: openFeeShare + closeFee,
                grossPnlPt,
                grossPnlU,
                netPnlU,
                holdMinutes: +holdMin.toFixed(1),
                leverage: currentPos.entries[0]?.leverage || 0,
                isBot: currentPos.entries.some(e => e.isBot),
                dayOfWeek: openDt.getDay(),
                hour: utc8H,
            });

            // 减少仓位
            currentPos.totalQty -= closeQty;
            currentPos.totalFee -= openFeeShare;
            if (currentPos.totalQty <= 0.001) currentPos = null;
        }
    }

    console.log(`\n📊 配对完成: ${completeTrades.length} 笔完整交易\n`);

    // ═══ 统计分析 ═══
    const wins = completeTrades.filter(t => t.netPnlU > 0);
    const losses = completeTrades.filter(t => t.netPnlU <= 0);
    const totalPnl = completeTrades.reduce((s, t) => s + t.netPnlU, 0);
    const totalFees = completeTrades.reduce((s, t) => s + t.totalFee, 0);
    const totalGross = completeTrades.reduce((s, t) => s + t.grossPnlU, 0);

    // Bot vs 手动
    const botTrades = completeTrades.filter(t => t.isBot);
    const manualTrades = completeTrades.filter(t => !t.isBot);

    console.log("═══════════════════════════════════════");
    console.log("  📈 总体统计");
    console.log("═══════════════════════════════════════");
    console.log(`总交易数: ${completeTrades.length}`);
    console.log(`  赢: ${wins.length} (${(wins.length / completeTrades.length * 100).toFixed(1)}%)`);
    console.log(`  亏: ${losses.length} (${(losses.length / completeTrades.length * 100).toFixed(1)}%)`);
    console.log(`毛利润: ${totalGross >= 0 ? "+" : ""}${totalGross.toFixed(2)} USDT`);
    console.log(`总手续费: ${totalFees.toFixed(2)} USDT`);
    console.log(`净利润: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} USDT`);
    console.log(`平均盈利: +${wins.length > 0 ? (wins.reduce((s, t) => s + t.netPnlU, 0) / wins.length).toFixed(2) : 0} USDT`);
    console.log(`平均亏损: ${losses.length > 0 ? (losses.reduce((s, t) => s + t.netPnlU, 0) / losses.length).toFixed(2) : 0} USDT`);

    console.log("\n═══════════════════════════════════════");
    console.log("  🤖 Bot vs 📱 手动");
    console.log("═══════════════════════════════════════");
    const botPnl = botTrades.reduce((s, t) => s + t.netPnlU, 0);
    const manPnl = manualTrades.reduce((s, t) => s + t.netPnlU, 0);
    const botWins = botTrades.filter(t => t.netPnlU > 0).length;
    const manWins = manualTrades.filter(t => t.netPnlU > 0).length;
    console.log(`Bot(D66_): ${botTrades.length}笔 | 胜率${botTrades.length > 0 ? (botWins / botTrades.length * 100).toFixed(1) : 0}% | PnL: ${botPnl >= 0 ? "+" : ""}${botPnl.toFixed(2)}`);
    console.log(`手动/其他: ${manualTrades.length}笔 | 胜率${manualTrades.length > 0 ? (manWins / manualTrades.length * 100).toFixed(1) : 0}% | PnL: ${manPnl >= 0 ? "+" : ""}${manPnl.toFixed(2)}`);

    // ═══ 方向分析 ═══
    console.log("\n═══════════════════════════════════════");
    console.log("  📊 方向分析 (LONG vs SHORT)");
    console.log("═══════════════════════════════════════");
    const longs = completeTrades.filter(t => t.direction === "LONG");
    const shorts = completeTrades.filter(t => t.direction === "SHORT");
    const longWins = longs.filter(t => t.netPnlU > 0).length;
    const shortWins = shorts.filter(t => t.netPnlU > 0).length;
    const longPnl = longs.reduce((s, t) => s + t.netPnlU, 0);
    const shortPnl = shorts.reduce((s, t) => s + t.netPnlU, 0);
    console.log(`LONG:  ${longs.length}笔 | 胜率${longs.length > 0 ? (longWins / longs.length * 100).toFixed(1) : 0}% | PnL: ${longPnl >= 0 ? "+" : ""}${longPnl.toFixed(2)}`);
    console.log(`SHORT: ${shorts.length}笔 | 胜率${shorts.length > 0 ? (shortWins / shorts.length * 100).toFixed(1) : 0}% | PnL: ${shortPnl >= 0 ? "+" : ""}${shortPnl.toFixed(2)}`);

    // ═══ 时段分析 (UTC+8) ═══
    console.log("\n═══════════════════════════════════════");
    console.log("  ⏰ 时段分析 (UTC+8)");
    console.log("═══════════════════════════════════════");
    const hourMap: Record<number, { count: number; wins: number; pnl: number }> = {};
    for (const t of completeTrades) {
        if (!hourMap[t.hour]) hourMap[t.hour] = { count: 0, wins: 0, pnl: 0 };
        hourMap[t.hour].count++;
        if (t.netPnlU > 0) hourMap[t.hour].wins++;
        hourMap[t.hour].pnl += t.netPnlU;
    }
    const sortedHours = Object.keys(hourMap).map(Number).sort((a, b) => a - b);
    for (const h of sortedHours) {
        const d = hourMap[h];
        const wr = (d.wins / d.count * 100).toFixed(0);
        const pnlStr = d.pnl >= 0 ? `+${d.pnl.toFixed(0)}` : d.pnl.toFixed(0);
        const bar = d.pnl >= 0 ? "🟢".repeat(Math.min(Math.ceil(d.pnl / 50), 10)) : "🔴".repeat(Math.min(Math.ceil(-d.pnl / 50), 10));
        console.log(`  ${String(h).padStart(2)}:00 | ${String(d.count).padStart(4)}笔 | 胜率${wr.padStart(3)}% | ${pnlStr.padStart(8)} | ${bar}`);
    }

    // ═══ 星期分析 ═══
    console.log("\n═══════════════════════════════════════");
    console.log("  📅 星期分析");
    console.log("═══════════════════════════════════════");
    const dayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const dayMap: Record<number, { count: number; wins: number; pnl: number }> = {};
    for (const t of completeTrades) {
        if (!dayMap[t.dayOfWeek]) dayMap[t.dayOfWeek] = { count: 0, wins: 0, pnl: 0 };
        dayMap[t.dayOfWeek].count++;
        if (t.netPnlU > 0) dayMap[t.dayOfWeek].wins++;
        dayMap[t.dayOfWeek].pnl += t.netPnlU;
    }
    for (let d = 0; d < 7; d++) {
        if (!dayMap[d]) continue;
        const v = dayMap[d];
        const wr = (v.wins / v.count * 100).toFixed(0);
        const pnlStr = v.pnl >= 0 ? `+${v.pnl.toFixed(0)}` : v.pnl.toFixed(0);
        console.log(`  ${dayNames[d]} | ${String(v.count).padStart(4)}笔 | 胜率${wr.padStart(3)}% | ${pnlStr.padStart(8)}`);
    }

    // ═══ 持仓时间分析 ═══
    console.log("\n═══════════════════════════════════════");
    console.log("  ⏱️ 持仓时间 vs 胜率");
    console.log("═══════════════════════════════════════");
    const holdBuckets = [
        { label: "<1分钟", min: 0, max: 1 },
        { label: "1-5分钟", min: 1, max: 5 },
        { label: "5-15分钟", min: 5, max: 15 },
        { label: "15-30分钟", min: 15, max: 30 },
        { label: "30-60分钟", min: 30, max: 60 },
        { label: ">1小时", min: 60, max: Infinity },
    ];
    for (const b of holdBuckets) {
        const bucket = completeTrades.filter(t => t.holdMinutes >= b.min && t.holdMinutes < b.max);
        if (bucket.length === 0) continue;
        const bWins = bucket.filter(t => t.netPnlU > 0).length;
        const bPnl = bucket.reduce((s, t) => s + t.netPnlU, 0);
        const avgPnl = bPnl / bucket.length;
        console.log(`  ${b.label.padEnd(10)} | ${String(bucket.length).padStart(4)}笔 | 胜率${(bWins / bucket.length * 100).toFixed(0).padStart(3)}% | 均PnL: ${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(1)}`);
    }

    // ═══ TOP 10 最大亏损 ═══
    console.log("\n═══════════════════════════════════════");
    console.log("  ❌ TOP 10 最大单笔亏损");
    console.log("═══════════════════════════════════════");
    const worstTrades = [...completeTrades].sort((a, b) => a.netPnlU - b.netPnlU).slice(0, 10);
    for (const t of worstTrades) {
        console.log(`  ${t.openDate.slice(5, 16)} | ${t.direction} | ${t.netPnlU.toFixed(1)}U | ${t.grossPnlPt.toFixed(1)}pt | 持仓${t.holdMinutes}min | ${t.isBot ? "🤖" : "📱"} | ${t.hour}:00`);
    }

    // ═══ TOP 10 最大盈利 ═══
    console.log("\n═══════════════════════════════════════");
    console.log("  ✅ TOP 10 最大单笔盈利");
    console.log("═══════════════════════════════════════");
    const bestTrades = [...completeTrades].sort((a, b) => b.netPnlU - a.netPnlU).slice(0, 10);
    for (const t of bestTrades) {
        console.log(`  ${t.openDate.slice(5, 16)} | ${t.direction} | +${t.netPnlU.toFixed(1)}U | +${t.grossPnlPt.toFixed(1)}pt | 持仓${t.holdMinutes}min | ${t.isBot ? "🤖" : "📱"} | ${t.hour}:00`);
    }

    // ═══ 保存完整分析报告 ═══
    const report = {
        generatedAt: new Date().toISOString(),
        summary: {
            totalTrades: completeTrades.length,
            wins: wins.length,
            losses: losses.length,
            winRate: completeTrades.length > 0 ? +(wins.length / completeTrades.length * 100).toFixed(1) : 0,
            totalGrossPnl: +totalGross.toFixed(2),
            totalFees: +totalFees.toFixed(2),
            totalNetPnl: +totalPnl.toFixed(2),
            avgWin: wins.length > 0 ? +(wins.reduce((s, t) => s + t.netPnlU, 0) / wins.length).toFixed(2) : 0,
            avgLoss: losses.length > 0 ? +(losses.reduce((s, t) => s + t.netPnlU, 0) / losses.length).toFixed(2) : 0,
        },
        byDirection: { longCount: longs.length, shortCount: shorts.length, longPnl: +longPnl.toFixed(2), shortPnl: +shortPnl.toFixed(2) },
        byHour: hourMap,
        byDay: dayMap,
        botVsManual: {
            bot: { count: botTrades.length, pnl: +botPnl.toFixed(2), winRate: botTrades.length > 0 ? +(botWins / botTrades.length * 100).toFixed(1) : 0 },
            manual: { count: manualTrades.length, pnl: +manPnl.toFixed(2), winRate: manualTrades.length > 0 ? +(manWins / manualTrades.length * 100).toFixed(1) : 0 },
        },
        worst10: worstTrades.map(t => ({ date: t.openDate, dir: t.direction, netPnl: +t.netPnlU.toFixed(2), pts: +t.grossPnlPt.toFixed(2), hold: t.holdMinutes, hour: t.hour, isBot: t.isBot })),
        best10: bestTrades.map(t => ({ date: t.openDate, dir: t.direction, netPnl: +t.netPnlU.toFixed(2), pts: +t.grossPnlPt.toFixed(2), hold: t.holdMinutes, hour: t.hour, isBot: t.isBot })),
        allTrades: completeTrades,
    };

    writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2));
    console.log(`\n📁 完整报告已保存: ${OUTPUT_FILE}`);
    console.log("═══════════════════════════════════════\n");
}

main();
