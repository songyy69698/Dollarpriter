/**
 * 🧠 ETH Order Flow Bot v3 — 策略核心
 * ═══════════════════════════════════════════════
 * 11-Gate Tick + 4-Layer Signal Audit
 * Bitunix ETHUSDT | 150x Max Leverage
 *
 * 从 eth_bot_v3.py 蓝图 1:1 转译为 TypeScript
 */

// ─────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────

export enum Direction { LONG = "LONG", SHORT = "SHORT", NEUTRAL = "NEUTRAL" }
export enum VolRegime { EXPANDING = "EXPANDING", CONTRACTING = "CONTRACTING", STABLE = "STABLE" }
export enum BotPhase { PHASE_0 = "paper_trading", PHASE_1 = "min_size_live", PHASE_2 = "normal_operation" }
export enum GateResult { PASS = "pass", REJECT = "reject", SKIP = "skip" }
export enum SignalType {
    ABSORPTION = "absorption", TRAP_REVERSAL = "trap_reversal",
    REAL_WALL = "real_wall", FAKE_WALL = "fake_wall",
    EXHAUSTION = "exhaustion", CONFLUENCE = "confluence", POC_MIGRATION = "poc_migration",
}

// ─────────────────────────────────────────────
// Data Structures
// ─────────────────────────────────────────────

export interface ValueArea { vah: number; val: number; poc: number; totalVolume: number; isFresh: boolean; }

export interface GateEvaluation {
    gateName: string; result: GateResult; reason: string; value?: string;
}

export interface GateChainRecord {
    timestamp: Date;
    gates: GateEvaluation[];
    finalAction: string;
}

export interface MarketSnapshot {
    atr7: number; atr21: number; atr14: number;
    volRegime: string; cvd: number;
    open: number; high: number; low: number; close: number; volume: number;
    poc: number; fcrVah: number; fcrVal: number; fcrPoc: number;
}

export interface SignalAuditEntry {
    signalId: number; signalType: string; timestamp: string;
    direction: string; triggerPrice: number;
    market: MarketSnapshot;
    gateChain: GateChainRecord | null;
}

export interface FourHourAssessment {
    timestamp: Date; boundary: number;
    bias: Direction; confidence: number; reasons: string[];
}

export interface ResonanceDimension { name: string; score: number; detail: string; }
export interface ResonanceSnapshot {
    timestamp: Date; direction: Direction;
    dimensions: ResonanceDimension[];
    totalScore: number; confirmCount: number; threshold: number; passed: boolean;
}

export interface DrawdownTier { scale: number; name: string; }
const TIERS: DrawdownTier[] = [
    { scale: 1.0, name: "TIER_0" }, { scale: 0.75, name: "TIER_1" },
    { scale: 0.50, name: "TIER_2" }, { scale: 0.25, name: "TIER_3" },
    { scale: 0.10, name: "TIER_4" },
];

// ═══════════════════════════════════════════════
// AdaptiveATR
// ═══════════════════════════════════════════════

export class AdaptiveATR {
    private trHistory: number[] = [];
    closes: number[] = [];
    private maxLen = 50;

    update(high: number, low: number, close: number) {
        let tr = high - low;
        if (this.closes.length > 0) {
            const prev = this.closes[this.closes.length - 1];
            tr = Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev));
        }
        this.closes.push(close);
        this.trHistory.push(tr);
        if (this.closes.length > this.maxLen) { this.closes.shift(); this.trHistory.shift(); }
    }

    private _atr(period: number): number {
        if (this.trHistory.length < period) return this.trHistory.length > 0 ? this.trHistory[this.trHistory.length - 1] : 0;
        const slice = this.trHistory.slice(-period);
        return slice.reduce((a, b) => a + b, 0) / period;
    }

    get atrFast(): number { return this._atr(7); }
    get atrSlow(): number { return this._atr(21); }
    get atr14(): number { return this._atr(14); }
    get atr50(): number { return this._atr(50); }

    get regime(): VolRegime {
        const fast = this.atrFast, slow = this.atrSlow;
        if (slow === 0) return VolRegime.STABLE;
        const ratio = fast / slow;
        if (ratio > 1.10) return VolRegime.EXPANDING;
        if (ratio < 0.90) return VolRegime.CONTRACTING;
        return VolRegime.STABLE;
    }

    get volRatio1450(): number { return this.atr50 ? this.atr14 / this.atr50 : 1.0; }

    stopDistance(mult = 1.0): number { return this.atrFast * mult; }

    maxLeverage(price: number, riskPct = 0.02, slMult = 1.0, hardCap = 150): number {
        const sd = this.stopDistance(slMult);
        if (sd === 0 || price === 0) return hardCap;
        return Math.min(riskPct / (sd / price), hardCap);
    }
}

// ═══════════════════════════════════════════════
// SlippageTracker
// ═══════════════════════════════════════════════

export class SlippageTracker {
    private records: { slip: number; latency: number }[] = [];
    private maxLen: number;

    constructor(window = 100) { this.maxLen = window; }

    record(expected: number, actual: number, latencyMs: number) {
        this.records.push({ slip: Math.abs(actual - expected) / expected, latency: latencyMs });
        if (this.records.length > this.maxLen) this.records.shift();
    }

    get avgSlippagePct(): number {
        if (!this.records.length) return 0.001;
        return this.records.reduce((s, r) => s + r.slip, 0) / this.records.length;
    }

    get p95SlippagePct(): number {
        if (this.records.length < 5) return 0.002;
        const sorted = this.records.map(r => r.slip).sort((a, b) => a - b);
        return sorted[Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1)];
    }
}

// ═══════════════════════════════════════════════
// ColdStartManager
// ═══════════════════════════════════════════════

export class ColdStartManager {
    phase: BotPhase = BotPhase.PHASE_0;
    totalTrades = 0;

    recordTrade(wins: number, losses: number, kellyF: number) {
        this.totalTrades = wins + losses;
        const wr = this.totalTrades > 0 ? wins / this.totalTrades : 0;
        if (wr < 0.35 && this.totalTrades >= 20) {
            if (this.phase === BotPhase.PHASE_2) { this.phase = BotPhase.PHASE_1; return; }
            if (this.phase === BotPhase.PHASE_1) { this.phase = BotPhase.PHASE_0; return; }
        }
        if (this.phase === BotPhase.PHASE_0 && this.totalTrades >= 50 && wr >= 0.40) this.phase = BotPhase.PHASE_1;
        else if (this.phase === BotPhase.PHASE_1 && this.totalTrades >= 100 && kellyF > 0) this.phase = BotPhase.PHASE_2;
    }

    get isPaper(): boolean { return this.phase === BotPhase.PHASE_0; }
    get sizeScale(): number {
        if (this.phase === BotPhase.PHASE_0) return 0;
        if (this.phase === BotPhase.PHASE_1) return 0.10;
        return 1.0;
    }
}

// ═══════════════════════════════════════════════
// KellyRiskManager
// ═══════════════════════════════════════════════

export class KellyRiskManager {
    winCount = 0; lossCount = 0;
    totalWinsAmt = 0; totalLossesAmt = 0;
    dailyConsecWins = 0;

    kellyFraction(): number {
        const total = this.winCount + this.lossCount;
        if (total < 10) return 0;
        const p = this.winCount / total, q = 1 - p;
        const aw = this.winCount ? this.totalWinsAmt / this.winCount : 0;
        const al = this.lossCount ? this.totalLossesAmt / this.lossCount : 1;
        if (al === 0) return 0;
        const b = aw / al;
        const k = b > 0 ? (p * b - q) / b : 0;
        return Math.max(0, k * 0.5);
    }

    hasEdge(): boolean { return this.kellyFraction() > 0; }

    recordTrade(pnl: number) {
        if (pnl > 0) { this.winCount++; this.totalWinsAmt += pnl; this.dailyConsecWins++; }
        else { this.lossCount++; this.totalLossesAmt += Math.abs(pnl); this.dailyConsecWins = 0; }
    }

    shouldShutdown(): boolean { return this.dailyConsecWins >= 3; }
    resetDaily() { this.dailyConsecWins = 0; }
}

// ═══════════════════════════════════════════════
// StopLossEngine
// ═══════════════════════════════════════════════

export class StopLossEngine {
    static readonly MAX_RISK_PCT = 0.02;
    static readonly SL_ATR_MULT = 1.0;

    capital: number;
    atr: AdaptiveATR;
    slippage: SlippageTracker;
    consecutiveLosses = 0;

    constructor(capital: number, atr: AdaptiveATR, slippage: SlippageTracker) {
        this.capital = capital; this.atr = atr; this.slippage = slippage;
    }

    getCurrentTier(): DrawdownTier {
        return TIERS[Math.min(this.consecutiveLosses, TIERS.length - 1)];
    }

    maxLossAmount(): number {
        return this.capital * StopLossEngine.MAX_RISK_PCT * this.getCurrentTier().scale;
    }

    recordResult(win: boolean) { this.consecutiveLosses = win ? 0 : this.consecutiveLosses + 1; }

    computeStopPrice(entry: number, dir: Direction, fvgOrigin?: number): number {
        const buf = this.atr.atrFast * 0.15;
        if (fvgOrigin !== undefined) {
            return dir === Direction.LONG ? fvgOrigin - buf : fvgOrigin + buf;
        }
        const sd = this.atr.stopDistance(StopLossEngine.SL_ATR_MULT);
        return dir === Direction.LONG ? entry - sd : entry + sd;
    }

    computePositionSize(entry: number, stop: number, leverage: number, coldScale = 1.0): number {
        const dist = Math.abs(entry - stop) / entry;
        const eff = dist + this.slippage.p95SlippagePct;
        if (eff === 0) return 0;
        const notional = this.maxLossAmount() / eff;
        return (notional / leverage) * coldScale;
    }

