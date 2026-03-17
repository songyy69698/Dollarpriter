/**
 * 🎯 Dollarprinter V90 — 时段窗口策略
 * ═══════════════════════════════════════
 * 三窗口 + CEO确认 + 自动模式
 * 发信号 → CEO 3分钟内确认→3ETH | 不回→自动2ETH
 */

import { BitunixWSEngine } from "./bitunix-ws";
import { WindowStrategy } from "./strategy";
import { BitunixExecutor } from "./executor";
import { CandleTracker } from "./candles";
import { IndicatorEngine } from "./indicators";
import { notifyTG, pollTGCommands } from "./telegram";
import {
    LEVERAGE, ENTRY_QTY,
    INITIAL_SL_PT, BREAKEVEN_PT, TRAILING_PT,
    MAX_DAILY_TRADES, MAX_DAILY_LOSS,
    ETH_SYMBOL, SYMBOL_PRECISION,
} from "./config";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [main] ${msg}`);
}

// ═══ 自动开单配置 ═══
const AUTO_QTY = 2.0;             // CEO 不回覆 → 自动 2 ETH
const CEO_QTY = 3.0;              // CEO 确认 → 3 ETH
const AUTO_TIMEOUT_MS = 180_000;  // 3 分钟无回覆 → 自动开单

class DollarprinterBot {
    private ws: BitunixWSEngine;
    private strategy: WindowStrategy;
    private executor: BitunixExecutor;
    private candles: CandleTracker;
    private indicators: IndicatorEngine;

    private paused = true;
    private startTime = Date.now();
    private dailyTrades = 0;
    private dailyPnl = 0;
    private totalTrades = 0;
    private totalPnl = 0;
    private currentBalance = 0;

    // CEO 确认机制
    private signalSentTs = 0;      // 信号发出时间
    private signalNotified = false; // 已发 TG 通知

    constructor() {
        const apiKey = process.env.BITUNIX_API_KEY || "";
        const secretKey = process.env.BITUNIX_SECRET_KEY || "";
        if (!apiKey || !secretKey) {
            log("❌ 缺少 BITUNIX_API_KEY / BITUNIX_SECRET_KEY");
            process.exit(1);
        }
        this.ws = new BitunixWSEngine();
        this.strategy = new WindowStrategy();
        this.executor = new BitunixExecutor(apiKey, secretKey);
        this.candles = new CandleTracker(ETH_SYMBOL);
        this.indicators = new IndicatorEngine();
    }

    async start() {
        log("════════════════════════════════════════════");
        log("  🎯 V90 时段窗口策略");
        log("  📊 三窗口: 08:00做多 | 15:00做空 | 22:00做多");
        log("  🛡️ SL=8pt → 保本5pt → 跟踪5pt");
        log("  🤖 CEO确认→3ETH | 不回→自动2ETH");
        log("════════════════════════════════════════════");

        // 预加载数据
        await this.candles.bootstrap();
        await this.candles.bootstrapAmplitude();
        this.candles.start();
        await this.indicators.bootstrap();
        this.ws.start();
        await this.waitForWS();

        const bal = await this.executor.getBalance();
        this.currentBalance = bal;

        log(`  💰 余额: $${bal.toFixed(2)}`);
        log("════════════════════════════════════════════");

        await notifyTG(
            `🎯 *V90 时段窗口启动*\n` +
            `💰 $${bal.toFixed(2)} | ${LEVERAGE}x\n` +
            `📊 08:00做多 | 15:00做空 | 22:00做多\n` +
            `🛡️ SL=${INITIAL_SL_PT}pt → 保本${BREAKEVEN_PT}pt → 跟踪${TRAILING_PT}pt\n` +
            `🤖 确认→${CEO_QTY}ETH | 自动→${AUTO_QTY}ETH\n` +
            `发 *1* 激活`,
        );

        await this.executor.setupTradeEnv(ETH_SYMBOL);

        const recovered = await this.executor.recoverPositions();
        if (recovered) {
            const coinName = this.executor.positionSymbol.replace("USDT", "");
            const prec = SYMBOL_PRECISION[this.executor.positionSymbol] || { qty: 1, price: 3 };
            await notifyTG(
                `🔄 *仓位接管*\n` +
                `${coinName} ${this.executor.positionSide.toUpperCase()} ` +
                `${this.executor.positionQty} @ $${this.executor.entryPrice.toFixed(prec.price)}`,
            );
        }

        this.strategyLoop();
        this.positionLoop();
        this.tgCommandLoop();
        this.indicatorRefreshLoop();
        setInterval(() => this.hourlyReport(), 3600_000);
        setInterval(async () => {
            this.currentBalance = await this.executor.getBalance();
        }, 30_000);
        // 每日重置
        setInterval(() => this.dailyReset(), 60_000);

        log("🟢 V90 就绪 — 发 1 激活");
    }

    private async waitForWS() {
        let waited = 0;
        while (waited < 30) {
            const s = this.ws.getSnapshot();
            if (s.connected && s.price > 0) break;
            await Bun.sleep(1000);
            waited++;
        }
        log("📡 WS 数据流就绪");
    }

    // ═══ 指标定时刷新 (每 5 分钟) ═══
    private indicatorRefreshLoop() {
        setInterval(async () => {
            await this.indicators.refresh();
        }, 300_000); // 5 分钟
    }

    // ═══ 每日重置 (UTC+8 00:00) ═══
    private dailyReset() {
        const dt = new Date();
        const utc8h = (dt.getUTCHours() + 8) % 24;
        const utc8m = dt.getUTCMinutes();
        if (utc8h === 0 && utc8m === 0) {
            this.dailyTrades = 0;
            this.dailyPnl = 0;
            log("📅 日重置");
        }
    }

    // ═══════════════════════════════════════════
    // 策略循环: 窗口检测 + CEO确认/自动开单
    // ═══════════════════════════════════════════
    private strategyLoop() {
        setInterval(async () => {
            if (this.paused) return;
            if (this.executor.inPosition) return;
            if (this.dailyTrades >= MAX_DAILY_TRADES) return;
            if (this.dailyPnl <= -MAX_DAILY_LOSS) return;

            const s = this.ws.getSnapshot();
            const ethPrice = s.ethPrice;
            if (ethPrice <= 0 || !s.connected) return;

            this.candles.updateRealtimePrice(ethPrice);

            // 检查是否有待确认的信号
            const pending = this.strategy.pendingSignal;
            if (pending) {
                const now = Date.now();

                // CEO 已确认 → 用 3 ETH 开单
                if (this.strategy.ceoApproved) {
                    log(`✅ CEO 确认! 用 ${CEO_QTY} ETH 开单`);
                    await this.executeEntry(pending.side, ethPrice, CEO_QTY);
                    this.strategy.markTraded();
                    return;
                }

                // 已发通知但未确认 → 检查超时
                if (this.signalNotified && now - this.signalSentTs >= AUTO_TIMEOUT_MS) {
                    log(`⏰ 3分钟未回覆 → 自动用 ${AUTO_QTY} ETH 开单`);
                    await notifyTG(`⏰ *3分钟未确认 → 自动开单 ${AUTO_QTY}ETH*`);
                    await this.executeEntry(pending.side, ethPrice, AUTO_QTY);
                    this.strategy.markTraded();
                    return;
                }

                // 已有信号但还没发通知
                if (!this.signalNotified) {
                    await this.sendSignalNotification(pending);
                    this.signalSentTs = Date.now();
                    this.signalNotified = true;
                }

                return; // 等待中,不产生新信号
            }

            // 没有待确认信号 → 评估新信号
            this.signalNotified = false;
            const sig = this.strategy.evaluate(ethPrice, this.indicators);
            // signal 已存储在 strategy.pendingSignal 中

        }, 5000); // 5 秒检查一次 (5m K 线不需要太频繁)
    }

    /** 发送信号通知到 Telegram */
    private async sendSignalNotification(sig: WindowSignal) {
        const { rsi, vwapDev, usedRange, atr, prev1hChange, barRangeRatio } = sig.indicators;
        const msg =
            `🎯 *${sig.windowName} 信号*\n` +
            `──────────────\n` +
            `方向: *${sig.side.toUpperCase()}* ${sig.side === "long" ? "📈做多" : "📉做空"}\n` +
            `价格: $${sig.price.toFixed(2)}\n` +
            `──────────────\n` +
            `RSI: ${rsi.toFixed(0)} ${rsi < 30 ? "✅超卖" : rsi > 70 ? "✅超买" : "⚠️"}\n` +
            `VWAP偏: ${vwapDev > 0 ? "+" : ""}${vwapDev.toFixed(2)}% ✅\n` +
            `日振幅: ${(usedRange * 100).toFixed(0)}% ✅\n` +
            `前1h: ${prev1hChange > 0 ? "+" : ""}${prev1hChange.toFixed(2)}%\n` +
            `ATR: ${atr.toFixed(1)}pt\n` +
            `──────────────\n` +
            `回覆 *y* → ${CEO_QTY}ETH 开单\n` +
            `3分钟不回 → 自动${AUTO_QTY}ETH`;
        await notifyTG(msg);
    }

    /** 执行入场 */
    private async executeEntry(side: "long" | "short", price: number, qty: number) {
        const prec = SYMBOL_PRECISION[ETH_SYMBOL] || { qty: 3, price: 2 };

        await notifyTG(
            `🏁 *${side.toUpperCase()} ETH*\n` +
            `@ $${price.toFixed(prec.price)} | ${qty}ETH`,
        );

        const ok = await this.executor.atomicEntry(side, price, qty, ETH_SYMBOL, notifyTG);
        if (ok) {
            log(`✅ ${side.toUpperCase()} ${qty} ETH @ ${price.toFixed(prec.price)}`);
            const diagMsg =
                `📡 *订单诊断*\n` +
                `⏱ Entry: ${this.executor.lastEntryMs}ms | SL: ${this.executor.lastSlMs}ms\n` +
                `Slip: ${this.executor.lastSlippage.toFixed(prec.price)}pt` +
                (this.executor.highSlippage ? `\n🚨 *HIGH SLIPPAGE*` : "");
            await notifyTG(diagMsg);
            await Bun.sleep(500);
            await this.executor.syncPositions();
        }
    }

    // ═══ 仓位管理循环 ═══
    private positionLoop() {
        setInterval(async () => {
            if (!this.executor.inPosition) return;

            const s = this.ws.getSnapshot();
            const currentPrice = s.ethPrice;
            if (currentPrice <= 0) return;

            this.candles.updateRealtimePrice(currentPrice);

            const r = await this.executor.checkPosition(currentPrice);

            if (r.closed) {
                this.dailyTrades++;
                this.dailyPnl += r.netPnlU;
                this.totalTrades++;
                this.totalPnl += r.netPnlU;
                const emoji = r.netPnlU > 0 ? "✅" : "❌";
                await notifyTG(
                    `${emoji} *ETH 平仓*\n` +
                    `${r.reason}\n` +
                    `净PnL: ${r.netPnlU >= 0 ? "+" : ""}${r.netPnlU.toFixed(2)}U\n` +
                    `今日: ${this.dailyTrades}单 ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(2)}U`,
                );
            } else {
                await this.executor.syncPositions();
            }
        }, 1000);
    }

    // ═══ Telegram 指令 ═══
    private tgCommandLoop() {
        let lastId = 0;
        setInterval(async () => {
            lastId = await pollTGCommands(lastId, {
                "1": async () => { this.paused = false; await notifyTG(`✅ *V90 激活* 三窗口运行中`); },
                "/start": async () => { this.paused = false; await notifyTG(`✅ *V90 激活*`); },
                "0": async () => { this.paused = true; await notifyTG("🔴 *V90 暂停*"); },
                "/stop": async () => { this.paused = true; await notifyTG("🔴 *V90 暂停*"); },
                // CEO 确认开单
                "y": async () => {
                    if (this.strategy.pendingSignal) {
                        this.strategy.approveTrade();
                        await notifyTG(`✅ *收到确认! ${CEO_QTY}ETH 即将开单*`);
                    } else {
                        await notifyTG("⚠️ 无待确认信号");
                    }
                },
                "yes": async () => {
                    if (this.strategy.pendingSignal) {
                        this.strategy.approveTrade();
                        await notifyTG(`✅ *收到确认! ${CEO_QTY}ETH 即将开单*`);
                    } else {
                        await notifyTG("⚠️ 无待确认信号");
                    }
                },
                // CEO 拒绝
                "n": async () => {
                    this.strategy.clearPending();
                    this.signalNotified = false;
                    await notifyTG("🚫 *信号已跳过*");
                },
                "no": async () => {
                    this.strategy.clearPending();
                    this.signalNotified = false;
                    await notifyTG("🚫 *信号已跳过*");
                },
                s: async () => { await this.sendStatus(); },
                "/status": async () => { await this.sendStatus(); },
                x: async () => {
                    const s = this.ws.getSnapshot();
                    const r = await this.executor.forceCloseAll(s.ethPrice);
                    if (r.ok) {
                        this.dailyTrades++; this.dailyPnl += r.netPnlU;
                        this.totalTrades++; this.totalPnl += r.netPnlU;
                        await notifyTG(`🔴 *强平* ${r.netPnlU.toFixed(2)}U`);
                    } else { await notifyTG("⚠️ 无持仓"); }
                },
                "/close": async () => {
                    const s = this.ws.getSnapshot();
                    const r = await this.executor.forceCloseAll(s.ethPrice);
                    if (r.ok) {
                        this.dailyTrades++; this.dailyPnl += r.netPnlU;
                        this.totalTrades++; this.totalPnl += r.netPnlU;
                        await notifyTG(`🔴 *强平* ${r.netPnlU.toFixed(2)}U`);
                    } else { await notifyTG("⚠️ 无持仓"); }
                },
                h: async () => { await notifyTG(`📖 *V90*\n1 激活\n0 暂停\ny 确认开单\nn 跳过\ns 状态\nx 强平\nh 帮助`); },
                "/help": async () => { await notifyTG(`📖 *V90*\n1 激活\n0 暂停\ny 确认开单\nn 跳过\ns 状态\nx 强平\nh 帮助`); },
            });
        }, 2000);
    }

    private async sendStatus() {
        const s = this.ws.getSnapshot();
        const b = await this.executor.getBalance();
        this.currentBalance = b;
        const uptimeMs = Date.now() - this.startTime;
        const uptimeH = Math.floor(uptimeMs / 3600_000);
        const uptimeM = Math.floor((uptimeMs % 3600_000) / 60_000);

        const dt = new Date();
        const utc8h = (dt.getUTCHours() + 8) % 24;

        const snap = this.indicators.getSnapshot(s.ethPrice);

        let m = `🎯 *V90 时段窗口*\n──────────────\n`;
        m += `💰 $${b.toFixed(2)} | ${this.paused ? "🔴暂停" : "🟢运行"} | ${uptimeH}h${uptimeM}m\n`;
        m += `──────────────\n`;
        m += `💎 ETH $${s.ethPrice.toFixed(2)}\n`;
        m += `📊 RSI=${snap.rsi.toFixed(0)} | VWAP偏=${snap.vwapDev > 0 ? "+" : ""}${snap.vwapDev.toFixed(2)}%\n`;
        m += `📊 日振=${(snap.usedRange * 100).toFixed(0)}% | ATR=${snap.atr.toFixed(1)}pt\n`;
        m += `──────────────\n`;
        m += `📋 今:${this.dailyTrades}/${MAX_DAILY_TRADES} ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(1)}U\n`;
        m += `📋 累:${this.totalTrades}单 ${this.totalPnl >= 0 ? "+" : ""}${this.totalPnl.toFixed(1)}U\n`;

        if (this.executor.inPosition) {
            const prec = SYMBOL_PRECISION[this.executor.positionSymbol] || { qty: 1, price: 3 };
            const pnl = this.executor.positionSide === "long"
                ? s.ethPrice - this.executor.entryPrice : this.executor.entryPrice - s.ethPrice;
            m += `──────────────\n`;
            m += `🔥 ETH ${this.executor.positionSide.toUpperCase()} @ $${this.executor.entryPrice.toFixed(prec.price)}\n`;
            m += `浮盈:${pnl >= 0 ? "+" : ""}${pnl.toFixed(prec.price)}pt | 保本:${this.executor.breakevenTriggered ? "✅" : "❌"}\n`;
            m += `最优:+${this.executor.bestProfitPt.toFixed(1)}pt\n`;
        }

        await notifyTG(m);
    }

    private async hourlyReport() {
        const s = this.ws.getSnapshot();
        const b = await this.executor.getBalance();
        const uptimeMs = Date.now() - this.startTime;
        const uptimeH = Math.floor(uptimeMs / 3600_000);

        const snap = this.indicators.getSnapshot(s.ethPrice);

        let m = `💓 *V90* ${uptimeH}h | ${this.paused ? "🔴" : "🟢"}\n`;
        m += `ETH $${s.ethPrice.toFixed(2)} | RSI=${snap.rsi.toFixed(0)} | 日振=${(snap.usedRange * 100).toFixed(0)}%\n`;
        m += `余$${b.toFixed(2)} | 今${this.dailyTrades}/${MAX_DAILY_TRADES} ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(1)}U`;

        await notifyTG(m);
    }
}

// 需要导入 WindowSignal type
import type { WindowSignal } from "./strategy";

const bot = new DollarprinterBot();
process.on("SIGINT", () => { log("🛑 停止..."); process.exit(0); });
bot.start();
