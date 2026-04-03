/**
 * 📊 Binance Futures 数据获取器
 * ═══════════════════════════════════════════════
 * 定时从 Binance Futures API 拉取:
 *  - 5m / 30m / 4h K线 (含 takerBuyBase)
 *  - Funding Rate
 *  - Open Interest 历史
 *  - Long/Short Account Ratio
 *
 * 用于 ObserverScorer v15 的 8 层评分系统
 */

const BINANCE_FAPI = "https://fapi.binance.com";
const BINANCE_SPOT = "https://api.binance.com";
const SYMBOL = "ETHUSDT";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [binance] ${msg}`);
}

// ─────────────────────────────────────────────
// Data Types
// ─────────────────────────────────────────────

export interface BKline {
    time: number; open: number; high: number; low: number; close: number;
    volume: number; takerBuyBase: number; takerSellBase: number;
    delta: number; // takerBuy - takerSell
}

export interface FundingRecord { time: number; fundingRate: number; }
export interface OIRecord { time: number; oi: number; }
export interface LSRecord { time: number; longShortRatio: number; }

// ─────────────────────────────────────────────
// Fetcher
// ─────────────────────────────────────────────

async function fetchJson(url: string): Promise<any> {
    const res = await fetch(url, {
        headers: { "User-Agent": "dollarprinter-observer/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.json();
}

function parseKlines(rows: any[][]): BKline[] {
    return rows.map((k) => {
        const vol = +k[5], takerBuy = +k[9], takerSell = vol - takerBuy;
        return {
            time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4],
            volume: vol, takerBuyBase: takerBuy, takerSellBase: takerSell,
            delta: takerBuy - takerSell,
        };
    });
}

// ═══════════════════════════════════════════════
// BinanceDataFetcher
// ═══════════════════════════════════════════════

export class BinanceDataFetcher {
    k5: BKline[] = [];   // 5m klines
    k30: BKline[] = [];  // 30m klines
    k4h: BKline[] = [];  // 4h klines
    funding: FundingRecord[] = [];
    oiHistory: OIRecord[] = [];
    lsHistory: LSRecord[] = [];

    private _ready = false;
    private _pollTimer: ReturnType<typeof setInterval> | null = null;
    private _slowPollTimer: ReturnType<typeof setInterval> | null = null;

    get ready(): boolean { return this._ready; }

    /** 初始化 — 一次拉全部历史数据 */
    async init(): Promise<void> {
        try {
            const [r5, r30, r4h, rF, rOI, rLS] = await Promise.all([
                this.fetchKlines("5m", 500),
                this.fetchKlines("30m", 240),
                this.fetchKlines4h(240),
                this.fetchFunding(),
                this.fetchOI(500),
                this.fetchLS(500),
            ]);
            this.k5 = r5; this.k30 = r30; this.k4h = r4h;
            this.funding = rF; this.oiHistory = rOI; this.lsHistory = rLS;
            this._ready = true;
            log(`✅ 初始化完成: 5m=${r5.length} 30m=${r30.length} 4h=${r4h.length} FR=${rF.length} OI=${rOI.length} LS=${rLS.length}`);
        } catch (e: any) {
            log(`⚠️ 初始化失败: ${e.message}`);
        }
    }

    /** 启动定时轮询 */
    startPolling() {
        // 5m klines: 每 30 秒刷新最新 3 根
        this._pollTimer = setInterval(() => this.refreshFast(), 30_000);
        // 30m/4h/funding/OI/LS: 每 5 分钟刷新
        this._slowPollTimer = setInterval(() => this.refreshSlow(), 5 * 60_000);
        log("📡 Binance 轮询已启动 (5m@30s, slow@5min)");
    }

    stop() {
        if (this._pollTimer) clearInterval(this._pollTimer);
        if (this._slowPollTimer) clearInterval(this._slowPollTimer);
    }

    // ── 快速刷新 (5m klines) ──
    private async refreshFast() {
        try {
            const fresh = await this.fetchKlines("5m", 3);
            if (!fresh.length) return;
            // 合并: 根据 time 去重
            for (const k of fresh) {
                const idx = this.k5.findIndex(x => x.time === k.time);
                if (idx >= 0) this.k5[idx] = k;
                else this.k5.push(k);
            }
            // 保留最近 500 根
            if (this.k5.length > 500) this.k5 = this.k5.slice(-500);
        } catch { /* silent */ }
    }

    // ── 慢速刷新 (30m/4h/funding/OI/LS) ──
    private async refreshSlow() {
        try {
            const [r30, r4h, rF, rOI, rLS] = await Promise.all([
                this.fetchKlines("30m", 5),
                this.fetchKlines4h(5),
                this.fetchFunding(),
                this.fetchOI(10),
                this.fetchLS(10),
            ]);
            // 合并 30m
            for (const k of r30) {
                const idx = this.k30.findIndex(x => x.time === k.time);
                if (idx >= 0) this.k30[idx] = k; else this.k30.push(k);
            }
            if (this.k30.length > 240) this.k30 = this.k30.slice(-240);
            // 合并 4h
            for (const k of r4h) {
                const idx = this.k4h.findIndex(x => x.time === k.time);
                if (idx >= 0) this.k4h[idx] = k; else this.k4h.push(k);
            }
            if (this.k4h.length > 240) this.k4h = this.k4h.slice(-240);
            // 覆盖
            if (rF.length) this.funding = rF;
            for (const r of rOI) {
                if (!this.oiHistory.find(x => x.time === r.time)) this.oiHistory.push(r);
            }
            if (this.oiHistory.length > 500) this.oiHistory = this.oiHistory.slice(-500);
            for (const r of rLS) {
                if (!this.lsHistory.find(x => x.time === r.time)) this.lsHistory.push(r);
            }
            if (this.lsHistory.length > 500) this.lsHistory = this.lsHistory.slice(-500);
        } catch { /* silent */ }
    }

    // ── API 调用 ──
    private async fetchKlines(interval: string, limit: number): Promise<BKline[]> {
        const rows = await fetchJson(`${BINANCE_FAPI}/fapi/v1/klines?symbol=${SYMBOL}&interval=${interval}&limit=${limit}`);
        return parseKlines(rows);
    }
    private async fetchKlines4h(limit: number): Promise<BKline[]> {
        const rows = await fetchJson(`${BINANCE_FAPI}/fapi/v1/klines?symbol=${SYMBOL}&interval=4h&limit=${limit}`);
        return parseKlines(rows);
    }
    private async fetchFunding(): Promise<FundingRecord[]> {
        const rows = await fetchJson(`${BINANCE_FAPI}/fapi/v1/fundingRate?symbol=${SYMBOL}&limit=100`);
        return rows.map((x: any) => ({ time: +x.fundingTime, fundingRate: +x.fundingRate }));
    }
    private async fetchOI(limit: number): Promise<OIRecord[]> {
        try {
            const rows = await fetchJson(`${BINANCE_FAPI}/futures/data/openInterestHist?symbol=${SYMBOL}&period=5m&limit=${limit}`);
            return rows.map((x: any) => ({ time: +x.timestamp, oi: +x.sumOpenInterest }));
        } catch { return []; }
    }
    private async fetchLS(limit: number): Promise<LSRecord[]> {
        try {
            const rows = await fetchJson(`${BINANCE_FAPI}/futures/data/topLongShortAccountRatio?symbol=${SYMBOL}&period=5m&limit=${limit}`);
            return rows.map((x: any) => ({ time: +x.timestamp, longShortRatio: +x.longShortRatio }));
        } catch { return []; }
    }

    /** 获取最近的 funding rate */
    latestFunding(): number {
        if (!this.funding.length) return 0;
        return this.funding[this.funding.length - 1].fundingRate;
    }

    /** 获取最近 15 分钟的 OI 变化百分比 */
    latestOIChange(): number {
        if (this.oiHistory.length < 2) return 0;
        const now = this.oiHistory[this.oiHistory.length - 1];
        const prev = this.nearest(this.oiHistory, now.time - 900_000);
        if (!prev) return 0;
        return ((now.oi - prev.oi) / prev.oi) * 100;
    }

    /** 获取最近的 Long/Short ratio */
    latestLS(): LSRecord | null {
        return this.lsHistory.length ? this.lsHistory[this.lsHistory.length - 1] : null;
    }

    private nearest<T extends { time: number }>(arr: T[], t: number): T | null {
        let best: T | null = null;
        for (const r of arr) { if (r.time <= t) best = r; else break; }
        return best;
    }
}
