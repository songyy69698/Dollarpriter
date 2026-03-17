/**
 * 🎯 V90 时段窗口策略 — CEO 确认模式
 * ═══════════════════════════════════════════
 * 三个交易窗口:
 *   08:00-09:00 做多 (RSI<30 + VWAP↓ + 日振<50%)
 *   15:00-16:00 做空 (RSI>70 + VWAP↑ + 日振>60%)
 *   22:00-23:00 做多 (RSI<30 + VWAP↓ + 日振>70% + 大K)
 *
 * 不自动开单! 发信号到 Telegram, CEO 确认后才开。
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
    }

    /**
     * 评估当前是否在交易窗口内，是否满足入场条件
     * 返回信号或 null
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
            this.lastWindowSignal = "";
            return null;
        }

        // 同一窗口不重复产生信号
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

        const snap = { rsi, vwapDev, usedRange, atr, prev1hChange: prev1h, barRangeRatio: barRR };

        let signal: WindowSignal | null = null;

        // ═══ 窗口 1: 08:00 做多 ═══
        if (activeWindow.name === "08做多") {
            if (rsi < RSI_OVERSOLD && vwapDev < -VWAP_DEV_MIN && usedRange < RANGE_LOW_THRESHOLD) {
                const reason =
                    `🌅 08:00 做多信号\n` +
                    `RSI=${rsi.toFixed(0)} (<${RSI_OVERSOLD}) ✅\n` +
                    `VWAP偏=${vwapDev.toFixed(2)}% (<-${VWAP_DEV_MIN}%) ✅\n` +
                    `日振=${(usedRange * 100).toFixed(0)}% (<${RANGE_LOW_THRESHOLD * 100}%) ✅\n` +
                    `前1h=${prev1h.toFixed(2)}% | ATR=${atr.toFixed(1)}pt`;
                signal = {
                    side: "long", price: currentPrice, qty: ENTRY_QTY,
                    reason, targetSymbol: ETH_SYMBOL, windowName: activeWindow.name,
                    indicators: snap,
                };
            }
        }

        // ═══ 窗口 2: 15:00 做空 ═══
        if (activeWindow.name === "15做空") {
            if (rsi > RSI_OVERBOUGHT && vwapDev > VWAP_DEV_MIN && usedRange > RANGE_HIGH_THRESHOLD) {
                const reason =
                    `🌇 15:00 做空信号\n` +
                    `RSI=${rsi.toFixed(0)} (>${RSI_OVERBOUGHT}) ✅\n` +
                    `VWAP偏=+${vwapDev.toFixed(2)}% (>${VWAP_DEV_MIN}%) ✅\n` +
                    `日振=${(usedRange * 100).toFixed(0)}% (>${RANGE_HIGH_THRESHOLD * 100}%) ✅\n` +
                    `前1h=${prev1h.toFixed(2)}% | ATR=${atr.toFixed(1)}pt`;
                signal = {
                    side: "short", price: currentPrice, qty: ENTRY_QTY,
                    reason, targetSymbol: ETH_SYMBOL, windowName: activeWindow.name,
                    indicators: snap,
                };
            }
        }

        // ═══ 窗口 3: 22:00 做多 ═══
        if (activeWindow.name === "22做多") {
            if (rsi < RSI_OVERSOLD && vwapDev < -VWAP_DEV_MIN && usedRange > RANGE_FULL_THRESHOLD && barRR > 1.0) {
                const reason =
                    `🌙 22:00 做多信号 (假跌破反弹)\n` +
                    `RSI=${rsi.toFixed(0)} (<${RSI_OVERSOLD}) ✅\n` +
                    `VWAP偏=${vwapDev.toFixed(2)}% (<-${VWAP_DEV_MIN}%) ✅\n` +
                    `日振=${(usedRange * 100).toFixed(0)}% (>${RANGE_FULL_THRESHOLD * 100}%) ✅\n` +
                    `K线/ATR=${barRR.toFixed(1)}x (>1.0) ✅\n` +
                    `前1h=${prev1h.toFixed(2)}% | ATR=${atr.toFixed(1)}pt`;
                signal = {
                    side: "long", price: currentPrice, qty: ENTRY_QTY,
                    reason, targetSymbol: ETH_SYMBOL, windowName: activeWindow.name,
                    indicators: snap,
                };
            }
        }

        if (signal) {
            this.lastWindowSignal = activeWindow.name;
            this._pendingSignal = signal;
            this._ceoApproved = false;
            log(`📡 ${signal.windowName} 信号产生 → 等待 CEO 确认`);
        }

        return signal;
    }
}
