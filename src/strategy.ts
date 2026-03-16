/**
 * 🏁 V80.3 DYNAMIC POSITIONING — 固定 ETH 仓位
 * ═══════════════════════════════════════════
 * BTC Lead → 1.5/3.0/5.0 ETH | 绝对上限 5 ETH
 * ATR 动态门槛 + 时段模式 + 疲劳仪
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

function clamp(min: number, val: number, max: number): number {
    return Math.max(min, Math.min(val, max));
}

// ═══ V80.3 固定仓位规则 ═══
const ABSOLUTE_MAX_QTY = 5.0;   // ETH 绝对上限

/** 根据 BTC Lead 返回 ETH 数量 */
function getDynamicQty(btcLead: number): { qty: number; tier: string } {
    if (btcLead >= 15) return { qty: 5.0, tier: "🐋T3" };
    if (btcLead >= 10) return { qty: 3.0, tier: "🔥T2" };
    return { qty: 1.5, tier: "⚡T1" };
}

export interface CausalSignal {
    side: "long" | "short";
    price: number;
    qty: number;          // V80.3: 直接输出 ETH 数量
    reason: string;
    targetSymbol: string;
}

export class CausalStrategy {
    private lastTradeTs = 0;
    private scanCount = 0;
    private _currentMode: TimeMode = "SLEEP";
    private _defenseMode = false;

    getScanCount(): number { return this.scanCount; }
    get currentMode(): TimeMode { return this._currentMode; }
    get defenseMode(): boolean { return this._defenseMode; }
    set defenseMode(v: boolean) { this._defenseMode = v; }

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

        const instantVol = snap.ethInstantVol;
        const l1Ask = snap.ethL1AskVol;
        const l1Bid = snap.ethL1BidVol;

        // 流动性门槛: 瞬量 > 50
        if (instantVol < 50) return null;

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

        // ═══ V80.3 动态仓位 ═══
        const { qty: rawQty, tier } = getDynamicQty(btcLead);
        let qty = Math.min(rawQty, ABSOLUTE_MAX_QTY);

        // 防御模式: 强制 1.0 ETH
        if (this._defenseMode) qty = 1.0;

        // 余额安全: qty 对应的保证金 < 余额 30%
        const requiredMargin = (qty * ethPrice) / 200; // 200x
        if (requiredMargin > balance * 0.3) {
            qty = Math.floor((balance * 0.3 * 200 / ethPrice) * 10) / 10;
            if (qty < 0.5) return null; // 余额太低
        }

        // ═══ 振幅疲劳仪 ═══
        ct.updateRealtimePrice(ethPrice);
        const fatigue = ct.getFatigue();

        // fatigue > 0.7 → 极值反转 or 禁开仓
        if (fatigue > FATIGUE_BLOCK_THRESHOLD) {
            if (fatigue > 0.9) {
                const pricePos = ct.getPricePosition(ethPrice);
                if (pricePos > 0.9 && ALLOW_SHORT) {
                    this.lastTradeTs = now;
                    const reason = `🔄 极值SHORT: $${ethPrice.toFixed(2)} | 疲劳=${(fatigue*100).toFixed(0)}% | ${qty}ETH ${tier}`;
                    log(reason);
                    return { side: "short", price: ethPrice, qty, reason, targetSymbol: ETH_SYMBOL };
                }
                if (pricePos < 0.1) {
                    this.lastTradeTs = now;
                    const reason = `🔄 极值LONG: $${ethPrice.toFixed(2)} | 疲劳=${(fatigue*100).toFixed(0)}% | ${qty}ETH ${tier}`;
                    log(reason);
                    return { side: "long", price: ethPrice, qty, reason, targetSymbol: ETH_SYMBOL };
                }
            }
            return null;
        }

        // ═══ ANTIFAKE ═══
        if (tmConfig.mode === "ANTIFAKE") {
            const prev15mH = ct.prev15mHigh;
            const prev15mL = ct.prev15mLow;
            const bp = instantVol / Math.max(l1Ask, 0.001);
            if (ethPrice > prev15mH && bp < 1.5 && ALLOW_SHORT) {
                this.lastTradeTs = now;
                const reason = `🎭 ANTIFAKE SHORT: $${ethPrice.toFixed(2)} | ${qty}ETH ${tier}`;
                log(reason);
                return { side: "short", price: ethPrice, qty, reason, targetSymbol: ETH_SYMBOL };
            }
            if (ethPrice < prev15mL && bp < 1.5) {
                this.lastTradeTs = now;
                const reason = `🎭 ANTIFAKE LONG: $${ethPrice.toFixed(2)} | ${qty}ETH ${tier}`;
                log(reason);
                return { side: "long", price: ethPrice, qty, reason, targetSymbol: ETH_SYMBOL };
            }
            return null;
        }

        if (!tmConfig.allowBreakout) return null;
        if (instantVol <= 0) return null;
        const wallRatio = l1Bid / Math.max(l1Ask, 0.001);

        // --- LONG ---
        const breakoutLong = instantVol / Math.max(l1Ask, 0.001);
        const wallSmashLong = btcBuyRatio >= 15;
        if (
            btcBuyRatio >= dynamicBtcThreshold &&
            (breakoutLong >= BREAKOUT_POWER_MIN || wallSmashLong) &&
            (wallRatio > ENTRY_WALL_RATIO_LONG || wallSmashLong)
        ) {
            this.lastTradeTs = now;
            const tag = wallSmashLong ? "🐋" : "🚀";
            const reason = `${tag} LONG: $${ethPrice.toFixed(2)} | BTC=${btcBuyRatio.toFixed(1)}x | ${qty}ETH ${tier} | ATR=${atr.toFixed(1)} | [${tmConfig.mode}]`;
            log(reason);
            return { side: "long", price: ethPrice, qty, reason, targetSymbol: ETH_SYMBOL };
        }

        // --- SHORT ---
        const breakoutShort = instantVol / Math.max(l1Bid, 0.001);
        const wallSmashShort = btcSellRatio >= 15;
        if (
            ALLOW_SHORT &&
            btcSellRatio >= dynamicBtcThreshold &&
            (breakoutShort >= BREAKOUT_POWER_MIN || wallSmashShort) &&
            (wallRatio < ENTRY_WALL_RATIO_SHORT || wallSmashShort)
        ) {
            this.lastTradeTs = now;
            const tag = wallSmashShort ? "🐋" : "🚀";
            const reason = `${tag} SHORT: $${ethPrice.toFixed(2)} | BTC=${btcSellRatio.toFixed(1)}x | ${qty}ETH ${tier} | ATR=${atr.toFixed(1)} | [${tmConfig.mode}]`;
            log(reason);
            return { side: "short", price: ethPrice, qty, reason, targetSymbol: ETH_SYMBOL };
        }

        return null;
    }
}
