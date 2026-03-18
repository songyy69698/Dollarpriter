/**
 * 🎯 Dollarprinter V93 — 六重共振策略
 * ═══════════════════════════════════════════════════
 * 回测: 20天14笔79%胜+$591 | 本周4笔100%胜+$158
 * 入场: POC+RSI+量+ATR+K棒+疲劳 全绿 + 回调进
 * 出场: 窗口收盘平仓 + 硬SL=8保护
 * 模式: 信号→CEO确认→5ETH | 不回→自动3ETH
 */

import { BitunixWSEngine } from "./bitunix-ws";
import { Mom12Strategy } from "./strategy";
import type { Mom12Signal } from "./strategy";
import { BitunixExecutor } from "./executor";
import { notifyTG, pollTGCommands } from "./telegram";
import {
    LEVERAGE, MARGIN_PER_TRADE,
    INITIAL_SL_PT, BREAKEVEN_PT, TRAILING_PT,
    MAX_DAILY_TRADES, MAX_DAILY_LOSS,
    ETH_SYMBOL, SYMBOL_PRECISION,
    MOM12_THRESHOLD, VOL_MULTIPLIER, BINANCE_BASE,
} from "./config";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [main] ${msg}`);
}

const AUTO_QTY = 3.0;       // 不回覆自动开 3ETH
const CEO_QTY = 5.0;        // CEO确认开 5ETH
const AUTO_TIMEOUT_MS = 180_000;   // 3分钟

class DollarprinterBot {
    private ws: BitunixWSEngine;
    private strategy: Mom12Strategy;
    private executor: BitunixExecutor;

    private paused = true;
    private startTime = Date.now();
    private dailyTrades = 0;
    private dailyPnl = 0;
    private totalTrades = 0;
    private totalPnl = 0;

    private signalSentTs = 0;
    private signalNotified = false;

    constructor() {
        const apiKey = process.env.BITUNIX_API_KEY || "";
        const secretKey = process.env.BITUNIX_SECRET_KEY || "";
        if (!apiKey || !secretKey) { log("❌ 缺少 API Key"); process.exit(1); }
        this.ws = new BitunixWSEngine();
        this.strategy = new Mom12Strategy();
        this.executor = new BitunixExecutor(apiKey, secretKey);
    }

    async start() {
        log("════════════════════════════════════════════");
        log("  🎯 V91 Mom12 冠军策略");
        log(`  📊 入场: Mom12>${MOM12_THRESHOLD}pt + 放量×${VOL_MULTIPLIER}`);
        log(`  🛡️ SL=${INITIAL_SL_PT} → 保本${BREAKEVEN_PT}+1 → 跟踪${TRAILING_PT}`);
        log(`  💰 $${MARGIN_PER_TRADE}/单 ${LEVERAGE}x | CEO→${CEO_QTY}ETH 自动→${AUTO_QTY}ETH`);
        log("════════════════════════════════════════════");

        this.ws.start();
        await this.waitForWS();

        const bal = await this.executor.getBalance();
        log(`  💰 余额: $${bal.toFixed(2)}`);

        await notifyTG(
            `🎯 *V92b 本周策略: 只做多*\n` +
            `💰 $${bal.toFixed(2)} | ${LEVERAGE}x\n` +
            `📊 Mom12<-40pt + 放量≥1.5x → 做多\n` +
            `📈 RSI=19超卖 → 抓反弹\n` +
            `🛡️ SL=${INITIAL_SL_PT} → BE${BREAKEVEN_PT}+1 → TR${TRAILING_PT}\n` +
            `⏰ 窗口: 08/15/22 UTC+8\n` +
            `发 *1* 激活`,
        );

        await this.executor.setupTradeEnv(ETH_SYMBOL);
        const recovered = await this.executor.recoverPositions();
        if (recovered) {
            const prec = SYMBOL_PRECISION[this.executor.positionSymbol] || { qty: 1, price: 3 };
            await notifyTG(
                `🔄 *仓位接管*\n` +
                `ETH ${this.executor.positionSide.toUpperCase()} ` +
                `${this.executor.positionQty} @ $${this.executor.entryPrice.toFixed(prec.price)}`,
            );
        }

        this.strategyLoop();
        this.positionLoop();
        this.tgCommandLoop();
        setInterval(() => this.hourlyReport(), 3600_000);
        setInterval(() => this.dailyReset(), 60_000);

        log("🟢 V91 就绪 — 发 1 激活");
    }

    private async waitForWS() {
        let w = 0;
        while (w < 30) {
            const s = this.ws.getSnapshot();
            if (s.connected && s.ethPrice > 0) break;
            await Bun.sleep(1000); w++;
        }
        log("📡 WS 就绪");
    }

    private dailyReset() {
        const dt = new Date();
        const h = (dt.getUTCHours() + 8) % 24, m = dt.getUTCMinutes();
        if (h === 0 && m === 0) {
            this.dailyTrades = 0; this.dailyPnl = 0;
            log("📅 日重置");
        }
    }

    // ═══ 策略循环 ═══
    private strategyLoop() {
        setInterval(async () => {
            if (this.paused) return;
            if (this.executor.inPosition) return;
            if (this.dailyTrades >= MAX_DAILY_TRADES) return;
            if (this.dailyPnl <= -MAX_DAILY_LOSS) return;

            // 刷新 K线数据
            await this.strategy.refreshKlines();

            // 检查待确认信号
            const pending = this.strategy.pendingSignal;
            if (pending) {
                if (this.strategy.ceoApproved) {
                    log(`✅ CEO 确认! ${CEO_QTY}ETH`);
                    await this.executeEntry(pending.side, pending.price, CEO_QTY);
                    this.strategy.markTraded();
                    return;
                }
                if (this.signalNotified && Date.now() - this.signalSentTs >= AUTO_TIMEOUT_MS) {
                    log(`⏰ 3分钟未回 → 自动${AUTO_QTY}ETH`);
                    await notifyTG(`⏰ *3分钟未确认 → 自动${AUTO_QTY}ETH*`);
                    await this.executeEntry(pending.side, pending.price, AUTO_QTY);
                    this.strategy.markTraded();
                    return;
                }
                if (!this.signalNotified) {
                    await this.sendSignalNotification(pending);
                    this.signalSentTs = Date.now();
                    this.signalNotified = true;
                }
                return;
            }

            this.signalNotified = false;
            this.strategy.evaluate();

        }, 10_000); // 每10秒检查 (K线5分钟更新一次)
    }

    private async sendSignalNotification(sig: Mom12Signal) {
        const msg =
            `🎯 *V93 六绿全亮*\n` +
            `──────────\n` +
            `⏰ ${sig.windowName}\n` +
            `方向: *${sig.side.toUpperCase()}* ${sig.side === "long" ? "📈做多" : "📉做空"}\n` +
            `价格: $${sig.price.toFixed(2)}\n` +
            `──────────\n` +
            `POC: ${sig.momentum >= 0 ? "+" : ""}${sig.momentum.toFixed(0)}pt\n` +
            `量: ${sig.volRatio.toFixed(1)}x\n` +
            `──────────\n` +
            `窗口收盘自动平仓\n` +
            `回 *y* → ${CEO_QTY}ETH\n` +
            `3分钟不回 → ${AUTO_QTY}ETH`;
        await notifyTG(msg);
    }

    private windowCloseTimer: ReturnType<typeof setTimeout> | null = null;

    private async executeEntry(side: "long" | "short", price: number, qty: number) {
        const s = this.ws.getSnapshot();
        const livePrice = s.ethPrice > 0 ? s.ethPrice : price;
        const prec = SYMBOL_PRECISION[ETH_SYMBOL] || { qty: 3, price: 2 };
        await notifyTG(`🏁 *${side.toUpperCase()} ETH*\n@ $${livePrice.toFixed(prec.price)} | ${qty}ETH`);
        const ok = await this.executor.atomicEntry(side, livePrice, qty, ETH_SYMBOL, notifyTG);
        if (ok) {
            log(`✅ ${side.toUpperCase()} ${qty} ETH @ ${livePrice.toFixed(prec.price)}`);
            await notifyTG(
                `📡 *诊断*\n⏱ Entry: ${this.executor.lastEntryMs}ms | SL: ${this.executor.lastSlMs}ms\nSlip: ${this.executor.lastSlippage.toFixed(prec.price)}pt` +
                (this.executor.highSlippage ? `\n🚨 *HIGH SLIPPAGE*` : ""),
            );
            await Bun.sleep(500);
            await this.executor.syncPositions();

            // ═══ V93: 窗口收盘定时平仓 ═══
            const pending = this.strategy.pendingSignal;
            if (pending?.windowEndTs) {
                const msToClose = pending.windowEndTs - Date.now();
                if (msToClose > 0 && msToClose < 3600_000) {
                    if (this.windowCloseTimer) clearTimeout(this.windowCloseTimer);
                    const closeMinutes = (msToClose / 60_000).toFixed(1);
                    log(`⏰ 窗口收盘平仓定时: ${closeMinutes}min后`);
                    this.windowCloseTimer = setTimeout(async () => {
                        if (!this.executor.inPosition) return;
                        const snap = this.ws.getSnapshot();
                        log(`⏰ 窗口收盘! 自动平仓`);
                        const r = await this.executor.forceCloseAll(snap.ethPrice);
                        if (r.ok) {
                            this.dailyTrades++; this.dailyPnl += r.netPnlU;
                            this.totalTrades++; this.totalPnl += r.netPnlU;
                            const emoji = r.netPnlU > 0 ? "✅" : "❌";
                            await notifyTG(
                                `${emoji} *窗口收盘平仓*\n` +
                                `净PnL: ${r.netPnlU >= 0 ? "+" : ""}${r.netPnlU.toFixed(2)}U\n` +
                                `今日: ${this.dailyTrades}/${MAX_DAILY_TRADES} ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(2)}U`,
                            );
                        }
                        this.windowCloseTimer = null;
                    }, msToClose);
                }
            }
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
                this.dailyTrades++; this.dailyPnl += r.netPnlU;
                this.totalTrades++; this.totalPnl += r.netPnlU;
                const emoji = r.netPnlU > 0 ? "✅" : "❌";
                await notifyTG(
                    `${emoji} *ETH 平仓*\n${r.reason}\n` +
                    `净PnL: ${r.netPnlU >= 0 ? "+" : ""}${r.netPnlU.toFixed(2)}U\n` +
                    `今日: ${this.dailyTrades}/${MAX_DAILY_TRADES} ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(2)}U`,
                );
            } else { await this.executor.syncPositions(); }
        }, 1000);
    }

    // ═══ Telegram ═══
    private tgCommandLoop() {
        let lastId = 0;
        setInterval(async () => {
            lastId = await pollTGCommands(lastId, {
                "1": async () => { this.paused = false; await notifyTG(`✅ *V92b 激活*`); },
                "/start": async () => { this.paused = false; await notifyTG(`✅ *V92b 激活*`); },
                "0": async () => { this.paused = true; await notifyTG("🔴 *暂停*"); },
                "/stop": async () => { this.paused = true; await notifyTG("🔴 *暂停*"); },
                "y": async () => {
                    if (this.strategy.pendingSignal) {
                        this.strategy.approveTrade();
                        await notifyTG(`✅ *确认! ${CEO_QTY}ETH 即将开单*`);
                    } else { await notifyTG("⚠️ 无待确认信号"); }
                },
                "yes": async () => {
                    if (this.strategy.pendingSignal) {
                        this.strategy.approveTrade();
                        await notifyTG(`✅ *确认! ${CEO_QTY}ETH*`);
                    } else { await notifyTG("⚠️ 无待确认信号"); }
                },
                "n": async () => { this.strategy.clearPending(); this.signalNotified = false; await notifyTG("🚫 *跳过*"); },
                "no": async () => { this.strategy.clearPending(); this.signalNotified = false; await notifyTG("🚫 *跳过*"); },
                "s": async () => { await this.sendStatus(); },
                "/status": async () => { await this.sendStatus(); },
                "r": async () => { await this.reflect(); },
                "反思": async () => { await this.reflect(); },
                "/reflect": async () => { await this.reflect(); },
                "x": async () => {
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
                "h": async () => { await notifyTG(`📖 *V92b 指令*\n1 激活 | 0 暂停\ny 确认 | n 跳过\ns 状态 | r 反思\nx 强平`); },
                "/help": async () => { await notifyTG(`📖 *V92b 指令*\n1 激活 | 0 暂停\ny 确认 | n 跳过\ns 状态 | r 反思\nx 强平`); },
            });
        }, 2000);
    }

    private async sendStatus() {
        const s = this.ws.getSnapshot();
        const b = await this.executor.getBalance();
        const upMs = Date.now() - this.startTime;
        const upH = Math.floor(upMs / 3600_000), upM = Math.floor((upMs % 3600_000) / 60_000);

        let m = `🎯 *V92b*\n──────────\n`;
        m += `💰 $${b.toFixed(2)} | ${this.paused ? "🔴暂停" : "🟢运行"} | ${upH}h${upM}m\n`;
        m += `💎 ETH $${s.ethPrice.toFixed(2)}\n`;
        m += `📋 今:${this.dailyTrades}/${MAX_DAILY_TRADES} ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(1)}U\n`;
        m += `📋 累:${this.totalTrades}单 ${this.totalPnl >= 0 ? "+" : ""}${this.totalPnl.toFixed(1)}U\n`;

        if (this.executor.inPosition) {
            const prec = SYMBOL_PRECISION[this.executor.positionSymbol] || { qty: 1, price: 3 };
            const pnl = this.executor.positionSide === "long"
                ? s.ethPrice - this.executor.entryPrice : this.executor.entryPrice - s.ethPrice;
            m += `──────────\n`;
            m += `🔥 ETH ${this.executor.positionSide.toUpperCase()} @ $${this.executor.entryPrice.toFixed(prec.price)}\n`;
            m += `浮盈:${pnl >= 0 ? "+" : ""}${pnl.toFixed(prec.price)}pt | 保本:${this.executor.breakevenTriggered ? "✅" : "❌"}\n`;
            m += `最优:+${this.executor.bestProfitPt.toFixed(1)}pt\n`;
        }
        await notifyTG(m);
    }

    private async hourlyReport() {
        const s = this.ws.getSnapshot();
        const b = await this.executor.getBalance();
        const upH = Math.floor((Date.now() - this.startTime) / 3600_000);
        await notifyTG(
            `💓 *V92b* ${upH}h | ${this.paused ? "🔴" : "🟢"}\n` +
            `ETH $${s.ethPrice.toFixed(2)} | $${b.toFixed(2)}\n` +
            `今${this.dailyTrades}/${MAX_DAILY_TRADES} ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(1)}U`,
        );
    }

    /** 🧠 反思指令: 分析当前6重过滤状态, 3行重点回覆 */
    private async reflect() {
        try {
            // 拉最近48根1h K线
            const now = Date.now();
            const url = `${BINANCE_BASE}/api/v3/klines?symbol=ETHUSDT&interval=1h&startTime=${now - 48 * 3600000}&endTime=${now}&limit=48`;
            const res = await fetch(url);
            const data = (await res.json()) as any[][];
            const kl = data.map(k => ({ o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
            if (kl.length < 20) { await notifyTG("⚠️ K线不足"); return; }

            const n = kl.length;
            const price = kl[n - 1].c;

            // RSI14
            let g = 0, l = 0;
            for (let i = n - 14; i < n; i++) { const d = kl[i].c - kl[i - 1].c; if (d > 0) g += d; else l += -d; }
            const rsi = l === 0 ? 100 : 100 - 100 / (1 + g / 14 / (l / 14));

            // ATR14
            let atr = 0; for (let i = n - 14; i < n; i++) atr += kl[i].h - kl[i].l; atr /= 14;

            // POC(前4h)
            let maxV = 0, pocP = 0;
            for (let i = n - 4; i < n; i++) { if (kl[i].v > maxV) { maxV = kl[i].v; pocP = (kl[i].h + kl[i].l + kl[i].c) / 3; } }
            let maxV2 = 0, pocP2 = 0;
            for (let i = n - 8; i < n - 4; i++) { if (kl[i].v > maxV2) { maxV2 = kl[i].v; pocP2 = (kl[i].h + kl[i].l + kl[i].c) / 3; } }
            const pocSlope = pocP - pocP2;

            // 日振幅已用%
            const todayBars = kl.slice(-Math.min(n, 24));
            const dayHi = Math.max(...todayBars.map(k => k.h));
            const dayLo = Math.min(...todayBars.map(k => k.l));
            const dayRange = dayHi - dayLo;

            // 过去2天涨跌
            const chg48h = kl[n - 1].c - kl[Math.max(0, n - 48)].c;

            // 6重过滤状态
            const pocDir = pocSlope > 5 ? "↑多" : pocSlope < -5 ? "↓空" : "→不明";
            const rsiStatus = rsi > 60 ? "⚠️超买" : rsi < 40 ? "⚠️超卖" : "✅中性";
            const atrStatus = atr < 3 ? "⚠️太低" : "✅" + atr.toFixed(0);
            const pocChase = Math.abs(pocSlope) > 50 ? "⚠️不追" : "✅";
            const fatigue = Math.abs(chg48h) > 150 ? "⚠️疲劳" : "✅";

            // 下个窗口
            const utc8H = (new Date().getUTCHours() + 8) % 24;
            const nextWin = utc8H < 8 ? "08" : utc8H < 15 ? "15" : utc8H < 22 ? "22" : "明08";

            // 判断: 能不能做?
            const canTrade = rsi >= 40 && rsi <= 60 && atr >= 3 && Math.abs(pocSlope) <= 50 && Math.abs(chg48h) <= 150 && pocSlope !== 0;
            const action = !canTrade ? "⏸️观望" : pocSlope > 5 ? "📈做多" : "📉做空";

            // 3行重点
            const line1 = `🧠 ETH $${price.toFixed(0)} RSI=${rsi.toFixed(0)}${rsiStatus} ATR=${atrStatus}`;
            const line2 = `POC${pocDir}(${pocSlope >= 0 ? "+" : ""}${pocSlope.toFixed(0)}) ${pocChase} 48h${chg48h >= 0 ? "+" : ""}${chg48h.toFixed(0)}pt ${fatigue}`;
            const line3 = `${nextWin}窗→${action} 日振${dayRange.toFixed(0)}pt`;

            await notifyTG(`${line1}\n${line2}\n${line3}`);
        } catch (e) {
            await notifyTG(`⚠️ 反思失败: ${e}`);
        }
    }
}

const bot = new DollarprinterBot();
process.on("SIGINT", () => { log("🛑 停止"); process.exit(0); });
bot.start();
