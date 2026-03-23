/**
 * 🧠 自我反思引擎 — Bot 交易日志分析 + 优化洞察
 * ═══════════════════════════════════════════════════════
 * 读取 data/trades.jsonl，多维度分析交易表现，
 * 生成可执行的优化建议，通过 TG 通知 CEO。
 *
 * 独立运行: bun src/self-reflect.ts
 * 嵌入运行: import { SelfReflector } from "./self-reflect"
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

// ═══════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════

/** 从 executor.ts logTrade() 写入的单条交易记录 */
interface TradeRecord {
    ts: number;
    date: string;
    symbol: string;
    side: string;           // "long" | "short"
    window: string;
    dayOfWeek: number;
    entryPrice: number;
    signalPrice: number;
    slippage: number;
    pnlPt: number;
    netPnlU: number;
    reason: string;
    holdMinutes: number;
    bestProfitPt: number;
    breakevenHit: boolean;
    slPt: number;
    tpPt: number;
    qty: number;
    leverage: number;
    atr: number;
    mtfScore: number;
    fundingRate: number;
    ema3: number;
    ema7: number;
    ema20: number;
    volRatio: number;
    pocSlope: number;
}

/** 分析结果 */
interface PerformanceAnalysis {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    avgPnl: number;
    // 方向拆分
    longCount: number;
    longWins: number;
    longWinRate: number;
    longPnl: number;
    shortCount: number;
    shortWins: number;
    shortWinRate: number;
    shortPnl: number;
    // 连亏
    currentStreak: number;       // 当前连亏 (<0) 或连赢 (>0)
    maxLossStreak: number;       // 历史最大连亏
    streakPnl: number;           // 当前连亏金额
    // SL 有效性
    slTradeCount: number;        // 被 SL 扫掉的笔数
    slAvgBestProfit: number;     // 被扫SL的单，平均最大浮盈
    slTooTight: boolean;         // SL 是否太紧
    // 保本效率
    breakevenCount: number;      // 触发保本的笔数
    breakevenProfitRate: number; // 保本后最终盈利的比例
    breakevenAvgProfit: number;  // 保本后平均最终盈利
    // 滑点
    avgSlippage: number;
    maxSlippage: number;
    // 时段拆分
    hourlyStats: Record<number, { count: number; wins: number; pnl: number }>;
    // 持仓时间
    avgHoldMinutes: number;
    winAvgHold: number;
    lossAvgHold: number;
}

/** 洞察建议 */
interface Insight {
    level: "🚨" | "⚠️" | "💡" | "✅";  // 严重 / 警告 / 建议 / 好消息
    message: string;
}

// ═══════════════════════════════════════
// 核心类
// ═══════════════════════════════════════

const TRADES_FILE = join(process.cwd(), "data", "trades.jsonl");

export class SelfReflector {

