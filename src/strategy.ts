/**
 * 🧠 V75 "能量 vs 阻力" — 牆体坍塌策略引擎
 * ═══════════════════════════════════════════════
 * 入场：BTC领路(5.5x) + 能量击穿L1首档牆(3x)
 * 纯订单流因果，不依赖K线结构
 */

import type { CausalSnapshot } from "./bitunix-ws";
import type { CandleTracker } from "./candles";
import {
    COOLDOWN_MS, WS_LAG_MAX_MS,
    ALLOW_SHORT, BTC_ENTRY_RATIO,
    ETH_SYMBOL, MAX_SPREAD_POINTS, MIN_DEPTH_ETH,
    BREAKOUT_POWER_MIN,
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
     * V75: 能量 vs 阻力 — 牆体坍塌评估
     * @param snap  WS 数据快照
     * @param ct    K线追踪器 (保留用于 Iron Guard 出场)
     * @param balance 当前余额 (用于复利)
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
        const btcTotal = btcBuy + btcSell;
        if (btcTotal <= 0) return null;

        const btcBuyRatio = btcBuy / Math.max(btcSell, 0.001);
        const btcSellRatio = btcSell / Math.max(btcBuy, 0.001);

        // ═══ V75 瞬时成交量 & L1 牆量 ═══
        const instantVol = snap.ethInstantVol;
        const l1Ask = snap.ethL1AskVol;
        const l1Bid = snap.ethL1BidVol;

        // 瞬时成交量必须 > 0 才有意义
        if (instantVol <= 0) return null;

        // ═══ 动态保证金 ═══
        const margin = getMargin(balance);

        // ═══════════════════════════════════════════════
        // V75 入场判定: 牆体坍塌
        // ═══════════════════════════════════════════════

        // --- LONG: BTC 买压领路 + 能量击穿首档卖牆 ---
        const breakoutLong = instantVol / Math.max(l1Ask, 0.001);
        if (
            btcBuyRatio >= BTC_ENTRY_RATIO &&
            breakoutLong >= BREAKOUT_POWER_MIN
        ) {
            this.lastTradeTs = now;
            const reason =
                `🔨 V75 牆塌LONG: $${ethPrice.toFixed(2)} | ` +
                `突破力=${breakoutLong.toFixed(1)}x≥${BREAKOUT_POWER_MIN}x | ` +
                `BTC買壓=${btcBuyRatio.toFixed(1)}x | ` +
                `瞬量=${instantVol.toFixed(1)} vs L1賣牆=${l1Ask.toFixed(1)}`;
            log(reason);
            return {
                side: "long",
                price: ethPrice,
                margin,
                reason,
                targetSymbol: ETH_SYMBOL,
            };
        }

        // --- SHORT: BTC 卖压领路 + 能量击穿首档买牆 ---
        const breakoutShort = instantVol / Math.max(l1Bid, 0.001);
        if (
            ALLOW_SHORT &&
            btcSellRatio >= BTC_ENTRY_RATIO &&
            breakoutShort >= BREAKOUT_POWER_MIN
        ) {
            this.lastTradeTs = now;
            const reason =
                `🔨 V75 牆塌SHORT: $${ethPrice.toFixed(2)} | ` +
                `突破力=${breakoutShort.toFixed(1)}x≥${BREAKOUT_POWER_MIN}x | ` +
                `BTC賣壓=${btcSellRatio.toFixed(1)}x | ` +
                `瞬量=${instantVol.toFixed(1)} vs L1買牆=${l1Bid.toFixed(1)}`;
            log(reason);
            return {
                side: "short",
                price: ethPrice,
                margin,
                reason,
                targetSymbol: ETH_SYMBOL,
            };
        }

        return null;
    }
}
