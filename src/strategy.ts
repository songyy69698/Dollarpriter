/**
 * 🔥 V96 Fire Candle 策略引擎
 * ═════════════════════════════════════════════════
 * 回测: $500→$1300 (+160%) 43笔 58%胜 PF 2.30
 *
 * 每日 UTC 12:00 用 1h K线合成 UTC 08-12 的 4H K线
 * 判定方向 → UTC 12-20 等诱导回踩 → 5m确认入场
 *
 * ① UTC 08-12 强阳=做多 / 强阴=做空 / 十字星=跳过
 * ② 等价格跌破 Close (做多) 或涨过 Close (做空)
 * ③ 5m 阳线收回 Close 上方 (做多) = 入场
 * ④ SL = 4H Low (做多) / High (做空)
 * ⑤ TP = 5R (回测最优)
 */

import {
    ETH_SYMBOL, COOLDOWN_MS, BINANCE_BASE,
    FIXED_QTY, SL_MIN_PT, TP_RR_RATIO, RISK_PCT, MAX_DAILY_TRADES,
    INITIAL_SL_PT, TARGET_BALANCE,
    FIRE_CANDLE_START_UTC, FIRE_CANDLE_END_UTC,
    TRADE_START_UTC, TRADE_END_UTC,
    FIRE_MIN_BODY_RATIO,
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
    slPt: number;
    tpPt: number;
    dynamicQty: number;
}

export type CausalSignal = Mom12Signal;
export type WindowSignal = Mom12Signal;

interface K1h {
    ts: number; o: number; h: number; l: number; c: number; v: number;
}

interface FireCandle {
    date: string;
    h: number; l: number; o: number; c: number;
    body: number; range: number; bodyRatio: number;
    dir: "long" | "short" | "skip";
}

export class Mom12Strategy {
    private lastTradeTs = 0;
    private scanCount = 0;
    private _pendingSignal: Mom12Signal | null = null;
    private _ceoApproved = false;
    private todayFire: FireCandle | null = null;
    private todayDate = "";
    private manipulated = false;
    private todayTradeCount = 0;

    // 1h K线缓存
    private klines1h: K1h[] = [];
    private lastFetch1hTs = 0;

    // 5m K线 (兼容旧代码)
    private klines: K1h[] = [];
    private lastFetchTs = 0;

    // Funding Rate 缓存 (兼容)
    private fundingRate = 0;

    getScanCount() { return this.scanCount; }
    get pendingSignal() { return this._pendingSignal; }
    get ceoApproved() { return this._ceoApproved; }

    approveTrade() { this._ceoApproved = true; log("✅ CEO 确认开单!"); }
    clearPending() { this._pendingSignal = null; this._ceoApproved = false; }
    markTraded() { this.lastTradeTs = Date.now(); this.todayTradeCount++; this.manipulated = false; this.clearPending(); log(`📋 今日已开单 ${this.todayTradeCount}/${MAX_DAILY_TRADES}`); }

    /** 📊 获取当前策略指标快照 */
    getIndicatorSnapshot() {
        return {
            atr: this.atr14(),
            ema3: 0, ema7: 0, ema20: 0,
            fundingRate: this.fundingRate,
            volRatio: 0,
            pocSlope: 0,
        };
    }

    /** 拉取 1h 和 5m K线 */
    async refreshKlines() {
        const now = Date.now();

        // 每 60 秒刷新 1h K线
        if (now - this.lastFetch1hTs > 60_000) {
            this.lastFetch1hTs = now;
            try {
                const start = now - 48 * 3600000; // 48h
                const url = `${BINANCE_BASE}/api/v3/klines?symbol=ETHUSDT&interval=1h&startTime=${start}&endTime=${now}&limit=48`;
                const res = await fetch(url);
                if (res.ok) {
                    const data = (await res.json()) as any[][];
                    this.klines1h = data.map(k => ({
                        ts: k[0] as number, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
                    }));
                }
            } catch (e) {
                log(`⚠️ 1h K线拉取失败: ${e}`);
            }
        }

        // 兼容: 也拉5m
        if (now - this.lastFetchTs > 290_000) {
            this.lastFetchTs = now;
            try {
                const start = now - 100 * 5 * 60_000;
                const url = `${BINANCE_BASE}/api/v3/klines?symbol=ETHUSDT&interval=5m&startTime=${start}&endTime=${now}&limit=100`;
                const res = await fetch(url);
                if (res.ok) {
                    const data = (await res.json()) as any[][];
                    this.klines = data.map(k => ({
                        ts: k[0] as number, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
                    }));
                }
            } catch {}
        }
    }

