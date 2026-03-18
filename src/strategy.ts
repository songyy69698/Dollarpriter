/**
 * 🧠 V92 本周灵活多空策略
 * ═══════════════════════════════════════════════════════
 * 基于229窗口×200+条件穷举得出的高胜率规则:
 *
 * 08窗口: RSI<35 → 做多 (71%胜率, 14笔, +$327)
 * 15窗口: RSI<25 → 做多 (86%胜率, 7笔, +$244)
 *         RSI 25-40 + Mom4<-5 → 做多 (60%胜率, +$597)
 * 22窗口: Mom12>+20 → 做空 (83%胜率, 6笔, +$595)
 *
 * 通用补充 (任何窗口):
 *   Mom4<-8 → 做多 (63%胜率, 35笔, +$601)
 *   Mom4>+8 → 做空 (60%胜率, 20笔, +$649)
 *   Mom12>+25 → 做空 (88%胜率, 8笔, +$599)
 *
 * 出场: executor.ts (SL=8 → 保本5+1 → 跟踪15)
 */

import {
    TRADE_WINDOWS, ETH_SYMBOL, COOLDOWN_MS, BINANCE_BASE,
    ATR_BAN_THRESHOLD, MARGIN_PER_TRADE, LEVERAGE,
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
                const k = this.klines[this.klines.length - 2];
                log(`📊 K5m: ${this.klines.length}根 | $${k.c.toFixed(2)} | RSI=${this.rsi14().toFixed(0)} | Mom12=${this.mom12().toFixed(1)} | Mom4=${this.mom4().toFixed(1)} | ATR=${this.atr14().toFixed(1)}`);
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

    private mom4(): number {
        const n = this.klines.length;
        return n >= 6 ? this.klines[n - 2].c - this.klines[n - 6].c : 0;
    }

    private atr14(): number {
        const n = this.klines.length; if (n < 16) return 0;
        let s = 0; for (let i = n - 15; i < n - 1; i++) s += this.klines[i].h - this.klines[i].l;
        return s / 14;
    }

    private rsi14(): number {
        const n = this.klines.length; if (n < 17) return 50;
        let g = 0, l = 0;
        for (let i = n - 15; i < n - 1; i++) {
            const d = this.klines[i].c - this.klines[i - 1].c;
            if (d > 0) g += d; else l += -d;
        }
        const ag = g / 14, al = l / 14;
        return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }

    /** V92 灵活多空入场 */
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

        // ═══ Step 3: 算指标 ═══
        const mom12 = this.mom12();
        const mom4 = this.mom4();
        const rsi = this.rsi14();
        const price = this.klines[this.klines.length - 2].c;
        const wn = activeWindow.name;

        let side: "long" | "short" | "" = "";
        let reason = "";

        // ═══ Step 4: 高胜率规则 (按胜率优先匹配) ═══

        // 88% — Mom12>25 做空 (任何窗口)
        if (!side && mom12 > 25) {
            side = "short";
            reason = `📉 Mom12=${mom12.toFixed(1)}>25 做空(88%) RSI=${rsi.toFixed(0)}`;
        }

        // 86% — RSI<25 + 15窗口 做多
        if (!side && rsi < 25 && wn.includes("15")) {
            side = "long";
            reason = `📈 RSI=${rsi.toFixed(0)}<25+15窗口 做多(86%)`;
        }

        // 83% — Mom12>20 + 22窗口 做空
        if (!side && mom12 > 20 && wn.includes("22")) {
            side = "short";
            reason = `📉 Mom12=${mom12.toFixed(1)}>20+22窗口 做空(83%)`;
        }

        // 71% — RSI<35 + 08窗口 做多
        if (!side && rsi < 35 && wn.includes("08")) {
            side = "long";
            reason = `📈 RSI=${rsi.toFixed(0)}<35+08窗口 做多(71%)`;
        }

        // 67% — Mom12<-15 + 08窗口 做多
        if (!side && mom12 < -15 && wn.includes("08")) {
            side = "long";
            reason = `📈 Mom12=${mom12.toFixed(1)}<-15+08窗口 做多(67%)`;
        }

        // 63% — Mom4<-8 做多 (任何窗口)
        if (!side && mom4 < -8) {
            side = "long";
            reason = `📈 Mom4=${mom4.toFixed(1)}<-8 做多(63%)`;
        }

        // 60% — Mom4>8 做空 (任何窗口)
        if (!side && mom4 > 8) {
            side = "short";
            reason = `📉 Mom4=${mom4.toFixed(1)}>8 做空(60%)`;
        }

        if (!side) return null;

        // ═══ 生成信号 ═══
        const qty = (MARGIN_PER_TRADE * LEVERAGE) / price;
        const fullReason = `${reason} | ${wn} ATR=${atr.toFixed(1)}`;

        const signal: Mom12Signal = {
            side, price, qty,
            reason: fullReason,
            targetSymbol: ETH_SYMBOL,
            windowName: wn,
            momentum: mom12,
            volRatio: mom4,
        };

        this.lastWindowSignal = activeWindow.name;
        this._pendingSignal = signal;
        this._ceoApproved = false;
        log(`📡 ${fullReason}`);
        return signal;
    }
}

export { Mom12Strategy as CausalStrategy };
export { Mom12Strategy as WindowStrategy };
