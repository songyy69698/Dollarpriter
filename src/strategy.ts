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

        // ═══ 每个窗口双向检查: 多空都看，条件满足哪个做哪个 ═══

        // ─── 做多条件: RSI<30 + VWAP偏下 ───
        const longOk = rsi < RSI_OVERSOLD && vwapDev < -VWAP_DEV_MIN;
        // ─── 做空条件: RSI>70 + VWAP偏上 ───
        const shortOk = rsi > RSI_OVERBOUGHT && vwapDev > VWAP_DEV_MIN;

        if (activeWindow.name === "08窗口") {
            // 08:00 — 日振已用少 → 偏做多(均值回归); 日振已用多 → 可做空(趋势延续)
            if (longOk && usedRange < RANGE_LOW_THRESHOLD) {
                signal = this.buildSignal("long", `🌅 08:00 做多`, currentPrice, snap, activeWindow.name);
            } else if (shortOk && usedRange > RANGE_HIGH_THRESHOLD) {
                signal = this.buildSignal("short", `🌅 08:00 做空`, currentPrice, snap, activeWindow.name);
            }
        }

        if (activeWindow.name === "15窗口") {
            // 15:00 — 日振已用多 → 偏做空(超涨回落); 日振已用少 → 可做多(低位反弹)
            if (shortOk && usedRange > RANGE_HIGH_THRESHOLD) {
                signal = this.buildSignal("short", `🌇 15:00 做空`, currentPrice, snap, activeWindow.name);
            } else if (longOk && usedRange < RANGE_LOW_THRESHOLD) {
                signal = this.buildSignal("long", `🌇 15:00 做多`, currentPrice, snap, activeWindow.name);
            }
        }

        if (activeWindow.name === "22窗口") {
            // 22:00 — 全天最大波动窗口，多空都有机会
            if (longOk && usedRange > RANGE_FULL_THRESHOLD && barRR > 1.0) {
                signal = this.buildSignal("long", `🌙 22:00 做多(假跌反弹)`, currentPrice, snap, activeWindow.name);
            } else if (shortOk && usedRange > RANGE_FULL_THRESHOLD && barRR > 1.0) {
                signal = this.buildSignal("short", `🌙 22:00 做空(假涨反跌)`, currentPrice, snap, activeWindow.name);
            }
        }

        if (signal) {
            this.lastWindowSignal = activeWindow.name;
            this._pendingSignal = signal;
            this._ceoApproved = false;
            log(`📡 ${signal.windowName} ${signal.side.toUpperCase()} 信号 → 等待 CEO 确认`);
        }

        return signal;
    }

    /** 构建信号对象 */
    private buildSignal(
        side: "long" | "short", title: string,
        price: number, snap: WindowSignal["indicators"],
        windowName: string,
    ): WindowSignal {
        const { rsi, vwapDev, usedRange, atr, prev1hChange, barRangeRatio } = snap;
        const sideLabel = side === "long" ? "做多📈" : "做空📉";
        const reason =
            `${title} ${sideLabel}\n` +
            `RSI=${rsi.toFixed(0)} ${side === "long" ? `(<${RSI_OVERSOLD})` : `(>${RSI_OVERBOUGHT})`} ✅\n` +
            `VWAP偏=${vwapDev > 0 ? "+" : ""}${vwapDev.toFixed(2)}% ✅\n` +
            `日振=${(usedRange * 100).toFixed(0)}% ✅\n` +
            `前1h=${prev1hChange > 0 ? "+" : ""}${prev1hChange.toFixed(2)}% | ATR=${atr.toFixed(1)}pt`;
        return {
            side, price, qty: ENTRY_QTY,
            reason, targetSymbol: ETH_SYMBOL, windowName,
            indicators: snap,
        };
    }
}
