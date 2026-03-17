/**
 * 🎯 Dollarprinter V91 — 因果套利 + 平衡型出场
 * ═══════════════════════════════════════════════════
 * 入场: 实时盘口买压/卖墙 因果套利
 * 出场: SL=12 → 保本10+3 → 跟踪10
 * 模式: 信号→CEO确认→3ETH | 不回→自动2ETH
 */

import { BitunixWSEngine } from "./bitunix-ws";
import { CausalStrategy } from "./strategy";
import type { CausalSignal } from "./strategy";
import { BitunixExecutor } from "./executor";
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

// ═══ CEO 确认参数 ═══
const AUTO_QTY = 2.0;
const CEO_QTY = 3.0;
const AUTO_TIMEOUT_MS = 180_000;  // 3分钟

class DollarprinterBot {
    private ws: BitunixWSEngine;
    private strategy: CausalStrategy;
    private executor: BitunixExecutor;

    private paused = true;
    private startTime = Date.now();
    private dailyTrades = 0;
    private dailyPnl = 0;
    private totalTrades = 0;
    private totalPnl = 0;
    private currentBalance = 0;

    // CEO 确认
    private signalSentTs = 0;
    private signalNotified = false;

    constructor() {
        const apiKey = process.env.BITUNIX_API_KEY || "";
        const secretKey = process.env.BITUNIX_SECRET_KEY || "";
        if (!apiKey || !secretKey) {
            log("❌ 缺少 BITUNIX_API_KEY / BITUNIX_SECRET_KEY");
            process.exit(1);
        }
        this.ws = new BitunixWSEngine();
        this.strategy = new CausalStrategy();
        this.executor = new BitunixExecutor(apiKey, secretKey);
    }

