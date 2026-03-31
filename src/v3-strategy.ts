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

    shouldProtectProfit(): boolean { return this.exhaustionActive; }
    setExhaustion(active: boolean) { this.exhaustionActive = active; }
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
    static readonly CONFIRM_THRESHOLD = 5;
    static readonly EVAL_INTERVAL_MS = 15 * 60_000;

    snapshots: ResonanceSnapshot[] = [];
    lastEvalTime: Date | null = null;
    current: ResonanceSnapshot | null = null;

    // VWAP
    private vwapNum = 0; private vwapDen = 0; private lastDay = -1;
    // Volume
    private volHistory: number[] = [];
    // Slopes
    private cvdHistory: { ts: number; val: number }[] = [];
    private priceHistory: { ts: number; val: number }[] = [];

    updateData(now: Date, price: number, volume: number, cvd: number) {
        if (this.lastDay >= 0 && now.getUTCDate() !== this.lastDay) { this.vwapNum = 0; this.vwapDen = 0; }
        this.lastDay = now.getUTCDate();
        this.vwapNum += price * volume; this.vwapDen += volume;
        this.volHistory.push(volume); if (this.volHistory.length > 100) this.volHistory.shift();
        const ts = now.getTime();
        this.cvdHistory.push({ ts, val: cvd }); if (this.cvdHistory.length > 30) this.cvdHistory.shift();
        this.priceHistory.push({ ts, val: price }); if (this.priceHistory.length > 30) this.priceHistory.shift();
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

        // D2: CVD vs Price
        const cvdS = this.slope(this.cvdHistory), priceS = this.slope(this.priceHistory);
        const cvdOk = isLong ? cvdS > 0 : cvdS < 0;
        const priceOk = isLong ? priceS > 0 : priceS < 0;
        dims.push({ name: "CVD_PRICE", score: cvdOk && priceOk ? 1 : cvdOk !== priceOk ? 0 : -1,
            detail: `cvd=${cvdS.toFixed(1)} price=${priceS.toFixed(1)}` });

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
}

export class ETHOrderFlowBot {
    static readonly LEVERAGE_HARD_CAP = 150;

