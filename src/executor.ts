/**
 * ⚡ Bitunix 执行器 — V80 "FINAL-SENSE"
 * ═══════════════════════════════════════════
 * MARKET 入场 (IOC) + 穿牆狙击出场
 * 硬止损 4pt → Zero-Risk 6pt → 吸能止盈 → 牆压止盈
 */

import {
    BITUNIX_BASE, SYMBOL, ETH_SYMBOL, LEVERAGE,
    SL_POINTS, TAKER_FEE, SYMBOL_PRECISION,
    ZERO_RISK_THRESHOLD, ZERO_RISK_SL_OFFSET,
    ABSORPTION_EFF_MIN, ABSORPTION_WALL_PRESS, ABSORPTION_PROFIT_MIN,
    WALL_PRESSURE_EXIT, WALL_PRESSURE_PROFIT_MIN,
    MIN_HOLD_MS, AVG_VOL_WINDOW,
} from "./config";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [executor] ${msg}`);
}

function genOrderTag(): string {
    return `D66_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getPrecision(symbol: string): { qty: number; price: number } {
    return SYMBOL_PRECISION[symbol] || SYMBOL_PRECISION[SYMBOL] || { qty: 1, price: 3 };
}

export class BitunixExecutor {
    private apiKey: string;
    private secretKey: string;

    inPosition = false;
    positionSide: "long" | "short" | "" = "";
    positionSymbol = "";
    entryPrice = 0;
    positionQty = 0;
    entryTs = 0;
    positionId = "";
    orderTag = "";

    private slOrderId = "";
    private currentSlPrice = 0;
    private _entering = false;

    tradeLog: any[] = [];

    // V80-DEFIANCE 状态
    zeroRiskTriggered = false;
    structGuardPrice = 0;
    stage1Closed = false;          // n-of-1: 已平 30%
    originalQty = 0;               // 原始数量 (分阶段用)

    // 延迟诊断
    lastEntryMs = 0;
    lastSlMs = 0;
    lastSlippage = 0;
    signalPrice = 0;
    highSlippage = false;
    lastError = "";               // 最近一次 API 错误

    constructor(apiKey: string, secretKey: string) {
        this.apiKey = apiKey;
        this.secretKey = secretKey;
    }

