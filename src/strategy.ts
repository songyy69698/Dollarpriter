/**
 * 🧠 V52.4 "Logic Leader" — 策略引擎
 * ═══════════════════════════════════════════════
 * 双条件入场 (Proportional Entry):
 *   条件 A: BTC >= 4.0x + ETH效率 >= 1.0 (BTC强力驱动)
 *   条件 B: BTC >= 2.5x + ETH效率 >= 2.0 (ETH强效率驱动)
 *
 * + Spread/Liquidity Gate + CVD 方向一致性
 */

import type { CausalSnapshot } from "./bitunix-ws";
import {
    IMBALANCE_RATIO, COOLDOWN_MS, WS_LAG_MAX_MS,
    MARGIN_DEFAULT, TRADE_HOUR_START, TRADE_HOUR_END,
    EFFICIENCY_ABS_THRESHOLD, ALLOW_SHORT,
    BTC_IMBALANCE_RATIO, SOL_RESONANCE_RATIO,
    BTC_LEAD_STRONG, ETH_EFF_WITH_STRONG_BTC,
    BTC_LEAD_WEAK, ETH_EFF_WITH_WEAK_BTC,
    SOL_MIN_EFFICIENCY, ETH_MIN_EFFICIENCY,
    SYMBOL, ETH_SYMBOL, MAX_SPREAD_POINTS,
    MIN_DEPTH_ETH, CVD_CONFIRM_TICKS,
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
    mode: "sniper" | "resonance" | "auto-switch";
    targetSymbol: string;
}

/** CVD 方向一致性检查 */
function checkCvdDirection(dirs: number[], side: "long" | "short", n: number): boolean {
    if (dirs.length < n) return false;
    const recent = dirs.slice(-n);
    if (side === "long") return recent.every(d => d > 0);
    return recent.every(d => d < 0);
}

/**
 * V52.4: 双条件 BTC Lead 检查 (Proportional Entry)
 * 条件 A: BTC >= 4.0x + ETH效率 >= 1.0
 * 条件 B: BTC >= 2.5x + ETH效率 >= 2.0
 * 返回触发的条件标签，或 null
 */
function checkProportionalEntry(btcRatio: number, ethEff: number): string | null {
    if (btcRatio >= BTC_LEAD_STRONG && ethEff >= ETH_EFF_WITH_STRONG_BTC) {
        return `A:BTC${btcRatio.toFixed(1)}x≥${BTC_LEAD_STRONG}+ETHeff${ethEff.toFixed(2)}≥${ETH_EFF_WITH_STRONG_BTC}`;
    }
    if (btcRatio >= BTC_LEAD_WEAK && ethEff >= ETH_EFF_WITH_WEAK_BTC) {
        return `B:BTC${btcRatio.toFixed(1)}x≥${BTC_LEAD_WEAK}+ETHeff${ethEff.toFixed(2)}≥${ETH_EFF_WITH_WEAK_BTC}`;
    }
    return null;
}

export class CausalStrategy {
    private lastSignalTs = 0;
    private scanCount = 0;

    getScanCount(): number { return this.scanCount; }

