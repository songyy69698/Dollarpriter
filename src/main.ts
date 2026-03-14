/**
 * 🐋 Dollarprinter V66 — LEVIATHAN
 * ═══════════════════════════════════════
 * 15M 结构性趋势交易 + Iron Guard 出场
 * MARKET IOC + Zero-Risk Gate + 复利保证金
 */

import { BitunixWSEngine } from "./bitunix-ws";
import { CausalStrategy } from "./strategy";
import { BitunixExecutor } from "./executor";
import { CandleTracker } from "./candles";
import { notifyTG, pollTGCommands } from "./telegram";
import {
    LEVERAGE, MARGIN_DEFAULT,
    SL_POINTS, STRUCT_SL_BUFFER, ZERO_RISK_THRESHOLD,
    MAX_SPREAD_POINTS, MIN_DEPTH_ETH,
    MAX_DAILY_TRADES, MAX_DAILY_LOSS,
    BTC_ENTRY_RATIO,
    ETH_SYMBOL,
    SYMBOL_PRECISION,
    getMargin,
} from "./config";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [main] ${msg}`);
}

class LeviathanBot {
    private ws: BitunixWSEngine;
    private strategy: CausalStrategy;
    private executor: BitunixExecutor;
    private candles: CandleTracker;

    private paused = false;    // V66: 默认激活, 不需发1
    private startTime = Date.now();
    private dailyTrades = 0;
    private dailyPnl = 0;
    private totalTrades = 0;
    private totalPnl = 0;
    private currentBalance = 0;

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
        this.candles = new CandleTracker(ETH_SYMBOL);
    }

    async start() {
        log("════════════════════════════════════════════");
        log("  🐋 Dollarprinter V66 — LEVIATHAN");
        log("  🔥 15M 结构性趋势交易 + Iron Guard");
        log("  📡 三币种: SOL + BTC + ETH");
        log("════════════════════════════════════════════");

        // Step 1: 先预加载 K线 (比 WS 先启动)
        await this.candles.bootstrap();
        this.candles.start();

        // Step 2: 启动 WS 数据流
        this.ws.start();
        await this.waitForWS();

        const bal = await this.executor.getBalance();
        this.currentBalance = bal;
        const margin = getMargin(bal);
        const cs = this.candles.getSnapshot();

        log(`  💰 余额: $${bal.toFixed(2)}`);
        log(`  📊 ${ETH_SYMBOL} | ${LEVERAGE}x 杠杆 | M=$${margin}`);
        log(`  🐋 入场: 15M突破 + BTC≥${BTC_ENTRY_RATIO}x`);
        log(`  📊 H2=$${cs.highest2_15m.toFixed(2)} | L2=$${cs.lowest2_15m.toFixed(2)}`);
        log(`  🛡️ SL=${SL_POINTS}pt | Zero-Risk≥${ZERO_RISK_THRESHOLD}pt`);
        log(`  ⚔️ Iron Guard: prev15M ±${STRUCT_SL_BUFFER}pt (1M确认)`);
        log(`  💎 复利: $20→$60→$150→$400`);
        log("════════════════════════════════════════════");

        await notifyTG(
            `🐋 *V66 LEVIATHAN 已激活*\n` +
            `💰 $${bal.toFixed(2)} | ${LEVERAGE}x | M=$${margin}\n` +
            `📊 H2=$${cs.highest2_15m.toFixed(2)} | L2=$${cs.lowest2_15m.toFixed(2)}\n` +
            `🐋 15M突破 + BTC≥${BTC_ENTRY_RATIO}x\n` +
            `🛡️ SL=${SL_POINTS}pt | Zero-Risk≥${ZERO_RISK_THRESHOLD}pt\n` +
            `⚔️ Iron Guard ±${STRUCT_SL_BUFFER}pt\n` +
            `🟢 自动扫描中...`,
        );

        // 🔄 启动时自动接管现有仓位
        const recovered = await this.executor.recoverPositions();
        if (recovered) {
            const coinName = this.executor.positionSymbol.replace("USDT", "");
            const prec = SYMBOL_PRECISION[this.executor.positionSymbol] || { qty: 1, price: 3 };
            await notifyTG(
                `🔄 *仓位自动接管*\n` +
                `${coinName} ${this.executor.positionSide.toUpperCase()} ` +
                `${this.executor.positionQty} @ $${this.executor.entryPrice.toFixed(prec.price)}\n` +
                `Iron Guard 出场逻辑已激活`,
            );
        }

        this.strategyLoop();
        this.positionLoop();
        this.tgCommandLoop();
        setInterval(() => this.hourlyReport(), 3600_000);
        // 每 60s 更新余额 (用于复利计算)
        setInterval(async () => {
            this.currentBalance = await this.executor.getBalance();
        }, 60_000);
        log("🟢 V66 就绪 — 自动扫描中");
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

    // ═══════════════════════════════════════
    // 策略循环 — 15M 结构性突破
    // ═══════════════════════════════════════

    private strategyLoop() {
        setInterval(async () => {
            if (this.paused) return;
            if (this.executor.inPosition) return;
            if (this.dailyTrades >= MAX_DAILY_TRADES) return;
            if (this.dailyPnl <= -MAX_DAILY_LOSS) return;

            const snap = this.ws.getSnapshot();
            const sig = this.strategy.evaluate(snap, this.candles, this.currentBalance);
            if (!sig) return;

            const prec = SYMBOL_PRECISION[sig.targetSymbol] || { qty: 1, price: 3 };
            const coinName = sig.targetSymbol.replace("USDT", "");

            await notifyTG(
                `🐋 *${sig.side.toUpperCase()} ${coinName}*\n${sig.reason}\n` +
                `@ ${sig.price.toFixed(prec.price)} | M=$${sig.margin}`,
            );

            const ok = await this.executor.atomicEntry(sig.side, sig.price, sig.margin, sig.targetSymbol, notifyTG);
            if (ok) {
                log(`✅ 🐋 ${sig.side.toUpperCase()} ${coinName} @ ${sig.price.toFixed(prec.price)} M=$${sig.margin}`);

                // 延迟诊断 TG 通知
                let diagMsg =
                    `📡 *订单诊断*\n` +
                    `⏱ Entry: ${this.executor.lastEntryMs}ms | SL: ${this.executor.lastSlMs}ms\n` +
                    `[DRIFT] Signal: ${this.executor.signalPrice.toFixed(prec.price)} | Fill: ${this.executor.entryPrice.toFixed(prec.price)} | Slip: ${this.executor.lastSlippage.toFixed(prec.price)}pt`;
                if (this.executor.highSlippage) {
                    diagMsg += `\n🚨 *HIGH SLIPPAGE* — 激进出场 BE+1pt`;
                }
                await notifyTG(diagMsg);

                await Bun.sleep(500);
                await this.executor.syncPositions();
            }
        }, 500); // 每 500ms 检查 (15M策略不需太快)
    }

    // ═══════════════════════════════════════
    // 持仓监控 — Iron Guard
    // ═══════════════════════════════════════

    private positionLoop() {
        setInterval(async () => {
            if (!this.executor.inPosition) return;

            const s = this.ws.getSnapshot();
            const currentPrice = this.executor.positionSymbol === ETH_SYMBOL ? s.ethPrice : s.price;
            if (currentPrice <= 0) return;

            const r = await this.executor.checkPosition(
                currentPrice,
                this.candles.prev15mHigh,
                this.candles.prev15mLow,
                this.candles.last1mClose,
            );

            if (r.closed) {
                this.dailyTrades++;
                this.dailyPnl += r.netPnlU;
                this.totalTrades++;
                this.totalPnl += r.netPnlU;
                const emoji = r.netPnlU > 0 ? "✅" : "❌";
                await notifyTG(
                    `${emoji} *${r.symbol.replace("USDT", "")} 平仓*\n` +
                    `${r.reason}\n` +
                    `净PnL: ${r.netPnlU >= 0 ? "+" : ""}${r.netPnlU.toFixed(2)}U\n` +
                    `今日: ${this.dailyTrades}单 ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(2)}U`,
                );
            } else {
                await this.executor.syncPositions();
            }
        }, 1000);
    }

    // ═══════════════════════════════════════
    // TG 命令
    // ═══════════════════════════════════════

    private tgCommandLoop() {
        let lastId = 0;
        setInterval(async () => {
            lastId = await pollTGCommands(lastId, {
                "1": async () => {
                    this.paused = false;
                    await notifyTG(`✅ *V66 LEVIATHAN 激活*\n15M 结构性趋势扫描中...`);
                },
                "/start": async () => {
                    this.paused = false;
                    await notifyTG(`✅ *V66 LEVIATHAN 激活*\n15M 结构性趋势扫描中...`);
                },
                "0": async () => {
                    this.paused = true;
                    await notifyTG("🔴 *V66 暂停*");
                },
                "/stop": async () => {
                    this.paused = true;
                    await notifyTG("🔴 *V66 暂停*");
                },
                s: async () => { await this.sendStatus(); },
                "/status": async () => { await this.sendStatus(); },
                d: async () => { await this.sendDiagnostics(); },
                "/diag": async () => { await this.sendDiagnostics(); },
                x: async () => {
                    const s = this.ws.getSnapshot();
                    const price = this.executor.positionSymbol === ETH_SYMBOL ? s.ethPrice : s.price;
                    const r = await this.executor.forceCloseAll(price);
                    if (r.ok) {
                        this.dailyTrades++;
                        this.dailyPnl += r.netPnlU;
                        this.totalTrades++;
                        this.totalPnl += r.netPnlU;
                        await notifyTG(`🔴 *强平* ${r.netPnlU.toFixed(2)}U`);
                    } else {
                        await notifyTG("⚠️ 无持仓");
                    }
                },
                "/close": async () => {
                    const s = this.ws.getSnapshot();
                    const price = this.executor.positionSymbol === ETH_SYMBOL ? s.ethPrice : s.price;
                    const r = await this.executor.forceCloseAll(price);
                    if (r.ok) {
                        this.dailyTrades++;
                        this.dailyPnl += r.netPnlU;
                        this.totalTrades++;
                        this.totalPnl += r.netPnlU;
                        await notifyTG(`🔴 *强平* ${r.netPnlU.toFixed(2)}U`);
                    } else {
                        await notifyTG("⚠️ 无持仓");
                    }
                },
                h: async () => {
                    await notifyTG(
                        `📖 *V66 LEVIATHAN*\n1 启动\n0 暂停\ns 状态\nd 诊断\nx 强平\nh 帮助`,
                    );
                },
                "/help": async () => {
                    await notifyTG(
                        `📖 *V66 LEVIATHAN*\n1 启动\n0 暂停\ns 状态\nd 诊断\nx 强平\nh 帮助`,
                    );
                },
            });
        }, 2000);
    }

    // ═══════════════════════════════════════
    // 📡 诊断报告
    // ═══════════════════════════════════════

    private async sendDiagnostics() {
        const s = this.ws.getSnapshot();
        const cs = this.candles.getSnapshot();

        let m = `📡 *【V66 诊断报告】*\n`;
        m += `──────────────\n`;
        m += `📊 *15M K线:* ${cs.count15m}根 | 1M: ${cs.count1m}根\n`;
        m += `   H2=${cs.highest2_15m.toFixed(2)} | L2=${cs.lowest2_15m.toFixed(2)}\n`;
        m += `   prevH=${cs.prev15mHigh.toFixed(2)} | prevL=${cs.prev15mLow.toFixed(2)}\n`;
        m += `   1M close=$${cs.last1mClose.toFixed(2)}\n`;
        m += `──────────────\n`;
        m += `🕒 WS延迟: ${s.wsLatencyMs}ms (avg=${s.wsLatencyAvg}ms)\n`;
        if (this.executor.lastEntryMs > 0) {
            m += `⏱ Entry: ${this.executor.lastEntryMs}ms | SL: ${this.executor.lastSlMs}ms\n`;
            m += `Slip: ${this.executor.lastSlippage.toFixed(2)}pt\n`;
        }
        if (this.executor.inPosition) {
            m += `──────────────\n`;
            m += `⚔️ Guard: $${this.executor.structGuardPrice.toFixed(2)}\n`;
            m += `🛡️ Zero-Risk: ${this.executor.zeroRiskTriggered ? "✅已触发" : "❌未触发"}\n`;
        }

        await notifyTG(m);
    }

    // ═══════════════════════════════════════
    // 状态面板
    // ═══════════════════════════════════════

    private async sendStatus() {
        const s = this.ws.getSnapshot();
        const b = await this.executor.getBalance();
        this.currentBalance = b;
        const margin = getMargin(b);
        const uptimeMs = Date.now() - this.startTime;
        const uptimeH = Math.floor(uptimeMs / 3600_000);
        const uptimeM = Math.floor((uptimeMs % 3600_000) / 60_000);
        const cs = this.candles.getSnapshot();

        let m = `🐋 *V66 LEVIATHAN*\n`;
        m += `──────────────\n`;
        m += `💰 余额: $${b.toFixed(2)} | M=$${margin}\n`;
        m += `🔌 WS: ${s.connected ? "🟢" : "🔴"} | ${this.paused ? "🔴暂停" : "🟢运行"}\n`;
        m += `⚙️ 运行: ${uptimeH}h${uptimeM}m | 扫描: ${this.strategy.getScanCount()}\n`;
        m += `──────────────\n`;
        m += `🐋 15M突破 + BTC≥${BTC_ENTRY_RATIO}x\n`;
        m += `📊 H2=$${cs.highest2_15m.toFixed(2)} | L2=$${cs.lowest2_15m.toFixed(2)}\n`;
        m += `⚔️ Guard: prevH=$${cs.prev15mHigh.toFixed(2)} | prevL=$${cs.prev15mLow.toFixed(2)}\n`;
        m += `🛡️ SL=${SL_POINTS}pt | Zero-Risk≥${ZERO_RISK_THRESHOLD}pt\n`;
        m += `──────────────\n`;
        m += `💎 ETH $${s.ethPrice.toFixed(2)} | Sp=${s.ethSpread.toFixed(3)}\n`;
        m += `₿ BTC $${s.btcPrice.toFixed(1)} | 买:${s.btcBuyDelta.toFixed(1)} 卖:${s.btcSellDelta.toFixed(1)}\n`;
        m += `──────────────\n`;
        m += `📋 今日: ${this.dailyTrades}/${MAX_DAILY_TRADES}单 | ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(2)}U\n`;
        m += `📋 累计: ${this.totalTrades}单 | ${this.totalPnl >= 0 ? "+" : ""}${this.totalPnl.toFixed(2)}U\n`;

        if (this.executor.inPosition) {
            const prec = SYMBOL_PRECISION[this.executor.positionSymbol] || { qty: 1, price: 3 };
            const curPrice = this.executor.positionSymbol === ETH_SYMBOL ? s.ethPrice : s.price;
            const pnl = this.executor.positionSide === "long"
                ? curPrice - this.executor.entryPrice
                : this.executor.entryPrice - curPrice;
            const pnlPct = pnl / this.executor.entryPrice * 100;
            const coinName = this.executor.positionSymbol.replace("USDT", "");
            const holdMin = ((Date.now() - this.executor.entryTs) / 60_000).toFixed(1);
            m += `──────────────\n`;
            m += `🔥 ${coinName} ${this.executor.positionSide.toUpperCase()} @ $${this.executor.entryPrice.toFixed(prec.price)}\n`;
            m += `浮盈: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(prec.price)}pt (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(3)}%)\n`;
            m += `持仓: ${holdMin}min\n`;
            m += `⚔️ Guard: $${this.executor.structGuardPrice.toFixed(prec.price)}\n`;
            m += `🛡️ ZR: ${this.executor.zeroRiskTriggered ? "✅已触发" : "❌"}\n`;
        }

        await notifyTG(m);
    }

    private async hourlyReport() {
        const s = this.ws.getSnapshot();
        const b = await this.executor.getBalance();
        const uptimeMs = Date.now() - this.startTime;
        const uptimeH = Math.floor(uptimeMs / 3600_000);
        const uptimeM = Math.floor((uptimeMs % 3600_000) / 60_000);
        const cs = this.candles.getSnapshot();

        let m = `💓 *V66 LEVIATHAN*\n`;
        m += `${uptimeH}h${uptimeM}m | ${this.paused ? "🔴" : "🟢"}\n`;
        m += `ETH $${s.ethPrice.toFixed(2)} | BTC $${s.btcPrice.toFixed(1)}\n`;
        m += `15M: H2=$${cs.highest2_15m.toFixed(2)} L2=$${cs.lowest2_15m.toFixed(2)}\n`;
        m += `余$${b.toFixed(2)} | M=$${getMargin(b)}\n`;
        m += `今${this.dailyTrades}单 ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(1)}U | 累${this.totalTrades}单 ${this.totalPnl >= 0 ? "+" : ""}${this.totalPnl.toFixed(1)}U`;

        if (this.executor.inPosition) {
            const curPrice = this.executor.positionSymbol === ETH_SYMBOL ? s.ethPrice : s.price;
            const pnl = this.executor.positionSide === "long"
                ? curPrice - this.executor.entryPrice
                : this.executor.entryPrice - curPrice;
            const coinName = this.executor.positionSymbol.replace("USDT", "");
            m += `\n🔥 ${coinName} ${this.executor.positionSide.toUpperCase()} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)}pt | ZR:${this.executor.zeroRiskTriggered ? "✅" : "❌"}`;
        }

        await notifyTG(m);
    }
}

// ═══════════════════════════════════════
// 启动
// ═══════════════════════════════════════

const bot = new LeviathanBot();
process.on("SIGINT", () => {
    log("🛑 停止...");
    process.exit(0);
});
bot.start();
