/**
 * ⚡ Bitunix 执行器 — V52.4 "Logic Leader"
 * ═══════════════════════════════════════════
 * MARKET 入场 (IOC) + Fee Shield 5pt + 15s持仓保护
 * 硬止损 8pt / 硬止盈 25pt / 20分钟超时
 */

import {
    BITUNIX_BASE, SYMBOL, ETH_SYMBOL, LEVERAGE,
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
    private _entering = false;  // 🔒 入场锁: 防止竞态条件重复开仓

    tradeLog: any[] = [];

    // V52.4 延迟诊断 — 公开属性供状态面板读取
    lastEntryMs = 0;          // 最近入场订单往返时间
    lastSlMs = 0;             // 最近 SL 订单往返时间
    lastSlippage = 0;         // 最近滑点 (pt)
    signalPrice = 0;          // 信号价格 (entry signal)
    highSlippage = false;     // 🚨 高滑点模式: 取消 15s Hold + 激进出场

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
        // 🔒 双重锁: inPosition + _entering 防止竞态条件
        if (this.inPosition || this._entering) return false;
        this._entering = true;  // 立即加锁，不等订单返回

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
            this._entering = false;  // 🔓 解锁
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

        // V52.4 延迟诊断: 订单往返时间 + 滑点
        this.lastEntryMs = Math.round(ms);
        const slippage = Math.abs(actualPrice - currentPrice);
        this.lastSlippage = slippage;
        this.signalPrice = currentPrice;

        // 🚨 Slippage Cap: 滑点 > 1.5pt 触发激进出场模式
        const HIGH_SLIPPAGE_PT = 1.5;
        this.highSlippage = slippage > HIGH_SLIPPAGE_PT;

        log(`✅ MARKET ${side.toUpperCase()} ${actualQty} ${coinName} @ ${actualPrice.toFixed(prec.price)} [${targetSymbol}] (${ms.toFixed(0)}ms)`);
        log(`[DRIFT] SignalPrice: ${currentPrice.toFixed(prec.price)} | FillPrice: ${actualPrice.toFixed(prec.price)} | Slippage: ${slippage.toFixed(prec.price)}pt${this.highSlippage ? " 🚨 HIGH" : ""}`);

        this.inPosition = true;
        this._entering = false;  // 🔓 解锁: inPosition 已接管保护
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

        const slT0 = performance.now();
        const slOk = await this.placeStopMarket(
            targetSymbol, side === "long" ? "SELL" : "BUY", actualQty, slPrice, prec,
        );
        this.lastSlMs = Math.round(performance.now() - slT0);

        if (slOk) log(`🛡️ Atomic SL: ${slPrice.toFixed(prec.price)} (-${SL_POINTS}pt) [${this.lastSlMs}ms]`);
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
        // V52.4: 高滑点时取消 15s Hold 保护
        const holdSafe = this.highSlippage ? true : (elapsed >= MIN_HOLD_MS);
        let reason = "";

        // ═══ Layer 1: 硬止损 — 永远有效，8pt ═══
        if (pnlPt <= -SL_POINTS) {
            reason = `📉 硬止损: ${pnlPt.toFixed(prec.price)}pt (SL=${SL_POINTS}pt)`;
        }

        // ═══ Layer 2: 硬止盈 — 25pt 100% 平仓 ═══
        if (!reason && pnlPt >= TP_POINTS) {
            reason = `💰 硬止盈: +${pnlPt.toFixed(prec.price)}pt (TP=${TP_POINTS}pt)`;
        }

        // ═══ Layer 2.5: 🚨 高滑点激进出场 — BE+1pt 就跑 ═══
        if (!reason && this.highSlippage && pnlPt >= 1.0) {
            reason = `🚨 高滑点激进出场 [Slip=${this.lastSlippage.toFixed(2)}pt]: BE+${pnlPt.toFixed(prec.price)}pt`;
        }

        // ═══ Layer 3: 20 分钟硬超时 — 无条件平仓 ═══
        if (!reason && elapsed >= HARD_TIMEOUT_MS) {
            reason = `⏰ 超时平仓: ${(elapsed / 60_000).toFixed(1)}min (limit=20min) ${pnlPt >= 0 ? "+" : ""}${pnlPt.toFixed(prec.price)}pt`;
        }

        // ═══ 以下出场受 双重保护: holdSafe(15s，高滑点跳过) + FeeShield(5pt) ═══

        // Layer 4: 放量倒货止盈
        if (!reason && holdSafe && efficiency < DUMP_EFF_THRESHOLD && recentVol > avgVol * DUMP_VOL_MULT && pnlPt >= FEE_SHIELD_POINTS) {
            reason = `💰 放量倒货 [${this.highSlippage ? "🚨Slip" : "15s✅"}+FeeShield✅]: eff=${efficiency.toFixed(4)}<${DUMP_EFF_THRESHOLD} +${pnlPt.toFixed(prec.price)}pt`;
        }

        // Layer 5: 效率衰竭止盈
        if (!reason && holdSafe && efficiencyDecay && pnlPt >= FEE_SHIELD_POINTS) {
            reason = `💰 效率衰竭 [${this.highSlippage ? "🚨Slip" : "15s✅"}+FeeShield✅]: +${pnlPt.toFixed(prec.price)}pt`;
        }

        // ═══ 执行平仓 — 关闭所有仓位 ═══
        if (reason) {
            if (this.slOrderId) await this.cancelOrder(this.positionSymbol, this.slOrderId);
            const closedQty = await this.closeAllPositions(this.positionSymbol);
            if (closedQty > 0) {
                const gross = pnlPt * this.positionQty;
                const fee = (this.entryPrice * this.positionQty + currentPrice * this.positionQty) * TAKER_FEE;
                const net = gross - fee;
                const emoji = net > 0 ? "✅" : "❌";
                const holdSec = (elapsed / 1000).toFixed(1);
                log(`${emoji} [${sym}] ${reason} | 持仓${holdSec}s | 净PnL: ${net >= 0 ? "+" : ""}${net.toFixed(2)}U | 关闭${closedQty}个仓位`);
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

    // ═══ 仓位同步 — 聚合所有同方向仓位 ═══
    async syncPositions(): Promise<boolean> {
        // 查询所有可能的交易对
        const symbols = [this.positionSymbol || SYMBOL, ETH_SYMBOL].filter(
            (v, i, a) => a.indexOf(v) === i,
        );

        for (const sym of symbols) {
            try {
                const queryStr = "symbol" + sym;
                const headers = this.sign(queryStr);
                const res = await fetch(
                    `${BITUNIX_BASE}/api/v1/futures/position/get_pending_positions?symbol=${sym}`,
                    { headers: { ...headers, "Content-Type": "application/json", language: "en-US" } },
                );
                const data = (await res.json()) as any;
                if (String(data?.code) !== "0") continue;

                const positions = (data?.data ?? []).filter(
                    (p: any) => (p.symbol || "").toUpperCase() === sym,
                );

                if (positions.length > 0 && this.inPosition && sym === this.positionSymbol) {
                    // 聚合所有同方向仓位的总量
                    let totalQty = 0;
                    for (const p of positions) {
                        const side = String(p.side).toUpperCase();
                        if (
                            (this.positionSide === "long" && side === "BUY") ||
                            (this.positionSide === "short" && side === "SELL")
                        ) {
                            totalQty += +(p.qty || p.positionAmt || 0);
                            if (!this.positionId && p.positionId) {
                                this.positionId = String(p.positionId);
                            }
                        }
                    }
                    if (totalQty > this.positionQty) {
                        log(`⚠️ 仓位聚合: Bot记录=${this.positionQty} | 实际总量=${totalQty} (包含重复开仓)`);
                        this.positionQty = totalQty;  // 更新为实际总量
                    }
                } else if (positions.length === 0 && this.inPosition && sym === this.positionSymbol) {
                    log("⚠️ 仓位已被关闭 (STOP_MARKET 可能已触发)");
                    this.resetPosition();
                }
            } catch (e) {
                log(`syncPositions 异常 [${sym}]: ${e}`);
            }
        }
        return true;
    }

    // ═══ 强制平仓 — 关闭所有仓位 ═══
    async forceCloseAll(currentPrice: number): Promise<{ ok: boolean; netPnlU: number }> {
        if (!this.inPosition) return { ok: false, netPnlU: 0 };

        if (this.slOrderId) await this.cancelOrder(this.positionSymbol, this.slOrderId);

        const closedCount = await this.closeAllPositions(this.positionSymbol);
        if (closedCount === 0) return { ok: false, netPnlU: 0 };

        const pnl =
            this.positionSide === "long"
                ? currentPrice - this.entryPrice
                : this.entryPrice - currentPrice;
        const fee = (this.entryPrice * this.positionQty + currentPrice * this.positionQty) * TAKER_FEE;
        const net = pnl * this.positionQty - fee;
        log(`🔴 强平 [${this.positionSymbol}] ${closedCount}个仓位 | 净PnL: ${net.toFixed(2)}U`);
        this.logTrade("强制平仓", pnl, net);
        this.resetPosition();
        return { ok: true, netPnlU: net };
    }

    // ═══ 关闭某交易对的所有仓位 ═══
    private async closeAllPositions(sym: string): Promise<number> {
        const prec = getPrecision(sym);
        let closedCount = 0;

        try {
            const queryStr = "symbol" + sym;
            const headers = this.sign(queryStr);
            const res = await fetch(
                `${BITUNIX_BASE}/api/v1/futures/position/get_pending_positions?symbol=${sym}`,
                { headers: { ...headers, "Content-Type": "application/json", language: "en-US" } },
            );
            const data = (await res.json()) as any;
            if (String(data?.code) !== "0") {
                log(`⚠️ closeAllPositions: 查询失败 code=${data?.code}`);
                // fallback: 尝试用记录的数量关闭
                const closeSide = this.positionSide === "long" ? "SELL" : "BUY";
                const ok = await this.closePosition(sym, closeSide, this.positionQty, prec);
                return ok ? 1 : 0;
            }

            const positions = (data?.data ?? []).filter(
                (p: any) => (p.symbol || "").toUpperCase() === sym,
            );

            if (positions.length === 0) {
                log(`⚠️ closeAllPositions: 无仓位可关`);
                return 0;
            }

            log(`🛡️ 发现 ${positions.length} 个仓位, 逐个关闭...`);

            for (const pos of positions) {
                const posSide = String(pos.side).toUpperCase();
                const closeSide = posSide === "BUY" ? "SELL" : "BUY";
                const qty = +(pos.qty || pos.positionAmt || 0);
                const posId = pos.positionId ? String(pos.positionId) : "";

                if (qty <= 0) continue;

                // 取消该仓位的所有挂单
                if (pos.stopOrderId) await this.cancelOrder(sym, String(pos.stopOrderId));

                const orderData: Record<string, string> = {
                    symbol: sym,
                    side: closeSide,
                    orderType: "MARKET",
                    qty: qty.toFixed(prec.qty),
                    tradeSide: "CLOSE",
                    effect: "GTC",
                };
                if (posId) orderData.positionId = posId;

                const result = await this.postOrder(orderData);
                if (result) {
                    closedCount++;
                    log(`✅ 关闭仓位 #${closedCount}: ${posSide} ${qty} [posId=${posId}]`);
                } else {
                    log(`❌ 关闭仓位失败: ${posSide} ${qty} [posId=${posId}]`);
                }
            }
        } catch (e) {
            log(`closeAllPositions 异常: ${e}`);
        }

        return closedCount;
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
