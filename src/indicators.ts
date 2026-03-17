/**
 * 📊 V90 指标计算引擎
 * ═══════════════════════════════════════
 * 从 Binance 获取 5m K 线，计算:
 *   - VWAP (日内)
 *   - RSI(14)
 *   - 日振幅消耗比例
 *   - ATR(14)
 *   - 前 1 小时走势
 */

import { BINANCE_BASE, RSI_PERIOD } from "./config";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [indicators] ${msg}`);
}

export interface Candle5m {
    ts: number;     // 开盘时间戳 ms
    o: number;      // open
    h: number;      // high
    l: number;      // low
    c: number;      // close
    v: number;      // volume
}

/** 从 Binance 拉取 5m K 线 */
async function fetchBinanceKlines(symbol: string, interval: string, limit: number): Promise<Candle5m[]> {
    const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    try {
        const res = await fetch(url);
        const data = (await res.json()) as any[];
        return data.map((d: any) => ({
            ts: d[0] as number,
            o: +d[1],
            h: +d[2],
            l: +d[3],
            c: +d[4],
            v: +d[5],
        }));
    } catch (e) {
        log(`❌ Binance K线拉取失败: ${e}`);
        return [];
    }
}

/**
 * 指标管理器 — 维护 5m K 线缓存并计算指标
 */
export class IndicatorEngine {
    private candles5m: Candle5m[] = [];
    private prevDayRange = 0;    // 前一天的日振幅 (%)
    private _ready = false;

    get ready(): boolean { return this._ready; }

    /** 启动时预加载近 500 根 5m K 线 (约 42 小时) */
    async bootstrap(): Promise<boolean> {
        log("📊 预加载 Binance 5m K线...");
        const candles = await fetchBinanceKlines("ETHUSDT", "5m", 500);
        if (candles.length < 100) {
            log(`⚠️ K线不足: ${candles.length}`);
            return false;
        }
        this.candles5m = candles;
        this.computePrevDayRange();
        this._ready = true;
        log(`✅ 5m K线预加载: ${candles.length} 根 | 前日振幅: ${this.prevDayRange.toFixed(2)}%`);
        return true;
    }

    /** 定期刷新 (每 5 分钟调用一次) */
    async refresh(): Promise<void> {
        const latest = await fetchBinanceKlines("ETHUSDT", "5m", 20);
        if (latest.length === 0) return;

        // 合并: 去重后附加
        for (const c of latest) {
            const existing = this.candles5m.findIndex(x => x.ts === c.ts);
            if (existing >= 0) {
                this.candles5m[existing] = c; // 更新进行中的 K 线
            } else {
                this.candles5m.push(c);
            }
        }

        // 保留最近 600 根
        if (this.candles5m.length > 600) {
            this.candles5m = this.candles5m.slice(-600);
        }

        this.computePrevDayRange();
    }

    /** 计算前一天的日振幅 (%) */
    private computePrevDayRange(): void {
        const now = new Date();
        const utc8 = new Date(now.getTime() + 8 * 3600000);
        // 前一天日期 (UTC+8)
        const prevDate = new Date(utc8.getTime() - 86400000).toISOString().slice(0, 10);

        let hi = 0, lo = Infinity;
        for (const c of this.candles5m) {
            const d = new Date(c.ts + 8 * 3600000).toISOString().slice(0, 10);
            if (d !== prevDate) continue;
            hi = Math.max(hi, c.h);
            lo = Math.min(lo, c.l);
        }
        if (lo < Infinity && lo > 0) {
            this.prevDayRange = (hi - lo) / lo * 100;
        }
    }

    // ═══════════════════════════════════════
    // RSI(14)
    // ═══════════════════════════════════════
    getRSI(): number {
        const c = this.candles5m;
        if (c.length < RSI_PERIOD + 1) return 50;
        let gain = 0, loss = 0;
        for (let i = c.length - RSI_PERIOD; i < c.length; i++) {
            const change = c[i].c - c[i - 1].c;
            if (change > 0) gain += change;
            else loss -= change;
        }
        gain /= RSI_PERIOD;
        loss /= RSI_PERIOD;
        if (loss === 0) return 100;
        return 100 - 100 / (1 + gain / loss);
    }

    // ═══════════════════════════════════════
    // VWAP (当日，从 UTC+8 00:00 开始)
    // ═══════════════════════════════════════
    getVWAP(): number {
        const now = new Date();
        const today = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
        let pv = 0, vol = 0;
        for (const c of this.candles5m) {
            const d = new Date(c.ts + 8 * 3600000).toISOString().slice(0, 10);
            if (d !== today) continue;
            const tp = (c.h + c.l + c.c) / 3;
            pv += tp * c.v;
            vol += c.v;
        }
        return vol > 0 ? pv / vol : 0;
    }

    /** VWAP 偏离百分比 (正=价格高于VWAP，负=低于) */
    getVWAPDeviation(currentPrice: number): number {
        const vwap = this.getVWAP();
        if (vwap <= 0) return 0;
        return (currentPrice - vwap) / vwap * 100;
    }

    // ═══════════════════════════════════════
    // 日振幅已消耗比例 (0~∞)
    // ═══════════════════════════════════════
    getUsedRangeRatio(currentPrice: number): number {
        if (this.prevDayRange <= 0) return 0;
        const now = new Date();
        const today = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
        let hi = currentPrice, lo = currentPrice;
        for (const c of this.candles5m) {
            const d = new Date(c.ts + 8 * 3600000).toISOString().slice(0, 10);
            if (d !== today) continue;
            hi = Math.max(hi, c.h);
            lo = Math.min(lo, c.l);
        }
        if (lo <= 0) return 0;
        const usedPct = (hi - lo) / lo * 100;
        return usedPct / this.prevDayRange;
    }

    // ═══════════════════════════════════════
    // ATR(14)
    // ═══════════════════════════════════════
    getATR(): number {
        const c = this.candles5m;
        if (c.length < RSI_PERIOD) return 1;
        let sum = 0;
        for (let i = c.length - RSI_PERIOD; i < c.length; i++) {
            sum += c[i].h - c[i].l;
        }
        return sum / RSI_PERIOD;
    }

    /** 当前 K 线范围 / ATR */
    getCurrentBarRangeRatio(): number {
        if (this.candles5m.length === 0) return 0;
        const last = this.candles5m[this.candles5m.length - 1];
        const atr = this.getATR();
        return atr > 0 ? (last.h - last.l) / atr : 0;
    }

    // ═══════════════════════════════════════
    // 前 1 小时涨跌幅 (%)
    // ═══════════════════════════════════════
    getPrev1hChange(): number {
        const c = this.candles5m;
        if (c.length < 12) return 0;
        const start = c[c.length - 12].o;
        const end = c[c.length - 1].c;
        return start > 0 ? (end - start) / start * 100 : 0;
    }

    /** 最新价格 */
    getLatestPrice(): number {
        if (this.candles5m.length === 0) return 0;
        return this.candles5m[this.candles5m.length - 1].c;
    }

    /** 前日范围 */
    getPrevDayRange(): number {
        return this.prevDayRange;
    }

    // ═══════════════════════════════════════
    // 快照 (用于信号报告)
    // ═══════════════════════════════════════
    getSnapshot(currentPrice: number) {
        return {
            rsi: this.getRSI(),
            vwap: this.getVWAP(),
            vwapDev: this.getVWAPDeviation(currentPrice),
            usedRange: this.getUsedRangeRatio(currentPrice),
            atr: this.getATR(),
            barRangeRatio: this.getCurrentBarRangeRatio(),
            prev1hChange: this.getPrev1hChange(),
            prevDayRange: this.prevDayRange,
        };
    }
}
