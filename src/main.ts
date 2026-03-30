/**
 * 🤖 Dollarprinter V3 — Order Flow AI Bot
 * ═══════════════════════════════════════════════
 * 11-Gate Chain + 4-Layer Signal Audit
 * 4H Observer + Resonance 5/7 + Trap Reversal
 * Bitunix ETHUSDT | 150x Max
 */

import { BitunixWSEngine } from "./bitunix-ws";
import { BitunixExecutor } from "./executor";
import { notifyTG, pollTGCommands, initTG } from "./telegram";
import { ETHOrderFlowBot, Direction, type TickInput } from "./v3-strategy";
import {
    LEVERAGE, MAX_DAILY_TRADES, MAX_DAILY_LOSS,
    ETH_SYMBOL, SYMBOL_PRECISION, BINANCE_BASE,
} from "./config";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [main] ${msg}`);
}

class DollarprinterBot {
    private ws: BitunixWSEngine;
    private executor: BitunixExecutor;
    private bot: ETHOrderFlowBot;

    private paused = true;
    private startTime = Date.now();
    private dailyTrades = 0;
    private dailyPnl = 0;
    private totalTrades = 0;
    private totalPnl = 0;
    private invalidEnv = false;

    // 信号确认
    private signalPending: string | null = null;
    private signalSentTs = 0;
    private signalNotified = false;
    private static readonly AUTO_TIMEOUT_MS = 180_000; // 3分钟

    constructor() {
        const apiKey = process.env.BITUNIX_API_KEY || process.env.apikey || process.env.API_KEY || "";
        const secretKey = process.env.BITUNIX_SECRET_KEY || process.env.secretkey || process.env.SECRET_KEY || "";
        if (!apiKey || !secretKey) {
            log("🚨 缺少 BITUNIX_API_KEY 或 BITUNIX_SECRET_KEY！");
            this.invalidEnv = true;
        }
        this.ws = new BitunixWSEngine();
        this.executor = new BitunixExecutor(apiKey, secretKey);

        // V3 策略引擎
        this.bot = new ETHOrderFlowBot(10_000); // 初始资金后面会从余额同步
    }

    async start() {
        if (this.invalidEnv) {
            log("⏳ 环境变量缺失，60秒后重启...");
            await new Promise(r => setTimeout(r, 60000));
            process.exit(1);
        }

        await initTG();

        log("════════════════════════════════════════════");
        log("  🧠 V3 Order Flow Bot");
        log(`  📊 11-Gate Chain | 4H Observer | Resonance 5/7`);
        log(`  🛡️ Trap Reversal + FVG SL | ${LEVERAGE}x`);
        log("════════════════════════════════════════════");

        this.ws.start();
        await this.waitForWS();

        const bal = await this.executor.getBalance();
        this.bot.capital = bal;
        this.bot.stopLoss.capital = bal;
        log(`  💰 余额: $${bal.toFixed(2)}`);

        await notifyTG(
            `🧠 *V3 Order Flow Bot 启动*\n` +
            `💰 $${bal.toFixed(2)} | ${LEVERAGE}x\n` +
            `📊 11-Gate Chain\n` +
            `🔮 4H Observer + Resonance 5/7\n` +
            `🎯 Trap Reversal + FVG SL\n` +
            `发 *1* 激活 | *s* 状态 | *audit* 审计`,
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

        // 初始化 MTF 方向 (会从 K线数据推断)
        await this.initMTFBias();

        this.strategyLoop();
        this.positionLoop();
        this.candleLoop();
        this.tgCommandLoop();
        setInterval(() => this.hourlyReport(), 3600_000);
        setInterval(() => this.dailyReset(), 60_000);

        log("🟢 V3 Order Flow Bot 就绪 — 发 1 激活");
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

    /** 从 Binance K线推断 W/D/4H 方向 (启动时 + 每日自动更新) */
    private async initMTFBias() {
        try {
            // 周线 (4根)
            const weeklyRes = await fetch(`${BINANCE_BASE}/api/v3/klines?symbol=ETHUSDT&interval=1w&limit=4`);
            const weeklyData = (await weeklyRes.json()) as any[][];
            let weeklyDir = Direction.LONG;
            if (weeklyData.length >= 3) {
                const wCloses = weeklyData.slice(-3).map(k => +k[4]);
                weeklyDir = wCloses[2] > wCloses[0] ? Direction.LONG : Direction.SHORT;
            }

            // 日线 (7天)
            const dailyRes = await fetch(`${BINANCE_BASE}/api/v3/klines?symbol=ETHUSDT&interval=1d&limit=7`);
            const dailyData = (await dailyRes.json()) as any[][];
            let dailyDir = Direction.LONG;
            if (dailyData.length >= 3) {
                const dCloses = dailyData.slice(-3).map(k => +k[4]);
                dailyDir = dCloses[2] > dCloses[0] ? Direction.LONG : Direction.SHORT;
            }

            this.bot.storyline.updateMtf(weeklyDir, dailyDir);
            log(`📊 MTF: W=${weeklyDir} D=${dailyDir}`);
            await notifyTG(`📊 *MTF 自动更新*\nWeekly: ${weeklyDir}\nDaily: ${dailyDir}\n手动覆盖: 发 \`mtf long short\``);

            // 4H K线 (12根 = 2天)
            const h4Res = await fetch(`${BINANCE_BASE}/api/v3/klines?symbol=ETHUSDT&interval=4h&limit=12`);
            const h4Data = (await h4Res.json()) as any[][];
            for (const k of h4Data) {
                const h = +k[2], l = +k[3], c = +k[4], v = +k[5];
                this.bot.feedCandle(h, l, c);
                this.bot.fourHour.update(new Date(+k[0]), h, l, c, v);
            }
            log(`📊 4H Observer: ${h4Data.length}根K线 → bias=${this.bot.storyline.intradayBias}`);
        } catch (e) {
            log(`⚠️ MTF init 失败: ${e}`);
        }
    }

    /** V3: K线数据持续喂入 (15min Binance — 匹配策略ATR时间尺度) */
    private candleLoop() {
        // 启动时立即拉一次
        this.fetch15mCandles();
        setInterval(() => this.fetch15mCandles(), 60_000); // 每分钟检查
    }
    private _last15mTs = 0;
    private async fetch15mCandles() {
        try {
            const res = await fetch(`${BINANCE_BASE}/api/v3/klines?symbol=ETHUSDT&interval=15m&limit=3`);
            const data = (await res.json()) as any[][];
            if (data.length >= 2) {
                const k = data[data.length - 2]; // 倒数第二根(已完成)
                const ts = +k[0];
                if (ts !== this._last15mTs) {
                    this._last15mTs = ts;
                    const h = +k[2], l = +k[3], c = +k[4];
                    this.bot.feedCandle(h, l, c);
                    log(`📊 15m: H=${h.toFixed(2)} L=${l.toFixed(2)} C=${c.toFixed(2)} ATR=${this.bot.atr.atrFast.toFixed(2)}`);
                }
            }
        } catch { /* ignore */ }
    }

    // ═══ V3 策略循环 ═══
    private static readonly TRADING_ENABLED = true;

    private strategyLoop() {
        setInterval(async () => {
            if (!DollarprinterBot.TRADING_ENABLED) return;
            if (this.paused) return;
            if (this.executor.inPosition) return;
            if (this.dailyTrades >= MAX_DAILY_TRADES) return;
            if (this.dailyPnl <= -MAX_DAILY_LOSS) return;

            const snap = this.ws.getSnapshot();
            if (snap.ethPrice <= 0) return;

            // 从 WS 获取 VA 数据
            const vaData = (this.ws as any).eth?.getValueArea?.() || { vah: snap.ethVAH, val: snap.ethVAL, poc: snap.ethPOC };

            // 构建 tick input — 用 WS 实时价格
            const atrBuf = Math.max(this.bot.atr.atrFast * 0.1, 0.5); // 用 ATR 的10%做瞬时H/L估算
            const tickInput: TickInput = {
                now: new Date(),
                open: snap.ethPrice, close: snap.ethPrice,
                high: snap.ethPrice + atrBuf, low: snap.ethPrice - atrBuf,
                volume: snap.ethAvgVol || 1,
                cvd: snap.ethCVD, poc: snap.ethPOC,
                vah: vaData.vah || snap.ethVAH || 0,
                val: vaData.val || snap.ethVAL || 0,
                absorptionDetected: snap.ethAbsorption,
                absorptionSide: snap.ethAbsorptionSide,
            };

            // RAW data debug
            log(`RAW: o=${tickInput.open.toFixed(2)} h=${tickInput.high.toFixed(2)} l=${tickInput.low.toFixed(2)} c=${tickInput.close.toFixed(2)} cvd=${tickInput.cvd.toFixed(1)} poc=${tickInput.poc.toFixed(2)} vah=${tickInput.vah.toFixed(2)} val=${tickInput.val.toFixed(2)}`);

            // 运行 V3 tick
            const result = this.bot.tick(tickInput);

            // 记录 gate chain 到控制台
            const gc = this.bot.lastGateChain;
            if (gc) {
                const passGates = gc.gates.filter(g => g.result === "pass").length;
                const rej = gc.gates.find(g => g.result === "reject");
                if (rej) {
                    // 只在新的 rejection 原因时打印，避免刷屏
                    log(`🔗 ${passGates}/${gc.gates.length} → ${rej.gateName}: ${rej.reason}`);
                }
            }

            if (!result) return;

            // 处理 ENTRY 信号
            if (result.startsWith("ENTRY:") || result.startsWith("[PAPER] ENTRY:")) {
                const trade = this.bot.activeTrade!;
                if (trade.isPaper) {
                    // Paper trade — 只记录不下单
                    await notifyTG(`📝 *[PAPER] ${trade.direction} ETH*\n@ $${snap.ethPrice.toFixed(2)} | SL=${trade.stopLoss.toFixed(2)}\nPhase: ${this.bot.coldStart.phase}`);
                    this.bot.closeTrade(snap.ethPrice, 0); // 模拟平仓
                    return;
                }

                // 真实信号 → 发 TG 等待确认
                const prec = SYMBOL_PRECISION[ETH_SYMBOL] || { qty: 3, price: 2 };
                const qty = Math.max(0.1, Math.floor(trade.size * 10) / 10);
                const msg =
                    `🧠 *V3 Order Flow*\n` +
                    `──────────\n` +
                    `方向: *${trade.direction}* ${trade.direction === "LONG" ? "📈做多" : "📉做空"}\n` +
                    `价格: $${snap.ethPrice.toFixed(prec.price)}\n` +
                    `触发: 🪤 Trap Reversal\n` +
                    `窗口: ${trade.windowName}\n` +
                    `──────────\n` +
                    `SL: $${trade.stopLoss.toFixed(prec.price)}\n` +
                    `仓位: ${qty} ETH | ${trade.leverageUsed.toFixed(1)}x\n` +
                    `Tier: ${this.bot.stopLoss.getCurrentTier().name}\n` +
                    `──────────\n` +
                    `回 *y* → 确认 | 3分钟不回 → 自动`;
                await notifyTG(msg);
                this.signalPending = result;
                this.signalSentTs = Date.now();
                this.signalNotified = true;
                return;
            }

            // 处理待确认信号超时
            if (this.signalNotified && this.signalPending && this.bot.activeTrade) {
                if (Date.now() - this.signalSentTs >= DollarprinterBot.AUTO_TIMEOUT_MS) {
                    log("⏰ 3分钟未回 → 自动开单");
                    await notifyTG("⏰ *3分钟未确认 → 自动开单*");
                    await this.executeV3Entry();
                }
            }
        }, 10_000);
    }

    /** 执行 V3 入场 */
    private async executeV3Entry() {
        const trade = this.bot.activeTrade;
        if (!trade) return;

        const snap = this.ws.getSnapshot();
        const livePrice = snap.ethPrice > 0 ? snap.ethPrice : trade.entryPrice;
        const prec = SYMBOL_PRECISION[ETH_SYMBOL] || { qty: 3, price: 2 };
        const qty = Math.max(0.1, Math.floor(trade.size * 10) / 10);
        const side = trade.direction === Direction.LONG ? "long" : "short";
        const slPt = Math.abs(livePrice - trade.stopLoss);
        const tpPt = slPt * 3; // RR 1:3

        await notifyTG(`🏁 *${side.toUpperCase()} ETH*\n@ $${livePrice.toFixed(prec.price)} | ${qty}ETH | SL=${slPt.toFixed(1)}pt`);
        const ok = await this.executor.atomicEntry(side, livePrice, qty, ETH_SYMBOL, notifyTG, slPt, tpPt, trade.windowName);

        if (ok) {
            log(`✅ ${side.toUpperCase()} ${qty} ETH @ ${livePrice.toFixed(prec.price)}`);
            await notifyTG(`📡 *诊断*\n⏱ ${this.executor.lastEntryMs}ms | Slip: ${this.executor.lastSlippage.toFixed(prec.price)}pt`);
            await Bun.sleep(500);
            await this.executor.syncPositions();
        }

        this.signalPending = null;
        this.signalNotified = false;
    }

    // ═══ 仓位管理 ═══
    private positionLoop() {
        setInterval(async () => {
            if (!this.executor.inPosition) return;
            const s = this.ws.getSnapshot();
            if (s.ethPrice <= 0) return;

            // V3: 检查策略层强平信号
            if (this.bot.activeTrade) {
                const tickResult = this.bot.tick({
                    now: new Date(), open: s.ethPrice, close: s.ethPrice,
                    high: s.ethPrice, low: s.ethPrice,
                    volume: 0, cvd: s.ethCVD, poc: s.ethPOC,
                    vah: s.ethVAH, val: s.ethVAL,
                    absorptionDetected: s.ethAbsorption, absorptionSide: s.ethAbsorptionSide,
                });
                if (tickResult && tickResult.startsWith("CLOSE:")) {
                    log(`🧠 V3 强平: ${tickResult}`);
                    const r = await this.executor.forceCloseAll(s.ethPrice);
                    if (r.ok) {
                        this.dailyTrades++; this.dailyPnl += r.netPnlU;
                        this.totalTrades++; this.totalPnl += r.netPnlU;
                        this.bot.closeTrade(s.ethPrice, r.netPnlU);
                        const emoji = r.netPnlU > 0 ? "✅" : "❌";
                        await notifyTG(`${emoji} *V3 ${tickResult}*\n净PnL: ${r.netPnlU >= 0 ? "+" : ""}${r.netPnlU.toFixed(2)}U`);
                    }
                    return;
                }
            }

            // Executor 层出场检查 (硬SL, Climax, TP, 3H时效)
            const r = await this.executor.checkPosition(s.ethPrice, s);
            if (r.closed) {
                this.dailyTrades++; this.dailyPnl += r.netPnlU;
                this.totalTrades++; this.totalPnl += r.netPnlU;
                this.bot.closeTrade(s.ethPrice, r.netPnlU);
                const emoji = r.netPnlU > 0 ? "✅" : "❌";
                await notifyTG(
                    `${emoji} *ETH 平仓*\n${r.reason}\n` +
                    `净PnL: ${r.netPnlU >= 0 ? "+" : ""}${r.netPnlU.toFixed(2)}U\n` +
                    `今日: ${this.dailyTrades}/${MAX_DAILY_TRADES} ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(2)}U`,
                );
            } else { await this.executor.syncPositions(); }
        }, 1000);
    }

    // ═══ Telegram 指令 ═══
    private tgCommandLoop() {
        let lastId = 0;
        let polling = false;
        setInterval(async () => {
            if (polling) return;
            polling = true;
            try {
                const cmdHandlers: Record<string, () => Promise<void>> = {
                    "1": async () => { this.paused = false; await notifyTG(`✅ *V3 Order Flow Bot 激活*`); },
                    "/start": async () => { this.paused = false; await notifyTG(`✅ *V3 Order Flow Bot 激活*`); },
                    "0": async () => { this.paused = true; await notifyTG("🔴 *暂停*"); },
                    "/stop": async () => { this.paused = true; await notifyTG("🔴 *暂停*"); },
                    "y": async () => {
                        if (this.signalPending && this.bot.activeTrade) {
                            await notifyTG(`✅ *确认! 即将开单*`);
                            await this.executeV3Entry();
                        } else { await notifyTG("⚠️ 无待确认信号"); }
                    },
                    "yes": async () => {
                        if (this.signalPending && this.bot.activeTrade) {
                            await notifyTG(`✅ *确认开单!*`);
                            await this.executeV3Entry();
                        } else { await notifyTG("⚠️ 无待确认信号"); }
                    },
                    "n": async () => { this.signalPending = null; this.signalNotified = false; if (this.bot.activeTrade) this.bot.closeTrade(0, 0); await notifyTG("🚫 *跳过*"); },
                    "no": async () => { this.signalPending = null; this.signalNotified = false; if (this.bot.activeTrade) this.bot.closeTrade(0, 0); await notifyTG("🚫 *跳过*"); },
                    "s": async () => { await this.sendStatus(); },
                    "/status": async () => { await this.sendStatus(); },
                    "audit": async () => { await notifyTG(this.bot.audit.report()); },
                    "/audit": async () => { await notifyTG(this.bot.audit.report()); },
                    "res": async () => { await this.sendResonanceDetail(); },
                    "/res": async () => { await this.sendResonanceDetail(); },
                    "x": async () => {
                        const s = this.ws.getSnapshot();
                        const r = await this.executor.forceCloseAll(s.ethPrice);
                        if (r.ok) {
                            this.dailyTrades++; this.dailyPnl += r.netPnlU;
                            this.totalTrades++; this.totalPnl += r.netPnlU;
                            this.bot.closeTrade(s.ethPrice, r.netPnlU);
                            await notifyTG(`🔴 *强平* ${r.netPnlU.toFixed(2)}U`);
                        } else { await notifyTG("⚠️ 无持仓"); }
                    },
                    "/close": async () => {
                        const s = this.ws.getSnapshot();
                        const r = await this.executor.forceCloseAll(s.ethPrice);
                        if (r.ok) {
                            this.dailyTrades++; this.dailyPnl += r.netPnlU;
                            this.totalTrades++; this.totalPnl += r.netPnlU;
                            this.bot.closeTrade(s.ethPrice, r.netPnlU);
                            await notifyTG(`🔴 *强平* ${r.netPnlU.toFixed(2)}U`);
                        } else { await notifyTG("⚠️ 无持仓"); }
                    },
                    "mtf": async () => {
                        const s = this.bot.storyline;
                        await notifyTG(`📊 *MTF 方向*\nWeekly: ${s.weeklyDirection}\nDaily: ${s.dailyDirection}\n4H: ${s.intradayBias}\nBias: ${s.getBias()}\n──────────\n手动覆盖: 发 \`mtf long short\``);
                    },
                    "h": async () => { await notifyTG(`📖 *V3 指令*\n1 激活 | 0 暂停\ny 确认 | n 跳过\ns 状态 | audit 审计\nres 共振详情 | mtf 方向\nx 强平 | t 测试\nmtf long short 手动W/D`); },
                    "/help": async () => { await notifyTG(`📖 *V3 指令*\n1 激活 | 0 暂停\ny 确认 | n 跳过\ns 状态 | audit 审计\nres 共振详情 | mtf 方向\nx 强平 | t 测试\nmtf long short 手动W/D`); },
                    "t": async () => {
                        const snap = this.ws.getSnapshot();
                        if (snap.ethPrice <= 0) { await notifyTG("⚠️ 无价格"); return; }
                        if (this.executor.inPosition) { await notifyTG("⚠️ 已有持仓"); return; }
                        (this.executor as any)._bootTs = 0;
                        await notifyTG(`🧪 *开仓测试* 0.1ETH LONG @ $${snap.ethPrice.toFixed(2)}`);
                        const ok = await this.executor.atomicEntry("long", snap.ethPrice, 0.1, ETH_SYMBOL, notifyTG, 20, 100, "test");
                        if (!ok) return;
                        await notifyTG(`✅ 开仓成功! 5秒后平仓...`);
                        await Bun.sleep(5_000);
                        const s2 = this.ws.getSnapshot();
                        const r = await this.executor.forceCloseAll(s2.ethPrice > 0 ? s2.ethPrice : snap.ethPrice);
                        if (r.ok) await notifyTG(`✅ *测试完成*\n净PnL: ${r.netPnlU >= 0 ? "+" : ""}${r.netPnlU.toFixed(2)}U`);
                        else await notifyTG("❌ 平仓失败");
                    },
                    "_catchAll": async () => {
                        const txt = ((cmdHandlers as any)._rawText || "") as string;
                        await this.handleFlexCommand(txt);
                    },
                };
                lastId = await pollTGCommands(lastId, cmdHandlers);
            } finally { polling = false; }
        }, 2000);
    }

    private async sendStatus() {
        const s = this.ws.getSnapshot();
        const b = await this.executor.getBalance();
        const upMs = Date.now() - this.startTime;
        const upH = Math.floor(upMs / 3600_000), upM = Math.floor((upMs % 3600_000) / 60_000);

        const v3Status = this.bot.statusTG();
        let m = v3Status + `\n──────────\n`;
        m += `💰 $${b.toFixed(2)} | ${this.paused ? "🔴暂停" : "🟢运行"} | ${upH}h${upM}m\n`;
        m += `💎 ETH $${s.ethPrice.toFixed(2)}\n`;
        m += `📋 今:${this.dailyTrades}/${MAX_DAILY_TRADES} ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(1)}U\n`;
        m += `📋 累:${this.totalTrades}单 ${this.totalPnl >= 0 ? "+" : ""}${this.totalPnl.toFixed(1)}U`;

        if (this.executor.inPosition) {
            const prec = SYMBOL_PRECISION[this.executor.positionSymbol] || { qty: 1, price: 3 };
            const pnl = this.executor.positionSide === "long"
                ? s.ethPrice - this.executor.entryPrice : this.executor.entryPrice - s.ethPrice;
            m += `\n──────────\n`;
            m += `🔥 ETH ${this.executor.positionSide.toUpperCase()} @ $${this.executor.entryPrice.toFixed(prec.price)}\n`;
            m += `浮盈:${pnl >= 0 ? "+" : ""}${pnl.toFixed(prec.price)}pt`;
        }
        await notifyTG(m);
    }

    /** 共振7维详情 (对应 Python 蓝图的 resonance detail) */
    private async sendResonanceDetail() {
        const rs = this.bot.resonance.current;
        if (!rs) { await notifyTG("⚠️ 共振尚未评估（等待第一次15min周期）"); return; }
        let m = `🔮 *Resonance ${rs.confirmCount}/${rs.threshold}* ${rs.passed ? "✅ PASS" : "❌ FAIL"}\n`;
        m += `方向: ${rs.direction}\n──────────\n`;
        for (const d of rs.dimensions) {
            const icon = d.score === 1 ? "✅" : d.score === -1 ? "❌" : "⚪";
            m += `${icon} \`${d.name}\`\n    ${d.detail}\n`;
        }
        m += `──────────\nTotal: ${rs.totalScore} | ${rs.confirmCount}/7 confirmed`;
        await notifyTG(m);
    }

    /** 灵活指令处理 (mtf long short, etc) */
    private async handleFlexCommand(txt: string) {
        // mtf <weekly> <daily>
        const mtfMatch = txt.match(/^mtf\s+(long|short)\s+(long|short)$/i);
        if (mtfMatch) {
            const weekly = mtfMatch[1].toUpperCase() === "LONG" ? Direction.LONG : Direction.SHORT;
            const daily = mtfMatch[2].toUpperCase() === "LONG" ? Direction.LONG : Direction.SHORT;
            this.bot.storyline.updateMtf(weekly, daily);
            log(`📊 MTF 手动覆盖: W=${weekly} D=${daily}`);
            await notifyTG(`📊 *MTF 手动设置*\nWeekly: ${weekly}\nDaily: ${daily}\nBias: ${this.bot.storyline.getBias()}`);
            return;
        }
        // 未识别
        log(`❓ 未知指令: "${txt}"`);
    }

    private _lastMtfUpdateDate = "";
    private dailyReset() {
        const dt = new Date();
        const h = (dt.getUTCHours() + 8) % 24, m = dt.getUTCMinutes();
        if (h === 0 && m === 0) {
            this.dailyTrades = 0; this.dailyPnl = 0;
            this.bot.kelly.resetDaily();
            log("📅 日重置");
        }
        // 每日 00:05 UTC+8 自动更新 MTF 方向
        const today = dt.toISOString().slice(0, 10);
        if (h === 0 && m >= 5 && m < 6 && today !== this._lastMtfUpdateDate) {
            this._lastMtfUpdateDate = today;
            log("📊 每日自动 MTF 更新触发");
            this.initMTFBias().catch(e => log(`⚠️ 自动 MTF 更新失败: ${e}`));
        }
    }

    private async hourlyReport() {
        const s = this.ws.getSnapshot();
        const b = await this.executor.getBalance();
        const upH = Math.floor((Date.now() - this.startTime) / 3600_000);
        await notifyTG(
            `💓 *V3* ${upH}h | ${this.paused ? "🔴" : "🟢"}\n` +
            `ETH $${s.ethPrice.toFixed(2)} | $${b.toFixed(2)}\n` +
            `今${this.dailyTrades}/${MAX_DAILY_TRADES} ${this.dailyPnl >= 0 ? "+" : ""}${this.dailyPnl.toFixed(1)}U`,
        );
    }
}

const bot = new DollarprinterBot();
process.on("SIGINT", () => { log("🛑 停止"); process.exit(0); });
bot.start();

// 🌐 Zeabur Health Check
const port = process.env.PORT || 8080;
Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch(_req: Request) {
        return new Response("V3 Order Flow Bot is Alive! 🧠💚", { status: 200 });
    },
});
log(`🌐 Health check on 0.0.0.0:${port}`);