    /** TP = entry + risk × rrRatio (默认 2:1) */
    computeTP(entry: number, stop: number, dir: Direction, rrRatio = 2.0): number {
        const risk = Math.abs(entry - stop);
        const reward = risk * rrRatio;
        return dir === Direction.LONG ? entry + reward : entry - reward;
    }

    /** 3 阶段移动止损: 原始 → 保本(1R) → 跟踪(ATR×0.8) */
    updateTrailingStop(trade: ActiveTrade, currentHigh: number, currentLow: number) {
        const entry = trade.entryPrice;
        const risk = Math.abs(entry - trade.initialStop);
        if (risk === 0) return;

        if (trade.direction === Direction.LONG) {
            trade.bestPrice = Math.max(trade.bestPrice, currentHigh);
            const profit = trade.bestPrice - entry;
            // Phase 2: 保本
            if (profit >= risk && !trade.stopMovedToBreakeven) {
                trade.stopLoss = entry;
                trade.stopMovedToBreakeven = true;
                trade.trailingActive = true;
            }
            // Phase 3: 跟踪
            if (trade.trailingActive) {
                const newStop = trade.bestPrice - this.atr.atrFast * 0.8;
                if (newStop > trade.stopLoss) trade.stopLoss = newStop;
            }
        } else {
            if (trade.bestPrice === 0) trade.bestPrice = currentLow;
            trade.bestPrice = Math.min(trade.bestPrice, currentLow);
            const profit = entry - trade.bestPrice;
            if (profit >= risk && !trade.stopMovedToBreakeven) {
                trade.stopLoss = entry;
                trade.stopMovedToBreakeven = true;
                trade.trailingActive = true;
            }
            if (trade.trailingActive) {
                const newStop = trade.bestPrice + this.atr.atrFast * 0.8;
                if (newStop < trade.stopLoss) trade.stopLoss = newStop;
            }
        }
    }
}

// ═══════════════════════════════════════════════
// StorylineEngine (MTF alignment)
// ═══════════════════════════════════════════════

export class StorylineEngine {
    weeklyDirection: Direction = Direction.NEUTRAL;
    dailyDirection: Direction = Direction.NEUTRAL;
    intradayBias: Direction = Direction.NEUTRAL;
    pocHistory: { ts: Date; poc: number }[] = [];
    exhaustionActive = false;
    exhaustionSignals: string[] = [];

    updateMtf(weekly: Direction, daily: Direction) { this.weeklyDirection = weekly; this.dailyDirection = daily; }
    updateIntradayBias(bias: Direction) { this.intradayBias = bias; }

    isAligned(): boolean {
        if (this.weeklyDirection === Direction.NEUTRAL) return false;
        return this.weeklyDirection === this.dailyDirection;
    }
    is4hAligned(): boolean {
        if (this.intradayBias === Direction.NEUTRAL) return true;
        return this.intradayBias === this.weeklyDirection;
    }
    getBias(): Direction {
        if (!this.isAligned()) return Direction.NEUTRAL;
        if (!this.is4hAligned()) return Direction.NEUTRAL;
        return this.weeklyDirection;
    }

    trackPoc(ts: Date, poc: number) {
        this.pocHistory.push({ ts, poc });
        if (this.pocHistory.length > 20) this.pocHistory.shift();
    }
    pocIsMigrating(dir: Direction, lookback = 5): boolean {
        if (this.pocHistory.length < lookback) return false;
        const recent = this.pocHistory.slice(-lookback).map(p => p.poc);
        if (dir === Direction.LONG) return recent.every((v, i) => i === 0 || recent[i - 1] <= v);
        if (dir === Direction.SHORT) return recent.every((v, i) => i === 0 || recent[i - 1] >= v);
        return false;
    }

    /** 趋势衰竭检测 — CLIMAX_CANDLE / EXHAUSTION_GAP / FINAL_FLAG */
    detectExhaustion(candleRange: number, avgRange: number, volume: number, avgVolume: number, hasGap: boolean, isFlag: boolean): string | null {
        if (candleRange > avgRange * 2 && volume > avgVolume * 2.5) {
            this.exhaustionSignals.push("CLIMAX_CANDLE");
            this.exhaustionActive = true;
            return "CLIMAX_CANDLE";
        }
        if (hasGap && volume > avgVolume * 1.5) {
            this.exhaustionSignals.push("EXHAUSTION_GAP");
            this.exhaustionActive = true;
            return "EXHAUSTION_GAP";
        }
        if (isFlag && candleRange < avgRange * 0.4) {
            this.exhaustionSignals.push("FINAL_FLAG");
            this.exhaustionActive = true;
            return "FINAL_FLAG";
        }
        return null;
    }

    shouldProtectProfit(): boolean { return this.exhaustionActive; }
    clearExhaustion() { this.exhaustionActive = false; this.exhaustionSignals = []; }
}

// ═══════════════════════════════════════════════
// FourHourObserver
// ═══════════════════════════════════════════════

interface FourHourCandle {
    boundary: number; open: number; high: number; low: number; close: number;
    volume: number; poc: number; isBullish: boolean;
}

export class FourHourObserver {
    static readonly BOUNDARIES = [8, 12, 16, 20]; // UTC+8
    static readonly BIAS_THRESHOLD = 3;

    private storyline: StorylineEngine;
    completedCandles: FourHourCandle[] = [];
    assessments: FourHourAssessment[] = [];
    lastAssessment: FourHourAssessment | null = null;

    private curBoundary: number | null = null;
    private curOpen = 0; private curHigh = 0; private curLow = Infinity;
    private curVolume = 0; private curVwapNum = 0;

    constructor(storyline: StorylineEngine) { this.storyline = storyline; }

    private getBoundary(hour: number): number {
        const B = FourHourObserver.BOUNDARIES;
        for (let i = 0; i < B.length; i++) {
            const next = B[(i + 1) % B.length];
            if (next <= B[i]) { if (hour >= B[i] || hour < next) return B[i]; }
            else { if (hour >= B[i] && hour < next) return B[i]; }
        }
        return B[B.length - 1];
    }

    private closeCandle(close: number, ts: Date): FourHourCandle {
        const vol = Math.max(this.curVolume, 1);
        const candle: FourHourCandle = {
            boundary: this.curBoundary || 0, open: this.curOpen || close,
            high: this.curHigh, low: this.curLow, close, volume: this.curVolume,
            poc: this.curVwapNum / vol, isBullish: close >= (this.curOpen || close),
        };
        this.completedCandles.push(candle);
        if (this.completedCandles.length > 12) this.completedCandles = this.completedCandles.slice(-12);
        return candle;
    }

    private startCandle(boundary: number, open: number) {
        this.curBoundary = boundary; this.curOpen = open;
        this.curHigh = open; this.curLow = open; this.curVolume = 0; this.curVwapNum = 0;
    }

    private assess(now: Date, boundary: number, openPrice: number): FourHourAssessment {
        let score = 0; const reasons: string[] = [];
        const prev = this.completedCandles.length > 0 ? this.completedCandles[this.completedCandles.length - 1] : null;

        if (prev) {
            const body = Math.abs(prev.close - prev.open);
            if (prev.isBullish) { score += 2; reasons.push(`prev_4H bullish (+${body.toFixed(2)})`); }
            else { score -= 2; reasons.push(`prev_4H bearish (-${body.toFixed(2)})`); }

            const range = prev.high - prev.low;
            if (range > 0) {
                const closePct = (prev.close - prev.low) / range;
                if (closePct >= 0.75) { score += 1; reasons.push(`close upper 25%`); }
                else if (closePct <= 0.25) { score -= 1; reasons.push(`close lower 25%`); }

                const bodyTop = Math.max(prev.open, prev.close);
                const upperWick = (prev.high - bodyTop) / range;
                if (upperWick > 0.40) { score -= 1; reasons.push(`upper wick rejection`); }
                const bodyBot = Math.min(prev.open, prev.close);
                const lowerWick = (bodyBot - prev.low) / range;
                if (lowerWick > 0.40) { score += 1; reasons.push(`lower wick rejection`); }
            }

            const gap = openPrice - prev.close;
            const gapPct = prev.close ? gap / prev.close : 0;
            if (gapPct > 0.001) { score += 1; reasons.push(`gap UP +${gap.toFixed(2)}`); }
            else if (gapPct < -0.001) { score -= 1; reasons.push(`gap DOWN ${gap.toFixed(2)}`); }
        }

        // POC migration
        if (this.completedCandles.length >= 3) {
            const pocs = this.completedCandles.slice(-3).map(c => c.poc);
            if (pocs.every((v, i) => i === 0 || pocs[i - 1] <= v)) { score += 2; reasons.push("POC migrating UP"); }
            else if (pocs.every((v, i) => i === 0 || pocs[i - 1] >= v)) { score -= 2; reasons.push("POC migrating DOWN"); }
        }

        let bias = Direction.NEUTRAL;
        if (score >= FourHourObserver.BIAS_THRESHOLD) bias = Direction.LONG;
        else if (score <= -FourHourObserver.BIAS_THRESHOLD) bias = Direction.SHORT;

        const assessment: FourHourAssessment = {
            timestamp: now, boundary, bias,
            confidence: Math.min(Math.abs(score) / 6, 1), reasons,
        };
        this.assessments.push(assessment);
        if (this.assessments.length > 50) this.assessments = this.assessments.slice(-50);
        this.lastAssessment = assessment;
        return assessment;
    }

