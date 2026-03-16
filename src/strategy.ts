/**
 * 🧬 V80-DEFIANCE — n-of-1 自适应穿牆狙击
 * ═══════════════════════════════════════════
 * 动态子弹 + ATR 灵敏度 + 时段模式 + 疲劳仪
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
    getTimeMode,
    type TimeMode,
} from "./config";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [strategy] ${msg}`);
}

/** ATR clamp 工具 */
function clamp(min: number, val: number, max: number): number {
    return Math.max(min, Math.min(val, max));
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
    private _defenseMode = false;         // 熔断器

    getScanCount(): number { return this.scanCount; }
    get currentMode(): TimeMode { return this._currentMode; }
    get defenseMode(): boolean { return this._defenseMode; }
    set defenseMode(v: boolean) { this._defenseMode = v; }

    /**
     * V80-DEFIANCE: 自适应穿牆狙击
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

        if (tmConfig.mode === "SLEEP") return null;

        // ═══ 基础检查 ═══
        if (now - this.lastTradeTs < COOLDOWN_MS) return null;
        if (!snap.connected || snap.price <= 0) return null;
        if (now - snap.priceTs > WS_LAG_MAX_MS) return null;

        const ethPrice = snap.ethPrice;
        if (ethPrice <= 0) return null;
        if (snap.ethSpread > MAX_SPREAD_POINTS) return null;
        if (snap.ethTop3Depth < MIN_DEPTH_ETH) return null;

        // ═══ 订单流数据 ═══
        const instantVol = snap.ethInstantVol;
        const l1Ask = snap.ethL1AskVol;
        const l1Bid = snap.ethL1BidVol;

        // ═══ ATR 动态灵敏度 ═══
        const atr = ct.atr15m;
        const dynamicBtcThreshold = atr > 0
            ? clamp(5.0, atr * 0.5, 15.0)
            : tmConfig.btcThreshold;

        // ═══ BTC Lead ═══
        const btcBuy = snap.btcBuyDelta;
        const btcSell = snap.btcSellDelta;
        if (btcBuy + btcSell <= 0) return null;
        const btcBuyRatio = btcBuy / Math.max(btcSell, 0.001);
        const btcSellRatio = btcSell / Math.max(btcBuy, 0.001);
        const btcLead = Math.max(btcBuyRatio, btcSellRatio);

        // ═══ 自适应子弹 (Dynamic Margin) ═══
        const trendAligned = ct.isTrendAligned();
        let margin: number;
        let marginMode: string;

        if (this._defenseMode) {
            // 熔断器: 防御模式
            margin = 20;
            marginMode = "🛡️DEFENSE";
        } else if (btcLead >= 12 && trendAligned) {
            margin = 100;
            marginMode = "🎯SNIPER";
        } else {
            margin = 30;
            marginMode = "⚡SCALP";
        }

        // 余额安全检查: margin 不超过余额的 25%
        if (margin > balance * 0.25) margin = Math.floor(balance * 0.25);
        if (margin < 10) return null; // 余额太低不开

        // ═══ 振幅疲劳仪 ═══
        ct.updateRealtimePrice(ethPrice);
        const fatigue = ct.getFatigue();

        // fatigue > 0.7 → 极值反转 or 禁开仓
        if (fatigue > FATIGUE_BLOCK_THRESHOLD) {
            if (fatigue > 0.9) {
                const pricePos = ct.getPricePosition(ethPrice);
                if (pricePos > 0.9 && ALLOW_SHORT) {
                    this.lastTradeTs = now;
                    const reason =
                        `🔄 DEFIANCE 极值反转SHORT: $${ethPrice.toFixed(2)} | ` +
                        `疲劳=${(fatigue * 100).toFixed(0)}% | ${marginMode} M=$${margin}`;
                    log(reason);
                    return { side: "short", price: ethPrice, margin, reason, targetSymbol: ETH_SYMBOL };
                }
                if (pricePos < 0.1) {
                    this.lastTradeTs = now;
                    const reason =
                        `🔄 DEFIANCE 极值反转LONG: $${ethPrice.toFixed(2)} | ` +
                        `疲劳=${(fatigue * 100).toFixed(0)}% | ${marginMode} M=$${margin}`;
                    log(reason);
                    return { side: "long", price: ethPrice, margin, reason, targetSymbol: ETH_SYMBOL };
                }
            }
            return null;
        }

        // ═══ ANTIFAKE: 假突破反转 ═══
        if (tmConfig.mode === "ANTIFAKE") {
            const prev15mH = ct.prev15mHigh;
            const prev15mL = ct.prev15mLow;
            const breakoutPower = instantVol / Math.max(l1Ask, 0.001);

            if (ethPrice > prev15mH && breakoutPower < 1.5 && ALLOW_SHORT) {
                this.lastTradeTs = now;
                const reason =
                    `🎭 ANTIFAKE SHORT: $${ethPrice.toFixed(2)} > 15mH 但量弱=${breakoutPower.toFixed(1)}x | ${marginMode} M=$${margin}`;
                log(reason);
                return { side: "short", price: ethPrice, margin, reason, targetSymbol: ETH_SYMBOL };
            }
            if (ethPrice < prev15mL && breakoutPower < 1.5) {
                this.lastTradeTs = now;
                const reason =
                    `🎭 ANTIFAKE LONG: $${ethPrice.toFixed(2)} < 15mL 但量弱=${breakoutPower.toFixed(1)}x | ${marginMode} M=$${margin}`;
                log(reason);
                return { side: "long", price: ethPrice, margin, reason, targetSymbol: ETH_SYMBOL };
            }
            return null;
        }

        if (!tmConfig.allowBreakout) return null;

        // ═══ 穿牆入场 (Dynamic BTC Threshold) ═══
        if (instantVol <= 0) return null;
        const wallRatio = l1Bid / Math.max(l1Ask, 0.001);

        // --- LONG ---
        const breakoutLong = instantVol / Math.max(l1Ask, 0.001);
        if (
            btcBuyRatio >= dynamicBtcThreshold &&
            breakoutLong >= BREAKOUT_POWER_MIN &&
            wallRatio > ENTRY_WALL_RATIO_LONG
        ) {
            this.lastTradeTs = now;
            const reason =
                `🚀 DEFIANCE穿牆LONG: $${ethPrice.toFixed(2)} | ` +
                `BTC=${btcBuyRatio.toFixed(1)}x≥${dynamicBtcThreshold.toFixed(1)}x | ` +
                `${marginMode} M=$${margin} | ATR=${atr.toFixed(1)} | [${tmConfig.mode}]`;
            log(reason);
            return { side: "long", price: ethPrice, margin, reason, targetSymbol: ETH_SYMBOL };
        }

        // --- SHORT ---
        const breakoutShort = instantVol / Math.max(l1Bid, 0.001);
        if (
            ALLOW_SHORT &&
            btcSellRatio >= dynamicBtcThreshold &&
            breakoutShort >= BREAKOUT_POWER_MIN &&
            wallRatio < ENTRY_WALL_RATIO_SHORT
        ) {
            this.lastTradeTs = now;
            const reason =
                `📉 DEFIANCE穿牆SHORT: $${ethPrice.toFixed(2)} | ` +
                `BTC=${btcSellRatio.toFixed(1)}x≥${dynamicBtcThreshold.toFixed(1)}x | ` +
                `${marginMode} M=$${margin} | ATR=${atr.toFixed(1)} | [${tmConfig.mode}]`;
            log(reason);
            return { side: "short", price: ethPrice, margin, reason, targetSymbol: ETH_SYMBOL };
        }

        return null;
    }
}