    atr = new AdaptiveATR();
    slippage = new SlippageTracker();
    coldStart = new ColdStartManager();
    storyline = new StorylineEngine();
    fourHour: FourHourObserver;
    resonance = new ResonanceScorer();
    stopLoss: StopLossEngine;
    kelly = new KellyRiskManager();
    timeGuard: TimeGuardEngine;

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
            const forceClose = this.timeGuard.shouldForceClose(this.activeTrade.entryTime, now);
            if (forceClose) return `CLOSE: ${forceClose}`;
            if (this.storyline.shouldProtectProfit()) return "CLOSE: exhaustion_protection";
            if (inp.predictedClose !== undefined) {
                const tol = this.atr.atr14 * 0.20;
                if (Math.abs(close - inp.predictedClose) <= tol) return "CLOSE: predicted_close_reached";
            }
            return null;
        }

        // ── 4H OBSERVER ──
        const h4Result = this.fourHour.update(now, high, low, close, volume);

        // ── RESONANCE DATA ──
        this.resonance.updateData(now, close, volume, cvd);

        // ── RESONANCE EVALUATION ──
        const biasForRes = this.storyline.getBias();
        if (biasForRes !== Direction.NEUTRAL && this.resonance.shouldEvaluate(now)) {
            const absDir = inp.absorptionDetected
                ? (inp.absorptionSide === "buy" ? Direction.SHORT : Direction.LONG) : null;
            const pocMig = this.storyline.pocIsMigrating(biasForRes);
            const pocMigOpp = this.storyline.pocIsMigrating(biasForRes === Direction.LONG ? Direction.SHORT : Direction.LONG);
            this.resonance.evaluate(now, biasForRes, close, volume,
                this.fourHour.lastAssessment, pocMig, biasForRes,
                absDir, this.wsVA, [], this.atr.atrFast);
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

        // Gate 6: Resonance ≥5/7
        if (!chain.rejected) {
            const rs = this.resonance.current;
            if (rs) {
                if (rs.passed) chain.addGate("resonance", GateResult.PASS, "", `${rs.confirmCount}/7`);
                else chain.addGate("resonance", GateResult.REJECT, `only ${rs.confirmCount}/7 (need ${rs.threshold})`);
            } else chain.addGate("resonance", GateResult.SKIP, "no eval yet");
        } else chain.addGate("resonance", GateResult.SKIP, "upstream");

        // Gate 7: VA exists
        const va = this.wsVA;
        if (!chain.rejected) {
            if (va) chain.addGate("fcr_va_exists", GateResult.PASS, "", `VAH=${va.vah.toFixed(1)},VAL=${va.val.toFixed(1)}`);
            else chain.addGate("fcr_va_exists", GateResult.REJECT, "no VA");
        } else chain.addGate("fcr_va_exists", GateResult.SKIP, "upstream");

        // Gate 8: Trap reversal
        let trapDir: Direction | null = null;
        if (!chain.rejected && va) {
            const maxPierce = this.atr.atrFast * 0.5;
            if (low < va.val && close > va.val && va.val - low < maxPierce) trapDir = Direction.LONG;
            else if (high > va.vah && close < va.vah && high - va.vah < maxPierce) trapDir = Direction.SHORT;

            if (trapDir) chain.addGate("trap_reversal", GateResult.PASS, "", `dir=${trapDir}`);
            else {
                // Diagnose
                const pierceBelow = Math.max(0, va.val - low), pierceAbove = Math.max(0, high - va.vah);
                let reason = "no VA edge pierce";
                if (pierceBelow > maxPierce || pierceAbove > maxPierce) reason = `pierce too deep`;
                else if (pierceBelow > 0 && close < va.val) reason = "close below VAL";
                else if (pierceAbove > 0 && close > va.vah) reason = "close above VAH";
                chain.addGate("trap_reversal", GateResult.REJECT, reason);
            }
        } else chain.addGate("trap_reversal", GateResult.SKIP, "upstream");

        // Gate 9: Direction match
        if (!chain.rejected && trapDir) {
            if (trapDir === bias) chain.addGate("direction_match", GateResult.PASS, "", `trap=${trapDir},bias=${bias}`);
            else chain.addGate("direction_match", GateResult.REJECT, `trap=${trapDir} vs bias=${bias}`);
        } else chain.addGate("direction_match", GateResult.SKIP, "upstream");

        // Gate 10: Confluence (optional)
        if (!chain.rejected) chain.addGate("confluence", GateResult.SKIP, "optional");
        else chain.addGate("confluence", GateResult.SKIP, "upstream");

        // Gate 11: FVG origin
        if (!chain.rejected) {
            if (inp.fvgOrigin !== undefined) chain.addGate("fvg_origin", GateResult.PASS, "", `origin=${inp.fvgOrigin.toFixed(2)}`);
            else chain.addGate("fvg_origin", GateResult.REJECT, "no FVG origin");
        } else chain.addGate("fvg_origin", GateResult.SKIP, "upstream");

        // Gate 12: Position size
        let direction = trapDir; let dynLeverage = 0; let stopPrice = 0; let size = 0;
        if (!chain.rejected && direction && inp.fvgOrigin !== undefined) {
            dynLeverage = this.atr.maxLeverage(close, StopLossEngine.MAX_RISK_PCT, StopLossEngine.SL_ATR_MULT, ETHOrderFlowBot.LEVERAGE_HARD_CAP);
            stopPrice = this.stopLoss.computeStopPrice(close, direction, inp.fvgOrigin);
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
            this.activeTrade = {
                entryPrice: close, direction, entryTime: now, stopLoss: stopPrice,
                size: isPaper ? 0 : size, leverageUsed: dynLeverage, isPaper,
                windowName: this.timeGuard.activeWindowName(now),
            };
            this.dailyTrades++;
            action = `${isPaper ? "[PAPER] " : ""}ENTRY: ${direction} @ ${close.toFixed(2)} | ` +
                `SL=${stopPrice.toFixed(2)} | Size=${size.toFixed(4)} | Lev=${dynLeverage.toFixed(1)}x | ` +
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
            `🔮 Resonance: ${s.resonance}\n` +
            `🔗 Gates: ${s.lastGates} | Reject: ${s.lastReject}\n` +
            `📊 Kelly: ${s.kelly} | Phase: ${s.phase}\n` +
            `📋 Signals: ${s.totalSignals} | Wins: ${this.kelly.dailyConsecWins}`;
    }
}