    /** 读取最近 N 天的交易日志 */
    static readRecentTrades(days: number = 7): TradeRecord[] {
        if (!existsSync(TRADES_FILE)) return [];

        const cutoff = Date.now() - days * 24 * 3600_000;
        const lines = readFileSync(TRADES_FILE, "utf-8").trim().split("\n");
        const trades: TradeRecord[] = [];

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const t = JSON.parse(line) as TradeRecord;
                if (t.ts >= cutoff) trades.push(t);
            } catch { /* 跳过损坏行 */ }
        }

        return trades.sort((a, b) => a.ts - b.ts);
    }

    /** 多维度分析交易表现 */
    static analyzePerformance(trades: TradeRecord[]): PerformanceAnalysis {
        const wins = trades.filter(t => t.netPnlU > 0);
        const losses = trades.filter(t => t.netPnlU <= 0);
        const totalPnl = trades.reduce((s, t) => s + t.netPnlU, 0);

        // ═══ 方向拆分 ═══
        const longs = trades.filter(t => t.side === "long");
        const shorts = trades.filter(t => t.side === "short");
        const longWins = longs.filter(t => t.netPnlU > 0);
        const shortWins = shorts.filter(t => t.netPnlU > 0);

        // ═══ 连亏检测 ═══
        let currentStreak = 0;
        let maxLossStreak = 0;
        let streakPnl = 0;
        let tempStreak = 0;

        for (const t of trades) {
            if (t.netPnlU > 0) {
                tempStreak = tempStreak > 0 ? tempStreak + 1 : 1;
            } else {
                tempStreak = tempStreak < 0 ? tempStreak - 1 : -1;
            }
            if (tempStreak < maxLossStreak) maxLossStreak = tempStreak;
        }
        maxLossStreak = Math.abs(maxLossStreak);

        // 当前连续状态（从最后一笔往前数）
        if (trades.length > 0) {
            const last = trades[trades.length - 1];
            currentStreak = last.netPnlU > 0 ? 1 : -1;
            streakPnl = last.netPnlU;
            for (let i = trades.length - 2; i >= 0; i--) {
                const t = trades[i];
                if ((currentStreak > 0 && t.netPnlU > 0) || (currentStreak < 0 && t.netPnlU <= 0)) {
                    currentStreak += currentStreak > 0 ? 1 : -1;
                    streakPnl += t.netPnlU;
                } else {
                    break;
                }
            }
        }

        // ═══ SL 有效性 ═══
        const slTrades = trades.filter(t => t.reason.includes("硬止损") || t.reason.includes("STOP"));
        const slAvgBest = slTrades.length > 0
            ? slTrades.reduce((s, t) => s + t.bestProfitPt, 0) / slTrades.length
            : 0;
        const avgSlPt = trades.length > 0
            ? trades.reduce((s, t) => s + t.slPt, 0) / trades.length
            : 20;
        const slTooTight = slTrades.length >= 3 && slAvgBest > avgSlPt * 0.6;

        // ═══ 保本效率 ═══
        const beTrades = trades.filter(t => t.breakevenHit);
        const beProfitable = beTrades.filter(t => t.netPnlU > 0);
        const beAvgProfit = beTrades.length > 0
            ? beTrades.reduce((s, t) => s + t.netPnlU, 0) / beTrades.length
            : 0;

        // ═══ 滑点 ═══
        const slippages = trades.map(t => t.slippage).filter(s => s > 0);
        const avgSlip = slippages.length > 0 ? slippages.reduce((a, b) => a + b, 0) / slippages.length : 0;
        const maxSlip = slippages.length > 0 ? Math.max(...slippages) : 0;

        // ═══ 时段 ═══
        const hourlyStats: Record<number, { count: number; wins: number; pnl: number }> = {};
        for (const t of trades) {
            const d = new Date(t.ts);
            const utcH = d.getUTCHours();
            if (!hourlyStats[utcH]) hourlyStats[utcH] = { count: 0, wins: 0, pnl: 0 };
            hourlyStats[utcH].count++;
            if (t.netPnlU > 0) hourlyStats[utcH].wins++;
            hourlyStats[utcH].pnl += t.netPnlU;
        }

        // ═══ 持仓时间 ═══
        const avgHold = trades.length > 0
            ? trades.reduce((s, t) => s + t.holdMinutes, 0) / trades.length : 0;
        const winHold = wins.length > 0
            ? wins.reduce((s, t) => s + t.holdMinutes, 0) / wins.length : 0;
        const lossHold = losses.length > 0
            ? losses.reduce((s, t) => s + t.holdMinutes, 0) / losses.length : 0;

        return {
            totalTrades: trades.length,
            wins: wins.length,
            losses: losses.length,
            winRate: trades.length > 0 ? wins.length / trades.length : 0,
            totalPnl,
            avgPnl: trades.length > 0 ? totalPnl / trades.length : 0,
            longCount: longs.length,
            longWins: longWins.length,
            longWinRate: longs.length > 0 ? longWins.length / longs.length : 0,
            longPnl: longs.reduce((s, t) => s + t.netPnlU, 0),
            shortCount: shorts.length,
            shortWins: shortWins.length,
            shortWinRate: shorts.length > 0 ? shortWins.length / shorts.length : 0,
            shortPnl: shorts.reduce((s, t) => s + t.netPnlU, 0),
            currentStreak,
            maxLossStreak,
            streakPnl,
            slTradeCount: slTrades.length,
            slAvgBestProfit: slAvgBest,
            slTooTight,
            breakevenCount: beTrades.length,
            breakevenProfitRate: beTrades.length > 0 ? beProfitable.length / beTrades.length : 0,
            breakevenAvgProfit: beAvgProfit,
            avgSlippage: avgSlip,
            maxSlippage: maxSlip,
            hourlyStats,
            avgHoldMinutes: avgHold,
            winAvgHold: winHold,
            lossAvgHold: lossHold,
        };
    }

    /** 基于规则的洞察生成器 */
    static generateInsights(a: PerformanceAnalysis): Insight[] {
        const insights: Insight[] = [];

        // ═══ 规则 0: 数据不足 ═══
        if (a.totalTrades < 3) {
            insights.push({ level: "💡", message: `仅${a.totalTrades}笔交易，数据不足，继续积累` });
            return insights;
        }

        // ═══ 规则 1: 总体表现 ═══
        if (a.winRate >= 0.55) {
            insights.push({ level: "✅", message: `胜率${(a.winRate * 100).toFixed(0)}% 表现优秀` });
        } else if (a.winRate < 0.40) {
            insights.push({ level: "⚠️", message: `胜率仅${(a.winRate * 100).toFixed(0)}%，低于40%警戒线` });
        }

        // ═══ 规则 2: 方向偏好 ═══
        if (a.longCount >= 5 && a.longWinRate < 0.35) {
            insights.push({
                level: "⚠️",
                message: `做多胜率仅${(a.longWinRate * 100).toFixed(0)}%(${a.longWins}/${a.longCount})，PnL ${a.longPnl >= 0 ? "+" : ""}${a.longPnl.toFixed(0)}U → 建议暂停做多`,
            });
        }
        if (a.shortCount >= 5 && a.shortWinRate < 0.35) {
            insights.push({
                level: "⚠️",
                message: `做空胜率仅${(a.shortWinRate * 100).toFixed(0)}%(${a.shortWins}/${a.shortCount})，PnL ${a.shortPnl >= 0 ? "+" : ""}${a.shortPnl.toFixed(0)}U → 建议暂停做空`,
            });
        }
        if (a.longCount >= 5 && a.longWinRate >= 0.60) {
            insights.push({ level: "✅", message: `做多表现优秀 胜率${(a.longWinRate * 100).toFixed(0)}% PnL+${a.longPnl.toFixed(0)}U` });
        }
        if (a.shortCount >= 5 && a.shortWinRate >= 0.60) {
            insights.push({ level: "✅", message: `做空表现优秀 胜率${(a.shortWinRate * 100).toFixed(0)}% PnL+${a.shortPnl.toFixed(0)}U` });
        }

        // ═══ 规则 3: 连亏警报 ═══
        if (a.currentStreak <= -3) {
            insights.push({
                level: "🚨",
                message: `连亏${Math.abs(a.currentStreak)}笔 共${a.streakPnl.toFixed(0)}U → 建议暂停观望`,
            });
        } else if (a.currentStreak <= -2) {
            insights.push({
                level: "⚠️",
                message: `连亏${Math.abs(a.currentStreak)}笔 ${a.streakPnl.toFixed(0)}U，注意风控`,
            });
        } else if (a.currentStreak >= 3) {
            insights.push({ level: "✅", message: `连赢${a.currentStreak}笔 +${a.streakPnl.toFixed(0)}U 🔥` });
        }

        // ═══ 规则 4: SL 有效性 ═══
        if (a.slTooTight) {
            insights.push({
                level: "⚠️",
                message: `SL太紧! ${a.slTradeCount}笔被扫，平均曾浮盈+${a.slAvgBestProfit.toFixed(0)}pt → 考虑放宽SL`,
            });
        }

        // ═══ 规则 5: 保本效率 ═══
        if (a.breakevenCount >= 5 && a.breakevenProfitRate < 0.50) {
            insights.push({
                level: "💡",
                message: `保本触发${a.breakevenCount}次，仅${(a.breakevenProfitRate * 100).toFixed(0)}%最终盈利 → 考虑延后保本PT`,
            });
        }

        // ═══ 规则 6: 滑点异常 ═══
        if (a.avgSlippage > 1.5) {
            insights.push({
                level: "⚠️",
                message: `平均滑点${a.avgSlippage.toFixed(1)}pt(最大${a.maxSlippage.toFixed(1)}pt) → 考虑LIMIT入场`,
            });
        }

        // ═══ 规则 7: 亏损时段 ═══
        const worstHours = Object.entries(a.hourlyStats)
            .filter(([_, s]) => s.count >= 3 && s.pnl < 0)
            .sort((a, b) => a[1].pnl - b[1].pnl)
            .slice(0, 2);
        for (const [h, s] of worstHours) {
            const wr = (s.wins / s.count * 100).toFixed(0);
            insights.push({
                level: "💡",
                message: `UTC ${h}点 负期望: ${s.count}笔 胜率${wr}% PnL${s.pnl.toFixed(0)}U → 考虑避开`,
            });
        }

        // ═══ 规则 8: 持仓时间洞察 ═══
        if (a.winAvgHold > 0 && a.lossAvgHold > 0 && a.lossAvgHold > a.winAvgHold * 2) {
            insights.push({
                level: "💡",
                message: `亏单平均持仓${a.lossAvgHold.toFixed(0)}min 是赢单的${(a.lossAvgHold / a.winAvgHold).toFixed(1)}倍 → 亏单应更快止损`,
            });
        }

        // 如果一切正常
        if (insights.length === 0) {
            insights.push({ level: "✅", message: "各项指标正常，继续执行当前策略" });
        }

        return insights;
    }

    /** 格式化为 Telegram 快速摘要 (3-5行) */
    static formatQuickReport(a: PerformanceAnalysis, insights: Insight[]): string {
        if (a.totalTrades === 0) {
            return "🧠 *自我反思*\n无交易记录，等待第一笔交易后再分析";
        }

        const pnlEmoji = a.totalPnl >= 0 ? "✅" : "❌";
        const streakEmoji = a.currentStreak >= 0 ? "🔥" : "💀";

        let msg = `🧠 *自我反思 (${a.totalTrades}笔)*\n`;
        msg += `──────────\n`;
        msg += `${pnlEmoji} 胜率${(a.winRate * 100).toFixed(0)}% | PnL ${a.totalPnl >= 0 ? "+" : ""}${a.totalPnl.toFixed(0)}U\n`;
        msg += `📈多:${a.longWins}/${a.longCount}(${a.longCount > 0 ? (a.longWinRate * 100).toFixed(0) : "—"}%) 📉空:${a.shortWins}/${a.shortCount}(${a.shortCount > 0 ? (a.shortWinRate * 100).toFixed(0) : "—"}%)\n`;
        msg += `${streakEmoji} 当前${a.currentStreak > 0 ? "连赢" : "连亏"}${Math.abs(a.currentStreak)}笔\n`;
        msg += `──────────\n`;

        // 取最重要的 2 条洞察
        const top = insights
            .sort((a, b) => {
                const order = { "🚨": 0, "⚠️": 1, "💡": 2, "✅": 3 };
                return (order[a.level] ?? 4) - (order[b.level] ?? 4);
            })
            .slice(0, 2);
        for (const i of top) {
            msg += `${i.level} ${i.message}\n`;
        }

        return msg;
    }

    /** 格式化为 Telegram 深度报告 (完整版) */
    static formatDeepReport(a: PerformanceAnalysis, insights: Insight[]): string {
        if (a.totalTrades === 0) {
            return "🧠 *深度反思*\n无交易记录";
        }

        let msg = `🧠 *深度反思 (${a.totalTrades}笔 近7天)*\n`;
        msg += `════════════\n`;

        // 总体
        msg += `📊 *总体*\n`;
        msg += `  胜率: ${(a.winRate * 100).toFixed(0)}% (${a.wins}W/${a.losses}L)\n`;
        msg += `  PnL: ${a.totalPnl >= 0 ? "+" : ""}${a.totalPnl.toFixed(1)}U | 均${a.avgPnl >= 0 ? "+" : ""}${a.avgPnl.toFixed(1)}U/笔\n`;

        // 方向
        msg += `📈 *方向*\n`;
        msg += `  多: ${a.longWins}/${a.longCount} (${a.longCount > 0 ? (a.longWinRate * 100).toFixed(0) : "—"}%) ${a.longPnl >= 0 ? "+" : ""}${a.longPnl.toFixed(0)}U\n`;
        msg += `  空: ${a.shortWins}/${a.shortCount} (${a.shortCount > 0 ? (a.shortWinRate * 100).toFixed(0) : "—"}%) ${a.shortPnl >= 0 ? "+" : ""}${a.shortPnl.toFixed(0)}U\n`;

        // 风控
        msg += `🛡️ *风控*\n`;
        msg += `  连亏: 当前${Math.abs(a.currentStreak)}笔 | 历史最大${a.maxLossStreak}笔\n`;
        msg += `  SL被扫: ${a.slTradeCount}笔 | 被扫前均浮盈+${a.slAvgBestProfit.toFixed(0)}pt\n`;
        msg += `  保本: ${a.breakevenCount}次触发 | ${(a.breakevenProfitRate * 100).toFixed(0)}%最终盈利\n`;
        msg += `  滑点: 均${a.avgSlippage.toFixed(1)}pt | 最大${a.maxSlippage.toFixed(1)}pt\n`;

        // 持仓
        msg += `⏱️ *持仓*\n`;
        msg += `  均${a.avgHoldMinutes.toFixed(0)}min | 赢单${a.winAvgHold.toFixed(0)}min | 亏单${a.lossAvgHold.toFixed(0)}min\n`;

        // 时段
        const sortedHours = Object.entries(a.hourlyStats).sort((a, b) => +a[0] - +b[0]);
        if (sortedHours.length > 0) {
            msg += `⏰ *时段(UTC)*\n`;
            for (const [h, s] of sortedHours) {
                const wr = (s.wins / s.count * 100).toFixed(0);
                const icon = s.pnl >= 0 ? "🟢" : "🔴";
                msg += `  ${icon} ${String(h).padStart(2)}h: ${s.count}笔 ${wr}% ${s.pnl >= 0 ? "+" : ""}${s.pnl.toFixed(0)}U\n`;
            }
        }

        // 洞察
        msg += `════════════\n`;
        msg += `💡 *优化洞察*\n`;
        for (const i of insights) {
            msg += `${i.level} ${i.message}\n`;
        }

        return msg;
    }

    /** 一键分析 (供 main.ts 调用) */
    static quickAnalyze(days: number = 7): { report: string; deepReport: string; insights: Insight[]; isLossStreak: boolean; streakCount: number } {
        const trades = this.readRecentTrades(days);
        const analysis = this.analyzePerformance(trades);
        const insights = this.generateInsights(analysis);

        return {
            report: this.formatQuickReport(analysis, insights),
            deepReport: this.formatDeepReport(analysis, insights),
            insights,
            isLossStreak: analysis.currentStreak <= -3,
            streakCount: analysis.currentStreak,
        };
    }
}

