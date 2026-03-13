/**
 * 🧠 SOL 狙击手策略引擎 v2.0
 * ═══════════════════════════════════════════════
 * 三模式进场:
 *   模式 A — SOL 独立狙击: 5.5x + efficiency > 1.5
 *   模式 B — BTC-SOL 联动共振: BTC 3.0x + SOL 2.5x
 *   模式 C — BTC 领路自动切换: BTC 3.5x → SOL vs ETH 效率比较
 */

import type { CausalSnapshot } from "./bitunix-ws";
import {
    IMBALANCE_RATIO, COOLDOWN_MS, WS_LAG_MAX_MS,
    MARGIN_DEFAULT, TRADE_HOUR_START, TRADE_HOUR_END,
    EFFICIENCY_ABS_THRESHOLD, ALLOW_SHORT,
    BTC_IMBALANCE_RATIO, SOL_RESONANCE_RATIO,
    BTC_AUTO_SWITCH_RATIO, SOL_MIN_EFFICIENCY, ETH_MIN_EFFICIENCY,
    SYMBOL, ETH_SYMBOL,
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
    targetSymbol: string;  // 实际执行的交易对
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

        const margin = MARGIN_DEFAULT;

        // ═══════════════════════════════════════════
        // 模式 C — BTC 领路自动切换 (最高优先级)
        // BTC 3.5x → 比较 SOL vs ETH 效率 → 选最优
        // ═══════════════════════════════════════════
        if (snap.btcConnected && snap.btcAskWallVol > 0) {
            const btcImbalance = snap.btcBuyDelta / snap.btcAskWallVol;

            if (btcImbalance > BTC_AUTO_SWITCH_RATIO) {
                const solEff = snap.efficiency;
                const ethEff = snap.ethEfficiency;

                // SOL 效率更高且超过门槛 → 狙击 SOL
                if (solEff > ethEff && solEff > SOL_MIN_EFFICIENCY) {
                    const reason =
                        `🚀 BTC领路→SOL: BTC=${btcImbalance.toFixed(2)}x | ` +
                        `SOL效率=${solEff.toFixed(4)} > ETH=${ethEff.toFixed(4)}`;
                    log(`🎯 ${reason}`);
                    this.lastSignalTs = now;
                    return { side: "long", price: snap.price, margin, reason, mode: "auto-switch", targetSymbol: SYMBOL };
                }

                // ETH 效率达标 (SOL 没反应) → 兜底做 ETH
                if (snap.ethConnected && ethEff > ETH_MIN_EFFICIENCY) {
                    const reason =
                        `💎 BTC领路→ETH: BTC=${btcImbalance.toFixed(2)}x | ` +
                        `ETH效率=${ethEff.toFixed(4)} > ${ETH_MIN_EFFICIENCY} (SOL=${solEff.toFixed(4)}不够)`;
                    log(`🎯 ${reason}`);
                    this.lastSignalTs = now;
                    return { side: "long", price: snap.ethPrice, margin, reason, mode: "auto-switch", targetSymbol: ETH_SYMBOL };
                }
            }
        }

        // BTC 领路做空 (BTC 卖压 3.5x) — 需 ALLOW_SHORT
        if (ALLOW_SHORT && snap.btcConnected && snap.btcBidWallVol > 0) {
            const btcSellImbalance = snap.btcSellDelta / snap.btcBidWallVol;

            if (btcSellImbalance > BTC_AUTO_SWITCH_RATIO) {
                const solEff = snap.efficiency;
                const ethEff = snap.ethEfficiency;

                if (solEff > ethEff && solEff > SOL_MIN_EFFICIENCY) {
                    const reason =
                        `🚀 BTC领路→SOL空: BTC卖=${btcSellImbalance.toFixed(2)}x | ` +
                        `SOL效率=${solEff.toFixed(4)} > ETH=${ethEff.toFixed(4)}`;
                    log(`🎯 ${reason}`);
                    this.lastSignalTs = now;
                    return { side: "short", price: snap.price, margin, reason, mode: "auto-switch", targetSymbol: SYMBOL };
                }

                if (snap.ethConnected && ethEff > ETH_MIN_EFFICIENCY) {
                    const reason =
                        `💎 BTC领路→ETH空: BTC卖=${btcSellImbalance.toFixed(2)}x | ` +
                        `ETH效率=${ethEff.toFixed(4)} > ${ETH_MIN_EFFICIENCY}`;
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
                const reason =
                    `🔥 联动多: BTC=${btcImbalance.toFixed(2)}x SOL=${solImbalance.toFixed(2)}x`;
                log(`🎯 ${reason}`);
                this.lastSignalTs = now;
                return { side: "long", price: snap.price, margin, reason, mode: "resonance", targetSymbol: SYMBOL };
            }
        }

        // 模式 B 做空 — 需 ALLOW_SHORT
        if (ALLOW_SHORT && snap.btcConnected && snap.btcBidWallVol > 0 && snap.bidWallVol > 0) {
            const btcSellImbalance = snap.btcSellDelta / snap.btcBidWallVol;
            const solSellImbalance = snap.sellDelta / snap.bidWallVol;

            if (btcSellImbalance > BTC_IMBALANCE_RATIO && solSellImbalance > SOL_RESONANCE_RATIO) {
                const reason =
                    `🔥 联动空: BTC=${btcSellImbalance.toFixed(2)}x SOL=${solSellImbalance.toFixed(2)}x`;
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
                const reason =
                    `🚀 狙击多: ${buyImbalance.toFixed(2)}x 效率=${snap.efficiency.toFixed(4)}`;
                log(`🎯 ${reason}`);
                this.lastSignalTs = now;
                return { side: "long", price: snap.price, margin, reason, mode: "sniper", targetSymbol: SYMBOL };
            }
        }

        // 模式 A 做空 — 需 ALLOW_SHORT
        if (ALLOW_SHORT && snap.bidWallVol > 0) {
            const sellImbalance = snap.sellDelta / snap.bidWallVol;
            if (
                sellImbalance > IMBALANCE_RATIO &&
                snap.efficiency > EFFICIENCY_ABS_THRESHOLD &&
                snap.efficiency > snap.avgEfficiency
            ) {
                const reason =
                    `🔻 狙击空: ${sellImbalance.toFixed(2)}x 效率=${snap.efficiency.toFixed(4)}`;
                log(`🎯 ${reason}`);
                this.lastSignalTs = now;
                return { side: "short", price: snap.price, margin, reason, mode: "sniper", targetSymbol: SYMBOL };
            }
        }

        return null;
    }
}
