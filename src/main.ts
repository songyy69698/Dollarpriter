/**
 * 🧠 Dollarprinter V52.4 — Logic Leader
 * ═══════════════════════════════════════
 * 双条件入场: A(BTC4.0x+ETH1.0) B(BTC2.5x+ETH2.0)
 * MARKET IOC + Fee Shield 5pt + 15s持仓保护 + 20min超时
 */

import { BitunixWSEngine } from "./bitunix-ws";
import { CausalStrategy } from "./strategy";
import { BitunixExecutor } from "./executor";
import { notifyTG, pollTGCommands } from "./telegram";
import {
    LEVERAGE, MARGIN_DEFAULT, IMBALANCE_RATIO,
    SL_POINTS, TP_POINTS, FEE_SHIELD_POINTS, MIN_HOLD_MS,
    HARD_TIMEOUT_MS, MAX_SPREAD_POINTS, MIN_DEPTH_ETH,
    CVD_CONFIRM_TICKS,
    MAX_DAILY_TRADES, MAX_DAILY_LOSS,
    BTC_IMBALANCE_RATIO, SOL_RESONANCE_RATIO,
    BTC_LEAD_STRONG, ETH_EFF_WITH_STRONG_BTC,
    BTC_LEAD_WEAK, ETH_EFF_WITH_WEAK_BTC,
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
        log("  🎯 Dollarprinter V52.4 — Logic Leader");
        log("  🔥 双条件入场 + 联动共振 + 独立狙击");
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
        log(`  🚀 C①: BTC≥${BTC_LEAD_STRONG}x + ETH效率≥${ETH_EFF_WITH_STRONG_BTC}`);
        log(`  🚀 C②: BTC≥${BTC_LEAD_WEAK}x + ETH效率≥${ETH_EFF_WITH_WEAK_BTC}`);
        log(`  🛡️ SL=${SL_POINTS}pt | TP=${TP_POINTS}pt | FeeShield≥${FEE_SHIELD_POINTS}pt`);
        log(`  ⏱️ Hold≥${MIN_HOLD_MS / 1000}s | 超时=${HARD_TIMEOUT_MS / 60_000}min | Spread≤${MAX_SPREAD_POINTS}pt`);
        log(`  📋 CVD=${CVD_CONFIRM_TICKS}tick | MARKET IOC入场`);
        log(`  ⏰ 日限${MAX_DAILY_TRADES}单`);
        log("════════════════════════════════════════════");

        await notifyTG(
            `🎯 *Dollarprinter V52.4 — Logic Leader*\n` +
            `余额: $${bal.toFixed(2)} | ${LEVERAGE}x | M=$${MARGIN_DEFAULT}\n` +
            `🛡️ Fee≥5pt | SL=8pt | TP=25pt | Hold≥15s\n` +
            `🚀 C①: BTC≥${BTC_LEAD_STRONG}x+ETH≥1.0 | C②: BTC≥${BTC_LEAD_WEAK}x+ETH≥2.0\n` +
            `⏰ 超时${HARD_TIMEOUT_MS / 60_000}min | CVD ${CVD_CONFIRM_TICKS}tick\n` +
            `⚠️ 暂停中, 发 1 激活`,
        );

        this.strategyLoop();
        this.positionLoop();
        this.tgCommandLoop();
        setInterval(() => this.hourlyReport(), 3600_000);
        log("🟢 V52.4 就绪 — 等待 CEO 激活 (Telegram 发 1)");
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

                // V52.4 延迟诊断 TG 通知
                let diagMsg =
                    `📡 *订单诊断*\n` +
                    `⏱ Entry: ${this.executor.lastEntryMs}ms | SL: ${this.executor.lastSlMs}ms\n` +
                    `[DRIFT] Signal: ${this.executor.signalPrice.toFixed(prec.price)} | Fill: ${this.executor.entryPrice.toFixed(prec.price)} | Slip: ${this.executor.lastSlippage.toFixed(prec.price)}pt`;
                if (this.executor.highSlippage) {
                    diagMsg += `\n🚨 *HIGH SLIPPAGE* — 15s Hold 已取消, 激进出场 BE+1pt`;
                }
                await notifyTG(diagMsg);

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
                    await notifyTG(`✅ *V52.4 Logic Leader 激活*\n双条件+联动+狙击 扫描中...`);
                },
                "/start": async () => {
                    this.paused = false;
                    await notifyTG(`✅ *V52.4 Logic Leader 激活*\n双条件+联动+狙击 扫描中...`);
                },
                "0": async () => {
                    this.paused = true;
                    await notifyTG("🔴 *V52.2 暂停*");
                },
                "/stop": async () => {
                    this.paused = true;
                    await notifyTG("🔴 *V52.4 暂停*");
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
                        `📖 *V52.4 Logic Leader*\n1 启动\n0 暂停\ns 状态\nd 诊断\nx 强平\nh 帮助`,
                    );
                },
                "/help": async () => {
                    await notifyTG(
                        `📖 *V52.4 Logic Leader*\n1 启动\n0 暂停\ns 状态\nd 诊断\nx 强平\nh 帮助`,
                    );
                },
                d: async () => { await this.sendDiagnostics(); },
                "/diag": async () => { await this.sendDiagnostics(); },
            });
        }
    }

    // ═══════════════════════════════════════
    // 📡 连线诊断报告 — TG 命令 `d`
    // ═══════════════════════════════════════

    private async sendDiagnostics() {
        const s = this.ws.getSnapshot();

        let m = `📡 *【连线诊断报告】*\n`;
        m += `──────────────\n`;

        // WS 数据源延迟
        m += `🕒 *数据源延迟 (Bitunix WS → Bot):*\n`;
        m += `   当前: ${s.wsLatencyMs}ms | 平均: ${s.wsLatencyAvg}ms | 最大: ${s.wsLatencyMax}ms\n`;
        if (s.wsLatencyAvg > 200) {
            m += `   ⚠️ 延迟过高，请检查伺服器网路\n`;
        } else {
            m += `   🟢 数据极速\n`;
        }

        // 执行延迟
        m += `\n⚡ *执行延迟 (Bot → Bitunix API):*\n`;
        if (this.executor.lastEntryMs > 0) {
            m += `   Entry: ${this.executor.lastEntryMs}ms | SL: ${this.executor.lastSlMs}ms\n`;
            if (this.executor.lastEntryMs > 500) {
                m += `   ⚠️ Bitunix 回报缓慢\n`;
            } else {
                m += `   🟢 接口正常\n`;
            }
        } else {
            m += `   尚无订单数据\n`;
        }

        // 滑点
        m += `\n📉 *滑点诊断:*\n`;
        if (this.executor.signalPrice > 0) {
            m += `   Signal: ${this.executor.signalPrice.toFixed(2)} → Fill: ${this.executor.entryPrice.toFixed(2)}\n`;
            m += `   Slippage: ${this.executor.lastSlippage.toFixed(2)}pt${this.executor.highSlippage ? " 🚨 HIGH" : " 🟢"}\n`;
            if (this.executor.highSlippage) {
                m += `   ⚠️ 激进出场模式已启动 (BE+1pt)\n`;
            }
        } else {
            m += `   尚无成交数据\n`;
        }

        // 高延迟统计
        m += `\n📊 *累计统计:*\n`;
        m += `   高延迟(>200ms): ${s.highLatencyCount}次\n`;
        m += `──────────────`;

        await notifyTG(m);
    }

    // ═══════════════════════════════════════
    // 状态面板 — V52.4
    // ═══════════════════════════════════════

    private async sendStatus() {
        const s = this.ws.getSnapshot();
        const b = await this.executor.getBalance();
        const uptimeMs = Date.now() - this.startTime;
        const uptimeH = Math.floor(uptimeMs / 3600_000);
        const uptimeM = Math.floor((uptimeMs % 3600_000) / 60_000);

        let m = `📊 *V52.4 Logic Leader*\n`;
        m += `──────────────\n`;
        m += `💰 余额: $${b.toFixed(2)}\n`;
        m += `🔌 WS: ${s.connected ? "🟢" : "🔴"} | ${this.paused ? "🔴暂停" : "🟢运行"}\n`;
        m += `⚙️ 运行: ${uptimeH}h${uptimeM}m | 扫描: ${this.strategy.getScanCount()}\n`;
        m += `──────────────\n`;
        m += `🛡️ Fee≥${FEE_SHIELD_POINTS}pt | SL=${SL_POINTS}pt | TP=${TP_POINTS}pt\n`;
        m += `⏱️ Hold≥${MIN_HOLD_MS / 1000}s | 超时=${HARD_TIMEOUT_MS / 60_000}min\n`;
        m += `🚀 C①: BTC≥${BTC_LEAD_STRONG}x+ETH≥1.0 | C②: BTC≥${BTC_LEAD_WEAK}x+ETH≥2.0\n`;
        m += `──────────────\n`;
        m += `📈 SOL $${s.price.toFixed(3)} | 效率${s.efficiency.toFixed(4)}\n`;
        m += `   买:${s.buyDelta.toFixed(1)} 卖:${s.sellDelta.toFixed(1)} | 墙A:${s.askWallVol.toFixed(1)} B:${s.bidWallVol.toFixed(1)}\n`;
        m += `💎 ETH $${s.ethPrice.toFixed(2)} | 效率${s.ethEfficiency.toFixed(4)} | Sp=${s.ethSpread.toFixed(3)} | D3=${s.ethTop3Depth.toFixed(1)}\n`;
        m += `₿ BTC $${s.btcPrice.toFixed(1)} | 买:${s.btcBuyDelta.toFixed(1)} 卖:${s.btcSellDelta.toFixed(1)}\n`;
        m += `──────────────\n`;
        m += `📋 今日: ${this.dailyTrades}/${MAX_DAILY_TRADES}单 | ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(2)}U\n`;
        m += `📋 累计: ${this.totalTrades}单 | ${this.totalPnl >= 0 ? "+" : ""}${this.totalPnl.toFixed(2)}U\n`;
        m += `──────────────\n`;
        m += `📡 WS延迟: ${s.wsLatencyMs}ms (avg=${s.wsLatencyAvg}ms max=${s.wsLatencyMax}ms)\n`;
        if (s.highLatencyCount > 0) m += `⚠️ 高延迟(>200ms): ${s.highLatencyCount}次\n`;
        if (this.executor.lastEntryMs > 0) {
            m += `⏱ 上次Entry: ${this.executor.lastEntryMs}ms | SL: ${this.executor.lastSlMs}ms | Slip: ${this.executor.lastSlippage.toFixed(2)}pt\n`;
        }

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

        let m = `💓 *V52.4 Logic Leader*\n`;
        m += `${uptimeH}h${uptimeM}m | ${this.paused ? "🔴" : "🟢"}\n`;
        m += `SOL $${s.price.toFixed(3)} eff=${s.efficiency.toFixed(3)}\n`;
        m += `ETH $${s.ethPrice.toFixed(2)} eff=${s.ethEfficiency.toFixed(3)} sp=${s.ethSpread.toFixed(2)}\n`;
        m += `BTC $${s.btcPrice.toFixed(1)} | 余$${b.toFixed(2)}\n`;
        m += `今${this.dailyTrades}单 ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(1)}U | 累${this.totalTrades}单 ${this.totalPnl >= 0 ? "+" : ""}${this.totalPnl.toFixed(1)}U`;
        m += `\n📡 WS: ${s.wsLatencyAvg}ms(avg) ${s.wsLatencyMax}ms(max) ${s.highLatencyCount}❗`;

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
