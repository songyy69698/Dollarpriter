/**
 * 🧠 V92b 本周策略: Mom12>40 只做多
 * ═══════════════════════════════════════════════════════
 * 本周判断 (3/19 周日扫描):
 *   RSI=19 极度超卖 → 只做多（反弹概率高）
 *   连涨3周后昨天暴跌5% → Mom12<-40 容易触发
 *   做空不适合（超卖环境做空被反弹打）
 *
 * 入场: Mom12 < -40pt（1小时跌超40pt → 做多抓反弹）
 *       + 成交量 ≥ 1.5x（用已完成K线）
 * 保护: ATR < 55
 * 出场: SL=8 → BE5+1 → TR15
 *
 * 下周日重新判断是否换策略
 */

import {
    TRADE_WINDOWS, ETH_SYMBOL, COOLDOWN_MS, BINANCE_BASE,
    ATR_BAN_THRESHOLD, MARGIN_PER_TRADE, LEVERAGE,
    INITIAL_SL_PT, BREAKEVEN_PT, TRAILING_PT,
} from "./config";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [strategy] ${msg}`);
}

export interface Mom12Signal {
    side: "long" | "short";
    price: number;
    qty: number;
    reason: string;
    targetSymbol: string;
    windowName: string;
    momentum: number;
    volRatio: number;
}

export type CausalSignal = Mom12Signal;
export type WindowSignal = Mom12Signal;

interface K5m {
    ts: number; o: number; h: number; l: number; c: number; v: number;
}

export class Mom12Strategy {
    private lastTradeTs = 0;
    private scanCount = 0;
    private _pendingSignal: Mom12Signal | null = null;
    private _ceoApproved = false;
    private lastWindowSignal = "";

    private klines: K5m[] = [];
    private lastFetchTs = 0;
    private ema200 = 0;
    private ema200Ready = false;

    getScanCount() { return this.scanCount; }
    get pendingSignal() { return this._pendingSignal; }
    get ceoApproved() { return this._ceoApproved; }

    approveTrade() { this._ceoApproved = true; log("✅ CEO 确认开单!"); }
    clearPending() { this._pendingSignal = null; this._ceoApproved = false; }
    markTraded() { this.lastTradeTs = Date.now(); this.clearPending(); }

    /** 拉取最新 5m K线 */
    async refreshKlines() {
        const now = Date.now();
        if (now - this.lastFetchTs < 290_000) return;
        this.lastFetchTs = now;

        try {
            const end = now;
            const start = end - 250 * 5 * 60_000;
            const url = `${BINANCE_BASE}/api/v3/klines?symbol=ETHUSDT&interval=5m&startTime=${start}&endTime=${end}&limit=250`;
            const res = await fetch(url);
            if (!res.ok) return;
            const data = (await res.json()) as any[][];

            this.klines = data.map(k => ({
                ts: k[0] as number, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
            }));

            if (this.klines.length >= 200) {
                if (!this.ema200Ready) {
                    this.ema200 = this.klines.slice(-200).reduce((s, k) => s + k.c, 0) / 200;
                    this.ema200Ready = true;
                } else {
                    const last = this.klines[this.klines.length - 2];
                    const m = 2 / 201;
                    this.ema200 = last.c * m + this.ema200 * (1 - m);
                }
            }

            if (this.scanCount % 12 === 0) {
                const k = this.klines.length >= 2 ? this.klines[this.klines.length - 2] : this.klines[this.klines.length - 1];
                log(`📊 K5m: ${this.klines.length}根 | $${k.c.toFixed(2)} | EMA200=$${this.ema200.toFixed(2)} | Mom12=${this.mom12().toFixed(1)} | ATR=${this.atr14().toFixed(1)}`);
            }
        } catch (e) {
            log(`⚠️ K线拉取失败: ${e}`);
        }
    }

    // ═══ 指标 (全部用倒数第二根已完成K线) ═══

    private mom12(): number {
        const n = this.klines.length;
        return n >= 14 ? this.klines[n - 2].c - this.klines[n - 14].c : 0;
    }

    private atr14(): number {
        const n = this.klines.length; if (n < 16) return 0;
        let s = 0; for (let i = n - 15; i < n - 1; i++) s += this.klines[i].h - this.klines[i].l;
        return s / 14;
    }

    private avgVol(): number {
        const n = this.klines.length; if (n < 22) return 1;
        let s = 0; for (let i = n - 21; i < n - 1; i++) s += this.klines[i].v;
        return s / 20;
    }

    private curVol(): number {
        return this.klines.length >= 2 ? this.klines[this.klines.length - 2].v : 0;
    }

    /** 本周策略: 只做多 */
    evaluate(): Mom12Signal | null {
        this.scanCount++;
        const now = Date.now();
        if (now - this.lastTradeTs < COOLDOWN_MS) return null;
        if (this._pendingSignal) return null;
        if (this.klines.length < 20 || !this.ema200Ready) return null;

        // ═══ Step 1: 时间窗口 ═══
        const dt = new Date();
        const utc8H = (dt.getUTCHours() + 8) % 24;
        const utc8M = dt.getUTCMinutes();
        const hm = utc8H * 60 + utc8M;

        let activeWindow: typeof TRADE_WINDOWS[0] | null = null;
        for (const w of TRADE_WINDOWS) {
            const ws = w.startHour * 60 + w.startMin;
            const we = w.endHour * 60 + w.endMin;
            if (hm >= ws && hm < we) { activeWindow = w; break; }
        }
        if (!activeWindow) { this.lastWindowSignal = ""; return null; }
        if (this.lastWindowSignal === activeWindow.name) return null;

        // ═══ Step 2: ATR 保护 ═══
        const atr = this.atr14();
        if (atr > ATR_BAN_THRESHOLD) {
            log(`🛡️ ATR=${atr.toFixed(1)} > ${ATR_BAN_THRESHOLD} 禁入`);
            return null;
        }

        // ═══ Step 3: Mom12 动量 (只做多: 跌超40pt) ═══
        const mom = this.mom12();
        if (mom >= -40) return null; // 本周只接跌超40pt的做多信号

        // ═══ Step 4: 成交量确认 (放宽到1.5x) ═══
        const volRatio = this.curVol() / this.avgVol();
        if (volRatio < 1.5) return null;

        // ═══ Step 5: 做多 ═══
        const price = this.klines[this.klines.length - 2].c;
        const reason = `📈 ${activeWindow.name} Mom12=${mom.toFixed(1)}pt 做多(超卖反弹) | 量=${volRatio.toFixed(1)}x | ATR=${atr.toFixed(1)}`;

        const qty = (MARGIN_PER_TRADE * LEVERAGE) / price;
        const signal: Mom12Signal = {
            side: "long", price, qty, reason,
            targetSymbol: ETH_SYMBOL,
            windowName: activeWindow.name,
            momentum: mom, volRatio,
        };

        this.lastWindowSignal = activeWindow.name;
        this._pendingSignal = signal;
        this._ceoApproved = false;
        log(`📡 ${reason}`);
        return signal;
    }
}

export { Mom12Strategy as CausalStrategy };
export { Mom12Strategy as WindowStrategy };
