/**
 * 🧠 V91 Mom12 冠军策略
 * ═══════════════════════════════════════════════════════
 * 回测验证: $200→$939 (+$739) | 15笔 | 43%胜率 | 4.4:1盈亏比
 *
 * 入场 (仅在 CEO 三窗口内):
 *   做空: 12根5m K线涨超40pt + 放量×2 + 上影线长/实体小
 *   做多: 12根5m K线跌超40pt + 放量×2 + 下影线长/实体小
 *   保护: ATR<55
 *
 * 出场: executor.ts (SL=8 → 保本5+1 → 跟踪15)
 * CEO 确认后开 5ETH, 不回自动开 3ETH
 */

import {
    TRADE_WINDOWS, ETH_SYMBOL, COOLDOWN_MS, BINANCE_BASE,
    MOM12_THRESHOLD, VOL_MULTIPLIER, BAR_UPPER_SHADOW_MIN,
    BAR_BODY_MAX, ATR_BAN_THRESHOLD, MARGIN_PER_TRADE,
    LEVERAGE,
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

// 向后兼容
export type CausalSignal = Mom12Signal;
export type WindowSignal = Mom12Signal;

// ═══ 5m K线缓存 (从 Binance 拉取) ═══
interface K5m {
    ts: number; o: number; h: number; l: number; c: number; v: number;
}

export class Mom12Strategy {
    private lastTradeTs = 0;
    private scanCount = 0;
    private _pendingSignal: Mom12Signal | null = null;
    private _ceoApproved = false;
    private lastWindowSignal = "";

    // 5m K线数据
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

    /** 拉取最新 5m K线 (每5分钟一次) */
    async refreshKlines() {
        const now = Date.now();
        if (now - this.lastFetchTs < 290_000) return; // 4m50s
        this.lastFetchTs = now;

        try {
            const end = now;
            const start = end - 250 * 5 * 60_000; // 250根
            const url = `${BINANCE_BASE}/api/v3/klines?symbol=ETHUSDT&interval=5m&startTime=${start}&endTime=${end}&limit=250`;
            const res = await fetch(url);
            if (!res.ok) return;
            const data = (await res.json()) as any[][];

            this.klines = data.map(k => ({
                ts: k[0] as number, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
            }));

            // 更新 EMA200
            if (this.klines.length >= 200) {
                if (!this.ema200Ready) {
                    this.ema200 = this.klines.slice(-200).reduce((s, k) => s + k.c, 0) / 200;
                    this.ema200Ready = true;
                } else {
                    const last = this.klines[this.klines.length - 1];
                    const m = 2 / 201;
                    this.ema200 = last.c * m + this.ema200 * (1 - m);
                }
            }

            if (this.scanCount % 12 === 0) {
                const last = this.klines[this.klines.length - 1];
                log(`📊 K5m: ${this.klines.length}根 | $${last.c.toFixed(2)} | EMA200=$${this.ema200.toFixed(2)} | ATR=${this.atr14().toFixed(1)}`);
            }
        } catch (e) {
            log(`⚠️ K线拉取失败: ${e}`);
        }
    }

    // ═══ 指标 ═══
    private mom12(): number {
        const n = this.klines.length;
        return n >= 13 ? this.klines[n - 1].c - this.klines[n - 13].c : 0;
    }

    private atr14(): number {
        const n = this.klines.length; if (n < 14) return 0;
        let s = 0; for (let i = n - 14; i < n; i++) s += this.klines[i].h - this.klines[i].l;
        return s / 14;
    }

    private avgVol(): number {
        const n = this.klines.length; if (n < 20) return 1;
        let s = 0; for (let i = n - 20; i < n; i++) s += this.klines[i].v;
        return s / 20;
    }

    private curVol(): number {
        return this.klines.length > 0 ? this.klines[this.klines.length - 1].v : 0;
    }

    /** K棒形态 (不看红绿!) */
    private barShape(): { bodyR: number; upperR: number; lowerR: number } {
        const n = this.klines.length;
        if (n < 2) return { bodyR: 1, upperR: 0, lowerR: 0 };
        const k = this.klines[n - 1];
        const range = k.h - k.l;
        if (range <= 0) return { bodyR: 0, upperR: 0, lowerR: 0 };
        const prevClose = this.klines[n - 2].c;
        const bodyTop = Math.max(prevClose, k.c), bodyBot = Math.min(prevClose, k.c);
        return {
            bodyR: (bodyTop - bodyBot) / range,
            upperR: (k.h - bodyTop) / range,
            lowerR: (bodyBot - k.l) / range,
        };
    }

    /** 评估 Mom12 信号 */
    evaluate(): Mom12Signal | null {
        this.scanCount++;
        const now = Date.now();
        if (now - this.lastTradeTs < COOLDOWN_MS) return null;
        if (this._pendingSignal) return null;
        if (this.klines.length < 20 || !this.ema200Ready) return null;

        // ═══ Step 1: 时间窗口 (UTC+8) ═══
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

        // ═══ Step 2: V50 保护 ═══
        const atr = this.atr14();
        if (atr > ATR_BAN_THRESHOLD) {
            log(`🛡️ ATR=${atr.toFixed(1)} > ${ATR_BAN_THRESHOLD} 禁入`);
            return null;
        }

        // ═══ Step 3: Mom12 动量 ═══
        const mom = this.mom12();

        // ═══ Step 4: 成交量确认 ═══
        const volRatio = this.curVol() / this.avgVol();
        if (volRatio < VOL_MULTIPLIER) return null;

        // ═══ Step 5: K棒形态确认 ═══
        const bar = this.barShape();

        let side: "long" | "short" | "" = "";
        const price = this.klines[this.klines.length - 1].c;

        // 做空: 涨太多 + 上影线 或 实体小
        if (mom > MOM12_THRESHOLD) {
            if (bar.upperR > BAR_UPPER_SHADOW_MIN || bar.bodyR < BAR_BODY_MAX) {
                side = "short";
            }
        }

        // 做多: 跌太多 + 下影线 或 实体小
        if (!side && mom < -MOM12_THRESHOLD) {
            if (bar.lowerR > BAR_UPPER_SHADOW_MIN || bar.bodyR < BAR_BODY_MAX) {
                side = "long";
            }
        }

        if (!side) return null;

        // ═══ 生成信号 ═══
        const qty = (MARGIN_PER_TRADE * LEVERAGE) / price;
        const reason = side === "short"
            ? `📉 ${activeWindow.name} Mom12=${mom.toFixed(1)}pt 做空 | 量=${volRatio.toFixed(1)}x | 上影=${(bar.upperR * 100).toFixed(0)}% 实体=${(bar.bodyR * 100).toFixed(0)}%`
            : `📈 ${activeWindow.name} Mom12=${mom.toFixed(1)}pt 做多 | 量=${volRatio.toFixed(1)}x | 下影=${(bar.lowerR * 100).toFixed(0)}% 实体=${(bar.bodyR * 100).toFixed(0)}%`;

        const signal: Mom12Signal = {
            side, price, qty, reason,
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

// 向后兼容
export { Mom12Strategy as CausalStrategy };
export { Mom12Strategy as WindowStrategy };
