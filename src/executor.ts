/**
 * ⚡ Bitunix 执行器 — SOL 狙击手 v2.0
 * ═══════════════════════════════════════════
 * 支持动态交易对切换 (SOL/ETH)
 * 6 层出场防御: 惯性/止损/保本/倒货/衰竭/保本回落
 */

import {
    BITUNIX_BASE, SYMBOL, LEVERAGE,
    STOP_LOSS_PCT, BE_TARGET_PCT,
    TAKER_FEE, SYMBOL_PRECISION, MIN_PROFIT_FOR_DECAY,
    MOMENTUM_CHECK_MS, MOMENTUM_MIN_PCT,
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
    private beTriggered = false;

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

    // ═══ 原子入场 — IOC 防滑价 + 动态交易对 ═══
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
        const orderData: Record<string, string> = {
            symbol: targetSymbol,
            side: side === "long" ? "BUY" : "SELL",
            orderType: "MARKET",
            qty: qty.toString(),
            tradeSide: "OPEN",
            effect: "IOC",          // 【关键】立即成交否则取消, 防深度不足滑价
            clientId: tag,
        };

        const t0 = performance.now();
        const result = await this.postOrder(orderData);
        const ms = performance.now() - t0;

        if (!result) {
            log(`❌ IOC 开仓失败 [${targetSymbol}]`);
            return false;
        }

        // 【关键】检查成交状态 — IOC 可能因深度不足被取消
        const status = String(result?.status || result?.orderStatus || "").toUpperCase();
        const filledQty = +(result?.filledQty || result?.filled_qty || result?.executedQty || qty);
        const filledPrice = +(result?.filledPrice || result?.filled_price || result?.avgPrice || result?.price || currentPrice);

        if (status === "CANCELLED" || status === "CANCELED" || status === "EXPIRED" || filledQty <= 0) {
            log(`⚠️ IOC 未成交 [${targetSymbol}]: status=${status} — 深度不足, 放弃进场`);
            if (onDepthFail) {
                await onDepthFail(`⚠️ 深度不足：IOC 撤单成功 [${coinName}]，避开巨大滑价，等待下次因果爆发`);
            }
            return false;
        }

        // 成交确认 — 使用实际成交价格 (非预估价)
        const actualPrice = filledPrice > 0 ? filledPrice : currentPrice;
        const actualQty = filledQty > 0 ? filledQty : qty;

        log(`✅ IOC ${side.toUpperCase()} ${actualQty} ${coinName} @ ${actualPrice.toFixed(prec.price)} [${targetSymbol}] (${ms.toFixed(0)}ms)`);

        this.inPosition = true;
        this.positionSide = side;
        this.positionSymbol = targetSymbol;
        this.entryPrice = actualPrice;
        this.positionQty = actualQty;
        this.entryTs = Date.now();
        this.orderTag = tag;
        this.beTriggered = false;

        // Atomic SL
        const slPrice = side === "long"
            ? currentPrice * (1 - STOP_LOSS_PCT)
            : currentPrice * (1 + STOP_LOSS_PCT);
        this.currentSlPrice = slPrice;

        const slOk = await this.placeStopMarket(
            targetSymbol, side === "long" ? "SELL" : "BUY", qty, slPrice, prec,
        );
        if (slOk) log(`🛡️ Atomic SL: ${slPrice.toFixed(prec.price)} (${(STOP_LOSS_PCT * 100).toFixed(2)}%)`);
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

    // ═══ 6 层出场防御 ═══
    async checkPosition(
        currentPrice: number,
        efficiencyDecay: boolean,
        recentVol: number,
        avgVol: number,
        efficiency: number,
    ): Promise<{ closed: boolean; reason: string; netPnlU: number; symbol: string }> {
        if (!this.inPosition) return { closed: false, reason: "", netPnlU: 0, symbol: "" };

        const prec = getPrecision(this.positionSymbol);
        const sym = this.positionSymbol;  // 先缓存, resetPosition 后仍可用

        const pnlPct = this.positionSide === "long"
            ? (currentPrice - this.entryPrice) / this.entryPrice
            : (this.entryPrice - currentPrice) / this.entryPrice;

        const pnlPt = this.positionSide === "long"
            ? currentPrice - this.entryPrice
            : this.entryPrice - currentPrice;

        const elapsed = Date.now() - this.entryTs;
        let reason = "";

        // A. 1 秒惯性校验
        if (elapsed > MOMENTUM_CHECK_MS && pnlPct < MOMENTUM_MIN_PCT && !this.beTriggered) {
            reason = `⚡ 惯性消失: ${elapsed}ms ${(pnlPct * 100).toFixed(4)}% < ${(MOMENTUM_MIN_PCT * 100).toFixed(2)}%`;
        }

        // B. 物理止损
        if (!reason && pnlPct <= -STOP_LOSS_PCT) {
            reason = `📉 物理止损: ${(pnlPct * 100).toFixed(3)}%`;
        }

        // C. 保本锁定
        if (!reason && !this.beTriggered && pnlPct >= BE_TARGET_PCT) {
            this.beTriggered = true;
            log(`🛡️ 保本触发: +${(pnlPct * 100).toFixed(3)}% → SL移至进场价`);

            if (this.slOrderId) await this.cancelOrder(this.positionSymbol, this.slOrderId);
            const closeSide = this.positionSide === "long" ? "SELL" : "BUY";
            const slOk = await this.placeStopMarket(this.positionSymbol, closeSide, this.positionQty, this.entryPrice, prec);
            this.currentSlPrice = this.entryPrice;
            if (slOk) log(`🛡️ SL → ${this.entryPrice.toFixed(prec.price)} (零风险)`);
        }

        // D. 放量倒货止盈 (至少赚 0.3% 才触发)
        if (!reason && efficiency < DUMP_EFF_THRESHOLD && recentVol > avgVol * DUMP_VOL_MULT && pnlPct > MIN_PROFIT_FOR_DECAY) {
            reason = `💰 放量倒货: eff=${efficiency.toFixed(4)}<${DUMP_EFF_THRESHOLD} vol=${recentVol.toFixed(1)}>${avgVol.toFixed(1)}×${DUMP_VOL_MULT} +${(pnlPct * 100).toFixed(3)}%`;
        }

        // E. 效率衰竭止盈 (至少赚 0.3% 才触发)
        if (!reason && efficiencyDecay && pnlPct > MIN_PROFIT_FOR_DECAY) {
            reason = `💰 效率衰竭: +${(pnlPct * 100).toFixed(3)}% (+${pnlPt.toFixed(prec.price)}pt)`;
        }

        // F. 保本后回落
        if (!reason && this.beTriggered && pnlPct <= 0) {
            reason = `🛡️ 保本平仓: ${(pnlPct * 100).toFixed(3)}%`;
        }

        // ═══ 执行平仓 (最高优先级: 先平仓, 后通知) ═══
        if (reason) {
            if (this.slOrderId) await this.cancelOrder(this.positionSymbol, this.slOrderId);
            const closeSide = this.positionSide === "long" ? "SELL" : "BUY";
            const ok = await this.closePosition(this.positionSymbol, closeSide, this.positionQty, prec);
            if (ok) {
                const gross = pnlPt * this.positionQty;
                const fee = (this.entryPrice * this.positionQty + currentPrice * this.positionQty) * TAKER_FEE;
                const net = gross - fee;
                const emoji = net > 0 ? "✅" : "❌";
                log(`${emoji} [${sym}] ${reason} | 净PnL: ${net >= 0 ? "+" : ""}${net.toFixed(2)}U`);
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

    // ═══ 仓位同步 — 使用当前持仓交易对 ═══
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
        this.beTriggered = false;
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
