/**
 * 🧠 V94 策略回测 — MuleRun 数据驱动策略
 * ═══════════════════════════════════════════════════
 * 核心理念: 不预测方向，等待动量确认后顺势入场
 *
 * 数据驱动的 6 条规则:
 * 1. 动量确认: 入场前 30 分钟价格已动 0.3%+
 * 2. 量确认: 当前K线成交量 > 1.2x 均量
 * 3. EMA 排列: 短期 EMA 已排列好
 * 4. 方向: 做空（数据验证）, 但也允许做多（有条件）
 * 5. 时段: 排除地雷时段 (22-01, 周二三减仓)
 * 6. 出场: SL=15pt, TP跟踪, 30-60min 最优持仓
 *
 * 用法: bun src/backtest-v94.ts
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ═══ 配置 ═══
const LEVERAGE = 150;
const TAKER_FEE = 0.0004;
const INITIAL_CAPITAL = 200;          // $200 起始
const MARGIN_PER_TRADE = 15;          // 每单 $15 保证金

// 策略参数 (数据驱动)
const SL_PT = 15;                     // 中位亏损 13.2pt + buffer
const TP_PT = 30;                     // 让利润跑, RR=1:2
const BREAKEVEN_PT = 8;               // 浮盈 8pt → 保本
const BREAKEVEN_OFFSET = 2;           // 保本偏移
const TRAIL_PT = 8;                   // 跟踪距离

// 入场过滤
const MOMENTUM_THRESHOLD = 0.003;     // 30分钟价格变化 > 0.3%
const VOL_RATIO_MIN = 1.2;           // 量比 > 1.2x
const EMA_GAP_MIN = 1.5;             // EMA3-EMA7 最小间距 (pt)
const ATR_MIN = 6;                    // 最低波动
const ATR_MAX = 40;                   // 最高波动 (超过此值太危险)

// 时段过滤 (UTC+8) — 基于稳健数据
const BANNED_HOURS = [22, 23, 0, 1, 2, 7, 8, 13, 17]; // 负PnL时段
const PREFERRED_HOURS = [3, 6, 16, 19, 20];           // 正PnL时段

// 星期过滤
const WEAK_DAYS = [2, 3]; // 周二=2, 周三=3 减半仓位

const MAX_HOLD_BARS = 12;   // 最大持仓12根5m K线=60分钟
const MIN_HOLD_BARS = 6;    // 最少30分钟 (排除极短期噪音)
const MAX_DAILY_TRADES = 4;
const MAX_DAILY_LOSS = 100;

// ═══ 指标 ═══
function calcEMA(closes: number[], period: number): number {
    if (closes.length < period) return closes[closes.length - 1] || 0;
    let ema = closes.slice(0, period).reduce((a, b) => a + b) / period;
    const m = 2 / (period + 1);
    for (let i = period; i < closes.length; i++) ema = closes[i] * m + ema * (1 - m);
    return ema;
}

function calcATR(klines: { h: number; l: number; c: number }[], period = 14): number {
    if (klines.length < period + 1) return 0;
    let sum = 0;
    for (let i = klines.length - period; i < klines.length; i++) {
        sum += klines[i].h - klines[i].l;
    }
    return sum / period;
}

interface Bar { o: number; h: number; l: number; c: number; v: number; ts: number; }

// ═══ K线数据 (Binance 公开 API, 免签名, 一次最多 1500 根) ═══
async function fetchKlines(symbol: string, startTs: number, endTs: number): Promise<Bar[]> {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=5m&startTime=${startTs}&endTime=${endTs}&limit=1500`;
    const res = await fetch(url);
    let data: any;
    try { data = await res.json(); } catch { return []; }
    if (!Array.isArray(data)) return [];

    return data.map((k: any) => ({
        o: +k[1], h: +k[2], l: +k[3], c: +k[4],
        v: +k[5],  // volume
        ts: +k[0], // open time
    }));
}

// ═══ 回测引擎 ═══
interface Trade {
    entryTs: number;
    entryPrice: number;
    side: "SHORT" | "LONG";
    sl: number;
    tp: number;
    exitTs: number;
    exitPrice: number;
    exitReason: string;
    pnlPt: number;
    pnlU: number;
    holdBars: number;
    hour: number;
    dayOfWeek: number;
}

async function main() {
    console.log("═══════════════════════════════════════════════════");
    console.log("  🧠 V94 回测 — MuleRun 数据驱动策略");
    console.log("═══════════════════════════════════════════════════\n");

    // 拉取 3 个月 5m K线
    const symbol = "ETHUSDT";
    const periods = [
        { label: "2026-01", start: new Date("2026-01-01T00:00:00+08:00").getTime(), end: new Date("2026-01-31T23:59:59+08:00").getTime() },
        { label: "2026-02", start: new Date("2026-02-01T00:00:00+08:00").getTime(), end: new Date("2026-02-28T23:59:59+08:00").getTime() },
        { label: "2026-03", start: new Date("2026-03-01T00:00:00+08:00").getTime(), end: new Date("2026-03-22T23:59:59+08:00").getTime() },
    ];

    const allTrades: Trade[] = [];

    for (const period of periods) {
        console.log(`📊 拉取 ${period.label} K线数据...`);

        // 分段拉取 (API最多返回100根)
        let allBars: Bar[] = [];
        let cursor = period.start;
        while (cursor < period.end) {
            const segEnd = Math.min(cursor + 100 * 5 * 60_000, period.end);
            const bars = await fetchKlines(symbol, cursor, segEnd);
            if (bars.length === 0) { cursor = segEnd; await Bun.sleep(300); continue; }
            allBars = allBars.concat(bars);
            cursor = bars[bars.length - 1].ts + 60_000;
            await Bun.sleep(200);
        }

        // 去重
        const seen = new Set<number>();
        allBars = allBars.filter(b => { if (seen.has(b.ts)) return false; seen.add(b.ts); return true; });
        allBars.sort((a, b) => a.ts - b.ts);
        console.log(`  ✅ ${allBars.length} 根 5m K线\n`);

        if (allBars.length < 50) continue;

        // ═══ 逐根 K 线回测 ═══
        let capital = INITIAL_CAPITAL;
        let dailyLoss = 0;
        let dailyTrades = 0;
        let currentDay = "";
        let inPosition = false;
        let posEntry = 0, posSide: "SHORT" | "LONG" = "SHORT";
        let posSl = 0, posTp = 0, posTs = 0, posBars = 0;
        let bestProfit = 0, beTrigger = false;

        for (let i = 30; i < allBars.length; i++) {
            const bar = allBars[i];
            const dt = new Date(bar.ts);
            const utc8h = (dt.getUTCHours() + 8) % 24;
            const dayStr = dt.toISOString().slice(0, 10);
            const dow = dt.getDay();

            // 日重置
            if (dayStr !== currentDay) {
                currentDay = dayStr;
                dailyLoss = 0;
                dailyTrades = 0;
            }

            // 持仓管理
            if (inPosition) {
                posBars++;
                const curPnl = posSide === "SHORT"
                    ? posEntry - bar.c
                    : bar.c - posEntry;

                if (curPnl > bestProfit) bestProfit = curPnl;

                // 保本触发
                if (!beTrigger && curPnl >= BREAKEVEN_PT) {
                    beTrigger = true;
                    posSl = posEntry + (posSide === "SHORT" ? -BREAKEVEN_OFFSET : BREAKEVEN_OFFSET);
                }

                // 跟踪止损
                if (beTrigger && bestProfit > BREAKEVEN_PT) {
                    const trailSl = posSide === "SHORT"
                        ? (posEntry - bestProfit + TRAIL_PT)
                        : (posEntry + bestProfit - TRAIL_PT);
                    if (posSide === "SHORT" && trailSl < posSl) posSl = trailSl;
                    if (posSide === "LONG" && trailSl > posSl) posSl = trailSl;
                }

                // 检查止损/止盈/超时
                let exitPrice = 0, exitReason = "";

                // SL
                if (posSide === "SHORT" && bar.h >= posSl) { exitPrice = posSl; exitReason = "SL"; }
                if (posSide === "LONG" && bar.l <= posSl) { exitPrice = posSl; exitReason = "SL"; }

                // TP
                if (posTp > 0) {
                    if (posSide === "SHORT" && bar.l <= posTp) { exitPrice = posTp; exitReason = "TP"; }
                    if (posSide === "LONG" && bar.h >= posTp) { exitPrice = posTp; exitReason = "TP"; }
                }

                // 超时
                if (!exitReason && posBars >= MAX_HOLD_BARS) {
                    exitPrice = bar.c; exitReason = "TIMEOUT";
                }

                if (exitReason) {
                    const pnlPt = posSide === "SHORT" ? posEntry - exitPrice : exitPrice - posEntry;
                    const qty = MARGIN_PER_TRADE * LEVERAGE / posEntry;
                    const fee = qty * exitPrice * TAKER_FEE * 2;
                    const pnlU = pnlPt * qty - fee;

                    allTrades.push({
                        entryTs: posTs, entryPrice: posEntry, side: posSide,
                        sl: posSl, tp: posTp,
                        exitTs: bar.ts, exitPrice, exitReason,
                        pnlPt, pnlU, holdBars: posBars,
                        hour: (new Date(posTs).getUTCHours() + 8) % 24,
                        dayOfWeek: new Date(posTs).getDay(),
                    });

                    capital += pnlU;
                    if (pnlU < 0) dailyLoss += Math.abs(pnlU);
                    inPosition = false;
                }
                continue;
            }

            // ═══ 入场条件检测 ═══

            // 安全检查
            if (capital <= 0 || dailyTrades >= MAX_DAILY_TRADES || dailyLoss >= MAX_DAILY_LOSS) continue;

            // 时段过滤
            if (BANNED_HOURS.includes(utc8h)) continue;

            // 计算指标
            const lookback = allBars.slice(Math.max(0, i - 30), i + 1);
            const closes = lookback.map(b => b.c);

            const ema3 = calcEMA(closes, 3);
            const ema7 = calcEMA(closes, 7);
            const ema20 = calcEMA(closes, Math.min(20, closes.length));
            const atr = calcATR(lookback);

            if (atr < ATR_MIN || atr > ATR_MAX) continue;

            // 动量确认 (前6根K线 = 30分钟)
            const momentumLookback = Math.min(6, lookback.length - 1);
            const priceStart = lookback[lookback.length - 1 - momentumLookback].c;
            const priceNow = bar.c;
            const momentum = (priceNow - priceStart) / priceStart;

            // 量比
            const vols = lookback.slice(-21, -1).map(b => b.v);
            const avgVol = vols.length > 0 ? vols.reduce((a, b) => a + b) / vols.length : 1;
            const volRatio = avgVol > 0 ? bar.v / avgVol : 0;

            // ═══ 做空条件 ═══
            const shortMomentum = momentum < -MOMENTUM_THRESHOLD;
            const shortEma = ema3 < ema7 && ema7 < ema20;
            const shortEmaGap = Math.abs(ema3 - ema7) >= EMA_GAP_MIN;
            const shortVol = volRatio >= VOL_RATIO_MIN;
            const priceBelow20 = priceNow < ema20;

            if (shortMomentum && shortEma && shortEmaGap && shortVol && priceBelow20) {
                const marginMult = WEAK_DAYS.includes(dow) ? 0.5 : 1.0;
                const boost = PREFERRED_HOURS.includes(utc8h) ? 1.0 : 0.8;

                posEntry = priceNow;
                posSide = "SHORT";
                posSl = posEntry + SL_PT;
                posTp = TP_PT > 0 ? posEntry - TP_PT : 0;
                posTs = bar.ts;
                posBars = 0;
                bestProfit = 0;
                beTrigger = false;
                inPosition = true;
                dailyTrades++;
                continue;
            }

            // ═══ 做多条件 (更严格) ═══
            const longMomentum = momentum > MOMENTUM_THRESHOLD * 1.5; // 做多要求更高动量
            const longEma = ema3 > ema7 && ema7 > ema20;
            const longEmaGap = Math.abs(ema3 - ema7) >= EMA_GAP_MIN * 1.5;
            const longVol = volRatio >= VOL_RATIO_MIN * 1.2;
            const priceAbove20 = priceNow > ema20;

            if (longMomentum && longEma && longEmaGap && longVol && priceAbove20 && PREFERRED_HOURS.includes(utc8h)) {
                posEntry = priceNow;
                posSide = "LONG";
                posSl = posEntry - SL_PT;
                posTp = TP_PT > 0 ? posEntry + TP_PT : 0;
                posTs = bar.ts;
                posBars = 0;
                bestProfit = 0;
                beTrigger = false;
                inPosition = true;
                dailyTrades++;
            }
        }

        console.log(`  ${period.label} 资金: $${INITIAL_CAPITAL} → $${capital.toFixed(2)}`);
    }

    // ═══ 回测结果 ═══
    console.log("\n═══════════════════════════════════════════════════");
    console.log("  📊 V94 回测结果");
    console.log("═══════════════════════════════════════════════════");

    const wins = allTrades.filter(t => t.pnlU > 0);
    const losses = allTrades.filter(t => t.pnlU <= 0);
    const totalPnl = allTrades.reduce((s, t) => s + t.pnlU, 0);

    console.log(`  总交易: ${allTrades.length}`);
    console.log(`  赢: ${wins.length} (${allTrades.length > 0 ? (wins.length / allTrades.length * 100).toFixed(1) : 0}%)`);
    console.log(`  亏: ${losses.length}`);
    console.log(`  总PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} USDT`);
    if (wins.length > 0) console.log(`  均赢: +${(wins.reduce((s,t) => s + t.pnlU, 0) / wins.length).toFixed(2)}`);
    if (losses.length > 0) console.log(`  均亏: ${(losses.reduce((s,t) => s + t.pnlU, 0) / losses.length).toFixed(2)}`);

    // 方向分布
    const shorts = allTrades.filter(t => t.side === "SHORT");
    const longs = allTrades.filter(t => t.side === "LONG");
    console.log(`\n  SHORT: ${shorts.length}笔 PnL=${shorts.reduce((s,t) => s + t.pnlU, 0).toFixed(0)}`);
    console.log(`  LONG:  ${longs.length}笔 PnL=${longs.reduce((s,t) => s + t.pnlU, 0).toFixed(0)}`);

    // 出场原因
    const reasons: Record<string, { count: number; pnl: number }> = {};
    for (const t of allTrades) {
        if (!reasons[t.exitReason]) reasons[t.exitReason] = { count: 0, pnl: 0 };
        reasons[t.exitReason].count++;
        reasons[t.exitReason].pnl += t.pnlU;
    }
    console.log("\n  出场分布:");
    for (const [r, v] of Object.entries(reasons)) {
        console.log(`    ${r}: ${v.count}笔 PnL=${v.pnl.toFixed(0)}`);
    }

    // 按月统计
    console.log("\n  月度统计:");
    const months: Record<string, { count: number; pnl: number; wins: number }> = {};
    for (const t of allTrades) {
        const m = new Date(t.entryTs).toISOString().slice(0, 7);
        if (!months[m]) months[m] = { count: 0, pnl: 0, wins: 0 };
        months[m].count++;
        months[m].pnl += t.pnlU;
        if (t.pnlU > 0) months[m].wins++;
    }
    for (const [m, v] of Object.entries(months).sort()) {
        console.log(`    ${m}: ${v.count}笔 胜率${(v.wins/v.count*100).toFixed(0)}% PnL=${v.pnl >= 0 ? "+" : ""}${v.pnl.toFixed(0)}`);
    }

    // 保存结果
    writeFileSync(join(process.cwd(), "data", "v94-backtest.json"), JSON.stringify({
        config: { SL_PT, TP_PT, BREAKEVEN_PT, TRAIL_PT, MOMENTUM_THRESHOLD, VOL_RATIO_MIN, EMA_GAP_MIN },
        summary: {
            total: allTrades.length, wins: wins.length, losses: losses.length,
            winRate: allTrades.length > 0 ? +(wins.length / allTrades.length * 100).toFixed(1) : 0,
            totalPnl: +totalPnl.toFixed(2),
        },
        trades: allTrades,
    }, null, 2));
    console.log("\n📁 回测数据已保存: data/v94-backtest.json");
    console.log("═══════════════════════════════════════════════════\n");
}

main().catch(e => { console.error("💥 回测失败:", e); process.exit(1); });
