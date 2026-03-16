/**
 * 🧠 V80 "FINAL-SENSE" — 穿牆狙击策略引擎
 * ═══════════════════════════════════════════════
 * 入场：BTC 海嘯(8x) + 能量穿牆(3x) + 牆比确认
 * 纯订单流因果，不依赖K线结构
 */

import type { CausalSnapshot } from "./bitunix-ws";
import type { CandleTracker } from "./candles";
import {
    COOLDOWN_MS, WS_LAG_MAX_MS,
    ALLOW_SHORT, BTC_ENTRY_RATIO,
    ETH_SYMBOL, MAX_SPREAD_POINTS, MIN_DEPTH_ETH,
    BREAKOUT_POWER_MIN,
    ENTRY_WALL_RATIO_LONG, ENTRY_WALL_RATIO_SHORT,
    getMargin,
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

    getScanCount(): number { return this.scanCount; }

    /**
     * V80: 穿牆狙击评估
     */
    evaluate(snap: CausalSnapshot, ct: CandleTracker, balance: number): CausalSignal | null {
        this.scanCount++;
        const now = Date.now();

        // ═══ 基础检查 ═══
        if (now - this.lastTradeTs < COOLDOWN_MS) return null;
        if (!snap.connected || snap.price <= 0) return null;
        if (now - snap.priceTs > WS_LAG_MAX_MS) return null;

        // ═══ ETH 数据 ═══
        const ethPrice = snap.ethPrice;
        if (ethPrice <= 0) return null;

        // ═══ Spread Gate ═══
        if (snap.ethSpread > MAX_SPREAD_POINTS) return null;

        // ═══ Depth Gate ═══
        if (snap.ethTop3Depth < MIN_DEPTH_ETH) return null;

        // ═══ BTC Lead 强度 ═══
        const btcBuy = snap.btcBuyDelta;
        const btcSell = snap.btcSellDelta;
        if (btcBuy + btcSell <= 0) return null;

        const btcBuyRatio = btcBuy / Math.max(btcSell, 0.001);
        const btcSellRatio = btcSell / Math.max(btcBuy, 0.001);

        // ═══ V80 数据 ═══
        const instantVol = snap.ethInstantVol;
        const l1Ask = snap.ethL1AskVol;
        const l1Bid = snap.ethL1BidVol;
        if (instantVol <= 0) return null;

        // 牆比: bid/ask (> 1 = 买盘支撑强)
        const wallRatio = l1Bid / Math.max(l1Ask, 0.001);

        const margin = getMargin(balance);

        // ═══════════════════════════════════════════════
        // V80 入场：穿牆狙击
        // ═══════════════════════════════════════════════

        // --- LONG: BTC 买压海嘯 + 能量穿卖牆 + 买牆支撑 ---
        const breakoutLong = instantVol / Math.max(l1Ask, 0.001);
        if (
            btcBuyRatio >= BTC_ENTRY_RATIO &&
            breakoutLong >= BREAKOUT_POWER_MIN &&
            wallRatio > ENTRY_WALL_RATIO_LONG
        ) {
            this.lastTradeTs = now;
            const reason =
                `🚀 V80 穿牆LONG: $${ethPrice.toFixed(2)} | ` +
                `突破=${breakoutLong.toFixed(1)}x≥${BREAKOUT_POWER_MIN}x | ` +
                `BTC=${btcBuyRatio.toFixed(1)}x≥${BTC_ENTRY_RATIO}x | ` +
                `牆比=${wallRatio.toFixed(1)}>${ENTRY_WALL_RATIO_LONG}`;
            log(reason);
            return { side: "long", price: ethPrice, margin, reason, targetSymbol: ETH_SYMBOL };
        }

        // --- SHORT: BTC 卖压海嘯 + 能量穿买牆 + 卖牆压制 ---
        const breakoutShort = instantVol / Math.max(l1Bid, 0.001);
        if (
            ALLOW_SHORT &&
            btcSellRatio >= BTC_ENTRY_RATIO &&
            breakoutShort >= BREAKOUT_POWER_MIN &&
            wallRatio < ENTRY_WALL_RATIO_SHORT
        ) {
            this.lastTradeTs = now;
            const reason =
                `📉 V80 穿牆SHORT: $${ethPrice.toFixed(2)} | ` +
                `突破=${breakoutShort.toFixed(1)}x≥${BREAKOUT_POWER_MIN}x | ` +
                `BTC=${btcSellRatio.toFixed(1)}x≥${BTC_ENTRY_RATIO}x | ` +
                `牆比=${wallRatio.toFixed(2)}<${ENTRY_WALL_RATIO_SHORT}`;
            log(reason);
            return { side: "short", price: ethPrice, margin, reason, targetSymbol: ETH_SYMBOL };
        }

        return null;
    }
}
