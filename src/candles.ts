/**
 * 📊 V66 "LEVIATHAN" — 15M/1M K线追踪器
 * ═══════════════════════════════════════════════
 * REST 轮询 Bitunix K线 API, 构建 15M 和 1M 蜡烛数据
 * 提供结构性突破入场/出场所需的 High/Low 参考线
 */

import { BITUNIX_BASE, ETH_SYMBOL, CANDLE_POLL_MS, CANDLE_LOOKBACK } from "./config";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [candles] ${msg}`);
}

// ═══════════════════════════════════════════════
// K线数据结构
// ═══════════════════════════════════════════════

export interface Candle {
    open: number;
    high: number;
    low: number;
    close: number;
    ts: number;       // 开盘时间戳 (ms)
    volume: number;
}

// ═══════════════════════════════════════════════
// K线追踪器
// ═══════════════════════════════════════════════

export class CandleTracker {
    // 最近 5 根 K线缓存
    private _candles15m: Candle[] = [];
    private _candles1m: Candle[] = [];
    private _symbol: string;
    private _running = false;
    private _ready = false;

    // ═══ 结构性参考线 (公开, 供策略/执行器读取) ═══
    prev15mHigh = 0;             // 前一根已关闭 15M 最高价
    prev15mLow = Infinity;       // 前一根已关闭 15M 最低价
    lowest2_15m = Infinity;      // 最近 2 根 15M 最低低价
    highest2_15m = 0;            // 最近 2 根 15M 最高高价
    last1mClose = 0;             // 最新 1M 收盘价
    last1mHigh = 0;              // 最新 1M 最高价
    last1mLow = Infinity;        // 最新 1M 最低价

    constructor(symbol: string = ETH_SYMBOL) {
        this._symbol = symbol;
    }

    get ready(): boolean { return this._ready; }
    get candles15m(): Candle[] { return this._candles15m; }
    get candles1m(): Candle[] { return this._candles1m; }

    // ═══════════════════════════════════════════════
    // 启动轮询
    // ═══════════════════════════════════════════════

    start() {
        this._running = true;
        log(`📊 K线追踪器启动: ${this._symbol} | 轮询间隔 ${CANDLE_POLL_MS / 1000}s`);

        // 立即拉取一次
        this.poll();

        // 定时轮询
        setInterval(() => {
            if (this._running) this.poll();
        }, CANDLE_POLL_MS);
    }

    stop() {
        this._running = false;
    }

    // ═══════════════════════════════════════════════
    // REST 拉取 K线
    // ═══════════════════════════════════════════════

    private async poll() {
        try {
            const [ok15m, ok1m] = await Promise.all([
                this.fetchCandles("15min", 5),
                this.fetchCandles("1min", 5),
            ]);

            if (ok15m) this.update15mStructure();
            if (ok1m) this.update1mStructure();

            if (!this._ready && ok15m && ok1m) {
                this._ready = true;
                log(`✅ K线数据就绪: 15M=${this._candles15m.length}根 | 1M=${this._candles1m.length}根`);
                log(`📊 15M 结构: H2=${this.highest2_15m.toFixed(2)} L2=${this.lowest2_15m.toFixed(2)} | prev H=${this.prev15mHigh.toFixed(2)} L=${this.prev15mLow.toFixed(2)}`);
            }
        } catch (e) {
            log(`❌ K线轮询异常: ${e}`);
        }
    }

    private async fetchCandles(interval: string, limit: number): Promise<boolean> {
        try {
            const url = `${BITUNIX_BASE}/api/v1/futures/market/kline?symbol=${this._symbol}&klineType=${interval}&limit=${limit}`;
            const res = await fetch(url);
            const json = (await res.json()) as any;

            if (String(json?.code) !== "0") {
                if (!this._ready) log(`⚠️ K线 API [${interval}]: code=${json?.code} msg=${json?.msg}`);
                return false;
            }

            const rawList = json?.data || [];
            if (!Array.isArray(rawList) || rawList.length === 0) return false;

            const candles: Candle[] = rawList.map((k: any) => ({
                open: +(k.open || k.o || 0),
                high: +(k.high || k.h || 0),
                low: +(k.low || k.l || 0),
                close: +(k.close || k.c || 0),
                ts: +(k.ts || k.time || k.openTime || 0),
                volume: +(k.volume || k.vol || k.v || 0),
            })).filter((c: Candle) => c.high > 0 && c.low > 0);

            // 按时间排序 (旧→新)
            candles.sort((a: Candle, b: Candle) => a.ts - b.ts);

            if (interval === "15min") {
                this._candles15m = candles;
            } else {
                this._candles1m = candles;
            }

            return candles.length > 0;
        } catch {
            return false;
        }
    }

    // ═══════════════════════════════════════════════
    // 计算结构性参考线
    // ═══════════════════════════════════════════════

    private update15mStructure() {
        const c = this._candles15m;
        if (c.length < 2) return;

        // 前一根已关闭的 15M K线 (倒数第二根, 因为最后一根可能还在进行中)
        const prev = c[c.length - 2];
        this.prev15mHigh = prev.high;
        this.prev15mLow = prev.low;

        // 最近 N 根的极值 (用于突破入场)
        const lookback = Math.min(CANDLE_LOOKBACK, c.length - 1); // 排除当前进行中的
        const closedCandles = c.slice(-(lookback + 1), -1); // 取最近N根已关闭的

        this.lowest2_15m = Infinity;
        this.highest2_15m = 0;
        for (const candle of closedCandles) {
            if (candle.low < this.lowest2_15m) this.lowest2_15m = candle.low;
            if (candle.high > this.highest2_15m) this.highest2_15m = candle.high;
        }
    }

    private update1mStructure() {
        const c = this._candles1m;
        if (c.length === 0) return;

        // 最新 1M K线 (可能是进行中的)
        const latest = c[c.length - 1];
        this.last1mClose = latest.close;
        this.last1mHigh = latest.high;
        this.last1mLow = latest.low;
    }

    // ═══════════════════════════════════════════════
    // 状态快照
    // ═══════════════════════════════════════════════

    getSnapshot() {
        return {
            ready: this._ready,
            count15m: this._candles15m.length,
            count1m: this._candles1m.length,
            prev15mHigh: this.prev15mHigh,
            prev15mLow: this.prev15mLow,
            lowest2_15m: this.lowest2_15m,
            highest2_15m: this.highest2_15m,
            last1mClose: this.last1mClose,
            symbol: this._symbol,
        };
    }
}
