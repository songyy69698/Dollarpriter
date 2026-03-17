/**
 * 🧠 V91 因果套利策略 — 时间窗口 + 盘口因果
 * ═══════════════════════════════════════════════════════
 * 只在 CEO 指定的三个时段内寻找因果套利信号:
 *   08:00-09:00 | 15:00-16:00 | 22:00-23:00 (UTC+8)
 *
 * 入场: ethBuyDelta > ethAskWallVol × 2.5 且 效率 > 均值
 * 出场: executor.ts 管理 (SL=12 → 保本10+3 → 跟踪10)
 * CEO 确认后才开，不回自动 2ETH
 */

import type { CausalSnapshot } from "./bitunix-ws";
import {
    COOLDOWN_MS, ETH_SYMBOL, ENTRY_QTY,
    MAX_SPREAD_POINTS, MIN_DEPTH_ETH,
    TRADE_WINDOWS,
} from "./config";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [strategy] ${msg}`);
}

export interface CausalSignal {
    side: "long" | "short";
    price: number;
    qty: number;
    reason: string;
    targetSymbol: string;
    windowName: string;
    // 信号强度
    imbalanceRatio: number;
    efficiency: number;
}

// 向后兼容
export type WindowSignal = CausalSignal;

export class CausalStrategy {
    private lastTradeTs = 0;
    private scanCount = 0;
    private _pendingSignal: CausalSignal | null = null;
    private _ceoApproved = false;

    // 同一窗口不重复发信号
    private lastWindowSignal = "";

    getScanCount(): number { return this.scanCount; }
    get pendingSignal(): CausalSignal | null { return this._pendingSignal; }
    get ceoApproved(): boolean { return this._ceoApproved; }

    approveTrade(): void {
        this._ceoApproved = true;
        log("✅ CEO 确认开单!");
    }

    clearPending(): void {
        this._pendingSignal = null;
        this._ceoApproved = false;
    }

    markTraded(): void {
        this.lastTradeTs = Date.now();
        this.clearPending();
    }

    /**
     * 评估因果套利信号
     * Step 1: 检查是否在 CEO 指定的时间窗口内
     * Step 2: 检查盘口因果信号 (买压>卖墙×2.5)
     */
    evaluate(snapshot: CausalSnapshot): CausalSignal | null {
        this.scanCount++;
        const now = Date.now();

        // 冷却
        if (now - this.lastTradeTs < COOLDOWN_MS) return null;
        // 已有待确认信号
        if (this._pendingSignal) return null;

        // ═══ Step 1: 时间窗口检查 (UTC+8) ═══
        const dt = new Date();
        const utc8Hour = (dt.getUTCHours() + 8) % 24;
        const utc8Min = dt.getUTCMinutes();
        const hm = utc8Hour * 60 + utc8Min;

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
            // 不在窗口 → 重置
            this.lastWindowSignal = "";
            return null;
        }

        // 同窗口已发过信号
        if (this.lastWindowSignal === activeWindow.name) return null;

        // ═══ Step 2: 因果套利检测 ═══
        const {
            ethPrice, ethBuyDelta, ethSellDelta,
            ethAskWallVol, ethBidWallVol,
            ethEfficiency, ethAvgEfficiency,
            ethSpread, ethConnected,
        } = snapshot;

        // 基本检查
        if (!ethConnected || ethPrice <= 0) return null;
        if (ethAskWallVol <= 0 && ethBidWallVol <= 0) return null;
        if (ethAvgEfficiency <= 0) return null;

        // Spread 门控
        if (ethSpread > MAX_SPREAD_POINTS) {
            if (this.scanCount % 60 === 0) {
                log(`⚠️ ${activeWindow.name} Spread过大: ${ethSpread.toFixed(2)}pt`);
            }
            return null;
        }

        const IMBALANCE_RATIO = 2.5;
        const EFFICIENCY_THRESHOLD = 1.0;

        let side: "long" | "short" | "" = "";
        let ratio = 0;
        let reason = "";

        // 做多: 买压 > 卖墙 × 2.5
        if (ethAskWallVol > 0) {
            const buyImb = ethBuyDelta / ethAskWallVol;
            if (buyImb > IMBALANCE_RATIO && ethEfficiency > ethAvgEfficiency * EFFICIENCY_THRESHOLD) {
                side = "long";
                ratio = buyImb;
                reason = `📈 ${activeWindow.name} 因果做多 | 买压/卖墙=${buyImb.toFixed(1)}x | 效率=${ethEfficiency.toFixed(4)}`;
            }
        }

        // 做空: 卖压 > 买墙 × 2.5
        if (!side && ethBidWallVol > 0) {
            const sellImb = ethSellDelta / ethBidWallVol;
            if (sellImb > IMBALANCE_RATIO && ethEfficiency > ethAvgEfficiency * EFFICIENCY_THRESHOLD) {
                side = "short";
                ratio = sellImb;
                reason = `📉 ${activeWindow.name} 因果做空 | 卖压/买墙=${sellImb.toFixed(1)}x | 效率=${ethEfficiency.toFixed(4)}`;
            }
        }

        if (!side) return null;

        const signal: CausalSignal = {
            side,
            price: ethPrice,
            qty: ENTRY_QTY,
            reason,
            targetSymbol: ETH_SYMBOL,
            windowName: activeWindow.name,
            imbalanceRatio: ratio,
            efficiency: ethEfficiency,
        };

        this.lastWindowSignal = activeWindow.name;
        this._pendingSignal = signal;
        this._ceoApproved = false;
        log(`📡 ${reason}`);

        return signal;
    }
}

// 向后兼容: 导出 WindowStrategy 别名
export { CausalStrategy as WindowStrategy };