    // ═══ 🔄 启动时仓位恢复 ═══
    async recoverPositions(): Promise<boolean> {
        const symbolsToCheck = [ETH_SYMBOL, SYMBOL];
        log("🔄 检查现有仓位...");

        for (const sym of symbolsToCheck) {
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
                if (positions.length === 0) continue;

                let totalBuyQty = 0, totalSellQty = 0;
                let entryPriceSum = 0, entryQtySum = 0;
                let firstPosId = "";

                for (const p of positions) {
                    const side = String(p.side).toUpperCase();
                    const qty = +(p.qty || p.positionAmt || 0);
                    const entry = +(p.avgPrice || p.entryPrice || p.openPrice || 0);
                    if (qty <= 0) continue;
                    if (side === "BUY") totalBuyQty += qty;
                    else totalSellQty += qty;
                    if (entry > 0) { entryPriceSum += entry * qty; entryQtySum += qty; }
                    if (!firstPosId && p.positionId) firstPosId = String(p.positionId);
                }

                const dominantSide = totalBuyQty >= totalSellQty ? "long" : "short";
                const dominantQty = dominantSide === "long" ? totalBuyQty : totalSellQty;
                const avgEntryPrice = entryQtySum > 0 ? entryPriceSum / entryQtySum : 0;

                if (dominantQty > 0 && avgEntryPrice > 0) {
                    this.inPosition = true;
                    this.positionSide = dominantSide;
                    this.positionSymbol = sym;
                    this.entryPrice = avgEntryPrice;
                    this.positionQty = dominantQty;
                    this.entryTs = Date.now();
                    this.positionId = firstPosId;

                    const prec = getPrecision(sym);
                    const coinName = sym.replace("USDT", "");
                    log(`🔄 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
                    log(`🔄 接管仓位: ${coinName} ${dominantSide.toUpperCase()}`);
                    log(`🔄 数量: ${dominantQty} | 入场: $${avgEntryPrice.toFixed(prec.price)}`);
                    log(`🔄 仓位数: ${positions.length} | posId: ${firstPosId}`);
                    log(`🔄 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
                    return true;
                }
            } catch (e) {
                log(`recoverPositions 异常 [${sym}]: ${e}`);
            }
        }
        log("🔄 无现有仓位, 正常启动");
        return false;
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

    // ═══ V80.3 启动冷却 ═══
    private _bootTs = Date.now();
    private readonly BOOT_COOLDOWN_MS = 60_000; // 60s 启动冷却, 防重复开仓

    isBootCooldown(): boolean {
        return Date.now() - this._bootTs < this.BOOT_COOLDOWN_MS;
    }

    // ═══ V80.3 LIMIT 入场 (直接接收 ETH 数量) ═══
    async atomicEntry(
        side: "long" | "short",
        currentPrice: number,
        qty: number,               // V80.3: 直接 ETH 数量 (1.5/3.0/5.0)
        targetSymbol: string = SYMBOL,
        onDepthFail?: (msg: string) => Promise<void>,
    ): Promise<boolean> {
        if (this.inPosition || this._entering) return false;

        // 60s 启动冷却: 新实例前 60 秒禁止开仓
        if (this.isBootCooldown()) {
            log(`⏳ 启动冷却中 (${Math.ceil((this.BOOT_COOLDOWN_MS - (Date.now() - this._bootTs)) / 1000)}s), 禁止开仓`);
            return false;
        }

        this._entering = true;
        const prec = getPrecision(targetSymbol);
        const coinName = targetSymbol.replace("USDT", "");

        // 余额检查
        const balance = await this.getBalance();
        const requiredMargin = (qty * currentPrice) / LEVERAGE;
        log(`💰 [PRE-ORDER] 余额: $${balance.toFixed(2)} | 需保证金: $${requiredMargin.toFixed(2)} | ${qty} ${coinName}`);

        if (balance < requiredMargin * 1.2) {
            this._entering = false;
            log(`❌ 余额不足! $${balance.toFixed(2)} < $${(requiredMargin * 1.2).toFixed(2)}`);
            if (onDepthFail) await onDepthFail(`❌ 余额不足: $${balance.toFixed(2)}`);
            return false;
        }

        // 强制 1 位小数: 3.0, 1.5, 5.0
        qty = Math.floor(qty * 10) / 10;
        if (qty <= 0) { this._entering = false; return false; }

        // 绝对上限 5 ETH
        if (qty > 5.0) qty = 5.0;

        await this.setupTradeEnv(targetSymbol);

        const tag = genOrderTag();
        log(`🏁 [V80.3] ${side.toUpperCase()} ${qty} ${coinName} @ $${currentPrice.toFixed(prec.price)}`);

        const orderData: Record<string, string> = {
            symbol: targetSymbol,
            side: side === "long" ? "BUY" : "SELL",
            tradeSide: "OPEN",
            orderType: "MARKET",
            qty: qty.toFixed(1),
            clientId: tag,
        };

        const t0 = performance.now();
        const result = await this.postOrder(orderData);
        const ms = performance.now() - t0;

        if (!result) {
            this._entering = false;
            const errDetail = this.lastError || "未知错误";
            log(`❌ 开仓失败 [${targetSymbol}]: ${errDetail}`);
            if (onDepthFail) await onDepthFail(
                `❌ 开仓失败 [${coinName}]\n` +
                `💰 余额: $${balance.toFixed(2)}\n` +
                `🏁 ${side.toUpperCase()} ${qty} @ $${currentPrice.toFixed(prec.price)}\n` +
                `🚨 ${errDetail}`
            );
            return false;
        }

        const filledQty = +(result?.filledQty || result?.filled_qty || result?.executedQty || qty);
        const filledPrice = +(result?.filledPrice || result?.filled_price || result?.avgPrice || result?.price || currentPrice);
        const actualPrice = filledPrice > 0 ? filledPrice : currentPrice;
        const actualQty = filledQty > 0 ? filledQty : qty;

        this.lastEntryMs = Math.round(ms);
        const slippage = Math.abs(actualPrice - currentPrice);
        this.lastSlippage = slippage;
        this.signalPrice = currentPrice;
        this.highSlippage = slippage > 1.5;

        log(`✅ ${side.toUpperCase()} ${actualQty} ${coinName} @ ${actualPrice.toFixed(prec.price)} (${ms.toFixed(0)}ms) Slip=${slippage.toFixed(prec.price)}pt`);

        this.inPosition = true;
        this._entering = false;
        this.positionSide = side;
        this.positionSymbol = targetSymbol;
        this.entryPrice = actualPrice;
        this.positionQty = actualQty;
        this.originalQty = actualQty;
        this.entryTs = Date.now();
        this.orderTag = tag;
        this.zeroRiskTriggered = false;

        // Atomic SL — 4pt STOP_MARKET
        const slPrice = side === "long"
            ? actualPrice - SL_POINTS
            : actualPrice + SL_POINTS;
        this.currentSlPrice = slPrice;

        const slT0 = performance.now();
        const slOk = await this.placeStopMarket(
            targetSymbol, side === "long" ? "SELL" : "BUY", actualQty, slPrice, prec,
        );
        this.lastSlMs = Math.round(performance.now() - slT0);

        if (slOk) log(`🛡️ SL: ${slPrice.toFixed(prec.price)} (-${SL_POINTS}pt) [${this.lastSlMs}ms]`);
        else log("⚠️ SL 挂单失败!");

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
            tradeSide: "CLOSE",
            orderType: "STOP_MARKET",
            qty: qty.toFixed(prec.qty),
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

    // ═══════════════════════════════════════════════
    // V80-DEFIANCE — n-of-1 分阶段出场
    // ═══════════════════════════════════════════════
    async checkPosition(
        currentPrice: number,
        prev15mHigh: number,
        prev15mLow: number,
        last1mClose: number,
        // V80 订单流数据
        ethL1AskVol: number = 0,
        ethL1BidVol: number = 0,
        ethInstantVol: number = 0,
        ethAvgVol: number = 1,
        ethLastPrice: number = 0,
    ): Promise<{ closed: boolean; reason: string; netPnlU: number; symbol: string }> {
        if (!this.inPosition) return { closed: false, reason: "", netPnlU: 0, symbol: "" };

        const prec = getPrecision(this.positionSymbol);
        const sym = this.positionSymbol;

        const pnlPt = this.positionSide === "long"
            ? currentPrice - this.entryPrice
            : this.entryPrice - currentPrice;

        const elapsed = Date.now() - this.entryTs;
        let reason = "";

        // ═══ Layer 1: 硬止损 — 永远有效, 4pt (强平前触发) ═══
        if (pnlPt <= -SL_POINTS) {
            reason = `📉 硬止损: ${pnlPt.toFixed(prec.price)}pt (SL=${SL_POINTS}pt)`;
        }

        // ═══ 最短持仓 30s（硬止损除外）═══
        if (!reason && elapsed < MIN_HOLD_MS) {
            return { closed: false, reason: "", netPnlU: 0, symbol: "" };
        }

        // ═══ Layer 2: 高滑点激进出场 — BE+1pt ═══
        if (!reason && this.highSlippage && pnlPt >= 1.0) {
            reason = `🚨 高滑点激进出场 [Slip=${this.lastSlippage.toFixed(2)}pt]: BE+${pnlPt.toFixed(prec.price)}pt`;
        }

        // ═══ Layer 3: Zero-Risk Gate — 6pt 保本 ═══
        if (!reason && !this.zeroRiskTriggered && pnlPt >= ZERO_RISK_THRESHOLD) {
            this.zeroRiskTriggered = true;
            const newSl = this.positionSide === "long"
                ? this.entryPrice + ZERO_RISK_SL_OFFSET
                : this.entryPrice - ZERO_RISK_SL_OFFSET;

            log(`🛡️ Zero-Risk 触发! +${pnlPt.toFixed(prec.price)}pt ≥ ${ZERO_RISK_THRESHOLD}pt → SL→${newSl.toFixed(prec.price)}`);

            if (this.slOrderId) await this.cancelOrder(sym, this.slOrderId);
            const closeSide = this.positionSide === "long" ? "SELL" : "BUY";
            const slOk = await this.placeStopMarket(sym, closeSide, this.positionQty, newSl, prec);
            this.currentSlPrice = newSl;
            if (slOk) log(`✅ Zero-Risk SL: ${newSl.toFixed(prec.price)}`);
            else log("⚠️ Zero-Risk SL 挂单失败!");
        }

        // ═══ Layer 4: n-of-1 Stage 1 — +10pt 平 30%, SL→Entry+1 ═══
        if (!reason && !this.stage1Closed && pnlPt >= ABSORPTION_PROFIT_MIN) {
            const closeQty30 = Math.floor(this.positionQty * 0.3 * 10) / 10;
            if (closeQty30 > 0) {
                log(`💰 Stage1: +${pnlPt.toFixed(prec.price)}pt ≥ ${ABSORPTION_PROFIT_MIN}pt → 平 30% = ${closeQty30}`);
                const closeSide = this.positionSide === "long" ? "SELL" : "BUY";
                const partialData: Record<string, string> = {
                    symbol: sym,
                    side: closeSide,
                    tradeSide: "CLOSE",
                    orderType: "MARKET",
                    qty: closeQty30.toFixed(prec.qty),
                };
                if (this.positionId) partialData.positionId = this.positionId;
                const ok = await this.postOrder(partialData);
                if (ok) {
                    this.stage1Closed = true;
                    this.positionQty -= closeQty30;
                    log(`✅ Stage1 已平 ${closeQty30}, 剩余 ${this.positionQty}`);

                    // SL → Entry + 1pt
                    const newSl = this.positionSide === "long"
                        ? this.entryPrice + 1.0
                        : this.entryPrice - 1.0;
                    if (this.slOrderId) await this.cancelOrder(sym, this.slOrderId);
                    const slOk = await this.placeStopMarket(sym, closeSide, this.positionQty, newSl, prec);
                    this.currentSlPrice = newSl;
                    if (slOk) log(`🛡️ Stage1 SL→${newSl.toFixed(prec.price)} (+1pt)`);
                } else {
                    log("⚠️ Stage1 部分平仓失败");
                }
            }
        }

        // ═══ Layer 5: n-of-1 Stage 2 — 15m 结构护卫退出 ═══
        if (!reason && this.stage1Closed) {
            // LONG: 1m 收盘 < prev15m low → 结构破位出场
            // SHORT: 1m 收盘 > prev15m high → 结构破位出场
            if (this.positionSide === "long" && last1mClose > 0 && prev15mLow > 0 && last1mClose < prev15mLow) {
                reason = `🏗️ 15m结构护卫: 1m收=${last1mClose.toFixed(prec.price)} < 15mL=${prev15mLow.toFixed(prec.price)} | +${pnlPt.toFixed(prec.price)}pt`;
            }
            if (this.positionSide === "short" && last1mClose > 0 && prev15mHigh > 0 && last1mClose > prev15mHigh) {
                reason = `🏗️ 15m结构护卫: 1m收=${last1mClose.toFixed(prec.price)} > 15mH=${prev15mHigh.toFixed(prec.price)} | +${pnlPt.toFixed(prec.price)}pt`;
            }
        }

        // ═══ 执行平仓 ═══
        if (reason) {
            if (this.slOrderId) await this.cancelOrder(this.positionSymbol, this.slOrderId);
            const closedQty = await this.closeAllPositions(this.positionSymbol);
            if (closedQty > 0) {
                const gross = pnlPt * this.positionQty;
                const fee = (this.entryPrice * this.positionQty + currentPrice * this.positionQty) * TAKER_FEE;
                const net = gross - fee;
                const emoji = net > 0 ? "✅" : "❌";
                const holdMin = (elapsed / 60_000).toFixed(1);
                log(`${emoji} [${sym}] ${reason} | 持仓${holdMin}min | 净PnL: ${net >= 0 ? "+" : ""}${net.toFixed(2)}U | 关闭${closedQty}个仓位`);
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
        // 尝试主 API
        try {
            const queryStr = "marginCoinUSDT";
            const headers = this.sign(queryStr);
            const res = await fetch(`${BITUNIX_BASE}/api/v1/futures/account?marginCoin=USDT`, {
                headers: { ...headers, "Content-Type": "application/json", language: "en-US" },
            });
            const data = (await res.json()) as any;
            if (String(data?.code) === "0" && data?.data?.available) {
                return +(data.data.available);
            }
        } catch { /* fallback */ }

        // Fallback: get_account_info
        try {
            const headers2 = this.sign();
            const res2 = await fetch(`${BITUNIX_BASE}/api/v1/futures/account/get_account_info`, {
                headers: { ...headers2, "Content-Type": "application/json", language: "en-US" },
            });
            const data2 = (await res2.json()) as any;
            if (data2?.data?.available) return +(data2.data.available);
            if (data2?.data?.equity) return +(data2.data.equity);
        } catch { /* ignore */ }

        return 0;
    }

    // ═══ 仓位同步 ═══
    async syncPositions(): Promise<boolean> {
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
                    let totalQty = 0;
                    for (const p of positions) {
                        const side = String(p.side).toUpperCase();
                        if (
                            (this.positionSide === "long" && side === "BUY") ||
                            (this.positionSide === "short" && side === "SELL")
                        ) {
                            totalQty += +(p.qty || p.positionAmt || 0);
                            if (!this.positionId && p.positionId) this.positionId = String(p.positionId);
                        }
                    }
                    if (totalQty > this.positionQty) {
                        log(`⚠️ 仓位聚合: Bot记录=${this.positionQty} | 实际总量=${totalQty}`);
                        this.positionQty = totalQty;
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

    // ═══ 强制平仓 ═══
    async forceCloseAll(currentPrice: number): Promise<{ ok: boolean; netPnlU: number }> {
        if (!this.inPosition) return { ok: false, netPnlU: 0 };
        if (this.slOrderId) await this.cancelOrder(this.positionSymbol, this.slOrderId);
        const closedCount = await this.closeAllPositions(this.positionSymbol);
        if (closedCount === 0) return { ok: false, netPnlU: 0 };
        const pnl = this.positionSide === "long"
            ? currentPrice - this.entryPrice
            : this.entryPrice - currentPrice;
        const fee = (this.entryPrice * this.positionQty + currentPrice * this.positionQty) * TAKER_FEE;
        const net = pnl * this.positionQty - fee;
        log(`🔴 强平 [${this.positionSymbol}] ${closedCount}个仓位 | 净PnL: ${net.toFixed(2)}U`);
        this.logTrade("强制平仓", pnl, net);
        this.resetPosition();
        return { ok: true, netPnlU: net };
    }

    // ═══ 关闭所有仓位 ═══
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
                const closeSide = this.positionSide === "long" ? "SELL" : "BUY";
                const ok = await this.closePosition(sym, closeSide, this.positionQty, prec);
                return ok ? 1 : 0;
            }
            const positions = (data?.data ?? []).filter(
                (p: any) => (p.symbol || "").toUpperCase() === sym,
            );
            if (positions.length === 0) return 0;
            log(`🛡️ 发现 ${positions.length} 个仓位, 逐个关闭...`);
            for (const pos of positions) {
                const posSide = String(pos.side).toUpperCase();
                const closeSide = posSide === "BUY" ? "SELL" : "BUY";
                const qty = +(pos.qty || pos.positionAmt || 0);
                const posId = pos.positionId ? String(pos.positionId) : "";
                if (qty <= 0) continue;
                if (pos.stopOrderId) await this.cancelOrder(sym, String(pos.stopOrderId));
                const orderData: Record<string, string> = {
                    symbol: sym, side: closeSide, tradeSide: "CLOSE", orderType: "MARKET",
                    qty: qty.toFixed(prec.qty),
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
        Object.keys(data).sort().forEach(k => sorted[k] = data[k]);
        const body = JSON.stringify(sorted);
        const headers = this.sign("", body);
        try {
            const res = await fetch(`${BITUNIX_BASE}/api/v1/futures/trade/place_order`, {
                method: "POST",
                headers: { ...headers, "Content-Type": "application/json", language: "en-US" },
                body,
            });
            const json = (await res.json()) as any;
            if (String(json?.code) === "0") return json?.data || json;

            // 🚨 完整原始响应日志
            const errMsg = `code=${json?.code} msg=${json?.msg}`;
            this.lastError = errMsg;
            log(`🚨 [ORDER-FAIL] type=${data.orderType} side=${data.side} qty=${data.qty} symbol=${data.symbol}`);
            log(`🚨 [ORDER-FAIL] ${errMsg}`);
            log(`🚨 [ORDER-FAIL] RAW: ${JSON.stringify(json).slice(0, 500)}`);
            log(`🚨 [ORDER-FAIL] REQ: ${body}`);
            return null;
        } catch (e) {
            log(`❌ API 异常: ${e}`);
            return null;
        }
    }

    // ═══ 预设杠杆 ═══
    private async setLeverage(symbol: string, leverage: number): Promise<boolean> {
        try {
            const body = JSON.stringify({ marginCoin: "USDT", symbol, leverage: String(leverage) });
            const headers = this.sign("", body);
            const res = await fetch(`${BITUNIX_BASE}/api/v1/futures/account/change_leverage`, {
                method: "POST",
                headers: { ...headers, "Content-Type": "application/json", language: "en-US" },
                body,
            });
            const json = (await res.json()) as any;
            if (String(json?.code) === "0") {
                log(`✅ 杠杆: ${symbol} ${leverage}x`);
                return true;
            }
            log(`⚠️ 设置杠杆失败 [${symbol}]: code=${json?.code} msg=${json?.msg}`);
            return false;
        } catch (e) {
            log(`❌ 设置杠杆异常: ${e}`);
            return false;
        }
    }

    // ═══ 逐仓模式 ═══
    private async setMarginMode(symbol: string, mode: "ISOLATION" | "CROSS"): Promise<boolean> {
        try {
            const body = JSON.stringify({ marginCoin: "USDT", symbol, marginMode: mode });
            const headers = this.sign("", body);
            const res = await fetch(`${BITUNIX_BASE}/api/v1/futures/account/change_margin_mode`, {
                method: "POST",
                headers: { ...headers, "Content-Type": "application/json", language: "en-US" },
                body,
            });
            const json = (await res.json()) as any;
            if (String(json?.code) === "0") {
                log(`✅ 保证金模式: ${symbol} ${mode}`);
                return true;
            }
            // code=1 通常表示已经是该模式, 不算失败
            log(`⚠️ 保证金模式 [${symbol}]: code=${json?.code} msg=${json?.msg}`);
            return String(json?.code) === "1";  // 已经是该模式也算成功
        } catch (e) {
            log(`❌ 设置保证金模式异常: ${e}`);
            return false;
        }
    }

    // ═══ 🔧 一键设置交易环境 (启动时和下单前调用) ═══
    async setupTradeEnv(symbol: string): Promise<void> {
        log(`🔧 设置交易环境: ${symbol}`);
        await this.setMarginMode(symbol, "CROSS");  // 全仓
        await this.setLeverage(symbol, LEVERAGE);        // 200x
        log(`🔧 交易环境就绪: ${symbol} | CROSS | ${LEVERAGE}x`);
    }

    private async closePosition(
        symbol: string, closeSide: string, qty: number,
        prec: { qty: number; price: number },
    ): Promise<boolean> {
        const data: Record<string, string> = {
            symbol, side: closeSide, tradeSide: "CLOSE", orderType: "MARKET",
            qty: qty.toFixed(prec.qty),
        };
        if (this.positionId) data.positionId = this.positionId;
        return !!(await this.postOrder(data));
    }

    private async cancelOrder(symbol: string, orderId: string): Promise<void> {
        if (!orderId) return;
        try {
            const body = JSON.stringify({ symbol, orderId });
            const headers = this.sign("", body);
            await fetch(`${BITUNIX_BASE}/api/v1/futures/trade/cancel_orders`, {
                method: "POST",
                headers: { ...headers, "Content-Type": "application/json", language: "en-US" },
                body,
            });
        } catch {}
    }

    private resetPosition() {
        this.inPosition = false;
        this.positionSide = "";
        this.positionSymbol = "";
        this.entryPrice = 0;
        this.positionQty = 0;
        this.entryTs = 0;
        this.positionId = "";
        this.orderTag = "";
        this.slOrderId = "";
        this.currentSlPrice = 0;
        this._entering = false;
        this.zeroRiskTriggered = false;
        this.structGuardPrice = 0;
        this.highSlippage = false;
        this.stage1Closed = false;
        this.originalQty = 0;
    }

    private logTrade(reason: string, pnlPt: number, netPnlU: number) {
        this.tradeLog.push({
            ts: Date.now(),
            symbol: this.positionSymbol,
            side: this.positionSide,
            entry: this.entryPrice,
            pnlPt,
            netPnlU,
            reason,
        });
        if (this.tradeLog.length > 100) this.tradeLog = this.tradeLog.slice(-50);
    }
}
