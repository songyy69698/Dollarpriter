/**
 * 🤖 V200 五模组 Bot 策略引擎
 * ═════════════════════════════════════════════════
 * 模组一: 时间过滤器 (H4循环 + 3窗口 + 亚盘强制平仓)
 * 模组二: SVP环境感知 (POC位移 + 定性定量K线)
 * 模组三: 进场触发 (攻击日 + 引线回补 + 支撑测试)
 * 模组四: 执行效能 (3小时时效律 + 均波70%止盈)
 * 模组五: 风险管理 (凯利公式 + 2%止损 + 走三退一)
 *
 * 替换 V104 Fire Candle → 五模组回测验证策略
 */

import {
    ETH_SYMBOL, COOLDOWN_MS, BINANCE_BASE,
    MAX_DAILY_TRADES, LEVERAGE,
} from "./config";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [strategy] ${msg}`);
}

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
}

export type CausalSignal = Mom12Signal;
export type WindowSignal = Mom12Signal;

// ═══════════════════════════════════════════════════
// 模组一: 时间过滤器 (UTC+8 时区)
// ═══════════════════════════════════════════════════

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

const NOISE_ZONE_START = 8;   // UTC+8 08:00 噪音区开始
const NOISE_ZONE_END = 9;     // UTC+8 09:00 噪音区结束
// V200: 亚盘仓位 12:00 UTC+8 强制平仓标记
const NOON_FORCE_CLOSE_H = 12; // UTC+8 12:00

// ═══════════════════════════════════════════════════
// 模组二: POC 位移 + 定性定量 K 线
// ═══════════════════════════════════════════════════

interface K1h {
    ts: number; o: number; h: number; l: number; c: number; v: number;
}

// ═══════════════════════════════════════════════════
// 模组五: 凯利公式
// ═══════════════════════════════════════════════════

function kellyFraction(winRate: number, avgWin: number, avgLoss: number): number {
    if (avgLoss === 0 || winRate <= 0) return 0;
    const b = avgWin / Math.abs(avgLoss);
    const p = winRate, q = 1 - p;
    const f = (b * p - q) / b;
    if (f <= 0) return 0;
    return Math.min(f, 0.25); // 上限 25%
}

export class Mom12Strategy {
    private lastTradeTs = 0;
    private scanCount = 0;
    private _pendingSignal: Mom12Signal | null = null;
    private _ceoApproved = false;
    private todayDate = "";
    private todayTradeCount = 0;

    // 4h K线缓存 (POC方向)
    private klines4h: K1h[] = [];
    private lastFetch4hTs = 0;

    // 1h K线缓存 (均波计算)
    private klines1h: K1h[] = [];
    private lastFetch1hTs = 0;

    // 5m K线缓存
    private klines: K1h[] = [];
    private lastFetchTs = 0;

    // 模组五: 走三退一
    private consecutiveWins = 0;
    private cooldownUntilDay = "";

    // 模组五: 凯利滚动统计
    private rollingWins = 0;
    private rollingTotal = 0;
    private rollingWinSum = 0;
    private rollingLossSum = 0;

    // 每窗口每天只做一次
    private usedWindowKeys = new Set<string>();

    // 追踪当前活跃仓位是否为亚盘窗口
    private activePositionIsAsian = false;

    getScanCount() { return this.scanCount; }
    get pendingSignal() { return this._pendingSignal; }
    get ceoApproved() { return this._ceoApproved; }

    approveTrade() { this._ceoApproved = true; log("✅ CEO 确认开单!"); }
    clearPending() { this._pendingSignal = null; this._ceoApproved = false; }
    markTraded() {
        this.lastTradeTs = Date.now();
        this.todayTradeCount++;
        // 保存当前信号的亚盘标记到活跃仓位追踪
        if (this._pendingSignal) {
            const w = TRADE_WINDOWS.find(w => w.name === this._pendingSignal?.windowName);
            this.activePositionIsAsian = w?.isAsian === true;
        }
        this.clearPending();
        log(`📋 今日已开单 ${this.todayTradeCount}/${MAX_DAILY_TRADES} | 亚盘仓:${this.activePositionIsAsian}`);
    }

    /** 平仓后重置活跃仓位状态 (main.ts 平仓回调中调用) */
    clearActivePosition() {
        this.activePositionIsAsian = false;
    }

    /** 记录交易结果 (main.ts 平仓后调用，更新凯利统计 + 走三退一) */
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

        // 走三退一: 连赢3单 → 本日剩余不开单
        if (this.consecutiveWins >= 3) {
            this.cooldownUntilDay = new Date().toISOString().slice(0, 10);
            this.consecutiveWins = 0;
            log("🧊 走三退一: 连赢3单，进入冷却期，本日不再开单");
        }

        const wr = this.rollingTotal > 0 ? (this.rollingWins / this.rollingTotal * 100).toFixed(0) : "0";
        log(`📊 凯利统计: ${this.rollingTotal}笔 ${wr}%胜率 | 连赢${this.consecutiveWins}`);
    }

    /** 📊 获取当前策略指标快照 */
    getIndicatorSnapshot() {
        return {
            atr: this.atr14(),
            ema3: 0, ema7: 0, ema20: 0,
            fundingRate: 0,
            volRatio: 0,
            pocSlope: this.getPocShift(),
        };
    }

    /** 拉取 4h、1h 和 5m K线 */
    async refreshKlines() {
        const now = Date.now();

        // 每 120 秒刷新 4h K线 (POC方向)
        if (now - this.lastFetch4hTs > 120_000) {
            this.lastFetch4hTs = now;
            try {
                const start = now - 14 * 86400000; // 前14天
                const url = `${BINANCE_BASE}/api/v3/klines?symbol=ETHUSDT&interval=4h&startTime=${start}&endTime=${now}&limit=84`;
                const res = await fetch(url);
                if (res.ok) {
                    const raw = await res.json() as any[];
                    this.klines4h = raw.map((k: any) => ({
                        ts: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
                    }));
                }
            } catch (e) { log(`❌ 4h K线异常: ${e}`); }
        }

        // 每 60 秒刷新 1h K线 (均波计算)
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

        // 每 30 秒刷新 5m K线
        if (now - this.lastFetchTs > 30_000) {
            this.lastFetchTs = now;
            try {
                const start = now - 6 * 3600000;
                const url = `${BINANCE_BASE}/api/v3/klines?symbol=ETHUSDT&interval=5m&startTime=${start}&endTime=${now}&limit=72`;
                const res = await fetch(url);
                if (res.ok) {
                    const raw = await res.json() as any[];
                    this.klines = raw.map((k: any) => ({
                        ts: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
                    }));
                }
            } catch (e) { log(`❌ 5m K线异常: ${e}`); }
        }
    }

    // ═══════════════════════════════════════════════
    // 指标计算
    // ═══════════════════════════════════════════════

    /** ATR(14) on 5m */
    private atr14(): number {
        const n = this.klines.length; if (n < 16) return 0;
        let s = 0; for (let i = n - 15; i < n - 1; i++) s += this.klines[i].h - this.klines[i].l;
        return s / 14;
    }

    /** POC on one 4h bar (Volume-Weighted Typical Price) */
    private calcPOC(k: K1h): number {
        return (k.h + k.l + k.c) / 3;
    }

    /** POC 位移: 最近两根 4h 的 POC 差值 */
    private getPocShift(): number {
        if (this.klines4h.length < 2) return 0;
        const curr = this.klines4h[this.klines4h.length - 1];
        const prev = this.klines4h[this.klines4h.length - 2];
        return this.calcPOC(curr) - this.calcPOC(prev);
    }

    /** H1 平均波幅 (最近14根) */
    private avgH1Range(): number {
        if (this.klines1h.length < 14) return 30;
        const recent = this.klines1h.slice(-14);
        return recent.reduce((s, k) => s + (k.h - k.l), 0) / 14;
    }

    /** 5m 均量 (最近20根) */
    private avgVol5m(): number {
        const n = this.klines.length; if (n < 21) return 0;
        let s = 0; for (let i = n - 21; i < n - 1; i++) s += this.klines[i].v;
        return s / 20;
    }

    // ═══════════════════════════════════════════════
    // 模组三: 进场触发
    // ═══════════════════════════════════════════════

    /** 攻击日: 前根长影线 → 次根实体突破 */
    private detectAttackDay(prev: K1h, curr: K1h): "long" | "short" | null {
        const prevRange = prev.h - prev.l;
        if (prevRange < 2) return null;
        const prevUpperShadow = prev.h - Math.max(prev.o, prev.c);
        const prevLowerShadow = Math.min(prev.o, prev.c) - prev.l;
        const currBody = Math.abs(curr.c - curr.o);
        const currRange = curr.h - curr.l;

        if (prevUpperShadow / prevRange > 0.4 && curr.c < prev.l && currBody / (currRange + 0.01) > 0.5)
            return "short";
        if (prevLowerShadow / prevRange > 0.4 && curr.c > prev.h && currBody / (currRange + 0.01) > 0.5)
            return "long";
        return null;
    }

    /** 引线回补 */
    private detectWickReclaim(): "long" | "short" | null {
        const n = this.klines.length;
        if (n < 4) return null;
        const curr = this.klines[n - 1];
        const prev1 = this.klines[n - 2];
        const prev2 = this.klines[n - 3];

        const prev2LowerShadow = Math.min(prev2.o, prev2.c) - prev2.l;
        const prev2Body = Math.abs(prev2.c - prev2.o);
        if (prev2LowerShadow > prev2Body * 0.5 && prev2LowerShadow > 2) {
            const reclaimLevel = Math.min(prev2.o, prev2.c);
            if (prev1.l < prev2.l && curr.c > reclaimLevel && curr.c > curr.o)
                return "long";
        }

        const prev2UpperShadow = prev2.h - Math.max(prev2.o, prev2.c);
        if (prev2UpperShadow > prev2Body * 0.5 && prev2UpperShadow > 2) {
            const reclaimLevel = Math.max(prev2.o, prev2.c);
            if (prev1.h > prev2.h && curr.c < reclaimLevel && curr.c < curr.o)
                return "short";
        }
        return null;
    }

    /** 支撑/阻力测试次数 (替代 DOM 真假墙) */
    private detectLevelTest(): { support: number; resistance: number; supportLevel: number; resistanceLevel: number } {
        const n = this.klines.length;
        if (n < 21) return { support: 0, resistance: 0, supportLevel: 0, resistanceLevel: 0 };
        const lookback = this.klines.slice(n - 21, n - 1);
        let minL = Infinity, maxH = 0;
        for (const k of lookback) { if (k.l < minL) minL = k.l; if (k.h > maxH) maxH = k.h; }
        let st = 0, rt = 0;
        for (const k of lookback) {
            if (Math.abs(k.l - minL) < 3) st++;
            if (Math.abs(k.h - maxH) < 3) rt++;
        }
        return { support: st, resistance: rt, supportLevel: minL, resistanceLevel: maxH };
    }

    // ═══════════════════════════════════════════════
    // 主评估函数 (每10秒由 main.ts 调用)
    // ═══════════════════════════════════════════════

    evaluate(
        wsPocSlope?: number,
        balance?: number,
        bigDelta?: number,
        bigCVD?: number,
        bigRatio?: number,
    ): Mom12Signal | null {
        this.scanCount++;
        const now = Date.now();
        if (now - this.lastTradeTs < COOLDOWN_MS) return null;
        if (this._pendingSignal) return null;
        if (this.klines.length < 20) return null;
        if (this.klines4h.length < 2) return null;

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

        // 模组五: 走三退一冷却
        if (this.cooldownUntilDay === today) {
            if (this.scanCount % 60 === 0) log("🧊 走三退一冷却中...");
            return null;
        }

        // 模组一: 噪音过滤 (08-09 UTC+8)
        if (h >= NOISE_ZONE_START && h < NOISE_ZONE_END) {
            if (this.scanCount % 60 === 0) log("🔇 噪音区 08-09 UTC+8，仅记录");
            return null;
        }

        // 模组一: 检查交易窗口
        let activeWindow: TradeWindow | null = null;
        for (const w of TRADE_WINDOWS) {
            if (h >= w.startH && h < w.endH) { activeWindow = w; break; }
        }
        if (!activeWindow) return null;

        // 每窗口每天只做一次
        const winKey = `${today}_${activeWindow.name}`;
        if (this.usedWindowKeys.has(winKey)) return null;

        // ═══ 模组二: POC 位移 ═══
        const pocShift = wsPocSlope !== undefined && wsPocSlope !== 0 ? wsPocSlope : this.getPocShift();
        let dir: "long" | "short" | "" = "";
        if (pocShift > 5) dir = "long";
        else if (pocShift < -5) dir = "short";
        else {
            if (this.scanCount % 30 === 0) log(`⏳ POC无方向: ${pocShift.toFixed(1)}pt`);
            return null;
        }

        // 定性定量 K 线: 最近3根5m有大实体+放量
        const avgVol = this.avgVol5m();
        let aggressiveConfirm = false;
        for (let i = this.klines.length - 3; i < this.klines.length; i++) {
            if (i < 0) continue;
            const k = this.klines[i];
            const body = Math.abs(k.c - k.o);
            const range = k.h - k.l;
            if (range > 1 && body / range > 0.7 && k.v > avgVol * 1.5) {
                const aggDir = k.c > k.o ? "long" : "short";
                if (aggDir === dir) aggressiveConfirm = true;
                else if (aggDir !== dir) {
                    if (this.scanCount % 30 === 0) log(`⚠️ 主力方向与POC矛盾，跳过`);
                    return null;
                }
            }
        }

        // ═══ 模组三: 进场触发 ═══
        const n = this.klines.length;
        const curr = this.klines[n - 1];
        const prev = this.klines[n - 2];

        let triggered = false;
        let triggerReason = "";

        // 攻击日
        const attack = this.detectAttackDay(prev, curr);
        if (attack === dir) { triggered = true; triggerReason = "攻击日"; }

        // 引线回补
        if (!triggered) {
            const wick = this.detectWickReclaim();
            if (wick === dir) { triggered = true; triggerReason = "引线回补"; }
        }

        // 支撑/阻力测试 (替代真假墙)
        if (!triggered) {
            const levels = this.detectLevelTest();
            if (dir === "long" && levels.support >= 3 && Math.abs(curr.l - levels.supportLevel) < 5) {
                triggered = true; triggerReason = `支撑测试x${levels.support}`;
            }
            if (dir === "short" && levels.resistance >= 3 && Math.abs(curr.h - levels.resistanceLevel) < 5) {
                triggered = true; triggerReason = `阻力测试x${levels.resistance}`;
            }
        }

        if (!triggered) return null;

        // 量能确认: 当前bar量能不能太小
        if (avgVol > 0 && curr.v < avgVol * 0.8) {
            if (this.scanCount % 30 === 0) log(`⏳ 量能不足: ${(curr.v / avgVol).toFixed(1)}x < 0.8x`);
            return null;
        }

        // ═══ 模组五: 凯利公式计算仓位 ═══
        const bal = balance || 250;
        let kellyF = 0.10; // 默认 10%
        if (this.rollingTotal >= 5) {
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

        // 模组五: 2% 止损
        const slPt2Pct = (bal * 0.02) / 1.0; // 以1ETH为基准
        const slPt = Math.max(10, Math.min(slPt2Pct, 40)); // clamp [10, 40]

        // 凯利仓位
        const riskAmount = bal * kellyF;
        let qty = riskAmount / slPt;
        const maxQty = (bal * LEVERAGE) / curr.c;
        qty = Math.max(0.1, Math.min(qty, maxQty, 5.0));
        qty = Math.floor(qty * 10) / 10; // 1位小数

        // 模组四: 均波70%止盈
        const avgRange = this.avgH1Range();
        const tpPt = avgRange * 0.7;

        // 窗口结束时间
        const endTs = new Date(now + 8 * 3600000);
        endTs.setUTCHours(activeWindow.endH, 0, 0, 0);
        // 减回 UTC+8 偏移得到真实 UTC 时间
        const windowEndTs = endTs.getTime() - 8 * 3600000;
        const adjustedEnd = windowEndTs < now ? windowEndTs + 86400000 : windowEndTs;

        // 3小时时效 → 窗口结束 取较早者
        const maxHoldMs = 3 * 3600000; // 3小时
        const timeoutTs = Math.min(now + maxHoldMs, adjustedEnd);

        const price = curr.c;

        const reason =
            `🤖 V200 ${dir === "long" ? "📈做多" : "📉做空"} | ` +
            `窗: ${activeWindow.name} | 触发: ${triggerReason} | ` +
            `POC=${pocShift >= 0 ? "+" : ""}${pocShift.toFixed(0)}pt | ` +
            `SL=${slPt.toFixed(0)}pt TP=${tpPt.toFixed(0)}pt | ` +
            `Kelly=${(kellyF * 100).toFixed(0)}% ${qty.toFixed(1)}ETH`;

        this.usedWindowKeys.add(winKey);

        const signal: Mom12Signal = {
            side: dir,
            price,
            qty,
            reason,
            targetSymbol: ETH_SYMBOL,
            windowName: activeWindow.name,
            momentum: pocShift,
            volRatio: avgVol > 0 ? curr.v / avgVol : 1,
            windowEndTs: timeoutTs,
            slPt,
            tpPt,
            dynamicQty: qty,
        };

        this._pendingSignal = signal;
        this._ceoApproved = false;
        log(reason);
        return signal;
    }

    /** 检查亚盘仓位是否需要 12:00 UTC+8 强制平仓 */
    shouldNoonForceClose(): boolean {
        if (!this.activePositionIsAsian) return false;
        const h = new Date(Date.now() + 8 * 3600000).getUTCHours();
        return h >= NOON_FORCE_CLOSE_H;
    }

    /** 获取当前策略版本 */
    getVersion(): string { return "V200 五模组 Bot"; }
}

export { Mom12Strategy as CausalStrategy };
export { Mom12Strategy as WindowStrategy };
