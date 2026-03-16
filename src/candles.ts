/**
 * 📊 V69 "NO-EXCUSE" — 15M/1M K线追踪器
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
    prev15mLow = 0;
    lowest2_15m = 0;
    highest2_15m = 0;
    last1mClose = 0;
    last1mHigh = 0;
    last1mLow = 0;

    // V80-DEFIANCE: ATR + 趋势
    private _atr15m = 0;
    get atr15m(): number { return this._atr15m; }

    /** 最近3根15m是否趋势对齐 (连涨或连跌) */
    isTrendAligned(): boolean {
        const c = this._candles15m;
        if (c.length < 3) return false;
        const last3 = c.slice(-3);
        const allUp = last3.every(k => k.close > k.open);
        const allDown = last3.every(k => k.close < k.open);
        return allUp || allDown;
    }

    /** 趋势方向: 1=多头, -1=空头, 0=无 */
    trendDirection(): number {
        const c = this._candles15m;
        if (c.length < 3) return 0;
        const last3 = c.slice(-3);
        if (last3.every(k => k.close > k.open)) return 1;
        if (last3.every(k => k.close < k.open)) return -1;
        return 0;
    }

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

        // V80-DEFIANCE: ATR_15m = 最近4根15m的平均振幅
        if (closedCandles.length > 0) {
            const atrSum = closedCandles.reduce((s, k) => s + (k.high - k.low), 0);
            this._atr15m = atrSum / closedCandles.length;
        }
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
    // V80.1 振幅疲劳仪
    // ═══════════════════════════════════════════════

    private _avg1hAmplitude = 0;       // 70 天 1H 平均振幅 (pt)
    private _currentHourHigh = 0;
    private _currentHourLow = Infinity;
    private _currentHourStart = 0;     // 当前小时起始 ts

    get avg1hAmplitude(): number { return this._avg1hAmplitude; }

    /** 启动时拉取 70 天 1H K 线计算平均振幅 */
    async bootstrapAmplitude(): Promise<boolean> {
        try {
            // 拉 70 天 ≈ 1680 根 1H K 线 (Bitunix limit 可能有限制，分批拉)
            const limit = 500; // Bitunix 单次上限
            let allAmplitudes: number[] = [];

            for (let batch = 0; batch < 4; batch++) {
                const url = `${BITUNIX_BASE}/api/v1/futures/market/kline?symbol=${this._symbol}&interval=1h&limit=${limit}`;
                const res = await fetch(url);
                const json = (await res.json()) as any;
                if (String(json?.code) !== "0" || !Array.isArray(json?.data)) {
                    log(`⚠️ 1H K线拉取失败 batch=${batch}`);
                    break;
                }

                const candles = json.data;
                for (const k of candles) {
                    const h = +k.high;
                    const l = +k.low;
                    if (h > 0 && l > 0) {
                        allAmplitudes.push(h - l);
                    }
                }

                // 如果返回不足 limit，说明没有更多数据
                if (candles.length < limit) break;
            }

            if (allAmplitudes.length > 0) {
                const sum = allAmplitudes.reduce((a: number, b: number) => a + b, 0);
                this._avg1hAmplitude = sum / allAmplitudes.length;
                log(`📊 1H 均幅: ${this._avg1hAmplitude.toFixed(2)}pt (${allAmplitudes.length}根K线)`);
                return true;
            }
            log(`⚠️ 1H 振幅数据为空`);
            return false;
        } catch (e) {
            log(`❌ 1H 振幅计算异常: ${e}`);
            return false;
        }
    }

    /** 用实时价格更新当前小时的 high/low */
    updateRealtimePrice(price: number) {
        if (price <= 0) return;

        const now = Date.now();
        const hourMs = 3600_000;
        const currentHourTs = Math.floor(now / hourMs) * hourMs;

        // 新的一小时 → 重置
        if (currentHourTs !== this._currentHourStart) {
            this._currentHourStart = currentHourTs;
            this._currentHourHigh = price;
            this._currentHourLow = price;
            return;
        }

        if (price > this._currentHourHigh) this._currentHourHigh = price;
        if (price < this._currentHourLow) this._currentHourLow = price;
    }

    /** 获取疲劳比: currentAmplitude / avgAmplitude (0-∞) */
    getFatigue(): number {
        if (this._avg1hAmplitude <= 0) return 0;
        if (this._currentHourHigh <= 0 || this._currentHourLow === Infinity) return 0;
        const currentAmp = this._currentHourHigh - this._currentHourLow;
        return currentAmp / this._avg1hAmplitude;
    }

    /** 当前小时内价格在振幅中的位置 (0=底部, 1=顶部) */
    getPricePosition(price: number): number {
        if (this._currentHourHigh <= this._currentHourLow) return 0.5;
        return (price - this._currentHourLow) / (this._currentHourHigh - this._currentHourLow);
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
            // V80.1
            avg1hAmplitude: this._avg1hAmplitude,
            currentHourHigh: this._currentHourHigh,
            currentHourLow: this._currentHourLow === Infinity ? 0 : this._currentHourLow,
            fatigue: this.getFatigue(),
        };
    }
}

