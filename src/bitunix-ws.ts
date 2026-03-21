/**
 * 🔌 Bitunix WebSocket 数据引擎 — V75 能量 vs 阻力
 * ═══════════════════════════════════════════════════════
 * 三币种订阅: SOLUSDT + ETHUSDT + BTCUSDT
 * V75: L1 首档牆量 + 瞬时成交量 + 牆体变化率
 */

import {
    BITUNIX_WS_PUBLIC, SYMBOL, ETH_SYMBOL, BTC_SYMBOL,
    EFFICIENCY_WINDOW, AVG_VOL_WINDOW,
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

    // ── V75 能量 vs 阻力 ──
    ethL1AskVol: number;
    ethL1BidVol: number;
    ethInstantVol: number;
    ethBidWallChange: number;
    ethLastPrice: number;
    ethAvgVol: number;

    // ── V92 POC Volume Profile ──
    ethPOC: number;              // 当前4h POC价格
    ethPrevPOC: number;          // 前4h POC价格
    ethPOCSlope: number;         // POC位移 (current - previous)
    ethPOCDir: "long" | "short" | "";  // POC方向 (>5pt多 <-5pt空)
    ethVPNodeCount: number;      // Volume Profile 活跃价格层级数

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

    bestAsk = 0;
    bestBid = 0;
    askWallVol = 0;
    bidWallVol = 0;
    top3Depth = 0;

    // V75: L1 首档牆量
    l1AskVol = 0;
    l1BidVol = 0;

    // V75: 牆体变化率追踪
    bidWallHistory: { ts: number; vol: number }[] = [];
    readonly WALL_HISTORY_MS = 5_000;

    deltaRing: { ts: number; buyVol: number; sellVol: number; efficiency: number; vol: number }[] = [];
    readonly DELTA_WINDOW_MS = 10_000;

    efficiencyRing: number[] = [];
    volRing: number[] = [];
    lastPrice = 0;

    deltaDirRing: number[] = [];
    readonly DELTA_DIR_MAX = 10;

    // ═══ V92 Volume Profile POC ═══
    // 真实成交数据 bin=1.0pt, 滚动4h窗口
    private readonly VP_BIN_SIZE = 1.0;           // 价格分桶 1.0pt
    private readonly VP_WINDOW_MS = 4 * 3600_000; // 4小时滚动窗口
    private vpTradeBuffer: { ts: number; binPrice: number; vol: number }[] = [];
    private vpVolumeMap = new Map<number, number>(); // binPrice → totalVol
    private vpPOC = 0;           // 当前4h POC价格
    private vpPrevPOC = 0;       // 前4h POC (每4h更新一次)
    private vpLastRotateTs = 0;  // 上次轮换 prevPOC 的时间
    private vpLastCleanTs = 0;   // 上次清理的时间

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

    /** V75: 瞬时成交量 (最近 windowMs 毫秒的总成交量) */
    getInstantVol(windowMs = 2000): number {
        const now = Date.now();
        let total = 0;
        for (let i = this.deltaRing.length - 1; i >= 0; i--) {
            if (now - this.deltaRing[i].ts > windowMs) break;
            total += this.deltaRing[i].vol;
        }
        return total;
    }

    /** V75: 买盘牆变化率 (vs 5s 前，-0.6 = 下降 60%) */
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

            // ═══ V92 Volume Profile: 每笔成交加入分桶 ═══
            const binPrice = Math.round(tradePrice / this.VP_BIN_SIZE) * this.VP_BIN_SIZE;
            this.vpTradeBuffer.push({ ts: now, binPrice, vol: qty });
            this.vpVolumeMap.set(binPrice, (this.vpVolumeMap.get(binPrice) || 0) + qty);
        }

        // 每60秒清理超过4h的旧成交 + 重算POC
        if (now - this.vpLastCleanTs > 60_000) {
            this.vpCleanAndRecalc(now);
            this.vpLastCleanTs = now;
        }
    }

    // ═══ V92 Volume Profile 清理+重算 ═══
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

    /** V92 POC 数据 */
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

        let askVol = 0;
        let top3 = 0;
        for (let i = 0; i < Math.min(5, asks.length); i++) {
            const entry = asks[i];
            const vol = +(Array.isArray(entry) ? entry[1] : entry?.sz || entry?.qty || entry?.v || 0);
            const price = +(Array.isArray(entry) ? entry[0] : entry?.price || entry?.p || 0);
            if (i === 0) { this.bestAsk = price; this.l1AskVol = vol; }  // V75: L1
            askVol += vol;
            if (i < 3) top3 += vol;
        }
        this.askWallVol = askVol;
        this.top3Depth = top3;

        let bidVol = 0;
        for (let i = 0; i < Math.min(5, bids.length); i++) {
            const entry = bids[i];
            const vol = +(Array.isArray(entry) ? entry[1] : entry?.sz || entry?.qty || entry?.v || 0);
            const price = +(Array.isArray(entry) ? entry[0] : entry?.price || entry?.p || 0);
            if (i === 0) { this.bestBid = price; this.l1BidVol = vol; }  // V75: L1
            bidVol += vol;
        }
        this.bidWallVol = bidVol;

        // V75: 记录牆体历史 (用于变化率计算)
        const now = Date.now();
        this.bidWallHistory.push({ ts: now, vol: bidVol });
        // 清理超过 10s 的旧记录
        while (this.bidWallHistory.length > 0 && now - this.bidWallHistory[0].ts > this.WALL_HISTORY_MS * 2) {
            this.bidWallHistory.shift();
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
                    const res = await fetch(`${BASE}/api/v1/futures/market/depth?symbol=${sym}&limit=5`);
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

            // V75 能量 vs 阻力
            ethL1AskVol: this.eth.l1AskVol,
            ethL1BidVol: this.eth.l1BidVol,
            ethInstantVol: this.eth.getInstantVol(2000),
            ethBidWallChange: this.eth.getBidWallChange(),
            ethLastPrice: this.eth.lastPrice,
            ethAvgVol: this.eth.getAvgVol(),

            // V92 POC Volume Profile
            ...(() => {
                const p = this.eth.getPOCData();
                return { ethPOC: p.poc, ethPrevPOC: p.prevPOC, ethPOCSlope: p.slope, ethPOCDir: p.dir, ethVPNodeCount: p.nodeCount };
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
                    { ch: "trade", symbol: SYMBOL },
                    { ch: "depth", symbol: SYMBOL },
                    { ch: "trade", symbol: BTC_SYMBOL },
                    { ch: "depth", symbol: BTC_SYMBOL },
                    { ch: "trade", symbol: ETH_SYMBOL },
                    { ch: "depth", symbol: ETH_SYMBOL },
                ],
            });
            this.ws!.send(subscribeMsg);
            log(`📡 已订阅: [${SYMBOL}] + [${BTC_SYMBOL}] + [${ETH_SYMBOL}]`);
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
                            if (this._highLatencyCount <= 5 || this._highLatencyCount % 50 === 0) {
                                log(`⚠️ High WS Latency: ${latency}ms [${symbol}] (count=${this._highLatencyCount})`);
                            }
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
