/**
 * 🔥 V104 混合止盈版策略引擎
 * ═════════════════════════════════════════════════
 * 15m看结构 + 5m找点(5条件) + 分批止盈
 *
 * ① UTC 08-12 合成Fire Candle (实体≥35% + 范围≥80pt)
 * ② 诱导回踩 (深度≥12pt + 量能1.3x)
 * ③ 15m结构确认 (EMA21>EMA55 + HH/HL)
 * ④ 5m 5条件入场 (回穿+强阳+前根反侧+量能+RSI)
 * ⑤ 动态SL (诱导低点-8pt, clamp[15,22]), 分批TP
 */

import {
    ETH_SYMBOL, COOLDOWN_MS, BINANCE_BASE,
    FIXED_QTY, TP_RR_RATIO, MAX_DAILY_TRADES,
    INITIAL_SL_PT, TARGET_BALANCE,
    FIRE_CANDLE_START_UTC, FIRE_CANDLE_END_UTC,
    TRADE_START_UTC, TRADE_END_UTC,
    FIRE_MIN_BODY_RATIO, FIRE_MIN_RANGE_PT,
    INDUCEMENT_MIN_DEPTH_PT, INDUCEMENT_VOL_MULT,
    ENTRY_VOL_MULT, ENTRY_BODY_RATIO, ENTRY_RSI_MIN, ENTRY_RSI_MAX,
    FUNDING_EXTREME,
    SL_INDUCEMENT_PAD, SL_ATR_FLOOR, SL_ATR_CEILING, SL_ATR_BASELINE,
    PARTIAL_TP_PT, FULL_TP_PT,
    RSI_PERIOD,
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
    private inducementLow = 0;   // V104: 诱导低点(做多)
    private inducementHigh = 0;  // V104: 诱导高点(做空)

    // 1h K线缓存
    private klines1h: K1h[] = [];
    private lastFetch1hTs = 0;

    // 15m K线缓存 (V104)
    private klines15m: K1h[] = [];
    private lastFetch15mTs = 0;

    // 5m K线
    private klines: K1h[] = [];
    private lastFetchTs = 0;

    // Funding Rate 缓存
    private fundingRate = 0;
    private lastFetchFundingTs = 0;

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

    /** 拉取 1h、15m 和 5m K线 + Funding Rate */
    async refreshKlines() {
        const now = Date.now();

        // 每 60 秒刷新 1h K线
        if (now - this.lastFetch1hTs > 60_000) {
            this.lastFetch1hTs = now;
            try {
                const start = now - 48 * 3600000;
                const url = `${BINANCE_BASE}/api/v3/klines?symbol=ETHUSDT&interval=1h&startTime=${start}&endTime=${now}&limit=48`;
                const res = await fetch(url);
                if (res.ok) {
                    const raw = await res.json() as any[];
                    this.klines1h = raw.map((k: any) => ({
                        ts: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
                    }));
                }
            } catch (e) { log(`❌ 1h K线异常: ${e}`); }
        }

        // 每 60 秒刷新 15m K线 (V104)
        if (now - this.lastFetch15mTs > 60_000) {
            this.lastFetch15mTs = now;
            try {
                const start = now - 12 * 3600000; // 12小时
                const url = `${BINANCE_BASE}/api/v3/klines?symbol=ETHUSDT&interval=15m&startTime=${start}&endTime=${now}&limit=48`;
                const res = await fetch(url);
                if (res.ok) {
                    const raw = await res.json() as any[];
                    this.klines15m = raw.map((k: any) => ({
                        ts: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
                    }));
                }
            } catch (e) { log(`❌ 15m K线异常: ${e}`); }
        }

        // 每 30 秒刷新 5m K线
        if (now - this.lastFetchTs > 30_000) {
            this.lastFetchTs = now;
            try {
                const start = now - 6 * 3600000;
                const url = `${BINANCE_BASE}/api/v3/klines?symbol=ETHUSDT&interval=5m&startTime=${start}&endTime=${now}&limit=72`;
                const res = await fetch(url);
                if (res.ok) {
                    const raw = await res.json() as any[];
                    this.klines = raw.map((k: any) => ({
                        ts: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
                    }));
                }
            } catch (e) { log(`❌ 5m K线异常: ${e}`); }
        }

        // 每 120 秒刷新 Funding Rate (V104)
        if (now - this.lastFetchFundingTs > 120_000) {
            this.lastFetchFundingTs = now;
            try {
                const url = `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=ETHUSDT`;
                const res = await fetch(url);
                if (res.ok) {
                    const data = await res.json() as any;
                    this.fundingRate = +(data.lastFundingRate || 0);
                }
            } catch (e) { /* 静默 */ }
        }
    }

    /** ATR(14) */
    private atr14(): number {
        const n = this.klines.length; if (n < 16) return 0;
        let s = 0; for (let i = n - 15; i < n - 1; i++) s += this.klines[i].h - this.klines[i].l;
        return s / 14;
    }

    /** RSI(14) on 5m (V104) */
    private rsi14(): number {
        const n = this.klines.length; if (n < RSI_PERIOD + 2) return 50;
        let gain = 0, loss = 0;
        for (let i = n - RSI_PERIOD - 1; i < n - 1; i++) {
            const diff = this.klines[i + 1].c - this.klines[i].c;
            if (diff > 0) gain += diff; else loss -= diff;
        }
        if (loss === 0) return 100;
        const rs = (gain / RSI_PERIOD) / (loss / RSI_PERIOD);
        return 100 - (100 / (1 + rs));
    }

    /** EMA simple helper */
    private ema(data: number[], period: number): number {
        if (data.length < period) return data[data.length - 1] || 0;
        const k = 2 / (period + 1);
        let e = data[0];
        for (let i = 1; i < data.length; i++) e = data[i] * k + e * (1 - k);
        return e;
    }

    /** V104: 15m结构确认 */
    private check15mStructure(dir: "long" | "short"): boolean {
        if (this.klines15m.length < 55) return true; // 数据不足放行

        const closes = this.klines15m.map(k => k.c);
        const ema21 = this.ema(closes, 21);
        const ema55 = this.ema(closes, 55);

        // 最近4根15m检查HH/HL结构
        const recent = this.klines15m.slice(-4);

        if (dir === "long") {
            const emaOk = ema21 > ema55;
            // Higher Low: 最近4根中最低的Low > 之前4根最低的Low
            const prev4 = this.klines15m.slice(-8, -4);
            const hlOk = prev4.length >= 4
                ? Math.min(...recent.map(k => k.l)) >= Math.min(...prev4.map(k => k.l)) * 0.998
                : true;

            if (!emaOk) {
                log(`⚠️ 15m做多结构失败: EMA21=${ema21.toFixed(1)} < EMA55=${ema55.toFixed(1)}`);
                return false;
            }
            log(`✅ 15m做多结构: EMA21=${ema21.toFixed(1)} > EMA55=${ema55.toFixed(1)} HL=${hlOk ? "✅" : "⚠️"}`);
            return true;
        } else {
            const emaOk = ema21 < ema55;
            const prev4 = this.klines15m.slice(-8, -4);
            const lhOk = prev4.length >= 4
                ? Math.max(...recent.map(k => k.h)) <= Math.max(...prev4.map(k => k.h)) * 1.002
                : true;

            if (!emaOk) {
                log(`⚠️ 15m做空结构失败: EMA21=${ema21.toFixed(1)} > EMA55=${ema55.toFixed(1)}`);
                return false;
            }
            log(`✅ 15m做空结构: EMA21=${ema21.toFixed(1)} < EMA55=${ema55.toFixed(1)} LH=${lhOk ? "✅" : "⚠️"}`);
            return true;
        }
    }

    /** 5m均量(最近12根) */
    private avgVol5m(): number {
        const n = this.klines.length; if (n < 13) return 0;
        let s = 0;
        for (let i = n - 13; i < n - 1; i++) s += this.klines[i].v;
        return s / 12;
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

        if (fireBars.length < 3) return null;

        const o = fireBars[0].o;
        const c = fireBars[fireBars.length - 1].c;
        const h = Math.max(...fireBars.map(k => k.h));
        const l = Math.min(...fireBars.map(k => k.l));
        const body = Math.abs(c - o), range = h - l;
        if (range < 5) return null;

        // V104: 范围过滤
        if (range < FIRE_MIN_RANGE_PT) {
            log(`⏭️ Fire范围太小: ${range.toFixed(1)}pt < ${FIRE_MIN_RANGE_PT}pt`);
            return null;
        }

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
            this.inducementLow = 0;
            this.inducementHigh = 0;
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
                log(`🔥 Fire Candle 判定: ${icon} | O=$${f.o.toFixed(1)} C=$${f.c.toFixed(1)} H=$${f.h.toFixed(1)} L=$${f.l.toFixed(1)} | 范围${f.range.toFixed(0)}pt 实体${(f.bodyRatio * 100).toFixed(0)}%`);
            } else {
                log(`⏳ Fire Candle 数据不足或范围不够`);
            }
        }

        if (!this.todayFire || this.todayFire.dir === "skip") return null;

        // 不在交易窗口内 → 跳过
        if (utcH < TRADE_START_UTC || utcH > TRADE_END_UTC) return null;

        const f = this.todayFire;

        // ═══ V104: Funding Rate 过滤 ═══
        if (f.dir === "long" && this.fundingRate > FUNDING_EXTREME) {
            log(`⏭️ Funding过高: ${(this.fundingRate * 100).toFixed(4)}% > ${(FUNDING_EXTREME * 100).toFixed(2)}% 不追多`);
            return null;
        }
        if (f.dir === "short" && this.fundingRate < -FUNDING_EXTREME) {
            log(`⏭️ Funding过低: ${(this.fundingRate * 100).toFixed(4)}% < -${(FUNDING_EXTREME * 100).toFixed(2)}% 不追空`);
            return null;
        }

        // ATR已移至3核心条件之后检查
        const atr = this.atr14();

        // ═══ Step 2: 诱导回踩 (V104: 深度+量能) ═══
        if (this.klines.length < 3) return null;
        const latestBar = this.klines[this.klines.length - 1];
        const prevBar = this.klines[this.klines.length - 2];
        const avgVol = this.avgVol5m();

        if (!this.manipulated) {
            if (f.dir === "long") {
                const depth = f.c - latestBar.l;
                if (depth >= INDUCEMENT_MIN_DEPTH_PT && (avgVol <= 0 || latestBar.v >= avgVol * INDUCEMENT_VOL_MULT)) {
                    this.manipulated = true;
                    this.inducementLow = latestBar.l;
                    log(`📉 诱导回踩! 深度${depth.toFixed(1)}pt 量能${(latestBar.v / (avgVol || 1)).toFixed(1)}x | Low=$${latestBar.l.toFixed(1)}`);
                } else if (latestBar.l < f.c) {
                    log(`⏳ 诱导不够深: ${(f.c - latestBar.l).toFixed(1)}pt < ${INDUCEMENT_MIN_DEPTH_PT}pt 或量能不足`);
                }
            }
            if (f.dir === "short") {
                const depth = latestBar.h - f.c;
                if (depth >= INDUCEMENT_MIN_DEPTH_PT && (avgVol <= 0 || latestBar.v >= avgVol * INDUCEMENT_VOL_MULT)) {
                    this.manipulated = true;
                    this.inducementHigh = latestBar.h;
                    log(`📈 诱导回踩! 深度${depth.toFixed(1)}pt 量能${(latestBar.v / (avgVol || 1)).toFixed(1)}x | High=$${latestBar.h.toFixed(1)}`);
                }
            }
            return null;
        }

        // 更新诱导极值
        if (f.dir === "long" && latestBar.l < this.inducementLow && latestBar.l > 0) {
            this.inducementLow = latestBar.l;
        }
        if (f.dir === "short" && latestBar.h > this.inducementHigh) {
            this.inducementHigh = latestBar.h;
        }

        const dir = f.dir as "long" | "short";  // 已在324行排除skip
        if (!this.check15mStructure(dir)) return null;

        // ═══ Step 4: 5m 3核心条件入场 (回测最优) ═══
        // 3核心 = 回穿FireClose + 强阳线(实体≥58%) + 量能爆发(≥1.4x)
        let entry = false;
        const barBody = Math.abs(latestBar.c - latestBar.o);
        const barRange = latestBar.h - latestBar.l;
        const barBodyRatio = barRange > 0 ? barBody / barRange : 0;

        if (f.dir === "long") {
            const cond1 = latestBar.c > f.c - 4;                           // ① 回到Close上方(容差4pt)
            const cond2 = latestBar.c > latestBar.o && barBodyRatio >= ENTRY_BODY_RATIO; // ② 强阳线≥58%
            const cond3 = avgVol > 0 && latestBar.v >= avgVol * ENTRY_VOL_MULT; // ③ 量能爆发≥1.4x

            if (cond1 && cond2 && cond3) {
                entry = true;
                log(`✅ 3核心入场! C>FC-4:✅ 强阳${(barBodyRatio*100).toFixed(0)}%:✅ Vol${(latestBar.v/avgVol).toFixed(1)}x:✅`);
            } else if (this.scanCount % 6 === 0) {
                log(`⏳ 3核心: C>${f.c.toFixed(0)}-4:${cond1?'✅':'❌'} 阳${(barBodyRatio*100).toFixed(0)}%:${cond2?'✅':'❌'} Vol${avgVol>0?(latestBar.v/avgVol).toFixed(1):'?'}x:${cond3?'✅':'❌'}`);
            }
        } else {
            const cond1 = latestBar.c < f.c + 4;
            const cond2 = latestBar.c < latestBar.o && barBodyRatio >= ENTRY_BODY_RATIO;
            const cond3 = avgVol > 0 && latestBar.v >= avgVol * ENTRY_VOL_MULT;

            if (cond1 && cond2 && cond3) {
                entry = true;
                log(`✅ 3核心入场(空)! C<FC+4:✅ 强阴${(barBodyRatio*100).toFixed(0)}%:✅ Vol${(latestBar.v/avgVol).toFixed(1)}x:✅`);
            }
        }

        if (!entry) return null;

        // ═══ ATR相对门槛（自适应市场波动）═══
        // 计算近20根5m bar的ATR均值
        const atrVals: number[] = [];
        for (let ai = Math.max(1, this.klines.length - 20); ai < this.klines.length; ai++) {
            const ki = this.klines[ai];
            const kp = this.klines[ai - 1];
            const tr = Math.max(ki.h - ki.l, Math.abs(ki.h - kp.c), Math.abs(ki.l - kp.c));
            atrVals.push(tr);
        }
        const avgAtr20 = atrVals.length > 0 ? atrVals.reduce((a, v) => a + v, 0) / atrVals.length : 0;

        if (avgAtr20 > 0 && atr < avgAtr20 * 0.62) {
            log(`⏭️ ATR太低: ${atr.toFixed(1)}pt < avg20(${avgAtr20.toFixed(1)})×0.62=${(avgAtr20*0.62).toFixed(1)}pt skip`);
            return null;
        }
        if (atr > 68) {
            log(`⏭️ ATR太高: ${atr.toFixed(1)}pt > 68pt 太疯狂skip`);
            return null;
        }

        // ═══ Step 5: 动态SL (V104: 诱导低点 + ATR弹性) ═══
        const price = latestBar.c;

        // 基于诱导极值的SL
        let inductSL: number;
        if (f.dir === "long") {
            inductSL = price - this.inducementLow + SL_INDUCEMENT_PAD;
        } else {
            inductSL = this.inducementHigh - price + SL_INDUCEMENT_PAD;
        }

        // ATR弹性调整 — ATR低→SL紧, ATR高→SL宽
        let atrSL = INITIAL_SL_PT;
        if (atr > 0) {
            const ratio = atr / SL_ATR_BASELINE;
            atrSL = SL_ATR_FLOOR + (SL_ATR_CEILING - SL_ATR_FLOOR) * Math.min(ratio, 1);
        }

        // 取两者中更大的，然后clamp
        const slPt = Math.max(SL_ATR_FLOOR, Math.min(SL_ATR_CEILING, Math.max(inductSL, atrSL)));
        const tpPt = FULL_TP_PT;  // 5R全平

        // 🎯 达标检测
        const bal = balance || 250;
        if (bal >= TARGET_BALANCE) {
            log(`🏆 已达标 $${bal.toFixed(0)} ≥ $${TARGET_BALANCE} → 停止交易!`);
            return null;
        }

        // 💰 固定仓位
        const qty = FIXED_QTY;
        const maxLoss = qty * slPt;
        log(`💰 V104: ${qty}ETH | SL=${slPt.toFixed(1)}pt(诱导${inductSL.toFixed(1)}+ATR${atrSL.toFixed(1)}) | TP=分批+${PARTIAL_TP_PT}pt/+${FULL_TP_PT}pt | Funding=${(this.fundingRate*100).toFixed(3)}% | 余额=$${bal.toFixed(0)}`);

        // 窗口结束 = UTC 20:00
        const endTs = new Date();
        endTs.setUTCHours(TRADE_END_UTC, 0, 0, 0);
        if (endTs.getTime() < now) endTs.setDate(endTs.getDate() + 1);

        const bigTag = bigDelta !== undefined && bigDelta !== 0 ? ` bigΔ=${bigDelta.toFixed(1)}` : "";
        const reason =
            `🔥 V104 ${f.dir === "long" ? "📈做多" : "📉做空"} | ` +
            `4H: O$${f.o.toFixed(0)} C$${f.c.toFixed(0)} 范围${f.range.toFixed(0)}pt 实体${(f.bodyRatio * 100).toFixed(0)}% | ` +
            `SL=${slPt.toFixed(0)}pt TP=分批(+${PARTIAL_TP_PT}/+${FULL_TP_PT})${bigTag}`;

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