    async start() {
        log("════════════════════════════════════════════");
        log("  🎯 V91 因果套利 + 平衡型出场");
        log("  📊 入场: 买压>卖墙×2.5 + 效率>均值");
        log(`  🛡️ SL=${INITIAL_SL_PT}pt → 保本${BREAKEVEN_PT}pt+3 → 跟踪${TRAILING_PT}pt`);
        log("  🤖 CEO确认→3ETH | 不回→自动2ETH");
        log("════════════════════════════════════════════");

        this.ws.start();
        await this.waitForWS();

        const bal = await this.executor.getBalance();
        this.currentBalance = bal;
        log(`  💰 余额: $${bal.toFixed(2)}`);
        log("════════════════════════════════════════════");

        await notifyTG(
            `🎯 *V91 因果套利启动*\n` +
            `💰 $${bal.toFixed(2)} | ${LEVERAGE}x\n` +
            `📊 买压>卖墙×2.5 入场\n` +
            `🛡️ SL=${INITIAL_SL_PT}pt → BE${BREAKEVEN_PT}+3 → TR${TRAILING_PT}pt\n` +
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
        setInterval(() => this.hourlyReport(), 3600_000);
        setInterval(async () => {
            this.currentBalance = await this.executor.getBalance();
        }, 30_000);
        setInterval(() => this.dailyReset(), 60_000);

        log("🟢 V91 就绪 — 发 1 激活");
    }

    private async waitForWS() {
        let waited = 0;
        while (waited < 30) {
            const s = this.ws.getSnapshot();
            if (s.connected && s.ethPrice > 0) break;
            await Bun.sleep(1000);
            waited++;
        }
        log("📡 WS 数据流就绪");
    }

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
    // 策略循环: 因果套利检测 + CEO确认
    // ═══════════════════════════════════════════
    private strategyLoop() {
        setInterval(async () => {
            if (this.paused) return;
            if (this.executor.inPosition) return;
            if (this.dailyTrades >= MAX_DAILY_TRADES) return;
            if (this.dailyPnl <= -MAX_DAILY_LOSS) return;

            const s = this.ws.getSnapshot();
            if (!s.connected || s.ethPrice <= 0) return;

            // 检查待确认信号
            const pending = this.strategy.pendingSignal;
            if (pending) {
                const now = Date.now();

                // CEO 已确认
                if (this.strategy.ceoApproved) {
                    log(`✅ CEO 确认! 用 ${CEO_QTY} ETH 开单`);
                    await this.executeEntry(pending.side, s.ethPrice, CEO_QTY);
                    this.strategy.markTraded();
                    return;
                }

                // 超时 → 自动开单
                if (this.signalNotified && now - this.signalSentTs >= AUTO_TIMEOUT_MS) {
                    log(`⏰ 3分钟未回覆 → 自动 ${AUTO_QTY} ETH`);
                    await notifyTG(`⏰ *3分钟未确认 → 自动开单 ${AUTO_QTY}ETH*`);
                    await this.executeEntry(pending.side, s.ethPrice, AUTO_QTY);
                    this.strategy.markTraded();
                    return;
                }

                // 发通知
                if (!this.signalNotified) {
                    await this.sendSignalNotification(pending);
                    this.signalSentTs = Date.now();
                    this.signalNotified = true;
                }
                return;
            }

            // 评估新信号
            this.signalNotified = false;
            this.strategy.evaluate(s);

        }, 2000); // 2秒检查一次 (盘口数据需要高频)
    }

    /** 发送因果套利信号通知 */
    private async sendSignalNotification(sig: CausalSignal) {
        const s = this.ws.getSnapshot();
        const msg =
            `🎯 *因果套利信号*\n` +
            `──────────────\n` +
            `方向: *${sig.side.toUpperCase()}* ${sig.side === "long" ? "📈做多" : "📉做空"}\n` +
            `价格: $${sig.price.toFixed(2)}\n` +
            `──────────────\n` +
            `失衡比: ${sig.imbalanceRatio.toFixed(1)}x (>2.5)\n` +
            `效率: ${sig.efficiency.toFixed(4)}\n` +
            `Spread: ${s.ethSpread.toFixed(2)}pt\n` +
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

    // ═══ 仓位管理 ═══
    private positionLoop() {
        setInterval(async () => {
            if (!this.executor.inPosition) return;
            const s = this.ws.getSnapshot();
            if (s.ethPrice <= 0) return;

            const r = await this.executor.checkPosition(s.ethPrice);
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
                "1": async () => { this.paused = false; await notifyTG(`✅ *V91 激活* 因果套利运行中`); },
                "/start": async () => { this.paused = false; await notifyTG(`✅ *V91 激活*`); },
                "0": async () => { this.paused = true; await notifyTG("🔴 *V91 暂停*"); },
                "/stop": async () => { this.paused = true; await notifyTG("🔴 *V91 暂停*"); },
                "y": async () => {
                    if (this.strategy.pendingSignal) {
                        this.strategy.approveTrade();
                        await notifyTG(`✅ *收到确认! ${CEO_QTY}ETH 即将开单*`);
                    } else { await notifyTG("⚠️ 无待确认信号"); }
                },
                "yes": async () => {
                    if (this.strategy.pendingSignal) {
                        this.strategy.approveTrade();
                        await notifyTG(`✅ *收到确认! ${CEO_QTY}ETH 即将开单*`);
                    } else { await notifyTG("⚠️ 无待确认信号"); }
                },
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
                h: async () => { await notifyTG(`📖 *V91*\n1 激活\n0 暂停\ny 确认开单\nn 跳过\ns 状态\nx 强平\nh 帮助`); },
                "/help": async () => { await notifyTG(`📖 *V91*\n1 激活\n0 暂停\ny 确认开单\nn 跳过\ns 状态\nx 强平\nh 帮助`); },
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

        // 因果数据
        const buyImb = s.ethAskWallVol > 0 ? (s.ethBuyDelta / s.ethAskWallVol).toFixed(1) : "N/A";
        const sellImb = s.ethBidWallVol > 0 ? (s.ethSellDelta / s.ethBidWallVol).toFixed(1) : "N/A";

        let m = `🎯 *V91 因果套利*\n──────────────\n`;
        m += `💰 $${b.toFixed(2)} | ${this.paused ? "🔴暂停" : "🟢运行"} | ${uptimeH}h${uptimeM}m\n`;
        m += `──────────────\n`;
        m += `💎 ETH $${s.ethPrice.toFixed(2)}\n`;
        m += `📊 买压比=${buyImb}x | 卖压比=${sellImb}x\n`;
        m += `📊 效率=${s.ethEfficiency.toFixed(4)} | 均=${s.ethAvgEfficiency.toFixed(4)}\n`;
        m += `📊 Spread=${s.ethSpread.toFixed(2)}pt\n`;
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

        let m = `💓 *V91* ${uptimeH}h | ${this.paused ? "🔴" : "🟢"}\n`;
        m += `ETH $${s.ethPrice.toFixed(2)} | Spread=${s.ethSpread.toFixed(2)}pt\n`;
        m += `余$${b.toFixed(2)} | 今${this.dailyTrades}/${MAX_DAILY_TRADES} ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(1)}U`;

        await notifyTG(m);
    }
}

const bot = new DollarprinterBot();
process.on("SIGINT", () => { log("🛑 停止..."); process.exit(0); });
bot.start();
