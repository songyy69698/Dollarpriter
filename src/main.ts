/**
 * 🤖 Dollarprinter V300 订单流 AI Bot
 * ═════════════════════════════════════════════
 * Order Flow 驱动: Absorption + CVD背离 + FVG + Sweep
 * 战场标记 + 陷阱反转 + 真突破 | 150x
 */

import { BitunixWSEngine } from "./bitunix-ws";
import { Mom12Strategy } from "./strategy";
import type { Mom12Signal } from "./strategy";
import { BitunixExecutor } from "./executor";
import type { EntryContext } from "./executor";
import { MtfPocEngine } from "./mtf-poc";
import { BattlefieldMarker } from "./battlefield";
import { notifyTG, pollTGCommands, initTG } from "./telegram";
import { SelfReflector } from "./self-reflect";
import { AgentCouncil } from "./agent-council";
import {
    LEVERAGE, MAX_DAILY_TRADES, MAX_DAILY_LOSS,
    ETH_SYMBOL, SYMBOL_PRECISION, BINANCE_BASE,
    SL_MIN_PT, SL_MAX_PT,
    COUNCIL_AUTO_DAILY, COUNCIL_AUTO_UTC_HOUR, COUNCIL_DAYS,
} from "./config";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [main] ${msg}`);
}

const AUTO_TIMEOUT_MS = 180_000;   // 3分钟

class DollarprinterBot {
    private ws: BitunixWSEngine;
    private strategy: Mom12Strategy;
    private executor: BitunixExecutor;
    private mtf: MtfPocEngine;
    private battlefield: BattlefieldMarker;

    private paused = true;
    private startTime = Date.now();
    private dailyTrades = 0;
    private dailyPnl = 0;
    private totalTrades = 0;
    private totalPnl = 0;

    private signalSentTs = 0;
    private signalNotified = false;

    constructor() {
        const apiKey = process.env.BITUNIX_API_KEY || process.env.apikey || process.env.apiKey || process.env.API_KEY || "";
        const secretKey = process.env.BITUNIX_SECRET_KEY || process.env.secretkey || process.env.secretKey || process.env.SECRET_KEY || "";
        if (!apiKey || !secretKey) {
            log("🚨 [致命错误] 缺少 BITUNIX_API_KEY 或 BITUNIX_SECRET_KEY！");
            log("⚠️ 请进入 Zeabur 面板 -> Settings -> Variables，补充缺少的变量。");
            log("⏳ 进程将挂起 60 秒然后重启，避免触发 Zeabur 的极速 CrashLoopBackOff 熔断...");
            // 使用 Bun.sleep 会更好，但构造函数不能 async，故抛出异常或在 start 里拦截
            // 改进：这里不直接退出，记录为 invalidEnv，在 start() 中进行延时和退出
            this.invalidEnv = true;
        }
        this.ws = new BitunixWSEngine();
        this.strategy = new Mom12Strategy();
        this.executor = new BitunixExecutor(apiKey, secretKey);
        this.mtf = new MtfPocEngine();
        this.battlefield = new BattlefieldMarker();
    }

    private invalidEnv = false;

    async start() {
        if (this.invalidEnv) {
            await new Promise(r => setTimeout(r, 60000));
            process.exit(1);
        }
        // 🔧 启动时清理 TG 旧连接 (防409)
        await initTG();

        log("════════════════════════════════════════════");
        log("  🤖 V300 订单流 AI Bot");
        log(`  📊 Absorption+CVD背离+FVG+Sweep`);
        log(`  🛡️ 战场标记+陷阱反转+真突破 | ${LEVERAGE}x`);
        log("════════════════════════════════════════════");

        this.ws.start();
        await this.waitForWS();

        const bal = await this.executor.getBalance();
        log(`  💰 余额: $${bal.toFixed(2)}`);

        // V300: 订单流 AI 引擎
        log(`  📊 V300 订单流引擎就绪`);

        await notifyTG(
            `🤖 *V300 订单流 AI Bot*\n` +
            `💰 $${bal.toFixed(2)} | ${LEVERAGE}x\n` +
            `📊 Absorption+CVD背离+FVG+Sweep\n` +
            `🎯 战场标记+陷阱反转+真突破\n` +
            `🧊 走三退一 | 亚盘12:00强平\n` +
            `发 *1* 激活 | *r* 反思`,
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
        this.battlefieldLoop();  // V300: 战场标记循环
        setInterval(() => this.hourlyReport(), 3600_000);
        setInterval(() => this.dailyReset(), 60_000);
        setInterval(() => this.dailyAutoReflect(), 60_000);

        log("🟢 V300 订单流 AI 就绪 — 发 1 激活");
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
    // 🛑 KILL SWITCH: 设为 false 停止所有交易, CEO 确认修改完成后改回 true
    private static readonly TRADING_ENABLED = true;

    private strategyLoop() {
        setInterval(async () => {
            if (!DollarprinterBot.TRADING_ENABLED) return;
            if (this.paused) return;
            if (this.executor.inPosition) return;
            if (this.dailyTrades >= MAX_DAILY_TRADES) return;
            if (this.dailyPnl <= -MAX_DAILY_LOSS) return;

            // 🧠 连亏保护: 连亏≥3笔 → 自动暂停60秒
            const refResult = SelfReflector.quickAnalyze(3);
            if (refResult.isLossStreak) {
                log(`🧠 连亏${Math.abs(refResult.streakCount)}笔, 60秒冷静期`);
                return;
            }

            // 刷新 K线数据
            await this.strategy.refreshKlines();
            const snap = this.ws.getSnapshot();

            // 检查待确认信号
            const pending = this.strategy.pendingSignal;
            if (pending) {
                if (this.strategy.ceoApproved) {
                    log(`✅ CEO 确认! ${pending.dynamicQty}ETH`);
                    await this.executeEntry(pending);
                    this.strategy.markTraded();
                    return;
                }
                if (this.signalNotified && Date.now() - this.signalSentTs >= AUTO_TIMEOUT_MS) {
                    log(`⏰ 3分钟未回 → 自动${pending.dynamicQty}ETH`);
                    await notifyTG(`⏰ *3分钟未确认 → 自动${pending.dynamicQty.toFixed(2)}ETH*`);
                    await this.executeEntry(pending);
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
            const bal = await this.executor.getBalance();
            const range = this.battlefield.getActiveRange();
            // V300: 传递 OF 快照和锚定数据给策略
            this.strategy.evaluate(
                snap,
                range,
                bal,
            );

        }, 10_000); // 每10秒检查
    }

    /** V300: 战场标记循环 (30s) */
    private battlefieldLoop() {
        setInterval(async () => {
            const mark = await this.battlefield.tick();
            if (mark) {
                await notifyTG(
                    `🎯 *战场标记* ${mark.name}\n` +
                    `H=${mark.high.toFixed(1)} L=${mark.low.toFixed(1)}\n` +
                    `VAH=${mark.vah.toFixed(1)} VAL=${mark.val.toFixed(1)}\n` +
                    `POC=${mark.poc.toFixed(1)}`,
                );
            }
        }, 30_000);
    }

    private async sendSignalNotification(sig: Mom12Signal) {
        const msg =
            `🤖 *V300 订单流*\n` +
            `──────────\n` +
            `方向: *${sig.side.toUpperCase()}* ${sig.side === "long" ? "📈做多" : "📉做空"}\n` +
            `价格: $${sig.price.toFixed(2)}\n` +
            `触发: ${sig.triggerMode === "trap" ? "🪤陷阱反转" : "🚀FVG突破"}\n` +
            `窗口: ${sig.windowName}\n` +
            `──────────\n` +
            `SL: ${sig.slPt.toFixed(1)}pt | TP: ${sig.tpPt.toFixed(1)}pt\n` +
            `仓位: ${sig.dynamicQty.toFixed(2)} ETH (Kelly)\n` +
            `──────────\n` +
            `回 *y* → 确认开单\n` +
            `3分钟不回 → 自动开`;
        await notifyTG(msg);
    }

    private windowCloseTimer: ReturnType<typeof setTimeout> | null = null;

    private async executeEntry(sig: Mom12Signal) {
        const s = this.ws.getSnapshot();
        const livePrice = s.ethPrice > 0 ? s.ethPrice : sig.price;
        const prec = SYMBOL_PRECISION[ETH_SYMBOL] || { qty: 3, price: 2 };

        // 📊 采集入场时的策略指标上下文
        const indicators = this.strategy.getIndicatorSnapshot();
        const mtfResult = this.mtf.getScore(livePrice);
        this.executor.setEntryContext({
            atr: indicators.atr,
            mtfScore: mtfResult.score,
            fundingRate: indicators.fundingRate,
            ema3: indicators.ema3,
            ema7: indicators.ema7,
            ema20: indicators.ema20,
            volRatio: indicators.volRatio,
            pocSlope: indicators.pocSlope,
        });

        await notifyTG(`🏁 *${sig.side.toUpperCase()} ETH*\n@ $${livePrice.toFixed(prec.price)} | ${sig.dynamicQty.toFixed(2)}ETH | SL=${sig.slPt.toFixed(1)} TP=${sig.tpPt.toFixed(1)}`);
        const ok = await this.executor.atomicEntry(
            sig.side, livePrice, sig.dynamicQty, ETH_SYMBOL, notifyTG,
            sig.slPt, sig.tpPt, sig.windowName,
        );
        if (ok) {
            log(`✅ ${sig.side.toUpperCase()} ${sig.dynamicQty.toFixed(2)} ETH @ ${livePrice.toFixed(prec.price)}`);
            await notifyTG(
                `📡 *诊断*\n⏱ Entry: ${this.executor.lastEntryMs}ms | SL: ${this.executor.lastSlMs}ms\nSlip: ${this.executor.lastSlippage.toFixed(prec.price)}pt` +
                (this.executor.highSlippage ? `\n🚨 *HIGH SLIPPAGE*` : ""),
            );
            await Bun.sleep(500);
            await this.executor.syncPositions();

            // ═══ V200: 窗口收盘定时平仓 ═══
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
                            this.strategy.recordTradeResult(r.netPnlU);
                            this.strategy.clearActivePosition();
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

            // V200: 亚盘仓位 12:00 UTC+8 强制平仓
            if (this.strategy.shouldNoonForceClose()) {
                log("🕛 亚盘仓位12:00强平触发!");
                const r = await this.executor.forceCloseAll(s.ethPrice);
                if (r.ok) {
                    this.dailyTrades++; this.dailyPnl += r.netPnlU;
                    this.totalTrades++; this.totalPnl += r.netPnlU;
                    this.strategy.recordTradeResult(r.netPnlU);
                    this.strategy.clearActivePosition();
                    const emoji = r.netPnlU > 0 ? "✅" : "❌";
                    await notifyTG(
                        `${emoji} *🕛 亚盘12:00强平*\n` +
                        `净PnL: ${r.netPnlU >= 0 ? "+" : ""}${r.netPnlU.toFixed(2)}U\n` +
                        `今日: ${this.dailyTrades}/${MAX_DAILY_TRADES} ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(2)}U`,
                    );
                }
                return;
            }

            const r = await this.executor.checkPosition(s.ethPrice, s);
            if (r.closed) {
                this.dailyTrades++; this.dailyPnl += r.netPnlU;
                this.totalTrades++; this.totalPnl += r.netPnlU;
                this.strategy.recordTradeResult(r.netPnlU);
                this.strategy.clearActivePosition();
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
        let polling = false;  // 🔒 防并发锁
        setInterval(async () => {
            if (polling) return;  // 上一次还没结束，跳过
            polling = true;
            try {
                lastId = await pollTGCommands(lastId, {
                "1": async () => { this.paused = false; await notifyTG(`✅ *V200 五模组 Bot 激活*`); },
                "/start": async () => { this.paused = false; await notifyTG(`✅ *V200 五模组 Bot 激活*`); },
                "0": async () => { this.paused = true; await notifyTG("🔴 *暂停*"); },
                "/stop": async () => { this.paused = true; await notifyTG("🔴 *暂停*"); },
                "y": async () => {
                    if (this.strategy.pendingSignal) {
                        this.strategy.approveTrade();
                        await notifyTG(`✅ *确认! 即将开单*`);
                    } else { await notifyTG("⚠️ 无待确认信号"); }
                },
                "yes": async () => {
                    if (this.strategy.pendingSignal) {
                        this.strategy.approveTrade();
                        await notifyTG(`✅ *确认开单!*`);
                    } else { await notifyTG("⚠️ 无待确认信号"); }
                },
                "n": async () => { this.strategy.clearPending(); this.signalNotified = false; await notifyTG("🚫 *跳过*"); },
                "no": async () => { this.strategy.clearPending(); this.signalNotified = false; await notifyTG("🚫 *跳过*"); },
                "s": async () => { await this.sendStatus(); },
                "/status": async () => { await this.sendStatus(); },
                "r": async () => { await this.reflect(); },
                "反思": async () => { await this.reflect(); },
                "/reflect": async () => { await this.reflect(); },
                "rr": async () => { await this.deepReflect(); },
                "/deepreflect": async () => { await this.deepReflect(); },
                "x": async () => {
                    const s = this.ws.getSnapshot();
                    const r = await this.executor.forceCloseAll(s.ethPrice);
                    if (r.ok) {
                        this.dailyTrades++; this.dailyPnl += r.netPnlU;
                        this.totalTrades++; this.totalPnl += r.netPnlU;
                        this.strategy.recordTradeResult(r.netPnlU);
                        this.strategy.clearActivePosition();
                        await notifyTG(`🔴 *强平* ${r.netPnlU.toFixed(2)}U`);
                    } else { await notifyTG("⚠️ 无持仓"); }
                },
                "/close": async () => {
                    const s = this.ws.getSnapshot();
                    const r = await this.executor.forceCloseAll(s.ethPrice);
                    if (r.ok) {
                        this.dailyTrades++; this.dailyPnl += r.netPnlU;
                        this.totalTrades++; this.totalPnl += r.netPnlU;
                        this.strategy.recordTradeResult(r.netPnlU);
                        this.strategy.clearActivePosition();
                        await notifyTG(`🔴 *强平* ${r.netPnlU.toFixed(2)}U`);
                    } else { await notifyTG("⚠️ 无持仓"); }
                },
                "h": async () => { await notifyTG(`📖 *V200 指令*\n1 激活 | 0 暂停\ny 确认 | n 跳过\ns 状态 | r 反思 | rr 深度反思\nm MTF详情 | x 强平\n🏛️ council 完整辩论 | cq 快速辩论`); },
                "/help": async () => { await notifyTG(`📖 *V200 指令*\n1 激活 | 0 暂停\ny 确认 | n 跳过\ns 状态 | r 反思 | rr 深度反思\nm MTF详情 | x 强平\n🏛️ council 完整辩论 | cq 快速辩论`); },
                "m": async () => { await this.sendMtfReport(); },
                "/mtf": async () => { await this.sendMtfReport(); },
                "council": async () => { await this.runCouncil(false); },
                "/council": async () => { await this.runCouncil(false); },
                "cq": async () => { await this.runCouncil(true); },
                "t": async () => {
                    const snap = this.ws.getSnapshot();
                    if (snap.ethPrice <= 0) { await notifyTG("⚠️ 无价格数据"); return; }
                    if (this.executor.inPosition) { await notifyTG("⚠️ 已有持仓"); return; }
                    // 临时清零冷却期
                    (this.executor as any)._bootTs = 0;
                    await notifyTG(`🧪 *开仓测试* 0.1ETH LONG @ $${snap.ethPrice.toFixed(2)}`);
                    const ok = await this.executor.atomicEntry("long", snap.ethPrice, 0.1, ETH_SYMBOL, notifyTG, 20, 100, "test");
                    if (!ok) { return; }  // atomicEntry已通过onDepthFail发了详细错误
                    await notifyTG(`✅ 开仓成功! 5秒后平仓...`);
                    await Bun.sleep(5_000);
                    const snap2 = this.ws.getSnapshot();
                    const r = await this.executor.forceCloseAll(snap2.ethPrice > 0 ? snap2.ethPrice : snap.ethPrice);
                    if (r.ok) {
                        await notifyTG(`✅ *测试完成*\n净PnL: ${r.netPnlU >= 0 ? "+" : ""}${r.netPnlU.toFixed(2)}U\n开关仓流畅 ✅`);
                    } else {
                        await notifyTG("❌ 平仓失败");
                    }
                },
            });
            } finally {
                polling = false;
            }
        }, 2000);
    }

    private async sendStatus() {
        const s = this.ws.getSnapshot();
        const b = await this.executor.getBalance();
        const upMs = Date.now() - this.startTime;
        const upH = Math.floor(upMs / 3600_000), upM = Math.floor((upMs % 3600_000) / 60_000);

        let m = `🤖 *V200 五模组 Bot*\n──────────\n`;
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
            m += `浮盈:${pnl >= 0 ? "+" : ""}${pnl.toFixed(prec.price)}pt | SL:${this.executor.dynamicSlPt.toFixed(0)}pt TP:${this.executor.dynamicTpPt.toFixed(0)}pt\n`;
            m += `最优:+${this.executor.bestProfitPt.toFixed(1)}pt\n`;
        }
        await notifyTG(m);
    }

    /** 🔬 MTF 共振详情报告 */
    private async sendMtfReport() {
        const s = this.ws.getSnapshot();
        const msg = this.mtf.formatTelegram(s.ethPrice);
        await notifyTG(msg);
    }

    private async hourlyReport() {
        const s = this.ws.getSnapshot();
        const b = await this.executor.getBalance();
        const upH = Math.floor((Date.now() - this.startTime) / 3600_000);
        await notifyTG(
            `💓 *V200* ${upH}h | ${this.paused ? "🔴" : "🟢"}\n` +
            `ETH $${s.ethPrice.toFixed(2)} | $${b.toFixed(2)}\n` +
            `今${this.dailyTrades}/${MAX_DAILY_TRADES} ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(1)}U`,
        );
    }

    /** 🧠 反思指令: 市场快照 + 自身表现分析 */
    private async reflect() {
        try {
            // ═══ Part 1: 市场快照 ═══
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

            // 日振幅
            const todayBars = kl.slice(-Math.min(n, 24));
            const dayHi = Math.max(...todayBars.map(k => k.h));
            const dayLo = Math.min(...todayBars.map(k => k.l));
            const dayRange = dayHi - dayLo;

            const chg48h = kl[n - 1].c - kl[Math.max(0, n - 48)].c;

            const pocDir = pocSlope > 5 ? "↑多" : pocSlope < -5 ? "↓空" : "→不明";
            const rsiStatus = rsi > 60 ? "⚠️超买" : rsi < 40 ? "⚠️超卖" : "✅中性";
            const atrStatus = atr < 3 ? "⚠️太低" : "✅" + atr.toFixed(0);
            const pocChase = Math.abs(pocSlope) > 50 ? "⚠️不追" : "✅";
            const fatigue = Math.abs(chg48h) > 150 ? "⚠️疲劳" : "✅";

            const canTrade = rsi >= 40 && rsi <= 60 && atr >= 3 && Math.abs(pocSlope) <= 50 && Math.abs(chg48h) <= 150 && pocSlope !== 0;
            const action = !canTrade ? "⏸️观望" : pocSlope > 5 ? "📈做多" : "📉做空";

            const line1 = `🧠 ETH $${price.toFixed(0)} RSI=${rsi.toFixed(0)}${rsiStatus} ATR=${atrStatus}`;
            const line2 = `POC${pocDir}(${pocSlope >= 0 ? "+" : ""}${pocSlope.toFixed(0)}) ${pocChase} 48h${chg48h >= 0 ? "+" : ""}${chg48h.toFixed(0)}pt ${fatigue}`;
            const line3 = `日振${dayRange.toFixed(0)}pt → ${action}`;

            // ═══ Part 2: 自身表现 ═══
            const selfResult = SelfReflector.quickAnalyze(7);

            // 合并输出: 市场 + 自身
            await notifyTG(`${line1}\n${line2}\n${line3}\n──────────\n${selfResult.report}`);
        } catch (e) {
            await notifyTG(`⚠️ 反思失败: ${e}`);
        }
    }

    /** 🧠 深度反思: 完整交易日志分析 */
    private async deepReflect() {
        try {
            const result = SelfReflector.quickAnalyze(7);
            await notifyTG(result.deepReport);
        } catch (e) {
            await notifyTG(`⚠️ 深度反思失败: ${e}`);
        }
    }

    /** 🧠 每日自动反思 (UTC 07:55 = 交易日开始前) */
    private _lastAutoReflectDate = "";
    private _lastAutoCouncilDate = "";
    private async dailyAutoReflect() {
        const now = new Date();
        const utcH = now.getUTCHours();
        const utcM = now.getUTCMinutes();
        const today = now.toISOString().slice(0, 10);

        // UTC 07:55 触发反思
        if (utcH === 7 && utcM >= 55 && utcM < 56 && today !== this._lastAutoReflectDate) {
            this._lastAutoReflectDate = today;
            log("🧠 每日自动反思触发");
            const result = SelfReflector.quickAnalyze(7);
            await notifyTG(`📅 *每日自动反思*\n${result.report}`);
        }

        // UTC 07:50 触发 Agent Council (每日自动)
        if (COUNCIL_AUTO_DAILY && utcH === COUNCIL_AUTO_UTC_HOUR && utcM >= 50 && utcM < 51 && today !== this._lastAutoCouncilDate) {
            this._lastAutoCouncilDate = today;
            log("🏛️ 每日自动 Agent Council 触发");
            await this.runCouncil(true);  // 快速版
        }
    }

    /** 🏛️ Agent Council 辩论 */
    private _councilRunning = false;
    private async runCouncil(quick: boolean) {
        if (this._councilRunning) {
            await notifyTG("⏳ Council 正在运行中，请稍候...");
            return;
        }
        this._councilRunning = true;
        try {
            await notifyTG(quick ? "⚡ *Quick Council 召开中...*" : "🏛️ *Agent Council 召开中...*");
            const result = quick
                ? await AgentCouncil.runQuickCouncil(COUNCIL_DAYS)
                : await AgentCouncil.runCouncil(COUNCIL_DAYS);
            await notifyTG(result.tgReport);
        } catch (e) {
            await notifyTG(`❌ Council 失败: ${e}`);
        } finally {
            this._councilRunning = false;
        }
    }
}

const bot = new DollarprinterBot();
process.on("SIGINT", () => { log("🛑 停止"); process.exit(0); });
bot.start();