    update(now: Date, high: number, low: number, close: number, volume = 0): FourHourAssessment | null {
        const utc8Hour = (now.getUTCHours() + 8) % 24;
        const boundary = this.getBoundary(utc8Hour);

        if (this.curBoundary !== null) {
            this.curHigh = Math.max(this.curHigh, high);
            this.curLow = Math.min(this.curLow, low);
            this.curVolume += volume;
            this.curVwapNum += ((high + low) / 2) * volume;
        }

        if (boundary !== this.curBoundary) {
            if (this.curBoundary !== null) this.closeCandle(close, now);
            const assessment = this.assess(now, boundary, close);
            this.storyline.updateIntradayBias(assessment.bias);
            this.startCandle(boundary, close);
            return assessment;
        } else if (this.curBoundary === null) {
            this.curBoundary = boundary; this.curOpen = close;
            this.curHigh = high; this.curLow = low;
        }
        return null;
    }

    get currentBias(): Direction { return this.lastAssessment?.bias ?? Direction.NEUTRAL; }
}

// ═══════════════════════════════════════════════
// ResonanceScorer (7 dimensions, every 15 min)
// ═══════════════════════════════════════════════

export class ResonanceScorer {
    static readonly CONFIRM_THRESHOLD = 4;
    static readonly EVAL_INTERVAL_MS = 15 * 60_000;

    snapshots: ResonanceSnapshot[] = [];
    lastEvalTime: Date | null = null;
    current: ResonanceSnapshot | null = null;
    // 双向评估
    currentLong: ResonanceSnapshot | null = null;
    currentShort: ResonanceSnapshot | null = null;
    activeBias: Direction = Direction.NEUTRAL;

    // VWAP
    private vwapNum = 0; private vwapDen = 0; private lastDay = -1;
    // Volume
    private volHistory: number[] = [];
    // Slopes
    private cvdHistory: { ts: number; val: number }[] = [];
    private priceHistory: { ts: number; val: number }[] = [];
    // Swing tracking for CVD divergence
    private swingWindow: number[] = [];
    private swingCvdWindow: number[] = [];
    private priceLows: number[] = [];
    private priceHighs: number[] = [];
    private cvdAtLows: number[] = [];
    private cvdAtHighs: number[] = [];

    updateData(now: Date, price: number, volume: number, cvd: number) {
        if (this.lastDay >= 0 && now.getUTCDate() !== this.lastDay) { this.vwapNum = 0; this.vwapDen = 0; }
        this.lastDay = now.getUTCDate();
        this.vwapNum += price * volume; this.vwapDen += volume;
        this.volHistory.push(volume); if (this.volHistory.length > 100) this.volHistory.shift();
        const ts = now.getTime();
        this.cvdHistory.push({ ts, val: cvd }); if (this.cvdHistory.length > 30) this.cvdHistory.shift();
        this.priceHistory.push({ ts, val: price }); if (this.priceHistory.length > 30) this.priceHistory.shift();

        // 5-bar swing detection
        this.swingWindow.push(price); this.swingCvdWindow.push(cvd);
        if (this.swingWindow.length > 5) { this.swingWindow.shift(); this.swingCvdWindow.shift(); }
        if (this.swingWindow.length === 5) {
            const mid = this.swingWindow[2];
            if (mid === Math.min(...this.swingWindow)) {
                this.priceLows.push(mid); this.cvdAtLows.push(this.swingCvdWindow[2]);
                if (this.priceLows.length > 10) { this.priceLows.shift(); this.cvdAtLows.shift(); }
            }
            if (mid === Math.max(...this.swingWindow)) {
                this.priceHighs.push(mid); this.cvdAtHighs.push(this.swingCvdWindow[2]);
                if (this.priceHighs.length > 10) { this.priceHighs.shift(); this.cvdAtHighs.shift(); }
            }
        }
    }

    /** CVD 背离检测: bullish = price LL + CVD HL; bearish = price HH + CVD LH */
    detectDivergence(dir: Direction): string | null {
        if (dir === Direction.LONG && this.priceLows.length >= 2 && this.cvdAtLows.length >= 2) {
            const [p1, p2] = this.priceLows.slice(-2);
            const [c1, c2] = this.cvdAtLows.slice(-2);
            if (p2 < p1 && c2 > c1) return `bullish: price LL ${p1.toFixed(0)}→${p2.toFixed(0)} CVD HL ${c1.toFixed(0)}→${c2.toFixed(0)}`;
        }
        if (dir === Direction.SHORT && this.priceHighs.length >= 2 && this.cvdAtHighs.length >= 2) {
            const [p1, p2] = this.priceHighs.slice(-2);
            const [c1, c2] = this.cvdAtHighs.slice(-2);
            if (p2 > p1 && c2 < c1) return `bearish: price HH ${p1.toFixed(0)}→${p2.toFixed(0)} CVD LH ${c1.toFixed(0)}→${c2.toFixed(0)}`;
        }
        return null;
    }

    get vwap(): number { return this.vwapDen > 0 ? this.vwapNum / this.vwapDen : 0; }
    get avgVol(): number { return this.volHistory.length ? this.volHistory.reduce((a, b) => a + b, 0) / this.volHistory.length : 0; }

    private slope(hist: { ts: number; val: number }[]): number {
        if (hist.length < 2) return 0;
        const data = hist.slice(-10);
        return data[data.length - 1].val - data[0].val;
    }

    shouldEvaluate(now: Date): boolean {
        if (!this.lastEvalTime) return true;
        return now.getTime() - this.lastEvalTime.getTime() >= ResonanceScorer.EVAL_INTERVAL_MS;
    }

    evaluate(now: Date, direction: Direction, price: number, volume: number,
        h4Assessment: FourHourAssessment | null,
        pocMigrating: boolean, pocMigDir: Direction,
        absorptionDir: Direction | null,
        va: ValueArea | null, realWalls: { price: number }[],
        atrFast: number): ResonanceSnapshot {

        const dims: ResonanceDimension[] = [];
        const isLong = direction === Direction.LONG;

        // D1: 4H Bias
        if (h4Assessment && h4Assessment.bias === direction && h4Assessment.confidence >= 0.5) {
            dims.push({ name: "4H_BIAS", score: 1, detail: `4H=${h4Assessment.bias} conf=${h4Assessment.confidence.toFixed(2)}` });
        } else if (h4Assessment && h4Assessment.bias === Direction.NEUTRAL) {
            dims.push({ name: "4H_BIAS", score: 0, detail: "4H=NEUTRAL" });
        } else {
            dims.push({ name: "4H_BIAS", score: -1, detail: `4H=${h4Assessment?.bias ?? "N/A"} vs ${direction}` });
        }

        // D2: CVD vs Price (with divergence detection)
        const cvdS = this.slope(this.cvdHistory), priceS = this.slope(this.priceHistory);
        const cvdOk = isLong ? cvdS > 0 : cvdS < 0;
        const priceOk = isLong ? priceS > 0 : priceS < 0;
        const divergence = this.detectDivergence(direction);
        if (divergence) {
            dims.push({ name: "CVD_PRICE", score: 1, detail: `DIVERGENCE ${divergence}` });
        } else if (cvdOk && priceOk) {
            dims.push({ name: "CVD_PRICE", score: 1, detail: `aligned cvd=${cvdS.toFixed(1)} price=${priceS.toFixed(1)}` });
        } else if (cvdOk !== priceOk) {
            dims.push({ name: "CVD_PRICE", score: 0, detail: `cvd=${cvdS.toFixed(1)} price=${priceS.toFixed(1)}` });
        } else {
            dims.push({ name: "CVD_PRICE", score: -1, detail: `cvd=${cvdS.toFixed(1)} price=${priceS.toFixed(1)}` });
        }

        // D3: Absorption
        if (absorptionDir === direction) dims.push({ name: "ABSORPTION", score: 1, detail: `absorption→${direction}` });
        else if (!absorptionDir) dims.push({ name: "ABSORPTION", score: 0, detail: "none" });
        else dims.push({ name: "ABSORPTION", score: -1, detail: `absorption→${absorptionDir}` });

        // D4: Wall position
        let wallOk = false;
        if (va && realWalls.length) {
            for (const w of realWalls) {
                if (isLong && Math.abs(w.price - va.val) < atrFast * 0.3) { wallOk = true; break; }
                if (!isLong && Math.abs(w.price - va.vah) < atrFast * 0.3) { wallOk = true; break; }
            }
        }
        dims.push({ name: "WALL_POSITION", score: wallOk ? 1 : 0, detail: wallOk ? "wall near VA" : "no walls" });

        // D5: POC migration
        if (pocMigrating && pocMigDir === direction) dims.push({ name: "POC_MIGRATION", score: 1, detail: `POC→${direction}` });
        else if (pocMigrating && pocMigDir !== direction) dims.push({ name: "POC_MIGRATION", score: -1, detail: `POC→${pocMigDir}` });
        else dims.push({ name: "POC_MIGRATION", score: 0, detail: "stable" });

        // D6: VWAP
        const v = this.vwap;
        if (v > 0) {
            const correctSide = (isLong && price > v) || (!isLong && price < v);
            dims.push({ name: "VWAP_POSITION", score: correctSide ? 1 : Math.abs(price - v) / v < 0.001 ? 0 : -1,
                detail: `price=${price.toFixed(1)} VWAP=${v.toFixed(1)}` });
        } else dims.push({ name: "VWAP_POSITION", score: 0, detail: "VWAP not ready" });

        // D7: Volume expansion
        const avg = this.avgVol;
        if (avg > 0 && volume > 0) {
            const ratio = volume / avg;
            dims.push({ name: "VOLUME_EXPANSION", score: ratio >= 1.2 ? 1 : ratio <= 0.7 ? -1 : 0,
                detail: `${ratio.toFixed(1)}x avg` });
        } else dims.push({ name: "VOLUME_EXPANSION", score: 0, detail: "no data" });

        const total = dims.reduce((s, d) => s + d.score, 0);
        const confirms = dims.filter(d => d.score === 1).length;
        const snap: ResonanceSnapshot = {
            timestamp: now, direction, dimensions: dims, totalScore: total,
            confirmCount: confirms, threshold: ResonanceScorer.CONFIRM_THRESHOLD,
            passed: confirms >= ResonanceScorer.CONFIRM_THRESHOLD,
        };
        this.snapshots.push(snap);
        if (this.snapshots.length > 200) this.snapshots = this.snapshots.slice(-200);
        this.lastEvalTime = now; this.current = snap;
        return snap;
    }