// ═══════════════════════════════════════
// 独立运行入口
// ═══════════════════════════════════════
if (import.meta.main) {
    console.log("═══════════════════════════════════════");
    console.log("  🧠 自我反思引擎 — 独立分析模式");
    console.log("═══════════════════════════════════════\n");

    const trades = SelfReflector.readRecentTrades(30);  // 近30天
    console.log(`📁 读取到 ${trades.length} 笔交易记录\n`);

    if (trades.length === 0) {
        console.log("⚠️ 无交易记录，请确认 data/trades.jsonl 存在");
        process.exit(0);
    }

    const analysis = SelfReflector.analyzePerformance(trades);
    const insights = SelfReflector.generateInsights(analysis);

    // 打印完整分析
    console.log("═══ 总体 ═══");
    console.log(`交易数: ${analysis.totalTrades} | 赢:${analysis.wins} 亏:${analysis.losses}`);
    console.log(`胜率: ${(analysis.winRate * 100).toFixed(1)}%`);
    console.log(`PnL: ${analysis.totalPnl >= 0 ? "+" : ""}${analysis.totalPnl.toFixed(2)}U`);
    console.log(`均PnL: ${analysis.avgPnl >= 0 ? "+" : ""}${analysis.avgPnl.toFixed(2)}U/笔`);

    console.log("\n═══ 方向 ═══");
    console.log(`做多: ${analysis.longWins}/${analysis.longCount} (${analysis.longCount > 0 ? (analysis.longWinRate * 100).toFixed(0) : "—"}%) PnL ${analysis.longPnl >= 0 ? "+" : ""}${analysis.longPnl.toFixed(1)}U`);
    console.log(`做空: ${analysis.shortWins}/${analysis.shortCount} (${analysis.shortCount > 0 ? (analysis.shortWinRate * 100).toFixed(0) : "—"}%) PnL ${analysis.shortPnl >= 0 ? "+" : ""}${analysis.shortPnl.toFixed(1)}U`);

    console.log("\n═══ 风控 ═══");
    console.log(`当前连续: ${analysis.currentStreak > 0 ? "连赢" : "连亏"}${Math.abs(analysis.currentStreak)}笔 (${analysis.streakPnl >= 0 ? "+" : ""}${analysis.streakPnl.toFixed(1)}U)`);
    console.log(`历史最大连亏: ${analysis.maxLossStreak}笔`);
    console.log(`SL被扫: ${analysis.slTradeCount}笔 | 被扫前均浮盈+${analysis.slAvgBestProfit.toFixed(1)}pt`);
    console.log(`保本触发: ${analysis.breakevenCount}次 | ${(analysis.breakevenProfitRate * 100).toFixed(0)}%最终盈利`);
    console.log(`滑点: 均${analysis.avgSlippage.toFixed(1)}pt | 最大${analysis.maxSlippage.toFixed(1)}pt`);

    console.log("\n═══ 持仓时间 ═══");
    console.log(`平均: ${analysis.avgHoldMinutes.toFixed(0)}min | 赢单: ${analysis.winAvgHold.toFixed(0)}min | 亏单: ${analysis.lossAvgHold.toFixed(0)}min`);

    console.log("\n═══ 时段(UTC) ═══");
    const sorted = Object.entries(analysis.hourlyStats).sort((a, b) => +a[0] - +b[0]);
    for (const [h, s] of sorted) {
        const wr = (s.wins / s.count * 100).toFixed(0);
        const icon = s.pnl >= 0 ? "🟢" : "🔴";
        console.log(`  ${icon} UTC ${String(h).padStart(2)}h: ${s.count}笔 胜率${wr}% PnL ${s.pnl >= 0 ? "+" : ""}${s.pnl.toFixed(0)}U`);
    }

    console.log("\n═══════════════════════════════════════");
    console.log("  💡 优化洞察");
    console.log("═══════════════════════════════════════");
    for (const i of insights) {
        console.log(`  ${i.level} ${i.message}`);
    }

    console.log("\n═══ TG 快速摘要 ═══");
    console.log(SelfReflector.formatQuickReport(analysis, insights));

    console.log("\n═══ TG 深度报告 ═══");
    console.log(SelfReflector.formatDeepReport(analysis, insights));
}
