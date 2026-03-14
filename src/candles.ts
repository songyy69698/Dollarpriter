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
    private _candles15m: Candle[] = [];
    private _candles1m: Candle[] = [];
    private _symbol: string;
    private _running = false;
    private _ready = false;
    private _pollCount = 0;

    // ═══ 结构性参考线 (公开, 供策略/执行器读取) ═══
    prev15mHigh = 0;
    prev15mLow = 0;             // 改为 0 (不用 Infinity, 防止显示异常)
    lowest2_15m = 0;            // 改为 0
    highest2_15m = 0;
    last1mClose = 0;
    last1mHigh = 0;
    last1mLow = 0;              // 改为 0

    constructor(symbol: string = ETH_SYMBOL) {
        this._symbol = symbol;
    }

    get ready(): boolean { return this._ready; }
    get candles15m(): Candle[] { return this._candles15m; }
    get candles1m(): Candle[] { return this._candles1m; }

    // ═══════════════════════════════════════════════
    // 强制预加载 — 启动前调用, 确保数据就绪
    // ═══════════════════════════════════════════════

    async bootstrap(): Promise<boolean> {
        log(`📊 强制预加载 K线: ${this._symbol}`);
        for (let attempt = 1; attempt <= 3; attempt++) {
            const [ok15m, ok1m] = await Promise.all([
                this.fetchCandles("15m", 5),
                this.fetchCandles("1m", 5),
            ]);
            if (ok15m) this.update15mStructure();
            if (ok1m) this.update1mStructure();

            if (ok15m && ok1m && this.highest2_15m > 0 && this.lowest2_15m > 0) {
                this._ready = true;
                log(`✅ K线预加载成功 (第${attempt}次): 15M=${this._candles15m.length}根 | 1M=${this._candles1m.length}根`);
                log(`📊 H2=$${this.highest2_15m.toFixed(2)} | L2=$${this.lowest2_15m.toFixed(2)} | prevH=$${this.prev15mHigh.toFixed(2)} | prevL=$${this.prev15mLow.toFixed(2)}`);
                return true;
            }
            log(`⚠️ 预加载第${attempt}次失败, 重试...`);
            await new Promise(r => setTimeout(r, 2000));
        }
        log(`❌ K线预加载失败, 后台继续轮询`);
        return false;
    }

    // ═══════════════════════════════════════════════
    // 启动轮询
    // ═══════════════════════════════════════════════

    start() {
        this._running = true;
        log(`📊 K线轮询启动: ${this._symbol} | 间隔 ${CANDLE_POLL_MS / 1000}s`);

        setInterval(() => {
            if (this._running) this.poll();
        }, CANDLE_POLL_MS);
    }

    stop() { this._running = false; }

    // ═══════════════════════════════════════════════
    // REST 拉取 K线
    // ═══════════════════════════════════════════════

    private async poll() {
        this._pollCount++;
        try {
            const [ok15m, ok1m] = await Promise.all([
                this.fetchCandles("15m", 5),
                this.fetchCandles("1m", 5),
            ]);
            if (ok15m) this.update15mStructure();
            if (ok1m) this.update1mStructure();

            if (!this._ready && ok15m && ok1m && this.highest2_15m > 0) {
                this._ready = true;
                log(`✅ K线就绪 (poll#${this._pollCount})`);
            }
        } catch (e) {
            log(`❌ K线轮询异常: ${e}`);
        }
    }

    /**
     * Bitunix K线 API:
     *   GET /api/v1/futures/market/kline?symbol=ETHUSDT&interval=15m&limit=5
     *   返回: { code: 0, data: [{ open, high, low, close, quoteVol, baseVol, time }] }
     *   数据按时间降序 (最新在前)
     */
    private async fetchCandles(interval: string, limit: number): Promise<boolean> {
        try {
            const url = `${BITUNIX_BASE}/api/v1/futures/market/kline?symbol=${this._symbol}&interval=${interval}&limit=${limit}`;
            const res = await fetch(url);
            const json = (await res.json()) as any;

            if (String(json?.code) !== "0" || !Array.isArray(json?.data)) {
                if (this._pollCount <= 2) {
                    log(`⚠️ K线[${interval}]: code=${json?.code} msg=${json?.msg} | URL=${url}`);
                }
                return false;
            }

            const rawList = json.data;
            if (rawList.length === 0) return false;

            const candles: Candle[] = rawList.map((k: any) => ({
                open: +k.open,
                high: +k.high,
                low: +k.low,
                close: +k.close,
                ts: +k.time,
                volume: +(k.quoteVol || k.volume || 0),
            })).filter((c: Candle) => c.high > 0 && c.low > 0);

            // Bitunix 返回降序 (最新在前), 反转为升序 (旧→新)
            candles.reverse();

            if (interval === "15m") {
                this._candles15m = candles;
            } else {
                this._candles1m = candles;
            }

            return candles.length > 0;
        } catch (e) {
            if (this._pollCount <= 2) log(`❌ fetchCandles[${interval}] 异常: ${e}`);
            return false;
        }
    }

    // ═══════════════════════════════════════════════
    // 计算结构性参考线
    // ═══════════════════════════════════════════════

    private update15mStructure() {
        const c = this._candles15m;
        if (c.length < 2) return;

        // 前一根已关闭的 15M K线 (倒数第二根, 最后一根可能在进行中)
        const prev = c[c.length - 2];
        this.prev15mHigh = prev.high;
        this.prev15mLow = prev.low;

        // 最近 N 根已关闭 K线的极值 (用于突破入场)
        const lookback = Math.min(CANDLE_LOOKBACK, c.length - 1);
        const closedCandles = c.slice(-(lookback + 1), -1);

        let lo = Infinity, hi = 0;
        for (const candle of closedCandles) {
            if (candle.low < lo) lo = candle.low;
            if (candle.high > hi) hi = candle.high;
        }
        this.lowest2_15m = lo === Infinity ? 0 : lo;
        this.highest2_15m = hi;
    }

    private update1mStructure() {
        const c = this._candles1m;
        if (c.length === 0) return;
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
            pollCount: this._pollCount,
        };
    }
}