    // ═══ 指标 ═══
    private atr14(): number {
        const n = this.klines.length; if (n < 16) return 0;
        let s = 0; for (let i = n - 15; i < n - 1; i++) s += this.klines[i].h - this.klines[i].l;
        return s / 14;
    }

    // ═══════════════════════════════════════════════
    // 🔥 Fire Candle 核心逻辑
    // ═══════════════════════════════════════════════

    /** 从 1h K线合成 Fire Candle (UTC 08-12) */
    private synthesizeFireCandle(): FireCandle | null {
        const today = new Date().toISOString().slice(0, 10);
        const fireHours: number[] = [];
        for (let h = FIRE_CANDLE_START_UTC; h < FIRE_CANDLE_END_UTC; h++) fireHours.push(h);

        const fireBars = this.klines1h.filter(k => {
            const d = new Date(k.ts);
            return d.toISOString().slice(0, 10) === today && fireHours.includes(d.getUTCHours());
        });

        if (fireBars.length < 3) return null;  // 至少3根1h

        const o = fireBars[0].o;
        const c = fireBars[fireBars.length - 1].c;
        const h = Math.max(...fireBars.map(k => k.h));
        const l = Math.min(...fireBars.map(k => k.l));
        const body = Math.abs(c - o), range = h - l;
        if (range < 5) return null;  // 太小不做

        const bodyRatio = body / range;
        let dir: "long" | "short" | "skip" = "skip";
        if (bodyRatio >= FIRE_MIN_BODY_RATIO) {
            dir = c > o ? "long" : "short";
        }

        return { date: today, h, l, o, c, body, range, bodyRatio, dir };
    }

