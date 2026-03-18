/**
 * 🧠 V93 六重共振策略
 * ═══════════════════════════════════════════════════════
 * 规格书: docs/conversations/06_日内交易系统规格书.md
 *
 * 六重过滤 (全绿才进场):
 *   1. POC方向(前4h成交量最集中价走向)
 *   2. RSI位置(做多<60 / 做空>40)
 *   3. 成交量(不缩量>=0.6x)
 *   4. ATR(>3,有波动)
 *   5. K棒结构(无反转形态)
 *   6. 追顶/疲劳(POC>50不追+连涨>150不追)
 *
 * 进场: 回调进(窗口前20min找回调点)
 * 出场: 窗口收盘平仓 + 硬SL=8保护
 *
 * 回测: 20天14笔79%胜+$591 | 本周4笔100%胜+$158
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
    windowEndTs: number; // 窗口结束时间戳 → executor用来定时平仓
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

    // 记忆: 过去2天涨跌
    private dayChanges: { date: string; change: number }[] = [];

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
            const start = end - 300 * 5 * 60_000; // 300根(25小时)
            const url = `${BINANCE_BASE}/api/v3/klines?symbol=ETHUSDT&interval=5m&startTime=${start}&endTime=${end}&limit=300`;
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

            // 更新日变化记忆
            this.updateDayChanges();

            if (this.scanCount % 12 === 0) {
                const k = this.klines[this.klines.length - 2];
                const rsi = this.rsi14();
                const poc = this.pocSlope();
                log(`📊 V93 | $${k.c.toFixed(2)} | RSI=${rsi.toFixed(0)} | POC${poc >= 0 ? "+" : ""}${poc.toFixed(0)} | ATR=${this.atr14().toFixed(1)}`);
            }
        } catch (e) {
            log(`⚠️ K线拉取失败: ${e}`);
        }
    }

    // ═══ 指标 (全部用倒数第二根已完成K线) ═══

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

    /** POC方向: 前4小时vs前8-4小时的成交量最集中价差异 */
    private pocSlope(): number {
        const n = this.klines.length;
        if (n < 96) return 0; // 需要8小时数据(96根5m)

        // 最近4小时(48根)POC
        let maxV1 = 0, poc1 = 0;
        for (let i = n - 48; i < n; i++) {
            if (this.klines[i].v > maxV1) {
                maxV1 = this.klines[i].v;
                const k = this.klines[i];
                poc1 = (k.h + k.l + k.c) / 3;
            }
        }

        // 前4-8小时(48根)POC
        let maxV2 = 0, poc2 = 0;
        for (let i = n - 96; i < n - 48; i++) {
            if (this.klines[i].v > maxV2) {
                maxV2 = this.klines[i].v;
                const k = this.klines[i];
                poc2 = (k.h + k.l + k.c) / 3;
            }
        }

        return poc1 - poc2;
    }

    /** K棒结构检查: 最近3根是否有反转形态 */
    private barStructureOk(dir: "long" | "short"): boolean {
        const n = this.klines.length;
        if (n < 5) return true;

        let reverseCount = 0;
        for (let j = n - 4; j < n - 1; j++) {
            const k = this.klines[j];
            const range = k.h - k.l;
            if (range <= 0) continue;
            const bodyTop = Math.max(k.c, k.o);
            const bodyBot = Math.min(k.c, k.o);
            const upperR = (k.h - bodyTop) / range;
            const lowerR = (bodyBot - k.l) / range;

            if (dir === "long" && upperR > 0.4) reverseCount++;
            if (dir === "short" && lowerR > 0.4) reverseCount++;
        }
        return reverseCount < 2;
    }

    /** 更新过去几天的涨跌记忆 */
    private updateDayChanges() {
        const days: Record<string, { open: number; close: number }> = {};
        for (const k of this.klines) {
            const d = new Date(k.ts + 8 * 3600000).toISOString().slice(0, 10);
            if (!days[d]) days[d] = { open: k.o, close: k.c };
            days[d].close = k.c;
        }
        this.dayChanges = Object.entries(days)
            .map(([date, { open, close }]) => ({ date, change: close - open }))
            .sort((a, b) => a.date.localeCompare(b.date));
    }

    /** 过去2天累计涨跌 */
    private recentChange(): number {
        if (this.dayChanges.length < 2) return 0;
        const last2 = this.dayChanges.slice(-3, -1); // 不含今天
        return last2.reduce((s, d) => s + d.change, 0);
    }

    /** V93 六重共振入场 */
    evaluate(): Mom12Signal | null {
        this.scanCount++;
        const now = Date.now();
        if (now - this.lastTradeTs < COOLDOWN_MS) return null;
        if (this._pendingSignal) return null;
        if (this.klines.length < 100 || !this.ema200Ready) return null;

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

        // 窗口结束时间戳
        const windowEndTs = (() => {
            const d = new Date();
            d.setUTCHours(activeWindow!.endHour - 8, activeWindow!.endMin || 0, 0, 0);
            if (d.getTime() < now) d.setDate(d.getDate() + 1);
            return d.getTime();
        })();

        // ═══ 六重过滤 ═══
        const price = this.klines[this.klines.length - 2].c;
        const rsi = this.rsi14();
        const atr = this.atr14();
        const volR = this.curVol() / this.avgVol();
        const pocSl = this.pocSlope();
        const recentChg = this.recentChange();
        const wn = activeWindow.name;

        const filters: string[] = [];

        // 1. POC方向
        let dir: "long" | "short" | "" = "";
        if (pocSl > 5) dir = "long";
        else if (pocSl < -5) dir = "short";
        else { this.logSkip(wn, "POC不明"); return null; }

        // 2. RSI
        const rsiOk = (dir === "long" && rsi < 60) || (dir === "short" && rsi > 40);
        if (!rsiOk) filters.push(`RSI=${rsi.toFixed(0)}`);

        // 3. 量
        const volOk = volR >= 0.6;
        if (!volOk) filters.push(`量${volR.toFixed(1)}x`);

        // 4. ATR
        const atrOk = atr >= 3;
        if (!atrOk) filters.push(`ATR=${atr.toFixed(1)}`);

        // 5. K棒
        const barOk = this.barStructureOk(dir);
        if (!barOk) filters.push("K棒反转");

        // 6. 追顶/疲劳
        let chaseOk = true;
        if (dir === "long" && pocSl > 50) { chaseOk = false; filters.push(`POC+${pocSl.toFixed(0)}追顶`); }
        if (dir === "short" && pocSl < -50) { chaseOk = false; filters.push(`POC${pocSl.toFixed(0)}追底`); }

        let fatigueOk = true;
        if (dir === "long" && recentChg > 150 && rsi > 55) { fatigueOk = false; filters.push("连涨疲劳"); }
        if (dir === "short" && recentChg < -150 && rsi < 45) { fatigueOk = false; filters.push("连跌疲劳"); }

        // ═══ 全绿检查 ═══
        if (filters.length > 0) {
            this.logSkip(wn, `${dir.toUpperCase()} [${filters.join(",")}]`);
            return null;
        }

        // ═══ 生成信号 ═══
        const qty = (MARGIN_PER_TRADE * LEVERAGE) / price;
        const reason = `📡 ${wn} ${dir === "long" ? "📈做多" : "📉做空"} 6绿全亮 | POC${pocSl >= 0 ? "+" : ""}${pocSl.toFixed(0)} RSI=${rsi.toFixed(0)} ATR=${atr.toFixed(1)} V=${volR.toFixed(1)}x`;

        const signal: Mom12Signal = {
            side: dir, price, qty, reason,
            targetSymbol: ETH_SYMBOL,
            windowName: wn,
            momentum: pocSl,
            volRatio: volR,
            windowEndTs,
        };

        this.lastWindowSignal = activeWindow.name;
        this._pendingSignal = signal;
        this._ceoApproved = false;
        log(reason);
        return signal;
    }

    private logSkip(wn: string, reason: string) {
        log(`⏭️ ${wn} 跳过 ${reason}`);
        // 标记已扫描过此窗口
        const dt = new Date();
        const utc8H = (dt.getUTCHours() + 8) % 24;
        for (const w of TRADE_WINDOWS) {
            if (w.name === wn) {
                this.lastWindowSignal = wn;
                break;
            }
        }
    }
}

export { Mom12Strategy as CausalStrategy };
export { Mom12Strategy as WindowStrategy };
