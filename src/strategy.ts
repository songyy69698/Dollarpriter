/**
 * 🧠 V80.1 "FINAL-SENSE" — 自适应时间穿牆狙击
 * ═══════════════════════════════════════════════
 * 时段模式切换 + 振幅疲劳仪 + 穿牆入场
 * SLEEP / ANTIFAKE / TREND / SCALP / TITAN
 */

import type { CausalSnapshot } from "./bitunix-ws";
import type { CandleTracker } from "./candles";
import {
    COOLDOWN_MS, WS_LAG_MAX_MS,
    ALLOW_SHORT,
    ETH_SYMBOL, MAX_SPREAD_POINTS, MIN_DEPTH_ETH,
    BREAKOUT_POWER_MIN,
    ENTRY_WALL_RATIO_LONG, ENTRY_WALL_RATIO_SHORT,
    FATIGUE_BLOCK_THRESHOLD,
    getMargin, getTimeMode,
    type TimeMode,
} from "./config";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [strategy] ${msg}`);
}

export interface CausalSignal {
    side: "long" | "short";
    price: number;
    margin: number;
    reason: string;
    targetSymbol: string;
}

export class CausalStrategy {
    private lastTradeTs = 0;
    private scanCount = 0;
    private _currentMode: TimeMode = "SLEEP";

    getScanCount(): number { return this.scanCount; }
    get currentMode(): TimeMode { return this._currentMode; }

    /**
     * V80.1: 自适应时间穿牆狙击
     */
    evaluate(snap: CausalSnapshot, ct: CandleTracker, balance: number): CausalSignal | null {
        this.scanCount++;
        const now = Date.now();

        // ═══ 时段模式 ═══
        const dt = new Date();
        const utc8Hour = (dt.getUTCHours() + 8) % 24;
        const utc8Min = dt.getUTCMinutes();
        const tmConfig = getTimeMode(utc8Hour, utc8Min);
        this._currentMode = tmConfig.mode;

        // ═══ SLEEP 模式: 03:01-07:59 强制关机 ═══
        if (tmConfig.mode === "SLEEP") return null;

        // ═══ 基础检查 ═══
        if (now - this.lastTradeTs < COOLDOWN_MS) return null;
        if (!snap.connected || snap.price <= 0) return null;
        if (now - snap.priceTs > WS_LAG_MAX_MS) return null;

        const ethPrice = snap.ethPrice;
        if (ethPrice <= 0) return null;
        if (snap.ethSpread > MAX_SPREAD_POINTS) return null;
        if (snap.ethTop3Depth < MIN_DEPTH_ETH) return null;

        // ═══ 振幅疲劳仪 ═══
        ct.updateRealtimePrice(ethPrice);
        const fatigue = ct.getFatigue();

        // fatigue > 0.7 → 禁止追单 (breakout 模式关闭)
        if (fatigue > FATIGUE_BLOCK_THRESHOLD && tmConfig.allowBreakout) {
            // 追单被疲劳仪阻止，只允许反转 (阶段4实装)
            return null;
        }

        // ═══ ANTIFAKE 模式: 19:00-20:30 只做反转 (阶段4实装) ═══
        if (tmConfig.mode === "ANTIFAKE") {
            // TODO: 阶段4 实装 Fake-out Reversal 逻辑
            return null;
        }

        // ═══ 不允许追单的模式直接返回 ═══
        if (!tmConfig.allowBreakout) return null;

        // ═══ BTC Lead (使用时段动态门槛) ═══
        const btcBuy = snap.btcBuyDelta;
        const btcSell = snap.btcSellDelta;
        if (btcBuy + btcSell <= 0) return null;

        const btcBuyRatio = btcBuy / Math.max(btcSell, 0.001);
        const btcSellRatio = btcSell / Math.max(btcBuy, 0.001);
        const btcThreshold = tmConfig.btcThreshold;

        // ═══ 订单流数据 ═══
        const instantVol = snap.ethInstantVol;
        const l1Ask = snap.ethL1AskVol;
        const l1Bid = snap.ethL1BidVol;
        if (instantVol <= 0) return null;

        const wallRatio = l1Bid / Math.max(l1Ask, 0.001);
        const margin = getMargin(balance);

        // ═══════════════════════════════════════════════
        // V80.1 入场: 穿牆狙击 (方案 B — 先跑)
        // ═══════════════════════════════════════════════

        // --- LONG ---
        const breakoutLong = instantVol / Math.max(l1Ask, 0.001);
        if (
            btcBuyRatio >= btcThreshold &&
            breakoutLong >= BREAKOUT_POWER_MIN &&
            wallRatio > ENTRY_WALL_RATIO_LONG
        ) {
            this.lastTradeTs = now;
            const reason =
                `🚀 V80 穿牆LONG: $${ethPrice.toFixed(2)} | ` +
                `突破=${breakoutLong.toFixed(1)}x | BTC=${btcBuyRatio.toFixed(1)}x≥${btcThreshold}x | ` +
                `牆比=${wallRatio.toFixed(1)} | 疲劳=${(fatigue * 100).toFixed(0)}% | [${tmConfig.mode}]`;
            log(reason);
            return { side: "long", price: ethPrice, margin, reason, targetSymbol: ETH_SYMBOL };
        }

        // --- SHORT ---
        const breakoutShort = instantVol / Math.max(l1Bid, 0.001);
        if (
            ALLOW_SHORT &&
            btcSellRatio >= btcThreshold &&
            breakoutShort >= BREAKOUT_POWER_MIN &&
            wallRatio < ENTRY_WALL_RATIO_SHORT
        ) {
            this.lastTradeTs = now;
            const reason =
                `📉 V80 穿牆SHORT: $${ethPrice.toFixed(2)} | ` +
                `突破=${breakoutShort.toFixed(1)}x | BTC=${btcSellRatio.toFixed(1)}x≥${btcThreshold}x | ` +
                `牆比=${wallRatio.toFixed(2)} | 疲劳=${(fatigue * 100).toFixed(0)}% | [${tmConfig.mode}]`;
            log(reason);
            return { side: "short", price: ethPrice, margin, reason, targetSymbol: ETH_SYMBOL };
        }

        return null;
    }
}
