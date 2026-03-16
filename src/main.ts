/**
 * 🧬 Dollarprinter V80-DEFIANCE — n-of-1 ADAPTIVE
 * ═══════════════════════════════════════
 * 自适应子弹 + ATR 动态灵敏度 + 分阶段出场 + 熔断器
 * $400 → $3,500
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

// ═══ 熔断器常量 ═══
const CIRCUIT_BREAKER_BALANCE = 200; // $200 以下才切防御

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
        log("  🧬 Dollarprinter V80-DEFIANCE");
        log("  🎯 n-of-1 ADAPTIVE: $400 → $3,500");
        log("  📊 ATR灵敏度 + 动态子弹 + 分阶段出场");
        log("  🛡️ SL=4pt | Stage1=+10pt平30% | 15m结构护卫");
        log("  🔒 熔断器: <$300 自动防御");
        log("════════════════════════════════════════════");

        await this.candles.bootstrap();
        await this.candles.bootstrapAmplitude();
        this.candles.start();
        this.ws.start();
        await this.waitForWS();

        const bal = await this.executor.getBalance();
        this.currentBalance = bal;
        const dt = new Date();
        const utc8h = (dt.getUTCHours() + 8) % 24;
        const tmCfg = getTimeMode(utc8h, dt.getUTCMinutes());

        // 启动时检查熔断器
        if (bal > 0 && bal < CIRCUIT_BREAKER_BALANCE) {
            this.strategy.defenseMode = true;
            log("🚨 熔断器激活! 防御模式");
        }

        log(`  💰 余额: $${bal.toFixed(2)}`);
        log(`  📊 ATR_15m: ${this.candles.atr15m.toFixed(2)}pt`);
        log(`  📊 1H均幅: ${this.candles.avg1hAmplitude.toFixed(2)}pt`);
        log(`  🕒 模式: ${tmCfg.mode} | 防御: ${this.strategy.defenseMode ? "🔴ON" : "🟢OFF"}`);
        log("════════════════════════════════════════════");

        await notifyTG(
            `🧬 *V80-DEFIANCE 已启动*\n` +
            `💰 $${bal.toFixed(2)} | ${LEVERAGE}x\n` +
            `🕒 *${tmCfg.mode}* | 防御: ${this.strategy.defenseMode ? "🔴ON" : "🟢OFF"}\n` +
            `📊 ATR=${this.candles.atr15m.toFixed(1)}pt | 1H均幅=${this.candles.avg1hAmplitude.toFixed(1)}pt\n` +
            `🎯 动态子弹: $30(SCALP) / $100(SNIPER)\n` +
            `💰 Stage1: +10pt→平30% | Stage2: 15m结构护卫\n` +
            `🛡️ SL=${SL_POINTS}pt | ZR≥${ZERO_RISK_THRESHOLD}pt\n` +
            `🔒 熔断器: <$${CIRCUIT_BREAKER_BALANCE}→防御\n` +
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
            // 熔断器: 实时检测
            if (this.currentBalance > 0 && this.currentBalance < CIRCUIT_BREAKER_BALANCE && !this.strategy.defenseMode) {
                this.strategy.defenseMode = true;
                log("🚨 熔断器激活! 余额 < $" + CIRCUIT_BREAKER_BALANCE);
                await notifyTG(`🚨 *熔断器激活!*\n余额 $${this.currentBalance.toFixed(2)} < $${CIRCUIT_BREAKER_BALANCE}\n自动切换防御模式: M=$20, 更严格入场`);
            } else if (this.currentBalance >= CIRCUIT_BREAKER_BALANCE + 50 && this.strategy.defenseMode) {
                this.strategy.defenseMode = false;
                log("🟢 熔断器解除! 余额恢复");
                await notifyTG(`🟢 *熔断器解除*\n余额 $${this.currentBalance.toFixed(2)} ≥ $${CIRCUIT_BREAKER_BALANCE + 50}\n恢复正常子弹`);
            }
        }, 60_000);
        log("🟢 V80-DEFIANCE 就绪 — 发 1 激活");
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

            const s = this.ws.getSnapshot();
            this.candles.updateRealtimePrice(s.ethPrice);

            const sig = this.strategy.evaluate(s, this.candles, this.currentBalance);
            if (!sig) return;

            const prec = SYMBOL_PRECISION[sig.targetSymbol] || { qty: 1, price: 3 };
            const coinName = sig.targetSymbol.replace("USDT", "");

            await notifyTG(
                `🧬 *${sig.side.toUpperCase()} ${coinName}*\n${sig.reason}\n` +
                `@ ${sig.price.toFixed(prec.price)} | M=$${sig.margin}`,
            );

            const ok = await this.executor.atomicEntry(sig.side, sig.price, sig.margin, sig.targetSymbol, notifyTG);
            if (ok) {
                this.executor.originalQty = this.executor.positionQty;
                log(`✅ 🧬 ${sig.side.toUpperCase()} ${coinName} @ ${sig.price.toFixed(prec.price)} M=$${sig.margin}`);
                let diagMsg =
                    `📡 *订单诊断*\n` +
                    `⏱ Entry: ${this.executor.lastEntryMs}ms | SL: ${this.executor.lastSlMs}ms\n` +
                    `[DRIFT] Signal: ${this.executor.signalPrice.toFixed(prec.price)} | Fill: ${this.executor.entryPrice.toFixed(prec.price)} | Slip: ${this.executor.lastSlippage.toFixed(prec.price)}pt`;
                if (this.executor.highSlippage) {
                    diagMsg += `\n🚨 *HIGH SLIPPAGE*`;
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
                "1": async () => { this.paused = false; await notifyTG(`✅ *DEFIANCE 激活* [${this.strategy.currentMode}] ${this.strategy.defenseMode ? "🛡️防御" : "🧬进攻"}`); },
                "/start": async () => { this.paused = false; await notifyTG(`✅ *DEFIANCE 激活* [${this.strategy.currentMode}]`); },
                "0": async () => { this.paused = true; await notifyTG("🔴 *DEFIANCE 暂停*"); },
                "/stop": async () => { this.paused = true; await notifyTG("🔴 *DEFIANCE 暂停*"); },
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
                h: async () => { await notifyTG(`📖 *DEFIANCE*\n1 激活\n0 暂停\ns 状态\nd 诊断\nx 强平\nh 帮助`); },
                "/help": async () => { await notifyTG(`📖 *DEFIANCE*\n1 激活\n0 暂停\ns 状态\nd 诊断\nx 强平\nh 帮助`); },
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
        const atr = this.candles.atr15m;

        let m = `📡 *【DEFIANCE 诊断】*\n──────────────\n`;
        m += `🧬 防御: ${this.strategy.defenseMode ? "🔴ON $20" : "🟢OFF 动态"}\n`;
        m += `🕒 *${tmCfg.mode}* | ATR=${atr.toFixed(1)}pt\n`;
        m += `📊 疲劳: ${(fatigue * 100).toFixed(0)}%`;
        if (fatigue > 0.9) m += ` 🔴`;
        else if (fatigue > 0.7) m += ` 🟡`;
        else m += ` 🟢`;
        m += ` | 趋势: ${this.candles.isTrendAligned() ? "✅对齐" : "❌无"}\n`;
        m += `   1H均幅=${cSnap.avg1hAmplitude.toFixed(1)}pt | 当前=${(cSnap.currentHourHigh - cSnap.currentHourLow).toFixed(1)}pt\n`;
        m += `──────────────\n`;
        m += `🔨 賣牆=${s.ethL1AskVol.toFixed(1)} 買牆=${s.ethL1BidVol.toFixed(1)} 瞬=${s.ethInstantVol.toFixed(1)}\n`;
        m += `   牆比=${(s.ethL1BidVol / Math.max(s.ethL1AskVol, 0.001)).toFixed(2)}\n`;
        const btcR = s.btcBuyDelta / Math.max(s.btcSellDelta, 0.001);
        m += `₿ 買=${s.btcBuyDelta.toFixed(1)} 賣=${s.btcSellDelta.toFixed(1)} 比=${btcR.toFixed(1)}x\n`;
        if (this.executor.inPosition) {
            m += `──────────────\n`;
            m += `🛡️ ZR:${this.executor.zeroRiskTriggered ? "✅" : "❌"} Stage1:${this.executor.stage1Closed ? "✅30%已平" : "❌待触发"}\n`;
        }
        await notifyTG(m);
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
        const tmCfg = getTimeMode(utc8h, dt.getUTCMinutes());
        const fatigue = this.candles.getFatigue();

        let m = `🧬 *DEFIANCE*\n──────────────\n`;
        m += `💰 $${b.toFixed(2)} | ${this.strategy.defenseMode ? "🛡️防御" : "🧬进攻"}\n`;
        m += `${s.connected ? "🟢" : "🔴"} | ${this.paused ? "🔴暂停" : "🟢运行"} | ${uptimeH}h${uptimeM}m\n`;
        m += `──────────────\n`;
        m += `🕒 *${tmCfg.mode}* | ATR=${this.candles.atr15m.toFixed(1)}pt\n`;
        m += `📊 疲劳:${(fatigue * 100).toFixed(0)}% | 趋势:${this.candles.isTrendAligned() ? "✅" : "❌"}\n`;
        m += `💎 ETH $${s.ethPrice.toFixed(2)}\n`;
        m += `──────────────\n`;
        m += `📋 今:${this.dailyTrades}/${MAX_DAILY_TRADES} ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(1)}U\n`;
        m += `📋 累:${this.totalTrades}单 ${this.totalPnl >= 0 ? "+" : ""}${this.totalPnl.toFixed(1)}U\n`;

        if (this.executor.inPosition) {
            const prec = SYMBOL_PRECISION[this.executor.positionSymbol] || { qty: 1, price: 3 };
            const curPrice = this.executor.positionSymbol === ETH_SYMBOL ? s.ethPrice : s.price;
            const pnl = this.executor.positionSide === "long"
                ? curPrice - this.executor.entryPrice : this.executor.entryPrice - curPrice;
            const coinName = this.executor.positionSymbol.replace("USDT", "");
            m += `──────────────\n`;
            m += `🔥 ${coinName} ${this.executor.positionSide.toUpperCase()} @ $${this.executor.entryPrice.toFixed(prec.price)}\n`;
            m += `浮盈:${pnl >= 0 ? "+" : ""}${pnl.toFixed(prec.price)}pt | Stage1:${this.executor.stage1Closed ? "✅" : "❌"}\n`;
        }

        await notifyTG(m);
    }

    private async hourlyReport() {
        const s = this.ws.getSnapshot();
        const b = await this.executor.getBalance();
        const uptimeMs = Date.now() - this.startTime;
        const uptimeH = Math.floor(uptimeMs / 3600_000);
        const fatigue = this.candles.getFatigue();

        let m = `💓 *DEFIANCE* ${uptimeH}h | ${this.paused ? "🔴" : "🟢"} | [${this.strategy.currentMode}]\n`;
        m += `ETH $${s.ethPrice.toFixed(2)} | ATR=${this.candles.atr15m.toFixed(1)}pt\n`;
        m += `疲劳:${(fatigue * 100).toFixed(0)}% | 趋势:${this.candles.isTrendAligned() ? "✅" : "❌"}\n`;
        m += `余$${b.toFixed(2)} | ${this.strategy.defenseMode ? "🛡️防御" : "🧬进攻"}\n`;
        m += `今${this.dailyTrades}/${MAX_DAILY_TRADES} ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(1)}U`;

        await notifyTG(m);
    }
}

const bot = new LeviathanBot();
process.on("SIGINT", () => { log("🛑 停止..."); process.exit(0); });
bot.start();