    get isConfirmed(): boolean { return this.current?.passed ?? false; }

    /** 双向评估 — 同时跑 LONG+SHORT，自动选强方向 */
    evaluateDual(now: Date, price: number, volume: number,
        h4Assessment: FourHourAssessment | null,
        pocMigLong: boolean, pocMigShort: boolean,
        absorptionDir: Direction | null,
        va: ValueArea | null, realWalls: { price: number }[],
        atrFast: number) {

        this.currentLong = this.evaluate(now, Direction.LONG, price, volume,
            h4Assessment, pocMigLong, Direction.LONG, absorptionDir, va, realWalls, atrFast);
        this.currentShort = this.evaluate(now, Direction.SHORT, price, volume,
            h4Assessment, pocMigShort, Direction.SHORT, absorptionDir, va, realWalls, atrFast);

        if (this.currentLong.confirmCount > this.currentShort.confirmCount) {
            this.activeBias = Direction.LONG;
            this.current = this.currentLong;
        } else if (this.currentShort.confirmCount > this.currentLong.confirmCount) {
            this.activeBias = Direction.SHORT;
            this.current = this.currentShort;
        } else {
            this.activeBias = Direction.NEUTRAL;
            this.current = this.currentLong; // 平手存 LONG 快照供参考
        }
        this.lastEvalTime = now;
    }
}

// ═══════════════════════════════════════════════
// ObserverScorer (8-Layer v15 — from observer_v15_validation.js)
// ═══════════════════════════════════════════════

import type { BKline, BinanceDataFetcher, FundingRecord, OIRecord, LSRecord } from "./binance-data";

export interface ObserverCheck { name: string; s: "✅" | "❌" | "⚪"; d: string; }
export interface ObserverResult { score: number; marks: ObserverCheck[]; }
export interface ObserverSnapshot {
    timestamp: Date;
    longResult: ObserverResult;
    shortResult: ObserverResult;
    activeBias: Direction;
    price: number;
    fundingRate: number;
    oiChange: number;
    lsr: number | null;
}

// ── EMA 计算 ──
function emaArr(arr: number[], p: number): number[] {
    const k = 2 / (p + 1); let prev: number | null = null;
    return arr.map((v) => { prev = prev == null ? v : v * k + prev * (1 - k); return prev; });
}

// ── GMMA 状态 (12-EMA Guppy) ──
interface GmmaState { up: boolean; down: boolean; tangled: boolean; }
const GMMA_SHORT_PERIODS = [3, 5, 8, 10, 12, 15];
const GMMA_LONG_PERIODS = [30, 35, 40, 45, 50, 60];

// 缓存键
const _gmmaCache = new WeakMap<BKline[], { s: number[][]; l: number[][] }>();

function gmmaState(data: BKline[], idx: number): GmmaState {
    if (!_gmmaCache.has(data)) {
        const cl = data.map(x => x.close);
        _gmmaCache.set(data, {
            s: GMMA_SHORT_PERIODS.map(p => emaArr(cl, p)),
            l: GMMA_LONG_PERIODS.map(p => emaArr(cl, p)),
        });
    }
    const g = _gmmaCache.get(data)!;
    const sA = g.s.reduce((a, e) => a + (e[idx] ?? 0), 0) / GMMA_SHORT_PERIODS.length;
    const lA = g.l.reduce((a, e) => a + (e[idx] ?? 0), 0) / GMMA_LONG_PERIODS.length;
    const pS = g.s.reduce((a, e) => a + (e[Math.max(0, idx - 1)] ?? 0), 0) / GMMA_SHORT_PERIODS.length;
    const pL = g.l.reduce((a, e) => a + (e[Math.max(0, idx - 1)] ?? 0), 0) / GMMA_LONG_PERIODS.length;
    const sep = Math.abs(sA - lA) / Math.max(1e-9, data[idx]?.close ?? 1);
    const exp = Math.abs(sA - lA) > Math.abs(pS - pL);
    return { up: sA > lA && exp, down: sA < lA && exp, tangled: sep < 0.0025 };
}

// ── Volume Profile POC ──
function calcPOC(data: BKline[], idx: number, bars = 18, bins = 24): number {
    const win = data.slice(Math.max(0, idx - bars + 1), idx + 1);
    if (!win.length) return data[idx]?.close ?? 0;
    let lo = Math.min(...win.map(x => x.low)), hi = Math.max(...win.map(x => x.high));
    if (!(hi > lo)) return data[idx].close;
    const step = (hi - lo) / bins, bkt = Array(bins).fill(0);
    for (const k of win) {
        const bi = Math.max(0, Math.min(bins - 1, Math.floor(((k.high + k.low + k.close) / 3 - lo) / step)));
        bkt[bi] += k.volume;
    }
    let best = 0;
    for (let i = 1; i < bins; i++) if (bkt[i] > bkt[best]) best = i;
    return lo + step * (best + 0.5);
}

// ── Volume Average ──
function volAvg(data: BKline[], idx: number, n = 20): number {
    const sl = data.slice(Math.max(0, idx - n), idx);
    return sl.length ? sl.reduce((a, b) => a + b.volume, 0) / sl.length : (data[idx]?.volume ?? 1);
}

// ── CVD Array ──
function cvdArr(data: BKline[]): number[] {
    let c = 0;
    return data.map(x => { c += x.delta; return c; });
}

// ── Sweep Signal (Liquidity Sweep) ──
export interface SweepResult { dir: "LONG" | "SHORT"; strength: number; level: number; }

function sweepSignal(data: BKline[], idx: number): SweepResult | null {
    const s = Math.max(2, idx - 30);
    const highs: number[] = [], lows: number[] = [];
    for (let i = s; i < idx - 2; i++) {
        if (i < 1 || i + 1 >= data.length) continue;
        if (data[i].high >= data[i - 1].high && data[i].high >= data[i + 1].high) highs.push(data[i].high);
        if (data[i].low <= data[i - 1].low && data[i].low <= data[i + 1].low) lows.push(data[i].low);
    }
    function cluster(arr: number[]): { p: number; n: number }[] {
        const out: { p: number; n: number }[] = [];
        for (const p of arr) {
            const h = out.find(x => Math.abs(x.p - p) / p <= 0.0015);
            if (!h) out.push({ p, n: 1 });
            else { h.p = (h.p * h.n + p) / (h.n + 1); h.n++; }
        }
        return out.sort((a, b) => b.n - a.n);
    }
    const k = data[idx];
    if (!k) return null;
    const top = cluster(highs).find(x => x.n >= 2 && k.high > x.p && k.close < x.p);
    const bot = cluster(lows).find(x => x.n >= 2 && k.low < x.p && k.close > x.p);
    if (top) return { dir: "SHORT", strength: top.n, level: top.p };
    if (bot) return { dir: "LONG", strength: bot.n, level: bot.p };
    return null;
}

// ── Absorption (taker ratio) ──
interface AbsorptionResult { bull: boolean; bear: boolean; }

function calcAbsorption(data: BKline[], idx: number): AbsorptionResult {
    const k = data[idx];
    if (!k) return { bull: false, bear: false };
    const br = k.takerBuyBase / Math.max(1e-9, k.volume);
    const sr = k.takerSellBase / Math.max(1e-9, k.volume);
    const body = (k.close - k.open) / Math.max(1e-9, k.open);
    return {
        bull: sr > 0.6 && body > -0.0008 && k.close >= k.open,
        bear: br > 0.6 && body < 0.0008 && k.close <= k.open,
    };
}

// ── Delta Divergence (6-bar) ──
interface DeltaDivResult { bull: boolean; bear: boolean; }

function deltaDiv(data: BKline[], idx: number): DeltaDivResult {
    if (idx < 6) return { bull: false, bear: false };
    const prev = data.slice(idx - 6, idx), k = data[idx];
    if (!k) return { bull: false, bear: false };
    const pLow = Math.min(...prev.map(x => x.low)), pHigh = Math.max(...prev.map(x => x.high));
    const avgD = prev.reduce((a, b) => a + b.delta, 0) / prev.length;
    return {
        bull: k.low <= pLow * 1.001 && k.delta > 0 && k.delta > Math.abs(avgD) * 0.35,
        bear: k.high >= pHigh * 0.999 && k.delta < 0 && Math.abs(k.delta) > Math.abs(avgD) * 0.35,
    };
}

// ── Nearest helper ──
function nearest<T extends { time: number }>(rows: T[], t: number): T | null {
    let best: T | null = null;
    for (const r of rows) { if (r.time <= t) best = r; else break; }
    return best;
}

// ── Helper constructors for check marks ──
function okMark(name: string, d: string): ObserverCheck { return { name, s: "✅", d }; }
function badMark(name: string, d: string): ObserverCheck { return { name, s: "❌", d }; }
function neuMark(name: string, d: string): ObserverCheck { return { name, s: "⚪", d }; }

