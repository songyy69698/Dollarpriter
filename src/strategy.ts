/**
 * 🧠 V66 "LEVIATHAN" — 策略引擎
 * ═══════════════════════════════════════════════
 * 15M 结构性突破入场:
 *   SHORT: Price < lowest(Low, 2根15M) AND BTC_Lead ≥ 4.0x
 *   LONG:  Price > highest(High, 2根15M) AND BTC_Lead ≥ 4.0x
 *
 * + Spread/Liquidity Gate + BTC Lead 确认
 */

import type { CausalSnapshot } from "./bitunix-ws";
import type { CandleTracker } from "./candles";
import {
    COOLDOWN_MS, WS_LAG_MAX_MS,
    ALLOW_SHORT, BTC_ENTRY_RATIO,
    ETH_SYMBOL, MAX_SPREAD_POINTS, MIN_DEPTH_ETH,
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
     * V66: 15M 结构性突破评估
     * @param snap  WS 数据快照
     * @param ct    K线追踪器
     * @param balance 当前余额 (用于复利)
     */
    evaluate(snap: CausalSnapshot, ct: CandleTracker, balance: number): CausalSignal | null {
        this.scanCount++;
        const now = Date.now();

        // ═══ 基础检查 ═══
        if (now - this.lastTradeTs < COOLDOWN_MS) return null;
        if (!snap.connected || snap.price <= 0) return null;
        if (now - snap.priceTs > WS_LAG_MAX_MS) return null;

        // ═══ K线数据就绪检查 ═══
        if (!ct.ready) return null;

        // ═══ ETH 数据 ═══
        const ethPrice = snap.ethPrice;
        if (ethPrice <= 0) return null;

        // ═══ Spread Gate ═══
        const ethSpread = snap.ethSpread;
        if (ethSpread > MAX_SPREAD_POINTS) return null;

        // ═══ Depth Gate ═══
        if (snap.ethTop3Depth < MIN_DEPTH_ETH) return null;

        // ═══ BTC Lead 强度 ═══
        const btcBuy = snap.btcBuyDelta;
        const btcSell = snap.btcSellDelta;
        const btcTotal = btcBuy + btcSell;
        if (btcTotal <= 0) return null;

        const btcBuyRatio = btcBuy / Math.max(btcSell, 0.001);
        const btcSellRatio = btcSell / Math.max(btcBuy, 0.001);

        // ═══ 15M 结构性参考线 ═══
        const { lowest2_15m, highest2_15m, prev15mHigh, prev15mLow } = ct;

        // ═══ 动态保证金 ═══
        const margin = getMargin(balance);

        // ═══════════════════════════════════════════════
        // 入场判定: 15M 结构性突破
        // ═══════════════════════════════════════════════

        // --- SHORT: 跌破最近 2 根 15M 最低价 + BTC 卖压主导 ---
        if (
            ALLOW_SHORT &&
            ethPrice < lowest2_15m &&
            btcSellRatio >= BTC_ENTRY_RATIO
        ) {
            this.lastTradeTs = now;
            const reason =
                `🐋 15M突破SHORT: $${ethPrice.toFixed(2)} < L2=${lowest2_15m.toFixed(2)} | ` +
                `BTC卖压=${btcSellRatio.toFixed(1)}x≥${BTC_ENTRY_RATIO}x | ` +
                `Guard=${prev15mHigh.toFixed(2)}+1.5pt`;
            log(reason);
            return {
                side: "short",
                price: ethPrice,
                margin,
                reason,
                targetSymbol: ETH_SYMBOL,
            };
        }

        // --- LONG: 突破最近 2 根 15M 最高价 + BTC 买压主导 ---
        if (
            ethPrice > highest2_15m &&
            btcBuyRatio >= BTC_ENTRY_RATIO
        ) {
            this.lastTradeTs = now;
            const reason =
                `🐋 15M突破LONG: $${ethPrice.toFixed(2)} > H2=${highest2_15m.toFixed(2)} | ` +
                `BTC买压=${btcBuyRatio.toFixed(1)}x≥${BTC_ENTRY_RATIO}x | ` +
                `Guard=${prev15mLow.toFixed(2)}-1.5pt`;
            log(reason);
            return {
                side: "long",
                price: ethPrice,
                margin,
                reason,
                targetSymbol: ETH_SYMBOL,
            };
        }

        return null;
    }
}
