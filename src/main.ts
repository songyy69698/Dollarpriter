/**
 * 🧠 Dollarprinter V52.2 — Fee Shield Recovery
 * ═══════════════════════════════════════
 * 三模式: A 独立狙击 / B 联动共振 / C BTC领路自动切换
 * MARKET IOC入场 + Fee Shield 8pt + Spread Gate + 20min超时
 */

import { BitunixWSEngine } from "./bitunix-ws";
import { CausalStrategy } from "./strategy";
import { BitunixExecutor } from "./executor";
import { notifyTG, pollTGCommands } from "./telegram";
import {
    LEVERAGE, MARGIN_DEFAULT, IMBALANCE_RATIO,
    SL_POINTS, TP_POINTS, FEE_SHIELD_POINTS,
    HARD_TIMEOUT_MS, MAX_SPREAD_POINTS, MIN_DEPTH_ETH,
    CVD_CONFIRM_TICKS,
    MAX_DAILY_TRADES, MAX_DAILY_LOSS,
    BTC_IMBALANCE_RATIO, SOL_RESONANCE_RATIO,
    BTC_AUTO_SWITCH_RATIO,
    EFFICIENCY_ABS_THRESHOLD,
    SOL_MIN_EFFICIENCY, ETH_MIN_EFFICIENCY,
    SYMBOL, BTC_SYMBOL, ETH_SYMBOL,
    SYMBOL_PRECISION,
} from "./config";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [main] ${msg}`);
}

class CausalArbitrageBot {
    private ws: BitunixWSEngine;
    private strategy: CausalStrategy;
    private executor: BitunixExecutor;

    private running = false;
    private paused = true;
    private startTime = Date.now();

    private dailyTrades = 0;
    private dailyPnl = 0;
    private totalTrades = 0;
    private totalPnl = 0;
    private dailyResetDate = new Date().toDateString();

    constructor() {
        const apiKey = process.env.BITUNIX_API_KEY || "";
        const secretKey = process.env.BITUNIX_SECRET_KEY || "";
        if (!apiKey || !secretKey) {
            log("❌ 缺少 BITUNIX_API_KEY 或 BITUNIX_SECRET_KEY");
            process.exit(1);
        }

        this.ws = new BitunixWSEngine();
        this.strategy = new CausalStrategy();
        this.executor = new BitunixExecutor(apiKey, secretKey);
    }

    async start() {
        log("════════════════════════════════════════════");
        log("  🎯 Dollarprinter V52.2 — Fee Shield Recovery");
        log("  🔥 三模式: 独立狙击 / 联动共振 / BTC自动切换");
        log("  📡 三币种: SOL + BTC + ETH");
        log("════════════════════════════════════════════");

        this.ws.start();
        this.running = true;

        log("⏳ 等待 Bitunix WS 就绪 (SOL + BTC + ETH 三通道)...");
        await this.waitForData();
        log("✅ 数据就绪!");

        await this.executor.syncPositions();
        const bal = await this.executor.getBalance();

        log("════════════════════════════════════════════");
        log(`  💰 余额: $${bal.toFixed(2)}`);
        log(`  📊 ${SYMBOL} | ${LEVERAGE}x 杠杆 | M=$${MARGIN_DEFAULT}`);
        log(`  🎯 A: SOL ${IMBALANCE_RATIO}x 独立 | 效率>${EFFICIENCY_ABS_THRESHOLD}`);
        log(`  🔥 B: BTC ${BTC_IMBALANCE_RATIO}x + SOL ${SOL_RESONANCE_RATIO}x 联动`);
        log(`  🚀 C: BTC ${BTC_AUTO_SWITCH_RATIO}x → SOL>${SOL_MIN_EFFICIENCY} / ETH>${ETH_MIN_EFFICIENCY}`);
        log(`  🛡️ SL=${SL_POINTS}pt | TP=${TP_POINTS}pt | FeeShield≥${FEE_SHIELD_POINTS}pt`);
        log(`  ⏰ 超时=${HARD_TIMEOUT_MS / 60_000}min | Spread≤${MAX_SPREAD_POINTS}pt | Depth≥${MIN_DEPTH_ETH}ETH`);
        log(`  📋 CVD=${CVD_CONFIRM_TICKS}tick | MARKET IOC入场`);
        log(`  ⏰ 日限${MAX_DAILY_TRADES}单`);
        log("════════════════════════════════════════════");

        await notifyTG(
            `🎯 *Dollarprinter V52.2 — Fee Shield Recovery*\n` +
            `余额: $${bal.toFixed(2)} | ${LEVERAGE}x\n` +
            `🛡️ FeeShield≥${FEE_SHIELD_POINTS}pt | SL=${SL_POINTS}pt | TP=${TP_POINTS}pt\n` +
            `⏰ 超时${HARD_TIMEOUT_MS / 60_000}min | Spread≤${MAX_SPREAD_POINTS}pt\n` +
            `BTC ${BTC_AUTO_SWITCH_RATIO}x→SOL/ETH | CVD ${CVD_CONFIRM_TICKS}tick | MARKET IOC\n` +
            `⚠️ 暂停中, 发 1 激活`,
        );

        this.strategyLoop();
        this.positionLoop();
        this.tgCommandLoop();
        setInterval(() => this.hourlyReport(), 3600_000);
        log("🟢 V52.2 就绪 — 等待 CEO 激活 (Telegram 发 1)");
    }

    private async waitForData() {
        while (true) {
            const s = this.ws.getSnapshot();
            if (s.connected && s.price > 0) break;
            await Bun.sleep(1000);
        }
        await Bun.sleep(5000);
    }

    // ═══════════════════════════════════════
    // 策略循环 — 100ms 扫描
    // ═══════════════════════════════════════

    private async strategyLoop() {
        while (this.running) {
            await Bun.sleep(100);

            this.checkDailyReset();
            if (this.paused || this.executor.inPosition) continue;
            if (this.dailyTrades >= MAX_DAILY_TRADES) continue;
            if (this.dailyPnl <= -MAX_DAILY_LOSS) continue;

            const snap = this.ws.getSnapshot();
            if (!snap.connected) continue;

            const sig = this.strategy.evaluate(snap);
            if (!sig) continue;

            // 进场 — 根据 targetSymbol 动态切换
            const modeLabels: Record<string, string> = {
                "sniper": "🎯独立狙击",
                "resonance": "🔥联动共振",
                "auto-switch": "🚀BTC领路",
            };
            const modeLabel = modeLabels[sig.mode] || sig.mode;
            const coinName = sig.targetSymbol.replace("USDT", "");
            const prec = SYMBOL_PRECISION[sig.targetSymbol] || { qty: 1, price: 3 };

            await notifyTG(
                `${modeLabel} *${sig.side.toUpperCase()} ${coinName}*\n${sig.reason}\n` +
                `@ ${sig.price.toFixed(prec.price)} | M=$${sig.margin}`,
            );

            const ok = await this.executor.atomicEntry(sig.side, sig.price, sig.margin, sig.targetSymbol, notifyTG);
            if (ok) {
                log(`✅ ${modeLabel} ${sig.side.toUpperCase()} ${coinName} @ ${sig.price.toFixed(prec.price)} M=$${sig.margin}`);
                await Bun.sleep(500);
                await this.executor.syncPositions();
            }
        }
    }

    // ═══════════════════════════════════════
    // 持仓循环 — 200ms 监控
    // ═══════════════════════════════════════

    private async positionLoop() {
        while (this.running) {
            await Bun.sleep(200);
            if (!this.executor.inPosition) continue;

            const snap = this.ws.getSnapshot();
            if (!snap.connected || snap.price <= 0) continue;

            // 根据当前持仓交易对选择正确的价格
            const currentPrice = this.executor.positionSymbol === ETH_SYMBOL
                ? snap.ethPrice
                : snap.price;

            if (currentPrice <= 0) continue;

            const r = await this.executor.checkPosition(
                currentPrice,
                snap.isEfficiencyDecay,
                snap.recentVol,
                snap.avgVol,
                snap.efficiency,
            );
            if (r.closed) {
                this.dailyTrades++;
                this.dailyPnl += r.netPnlU;
                this.totalTrades++;
                this.totalPnl += r.netPnlU;

                const emoji = r.netPnlU > 0 ? "✅" : "❌";
                const coinName = (r.symbol || "SOL").replace("USDT", "");
                await notifyTG(
                    `${emoji} *平仓 ${coinName}* ${r.reason}\n` +
                    `净PnL: ${r.netPnlU >= 0 ? "+" : ""}${r.netPnlU.toFixed(2)}U\n` +
                    `今日: ${this.dailyTrades}单 | ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(2)}U`,
                );

                await Bun.sleep(1000);
                await this.executor.syncPositions();
            }
        }
    }

    // ═══════════════════════════════════════
    // Telegram 指令
    // ═══════════════════════════════════════

    private async tgCommandLoop() {
        let lastId = 0;
        while (this.running) {
            await Bun.sleep(2000);
            lastId = await pollTGCommands(lastId, {
                "1": async () => {
                    this.paused = false;
                    await notifyTG(`✅ *V52.2 Fee Shield 激活*\n三模式扫描中...`);
                },
                "/start": async () => {
                    this.paused = false;
                    await notifyTG(`✅ *V52.2 Fee Shield 激活*\n三模式扫描中...`);
                },
                "0": async () => {
                    this.paused = true;
                    await notifyTG("🔴 *V52.2 暂停*");
                },
                "/stop": async () => {
                    this.paused = true;
                    await notifyTG("🔴 *V52.2 暂停*");
                },
                s: async () => { await this.sendStatus(); },
                "/status": async () => { await this.sendStatus(); },
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
                        `📖 *V52.2 Fee Shield*\n1 启动\n0 暂停\ns 状态\nx 强平\nh 帮助`,
                    );
                },
                "/help": async () => {
                    await notifyTG(
                        `📖 *V52.2 Fee Shield*\n1 启动\n0 暂停\ns 状态\nx 强平\nh 帮助`,
                    );
                },
            });
        }
    }

    // ═══════════════════════════════════════
    // 状态面板 — V52.2
    // ═══════════════════════════════════════

    private async sendStatus() {
        const s = this.ws.getSnapshot();
        const b = await this.executor.getBalance();
        const uptimeMs = Date.now() - this.startTime;
        const uptimeH = Math.floor(uptimeMs / 3600_000);
        const uptimeM = Math.floor((uptimeMs % 3600_000) / 60_000);

        let m = `📊 *V52.2 Fee Shield Recovery*\n`;
        m += `──────────────\n`;
        m += `💰 余额: $${b.toFixed(2)}\n`;
        m += `🔌 WS: ${s.connected ? "🟢" : "🔴"} | ${this.paused ? "🔴暂停" : "🟢运行"}\n`;
        m += `⚙️ 运行: ${uptimeH}h${uptimeM}m | 扫描: ${this.strategy.getScanCount()}\n`;
        m += `──────────────\n`;
        m += `🛡️ FeeShield≥${FEE_SHIELD_POINTS}pt | SL=${SL_POINTS}pt | TP=${TP_POINTS}pt\n`;
        m += `⏰ 超时=${HARD_TIMEOUT_MS / 60_000}min | Spread≤${MAX_SPREAD_POINTS}pt\n`;
        m += `──────────────\n`;
        m += `📈 SOL $${s.price.toFixed(3)} | 效率${s.efficiency.toFixed(4)}\n`;
        m += `   买:${s.buyDelta.toFixed(1)} 卖:${s.sellDelta.toFixed(1)} | 墙A:${s.askWallVol.toFixed(1)} B:${s.bidWallVol.toFixed(1)}\n`;
        m += `💎 ETH $${s.ethPrice.toFixed(2)} | 效率${s.ethEfficiency.toFixed(4)} | Sp=${s.ethSpread.toFixed(3)} | D3=${s.ethTop3Depth.toFixed(1)}\n`;
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
            m += `持仓: ${holdMin}min / ${HARD_TIMEOUT_MS / 60_000}min\n`;
        }

        await notifyTG(m);
    }

    private async hourlyReport() {
        const s = this.ws.getSnapshot();
        const b = await this.executor.getBalance();
        const uptimeMs = Date.now() - this.startTime;
        const uptimeH = Math.floor(uptimeMs / 3600_000);
        const uptimeM = Math.floor((uptimeMs % 3600_000) / 60_000);

        let m = `💓 *V52.2 Fee Shield*\n`;
        m += `${uptimeH}h${uptimeM}m | ${this.paused ? "🔴" : "🟢"}\n`;
        m += `SOL $${s.price.toFixed(3)} eff=${s.efficiency.toFixed(3)}\n`;
        m += `ETH $${s.ethPrice.toFixed(2)} eff=${s.ethEfficiency.toFixed(3)} sp=${s.ethSpread.toFixed(2)}\n`;
        m += `BTC $${s.btcPrice.toFixed(1)} | 余$${b.toFixed(2)}\n`;
        m += `今${this.dailyTrades}单 ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(1)}U | 累${this.totalTrades}单 ${this.totalPnl >= 0 ? "+" : ""}${this.totalPnl.toFixed(1)}U`;

        if (this.executor.inPosition) {
            const curPrice = this.executor.positionSymbol === ETH_SYMBOL ? s.ethPrice : s.price;
            const pnl = this.executor.positionSide === "long"
                ? curPrice - this.executor.entryPrice
                : this.executor.entryPrice - curPrice;
            const coinName = this.executor.positionSymbol.replace("USDT", "");
            m += `\n🔥 ${coinName} ${this.executor.positionSide.toUpperCase()} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)}pt`;
        }

        await notifyTG(m);
    }

    private checkDailyReset() {
        const today = new Date().toDateString();
        if (today !== this.dailyResetDate) {
            log(`🔄 日统计重置: ${this.dailyTrades}单 ${this.dailyPnl.toFixed(2)}U`);
            this.dailyTrades = 0;
            this.dailyPnl = 0;
            this.dailyResetDate = today;
        }
    }
}

// ═══════════════════════════════════════
// 启动
// ═══════════════════════════════════════
const bot = new CausalArbitrageBot();
process.on("SIGINT", () => {
    log("🛑 停止...");
    process.exit(0);
});
bot.start();