// ── Score one side (LONG or SHORT) — exact v15 logic ──
function scoreSide(args: {
    side: "LONG" | "SHORT"; envBias: number;
    g30: GmmaState; g5: GmmaState; ve: number;
    sweep: SweepResult | null; dd: DeltaDivResult; abs: AbsorptionResult;
    cvd3: number; cvd8: number;
    ls: LSRecord | null; fr: number; oiCh: number; k: BKline;
}): ObserverResult {
    const { side, envBias, g30, g5, ve, sweep, dd, abs, cvd3, cvd8, ls, fr, oiCh, k } = args;
    let score = 0;
    const marks: ObserverCheck[] = [];
    const cLong = ls && ls.longShortRatio > 1.45 && fr >= 0;
    const cShort = ls && ls.longShortRatio < 0.75 && fr <= 0;
    const liqL = oiCh < -0.15 && k.close < k.open;
    const liqS = oiCh < -0.15 && k.close > k.open;
    const lsr = ls?.longShortRatio?.toFixed(2) ?? "n/a";

    // 1. LIQUIDITY
    if (sweep && sweep.dir === side) {
        score += 2; if (sweep.strength >= 3) score += 1;
        marks.push(okMark("LIQUIDITY", `${side} sweep str=${sweep.strength}`));
    } else marks.push(neuMark("LIQUIDITY", "no sweep"));

    // 2. VOLUME
    if (ve > 1.8) { score += 1; marks.push(okMark("VOLUME", `${ve.toFixed(1)}x`)); }
    else if (ve < 0.8) { score -= 1; marks.push(badMark("VOLUME", `${ve.toFixed(1)}x weak`)); }
    else marks.push(neuMark("VOLUME", `${ve.toFixed(1)}x`));

    if (side === "LONG") {
        // 3. 4H
        if (envBias === 1) { score += 1; marks.push(okMark("4H_GMMA+POC", "bull confirmed")); }
        else if (envBias === 0) marks.push(badMark("4H_GMMA+POC", "neutral"));
        else marks.push(neuMark("4H_GMMA+POC", "bear weight vs long"));
        // 4. 30M
        if (g30.up) { score += 1; marks.push(okMark("30M_GMMA", "aligned up")); }
        else marks.push(badMark("30M_GMMA", "not up"));
        // 5. 5M
        if (g5.up) { score += 1; marks.push(okMark("5M_GMMA", "trigger up")); }
        else marks.push(neuMark("5M_GMMA", "not triggered"));
        // 6. DELTA
        if (dd.bull) { score += 2; marks.push(okMark("DELTA", "deltaDivBull")); }
        else marks.push(neuMark("DELTA", `d=${k.delta.toFixed(0)}`));
        // 7. ABSORPTION
        if (abs.bull) { score += 1; marks.push(okMark("ABSORPTION", "bull")); }
        else marks.push(neuMark("ABSORPTION", "none"));
        // 8. CVD
        if (cvd3 > 0 && cvd8 > 0) { score += 1; marks.push(okMark("CVD", `c3=${cvd3.toFixed(0)} c8=${cvd8.toFixed(0)}`)); }
        else marks.push(neuMark("CVD", `c3=${cvd3.toFixed(0)}`));
        // 9. CFD
        if (cShort || liqL) { score += 1; marks.push(okMark("CFD", `lsr=${lsr} oi=${oiCh.toFixed(3)}%`)); }
        else marks.push(neuMark("CFD", `lsr=${lsr}`));
    } else {
        if (envBias === -1) { score += 1; marks.push(okMark("4H_GMMA+POC", "bear confirmed")); }
        else if (envBias === 0) marks.push(badMark("4H_GMMA+POC", "neutral"));
        else marks.push(neuMark("4H_GMMA+POC", "bull weight vs short"));
        if (g30.down) { score += 1; marks.push(okMark("30M_GMMA", "aligned down")); }
        else marks.push(badMark("30M_GMMA", "not down"));
        if (g5.down) { score += 1; marks.push(okMark("5M_GMMA", "trigger down")); }
        else marks.push(neuMark("5M_GMMA", "not triggered"));
        if (dd.bear) { score += 2; marks.push(okMark("DELTA", "deltaDivBear")); }
        else marks.push(neuMark("DELTA", `d=${k.delta.toFixed(0)}`));
        if (abs.bear) { score += 1; marks.push(okMark("ABSORPTION", "bear")); }
        else marks.push(neuMark("ABSORPTION", "none"));
        if (cvd3 < 0 && cvd8 < 0) { score += 1; marks.push(okMark("CVD", `c3=${cvd3.toFixed(0)} c8=${cvd8.toFixed(0)}`)); }
        else marks.push(neuMark("CVD", `c3=${cvd3.toFixed(0)}`));
        if (cLong || liqS) { score += 1; marks.push(okMark("CFD", `lsr=${lsr} oi=${oiCh.toFixed(3)}%`)); }
        else marks.push(neuMark("CFD", `lsr=${lsr}`));
    }

    // SLIPPAGE warning
    const slip = ve > 3.0 ? "HIGH" : ve > 1.8 ? "MEDIUM" : "LOW";
    marks.push(slip === "HIGH" ? badMark("SLIPPAGE", slip) : slip === "MEDIUM" ? neuMark("SLIPPAGE", slip) : okMark("SLIPPAGE", slip));
    return { score, marks };
}

// ═══════════════════════════════════════════════
// ObserverScorer — 主类
// ═══════════════════════════════════════════════

export class ObserverScorer {
    static readonly SCORE_THRESHOLD = 4;
    static readonly EVAL_INTERVAL_MS = 60_000; // 每分钟评估一次

    current: ObserverSnapshot | null = null;
    activeBias: Direction = Direction.NEUTRAL;
    lastEvalTime: Date | null = null;

    // 引用 Binance 数据源
    private fetcher: BinanceDataFetcher | null = null;

    setFetcher(f: BinanceDataFetcher) { this.fetcher = f; }

    shouldEvaluate(now: Date): boolean {
        if (!this.lastEvalTime) return true;
        return now.getTime() - this.lastEvalTime.getTime() >= ObserverScorer.EVAL_INTERVAL_MS;
    }

    /** 双向评估 — 与 observer_v15 完全一致 */
    evaluate(now: Date): ObserverSnapshot | null {
        const f = this.fetcher;
        if (!f || !f.ready || !f.k5.length) return null;

        const k5 = f.k5, k30 = f.k30, k4h = f.k4h;
        const li = k5.length - 1, l30 = k30.length - 1, l4 = k4h.length - 1;
        if (li < 10 || l30 < 0 || l4 < 0) return null;

        const latest = k5[li];
        const CVD = cvdArr(k5);

        // 清除 GMMA 缓存 (数据变了)
        _gmmaCache.delete(k4h); _gmmaCache.delete(k30); _gmmaCache.delete(k5);

        // 4H 环境偏差: GMMA up + price > POC
        const g4 = gmmaState(k4h, l4), p4 = calcPOC(k4h, l4);
        const envBias = g4.up && k4h[l4].close > p4 && !g4.tangled ? 1
            : g4.down && k4h[l4].close < p4 && !g4.tangled ? -1 : 0;

        // 30M + 5M GMMA
        const g30 = gmmaState(k30, l30), g5 = gmmaState(k5, li);

        // 其他指标
        const ve = latest.volume / Math.max(1e-9, volAvg(k5, li));
        const sw = sweepSignal(k5, li);
        const dd = deltaDiv(k5, li);
        const ab = calcAbsorption(k5, li);
        const cvd3 = CVD[li] - CVD[Math.max(0, li - 3)];
        const cvd8 = CVD[li] - CVD[Math.max(0, li - 8)];
        const fr = f.latestFunding();
        const oiCh = f.latestOIChange();
        const ls = f.latestLS();

        const args = { g30, g5, ve, sweep: sw, dd, abs: ab, cvd3, cvd8, ls, fr, oiCh, k: latest, envBias };
        const L = scoreSide({ side: "LONG", ...args });
        const S = scoreSide({ side: "SHORT", ...args });
        const active = L.score === S.score ? Direction.NEUTRAL : L.score > S.score ? Direction.LONG : Direction.SHORT;

        this.activeBias = active;
        this.lastEvalTime = now;
        this.current = {
            timestamp: now,
            longResult: L, shortResult: S,
            activeBias: active,
            price: latest.close,
            fundingRate: fr, oiChange: oiCh,
            lsr: ls?.longShortRatio ?? null,
        };
        return this.current;
    }

    /** 获取当前活跃方向的得分 */
    get activeScore(): number {
        if (!this.current) return 0;
        if (this.activeBias === Direction.LONG) return this.current.longResult.score;
        if (this.activeBias === Direction.SHORT) return this.current.shortResult.score;
        return Math.max(this.current.longResult.score, this.current.shortResult.score);
    }

    /** 是否达到入場阈值 */
    get isConfirmed(): boolean { return this.activeScore >= ObserverScorer.SCORE_THRESHOLD; }

    /** 获取活跃方向的 sweep 信号 */
    get activeSweep(): SweepResult | null {
        if (!this.fetcher?.ready || !this.fetcher.k5.length) return null;
        return sweepSignal(this.fetcher.k5, this.fetcher.k5.length - 1);
    }
}

// ═══════════════════════════════════════════════
// FVGDetector (Fair Value Gap)
// ═══════════════════════════════════════════════

interface FVGZone {
    direction: Direction; upper: number; lower: number;
    timestamp: Date; candleIdx: number;
    isFilled: boolean; isRetested: boolean; engulfingConfirmed: boolean;
    fvgSize: number;
}

interface CandleRecord { o: number; h: number; l: number; c: number; v: number; }

export class FVGDetector {
    static readonly MIN_FVG_ATR_MULT = 0.1;
    static readonly FVG_EXPIRY = 30;
    static readonly MAX_FVGS = 20;

    private candles: CandleRecord[] = [];
    activeFVGs: FVGZone[] = [];
    private candleCount = 0;

    constructor(private atr: AdaptiveATR) {}

    feedCandle(now: Date, o: number, h: number, l: number, c: number, v = 0) {
        this.candleCount++;
        this.candles.push({ o, h, l, c, v });
        if (this.candles.length > 50) this.candles = this.candles.slice(-50);

        if (this.candles.length >= 3) this.detectFVG(now);
        this.updateFVGs(h, l);
        if (this.candles.length >= 2) this.checkEngulfing();
        this.expireFVGs();
    }

