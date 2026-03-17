/**
 * 🎯 V90.4 时段窗口策略 — 精准入场
 * ═══════════════════════════════════════════
 * 每个窗口都开单，但等"动能衰竭"再进:
 *   1. 先检测方向 (RSI+VWAP+日振)
 *   2. 在窗口内等最佳时机:
 *      - 实体/ATR < 0.8 (K线变小=犹豫)
 *      - RSI 在减速 (动能衰竭)
 *   3. 如果窗口快结束还没等到 → 最后5分钟照开
 *
 * CEO 确认后才开，不回自动 2ETH
 */

import type { IndicatorEngine } from "./indicators";
import {
    TRADE_WINDOWS, ENTRY_QTY,
    RSI_OVERSOLD, RSI_OVERBOUGHT,
    VWAP_DEV_MIN,
    RANGE_LOW_THRESHOLD, RANGE_HIGH_THRESHOLD, RANGE_FULL_THRESHOLD,
    COOLDOWN_MS, ETH_SYMBOL,
} from "./config";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [strategy] ${msg}`);
}

export interface WindowSignal {
    side: "long" | "short";
    price: number;
    qty: number;
    reason: string;
    targetSymbol: string;
    windowName: string;
    indicators: {
        rsi: number;
        vwapDev: number;
        usedRange: number;
        atr: number;
        prev1hChange: number;
        barRangeRatio: number;
    };
}

export class WindowStrategy {
    private lastTradeTs = 0;
    private lastWindowSignal = "";  // 同一窗口不重复发信号
    private scanCount = 0;
    private _pendingSignal: WindowSignal | null = null;
    private _ceoApproved = false;

    // 窗口内等待状态
    private windowDirection: "long" | "short" | "" = "";  // 已确定方向
    private windowDetectedAt = 0;     // 首次检测到方向的时间
    private windowName = "";

    getScanCount(): number { return this.scanCount; }
    get pendingSignal(): WindowSignal | null { return this._pendingSignal; }
    get ceoApproved(): boolean { return this._ceoApproved; }

    /** CEO 通过 Telegram 确认 */
    approveTrade(): void {
        this._ceoApproved = true;
        log("✅ CEO 确认开单!");
    }

    /** 清除待确认信号 */
    clearPending(): void {
        this._pendingSignal = null;
        this._ceoApproved = false;
    }

    /** 标记已开单 */
    markTraded(): void {
        this.lastTradeTs = Date.now();
        this.clearPending();
        this.windowDirection = "";
        this.windowDetectedAt = 0;
    }

    /**
     * 评估: 在窗口内找最佳入场时机
     */
    evaluate(currentPrice: number, indicators: IndicatorEngine): WindowSignal | null {
        this.scanCount++;
        const now = Date.now();

        // 冷却检查
        if (now - this.lastTradeTs < COOLDOWN_MS) return null;

        // 当前 UTC+8 时间
        const dt = new Date();
        const utc8Hour = (dt.getUTCHours() + 8) % 24;
        const utc8Min = dt.getUTCMinutes();
        const hm = utc8Hour * 60 + utc8Min;

        // 检查哪个窗口
        let activeWindow: typeof TRADE_WINDOWS[0] | null = null;
        for (const w of TRADE_WINDOWS) {
            const wStart = w.startHour * 60 + w.startMin;
            const wEnd = w.endHour * 60 + w.endMin;
            if (hm >= wStart && hm < wEnd) {
                activeWindow = w;
                break;
            }
        }

        if (!activeWindow) {
            // 不在窗口 → 重置状态
            this.lastWindowSignal = "";
            this.windowDirection = "";
            this.windowDetectedAt = 0;
            return null;
        }

        // 同一窗口已发过信号
        if (this.lastWindowSignal === activeWindow.name) return null;

        if (!indicators.ready) return null;
        if (currentPrice <= 0) return null;

        // 计算指标
        const rsi = indicators.getRSI();
        const vwapDev = indicators.getVWAPDeviation(currentPrice);
        const usedRange = indicators.getUsedRangeRatio(currentPrice);
        const atr = indicators.getATR();
        const prev1h = indicators.getPrev1hChange();
        const barRR = indicators.getCurrentBarRangeRatio();

        // 亏损单反思指标
        const bodyR = indicators.getCurrentBarRangeRatio(); // 实体/ATR
        const rsiSpeed = indicators.getRSISpeed();          // RSI 变速

        // 前1h量价因果 (参考信息)
        const vpc = indicators.getPrev1hVolumePriceCausal();

        const snap = { rsi, vwapDev, usedRange, atr, prev1hChange: prev1h, barRangeRatio: barRR };

        // ═══ Step 1: 检测方向 (多空都看) ═══
        const longOk = rsi < RSI_OVERSOLD && vwapDev < -VWAP_DEV_MIN;
        const shortOk = rsi > RSI_OVERBOUGHT && vwapDev > VWAP_DEV_MIN;

        let detectedSide: "long" | "short" | "" = "";

        if (activeWindow.name === "08窗口") {
            if (longOk && usedRange < RANGE_LOW_THRESHOLD) detectedSide = "long";
            else if (shortOk && usedRange > RANGE_HIGH_THRESHOLD) detectedSide = "short";
        }

        if (activeWindow.name === "15窗口") {
            if (shortOk && usedRange > RANGE_HIGH_THRESHOLD) detectedSide = "short";
            else if (longOk && usedRange < RANGE_LOW_THRESHOLD) detectedSide = "long";
        }

        if (activeWindow.name === "22窗口") {
            if (longOk && usedRange > RANGE_FULL_THRESHOLD && barRR > 1.0) detectedSide = "long";
            else if (shortOk && usedRange > RANGE_FULL_THRESHOLD && barRR > 1.0) detectedSide = "short";
        }

        if (!detectedSide) return null;

        // 首次检测到方向 → 记录
        if (!this.windowDirection) {
            this.windowDirection = detectedSide;
            this.windowDetectedAt = now;
            this.windowName = activeWindow.name;
            log(`🔍 ${activeWindow.name} 检测到 ${detectedSide.toUpperCase()} 方向 → 等待最佳入场时机...`);
        }

        // ═══ Step 2: 等最佳入场时机 ═══
        // 亏损单反思: 赢单实体比=0.58, 亏单=1.04; 赢单RSI减速, 亏单RSI加速
        const isDecelerating = detectedSide === "long"
            ? rsiSpeed < 0    // 做多: RSI 在回升(从超卖恢复)
            : rsiSpeed > 0;   // 做空: RSI 在回落(从超买恢复)
        // 注: 做多时 rsiSpeed<0 代表 RSI 跌速在放缓/开始回升

        const bodySmall = bodyR < 0.8;  // K 线实体变小 = 犹豫 = 将反转
        const timingGood = bodySmall || isDecelerating;

        // 窗口快结束了 (最后5分钟) → 不再等
        const windowEnd = activeWindow.endHour * 60 + activeWindow.endMin;
        const minutesLeft = windowEnd - hm;
        const urgentEntry = minutesLeft <= 5;

        if (!timingGood && !urgentEntry) {
            // 方向对但时机不到 → 继续等
            if (this.scanCount % 12 === 0) { // 每分钟 log 一次
                log(`⏳ ${activeWindow.name} ${detectedSide.toUpperCase()} 等待中... 实体比=${bodyR.toFixed(2)} RSI速=${rsiSpeed.toFixed(1)} 剩${minutesLeft}min`);
            }
            return null;
        }

        // ═══ Step 3: 产生信号 ═══
        const entryType = urgentEntry && !timingGood ? "⏰末班车" : "🎯精准";
        const title = activeWindow.name === "08窗口" ? "🌅 08:00" :
                      activeWindow.name === "15窗口" ? "🌇 15:00" : "🌙 22:00";

        const vpcLabel = vpc.direction === "bullish" ? "🟢多头量能" :
                         vpc.direction === "bearish" ? "🔴空头量能" : "⚪中性量能";

        const sideLabel = detectedSide === "long" ? "做多📈" : "做空📉";
        const reason =
            `${title} ${sideLabel} [${entryType}]\n` +
            `RSI=${rsi.toFixed(0)} ${detectedSide === "long" ? `(<${RSI_OVERSOLD})` : `(>${RSI_OVERBOUGHT})`} ✅\n` +
            `VWAP偏=${vwapDev > 0 ? "+" : ""}${vwapDev.toFixed(2)}% ✅\n` +
            `日振=${(usedRange * 100).toFixed(0)}% ✅\n` +
            `实体比=${bodyR.toFixed(2)} ${bodySmall ? "✅小(犹豫)" : "⚠️大(加速)"}\n` +
            `RSI速=${rsiSpeed.toFixed(1)} ${isDecelerating ? "✅减速" : "⚠️加速"}\n` +
            `量价: ${vpcLabel} 买卖比=${vpc.ratio.toFixed(1)}\n` +
            `前1h=${prev1h > 0 ? "+" : ""}${prev1h.toFixed(2)}% | ATR=${atr.toFixed(1)}pt`;

        const signal: WindowSignal = {
            side: detectedSide, price: currentPrice, qty: ENTRY_QTY,
            reason, targetSymbol: ETH_SYMBOL, windowName: activeWindow.name,
            indicators: snap,
        };

        this.lastWindowSignal = activeWindow.name;
        this._pendingSignal = signal;
        this._ceoApproved = false;
        log(`📡 ${activeWindow.name} ${detectedSide.toUpperCase()} [${entryType}] → 实体比=${bodyR.toFixed(2)} RSI速=${rsiSpeed.toFixed(1)} → 等待 CEO 确认`);

        return signal;
    }
}
