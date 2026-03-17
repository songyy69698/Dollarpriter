/**
 * 💀 V80.3 THE REAPER — 高质量因果穿牆策略
 * ═══════════════════════════════════════════
 * P0: BTC 持续 3 秒 ≥10x 才触发（过滤噪音）
 * P1: ETH 已朝方向移动 ≥1pt（价格确认）
 * P2: 每小时最多 1 单（控制手续费）
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

// ═══ 仓位常量 ═══
const ABSOLUTE_MAX_QTY = 5.0;
const TITAN_BTC = 15.0;
const TITAN_WALL_MAX = 0.33;
const TITAN_FATIGUE_MAX = 0.30;
const SCOUT_BTC = 5.0;
const SLEEP_OVERRIDE_BTC = 25.0;

// ═══ P0: BTC 持续性 ═══
const BTC_PERSIST_SECONDS = 3;      // 需持续 3 秒
const BTC_PERSIST_THRESHOLD = 10.0; // 持续 ≥10x

// ═══ P1: ETH 价格确认 ═══
const ETH_CONFIRM_PT = 1.0;         // ETH 已朝方向移动 ≥1pt

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

    // ═══ BTC 持续性追踪器 ═══
    private btcHistory: { ts: number; buyR: number; sellR: number }[] = [];
    private ethPriceHistory: { ts: number; price: number }[] = [];

    getScanCount(): number { return this.scanCount; }
    get currentMode(): TimeMode { return this._currentMode; }
    get defenseMode(): boolean { return this._defenseMode; }
    set defenseMode(v: boolean) { this._defenseMode = v; }

    /**
     * P0: 检查 BTC 是否在过去 N 秒持续 ≥ threshold
     * 返回 "long" | "short" | null
     */
    private checkBtcPersistence(buyR: number, sellR: number): "long" | "short" | null {
        const now = Date.now();

        // 记录当前数据
        this.btcHistory.push({ ts: now, buyR, sellR });

        // 清理超过 10 秒的旧数据
        this.btcHistory = this.btcHistory.filter(h => now - h.ts < 10_000);

        // 检查过去 BTC_PERSIST_SECONDS(3s) 内的所有样本
        const cutoff = now - BTC_PERSIST_SECONDS * 1000;
        const recent = this.btcHistory.filter(h => h.ts >= cutoff);

        // 至少需要 3 个样本 (500ms 间隔 × 3s ≈ 6 个)
        if (recent.length < 3) return null;

        // 检查是否所有样本的 buyR 或 sellR 都 ≥ threshold
        const allBullish = recent.every(h => h.buyR >= BTC_PERSIST_THRESHOLD);
        const allBearish = recent.every(h => h.sellR >= BTC_PERSIST_THRESHOLD);

        if (allBullish) return "long";
        if (allBearish) return "short";
        return null;
    }

    /**
     * P1: 检查 ETH 是否已朝 side 方向移动 ≥ ETH_CONFIRM_PT
     */
    private checkEthConfirmation(currentPrice: number, side: "long" | "short"): boolean {
        const now = Date.now();

        // 记录
        this.ethPriceHistory.push({ ts: now, price: currentPrice });
        this.ethPriceHistory = this.ethPriceHistory.filter(h => now - h.ts < 10_000);

        // 取 3 秒前的价格
        const threeSAgo = this.ethPriceHistory.find(
            h => now - h.ts >= 2500 && now - h.ts <= 5000,
        );
        if (!threeSAgo) return false;

        const priceDelta = currentPrice - threeSAgo.price;

        if (side === "long" && priceDelta >= ETH_CONFIRM_PT) return true;
        if (side === "short" && priceDelta <= -ETH_CONFIRM_PT) return true;

        return false;
    }

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

        const instantVol = snap.ethInstantVol;
        if (instantVol < 50) return null;

        const l1Ask = snap.ethL1AskVol;
        const l1Bid = snap.ethL1BidVol;

        // ═══ BTC 比率 ═══
        const btcBuy = snap.btcBuyDelta;
        const btcSell = snap.btcSellDelta;
        if (btcBuy + btcSell <= 0) return null;
        const btcBuyRatio = btcBuy / Math.max(btcSell, 0.001);
        const btcSellRatio = btcSell / Math.max(btcBuy, 0.001);
        const btcLead = Math.max(btcBuyRatio, btcSellRatio);

        // ═══ P0: BTC 持续性检查 ═══
        const persistDir = this.checkBtcPersistence(btcBuyRatio, btcSellRatio);

        // ═══ 振幅疲劳仪 ═══
        ct.updateRealtimePrice(ethPrice);
        const fatigue = ct.getFatigue();

        // ═══ SLEEP: 除非 BTC > 25x ═══
        if (tmConfig.mode === "SLEEP") {
            if (btcLead < SLEEP_OVERRIDE_BTC) return null;
            log(`⚡ SLEEP 破例! BTC=${btcLead.toFixed(1)}x ≥ ${SLEEP_OVERRIDE_BTC}x`);
        }

        // ═══ 牆比 ═══
        const opposingWallLong = l1Ask / Math.max(l1Bid, 0.001);  // 低=利多
        const opposingWallShort = l1Bid / Math.max(l1Ask, 0.001); // 低=利空

        // ═══ 仓位决定 ═══
        let qty: number;
        let tier: string;

        if (this._defenseMode) {
            qty = 1.0; tier = "🛡️DEF";
        } else if (
            btcLead >= TITAN_BTC && fatigue < TITAN_FATIGUE_MAX &&
            persistDir !== null &&
            ((persistDir === "long" && opposingWallLong <= TITAN_WALL_MAX) ||
             (persistDir === "short" && opposingWallShort <= TITAN_WALL_MAX))
        ) {
            qty = 5.0; tier = "🐋TITAN";
        } else if (btcLead >= SCOUT_BTC && persistDir !== null) {
            qty = 1.5; tier = "⚡SCOUT";
        } else {
            return null; // 无持续 BTC 信号 = 不开枪
        }

        qty = Math.min(qty, ABSOLUTE_MAX_QTY);

        // 余额安全
        const reqMargin = (qty * ethPrice) / 200;
        if (reqMargin > balance * 0.3) {
            qty = Math.floor((balance * 0.3 * 200 / ethPrice) * 10) / 10;
            if (qty < 0.5) return null;
        }

        // ═══ fatigue > 70% → 禁开仓 ═══
        if (fatigue > FATIGUE_BLOCK_THRESHOLD) return null;

        // ═══ ANTIFAKE 模式 ═══
        if (tmConfig.mode === "ANTIFAKE") {
            const bp = instantVol / Math.max(l1Ask, 0.001);
            if (ethPrice > ct.prev15mHigh && bp < 1.5 && ALLOW_SHORT && persistDir === "short") {
                if (!this.checkEthConfirmation(ethPrice, "short")) return null;
                this.lastTradeTs = now;
                const r = `🎭 ANTIFAKE SHORT: $${ethPrice.toFixed(2)} | BTC持续${BTC_PERSIST_SECONDS}s | ${qty}ETH ${tier}`;
                log(r); return { side: "short", price: ethPrice, qty, reason: r, targetSymbol: ETH_SYMBOL };
            }
            if (ethPrice < ct.prev15mLow && bp < 1.5 && persistDir === "long") {
                if (!this.checkEthConfirmation(ethPrice, "long")) return null;
                this.lastTradeTs = now;
                const r = `🎭 ANTIFAKE LONG: $${ethPrice.toFixed(2)} | BTC持续${BTC_PERSIST_SECONDS}s | ${qty}ETH ${tier}`;
                log(r); return { side: "long", price: ethPrice, qty, reason: r, targetSymbol: ETH_SYMBOL };
            }
            return null;
        }

        if (!tmConfig.allowBreakout) return null;

        // ═══ P1: ETH 价格确认 ═══
        if (!this.checkEthConfirmation(ethPrice, persistDir!)) return null;

        // ═══ 穿牆入场 ═══
        const breakoutPower = persistDir === "long"
            ? instantVol / Math.max(l1Ask, 0.001)
            : instantVol / Math.max(l1Bid, 0.001);
        const wallSmash = btcLead >= 15;

        if (breakoutPower >= BREAKOUT_POWER_MIN || wallSmash) {
            this.lastTradeTs = now;
            const r = `${wallSmash ? "🐋" : "🚀"} ${persistDir!.toUpperCase()}: $${ethPrice.toFixed(2)} | ` +
                `BTC=${btcLead.toFixed(1)}x 持续${BTC_PERSIST_SECONDS}s ✅ | ETH确认+${ETH_CONFIRM_PT}pt ✅ | ` +
                `${qty}ETH ${tier} | [${tmConfig.mode}]`;
            log(r);
            return { side: persistDir!, price: ethPrice, qty, reason: r, targetSymbol: ETH_SYMBOL };
        }

        return null;
    }
}