    private detectFVG(now: Date) {
        const c0 = this.candles[this.candles.length - 3];
        const c2 = this.candles[this.candles.length - 1];
        const minGap = this.atr.atrFast * FVGDetector.MIN_FVG_ATR_MULT;

        // Bullish FVG: c2.l > c0.h
        if (c2.l > c0.h && (c2.l - c0.h) >= minGap) {
            this.activeFVGs.push({ direction: Direction.LONG, upper: c2.l, lower: c0.h,
                timestamp: now, candleIdx: this.candleCount, isFilled: false,
                isRetested: false, engulfingConfirmed: false, fvgSize: c2.l - c0.h });
        }
        // Bearish FVG: c2.h < c0.l
        if (c2.h < c0.l && (c0.l - c2.h) >= minGap) {
            this.activeFVGs.push({ direction: Direction.SHORT, upper: c0.l, lower: c2.h,
                timestamp: now, candleIdx: this.candleCount, isFilled: false,
                isRetested: false, engulfingConfirmed: false, fvgSize: c0.l - c2.h });
        }
        if (this.activeFVGs.length > FVGDetector.MAX_FVGS) this.activeFVGs = this.activeFVGs.slice(-FVGDetector.MAX_FVGS);
    }

    private updateFVGs(high: number, low: number) {
        for (const fvg of this.activeFVGs) {
            if (fvg.isFilled) continue;
            if (fvg.direction === Direction.LONG) {
                if (low <= fvg.lower) fvg.isFilled = true;
                else if (low <= fvg.upper) fvg.isRetested = true;
            } else {
                if (high >= fvg.upper) fvg.isFilled = true;
                else if (high >= fvg.lower) fvg.isRetested = true;
            }
        }
    }

    private checkEngulfing() {
        const prev = this.candles[this.candles.length - 2];
        const curr = this.candles[this.candles.length - 1];
        const prevBodyTop = Math.max(prev.o, prev.c), prevBodyBot = Math.min(prev.o, prev.c);
        const currBodyTop = Math.max(curr.o, curr.c), currBodyBot = Math.min(curr.o, curr.c);

        for (const fvg of this.activeFVGs) {
            if (fvg.isFilled || !fvg.isRetested || fvg.engulfingConfirmed) continue;
            if (fvg.direction === Direction.LONG) {
                if (curr.c >= curr.o && curr.c > prev.h && currBodyBot <= prevBodyBot && currBodyTop >= prevBodyTop)
                    fvg.engulfingConfirmed = true;
            } else {
                if (curr.c < curr.o && curr.c < prev.l && currBodyTop >= prevBodyTop && currBodyBot <= prevBodyBot)
                    fvg.engulfingConfirmed = true;
            }
        }
    }

    private expireFVGs() {
        const cutoff = this.candleCount - FVGDetector.FVG_EXPIRY;
        this.activeFVGs = this.activeFVGs.filter(f => !f.isFilled && f.candleIdx > cutoff);
    }

    getConfirmedFVG(dir: Direction): FVGZone | null {
        return [...this.activeFVGs].reverse().find(f => f.direction === dir && f.isRetested && f.engulfingConfirmed && !f.isFilled) ?? null;
    }
    getRestestedFVG(dir: Direction): FVGZone | null {
        return [...this.activeFVGs].reverse().find(f => f.direction === dir && f.isRetested && !f.isFilled) ?? null;
    }
    getAnyFVG(dir: Direction): FVGZone | null {
        return [...this.activeFVGs].reverse().find(f => f.direction === dir && !f.isFilled) ?? null;
    }

    getOriginPrice(dir: Direction): number | null {
        const fvg = this.getConfirmedFVG(dir) || this.getRestestedFVG(dir) || this.getAnyFVG(dir);
        if (!fvg) return null;
        return dir === Direction.LONG ? fvg.lower : fvg.upper;
    }

    diagnose(dir: Direction): string {
        const c = this.getConfirmedFVG(dir);
        if (c) return `confirmed ${c.lower.toFixed(1)}-${c.upper.toFixed(1)}`;
        const r = this.getRestestedFVG(dir);
        if (r) return `retested ${r.lower.toFixed(1)}-${r.upper.toFixed(1)}`;
        const a = this.getAnyFVG(dir);
        if (a) return `active ${a.lower.toFixed(1)}-${a.upper.toFixed(1)}`;
        return `no ${dir} FVG`;
    }

    get stats() {
        const total = this.activeFVGs.length;
        const bull = this.activeFVGs.filter(f => f.direction === Direction.LONG).length;
        const bear = this.activeFVGs.filter(f => f.direction === Direction.SHORT).length;
        const retested = this.activeFVGs.filter(f => f.isRetested).length;
        const confirmed = this.activeFVGs.filter(f => f.engulfingConfirmed).length;
        return { total, bull, bear, retested, confirmed, candles: this.candleCount };
    }
}

// ═══════════════════════════════════════════════
// TimeGuardEngine
// ═══════════════════════════════════════════════

export class TimeGuardEngine {
    static readonly MAX_HOLD_MS = 3 * 3600_000;
    // UTC+8 分钟
    static readonly ASIA_START = 9 * 60; static readonly ASIA_END = 10 * 60 + 30;
    static readonly EURO_START = 15 * 60 + 15; static readonly EURO_END = 16 * 60;
    static readonly US_GOLDEN = 22 * 60 + 30;

    atr: AdaptiveATR;
    constructor(atr: AdaptiveATR) { this.atr = atr; }

    private utc8Min(d: Date): number {
        const h = (d.getUTCHours() + 8) % 24;
        return h * 60 + d.getUTCMinutes();
    }

    isEntryAllowed(now: Date): boolean {
        const m = this.utc8Min(now);
        if (m >= TimeGuardEngine.ASIA_START && m <= TimeGuardEngine.ASIA_END) return true;
        if (m >= TimeGuardEngine.EURO_START && m <= TimeGuardEngine.EURO_END) return true;
        if (Math.abs(m - TimeGuardEngine.US_GOLDEN) <= 15) return true;
        return false;
    }

    activeWindowName(now: Date): string {
        const m = this.utc8Min(now);
        if (m >= TimeGuardEngine.ASIA_START && m <= TimeGuardEngine.ASIA_END) return "ASIA_ENTRY";
        if (m >= TimeGuardEngine.EURO_START && m <= TimeGuardEngine.EURO_END) return "EURO_GOLDEN";
        if (Math.abs(m - TimeGuardEngine.US_GOLDEN) <= 15) return "US_GOLDEN";
        return "OUTSIDE";
    }

    shouldForceClose(entryTime: Date, now: Date): string | null {
        if (now.getTime() - entryTime.getTime() >= TimeGuardEngine.MAX_HOLD_MS) return "force_close_3h_expiry";
        // 亚盘12:00强平
        const entryM = this.utc8Min(entryTime);
        if (entryM >= TimeGuardEngine.ASIA_START && entryM <= TimeGuardEngine.ASIA_END) {
            if (this.utc8Min(now) >= 12 * 60) return "force_close_asia_deadline";
        }
        return null;
    }
}

// ═══════════════════════════════════════════════
// SignalAuditLog
// ═══════════════════════════════════════════════

export class SignalAuditLog {
    entries: SignalAuditEntry[] = [];
    private maxEntries: number;
    private nextId = 1;

    constructor(max = 10_000) { this.maxEntries = max; }

    log(type: SignalType, ts: Date, direction: string, price: number,
        market: MarketSnapshot, gateChain: GateChainRecord | null): SignalAuditEntry {
        const entry: SignalAuditEntry = {
            signalId: this.nextId++, signalType: type, timestamp: ts.toISOString(),
            direction, triggerPrice: price, market, gateChain,
        };
        this.entries.push(entry);
        if (this.entries.length > this.maxEntries) this.entries = this.entries.slice(-this.maxEntries);
        return entry;
    }

    get count(): number { return this.entries.length; }

    /** 诊断报告 */
    report(): string {
        const byType = new Map<string, { total: number; passed: number; gatesPassed: number; gatesTotal: number }>();
        const gateStats = new Map<string, { evaluated: number; rejected: number; firstReject: number }>();

        for (const e of this.entries) {
            if (!e.gateChain) continue;
            const st = byType.get(e.signalType) || { total: 0, passed: 0, gatesPassed: 0, gatesTotal: 0 };
            st.total++;
            const gates = e.gateChain.gates;
            const passCount = gates.filter(g => g.result === GateResult.PASS).length;
            const hasReject = gates.some(g => g.result === GateResult.REJECT);
            if (!hasReject) st.passed++;
            st.gatesPassed += passCount; st.gatesTotal += gates.length;
            byType.set(e.signalType, st);

            let firstFound = false;
            for (const g of gates) {
                const gs = gateStats.get(g.gateName) || { evaluated: 0, rejected: 0, firstReject: 0 };
                gs.evaluated++;
                if (g.result === GateResult.REJECT) { gs.rejected++; if (!firstFound) { gs.firstReject++; firstFound = true; } }
                gateStats.set(g.gateName, gs);
            }
        }

        let r = `═ SIGNAL AUDIT (${this.count} signals) ═\n`;
        for (const [type, s] of byType) {
            r += `  ${type}: ${s.total} total, ${s.passed} passed (${s.total > 0 ? (s.passed / s.total * 100).toFixed(0) : 0}%)\n`;
        }
        r += `── Gate Bottlenecks ──\n`;
        const sorted = [...gateStats.entries()].sort((a, b) => (b[1].firstReject / (b[1].evaluated || 1)) - (a[1].firstReject / (a[1].evaluated || 1)));
        for (const [gate, s] of sorted) {
            r += `  ${gate}: eval=${s.evaluated} rej=${s.rejected} bottleneck=${(s.firstReject / (s.evaluated || 1) * 100).toFixed(0)}%\n`;
        }
        return r;
    }
}

// ═══════════════════════════════════════════════
// Gate Chain Helpers
// ═══════════════════════════════════════════════