    evaluate(
        wsPocSlope?: number,
        balance?: number,
        bigDelta?: number,
        bigCVD?: number,
        bigRatio?: number,
    ): Mom12Signal | null {
        this.scanCount++;
        const now = Date.now();
        if (now - this.lastTradeTs < COOLDOWN_MS) return null;
        if (this._pendingSignal) return null;
        if (this.klines1h.length < 10) return null;

        const utcH = new Date().getUTCHours();
        const today = new Date().toISOString().slice(0, 10);

        // 每日重置
        if (today !== this.todayDate) {
            this.todayDate = today;
            this.todayFire = null;
            this.manipulated = false;
            this.todayTradeCount = 0;
            log(`📅 新日: ${today}`);
        }

        // 今天已达上限 → 跳过
        if (this.todayTradeCount >= MAX_DAILY_TRADES) return null;

        // ═══ Step 1: UTC 12+ 合成 Fire Candle ═══
        if (!this.todayFire && utcH >= FIRE_CANDLE_END_UTC) {
            this.todayFire = this.synthesizeFireCandle();
            if (this.todayFire) {
                const f = this.todayFire;
                const icon = f.dir === "long" ? "🟢做多" : f.dir === "short" ? "🔴做空" : "⚪跳过";
                log(`🔥 Fire Candle 判定: ${icon} | O=$${f.o.toFixed(1)} C=$${f.c.toFixed(1)} H=$${f.h.toFixed(1)} L=$${f.l.toFixed(1)} | 实体${(f.bodyRatio * 100).toFixed(0)}%`);
            } else {
                log(`⏳ Fire Candle 数据不足`);
            }
        }

        if (!this.todayFire || this.todayFire.dir === "skip") return null;

        // 不在交易窗口内 → 跳过
        if (utcH < TRADE_START_UTC || utcH > TRADE_END_UTC) return null;

        const f = this.todayFire;

        // ═══ Step 2: 等诱导回踩 (Manipulation) ═══
        // 用最新的5m K线检查
        if (this.klines.length < 3) return null;
        const latestBar = this.klines[this.klines.length - 1];
        const prevBar = this.klines[this.klines.length - 2];

        if (!this.manipulated) {
            if (f.dir === "long" && latestBar.l < f.c) {
                this.manipulated = true;
                log(`📉 诱导回踩! 价格 $${latestBar.l.toFixed(1)} 跌破 Close $${f.c.toFixed(1)}`);
            }
            if (f.dir === "short" && latestBar.h > f.c) {
                this.manipulated = true;
                log(`📈 诱导回踩! 价格 $${latestBar.h.toFixed(1)} 涨过 Close $${f.c.toFixed(1)}`);
            }
            return null;
        }

        // ═══ Step 3: 5m 确认入场 ═══
        let entry = false;
        if (f.dir === "long") {
            // 阳线收回 Close 上方
            if (latestBar.c > f.c && latestBar.c > latestBar.o && prevBar.c < f.c) {
                entry = true;
            }
        } else {
            // 阴线收回 Close 下方
            if (latestBar.c < f.c && latestBar.c < latestBar.o && prevBar.c > f.c) {
                entry = true;
            }
        }

        if (!entry) return null;

        // ═══ Step 4: 固定20pt SL + 5R TP ═══
        const price = latestBar.c;
        const slPt = INITIAL_SL_PT;  // 固定20pt

        const tpPt = slPt * TP_RR_RATIO;  // 5R = 100pt

        // 🎯 达标检测
        const bal = balance || 150;
        if (bal >= TARGET_BALANCE) {
            log(`🏆 已达标 $${bal.toFixed(0)} ≥ $${TARGET_BALANCE} → 停止交易!`);
            return null;
        }

        // 💰 固定仓位
        const qty = FIXED_QTY;  // 固定2 ETH
        const maxLoss = qty * slPt;
        log(`💰 固定仓位: ${qty} ETH | SL=${slPt}pt | TP=${tpPt}pt | 最大亏损=$${maxLoss.toFixed(0)} | 余额=$${bal.toFixed(0)}`);

        // 窗口结束 = UTC 20:00
        const endTs = new Date();
        endTs.setUTCHours(TRADE_END_UTC, 0, 0, 0);
        if (endTs.getTime() < now) endTs.setDate(endTs.getDate() + 1);

        const bigTag = bigDelta !== undefined && bigDelta !== 0 ? ` bigΔ=${bigDelta.toFixed(1)}` : "";
        const reason =
            `🔥 Fire Candle ${f.dir === "long" ? "📈做多" : "📉做空"} | ` +
            `4H: O$${f.o.toFixed(0)} C$${f.c.toFixed(0)} 实体${(f.bodyRatio * 100).toFixed(0)}% | ` +
            `SL=${slPt.toFixed(0)}pt TP=${tpPt.toFixed(0)}pt (${TP_RR_RATIO}R)${bigTag}`;

        const signal: Mom12Signal = {
            side: f.dir as "long" | "short",
            price,
            qty,
            reason,
            targetSymbol: ETH_SYMBOL,
            windowName: "Fire窗口",
            momentum: 0,
            volRatio: 0,
            windowEndTs: endTs.getTime(),
            slPt,
            tpPt,
            dynamicQty: qty,
        };

        this._pendingSignal = signal;
        this._ceoApproved = false;
        log(reason);
        return signal;
    }

    private logSkip(label: string, reason: string) {
        log(`⏭️ ${label} 跳过 ${reason}`);
    }
}

export { Mom12Strategy as CausalStrategy };
export { Mom12Strategy as WindowStrategy };
