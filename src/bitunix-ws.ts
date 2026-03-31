/**
 * 🔌 Bitunix WebSocket 数据引擎 — V300 订单流 AI
 * ═══════════════════════════════════════════════════════
 * 三币种订阅: SOLUSDT + ETHUSDT + BTCUSDT
 * VP/POC + CVD + VA + 吸收/掃单/假墙 + DOM10
 */

import {
    BITUNIX_WS_PUBLIC, SYMBOL, ETH_SYMBOL, BTC_SYMBOL,
    EFFICIENCY_WINDOW, AVG_VOL_WINDOW,
    VA_PERCENTAGE, ABSORPTION_VOL_MIN, ABSORPTION_PRICE_MAX,
    ABSORPTION_WINDOW_MS, SWEEP_LAYER_MIN, SWEEP_SPEED_MS,
    FAKE_WALL_CANCEL_RATIO, DOM_LEVELS, CVD_DIVERGE_THRESHOLD,
} from "./config";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [ws] ${msg}`);
}

// ═══════════════════════════════════════════════
// 因果快照 — 三币种数据 + V52.2 新增字段
// ═══════════════════════════════════════════════

export interface CausalSnapshot {
    price: number;
    priceTs: number;
    connected: boolean;

    // ── SOL 数据 ──
    buyDelta: number;
    sellDelta: number;
    netDelta: number;
    askWallVol: number;
    bidWallVol: number;
    bestAsk: number;
    bestBid: number;
    spread: number;
    efficiency: number;
    avgEfficiency: number;
    avgVol: number;
    recentVol: number;
    isEfficiencyDecay: boolean;

    // ── BTC 联动数据 ──
    btcPrice: number;
    btcBuyDelta: number;
    btcSellDelta: number;
    btcAskWallVol: number;
    btcBidWallVol: number;
    btcConnected: boolean;

    // ── ETH 自动切换数据 ──
    ethPrice: number;
    ethBuyDelta: number;
    ethSellDelta: number;
    ethAskWallVol: number;
    ethBidWallVol: number;
    ethEfficiency: number;
    ethAvgEfficiency: number;
    ethConnected: boolean;

    // ── V52.2 ──
    ethSpread: number;
    ethBestAsk: number;
    ethBestBid: number;
    ethTop3Depth: number;
    recentDeltaDirs: number[];
    ethRecentDeltaDirs: number[];

    // ── 能量 vs 阻力 ──
    ethL1AskVol: number;
    ethL1BidVol: number;
    ethInstantVol: number;
    ethBidWallChange: number;
    ethLastPrice: number;
    ethAvgVol: number;

    // ── V200 POC Volume Profile ──
    ethPOC: number;              // 当前4h POC价格
    ethPrevPOC: number;          // 前4h POC价格
    ethPOCSlope: number;         // POC位移 (current - previous)
    ethPOCDir: "long" | "short" | "";  // POC方向 (>5pt多 <-5pt空)
    ethVPNodeCount: number;      // Volume Profile 活跃价格层级数

    // ── V95 大单 Delta 引擎 ──
    ethBigBuyDelta: number;      // 大单买入量 (>3 ETH)
    ethBigSellDelta: number;     // 大单卖出量 (>3 ETH)
    ethBigNetDelta: number;      // 大单净 Delta (正=机构买, 负=机构卖)
    ethBigCVD: number;           // 累积大单 Delta (5min窗口)
    ethBigRatio: number;         // 大单占总成交比例 (0-1)
    ethBigOrderCount: number;    // 5min 内大单笔数

    // ── V300 订单流检测 ──
    ethCVD: number;              // 全量累积成交量差
    ethCVDSlope: number;         // CVD 10s 斜率
    ethVAH: number;              // Value Area High
    ethVAL: number;              // Value Area Low
    ethAbsorption: boolean;      // 吸收单检测
    ethAbsorptionSide: "buy" | "sell" | "";  // 吸收方向
    ethSweep: boolean;           // 掃单检测
    ethSweepSide: "buy" | "sell" | "";      // 掃单方向
    ethFakeWall: boolean;        // 假墙标记
    ethFakeWallSide: "ask" | "bid" | "";    // 假墙方向
    ethDOM10AskVol: number;      // 10档卖方密集度
    ethDOM10BidVol: number;      // 10档买方密集度

    // ── 延迟诊断 ──
    wsLatencyMs: number;
    wsLatencyAvg: number;
    wsLatencyMax: number;
    highLatencyCount: number;
}

// ═══════════════════════════════════════════════
// 单币种数据追踪器
// ═══════════════════════════════════════════════

class SymbolTracker {
    readonly symbol: string;

    price = 0;
    priceTs = 0;
    lastKlineOHLC: { o: number; h: number; l: number; c: number; v: number } | null = null;

    bestAsk = 0;
    bestBid = 0;
    askWallVol = 0;
    bidWallVol = 0;
    top3Depth = 0;

    // L1 首档牆量
    l1AskVol = 0;
    l1BidVol = 0;

    // 牆体变化率追踪
    bidWallHistory: { ts: number; vol: number }[] = [];
    readonly WALL_HISTORY_MS = 5_000;

    deltaRing: { ts: number; buyVol: number; sellVol: number; efficiency: number; vol: number }[] = [];
    readonly DELTA_WINDOW_MS = 10_000;

    efficiencyRing: number[] = [];
    volRing: number[] = [];
    lastPrice = 0;

    deltaDirRing: number[] = [];
    readonly DELTA_DIR_MAX = 10;

    // ═══ V95 大单过滤引擎 ═══
    // 大单定义: >3 ETH (~$6K+), 滚动5分钟窗口
    private readonly BIG_ORDER_THRESHOLD = 3.0;       // ETH 单位
    private readonly BIG_ORDER_WINDOW_MS = 5 * 60_000; // 5 分钟窗口
    private bigOrderRing: { ts: number; buyVol: number; sellVol: number }[] = [];
    private bigOrderTotalBuy = 0;   // 5min 窗口内大单买入总量
    private bigOrderTotalSell = 0;  // 5min 窗口内大单卖出总量
    private totalVolInWindow = 0;   // 5min 窗口内总成交量
    private bigVolInWindow = 0;     // 5min 窗口内大单成交量

    // ═══ V200 Volume Profile POC ═══
    // 真实成交数据 bin=1.0pt, 滚动4h窗口
    private readonly VP_BIN_SIZE = 1.0;           // 价格分桶 1.0pt
    private readonly VP_WINDOW_MS = 4 * 3600_000; // 4小时滚动窗口
    private vpTradeBuffer: { ts: number; binPrice: number; vol: number }[] = [];
    private vpVolumeMap = new Map<number, number>(); // binPrice → totalVol
    private vpPOC = 0;           // 当前4h POC价格
    private vpPrevPOC = 0;       // 前4h POC (每4h更新一次)
    private vpLastRotateTs = 0;  // 上次轮换 prevPOC 的时间
    private vpLastCleanTs = 0;   // 上次清理的时间

    // ═══ V300 全量 CVD 引擎 ═══
    private cvdTotal = 0;           // 全量累积成交量差 (买-卖)
    private cvdRing: { ts: number; val: number }[] = [];  // CVD 快照历史
    private readonly CVD_SNAPSHOT_MS = 10_000;  // 每 10s 存一个 CVD 快照
    private cvdLastSnapshotTs = 0;
    private cvdPriceHigh = 0;       // CVD 窗口内价格最高
    private cvdPriceLow = Infinity; // CVD 窗口内价格最低
    private cvdAtPriceHigh = 0;     // 价格创高时的 CVD
    private cvdAtPriceLow = 0;      // 价格创低时的 CVD

    // ═══ V300 吸收单检测 ═══
    private absorbRing: { ts: number; vol: number; priceStart: number; priceEnd: number; isBuy: boolean }[] = [];
    private absorbDetected = false;
    private absorbSide: "buy" | "sell" | "" = "";

    // ═══ V300 掃单检测 ═══
    private sweepDetected = false;
    private sweepSide: "buy" | "sell" | "" = "";
    private sweepRing: { ts: number; layers: number; side: "buy" | "sell" }[] = [];
    private lastDepthAskPrices: number[] = [];
    private lastDepthBidPrices: number[] = [];

    // ═══ V300 假墙追踪 ═══
    private fakeWallDetected = false;
    private fakeWallSide: "ask" | "bid" | "" = "";
    private prevAskWallVol = 0;
    private prevBidWallVol = 0;
    private prevAskTrades = 0;  // 上一周期卖方成交量
    private prevBidTrades = 0;  // 上一周期买方成交量

    // ═══ V300 DOM 10 档 ═══
    dom10AskVol = 0;
    dom10BidVol = 0;

    constructor(symbol: string) {
        this.symbol = symbol;
        this.vpLastRotateTs = Date.now();
        this.vpLastCleanTs = Date.now();
    }

    getDelta(): { buyDelta: number; sellDelta: number } {
        const now = Date.now();
        while (this.deltaRing.length > 0 && now - this.deltaRing[0].ts > this.DELTA_WINDOW_MS) {
            this.deltaRing.shift();
        }
        let buyDelta = 0, sellDelta = 0;
        for (const d of this.deltaRing) {
            buyDelta += d.buyVol;
            sellDelta += d.sellVol;
        }
        return { buyDelta, sellDelta };
    }

    getAvgEfficiency(): number {
        return this.efficiencyRing.length > 0
            ? this.efficiencyRing.reduce((a, b) => a + b, 0) / this.efficiencyRing.length
            : 0.01;
    }

    getAvgVol(): number {
        return this.volRing.length > 0
            ? this.volRing.reduce((a, b) => a + b, 0) / this.volRing.length
            : 1;
    }

    getLastEfficiency(): number {
        return this.deltaRing[this.deltaRing.length - 1]?.efficiency ?? 0;
    }

    getRecentVol(): number {
        return this.deltaRing[this.deltaRing.length - 1]?.vol ?? 0;
    }

    getRecentDeltaDirs(): number[] {
        return this.deltaDirRing.slice(-this.DELTA_DIR_MAX);
    }

    /** 瞬时成交量 (最近 windowMs 毫秒的总成交量) */
    getInstantVol(windowMs = 2000): number {
        const now = Date.now();
        let total = 0;
        for (let i = this.deltaRing.length - 1; i >= 0; i--) {
            if (now - this.deltaRing[i].ts > windowMs) break;
            total += this.deltaRing[i].vol;
        }
        return total;
    }

    /** 买盘牆变化率 (vs 5s 前，-0.6 = 下降 60%) */
    getBidWallChange(): number {
        if (this.bidWallHistory.length < 2) return 0;
        const now = Date.now();
        // 找到最接近 5s 前的记录
        let oldVol = this.bidWallHistory[0].vol;
        for (const h of this.bidWallHistory) {
            if (now - h.ts >= this.WALL_HISTORY_MS) oldVol = h.vol;
            else break;
        }
        if (oldVol <= 0) return 0;
        return (this.bidWallVol - oldVol) / oldVol;
    }

    // ═══ V95 大单 Delta 引擎 ═══

    /** 清理超过5分钟的大单记录 */
    private cleanBigOrders() {
        const cutoff = Date.now() - this.BIG_ORDER_WINDOW_MS;
        while (this.bigOrderRing.length > 0 && this.bigOrderRing[0].ts < cutoff) {
            const old = this.bigOrderRing.shift()!;
            this.bigOrderTotalBuy -= old.buyVol;
            this.bigOrderTotalSell -= old.sellVol;
            this.bigVolInWindow -= (old.buyVol + old.sellVol);
        }
    }

    /** 获取大单 Delta (5分钟窗口) */
    getBigDelta(): { buyDelta: number; sellDelta: number; netDelta: number } {
        this.cleanBigOrders();
        return {
            buyDelta: this.bigOrderTotalBuy,
            sellDelta: this.bigOrderTotalSell,
            netDelta: this.bigOrderTotalBuy - this.bigOrderTotalSell,
        };
    }

    /** 累积大单 Delta (CVD, 5分钟窗口) — 正=机构持续买入, 负=机构持续卖出 */
    getBigCVD(): number {
        this.cleanBigOrders();
        let cvd = 0;
        for (const o of this.bigOrderRing) cvd += (o.buyVol - o.sellVol);
        return cvd;
    }

    /** 大单成交占总成交比例 (0-1) */
    getBigRatio(): number {
        this.cleanBigOrders();
        return this.totalVolInWindow > 0 ? this.bigVolInWindow / this.totalVolInWindow : 0;
    }

    /** 5分钟窗口内大单笔数 */
    getBigOrderCount(): number {
        this.cleanBigOrders();
        return this.bigOrderRing.length;
    }

    handleTrade(trades: any) {
        const now = Date.now();
        const tradeList = Array.isArray(trades) ? trades : [trades];

        for (const t of tradeList) {
            const tradePrice = +(t.p || t.price || 0);
            const qty = +(t.v || t.q || t.qty || t.sz || t.size || 0);
            const side = String(t.s || t.side || "").toLowerCase();

            if (tradePrice <= 0 || qty <= 0) continue;

            this.price = tradePrice;
            this.priceTs = now;

            const isBuyer = side === "buy";
            const priceChange = this.lastPrice > 0 ? Math.abs(tradePrice - this.lastPrice) : 0;
            const efficiency = qty > 0 ? priceChange / qty : 0;

            this.deltaRing.push({
                ts: now,
                buyVol: isBuyer ? qty : 0,
                sellVol: isBuyer ? 0 : qty,
                efficiency,
                vol: qty,
            });

            if (this.deltaRing.length > 5000) {
                this.deltaRing = this.deltaRing.slice(-2500);
            }

            this.efficiencyRing.push(efficiency);
            if (this.efficiencyRing.length > EFFICIENCY_WINDOW) this.efficiencyRing.shift();

            this.volRing.push(qty);
            if (this.volRing.length > AVG_VOL_WINDOW) this.volRing.shift();

            // V52.2: 记录 Delta 方向
            this.deltaDirRing.push(isBuyer ? 1 : -1);
            if (this.deltaDirRing.length > this.DELTA_DIR_MAX) this.deltaDirRing.shift();

            this.lastPrice = tradePrice;

            // ═══ V95 大单过滤: >3 ETH 的单独记录 ═══
            this.totalVolInWindow += qty;
            if (qty >= this.BIG_ORDER_THRESHOLD) {
                const buyV = isBuyer ? qty : 0;
                const sellV = isBuyer ? 0 : qty;
                this.bigOrderRing.push({ ts: now, buyVol: buyV, sellVol: sellV });
                this.bigOrderTotalBuy += buyV;
                this.bigOrderTotalSell += sellV;
                this.bigVolInWindow += qty;
            }
            // 每 200 笔交易清理一次大单窗口
            if (this.deltaRing.length % 200 === 0) this.cleanBigOrders();

            // ═══ V200 Volume Profile: 每笔成交加入分桶 ═══
            const binPrice = Math.round(tradePrice / this.VP_BIN_SIZE) * this.VP_BIN_SIZE;
            this.vpTradeBuffer.push({ ts: now, binPrice, vol: qty });
            this.vpVolumeMap.set(binPrice, (this.vpVolumeMap.get(binPrice) || 0) + qty);

            // ═══ V300 CVD 累积 ═══
            this.cvdTotal += isBuyer ? qty : -qty;

            // CVD 快照 (每 10s 存一次，用于斜率计算)
            if (now - this.cvdLastSnapshotTs >= this.CVD_SNAPSHOT_MS) {
                this.cvdRing.push({ ts: now, val: this.cvdTotal });
                if (this.cvdRing.length > 30) this.cvdRing.shift(); // 保留 5min
                this.cvdLastSnapshotTs = now;
            }

            // CVD 价格-CVD 背离追踪 (5min 窗口)
            if (tradePrice > this.cvdPriceHigh) {
                this.cvdPriceHigh = tradePrice;
                this.cvdAtPriceHigh = this.cvdTotal;
            }
            if (tradePrice < this.cvdPriceLow) {
                this.cvdPriceLow = tradePrice;
                this.cvdAtPriceLow = this.cvdTotal;
            }

            // ═══ V300 吸收单检测 ═══
            // 大量主动单 (≥ABSORPTION_VOL_MIN ETH) 但价格几乎不动
            this.absorbRing.push({
                ts: now, vol: qty,
                priceStart: this.lastPrice > 0 ? this.lastPrice : tradePrice,
                priceEnd: tradePrice,
                isBuy: isBuyer,
            });
            // 清理窗口外数据
            while (this.absorbRing.length > 0 && now - this.absorbRing[0].ts > ABSORPTION_WINDOW_MS) {
                this.absorbRing.shift();
            }
            // 检测: 窗口内总量 ≥ 阈值 且 价格位移小
            if (this.absorbRing.length >= 3) {
                const windowVol = this.absorbRing.reduce((s, r) => s + r.vol, 0);
                const buyVol = this.absorbRing.filter(r => r.isBuy).reduce((s, r) => s + r.vol, 0);
                const sellVol = windowVol - buyVol;
                const priceRange = this.absorbRing.length > 0
                    ? Math.abs(this.absorbRing[this.absorbRing.length - 1].priceEnd - this.absorbRing[0].priceStart)
                    : 0;

                if (windowVol >= ABSORPTION_VOL_MIN && priceRange <= ABSORPTION_PRICE_MAX) {
                    this.absorbDetected = true;
                    this.absorbSide = buyVol > sellVol ? "buy" : "sell";
                } else {
                    this.absorbDetected = false;
                    this.absorbSide = "";
                }
            }
        }

        // 每60秒清理超过4h的旧成交 + 重算POC
        const now2 = Date.now();
        if (now2 - this.vpLastCleanTs > 60_000) {
            this.vpCleanAndRecalc(now2);
            this.vpLastCleanTs = now2;
        }

        // 每 5min 重置 CVD 价格高低追踪
        if (now2 - (this.cvdRing[0]?.ts ?? now2) > 300_000 && this.cvdRing.length > 0) {
            this.cvdPriceHigh = this.price;
            this.cvdPriceLow = this.price;
            this.cvdAtPriceHigh = this.cvdTotal;
            this.cvdAtPriceLow = this.cvdTotal;
        }
    }

    // ═══ V200 Volume Profile 清理+重算 ═══
    private vpCleanAndRecalc(now: number) {
        const cutoff = now - this.VP_WINDOW_MS;

        // 清理超过4h的旧成交
        const oldLen = this.vpTradeBuffer.length;
        if (oldLen > 0 && this.vpTradeBuffer[0].ts < cutoff) {
            // 找到第一个在窗口内的索引
            let idx = 0;
            while (idx < oldLen && this.vpTradeBuffer[idx].ts < cutoff) idx++;

            // 从 volumeMap 中减去被清理的成交量
            for (let i = 0; i < idx; i++) {
                const t = this.vpTradeBuffer[i];
                const cur = this.vpVolumeMap.get(t.binPrice) || 0;
                const newVal = cur - t.vol;
                if (newVal <= 0.001) this.vpVolumeMap.delete(t.binPrice);
                else this.vpVolumeMap.set(t.binPrice, newVal);
            }
            this.vpTradeBuffer = this.vpTradeBuffer.slice(idx);
        }

        // 计算当前 POC (成交量最大的价格层级)
        let maxVol = 0, poc = 0;
        for (const [binP, vol] of this.vpVolumeMap) {
            if (vol > maxVol) { maxVol = vol; poc = binP; }
        }
        this.vpPOC = poc;

        // 每4h轮换 prevPOC
        if (now - this.vpLastRotateTs >= this.VP_WINDOW_MS) {
            this.vpPrevPOC = this.vpPOC;
            this.vpLastRotateTs = now;
        }
        // 首次: 如果 prevPOC 为0且数据足够(>1h), 用当前POC初始化
        if (this.vpPrevPOC === 0 && this.vpTradeBuffer.length > 100) {
            this.vpPrevPOC = this.vpPOC;
        }
    }

    /** V200 POC 数据 */
    getPOCData(): { poc: number; prevPOC: number; slope: number; dir: "long" | "short" | ""; nodeCount: number } {
        const slope = this.vpPOC - this.vpPrevPOC;
        const dir = slope > 5 ? "long" as const : slope < -5 ? "short" as const : "" as const;
        return {
            poc: this.vpPOC,
            prevPOC: this.vpPrevPOC,
            slope,
            dir,
            nodeCount: this.vpVolumeMap.size,
        };
    }

    // ═══ V300 Value Area (70%) 计算 ═══
    getValueArea(): { vah: number; val: number; poc: number } {
        if (this.vpVolumeMap.size === 0) return { vah: 0, val: 0, poc: this.vpPOC };

        // 总成交量
        let totalVol = 0;
        for (const vol of this.vpVolumeMap.values()) totalVol += vol;

        // 按价格排序的分桶
        const sorted = Array.from(this.vpVolumeMap.entries()).sort((a, b) => a[0] - b[0]);
        const targetVol = totalVol * VA_PERCENTAGE;

        // 从 POC 向两侧扩展直到累积 70%
        const pocIdx = sorted.findIndex(([p]) => p === this.vpPOC);
        if (pocIdx === -1) return { vah: sorted[sorted.length - 1][0], val: sorted[0][0], poc: this.vpPOC };

        let accVol = sorted[pocIdx][1]; // POC 本身的量
        let lo = pocIdx, hi = pocIdx;

        while (accVol < targetVol && (lo > 0 || hi < sorted.length - 1)) {
            const loVol = lo > 0 ? sorted[lo - 1][1] : 0;
            const hiVol = hi < sorted.length - 1 ? sorted[hi + 1][1] : 0;

            if (loVol >= hiVol && lo > 0) {
                lo--;
                accVol += sorted[lo][1];
            } else if (hi < sorted.length - 1) {
                hi++;
                accVol += sorted[hi][1];
            } else if (lo > 0) {
                lo--;
                accVol += sorted[lo][1];
            } else {
                break;
            }
        }

        return { vah: sorted[hi][0], val: sorted[lo][0], poc: this.vpPOC };
    }

    // ═══ V300 CVD 数据 ═══
    getCVDData(): { cvd: number; slope: number; divergeHigh: boolean; divergeLow: boolean } {
        let slope = 0;
        if (this.cvdRing.length >= 2) {
            const last = this.cvdRing[this.cvdRing.length - 1];
            const prev = this.cvdRing[this.cvdRing.length - 2];
            slope = last.val - prev.val;
        }

        // 背离检测: 价格创高但 CVD 未创高
        const divergeHigh = this.cvdPriceHigh > 0 &&
            this.price >= this.cvdPriceHigh &&
            this.cvdTotal < this.cvdAtPriceHigh - CVD_DIVERGE_THRESHOLD;

        // 背离检测: 价格创低但 CVD 未创低
        const divergeLow = this.cvdPriceLow < Infinity &&
            this.price <= this.cvdPriceLow &&
            this.cvdTotal > this.cvdAtPriceLow + CVD_DIVERGE_THRESHOLD;

        return { cvd: this.cvdTotal, slope, divergeHigh, divergeLow };
    }

    // ═══ V300 吸收单检测结果 ═══
    getAbsorption(): { detected: boolean; side: "buy" | "sell" | "" } {
        return { detected: this.absorbDetected, side: this.absorbSide };
    }

    // ═══ V300 掃单检测结果 ═══
    getSweep(): { detected: boolean; side: "buy" | "sell" | "" } {
        // 清理过期
        const now = Date.now();
        while (this.sweepRing.length > 0 && now - this.sweepRing[0].ts > 30_000) {
            this.sweepRing.shift();
        }
        return { detected: this.sweepDetected, side: this.sweepSide };
    }

    // ═══ V300 假墙检测结果 ═══
    getFakeWall(): { detected: boolean; side: "ask" | "bid" | "" } {
        return { detected: this.fakeWallDetected, side: this.fakeWallSide };
    }

    handleDepth(depthData: any) {
        const asks = depthData?.asks || depthData?.a || [];
        const bids = depthData?.bids || depthData?.b || [];

        // DEBUG: 首次收到 depth 数据时打印原始格式
        if (this.askWallVol === 0 && (asks.length > 0 || bids.length > 0)) {
            log(`🔍 [${this.symbol}] Depth 原始数据: asks=${JSON.stringify(asks.slice(0, 2))} bids=${JSON.stringify(bids.slice(0, 2))}`);
        }
        if (this.askWallVol === 0 && asks.length === 0 && bids.length === 0) {
            log(`⚠️ [${this.symbol}] Depth asks/bids 为空! keys=${JSON.stringify(Object.keys(depthData || {}))} raw=${JSON.stringify(depthData).slice(0, 300)}`);
        }

        // ═══ V300: 保存旧墙量 (假墙检测用) ═══
        this.prevAskWallVol = this.askWallVol;
        this.prevBidWallVol = this.bidWallVol;

        // ═══ V300: 记录旧深度价格层 (掃单检测用) ═══
        const oldAskPrices = [...this.lastDepthAskPrices];
        const oldBidPrices = [...this.lastDepthBidPrices];

        let askVol = 0;
        let top3 = 0;
        let dom10Ask = 0;
        const newAskPrices: number[] = [];
        const maxLevels = Math.max(DOM_LEVELS, 5);
        for (let i = 0; i < Math.min(maxLevels, asks.length); i++) {
            const entry = asks[i];
            const vol = +(Array.isArray(entry) ? entry[1] : entry?.sz || entry?.qty || entry?.v || 0);
            const price = +(Array.isArray(entry) ? entry[0] : entry?.price || entry?.p || 0);
            if (i === 0) { this.bestAsk = price; this.l1AskVol = vol; }  // L1
            if (i < 5) askVol += vol;
            if (i < 3) top3 += vol;
            if (i < DOM_LEVELS) { dom10Ask += vol; newAskPrices.push(price); }
        }
        this.askWallVol = askVol;
        this.top3Depth = top3;
        this.dom10AskVol = dom10Ask;
        this.lastDepthAskPrices = newAskPrices;

        let bidVol = 0;
        let dom10Bid = 0;
        const newBidPrices: number[] = [];
        for (let i = 0; i < Math.min(maxLevels, bids.length); i++) {
            const entry = bids[i];
            const vol = +(Array.isArray(entry) ? entry[1] : entry?.sz || entry?.qty || entry?.v || 0);
            const price = +(Array.isArray(entry) ? entry[0] : entry?.price || entry?.p || 0);
            if (i === 0) { this.bestBid = price; this.l1BidVol = vol; }  // L1
            if (i < 5) bidVol += vol;
            if (i < DOM_LEVELS) { dom10Bid += vol; newBidPrices.push(price); }
        }
        this.bidWallVol = bidVol;
        this.dom10BidVol = dom10Bid;
        this.lastDepthBidPrices = newBidPrices;

        // 🔥 修复: 用 bestAsk/bestBid 中点作为备用价格 (解决只收到depth没有trade时price=$0)
        if (this.bestAsk > 0 && this.bestBid > 0) {
            const midPrice = (this.bestAsk + this.bestBid) / 2;
            if (this.price <= 0 || Date.now() - this.priceTs > 5000) {
                this.price = midPrice;
                this.priceTs = Date.now();
            }
        }

        // 记录牆体历史 (用于变化率计算)
        const now = Date.now();
        this.bidWallHistory.push({ ts: now, vol: bidVol });
        // 清理超过 10s 的旧记录
        while (this.bidWallHistory.length > 0 && now - this.bidWallHistory[0].ts > this.WALL_HISTORY_MS * 2) {
            this.bidWallHistory.shift();
        }

        // ═══ V300 掃单检测: 多层掛单被瞬间吃掉 ═══
        this.sweepDetected = false;
        this.sweepSide = "";
        if (oldAskPrices.length >= SWEEP_LAYER_MIN) {
            // 检查卖方掛单层级消失 (买方掃单向上吃)
            let layersGone = 0;
            for (const p of oldAskPrices) {
                if (!newAskPrices.includes(p)) layersGone++;
            }
            if (layersGone >= SWEEP_LAYER_MIN) {
                this.sweepDetected = true;
                this.sweepSide = "buy";
                this.sweepRing.push({ ts: now, layers: layersGone, side: "buy" });
            }
        }
        if (!this.sweepDetected && oldBidPrices.length >= SWEEP_LAYER_MIN) {
            // 检查买方掛单层级消失 (卖方掃单向下吃)
            let layersGone = 0;
            for (const p of oldBidPrices) {
                if (!newBidPrices.includes(p)) layersGone++;
            }
            if (layersGone >= SWEEP_LAYER_MIN) {
                this.sweepDetected = true;
                this.sweepSide = "sell";
                this.sweepRing.push({ ts: now, layers: layersGone, side: "sell" });
            }
        }

        // ═══ V300 假墙判断: 墙量大幅下降但对应成交量很少 = 被撤不是被吃 ═══
        this.fakeWallDetected = false;
        this.fakeWallSide = "";
        // 卖方假墙: askWall 大幅缩水但卖方成交量很少
        if (this.prevAskWallVol > 0) {
            const askDrop = (this.prevAskWallVol - this.askWallVol) / this.prevAskWallVol;
            if (askDrop >= FAKE_WALL_CANCEL_RATIO) {
                // 检查同期的买方成交量 — 如果很少说明不是被吃掉而是被撤
                const recentDelta = this.getDelta();
                if (recentDelta.buyDelta < this.prevAskWallVol * 0.3) {
                    this.fakeWallDetected = true;
                    this.fakeWallSide = "ask";
                }
            }
        }
        // 买方假墙: bidWall 大幅缩水但买方成交量很少
        if (!this.fakeWallDetected && this.prevBidWallVol > 0) {
            const bidDrop = (this.prevBidWallVol - this.bidWallVol) / this.prevBidWallVol;
            if (bidDrop >= FAKE_WALL_CANCEL_RATIO) {
                const recentDelta = this.getDelta();
                if (recentDelta.sellDelta < this.prevBidWallVol * 0.3) {
                    this.fakeWallDetected = true;
                    this.fakeWallSide = "bid";
                }
            }
        }
    }
}

// ═══════════════════════════════════════════════
// 主引擎 — 三币种 WS
// ═══════════════════════════════════════════════

export class BitunixWSEngine {
    private ws: WebSocket | null = null;
    private running = false;
    private _connected = false;
    private startTime = 0;
    private msgCount = 0;
    private reconnectCount = 0;

    // 三币种追踪器
    private sol: SymbolTracker;
    private btc: SymbolTracker;
    private eth: SymbolTracker;

    // V52.4 延迟诊断
    private _wsLatency = 0;
    private _wsLatencySum = 0;
    private _wsLatencyCount = 0;
    private _debugSampleLogged = false;
    private _wsLatencyMax = 0;
    private _highLatencyCount = 0;

    constructor() {
        this.sol = new SymbolTracker(SYMBOL);
        this.btc = new SymbolTracker(BTC_SYMBOL);
        this.eth = new SymbolTracker(ETH_SYMBOL);
    }

    start() {
        this.running = true;
        this.startTime = Date.now();
        this.connectWS();
        this.startDepthFallback();  // REST 备援
    }

    // ═══════════════════════════════════════════════
    // REST 深度同步 — 三币种强制轮询 (永不停止)
    // ═══════════════════════════════════════════════

    private startDepthFallback() {
        const BASE = "https://fapi.bitunix.com";
        let loggedOnce = false;

        setInterval(async () => {
            if (!this.running) return;

            // 三币种 REST 深度轮询 (始终活跃)
            const symbols = [
                { sym: SYMBOL, tracker: this.sol },
                { sym: BTC_SYMBOL, tracker: this.btc },
                { sym: ETH_SYMBOL, tracker: this.eth },
            ];

            for (const { sym, tracker } of symbols) {
                try {
                    const res = await fetch(`${BASE}/api/v1/futures/market/depth?symbol=${sym}&limit=20`);
                    const json = (await res.json()) as any;
                    if (String(json?.code) !== "0") continue;

                    const depthData = json?.data;
                    if (depthData) {
                        tracker.handleDepth(depthData);
                    }
                } catch {}
            }

            // 首次成功时打印一次
            if (!loggedOnce && (this.sol.askWallVol > 0 || this.sol.bidWallVol > 0)) {
                log(`✅ [REST] 三币种墙数据同步启动: SOL A:${this.sol.askWallVol.toFixed(1)} B:${this.sol.bidWallVol.toFixed(1)} | BTC A:${this.btc.askWallVol.toFixed(4)} B:${this.btc.bidWallVol.toFixed(4)}`);
                loggedOnce = true;
            }
        }, 2000);
    }

    stop() {
        this.running = false;
        this.ws?.close();
    }

    get connected(): boolean {
        return this._connected;
    }

    // ═══════════════════════════════════════════════
    // 因果快照 — 三币种数据 + V52.2 新增
    // ═══════════════════════════════════════════════

    getSnapshot(): CausalSnapshot {
        // SOL
        const solDelta = this.sol.getDelta();
        const solEfficiency = this.sol.getLastEfficiency();
        const solAvgEfficiency = this.sol.getAvgEfficiency();
        const solAvgVol = this.sol.getAvgVol();
        const solRecentVol = this.sol.getRecentVol();
        const isEfficiencyDecay = solRecentVol > solAvgVol * 3 && solEfficiency < 0.2;

        // BTC
        const btcDelta = this.btc.getDelta();

        // ETH
        const ethDelta = this.eth.getDelta();
        const ethEfficiency = this.eth.getLastEfficiency();
        const ethAvgEfficiency = this.eth.getAvgEfficiency();

        return {
            price: this.sol.price,
            priceTs: this.sol.priceTs,
            connected: this._connected,

            buyDelta: solDelta.buyDelta,
            sellDelta: solDelta.sellDelta,
            netDelta: solDelta.buyDelta - solDelta.sellDelta,

            askWallVol: this.sol.askWallVol,
            bidWallVol: this.sol.bidWallVol,
            bestAsk: this.sol.bestAsk,
            bestBid: this.sol.bestBid,
            spread: this.sol.bestAsk > 0 && this.sol.bestBid > 0
                ? this.sol.bestAsk - this.sol.bestBid : 999,

            efficiency: solEfficiency,
            avgEfficiency: solAvgEfficiency,
            avgVol: solAvgVol,
            recentVol: solRecentVol,
            isEfficiencyDecay,

            // BTC
            btcPrice: this.btc.price,
            btcBuyDelta: btcDelta.buyDelta,
            btcSellDelta: btcDelta.sellDelta,
            btcAskWallVol: this.btc.askWallVol,
            btcBidWallVol: this.btc.bidWallVol,
            btcConnected: this.btc.price > 0,

            // ETH
            ethPrice: this.eth.price,
            ethBuyDelta: ethDelta.buyDelta,
            ethSellDelta: ethDelta.sellDelta,
            ethAskWallVol: this.eth.askWallVol,
            ethBidWallVol: this.eth.bidWallVol,
            ethEfficiency,
            ethAvgEfficiency,
            ethConnected: this.eth.price > 0,

            // V52.2
            ethSpread: this.eth.bestAsk > 0 && this.eth.bestBid > 0
                ? this.eth.bestAsk - this.eth.bestBid : 999,
            ethBestAsk: this.eth.bestAsk,
            ethBestBid: this.eth.bestBid,
            ethTop3Depth: this.eth.top3Depth,
            recentDeltaDirs: this.sol.getRecentDeltaDirs(),
            ethRecentDeltaDirs: this.eth.getRecentDeltaDirs(),

            // 能量 vs 阻力
            ethL1AskVol: this.eth.l1AskVol,
            ethL1BidVol: this.eth.l1BidVol,
            ethInstantVol: this.eth.getInstantVol(2000),
            ethBidWallChange: this.eth.getBidWallChange(),
            ethLastPrice: this.eth.lastPrice,
            ethAvgVol: this.eth.getAvgVol(),

            // V200 POC Volume Profile
            ...(() => {
                const p = this.eth.getPOCData();
                return { ethPOC: p.poc, ethPrevPOC: p.prevPOC, ethPOCSlope: p.slope, ethPOCDir: p.dir, ethVPNodeCount: p.nodeCount };
            })(),

            // V95 大单 Delta 引擎
            // 注意: 当 SYMBOL=ETHUSDT 时, ETH数据流入 sol 追踪器
            // 所以从 sol 读取大单数据 (= 主交易币种)
            ...(() => {
                const bd = this.sol.getBigDelta();
                return {
                    ethBigBuyDelta: bd.buyDelta,
                    ethBigSellDelta: bd.sellDelta,
                    ethBigNetDelta: bd.netDelta,
                    ethBigCVD: this.sol.getBigCVD(),
                    ethBigRatio: this.sol.getBigRatio(),
                    ethBigOrderCount: this.sol.getBigOrderCount(),
                };
            })(),

            // V300 订单流检测
            ...(() => {
                const cvdData = this.sol.getCVDData();
                const va = this.sol.getValueArea();
                const absorb = this.sol.getAbsorption();
                const sweep = this.sol.getSweep();
                const fakeWall = this.sol.getFakeWall();
                return {
                    ethCVD: cvdData.cvd,
                    ethCVDSlope: cvdData.slope,
                    ethVAH: va.vah,
                    ethVAL: va.val,
                    ethAbsorption: absorb.detected,
                    ethAbsorptionSide: absorb.side,
                    ethSweep: sweep.detected,
                    ethSweepSide: sweep.side,
                    ethFakeWall: fakeWall.detected,
                    ethFakeWallSide: fakeWall.side,
                    ethDOM10AskVol: this.sol.dom10AskVol,
                    ethDOM10BidVol: this.sol.dom10BidVol,
                };
            })(),

            // 延迟诊断
            wsLatencyMs: this._wsLatency,
            wsLatencyAvg: this._wsLatencyCount > 0 ? Math.round(this._wsLatencySum / this._wsLatencyCount) : 0,
            wsLatencyMax: this._wsLatencyMax,
            highLatencyCount: this._highLatencyCount,
        };
    }

    // ═══════════════════════════════════════════════
    // WebSocket 连接 — 三币种订阅
    // ═══════════════════════════════════════════════

    private connectWS() {
        const url = BITUNIX_WS_PUBLIC;
        log(`🔌 连接 Bitunix WS: ${url}`);

        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
            this._connected = true;
            this.reconnectCount = 0;
            log("✅ Bitunix WS 已连接, 订阅三币种频道...");

            const subscribeMsg = JSON.stringify({
                op: "subscribe",
                args: [
                    { ch: "market_trade", symbol: SYMBOL },
                    { ch: "depth_book15", symbol: SYMBOL },
                    { ch: "market_kline_1min", symbol: SYMBOL },
                    { ch: "market_trade", symbol: BTC_SYMBOL },
                    { ch: "depth_book15", symbol: BTC_SYMBOL },
                    { ch: "market_trade", symbol: ETH_SYMBOL },
                    { ch: "depth_book15", symbol: ETH_SYMBOL },
                    { ch: "market_kline_1min", symbol: ETH_SYMBOL },
                ],
            });
            this.ws!.send(subscribeMsg);
            log(`📡 已订阅: trade+depth+kline [${SYMBOL}] [${BTC_SYMBOL}] [${ETH_SYMBOL}]`);
        };

        this.ws.onclose = () => {
            this._connected = false;
            if (this.running) {
                this.reconnectCount++;
                const delay = Math.min(30000, 1000 * Math.pow(2, this.reconnectCount));
                log(`🔌 断线, ${delay / 1000}s 后重连 (#${this.reconnectCount})`);
                setTimeout(() => this.connectWS(), delay);
            }
        };

        this.ws.onerror = (e) => {
            log(`❌ WS 错误: ${e}`);
        };

        this.ws.onmessage = (event) => {
            this.msgCount++;
            try {
                const msg = JSON.parse(event.data as string);
                this.handleMessage(msg);
            } catch {}
        };

        setInterval(() => {
            if (this._connected && this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ op: "ping" }));
            }
        }, 15_000);
    }

    // ═══════════════════════════════════════════════
    // 消息路由 — 三币种分发
    // ═══════════════════════════════════════════════

    private handleMessage(msg: any) {
        if (msg === "pong" || msg?.op === "pong") return;

        if (msg?.op === "subscribe") {
            log(`✅ 订阅确认: ${JSON.stringify(msg?.args || msg)}`);
            return;
        }

        // DEBUG: 打印前 10 条非 pong 消息的完整结构
        if (this.msgCount <= 10) {
            log(`🔬 MSG#${this.msgCount}: ${JSON.stringify(msg).slice(0, 500)}`);
        }

        const ch = msg?.ch || msg?.arg?.ch || "";
        const symbol = msg?.symbol || msg?.arg?.symbol || "";
        const data = msg?.data;

        // DEBUG: WS 数据流诊断
        if (this.msgCount <= 30) {
            const firstItem = Array.isArray(data) ? data[0] : data;
            log(`📡 WS: ch=${ch} sym=${symbol} price=${firstItem?.c || firstItem?.p || "no_price"}`);
        }

        if (!data) return;

        const tracker = this.getTracker(symbol);
        if (!tracker) return;

        if (ch === "trade" || ch.includes("trade")) {
            // V52.4 延迟诊断: 计算 WS trade 事件延迟
            const tradeList = Array.isArray(data) ? data : [data];

            // 首次 trade: 打印一次字段样本 (之后不再打印)
            if (!this._debugSampleLogged && tradeList.length > 0) {
                const sample = tradeList[0];
                log(`🔬 [LATENCY] Trade 字段: ${JSON.stringify(Object.keys(sample))} | 样本: ${JSON.stringify(sample).slice(0, 300)}`);
                this._debugSampleLogged = true;
            }

            for (const t of tradeList) {
                // 尝试所有可能的时间戳字段名 (支持 ISO 字符串和数字)
                let eventTs = 0;
                const rawTs = t.ts || t.T || t.t || t.time || t.E || t.timestamp || t.tradeTime || 0;
                if (typeof rawTs === "string" && rawTs.includes("T")) {
                    eventTs = new Date(rawTs).getTime(); // ISO 字符串
                } else {
                    eventTs = +rawTs;
                }

                // 如果是秒级时间戳 (10位数), 转为毫秒
                if (eventTs > 0 && eventTs < 1e12) eventTs *= 1000;

                if (eventTs > 0) {
                    const latency = Date.now() - eventTs;
                    if (latency >= 0 && latency < 60_000) {  // 合理范围
                        this._wsLatency = latency;
                        this._wsLatencySum += latency;
                        this._wsLatencyCount++;
                        if (latency > this._wsLatencyMax) this._wsLatencyMax = latency;
                        if (latency > 200) {
                            this._highLatencyCount++;
                        }
                        // 首次成功提取延迟时打印
                        if (this._wsLatencyCount === 1) {
                            log(`✅ [LATENCY] 首次检测: ${latency}ms (eventTs=${eventTs})`);
                        }
                    }
                }
            }
            tracker.handleTrade(data);
        } else if (ch === "depth5" || ch.includes("depth")) {
            tracker.handleDepth(data);
        } else if (ch.includes("kline")) {
            // 处理 K线数据 — 每根完成的单根 K线
            const klineList = Array.isArray(data) ? data : [data];
            for (const k of klineList) {
                const o = +(k.o || k.open || 0);
                const h = +(k.h || k.high || 0);
                const l = +(k.l || k.low || 0);
                const c = +(k.c || k.close || 0);
                const v = +(k.v || k.vol || k.volume || 0);
                if (h > 0 && l > 0 && c > 0) {
                    tracker.lastKlineOHLC = { o, h, l, c, v };
                }
            }
        }
    }

    private getTracker(symbol: string): SymbolTracker | null {
        const upper = (symbol || "").toUpperCase();
        if (upper === SYMBOL || upper.includes("SOL")) return this.sol;
        if (upper === BTC_SYMBOL || upper.includes("BTC")) return this.btc;
        if (upper === ETH_SYMBOL || upper.includes("ETH")) return this.eth;
        return null;
    }
}