function createChain(now: Date): GateChainRecord & { rejected: boolean; addGate: (name: string, result: GateResult, reason?: string, value?: string) => void } {
    const chain: GateChainRecord = { timestamp: now, gates: [], finalAction: "" };
    let rejected = false;
    return {
        ...chain,
        get rejected() { return rejected; },
        set rejected(v: boolean) { rejected = v; },
        addGate(name: string, result: GateResult, reason = "", value?: string) {
            chain.gates.push({ gateName: name, result, reason, value });
            if (result === GateResult.REJECT) rejected = true;
        },
        get gates() { return chain.gates; },
        set gates(v) { chain.gates = v; },
        get timestamp() { return chain.timestamp; },
        get finalAction() { return chain.finalAction; },
        set finalAction(v: string) { chain.finalAction = v; },
    };
}

function firstRejection(chain: GateChainRecord): GateEvaluation | null {
    return chain.gates.find(g => g.result === GateResult.REJECT) || null;
}
function passCount(chain: GateChainRecord): number {
    return chain.gates.filter(g => g.result === GateResult.PASS).length;
}

// ═══════════════════════════════════════════════
// MAIN: ETHOrderFlowBot v3
// ═══════════════════════════════════════════════

export interface TickInput {
    now: Date;
    open: number; close: number; high: number; low: number; volume: number;
    // From WS
    cvd: number;
    poc: number; vah: number; val: number;
    absorptionDetected: boolean; absorptionSide: string;
    // Optional
    fvgOrigin?: number;
    trendlinePrice?: number;
    predictedClose?: number;
}

export interface ActiveTrade {
    entryPrice: number; direction: Direction; entryTime: Date;
    stopLoss: number; size: number; leverageUsed: number; isPaper: boolean;
    windowName: string;
    // TP
    takeProfit: number | null; tpRatio: number;
    // Trailing stop
    initialStop: number; bestPrice: number;
    trailingActive: boolean; stopMovedToBreakeven: boolean;
}

export class ETHOrderFlowBot {
    static readonly LEVERAGE_HARD_CAP = 150;

    atr = new AdaptiveATR();
    slippage = new SlippageTracker();
    coldStart = new ColdStartManager();
    storyline = new StorylineEngine();
    fourHour: FourHourObserver;
    resonance = new ResonanceScorer();
    observer = new ObserverScorer();
    stopLoss: StopLossEngine;
    kelly = new KellyRiskManager();
    timeGuard: TimeGuardEngine;
    fvg: FVGDetector;

    activeTrade: ActiveTrade | null = null;
    dailyTrades = 0;
    audit = new SignalAuditLog();
    lastGateChain: GateChainRecord | null = null;

    // VA from WS
    private wsVA: ValueArea | null = null;

    constructor(public capital: number) {
        this.fourHour = new FourHourObserver(this.storyline);
        this.stopLoss = new StopLossEngine(capital, this.atr, this.slippage);
        this.timeGuard = new TimeGuardEngine(this.atr);
        this.fvg = new FVGDetector(this.atr);
    }

    feedCandle(high: number, low: number, close: number) { this.atr.update(high, low, close); }

    /** 从 WS 更新 VA 数据 */
    updateVA(vah: number, val: number, poc: number) {
        if (vah > 0 && val > 0) {
            this.wsVA = { vah, val, poc, totalVolume: 0, isFresh: true };
        }
    }

    private buildMarketSnapshot(inp: TickInput): MarketSnapshot {
        return {
            atr7: this.atr.atrFast, atr21: this.atr.atrSlow, atr14: this.atr.atr14,
            volRegime: this.atr.regime, cvd: inp.cvd,
            open: inp.open, high: inp.high, low: inp.low, close: inp.close, volume: inp.volume,
            poc: inp.poc, fcrVah: inp.vah, fcrVal: inp.val, fcrPoc: inp.poc,
        };
    }

