/**
 * 🐋 Dollarprinter V80.1 — FINAL-SENSE
 * ═══════════════════════════════════════
 * 自适应时段: TREND/SCALP/ANTIFAKE/TITAN/SLEEP
 * 振幅疲劳仪 + 穿牆狙击 + 吸能/牆压止盈
 */

import { BitunixWSEngine } from "./bitunix-ws";
import { CausalStrategy } from "./strategy";
import { BitunixExecutor } from "./executor";
import { CandleTracker } from "./candles";
import { notifyTG, pollTGCommands } from "./telegram";
import {
    LEVERAGE, MARGIN_DEFAULT,
    SL_POINTS, ZERO_RISK_THRESHOLD,
    MAX_DAILY_TRADES, MAX_DAILY_LOSS,
    BREAKOUT_POWER_MIN,
    ETH_SYMBOL, SYMBOL_PRECISION,
    getMargin, getTimeMode,
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

    private paused = true;
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
        log("  🐋 Dollarprinter V80.1 — FINAL-SENSE");
        log("  🕒 TREND / SCALP / ANTIFAKE / TITAN / SLEEP");
        log("  📊 振幅疲劳仪 + L1 对撞感应器");
        log("  🛡️ SL=4pt | ZR=6pt | M=$" + MARGIN_DEFAULT);
        log("  🔒 受控: 上限 " + MAX_DAILY_TRADES + " 单 | 默认暂停");
        log("════════════════════════════════════════════");

        await this.candles.bootstrap();
        await this.candles.bootstrapAmplitude();
        this.candles.start();
        this.ws.start();
        await this.waitForWS();

        const bal = await this.executor.getBalance();
        this.currentBalance = bal;
        const margin = getMargin(bal);
        const dt = new Date();
        const utc8h = (dt.getUTCHours() + 8) % 24;
        const tmCfg = getTimeMode(utc8h, dt.getUTCMinutes());

        log(`  💰 余额: $${bal.toFixed(2)} | M=$${margin}`);
        log(`  📊 1H均幅: ${this.candles.avg1hAmplitude.toFixed(2)}pt`);
        log(`  🕒 当前模式: ${tmCfg.mode}`);
        log("════════════════════════════════════════════");

        await notifyTG(
            `🐋 *V80.1 FINAL-SENSE 已启动*\n` +
            `💰 $${bal.toFixed(2)} | ${LEVERAGE}x | M=$${margin}\n` +
            `🕒 模式: *${tmCfg.mode}* | BTC≥${tmCfg.btcThreshold}x\n` +
            `📊 1H均幅: ${this.candles.avg1hAmplitude.toFixed(2)}pt\n` +
            `🛡️ SL=${SL_POINTS}pt | ZR≥${ZERO_RISK_THRESHOLD}pt\n` +
            `🔒 受控: 上限 ${MAX_DAILY_TRADES} 单 | 🔴默认暂停\n` +
            `🟢 振幅疲劳仪 + L1对撞感应器已联通\n` +
            `发 *1* 激活扫描`,
        );

        await this.executor.setupTradeEnv(ETH_SYMBOL);

        const recovered = await this.executor.recoverPositions();
        if (recovered) {
            const coinName = this.executor.positionSymbol.replace("USDT", "");
            const prec = SYMBOL_PRECISION[this.executor.positionSymbol] || { qty: 1, price: 3 };
            await notifyTG(
                `🔄 *仓位自动接管*\n` +
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
        }, 60_000);
        log("🟢 V80.1 就绪 — 发 1 激活");
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

    private strategyLoop() {
        setInterval(async () => {
            if (this.paused) return;
            if (this.executor.inPosition) return;
            if (this.dailyTrades >= MAX_DAILY_TRADES) return;
            if (this.dailyPnl <= -MAX_DAILY_LOSS) return;

            // V80.1: 实时更新振幅
            const s = this.ws.getSnapshot();
            this.candles.updateRealtimePrice(s.ethPrice);

            const sig = this.strategy.evaluate(s, this.candles, this.currentBalance);
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
        }, 500);
    }

    private positionLoop() {
        setInterval(async () => {
            if (!this.executor.inPosition) return;

            const s = this.ws.getSnapshot();
            const currentPrice = this.executor.positionSymbol === ETH_SYMBOL ? s.ethPrice : s.price;
            if (currentPrice <= 0) return;

            this.candles.updateRealtimePrice(s.ethPrice);

            const r = await this.executor.checkPosition(
                currentPrice,
                this.candles.prev15mHigh,
                this.candles.prev15mLow,
                this.candles.last1mClose,
                s.ethL1AskVol,
                s.ethL1BidVol,
                s.ethInstantVol,
                s.ethAvgVol,
                s.ethLastPrice,
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

    private tgCommandLoop() {
        let lastId = 0;
        setInterval(async () => {
            lastId = await pollTGCommands(lastId, {
                "1": async () => { this.paused = false; await notifyTG(`✅ *V80.1 激活* [${this.strategy.currentMode}]`); },
                "/start": async () => { this.paused = false; await notifyTG(`✅ *V80.1 激活* [${this.strategy.currentMode}]`); },
                "0": async () => { this.paused = true; await notifyTG("🔴 *V80.1 暂停*"); },
                "/stop": async () => { this.paused = true; await notifyTG("🔴 *V80.1 暂停*"); },
                s: async () => { await this.sendStatus(); },
                "/status": async () => { await this.sendStatus(); },
                d: async () => { await this.sendDiagnostics(); },
                "/diag": async () => { await this.sendDiagnostics(); },
                x: async () => {
                    const s = this.ws.getSnapshot();
                    const price = this.executor.positionSymbol === ETH_SYMBOL ? s.ethPrice : s.price;
                    const r = await this.executor.forceCloseAll(price);
                    if (r.ok) {
                        this.dailyTrades++; this.dailyPnl += r.netPnlU;
                        this.totalTrades++; this.totalPnl += r.netPnlU;
                        await notifyTG(`🔴 *强平* ${r.netPnlU.toFixed(2)}U`);
                    } else { await notifyTG("⚠️ 无持仓"); }
                },
                "/close": async () => {
                    const s = this.ws.getSnapshot();
                    const price = this.executor.positionSymbol === ETH_SYMBOL ? s.ethPrice : s.price;
                    const r = await this.executor.forceCloseAll(price);
                    if (r.ok) {
                        this.dailyTrades++; this.dailyPnl += r.netPnlU;
                        this.totalTrades++; this.totalPnl += r.netPnlU;
                        await notifyTG(`🔴 *强平* ${r.netPnlU.toFixed(2)}U`);
                    } else { await notifyTG("⚠️ 无持仓"); }
                },
                h: async () => { await notifyTG(`📖 *V80.1*\n1 激活\n0 暂停\ns 状态\nd 诊断\nx 强平\nh 帮助`); },
                "/help": async () => { await notifyTG(`📖 *V80.1*\n1 激活\n0 暂停\ns 状态\nd 诊断\nx 强平\nh 帮助`); },
            });
        }, 2000);
    }

    private async sendDiagnostics() {
        const s = this.ws.getSnapshot();
        const dt = new Date();
        const utc8h = (dt.getUTCHours() + 8) % 24;
        const tmCfg = getTimeMode(utc8h, dt.getUTCMinutes());
        const fatigue = this.candles.getFatigue();
        const cSnap = this.candles.getSnapshot();

        let m = `📡 *【V80.1 诊断报告】*\n`;
        m += `──────────────\n`;
        m += `🕒 *${tmCfg.mode}* | BTC≥${tmCfg.btcThreshold}x | SL=${tmCfg.slPoints}pt\n`;
        m += `📊 *疲劳:* ${(fatigue * 100).toFixed(0)}%`;
        if (fatigue > 0.9) m += ` 🔴耗尽`;
        else if (fatigue > 0.7) m += ` 🟡禁追`;
        else m += ` 🟢充足`;
        m += `\n`;
        m += `   1H均幅=${cSnap.avg1hAmplitude.toFixed(2)}pt | 当前=${(cSnap.currentHourHigh - cSnap.currentHourLow).toFixed(2)}pt\n`;
        m += `   H=${cSnap.currentHourHigh.toFixed(2)} L=${cSnap.currentHourLow.toFixed(2)}\n`;
        m += `──────────────\n`;
        m += `🔨 *L1感应:*\n`;
        m += `   賣牆=${s.ethL1AskVol.toFixed(2)} | 買牆=${s.ethL1BidVol.toFixed(2)}\n`;
        m += `   瞬量=${s.ethInstantVol.toFixed(2)} | 均量=${s.ethAvgVol.toFixed(2)}\n`;
        m += `   牆比=${(s.ethL1BidVol / Math.max(s.ethL1AskVol, 0.001)).toFixed(2)}\n`;
        m += `──────────────\n`;
        m += `₿ 買=${s.btcBuyDelta.toFixed(1)} 賣=${s.btcSellDelta.toFixed(1)}\n`;
        const btcR = s.btcBuyDelta / Math.max(s.btcSellDelta, 0.001);
        m += `   比=${btcR.toFixed(1)}x (門檻=${tmCfg.btcThreshold}x)\n`;
        m += `──────────────\n`;
        m += `🕒 WS: ${s.wsLatencyMs}ms\n`;
        if (this.executor.lastEntryMs > 0)
            m += `⏱ Entry: ${this.executor.lastEntryMs}ms | SL: ${this.executor.lastSlMs}ms | Slip: ${this.executor.lastSlippage.toFixed(2)}pt\n`;
        if (this.executor.inPosition)
            m += `🛡️ ZR: ${this.executor.zeroRiskTriggered ? "✅" : "❌"}\n`;

        await notifyTG(m);
    }

    private async sendStatus() {
        const s = this.ws.getSnapshot();
        const b = await this.executor.getBalance();
        this.currentBalance = b;
        const margin = getMargin(b);
        const uptimeMs = Date.now() - this.startTime;
        const uptimeH = Math.floor(uptimeMs / 3600_000);
        const uptimeM = Math.floor((uptimeMs % 3600_000) / 60_000);
        const dt = new Date();
        const utc8h = (dt.getUTCHours() + 8) % 24;
        const tmCfg = getTimeMode(utc8h, dt.getUTCMinutes());
        const fatigue = this.candles.getFatigue();

        let m = `🐋 *V80.1 FINAL-SENSE*\n──────────────\n`;
        m += `💰 $${b.toFixed(2)} | M=$${margin}\n`;
        m += `🔌 ${s.connected ? "🟢" : "🔴"} | ${this.paused ? "🔴暂停" : "🟢运行"}\n`;
        m += `⚙️ ${uptimeH}h${uptimeM}m | 扫描: ${this.strategy.getScanCount()}\n`;
        m += `──────────────\n`;
        m += `🕒 *${tmCfg.mode}* | BTC≥${tmCfg.btcThreshold}x\n`;
        m += `📊 疲劳: ${(fatigue * 100).toFixed(0)}% | 1H均幅=${this.candles.avg1hAmplitude.toFixed(1)}pt\n`;
        m += `🛡️ SL=${tmCfg.slPoints}pt | ZR≥${ZERO_RISK_THRESHOLD}pt\n`;
        m += `💎 ETH $${s.ethPrice.toFixed(2)} | Sp=${s.ethSpread.toFixed(3)}\n`;
        m += `₿ BTC $${s.btcPrice.toFixed(1)} | 买:${s.btcBuyDelta.toFixed(1)} 卖:${s.btcSellDelta.toFixed(1)}\n`;
        m += `──────────────\n`;
        m += `📋 今: ${this.dailyTrades}/${MAX_DAILY_TRADES} | ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(2)}U\n`;
        m += `📋 累: ${this.totalTrades}单 | ${this.totalPnl >= 0 ? "+" : ""}${this.totalPnl.toFixed(2)}U\n`;

        if (this.executor.inPosition) {
            const prec = SYMBOL_PRECISION[this.executor.positionSymbol] || { qty: 1, price: 3 };
            const curPrice = this.executor.positionSymbol === ETH_SYMBOL ? s.ethPrice : s.price;
            const pnl = this.executor.positionSide === "long"
                ? curPrice - this.executor.entryPrice : this.executor.entryPrice - curPrice;
            const coinName = this.executor.positionSymbol.replace("USDT", "");
            m += `──────────────\n`;
            m += `🔥 ${coinName} ${this.executor.positionSide.toUpperCase()} @ $${this.executor.entryPrice.toFixed(prec.price)}\n`;
            m += `浮盈: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(prec.price)}pt | ZR:${this.executor.zeroRiskTriggered ? "✅" : "❌"}\n`;
        }

        await notifyTG(m);
    }

    private async hourlyReport() {
        const s = this.ws.getSnapshot();
        const b = await this.executor.getBalance();
        const uptimeMs = Date.now() - this.startTime;
        const uptimeH = Math.floor(uptimeMs / 3600_000);
        const uptimeM = Math.floor((uptimeMs % 3600_000) / 60_000);
        const fatigue = this.candles.getFatigue();

        let m = `💓 *V80.1* ${uptimeH}h${uptimeM}m | ${this.paused ? "🔴" : "🟢"} | [${this.strategy.currentMode}]\n`;
        m += `ETH $${s.ethPrice.toFixed(2)} | BTC $${s.btcPrice.toFixed(1)}\n`;
        m += `疲劳:${(fatigue * 100).toFixed(0)}% | 1H均幅=${this.candles.avg1hAmplitude.toFixed(1)}pt\n`;
        m += `余$${b.toFixed(2)} | M=$${getMargin(b)}\n`;
        m += `今${this.dailyTrades}/${MAX_DAILY_TRADES} ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(1)}U | 累${this.totalTrades}单 ${this.totalPnl >= 0 ? "+" : ""}${this.totalPnl.toFixed(1)}U`;

        await notifyTG(m);
    }
}

const bot = new LeviathanBot();
process.on("SIGINT", () => { log("🛑 停止..."); process.exit(0); });
bot.start();
