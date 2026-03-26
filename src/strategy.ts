/**
 * 🤖 V300 订单流 AI 策略引擎
 * ═════════════════════════════════════════════════
 * 模式一: 陷阱反转 (Trap Reversal) — 高胜率
 *   → 价格突破锚定 H/L → 吸收 + CVD背离 → M1 收回 VA → 反向
 * 模式二: FVG 真突破 (Fair Value Gap Breakout)
 *   → 大实体穿过边界 + FVG缺口 → 回踩 + 吞噬 → 掃单确认
 *
 * 风控: 凯利公式 + 2%止损 + 走三退一 + 假墙禁追
 */

import {
    ETH_SYMBOL, COOLDOWN_MS, BINANCE_BASE,
    MAX_DAILY_TRADES, LEVERAGE,
    POC_SHIFT_THRESHOLD, KELLY_MIN_TRADES, KELLY_MAX_FRACTION,
    CONSECUTIVE_WIN_LIMIT, SL_MIN_PT, SL_MAX_PT,
    TP_MIN_PT, TP_MAX_PT, TP_AVG_RANGE_MULT,
    FVG_MIN_GAP_PT, FVG_LOOKBACK_BARS, ENGULF_BODY_RATIO,
} from "./config";
import type { CausalSnapshot } from "./bitunix-ws";
import type { ActiveRange } from "./battlefield";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [strategy] ${msg}`);
}

// ═══════════════════════════════════════════════
// 信号定义
// ═══════════════════════════════════════════════

export interface Mom12Signal {
    side: "long" | "short";
    price: number;
    qty: number;
    reason: string;
    targetSymbol: string;
    windowName: string;
    momentum: number;
    volRatio: number;
    windowEndTs: number;
    slPt: number;
    tpPt: number;
    dynamicQty: number;
    // V300 技术止损参考点
    fvgLow: number;
    fvgHigh: number;
    triggerMode: "trap" | "fvg";
}

export type CausalSignal = Mom12Signal;
export type WindowSignal = Mom12Signal;

// ═══════════════════════════════════════════════
// M1 K线结构
// ═══════════════════════════════════════════════

interface K1m {
    ts: number; o: number; h: number; l: number; c: number; v: number;
}

// ═══════════════════════════════════════════════
// 凯利公式
// ═══════════════════════════════════════════════

function kellyFraction(winRate: number, avgWin: number, avgLoss: number): number {
    if (avgLoss === 0 || winRate <= 0) return 0;
    const b = avgWin / Math.abs(avgLoss);
    const p = winRate, q = 1 - p;
    const f = (b * p - q) / b;
    if (f <= 0) return 0;
    return Math.min(f, KELLY_MAX_FRACTION);
}

// ═══════════════════════════════════════════════
// 时间窗口 (V300 交易窗口)
// ═══════════════════════════════════════════════

interface TradeWindow {
    name: string;
    startH: number; endH: number; // UTC+8
    isAsian: boolean;
}

const TRADE_WINDOWS: TradeWindow[] = [
    { name: "亚盘确立",   startH: 9,  endH: 10, isAsian: true },
    { name: "规律最强",   startH: 15, endH: 16, isAsian: false },
    { name: "波动峰值A",  startH: 20, endH: 22, isAsian: false },
    { name: "波动峰值B",  startH: 22, endH: 24, isAsian: false },
];

const NOISE_ZONE_START = 8;
const NOISE_ZONE_END = 9;
const NOON_FORCE_CLOSE_H = 12;

// ═══════════════════════════════════════════════
// V300 策略引擎
// ═══════════════════════════════════════════════

export class Mom12Strategy {
    private lastTradeTs = 0;
    private scanCount = 0;
    private _pendingSignal: Mom12Signal | null = null;
    private _ceoApproved = false;
    private todayDate = "";
    private todayTradeCount = 0;

    // M1 K线缓存
    private klines1m: K1m[] = [];
    private lastFetch1mTs = 0;

    // 1h K线缓存 (均波计算)
    private klines1h: K1m[] = [];
    private lastFetch1hTs = 0;

    // 走三退一
    private consecutiveWins = 0;
    private cooldownUntilDay = "";

    // 凯利滚动统计
    private rollingWins = 0;
    private rollingTotal = 0;
    private rollingWinSum = 0;
    private rollingLossSum = 0;

    // 每窗口每天只做一次
    private usedWindowKeys = new Set<string>();

    // 亚盘仓位追踪
    private activePositionIsAsian = false;

    getScanCount() { return this.scanCount; }
    get pendingSignal() { return this._pendingSignal; }
    get ceoApproved() { return this._ceoApproved; }

    approveTrade() { this._ceoApproved = true; log("✅ CEO 确认开单!"); }
    clearPending() { this._pendingSignal = null; this._ceoApproved = false; }
    markTraded() {
        this.lastTradeTs = Date.now();
        this.todayTradeCount++;
        if (this._pendingSignal) {
            const w = TRADE_WINDOWS.find(w => w.name === this._pendingSignal?.windowName);
            this.activePositionIsAsian = w?.isAsian === true;
        }
        this.clearPending();
        log(`📋 今日已开单 ${this.todayTradeCount}/${MAX_DAILY_TRADES} | 亚盘仓:${this.activePositionIsAsian}`);
    }

    clearActivePosition() { this.activePositionIsAsian = false; }

    recordTradeResult(netPnl: number) {
        this.rollingTotal++;
        if (netPnl > 0) {
            this.rollingWins++;
            this.rollingWinSum += netPnl;
            this.consecutiveWins++;
        } else {
            this.rollingLossSum += Math.abs(netPnl);
            this.consecutiveWins = 0;
        }
        if (this.consecutiveWins >= CONSECUTIVE_WIN_LIMIT) {
            this.cooldownUntilDay = new Date().toISOString().slice(0, 10);
            this.consecutiveWins = 0;
            log("🧊 走三退一: 连赢3单，进入冷却期，本日不再开单");
        }
        const wr = this.rollingTotal > 0 ? (this.rollingWins / this.rollingTotal * 100).toFixed(0) : "0";
        log(`📊 凯利统计: ${this.rollingTotal}笔 ${wr}%胜率 | 连赢${this.consecutiveWins}`);
    }

    getIndicatorSnapshot() {
        return {
            atr: this.atr14_1h(),
            ema3: 0, ema7: 0, ema20: 0,
            fundingRate: 0,
            volRatio: 0,
            pocSlope: 0,
        };
    }

    /** 拉取 M1 和 1h K线 */
    async refreshKlines() {
        const now = Date.now();

        // 每 15s 刷新 M1 K线
        if (now - this.lastFetch1mTs > 15_000) {
            this.lastFetch1mTs = now;
            try {
                const start = now - 60 * 60_000; // 最近60分钟
                const url = `${BINANCE_BASE}/api/v3/klines?symbol=ETHUSDT&interval=1m&startTime=${start}&endTime=${now}&limit=60`;
                const res = await fetch(url);
                if (res.ok) {
                    const raw = await res.json() as any[];
                    this.klines1m = raw.map((k: any) => ({
                        ts: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
                    }));
                }
            } catch (e) { log(`❌ M1 K线异常: ${e}`); }
        }

        // 每 60s 刷新 1h K线
        if (now - this.lastFetch1hTs > 60_000) {
            this.lastFetch1hTs = now;
            try {
                const start = now - 48 * 3600000;
                const url = `${BINANCE_BASE}/api/v3/klines?symbol=ETHUSDT&interval=1h&startTime=${start}&endTime=${now}&limit=48`;
                const res = await fetch(url);
                if (res.ok) {
                    const raw = await res.json() as any[];
                    this.klines1h = raw.map((k: any) => ({
                        ts: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
                    }));
                }
            } catch (e) { log(`❌ 1h K线异常: ${e}`); }
        }
    }

    // ═══════════════════════════════════════════════
    // 指标计算
    // ═══════════════════════════════════════════════

    /** ATR(14) on 1h */
    private atr14_1h(): number {
        const n = this.klines1h.length;
        if (n < 16) return 30;
        let s = 0;
        for (let i = n - 15; i < n - 1; i++) s += this.klines1h[i].h - this.klines1h[i].l;
        return s / 14;
    }

    /** H1 平均波幅 (最近14根) */
    private avgH1Range(): number {
        if (this.klines1h.length < 14) return 30;
        const recent = this.klines1h.slice(-14);
        return recent.reduce((s, k) => s + (k.h - k.l), 0) / 14;
    }

    /** M1 均量 (最近20根) */
    private avgVol1m(): number {
        const n = this.klines1m.length;
        if (n < 21) return 0;
        let s = 0;
        for (let i = n - 21; i < n - 1; i++) s += this.klines1m[i].v;
        return s / 20;
    }

    // ═══════════════════════════════════════════════
    // V300 进场模式 A: 陷阱反转 (Trap Reversal)
    // ═══════════════════════════════════════════════

    private detectTrapReversal(
        snap: CausalSnapshot,
        range: ActiveRange,
    ): { side: "long" | "short"; reason: string } | null {
        if (this.klines1m.length < 5) return null;
        const price = snap.ethPrice;
        const curr = this.klines1m[this.klines1m.length - 1];

        // 条件1: 价格曾突破锚定 High/Low 边界
        const brokeHigh = price > range.high || curr.h > range.high;
        const brokeLow = price < range.low || curr.l < range.low;
        if (!brokeHigh && !brokeLow) return null;

        // 条件2: 检测吸收 (Absorption) — 大量主动单但价格停止位移
        if (!snap.ethAbsorption) return null;

        // 条件3: CVD 背离 — 价格创高但 CVD 未创高 (或反之)
        // 从 WS 快照直接获取 CVD 数据
        // CVD 背离通过 getCVDData().divergeHigh/divergeLow 实现
        // 此处用 ethBigCVD 做近似判断
        let hasCVDDiverge = false;
        if (brokeHigh && snap.ethAbsorptionSide === "buy") {
            // 买方吸收 (价格在高位): 大量买单打进但价格不涨 → 做空信号
            hasCVDDiverge = true;
        }
        if (brokeLow && snap.ethAbsorptionSide === "sell") {
            // 卖方吸收 (价格在低位): 大量卖单打进但价格不跌 → 做多信号
            hasCVDDiverge = true;
        }
        if (!hasCVDDiverge) return null;

        // 条件4: M1 实体收回 VA 区间内
        const closedInVA = curr.c >= range.val && curr.c <= range.vah;
        if (!closedInVA) return null;

        // 信号判定
        if (brokeHigh && curr.c < range.high) {
            // 突破高点后收回 → 做空 (陷阱多头)
            return {
                side: "short",
                reason: `🪤 陷阱反转做空 | 破H=${range.high.toFixed(1)} 收回VA | 吸收=${snap.ethAbsorptionSide}`,
            };
        }
        if (brokeLow && curr.c > range.low) {
            // 突破低点后收回 → 做多 (陷阱空头)
            return {
                side: "long",
                reason: `🪤 陷阱反转做多 | 破L=${range.low.toFixed(1)} 收回VA | 吸收=${snap.ethAbsorptionSide}`,
            };
        }

        return null;
    }

    // ═══════════════════════════════════════════════
    // V300 进场模式 B: FVG 真突破
    // ═══════════════════════════════════════════════

    private detectFVGBreakout(
        snap: CausalSnapshot,
        range: ActiveRange,
    ): { side: "long" | "short"; reason: string; fvgLow: number; fvgHigh: number } | null {
        const n = this.klines1m.length;
        if (n < FVG_LOOKBACK_BARS + 2) return null;

        // 搜索最近 FVG
        for (let i = n - 2; i >= n - FVG_LOOKBACK_BARS; i--) {
            if (i < 1) break;
            const prev = this.klines1m[i - 1];
            const curr = this.klines1m[i];
            const next = i + 1 < n ? this.klines1m[i + 1] : null;

            // 多头 FVG: 前一根高点 < 后一根低点 (留下向上缺口)
            if (next && prev.h < next.l && (next.l - prev.h) >= FVG_MIN_GAP_PT) {
                const bodyR = Math.abs(curr.c - curr.o) / (curr.h - curr.l + 0.01);
                const isBullish = curr.c > curr.o && bodyR >= ENGULF_BODY_RATIO;

                // 确认: 大实体突破 + 穿过锚定边界
                if (isBullish && curr.c > range.high) {
                    // 等回踩 FVG
                    const latestBar = this.klines1m[n - 1];
                    const fvgLow = prev.h;
                    const fvgHigh = next.l;

                    // 回踩 FVG 区域
                    if (latestBar.l <= fvgHigh && latestBar.l >= fvgLow) {
                        // 吞噬确认: 最新 bar 实体覆盖回测 bar
                        const engulfBody = Math.abs(latestBar.c - latestBar.o);
                        const engulfRange = latestBar.h - latestBar.l;
                        if (engulfBody / (engulfRange + 0.01) >= ENGULF_BODY_RATIO && latestBar.c > latestBar.o) {
                            // 掃单验证
                            if (snap.ethSweep && snap.ethSweepSide === "buy") {
                                return {
                                    side: "long",
                                    reason: `🚀 FVG真突破做多 | GAP=${(fvgHigh - fvgLow).toFixed(1)}pt | 掃单确认 | 回踩吞噬✅`,
                                    fvgLow,
                                    fvgHigh,
                                };
                            }
                        }
                    }
                }
            }

            // 空头 FVG: 前一根低点 > 后一根高点 (留下向下缺口)
            if (next && prev.l > next.h && (prev.l - next.h) >= FVG_MIN_GAP_PT) {
                const bodyR = Math.abs(curr.c - curr.o) / (curr.h - curr.l + 0.01);
                const isBearish = curr.c < curr.o && bodyR >= ENGULF_BODY_RATIO;

                if (isBearish && curr.c < range.low) {
                    const latestBar = this.klines1m[n - 1];
                    const fvgLow = next.h;
                    const fvgHigh = prev.l;

                    if (latestBar.h >= fvgLow && latestBar.h <= fvgHigh) {
                        const engulfBody = Math.abs(latestBar.c - latestBar.o);
                        const engulfRange = latestBar.h - latestBar.l;
                        if (engulfBody / (engulfRange + 0.01) >= ENGULF_BODY_RATIO && latestBar.c < latestBar.o) {
                            if (snap.ethSweep && snap.ethSweepSide === "sell") {
                                return {
                                    side: "short",
                                    reason: `💥 FVG真突破做空 | GAP=${(fvgHigh - fvgLow).toFixed(1)}pt | 掃单确认 | 回踩吞噬✅`,
                                    fvgLow,
                                    fvgHigh,
                                };
                            }
                        }
                    }
                }
            }
        }

        return null;
    }

    // ═══════════════════════════════════════════════
    // 主评估函数 (每10秒由 main.ts 调用)
    // ═══════════════════════════════════════════════

    evaluate(
        snap: CausalSnapshot,
        range: ActiveRange | null,
        balance?: number,
    ): Mom12Signal | null {
        this.scanCount++;
        const now = Date.now();
        if (now - this.lastTradeTs < COOLDOWN_MS) return null;
        if (this._pendingSignal) return null;
        if (this.klines1m.length < 10) return null;

        const utc8 = new Date(now + 8 * 3600000);
        const h = utc8.getUTCHours();
        const today = utc8.toISOString().slice(0, 10);

        // 每日重置
        if (today !== this.todayDate) {
            this.todayDate = today;
            this.todayTradeCount = 0;
            this.usedWindowKeys.clear();
            log(`📅 新日: ${today}`);
        }

        if (this.todayTradeCount >= MAX_DAILY_TRADES) return null;

        // 走三退一冷却
        if (this.cooldownUntilDay === today) {
            if (this.scanCount % 60 === 0) log("🧊 走三退一冷却中...");
            return null;
        }

        // 噪音过滤 (08-09 UTC+8)
        if (h >= NOISE_ZONE_START && h < NOISE_ZONE_END) {
            if (this.scanCount % 60 === 0) log("🔇 噪音区 08-09 UTC+8，仅记录");
            return null;
        }

        // 检查交易窗口
        let activeWindow: TradeWindow | null = null;
        for (const w of TRADE_WINDOWS) {
            if (h >= w.startH && h < w.endH) { activeWindow = w; break; }
        }
        if (!activeWindow) return null;

        // 每窗口每天只做一次
        const winKey = `${today}_${activeWindow.name}`;
        if (this.usedWindowKeys.has(winKey)) return null;

        // ═══ V300: 必须有锚定范围 ═══
        if (!range) {
            if (this.scanCount % 30 === 0) log("⏳ 等待战场标记...");
            return null;
        }

        // ═══ V300 假墙检测: 禁止追单 ═══
        if (snap.ethFakeWall) {
            if (this.scanCount % 30 === 0) log(`⚠️ 假墙检测! ${snap.ethFakeWallSide}方撤牆, 禁止追单`);
            return null;
        }

        // ═══ V300: 严禁在 VA 内部乱开单 ═══
        const price = snap.ethPrice;
        const inVA = price > range.val && price < range.vah;
        if (inVA) {
            if (this.scanCount % 30 === 0) log(`⏳ 价格在VA内 (${range.val.toFixed(0)}-${range.vah.toFixed(0)}), 等待边界`);
            return null;
        }

        // ═══ V300 双模式进场触发 ═══
        let dir: "long" | "short" | null = null;
        let reason = "";
        let triggerMode: "trap" | "fvg" = "trap";
        let fvgLow = 0, fvgHigh = 0;

        // 模式 A: 陷阱反转 (高胜率)
        const trap = this.detectTrapReversal(snap, range);
        if (trap) {
            dir = trap.side;
            reason = trap.reason;
            triggerMode = "trap";
        }

        // 模式 B: FVG 真突破
        if (!dir) {
            const fvg = this.detectFVGBreakout(snap, range);
            if (fvg) {
                dir = fvg.side;
                reason = fvg.reason;
                triggerMode = "fvg";
                fvgLow = fvg.fvgLow;
                fvgHigh = fvg.fvgHigh;
            }
        }

        if (!dir) return null;

        // ═══ 凯利公式计算仓位 ═══
        const bal = balance || 250;
        let kellyF = 0.10;
        if (this.rollingTotal >= KELLY_MIN_TRADES) {
            const wr = this.rollingWins / this.rollingTotal;
            const avgW = this.rollingWins > 0 ? this.rollingWinSum / this.rollingWins : 1;
            const avgL = (this.rollingTotal - this.rollingWins) > 0
                ? this.rollingLossSum / (this.rollingTotal - this.rollingWins) : 1;
            kellyF = kellyFraction(wr, avgW, avgL);
            if (kellyF <= 0) {
                log(`🚫 凯利禁止: 预期值为负 (${this.rollingWins}/${this.rollingTotal}胜率)`);
                return null;
            }
        }

        // ═══ 技术止损 + 2% 止损取严 ═══
        let techSL = 0;
        if (triggerMode === "fvg" && fvgLow > 0 && fvgHigh > 0) {
            // FVG 止损: 设在 FVG 起始 K 线的极值
            techSL = dir === "long"
                ? price - fvgLow + 1  // 低点下方 1 跳
                : fvgHigh - price + 1; // 高点上方 1 跳
        } else {
            // 陷阱反转止损: VAH/VAL 外侧
            techSL = dir === "long"
                ? price - range.val + 1  // VAL 下方 1 跳
                : range.vah - price + 1; // VAH 上方 1 跳
        }

        // 2% 本金止损
        const slPt2Pct = (bal * 0.02) / 1.0;
        // 取两者中较严 (较小) 的
        const slPt = Math.max(SL_MIN_PT, Math.min(techSL, slPt2Pct, SL_MAX_PT));

        // 凯利仓位
        const riskAmount = bal * kellyF;
        let qty = riskAmount / slPt;
        const maxQty = (bal * LEVERAGE) / price;
        const MAX_TRADE_QTY = 50.0; // 本地硬编码最大 50 ETH 限制
        qty = Math.max(0.1, Math.min(qty, maxQty, MAX_TRADE_QTY));
        qty = Math.floor(qty * 10) / 10;

        // ═══ TP: 30-50pt 与 H1 均波×70% 取严 ═══
        const avgRange = this.avgH1Range();
        const avgRangeTP = avgRange * TP_AVG_RANGE_MULT;
        const tpPt = Math.max(TP_MIN_PT, Math.min(avgRangeTP, TP_MAX_PT));

        // 窗口结束时间
        const endTs = new Date(now + 8 * 3600000);
        endTs.setUTCHours(activeWindow.endH, 0, 0, 0);
        const windowEndTs = endTs.getTime() - 8 * 3600000;
        const adjustedEnd = windowEndTs < now ? windowEndTs + 86400000 : windowEndTs;
        const maxHoldMs = 3 * 3600000;
        const timeoutTs = Math.min(now + maxHoldMs, adjustedEnd);

        const fullReason =
            `🤖 V300 ${dir === "long" ? "📈做多" : "📉做空"} | ` +
            `锚: ${range.anchorName} | ${reason} | ` +
            `SL=${slPt.toFixed(0)}pt TP=${tpPt.toFixed(0)}pt | ` +
            `Kelly=${(kellyF * 100).toFixed(0)}% ${qty.toFixed(1)}ETH`;

        this.usedWindowKeys.add(winKey);

        const signal: Mom12Signal = {
            side: dir,
            price,
            qty,
            reason: fullReason,
            targetSymbol: ETH_SYMBOL,
            windowName: activeWindow.name,
            momentum: range.pocDir === "long" ? 1 : range.pocDir === "short" ? -1 : 0,
            volRatio: 0,
            windowEndTs: timeoutTs,
            slPt,
            tpPt,
            dynamicQty: qty,
            fvgLow,
            fvgHigh,
            triggerMode,
        };

        this._pendingSignal = signal;
        this._ceoApproved = false;
        log(fullReason);
        return signal;
    }

    /** 检查亚盘仓位是否需要 12:00 UTC+8 强制平仓 */
    shouldNoonForceClose(): boolean {
        if (!this.activePositionIsAsian) return false;
        const h = new Date(Date.now() + 8 * 3600000).getUTCHours();
        return h >= NOON_FORCE_CLOSE_H;
    }

    /** 获取当前策略版本 */
    getVersion(): string { return "V300 订单流 AI Bot"; }
}

export { Mom12Strategy as CausalStrategy };
export { Mom12Strategy as WindowStrategy };