    /**
     * 🎯 MAIN TICK — 11-gate evaluation with full audit
     * Returns action string or null
     */
    tick(inp: TickInput): string | null {
        const { now, open, close, high, low, volume, cvd, poc, vah, val } = inp;

        // Update VA from tick data
        if (vah > 0 && val > 0) this.updateVA(vah, val, poc);

        // ── MANAGE OPEN POSITION ──
        if (this.activeTrade) {
            const t = this.activeTrade;
            // 1. Time guard
            const forceClose = this.timeGuard.shouldForceClose(t.entryTime, now);
            if (forceClose) return `CLOSE: ${forceClose}`;
            // 2. TP hit
            if (t.takeProfit !== null) {
                if (t.direction === Direction.LONG && high >= t.takeProfit) return `CLOSE: tp_hit TP=${t.takeProfit.toFixed(2)} RR=${t.tpRatio.toFixed(0)}:1`;
                if (t.direction === Direction.SHORT && low <= t.takeProfit) return `CLOSE: tp_hit TP=${t.takeProfit.toFixed(2)} RR=${t.tpRatio.toFixed(0)}:1`;
            }
            // 3. Update trailing stop
            this.stopLoss.updateTrailingStop(t, high, low);
            // 4. Stop/trailing hit
            if (t.direction === Direction.LONG && low <= t.stopLoss) {
                return `CLOSE: ${t.trailingActive ? 'trailing_stop' : 'stop_loss'}_hit SL=${t.stopLoss.toFixed(2)}`;
            }
            if (t.direction === Direction.SHORT && high >= t.stopLoss) {
                return `CLOSE: ${t.trailingActive ? 'trailing_stop' : 'stop_loss'}_hit SL=${t.stopLoss.toFixed(2)}`;
            }
            // 5. Predicted close
            if (inp.predictedClose !== undefined) {
                const tol = this.atr.atr14 * 0.20;
                if (Math.abs(close - inp.predictedClose) <= tol) return "CLOSE: predicted_close_reached";
            }
            // 6. Exhaustion
            if (this.storyline.shouldProtectProfit()) return "CLOSE: exhaustion_protection";
            return null;
        }

        // ── 4H OBSERVER ──
        const h4Result = this.fourHour.update(now, high, low, close, volume);

        // ── RESONANCE DATA (legacy) ──
        this.resonance.updateData(now, close, volume, cvd);

        // ── FVG DETECTION ──
        this.fvg.feedCandle(now, open, high, low, close, volume);

        // ── OBSERVER v15 EVALUATION (每分钟) ──
        if (this.observer.shouldEvaluate(now)) {
            this.observer.evaluate(now);
        }

        // ── BUILD GATE CHAIN ──
        const chain = createChain(now);

        // Gate 0: 4H bias
        if (!chain.rejected) {
            if (this.storyline.is4hAligned()) {
                let v = `4H=${this.storyline.intradayBias}`;
                if (h4Result) v += `,conf=${h4Result.confidence.toFixed(2)}`;
                chain.addGate("4h_bias", GateResult.PASS, "", v);
            } else {
                chain.addGate("4h_bias", GateResult.REJECT,
                    `4H=${this.storyline.intradayBias} contradicts W=${this.storyline.weeklyDirection}`,
                    `4H=${this.storyline.intradayBias}`);
            }
        }

        // Gate 1: Walk-3-Rest-1
        if (!chain.rejected) {
            if (this.kelly.shouldShutdown()) chain.addGate("walk_3_rest_1", GateResult.REJECT, "3 consecutive wins");
            else chain.addGate("walk_3_rest_1", GateResult.PASS, "", `${this.kelly.dailyConsecWins}`);
        } else chain.addGate("walk_3_rest_1", GateResult.SKIP, "upstream");

        // Gate 2: Time window
        if (!chain.rejected) {
            if (this.timeGuard.isEntryAllowed(now)) chain.addGate("time_window", GateResult.PASS, "", this.timeGuard.activeWindowName(now));
            else chain.addGate("time_window", GateResult.REJECT, "outside golden window");
        } else chain.addGate("time_window", GateResult.SKIP, "upstream");

        // Gate 3: Kelly edge
        if (!chain.rejected) {
            const totalT = this.kelly.winCount + this.kelly.lossCount;
            if (this.coldStart.phase === BotPhase.PHASE_2 && totalT >= 10) {
                if (this.kelly.hasEdge()) chain.addGate("kelly_edge", GateResult.PASS, "", `f*=${this.kelly.kellyFraction().toFixed(4)}`);
                else { chain.addGate("kelly_edge", GateResult.REJECT, "no edge"); }
            } else chain.addGate("kelly_edge", GateResult.SKIP, `phase=${this.coldStart.phase},trades=${totalT}`);
        } else chain.addGate("kelly_edge", GateResult.SKIP, "upstream");

        // Gate 4: Storyline alignment
        const bias = this.storyline.getBias();
        if (!chain.rejected) {
            if (bias !== Direction.NEUTRAL) chain.addGate("storyline_align", GateResult.PASS, "",
                `W=${this.storyline.weeklyDirection},D=${this.storyline.dailyDirection},4H=${this.storyline.intradayBias}`);
            else chain.addGate("storyline_align", GateResult.REJECT, "MTF not aligned");
        } else chain.addGate("storyline_align", GateResult.SKIP, "upstream");

        // Gate 5: Exhaustion
        if (!chain.rejected) {
            if (this.storyline.shouldProtectProfit()) chain.addGate("exhaustion_check", GateResult.REJECT, "exhaustion active");
            else chain.addGate("exhaustion_check", GateResult.PASS);
        } else chain.addGate("exhaustion_check", GateResult.SKIP, "upstream");

        // Gate 6: Observer v15 Score (8-Layer dual)
        let entryDir: Direction | null = null;
        if (!chain.rejected) {
            const obs = this.observer.current;
            if (obs) {
                const lScore = obs.longResult.score, sScore = obs.shortResult.score;
                const detail = `${this.observer.activeBias} L=${lScore}/8 S=${sScore}/8 FR=${obs.fundingRate.toFixed(5)}`;
                if (this.observer.isConfirmed && this.observer.activeBias !== Direction.NEUTRAL) {
                    entryDir = this.observer.activeBias;
                    chain.addGate("observer_score", GateResult.PASS, "", detail);
                } else {
                    chain.addGate("observer_score", GateResult.REJECT, `best=${this.observer.activeScore}/8 (need ${ObserverScorer.SCORE_THRESHOLD}) ${detail}`);
                }
            } else chain.addGate("observer_score", GateResult.SKIP, "no eval yet (waiting for Binance data)");
        } else chain.addGate("observer_score", GateResult.SKIP, "upstream");

        // Gate 7: Liquidity Sweep (replaces trap reversal)
        let sweepDir: Direction | null = null;
        if (!chain.rejected && entryDir) {
            const sw = this.observer.activeSweep;
            if (sw) {
                sweepDir = sw.dir === "LONG" ? Direction.LONG : Direction.SHORT;
                chain.addGate("liquidity_sweep", GateResult.PASS, "", `${sw.dir} str=${sw.strength} level=${sw.level.toFixed(1)}`);
            } else {
                // Sweep 是加分项但不是死门槛 — 如果 observer score >= 5 可以跳过
                if (this.observer.activeScore >= 5) {
                    sweepDir = entryDir;
                    chain.addGate("liquidity_sweep", GateResult.PASS, "", `no sweep but score≥5, using observer dir=${entryDir}`);
                } else {
                    chain.addGate("liquidity_sweep", GateResult.REJECT, "no sweep signal and score<5");
                }
            }
        } else chain.addGate("liquidity_sweep", GateResult.SKIP, "upstream");

        // Gate 8: Direction consistency (sweep vs observer)
        let trapDir = sweepDir;
        if (!chain.rejected && trapDir && entryDir) {
            if (trapDir === entryDir) {
                chain.addGate("direction_match", GateResult.PASS, "", `sweep=${trapDir},observer=${entryDir}`);
            } else {
                // Sweep 方向和 observer 不一致 → 用 observer 的
                trapDir = entryDir;
                chain.addGate("direction_match", GateResult.PASS, "", `override: sweep=${sweepDir}→observer=${entryDir}`);
            }
        } else chain.addGate("direction_match", GateResult.SKIP, "upstream");

        // Gate 10: Confluence (optional)
        if (!chain.rejected) chain.addGate("confluence", GateResult.SKIP, "optional");
        else chain.addGate("confluence", GateResult.SKIP, "upstream");

        // Gate 11: FVG (internal detector + fallback to external)
        let fvgOriginPrice: number | null = null;
        if (!chain.rejected && trapDir) {
            const confirmedFvg = this.fvg.getConfirmedFVG(trapDir);
            const retestedFvg = this.fvg.getRestestedFVG(trapDir);
            const anyFvg = this.fvg.getAnyFVG(trapDir);
            if (confirmedFvg) {
                fvgOriginPrice = trapDir === Direction.LONG ? confirmedFvg.lower : confirmedFvg.upper;
                chain.addGate("fvg_confirmed", GateResult.PASS, "", `confirmed ${confirmedFvg.lower.toFixed(1)}-${confirmedFvg.upper.toFixed(1)}`);
            } else if (retestedFvg) {
                fvgOriginPrice = trapDir === Direction.LONG ? retestedFvg.lower : retestedFvg.upper;
                chain.addGate("fvg_confirmed", GateResult.PASS, "", `retested ${retestedFvg.lower.toFixed(1)}-${retestedFvg.upper.toFixed(1)}`);
            } else if (anyFvg) {
                fvgOriginPrice = trapDir === Direction.LONG ? anyFvg.lower : anyFvg.upper;
                chain.addGate("fvg_confirmed", GateResult.PASS, "", `active ${anyFvg.lower.toFixed(1)}-${anyFvg.upper.toFixed(1)}`);
            } else if (inp.fvgOrigin !== undefined) {
                fvgOriginPrice = inp.fvgOrigin;
                chain.addGate("fvg_confirmed", GateResult.PASS, "", `external=${inp.fvgOrigin.toFixed(1)}`);
            } else {
                chain.addGate("fvg_confirmed", GateResult.REJECT, this.fvg.diagnose(trapDir));
            }
        } else chain.addGate("fvg_confirmed", GateResult.SKIP, "upstream");

        // Gate 12: Position size
        let direction = trapDir; let dynLeverage = 0; let stopPrice = 0; let size = 0;
        if (!chain.rejected && direction && fvgOriginPrice !== null) {
            dynLeverage = this.atr.maxLeverage(close, StopLossEngine.MAX_RISK_PCT, StopLossEngine.SL_ATR_MULT, ETHOrderFlowBot.LEVERAGE_HARD_CAP);
            stopPrice = this.stopLoss.computeStopPrice(close, direction, fvgOriginPrice);
            size = this.stopLoss.computePositionSize(close, stopPrice, dynLeverage, this.coldStart.sizeScale);
            if (size > 0 || this.coldStart.isPaper) chain.addGate("position_size", GateResult.PASS, "", `size=${size.toFixed(4)},lev=${dynLeverage.toFixed(1)}x`);
            else chain.addGate("position_size", GateResult.REJECT, "size<=0");
        } else chain.addGate("position_size", GateResult.SKIP, "upstream");

        // ── FINAL ACTION ──
        let action: string | null = null;
        if (chain.rejected) {
            const rej = firstRejection(chain);
            if (rej) action = `BLOCKED: ${rej.gateName} → ${rej.reason}`;
        } else if (direction) {
            const isPaper = this.coldStart.isPaper;
            const tpRatio = 2.0;
            const tpPrice = this.stopLoss.computeTP(close, stopPrice, direction, tpRatio);
            this.activeTrade = {
                entryPrice: close, direction, entryTime: now, stopLoss: stopPrice,
                size: isPaper ? 0 : size, leverageUsed: dynLeverage, isPaper,
                windowName: this.timeGuard.activeWindowName(now),
                takeProfit: tpPrice, tpRatio,
                initialStop: stopPrice, bestPrice: close,
                trailingActive: false, stopMovedToBreakeven: false,
            };
            this.dailyTrades++;
            action = `${isPaper ? "[PAPER] " : ""}ENTRY: ${direction} @ ${close.toFixed(2)} | ` +
                `SL=${stopPrice.toFixed(2)} | TP=${tpPrice.toFixed(2)} (${tpRatio.toFixed(0)}:1) | ` +
                `Size=${size.toFixed(4)} | Lev=${dynLeverage.toFixed(1)}x | ` +
                `Tier=${this.stopLoss.getCurrentTier().name} | Phase=${this.coldStart.phase} | Vol=${this.atr.regime}`;
        }

        chain.finalAction = action || "NO_SIGNAL";

        // ── LOG TO AUDIT ──
        const mkt = this.buildMarketSnapshot(inp);
        this.audit.log(SignalType.TRAP_REVERSAL, now, direction?.toString() ?? bias.toString(), close, mkt, chain);
        this.lastGateChain = chain;

        return action;
    }

    /** 记录平仓 */
    closeTrade(exitPrice: number, pnl: number) {
        if (!this.activeTrade) return;
        this.stopLoss.recordResult(pnl > 0);
        this.kelly.recordTrade(pnl);
        this.coldStart.recordTrade(this.kelly.winCount, this.kelly.lossCount, this.kelly.kellyFraction());
        this.activeTrade = null;
    }

    /** 状态摘要 */
    status(): Record<string, any> {
        const last = this.lastGateChain;
        const h4 = this.fourHour.lastAssessment;
        const rej = last ? firstRejection(last) : null;
        return {
            phase: this.coldStart.phase,
            totalSignals: this.audit.count,
            atrFast: this.atr.atrFast.toFixed(2),
            atrSlow: this.atr.atrSlow.toFixed(2),
            volRegime: this.atr.regime,
            dynLeverage: this.atr.closes.length ? this.atr.maxLeverage(this.atr.closes[this.atr.closes.length - 1]).toFixed(1) + "x" : "N/A",
            tier: this.stopLoss.getCurrentTier().name,
            kelly: this.kelly.kellyFraction().toFixed(4),
            slippage: (this.slippage.avgSlippagePct * 100).toFixed(2) + "%",
            consecWins: this.kelly.dailyConsecWins,
            bias: this.storyline.getBias(),
            h4Bias: this.storyline.intradayBias,
            h4Conf: h4 ? h4.confidence.toFixed(2) : "N/A",
            resonance: this.resonance.current ? `${this.resonance.current.confirmCount}/7` : "N/A",
            observer: this.observer.current ? `L=${this.observer.current.longResult.score}/8 S=${this.observer.current.shortResult.score}/8 → ${this.observer.activeBias}` : "N/A",
            lastGates: last ? `${passCount(last)}/${last.gates.length}` : "N/A",
            lastReject: rej ? `${rej.gateName}: ${rej.reason}` : "none",
        };
    }

    /** Telegram 格式状态 */
    statusTG(): string {
        const s = this.status();
        return `🧠 V3 Order Flow Bot\n` +
            `──────────\n` +
            `📊 ATR: ${s.atrFast}/${s.atrSlow} | ${s.volRegime}\n` +
            `📏 Lev: ${s.dynLeverage} | Tier: ${s.tier}\n` +
            `📈 Bias: ${s.bias} | 4H: ${s.h4Bias}\n` +
            `🔮 Observer: ${s.observer}\n` +
            `🔗 Gates: ${s.lastGates} | Reject: ${s.lastReject}\n` +
            `📊 Kelly: ${s.kelly} | Phase: ${s.phase}\n` +
            `📋 Signals: ${s.totalSignals} | Wins: ${this.kelly.dailyConsecWins}`;
    }
}