    evaluate(snap: CausalSnapshot): CausalSignal | null {
        const now = Date.now();
        this.scanCount++;

        // ── 冷却 ──
        if (now - this.lastSignalTs < COOLDOWN_MS) return null;

        // ── 基础健康 ──
        if (!snap.connected || snap.price <= 0) return null;
        if (now - snap.priceTs > WS_LAG_MAX_MS) return null;

        // ── 时段限制 ──
        const utcHour = new Date().getUTCHours();
        if (utcHour < TRADE_HOUR_START || utcHour >= TRADE_HOUR_END) return null;

        // ── 盘口数据就绪 ──
        if (snap.askWallVol <= 0 && snap.bidWallVol <= 0) return null;
        if (snap.avgEfficiency <= 0) return null;

        // ── Spread Guard ──
        if (snap.spread > MAX_SPREAD_POINTS) return null;

        const margin = MARGIN_DEFAULT;

        // ═══════════════════════════════════════════
        // 模式 C — V52.4 双条件 BTC 领路 (最高优先级)
        // 条件 A: BTC >= 4.0x + ETH效率 >= 1.0
        // 条件 B: BTC >= 2.5x + ETH效率 >= 2.0
        // ═══════════════════════════════════════════

        // ── 做多 ──
        if (snap.btcConnected && snap.btcAskWallVol > 0) {
            const btcImbalance = snap.btcBuyDelta / snap.btcAskWallVol;
            const ethEff = snap.ethEfficiency;
            const solEff = snap.efficiency;

            const proportional = checkProportionalEntry(btcImbalance, ethEff);
            if (proportional) {
                // SOL 效率更高 → 狙击 SOL
                if (solEff > ethEff && solEff > SOL_MIN_EFFICIENCY) {
                    if (!checkCvdDirection(snap.recentDeltaDirs, "long", CVD_CONFIRM_TICKS)) return null;
                    const reason = `🚀 BTC领路→SOL [${proportional}] | SOLeff=${solEff.toFixed(4)} CVD✅`;
                    log(`🎯 ${reason}`);
                    this.lastSignalTs = now;
                    return { side: "long", price: snap.price, margin, reason, mode: "auto-switch", targetSymbol: SYMBOL };
                }

                // ETH 效率达标 → 做 ETH
                if (snap.ethConnected && ethEff >= ETH_MIN_EFFICIENCY) {
                    if (snap.ethSpread > MAX_SPREAD_POINTS) {
                        log(`⛔ ETH Spread Gate: ${snap.ethSpread.toFixed(3)}pt > ${MAX_SPREAD_POINTS}`);
                        return null;
                    }
                    if (snap.ethTop3Depth < MIN_DEPTH_ETH) {
                        log(`⛔ ETH Depth Gate: Top3=${snap.ethTop3Depth.toFixed(1)} < ${MIN_DEPTH_ETH} ETH`);
                        return null;
                    }
                    if (!checkCvdDirection(snap.ethRecentDeltaDirs, "long", CVD_CONFIRM_TICKS)) return null;
                    const reason = `💎 BTC领路→ETH [${proportional}] | Sp=${snap.ethSpread.toFixed(3)} CVD✅`;
                    log(`🎯 ${reason}`);
                    this.lastSignalTs = now;
                    return { side: "long", price: snap.ethPrice, margin, reason, mode: "auto-switch", targetSymbol: ETH_SYMBOL };
                }
            }
        }

        // ── 做空 (BTC 卖压) ──
        if (ALLOW_SHORT && snap.btcConnected && snap.btcBidWallVol > 0) {
            const btcSellImbalance = snap.btcSellDelta / snap.btcBidWallVol;
            const ethEff = snap.ethEfficiency;
            const solEff = snap.efficiency;

            const proportional = checkProportionalEntry(btcSellImbalance, ethEff);
            if (proportional) {
                if (solEff > ethEff && solEff > SOL_MIN_EFFICIENCY) {
                    if (!checkCvdDirection(snap.recentDeltaDirs, "short", CVD_CONFIRM_TICKS)) return null;
                    const reason = `🚀 BTC领路→SOL空 [${proportional}] | SOLeff=${solEff.toFixed(4)} CVD✅`;
                    log(`🎯 ${reason}`);
                    this.lastSignalTs = now;
                    return { side: "short", price: snap.price, margin, reason, mode: "auto-switch", targetSymbol: SYMBOL };
                }

                if (snap.ethConnected && ethEff >= ETH_MIN_EFFICIENCY) {
                    if (snap.ethSpread > MAX_SPREAD_POINTS) return null;
                    if (snap.ethTop3Depth < MIN_DEPTH_ETH) return null;
                    if (!checkCvdDirection(snap.ethRecentDeltaDirs, "short", CVD_CONFIRM_TICKS)) return null;
                    const reason = `💎 BTC领路→ETH空 [${proportional}] | Sp=${snap.ethSpread.toFixed(3)} CVD✅`;
                    log(`🎯 ${reason}`);
                    this.lastSignalTs = now;
                    return { side: "short", price: snap.ethPrice, margin, reason, mode: "auto-switch", targetSymbol: ETH_SYMBOL };
                }
            }
        }

        // ═══════════════════════════════════════════
        // 模式 B — BTC-SOL 联动共振
        // ═══════════════════════════════════════════
        if (snap.btcConnected && snap.btcAskWallVol > 0 && snap.askWallVol > 0) {
            const btcImbalance = snap.btcBuyDelta / snap.btcAskWallVol;
            const solImbalance = snap.buyDelta / snap.askWallVol;

            if (btcImbalance > BTC_IMBALANCE_RATIO && solImbalance > SOL_RESONANCE_RATIO) {
                if (!checkCvdDirection(snap.recentDeltaDirs, "long", CVD_CONFIRM_TICKS)) return null;
                const reason = `🔥 联动多: BTC=${btcImbalance.toFixed(2)}x SOL=${solImbalance.toFixed(2)}x | CVD✅`;
                log(`🎯 ${reason}`);
                this.lastSignalTs = now;
                return { side: "long", price: snap.price, margin, reason, mode: "resonance", targetSymbol: SYMBOL };
            }
        }

        if (ALLOW_SHORT && snap.btcConnected && snap.btcBidWallVol > 0 && snap.bidWallVol > 0) {
            const btcSellImbalance = snap.btcSellDelta / snap.btcBidWallVol;
            const solSellImbalance = snap.sellDelta / snap.bidWallVol;

            if (btcSellImbalance > BTC_IMBALANCE_RATIO && solSellImbalance > SOL_RESONANCE_RATIO) {
                if (!checkCvdDirection(snap.recentDeltaDirs, "short", CVD_CONFIRM_TICKS)) return null;
                const reason = `🔥 联动空: BTC=${btcSellImbalance.toFixed(2)}x SOL=${solSellImbalance.toFixed(2)}x | CVD✅`;
                log(`🎯 ${reason}`);
                this.lastSignalTs = now;
                return { side: "short", price: snap.price, margin, reason, mode: "resonance", targetSymbol: SYMBOL };
            }
        }

        // ═══════════════════════════════════════════
        // 模式 A — SOL 独立狙击: 5.5x + 效率双重校验
        // ═══════════════════════════════════════════
        if (snap.askWallVol > 0) {
            const buyImbalance = snap.buyDelta / snap.askWallVol;
            if (
                buyImbalance > IMBALANCE_RATIO &&
                snap.efficiency > EFFICIENCY_ABS_THRESHOLD &&
                snap.efficiency > snap.avgEfficiency
            ) {
                if (!checkCvdDirection(snap.recentDeltaDirs, "long", CVD_CONFIRM_TICKS)) return null;
                const reason = `🚀 狙击多: ${buyImbalance.toFixed(2)}x 效率=${snap.efficiency.toFixed(4)} | CVD✅`;
                log(`🎯 ${reason}`);
                this.lastSignalTs = now;
                return { side: "long", price: snap.price, margin, reason, mode: "sniper", targetSymbol: SYMBOL };
            }
        }

        if (ALLOW_SHORT && snap.bidWallVol > 0) {
            const sellImbalance = snap.sellDelta / snap.bidWallVol;
            if (
                sellImbalance > IMBALANCE_RATIO &&
                snap.efficiency > EFFICIENCY_ABS_THRESHOLD &&
                snap.efficiency > snap.avgEfficiency
            ) {
                if (!checkCvdDirection(snap.recentDeltaDirs, "short", CVD_CONFIRM_TICKS)) return null;
                const reason = `🔻 狙击空: ${sellImbalance.toFixed(2)}x 效率=${snap.efficiency.toFixed(4)} | CVD✅`;
                log(`🎯 ${reason}`);
                this.lastSignalTs = now;
                return { side: "short", price: snap.price, margin, reason, mode: "sniper", targetSymbol: SYMBOL };
            }
        }

        return null;
    }
}
