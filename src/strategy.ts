/**
 * 🏁 V80.3 THE REAPER — 因果穿牆策略
 * ═══════════════════════════════════════════
 * 因: BTC失衡 + 牆弱 + 低疲劳 → 5 ETH 全速
 * 果: 高疲劳 + 吸能 → 立即收网
 */

import type { CausalSnapshot } from "./bitunix-ws";
import type { CandleTracker } from "./candles";
import {
    COOLDOWN_MS, WS_LAG_MAX_MS,
    ALLOW_SHORT,
    ETH_SYMBOL, MAX_SPREAD_POINTS, MIN_DEPTH_ETH,
    BREAKOUT_POWER_MIN,
    FATIGUE_BLOCK_THRESHOLD,
    getTimeMode,
    type TimeMode,
} from "./config";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [REAPER] ${msg}`);
}

function clamp(min: number, val: number, max: number): number {
    return Math.max(min, Math.min(val, max));
}

// ═══ V80.3 THE REAPER 常量 ═══
const ABSOLUTE_MAX_QTY = 5.0;
const TITAN_BTC_THRESHOLD = 15.0;   // 5 ETH 需 BTC ≥ 15x
const TITAN_WALL_MAX = 0.33;        // 5 ETH 需反向牆弱 ≤ 0.33
const TITAN_FATIGUE_MAX = 0.30;     // 5 ETH 需疲劳 < 30%
const SCOUT_BTC_MIN = 5.0;          // 1.5 ETH 最低 BTC 5x
const SLEEP_OVERRIDE_BTC = 25.0;    // SLEEP 破例: BTC > 25x

export interface CausalSignal {
    side: "long" | "short";
    price: number;
    qty: number;
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

        // ═══ 基础检查 ═══
        if (now - this.lastTradeTs < COOLDOWN_MS) return null;
        if (!snap.connected || snap.price <= 0) return null;
        if (now - snap.priceTs > WS_LAG_MAX_MS) return null;

        const ethPrice = snap.ethPrice;
        if (ethPrice <= 0) return null;
        if (snap.ethSpread > MAX_SPREAD_POINTS) return null;
        if (snap.ethTop3Depth < MIN_DEPTH_ETH) return null;

        // 流动性门槛
        const instantVol = snap.ethInstantVol;
        if (instantVol < 50) return null;

        const l1Ask = snap.ethL1AskVol;
        const l1Bid = snap.ethL1BidVol;

        // ═══ BTC Lead ═══
        const btcBuy = snap.btcBuyDelta;
        const btcSell = snap.btcSellDelta;
        if (btcBuy + btcSell <= 0) return null;
        const btcBuyRatio = btcBuy / Math.max(btcSell, 0.001);
        const btcSellRatio = btcSell / Math.max(btcBuy, 0.001);
        const btcLead = Math.max(btcBuyRatio, btcSellRatio);
        const isBullBtc = btcBuyRatio > btcSellRatio;

        // ═══ 振幅疲劳仪 ═══
        ct.updateRealtimePrice(ethPrice);
        const fatigue = ct.getFatigue();

        // ═══ SLEEP: 除非 BTC > 25x 极端信号 ═══
        if (tmConfig.mode === "SLEEP") {
            if (btcLead < SLEEP_OVERRIDE_BTC) return null;
            log(`⚡ SLEEP 破例! BTC=${btcLead.toFixed(1)}x ≥ ${SLEEP_OVERRIDE_BTC}x`);
        }

        // ═══ 反向牆比 (opposing wall) ═══
        // LONG: 卖牆弱 → ask/bid < 0.33 好
        // SHORT: 买牆弱 → bid/ask < 0.33 好
        const opposingWallLong = l1Ask / Math.max(l1Bid, 0.001);
        const opposingWallShort = l1Bid / Math.max(l1Ask, 0.001);

        // ════════════════════════════════════════════
        // CEO 因果法则: 确定 ETH 仓位
        // ════════════════════════════════════════════
        let qty: number;
        let tier: string;

        if (this._defenseMode) {
            qty = 1.0;
            tier = "🛡️DEF";
        } else if (
            btcLead >= TITAN_BTC_THRESHOLD &&
            fatigue < TITAN_FATIGUE_MAX &&
            ((isBullBtc && opposingWallLong <= TITAN_WALL_MAX) ||
             (!isBullBtc && opposingWallShort <= TITAN_WALL_MAX))
        ) {
            // ═══ 因: 三重条件 = 大段行情(30+pt) ═══
            qty = 5.0;
            tier = "🐋TITAN";
            log(`🎯 因果: BTC=${btcLead.toFixed(1)}x≥15 + 反向牆弱 + 疲劳${(fatigue*100).toFixed(0)}%<30% → 5.0ETH`);
        } else if (btcLead >= SCOUT_BTC_MIN) {
            // ═══ Scout: 探路 ═══
            qty = 1.5;
            tier = "⚡SCOUT";
        } else {
            return null; // BTC < 5x = 不开枪
        }

        qty = Math.min(qty, ABSOLUTE_MAX_QTY);

        // 余额安全
        const reqMargin = (qty * ethPrice) / 200;
        if (reqMargin > balance * 0.3) {
            qty = Math.floor((balance * 0.3 * 200 / ethPrice) * 10) / 10;
            if (qty < 0.5) return null;
        }

        // ═══ fatigue > 70% → 极值反转 or 禁开仓 ═══
        if (fatigue > FATIGUE_BLOCK_THRESHOLD) {
            if (fatigue > 0.9) {
                const pos = ct.getPricePosition(ethPrice);
                if (pos > 0.9 && ALLOW_SHORT) {
                    this.lastTradeTs = now;
                    const r = `🔄 极值SHORT: $${ethPrice.toFixed(2)} | 疲劳${(fatigue*100).toFixed(0)}% | ${qty}ETH ${tier}`;
                    log(r);
                    return { side: "short", price: ethPrice, qty, reason: r, targetSymbol: ETH_SYMBOL };
                }
                if (pos < 0.1) {
                    this.lastTradeTs = now;
                    const r = `🔄 极值LONG: $${ethPrice.toFixed(2)} | 疲劳${(fatigue*100).toFixed(0)}% | ${qty}ETH ${tier}`;
                    log(r);
                    return { side: "long", price: ethPrice, qty, reason: r, targetSymbol: ETH_SYMBOL };
                }
            }
            return null;
        }

        // ═══ ANTIFAKE: 假突破反转 ═══
        if (tmConfig.mode === "ANTIFAKE") {
            const bp = instantVol / Math.max(l1Ask, 0.001);
            if (ethPrice > ct.prev15mHigh && bp < 1.5 && ALLOW_SHORT) {
                this.lastTradeTs = now;
                const r = `🎭 ANTIFAKE SHORT: $${ethPrice.toFixed(2)} | ${qty}ETH ${tier}`;
                log(r); return { side: "short", price: ethPrice, qty, reason: r, targetSymbol: ETH_SYMBOL };
            }
            if (ethPrice < ct.prev15mLow && bp < 1.5) {
                this.lastTradeTs = now;
                const r = `🎭 ANTIFAKE LONG: $${ethPrice.toFixed(2)} | ${qty}ETH ${tier}`;
                log(r); return { side: "long", price: ethPrice, qty, reason: r, targetSymbol: ETH_SYMBOL };
            }
            return null;
        }

        if (!tmConfig.allowBreakout) return null;

        // ═══ 穿牆入场 ═══
        const breakoutLong = instantVol / Math.max(l1Ask, 0.001);
        const breakoutShort = instantVol / Math.max(l1Bid, 0.001);
        const wallSmash = btcLead >= 15;

        // LONG
        if (isBullBtc && btcBuyRatio >= SCOUT_BTC_MIN &&
            (breakoutLong >= BREAKOUT_POWER_MIN || wallSmash)) {
            this.lastTradeTs = now;
            const r = `${wallSmash ? "🐋" : "🚀"} LONG: $${ethPrice.toFixed(2)} | BTC=${btcBuyRatio.toFixed(1)}x | ${qty}ETH ${tier} | [${tmConfig.mode}]`;
            log(r); return { side: "long", price: ethPrice, qty, reason: r, targetSymbol: ETH_SYMBOL };
        }

        // SHORT
        if (ALLOW_SHORT && !isBullBtc && btcSellRatio >= SCOUT_BTC_MIN &&
            (breakoutShort >= BREAKOUT_POWER_MIN || wallSmash)) {
            this.lastTradeTs = now;
            const r = `${wallSmash ? "🐋" : "🚀"} SHORT: $${ethPrice.toFixed(2)} | BTC=${btcSellRatio.toFixed(1)}x | ${qty}ETH ${tier} | [${tmConfig.mode}]`;
            log(r); return { side: "short", price: ethPrice, qty, reason: r, targetSymbol: ETH_SYMBOL };
        }

        return null;
    }
}
