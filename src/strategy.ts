/**
 * 🧠 V92 六重共振 + 动态风控策略
 * ═════════════════════════════════════════════════════
 * 六重过滤 + V92新增:
 *   1. POC方向(实时WS Volume Profile)
 *   2. RSI(30<RSI<70 + 做多<60 做空>40)
 *   3. 成交量(不缩量>=0.6x)
 *   4. ATR(>=8pt,有波动)
 *   5. K棒结构(无反转形态)
 *   6. 追顶/疲劳(POC>50不追+连涨>150不追)
 *   7. Funding Rate(>0.05%不追多) [NEW]
 *   8. 日振>80% 非22窗强制反转 [NEW]
 *
 * 出场: 动态SL(1.0×15mATR,15-20pt) + TP(1:1.5RR)
 * 仓位: 每单风险≤账户1%
 */

import {
    TRADE_WINDOWS, ETH_SYMBOL, COOLDOWN_MS, BINANCE_BASE,
    ATR_BAN_THRESHOLD, LEVERAGE,
    ATR_MIN, RSI_FLOOR, RSI_CEILING,
    FUNDING_LONG_MAX, BINANCE_FAPI,
    DAY_RANGE_REVERSAL_PCT,
    SL_ATR_MULT, SL_MIN_PT, SL_MAX_PT,
    TP_RR_RATIO, RISK_PCT, POS_SIZE_LEVERAGE,
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
    windowEndTs: number;
    // V92 动态风控
    slPt: number;       // 动态SL (ATR计算)
    tpPt: number;       // 动态TP (SL×1.5)
    dynamicQty: number; // 1%风险仓位
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

    // V92 Funding Rate 缓存
    private fundingRate = 0;
    private fundingTs = 0;

    // V92 15m ATR 缓存 (动态SL用)
    private klines15m: K5m[] = [];
    private lastFetch15mTs = 0;

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
                log(`📊 V92 | $${k.c.toFixed(2)} | RSI=${rsi.toFixed(0)} | POC${poc >= 0 ? "+" : ""}${poc.toFixed(0)} | ATR=${this.atr14().toFixed(1)} | FR=${(this.fundingRate * 100).toFixed(3)}%`);
            }
        } catch (e) {
            log(`⚠️ K线拉取失败: ${e}`);
        }

        // V92: 拉取 15m K线 (动态SL用)
        await this.refresh15mKlines();
        // V92: 拉取 Funding Rate
        await this.refreshFundingRate();
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

    /** POC方向: 用 WS 实时成交 Volume Profile (由 bitunix-ws.ts 计算)
     *  回退: 如果 WS POC 还没数据, 用 K线近似版 */
    private pocSlope(wsPocSlope?: number): number {
        // 优先用 WS 实时 Volume Profile POC
        if (wsPocSlope !== undefined && wsPocSlope !== 0) return wsPocSlope;

        // 回退: K线近似版 (启动头4小时 WS 还没攒够数据时用)
        const n = this.klines.length;
        if (n < 96) return 0;

        let maxV1 = 0, poc1 = 0;
        for (let i = n - 48; i < n; i++) {
            if (this.klines[i].v > maxV1) {
                maxV1 = this.klines[i].v;
                const k = this.klines[i];
                poc1 = (k.h + k.l + k.c) / 3;
            }
        }

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

    // ═══ V92 新增方法 ═══

    /** V92: 拉取 15m K线 (动态SL用 ATR14×15m) */
    private async refresh15mKlines() {
        const now = Date.now();
        if (now - this.lastFetch15mTs < 890_000) return; // ~15min
        this.lastFetch15mTs = now;
        try {
            const start = now - 30 * 15 * 60_000; // 30根 (7.5h)
            const url = `${BINANCE_BASE}/api/v3/klines?symbol=ETHUSDT&interval=15m&startTime=${start}&endTime=${now}&limit=30`;
            const res = await fetch(url);
            if (!res.ok) return;
            const data = (await res.json()) as any[][];
            this.klines15m = data.map(k => ({
                ts: k[0] as number, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
            }));
        } catch (e) {
            log(`⚠️ 15m K线拉取失败: ${e}`);
        }
    }

    /** V92: 15m ATR(14) → 动态SL */
    private atr15m(): number {
        const n = this.klines15m.length;
        if (n < 16) return 15; // 回退: 还没数据就用默认15pt
        let s = 0;
        for (let i = n - 15; i < n - 1; i++) s += this.klines15m[i].h - this.klines15m[i].l;
        return s / 14;
    }

    /** V92: 拉取 Funding Rate (Binance FAPI) */
    private async refreshFundingRate() {
        const now = Date.now();
        if (now - this.fundingTs < 300_000) return; // 5min一次
        this.fundingTs = now;
        try {
            const url = `${BINANCE_FAPI}/fapi/v1/premiumIndex?symbol=ETHUSDT`;
            const res = await fetch(url);
            if (!res.ok) return;
            const data = (await res.json()) as any;
            this.fundingRate = +(data.lastFundingRate || 0);
        } catch (e) {
            log(`⚠️ Funding Rate 拉取失败: ${e}`);
        }
    }

    /** V92: 当日已用振幅占ATR比例 (>0.8 = 超过80%) */
    private getDayRangePct(): number {
        const n = this.klines.length;
        if (n < 48) return 0; // 不够一天数据

        // 找今天 UTC+8 0:00 开始的K线
        const now = Date.now();
        const todayStart = new Date(now + 8 * 3600000);
        todayStart.setUTCHours(-8, 0, 0, 0); // UTC+8的0:00
        const startTs = todayStart.getTime();

        let hi = -Infinity, lo = Infinity;
        for (const k of this.klines) {
            if (k.ts < startTs) continue;
            hi = Math.max(hi, k.h);
            lo = Math.min(lo, k.l);
        }
        if (hi <= lo) return 0;

        // 用ATR14估算"典型日振幅" → 已用%
        const atr = this.atr14();
        if (atr <= 0) return 0;
        // 日振幅 ≈ ATR×12 (5m K线 * 12 = 1h, * 24h = ATR日估计)
        const typicalDayRange = atr * 12;
        return (hi - lo) / typicalDayRange;
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

    /** V92 六重+共振入场 (wsPocSlope: WS实时POC位移, 由main传入; balance: 账户余额) */
    evaluate(wsPocSlope?: number, balance?: number): Mom12Signal | null {
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

        // ═══ 指标计算 ═══
        const price = this.klines[this.klines.length - 2].c;
        const rsi = this.rsi14();
        const atr = this.atr14();
        const volR = this.curVol() / this.avgVol();
        const pocSl = this.pocSlope(wsPocSlope);
        const recentChg = this.recentChange();
        const wn = activeWindow.name;

        const filters: string[] = [];

        // ═══ 1. POC方向 ═══
        let dir: "long" | "short" | "" = "";
        if (pocSl > 5) dir = "long";
        else if (pocSl < -5) dir = "short";
        else { this.logSkip(wn, "POC不明"); return null; }

        // ═══ 2. RSI (V92: 30-70范围 + 方向过滤) ═══
        if (rsi < RSI_FLOOR || rsi > RSI_CEILING) {
            filters.push(`RSI=${rsi.toFixed(0)}超极端`);
        } else {
            const rsiOk = (dir === "long" && rsi < 60) || (dir === "short" && rsi > 40);
            if (!rsiOk) filters.push(`RSI=${rsi.toFixed(0)}`);
        }

        // ═══ 3. 量 ═══
        const volOk = volR >= 0.6;
        if (!volOk) filters.push(`量${volR.toFixed(1)}x`);

        // ═══ 4. ATR (V92: >=8pt) ═══
        const atrOk = atr >= ATR_MIN;
        if (!atrOk) filters.push(`ATR=${atr.toFixed(1)}<${ATR_MIN}`);

        // ═══ 5. K棒 ═══
        const barOk = this.barStructureOk(dir);
        if (!barOk) filters.push("K棒反转");

        // ═══ 6. 追顶/疲劳 ═══
        if (dir === "long" && pocSl > 50) filters.push(`POC+${pocSl.toFixed(0)}追顶`);
        if (dir === "short" && pocSl < -50) filters.push(`POC${pocSl.toFixed(0)}追底`);
        if (dir === "long" && recentChg > 150 && rsi > 55) filters.push("连涨疲劳");
        if (dir === "short" && recentChg < -150 && rsi < 45) filters.push("连跌疲劳");

        // ═══ 7. V92 Funding Rate ═══
        if (dir === "long" && this.fundingRate > FUNDING_LONG_MAX) {
            filters.push(`FR=${(this.fundingRate * 100).toFixed(3)}%贵`);
        }

        // ═══ 8. V92 日振>80% 反转模式 ═══
        const dayRange = this.getDayRangePct();
        if (dayRange > DAY_RANGE_REVERSAL_PCT && wn !== "22窗口") {
            // 日振已超>80%, 非22窗 → 强制反转方向
            const origDir = dir;
            dir = dir === "long" ? "short" : "long";
            log(`🔄 日振${(dayRange * 100).toFixed(0)}%>反转! ${origDir}→${dir}`);
        }

        // ═══ 全绿检查 ═══
        if (filters.length > 0) {
            this.logSkip(wn, `${dir.toUpperCase()} [${filters.join(",")}]`);
            return null;
        }

        // ═══ V92 动态SL/TP/仓位 ═══
        const atr15m = this.atr15m();
        const slPt = Math.max(SL_MIN_PT, Math.min(SL_MAX_PT, SL_ATR_MULT * atr15m));
        const tpPt = slPt * TP_RR_RATIO;

        // 动态仓位: qty = (balance × 1%) / (SL_pt × price / leverage)
        const bal = balance || 5000;
        const riskU = bal * RISK_PCT;           // 最多亏 $50 (5000×1%)
        const dynamicQty = riskU / (slPt * (price / POS_SIZE_LEVERAGE));
        // clamp: 最小0.01 ETH, 最大5 ETH
        const qty = Math.max(0.01, Math.min(5.0, Math.floor(dynamicQty * 100) / 100));

        const reason = `📡 ${wn} ${dir === "long" ? "📈做多" : "📉做空"} 全绿 | POC${pocSl >= 0 ? "+" : ""}${pocSl.toFixed(0)} RSI=${rsi.toFixed(0)} ATR=${atr.toFixed(1)} V=${volR.toFixed(1)}x | SL=${slPt.toFixed(1)} TP=${tpPt.toFixed(1)} Q=${qty.toFixed(2)}ETH`;

        const signal: Mom12Signal = {
            side: dir, price, qty, reason,
            targetSymbol: ETH_SYMBOL,
            windowName: wn,
            momentum: pocSl,
            volRatio: volR,
            windowEndTs,
            slPt, tpPt, dynamicQty: qty,
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
