/**
 * ⚡ Bitunix 执行器 — V52.4 "Logic Leader"
 * ═══════════════════════════════════════════
 * MARKET 入场 (IOC) + Fee Shield 5pt + 15s持仓保护
 * 硬止损 8pt / 硬止盈 25pt / 20分钟超时
 */

import {
    BITUNIX_BASE, SYMBOL, LEVERAGE,
    SL_POINTS, TP_POINTS, FEE_SHIELD_POINTS, HARD_TIMEOUT_MS, MIN_HOLD_MS,
    TAKER_FEE, SYMBOL_PRECISION,
    DUMP_EFF_THRESHOLD, DUMP_VOL_MULT,
} from "./config";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [exec] ${msg}`);
}

function genOrderTag(): string {
    return `SN_${Date.now()}`;
}

/** 根据交易对获取精度 */
function getPrecision(symbol: string): { qty: number; price: number } {
    return SYMBOL_PRECISION[symbol] || SYMBOL_PRECISION[SYMBOL] || { qty: 1, price: 3 };
}

export class BitunixExecutor {
    private apiKey: string;
    private secretKey: string;

    inPosition = false;
    positionSide: "long" | "short" | "" = "";
    positionSymbol = "";       // 当前持仓的交易对
    entryPrice = 0;
    positionQty = 0;
    entryTs = 0;
    positionId = "";
    orderTag = "";

    private slOrderId = "";
    private currentSlPrice = 0;

    tradeLog: any[] = [];

    constructor(apiKey: string, secretKey: string) {
        this.apiKey = apiKey;
        this.secretKey = secretKey;
    }

    // ═══ 签名 ═══
    private sign(queryParams = "", body = ""): Record<string, string> {
        const nonce = crypto.randomUUID().replace(/-/g, "");
        const timestamp = Date.now().toString();
        const digestInput = nonce + timestamp + this.apiKey + queryParams + body;
        const digest = new Bun.CryptoHasher("sha256").update(digestInput).digest("hex");
        const signature = new Bun.CryptoHasher("sha256").update(digest + this.secretKey).digest("hex");
        return { "api-key": this.apiKey, sign: signature, nonce, timestamp };
    }

    // ═══ V52.2: MARKET 入场 (IOC) — 确保执行力 ═══
    async atomicEntry(
        side: "long" | "short",
        currentPrice: number,
        margin: number,
        targetSymbol: string = SYMBOL,
        onDepthFail?: (msg: string) => Promise<void>,
    ): Promise<boolean> {
        if (this.inPosition) return false;

        const prec = getPrecision(targetSymbol);
        const qty = +((margin * LEVERAGE) / currentPrice).toFixed(prec.qty);
        if (qty <= 0) return false;

        const tag = genOrderTag();
        const coinName = targetSymbol.replace("USDT", "");

        // V52.2: MARKET 入场 + IOC — CEO 要求确保入场执行力
        const orderData: Record<string, string> = {
            symbol: targetSymbol,
            side: side === "long" ? "BUY" : "SELL",
            orderType: "MARKET",
            qty: qty.toString(),
            tradeSide: "OPEN",
            effect: "IOC",            // V52.2: IOC 即时成交或撤单
            clientId: tag,
        };

        const t0 = performance.now();
        const result = await this.postOrder(orderData);
        const ms = performance.now() - t0;

        if (!result) {
            log(`❌ MARKET 开仓失败 [${targetSymbol}]`);
            if (onDepthFail) {
                await onDepthFail(`❌ MARKET 开仓失败 [${coinName}]`);
            }
            return false;
        }

        const filledQty = +(result?.filledQty || result?.filled_qty || result?.executedQty || qty);
        const filledPrice = +(result?.filledPrice || result?.filled_price || result?.avgPrice || result?.price || currentPrice);
        const actualPrice = filledPrice > 0 ? filledPrice : currentPrice;
        const actualQty = filledQty > 0 ? filledQty : qty;

        log(`✅ MARKET ${side.toUpperCase()} ${actualQty} ${coinName} @ ${actualPrice.toFixed(prec.price)} [${targetSymbol}] (${ms.toFixed(0)}ms)`);

        this.inPosition = true;
        this.positionSide = side;
        this.positionSymbol = targetSymbol;
        this.entryPrice = actualPrice;
        this.positionQty = actualQty;
        this.entryTs = Date.now();
        this.orderTag = tag;

        // Atomic SL — 固定 8 点止损 (STOP_MARKET, GTC)
        const slPrice = side === "long"
            ? actualPrice - SL_POINTS
            : actualPrice + SL_POINTS;
        this.currentSlPrice = slPrice;

        const slOk = await this.placeStopMarket(
            targetSymbol, side === "long" ? "SELL" : "BUY", actualQty, slPrice, prec,
        );
        if (slOk) log(`🛡️ Atomic SL: ${slPrice.toFixed(prec.price)} (-${SL_POINTS}pt)`);
        else log("⚠️ Atomic SL 挂单失败! 软件层保护");

        return true;
    }

    // ═══ STOP_MARKET ═══
    private async placeStopMarket(
        symbol: string, closeSide: string, qty: number, triggerPrice: number,
        prec: { qty: number; price: number },
    ): Promise<boolean> {
        const data: Record<string, string> = {
            symbol,
            side: closeSide,
            orderType: "STOP_MARKET",
            qty: qty.toFixed(prec.qty),
            tradeSide: "CLOSE",
            effect: "GTC",
            triggerPrice: triggerPrice.toFixed(prec.price),
            stopType: "LAST",
        };
        if (this.positionId) data.positionId = this.positionId;

        const result = await this.postOrder(data);
        if (result) {
            this.slOrderId = result?.orderId || result?.order_id || "";
            return true;
        }
        return false;
    }

    // ═══ V52.2 出场逻辑: Fee Shield + 硬 SL/TP + 20min 超时 ═══
    async checkPosition(
        currentPrice: number,
        efficiencyDecay: boolean,
        recentVol: number,
        avgVol: number,
        efficiency: number,
    ): Promise<{ closed: boolean; reason: string; netPnlU: number; symbol: string }> {
        if (!this.inPosition) return { closed: false, reason: "", netPnlU: 0, symbol: "" };

        const prec = getPrecision(this.positionSymbol);
        const sym = this.positionSymbol;

        const pnlPt = this.positionSide === "long"
            ? currentPrice - this.entryPrice
            : this.entryPrice - currentPrice;

        const elapsed = Date.now() - this.entryTs;
        const holdSafe = elapsed >= MIN_HOLD_MS;  // V52.4: 15秒保护期
        let reason = "";

        // ═══ Layer 1: 硬止损 — 永远有效，8pt ═══
        if (pnlPt <= -SL_POINTS) {
            reason = `📉 硬止损: ${pnlPt.toFixed(prec.price)}pt (SL=${SL_POINTS}pt)`;
        }

        // ═══ Layer 2: 硬止盈 — 25pt 100% 平仓 ═══
        if (!reason && pnlPt >= TP_POINTS) {
            reason = `💰 硬止盈: +${pnlPt.toFixed(prec.price)}pt (TP=${TP_POINTS}pt)`;
        }

        // ═══ Layer 3: 20 分钟硬超时 — 无条件平仓 ═══
        if (!reason && elapsed >= HARD_TIMEOUT_MS) {
            reason = `⏰ 超时平仓: ${(elapsed / 60_000).toFixed(1)}min (limit=20min) ${pnlPt >= 0 ? "+" : ""}${pnlPt.toFixed(prec.price)}pt`;
        }

        // ═══ 以下出场受 双重保护: holdSafe(15s) + FeeShield(5pt) ═══

        // Layer 4: 放量倒货止盈 — 15s + Fee Shield 5pt
        if (!reason && holdSafe && efficiency < DUMP_EFF_THRESHOLD && recentVol > avgVol * DUMP_VOL_MULT && pnlPt >= FEE_SHIELD_POINTS) {
            reason = `💰 放量倒货 [15s✅+FeeShield✅]: eff=${efficiency.toFixed(4)}<${DUMP_EFF_THRESHOLD} +${pnlPt.toFixed(prec.price)}pt`;
        }

        // Layer 5: 效率衰竭止盈 — 15s + Fee Shield 5pt
        if (!reason && holdSafe && efficiencyDecay && pnlPt >= FEE_SHIELD_POINTS) {
            reason = `💰 效率衰竭 [15s✅+FeeShield✅]: +${pnlPt.toFixed(prec.price)}pt`;
        }

        // ═══ 执行平仓 ═══
        if (reason) {
            if (this.slOrderId) await this.cancelOrder(this.positionSymbol, this.slOrderId);
            const closeSide = this.positionSide === "long" ? "SELL" : "BUY";
            const ok = await this.closePosition(this.positionSymbol, closeSide, this.positionQty, prec);
            if (ok) {
                const gross = pnlPt * this.positionQty;
                const fee = (this.entryPrice * this.positionQty + currentPrice * this.positionQty) * TAKER_FEE;
                const net = gross - fee;
                const emoji = net > 0 ? "✅" : "❌";
                const holdSec = (elapsed / 1000).toFixed(1);
                log(`${emoji} [${sym}] ${reason} | 持仓${holdSec}s | 净PnL: ${net >= 0 ? "+" : ""}${net.toFixed(2)}U`);
                this.logTrade(reason, pnlPt, net);
                const netPnl = net;
                this.resetPosition();
                return { closed: true, reason, netPnlU: netPnl, symbol: sym };
            }
        }

        return { closed: false, reason: "", netPnlU: 0, symbol: "" };
    }

    // ═══ 余额 ═══
    async getBalance(): Promise<number> {
        const queryStr = "marginCoinUSDT";
        const headers = this.sign(queryStr);
        try {
            const res = await fetch(`${BITUNIX_BASE}/api/v1/futures/account?marginCoin=USDT`, {
                headers: { ...headers, "Content-Type": "application/json", language: "en-US" },
            });
            const data = (await res.json()) as any;
            return String(data?.code) === "0" ? +(data?.data?.available ?? 0) : 0;
        } catch { return 0; }
    }

    // ═══ 仓位同步 ═══
    async syncPositions(): Promise<boolean> {
        const sym = this.positionSymbol || SYMBOL;
        try {
            const queryStr = "symbol" + sym;
            const headers = this.sign(queryStr);
            const res = await fetch(
                `${BITUNIX_BASE}/api/v1/futures/position/get_pending_positions?symbol=${sym}`,
                { headers: { ...headers, "Content-Type": "application/json", language: "en-US" } },
            );
            const data = (await res.json()) as any;
            if (String(data?.code) !== "0") {
                log(`⚠️ syncPositions: code=${data?.code} msg=${data?.msg}`);
                return false;
            }
            const positions = (data?.data ?? []).filter(
                (p: any) => (p.symbol || "").toUpperCase() === sym,
            );

            if (positions.length > 0 && this.inPosition) {
                const myPos = positions.find((p: any) => {
                    const side = String(p.side).toUpperCase();
                    return (
                        (this.positionSide === "long" && side === "BUY") ||
                        (this.positionSide === "short" && side === "SELL")
                    );
                });
                if (myPos?.positionId) this.positionId = String(myPos.positionId);
            } else if (positions.length === 0 && this.inPosition) {
                log("⚠️ 仓位已被关闭 (STOP_MARKET 可能已触发)");
                this.resetPosition();
            }
            return true;
        } catch (e) {
            log(`syncPositions 异常: ${e}`);
            return false;
        }
    }

    // ═══ 强制平仓 ═══
    async forceCloseAll(currentPrice: number): Promise<{ ok: boolean; netPnlU: number }> {
        if (!this.inPosition) return { ok: false, netPnlU: 0 };

        const prec = getPrecision(this.positionSymbol);
        if (this.slOrderId) await this.cancelOrder(this.positionSymbol, this.slOrderId);
        const closeSide = this.positionSide === "long" ? "SELL" : "BUY";
        const ok = await this.closePosition(this.positionSymbol, closeSide, this.positionQty, prec);
        if (!ok) return { ok: false, netPnlU: 0 };
        const pnl =
            this.positionSide === "long"
                ? currentPrice - this.entryPrice
                : this.entryPrice - currentPrice;
        const fee = (this.entryPrice * this.positionQty + currentPrice * this.positionQty) * TAKER_FEE;
        const net = pnl * this.positionQty - fee;
        log(`🔴 强平 [${this.positionSymbol}] 净PnL: ${net.toFixed(2)}U`);
        this.logTrade("强制平仓", pnl, net);
        this.resetPosition();
        return { ok: true, netPnlU: net };
    }

    // ═══ API ═══
    private async postOrder(data: Record<string, string>): Promise<any> {
        const sorted: Record<string, string> = {};
        for (const key of Object.keys(data).sort()) sorted[key] = data[key];
        const body = JSON.stringify(sorted);
        const headers = this.sign("", body);
        try {
            const res = await fetch(`${BITUNIX_BASE}/api/v1/futures/trade/place_order`, {
                method: "POST",
                headers: { ...headers, "Content-Type": "application/json", language: "en-US" },
                body,
            });
            const result = (await res.json()) as any;
            if (String(result?.code) === "0") {
                if (result?.data?.positionId) this.positionId = String(result.data.positionId);
                return result.data;
            }
            log(`下单错误: ${JSON.stringify(result)}`);
            return null;
        } catch (e) {
            log(`下单异常: ${e}`);
            return null;
        }
    }

    private async closePosition(
        symbol: string, closeSide: string, qty: number,
        prec: { qty: number; price: number },
    ): Promise<boolean> {
        const data: Record<string, string> = {
            symbol,
            side: closeSide,
            orderType: "MARKET",
            qty: qty.toFixed(prec.qty),
            tradeSide: "CLOSE",
            effect: "GTC",
        };
        if (this.positionId) data.positionId = this.positionId;
        return (await this.postOrder(data)) !== null;
    }

    async cancelOrder(symbol: string, orderId: string): Promise<boolean> {
        if (!orderId) return false;
        const body = JSON.stringify({ orderId, symbol });
        const headers = this.sign("", body);
        try {
            const res = await fetch(`${BITUNIX_BASE}/api/v1/futures/trade/cancel_order`, {
                method: "POST",
                headers: { ...headers, "Content-Type": "application/json", language: "en-US" },
                body,
            });
            const data = (await res.json()) as any;
            return String(data?.code) === "0";
        } catch { return false; }
    }

    private resetPosition() {
        this.inPosition = false;
        this.positionSide = "";
        this.positionSymbol = "";
        this.entryPrice = 0;
        this.positionQty = 0;
        this.positionId = "";
        this.orderTag = "";
        this.slOrderId = "";
        this.currentSlPrice = 0;
    }

    private logTrade(reason: string, pnlPt: number, netPnlU: number) {
        const prec = getPrecision(this.positionSymbol);
        this.tradeLog.push({
            ts: new Date().toISOString(),
            symbol: this.positionSymbol,
            side: this.positionSide,
            entry: this.entryPrice,
            pnlPt: +pnlPt.toFixed(prec.price),
            netPnlU: +netPnlU.toFixed(2),
            reason,
            tag: this.orderTag,
        });
    }
}
