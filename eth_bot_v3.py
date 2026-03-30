"""
ETH Perpetual Futures Bot v3 — Unified with Signal Audit
==========================================================
Exchange: Bitunix | Pair: ETHUSDT | Max Leverage: 150x

v3 = v2 adaptive calibration + signal audit layer INSIDE tick().

KEY CHANGE: tick() no longer short-circuits silently.
  - Every gate is evaluated and recorded in GateChainRecord.
  - Every signal detection logs a full 4-layer SignalAuditEntry.
  - Execution logic unchanged — same gates, same order, same outcome.
  - After any session, call bot.audit_report() to see diagnostics.

PARAMETER CHOICES (user-confirmed):
  - Dual ATR: fast ATR(7) + slow ATR(21)
  - Stop loss: 1.0 × ATR | Leverage hard cap: 150x
  - Absorption: base_ratio × (ATR_14 / ATR_50)
  - VA pierce depth: < 0.5 × ATR
  - Predicted close tolerance: ATR(14) × 0.20

AUDIT LAYERS:
  L1: Signal identity   (type, time, direction, price)
  L2: Market snapshot    (ATR×3, vol_regime, CVD, OHLCV, POC, VA)
  L3: Orderbook snapshot (DOM top 10 bid/ask, aggressive vol, real walls)
  L4: Gate chain record  (11 gates, each pass/reject/skip + reason)
"""

from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Optional, List, Dict, Tuple, Deque, Any
from datetime import datetime, timedelta
from collections import deque, defaultdict
import json
import math


# ─────────────────────────────────────────────
# Shared Enums
# ─────────────────────────────────────────────

class Direction(Enum):
    LONG = auto()
    SHORT = auto()
    NEUTRAL = auto()

class VolRegime(Enum):
    EXPANDING = auto()
    CONTRACTING = auto()
    STABLE = auto()

class BotPhase(Enum):
    PHASE_0 = "paper_trading"
    PHASE_1 = "min_size_live"
    PHASE_2 = "normal_operation"

class SessionWindow(Enum):
    ASIA_NOISE    = "08:00-09:00"
    ASIA_ENTRY    = "09:00-10:30"
    ASIA_DEADLINE = "12:00"
    EURO_FLOW     = "15:15-16:00"
    US_ANCHOR     = "21:30-21:45"
    US_GOLDEN     = "22:30"

class DrawdownTier(Enum):
    TIER_0 = (1.0,  "Normal — full size")
    TIER_1 = (0.75, "1 consecutive loss — 75%")
    TIER_2 = (0.50, "2 consecutive losses — 50%")
    TIER_3 = (0.25, "3 consecutive losses — 25%")
    TIER_4 = (0.10, "4+ consecutive losses — survival 10%")
    def __init__(self, scale: float, desc: str):
        self.scale = scale
        self.desc = desc

class ExhaustionSignal(Enum):
    CLIMAX_CANDLE   = auto()
    EXHAUSTION_GAP  = auto()
    FINAL_FLAG      = auto()

class SignalType(Enum):
    ABSORPTION    = "absorption"
    TRAP_REVERSAL = "trap_reversal"
    REAL_WALL     = "real_wall"
    FAKE_WALL     = "fake_wall"
    EXHAUSTION    = "exhaustion"
    CONFLUENCE    = "confluence"
    POC_MIGRATION = "poc_migration"

class GateResult(Enum):
    PASS   = "pass"
    REJECT = "reject"
    SKIP   = "skip"


# ─────────────────────────────────────────────
# Shared Data Structures
# ─────────────────────────────────────────────

@dataclass
class ValueArea:
    vah: float
    val: float
    poc: float
    total_volume: float
    is_fresh: bool = True

@dataclass
class SNRLevel:
    price: float
    direction: Direction
    touch_count: int = 0
    is_fresh: bool = True
    body_based: bool = True
    trendline_confluence: bool = False

@dataclass
class WallReading:
    price: float
    size: float
    is_real: bool
    pull_count: int = 0
    test_count: int = 0

@dataclass
class TradeState:
    entry_price: float
    direction: Direction
    entry_time: datetime
    stop_loss: float
    take_profit: Optional[float] = None
    size: float = 0.0
    leverage_used: float = 0.0
    is_paper: bool = False
    pnl_unrealized: float = 0.0

@dataclass
class TradeRecord:
    entry_price: float
    exit_price: float
    direction: Direction
    pnl: float
    slippage: float
    fill_latency_ms: float
    leverage_used: float
    is_paper: bool
    timestamp: datetime = field(default_factory=datetime.now)


# ─────────────────────────────────────────────
# Audit Data Structures
# ─────────────────────────────────────────────

@dataclass
class DOMLevel:
    price: float
    size: float
    side: str  # "bid" or "ask"

@dataclass
class MarketSnapshot:
    atr_7: float
    atr_21: float
    atr_14: float
    vol_regime: str
    cvd: float
    candle_open: float
    candle_high: float
    candle_low: float
    candle_close: float
    candle_volume: float
    poc: float
    fcr_vah: float
    fcr_val: float
    fcr_poc: float

    def to_dict(self) -> dict:
        return {
            "atr_7": round(self.atr_7, 4),
            "atr_21": round(self.atr_21, 4),
            "atr_14": round(self.atr_14, 4),
            "vol_regime": self.vol_regime,
            "cvd": round(self.cvd, 2),
            "ohlcv": {
                "open": round(self.candle_open, 2),
                "high": round(self.candle_high, 2),
                "low": round(self.candle_low, 2),
                "close": round(self.candle_close, 2),
                "volume": round(self.candle_volume, 2),
            },
            "poc": round(self.poc, 2),
            "fcr_va": {
                "vah": round(self.fcr_vah, 2),
                "val": round(self.fcr_val, 2),
                "poc": round(self.fcr_poc, 2),
            },
        }

@dataclass
class OrderBookSnapshot:
    top_10_bids: List[DOMLevel]
    top_10_asks: List[DOMLevel]
    aggressive_buy_volume: float
    aggressive_sell_volume: float
    real_walls: List[Dict[str, Any]]

    def to_dict(self) -> dict:
        return {
            "bids": [{"price": round(l.price, 2),
                       "size": round(l.size, 4)}
                      for l in self.top_10_bids],
            "asks": [{"price": round(l.price, 2),
                       "size": round(l.size, 4)}
                      for l in self.top_10_asks],
            "aggressive_buy_vol": round(
                self.aggressive_buy_volume, 4),
            "aggressive_sell_vol": round(
                self.aggressive_sell_volume, 4),
            "real_walls": self.real_walls,
        }

@dataclass
class GateEvaluation:
    gate_name: str
    result: GateResult
    reason: str = ""
    value: Optional[str] = None

    def to_dict(self) -> dict:
        d = {"gate": self.gate_name, "result": self.result.value}
        if self.reason:
            d["reason"] = self.reason
        if self.value is not None:
            d["value"] = self.value
        return d

@dataclass
class GateChainRecord:
    timestamp: datetime
    gates: List[GateEvaluation] = field(default_factory=list)
    final_action: str = ""

    def add(self, gate_name: str, result: GateResult,
            reason: str = "", value: Optional[str] = None):
        self.gates.append(GateEvaluation(
            gate_name=gate_name, result=result,
            reason=reason, value=value))

    @property
    def passed_all(self) -> bool:
        return all(g.result != GateResult.REJECT for g in self.gates)

    @property
    def first_rejection(self) -> Optional[GateEvaluation]:
        for g in self.gates:
            if g.result == GateResult.REJECT:
                return g
        return None

    @property
    def pass_count(self) -> int:
        return sum(1 for g in self.gates
                   if g.result == GateResult.PASS)

    @property
    def total_gates(self) -> int:
        return len(self.gates)

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp.isoformat(),
            "gates": [g.to_dict() for g in self.gates],
            "passed_all": self.passed_all,
            "first_rejection": (self.first_rejection.to_dict()
                                if self.first_rejection else None),
            "pass_rate": f"{self.pass_count}/{self.total_gates}",
            "final_action": self.final_action,
        }

@dataclass
class SignalAuditEntry:
    signal_id: int
    signal_type: SignalType
    timestamp: datetime
    direction: str
    trigger_price: float
    market: MarketSnapshot
    orderbook: OrderBookSnapshot
    gate_chain: Optional[GateChainRecord] = None

    def to_dict(self) -> dict:
        return {
            "signal_id": self.signal_id,
            "signal_type": self.signal_type.value,
            "timestamp": self.timestamp.isoformat(),
            "direction": self.direction,
            "trigger_price": round(self.trigger_price, 2),
            "market_snapshot": self.market.to_dict(),
            "orderbook_snapshot": self.orderbook.to_dict(),
            "gate_chain": (self.gate_chain.to_dict()
                           if self.gate_chain else None),
        }

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent,
                          ensure_ascii=False)


# ─────────────────────────────────────────────
# Signal Audit Log
# ─────────────────────────────────────────────

class SignalAuditLog:
    def __init__(self, max_entries: int = 10_000):
        self.entries: List[SignalAuditEntry] = []
        self.max_entries = max_entries
        self._next_id: int = 1

    def log(self, signal_type: SignalType, timestamp: datetime,
            direction: str, trigger_price: float,
            market: MarketSnapshot, orderbook: OrderBookSnapshot,
            gate_chain: Optional[GateChainRecord] = None
            ) -> SignalAuditEntry:
        entry = SignalAuditEntry(
            signal_id=self._next_id,
            signal_type=signal_type,
            timestamp=timestamp, direction=direction,
            trigger_price=trigger_price,
            market=market, orderbook=orderbook,
            gate_chain=gate_chain)
        self.entries.append(entry)
        self._next_id += 1
        if len(self.entries) > self.max_entries:
            self.entries = self.entries[-self.max_entries:]
        return entry

    def get_by_type(self, t: SignalType) -> List[SignalAuditEntry]:
        return [e for e in self.entries if e.signal_type == t]

    def get_by_regime(self, r: str) -> List[SignalAuditEntry]:
        return [e for e in self.entries
                if e.market.vol_regime == r]

    def export_json(self, filepath: str):
        data = [e.to_dict() for e in self.entries]
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

    @property
    def count(self) -> int:
        return len(self.entries)


# ─────────────────────────────────────────────
# Signal Performance Analyzer
# ─────────────────────────────────────────────

class SignalPerformanceAnalyzer:
    def __init__(self, audit_log: SignalAuditLog):
        self.log = audit_log

    def signal_pass_rates(self) -> Dict[str, dict]:
        by_type: Dict[str, List[SignalAuditEntry]] = defaultdict(list)
        for e in self.log.entries:
            by_type[e.signal_type.value].append(e)
        results = {}
        for sig_type, entries in by_type.items():
            with_chain = [e for e in entries if e.gate_chain]
            passed = [e for e in with_chain
                      if e.gate_chain.passed_all]
            avg_pass = avg_total = 0.0
            if with_chain:
                avg_pass = sum(e.gate_chain.pass_count
                               for e in with_chain) / len(with_chain)
                avg_total = sum(e.gate_chain.total_gates
                                for e in with_chain) / len(with_chain)
            results[sig_type] = {
                "total": len(entries),
                "with_gate_chain": len(with_chain),
                "passed_all": len(passed),
                "pass_rate": (len(passed) / len(with_chain)
                              if with_chain else 0.0),
                "avg_gates_passed": f"{avg_pass:.1f}/{avg_total:.0f}",
            }
        return results

    def gate_rejection_frequency(self) -> Dict[str, dict]:
        gate_stats: Dict[str, Dict[str, int]] = defaultdict(
            lambda: {"evaluated": 0, "rejected": 0,
                     "first_reject": 0})
        for entry in self.log.entries:
            if not entry.gate_chain:
                continue
            first_found = False
            for g in entry.gate_chain.gates:
                stats = gate_stats[g.gate_name]
                stats["evaluated"] += 1
                if g.result == GateResult.REJECT:
                    stats["rejected"] += 1
                    if not first_found:
                        stats["first_reject"] += 1
                        first_found = True
        results = {}
        for gate, stats in gate_stats.items():
            ev = stats["evaluated"]
            results[gate] = {
                "times_evaluated": ev,
                "times_rejected": stats["rejected"],
                "times_first_rejection": stats["first_reject"],
                "rejection_rate": stats["rejected"] / ev if ev else 0,
                "bottleneck_rate": stats["first_reject"] / ev if ev else 0,
            }
        return dict(sorted(results.items(),
                           key=lambda x: x[1]["bottleneck_rate"],
                           reverse=True))

    def regime_distribution(self) -> Dict[str, dict]:
        by_regime: Dict[str, List[SignalAuditEntry]] = defaultdict(list)
        for e in self.log.entries:
            by_regime[e.market.vol_regime].append(e)
        results = {}
        for regime, entries in by_regime.items():
            type_counts: Dict[str, int] = defaultdict(int)
            for e in entries:
                type_counts[e.signal_type.value] += 1
            with_chain = [e for e in entries if e.gate_chain]
            passed = [e for e in with_chain
                      if e.gate_chain.passed_all]
            results[regime] = {
                "total_signals": len(entries),
                "by_type": dict(type_counts),
                "passed_all": len(passed),
                "pass_rate": (len(passed) / len(with_chain)
                              if with_chain else 0.0),
            }
        return results

    def full_report(self) -> dict:
        return {
            "total_signals": self.log.count,
            "signal_pass_rates": self.signal_pass_rates(),
            "gate_rejection_frequency": self.gate_rejection_frequency(),
            "regime_distribution": self.regime_distribution(),
        }

    def print_report(self):
        r = self.full_report()
        print("=" * 60)
        print(f"SIGNAL AUDIT REPORT — {r['total_signals']} signals")
        print("=" * 60)

        print("\n── Signal Pass Rates ──")
        for sig, s in r["signal_pass_rates"].items():
            print(f"  {sig:20s}  total={s['total']:4d}  "
                  f"passed={s['passed_all']:4d}  "
                  f"rate={s['pass_rate']:.1%}  "
                  f"avg_gates={s['avg_gates_passed']}")

        print("\n── Gate Bottleneck Analysis ──")
        for gate, s in r["gate_rejection_frequency"].items():
            print(f"  {gate:22s}  eval={s['times_evaluated']:4d}"
                  f"  rej={s['times_rejected']:4d}"
                  f"  bottleneck={s['bottleneck_rate']:.1%}")

        print("\n── Regime Distribution ──")
        for regime, s in r["regime_distribution"].items():
            print(f"  {regime:14s}  signals={s['total_signals']:4d}"
                  f"  passed={s['passed_all']:4d}"
                  f"  rate={s['pass_rate']:.1%}")
            for t, c in s["by_type"].items():
                print(f"    └─ {t}: {c}")
        print("=" * 60)


# ═══════════════════════════════════════════════
# AdaptiveATR
# ═══════════════════════════════════════════════

class AdaptiveATR:
    def __init__(self):
        self.highs: Deque[float] = deque(maxlen=50)
        self.lows: Deque[float] = deque(maxlen=50)
        self.closes: Deque[float] = deque(maxlen=50)
        self.tr_history: Deque[float] = deque(maxlen=50)

    def update(self, high: float, low: float, close: float):
        if len(self.closes) > 0:
            prev = self.closes[-1]
            tr = max(high - low, abs(high - prev), abs(low - prev))
        else:
            tr = high - low
        self.highs.append(high)
        self.lows.append(low)
        self.closes.append(close)
        self.tr_history.append(tr)

    def _atr(self, period: int) -> float:
        if len(self.tr_history) < period:
            return self.tr_history[-1] if self.tr_history else 0.0
        return sum(list(self.tr_history)[-period:]) / period

    @property
    def atr_fast(self) -> float:
        return self._atr(7)

    @property
    def atr_slow(self) -> float:
        return self._atr(21)

    @property
    def atr_14(self) -> float:
        return self._atr(14)

    @property
    def atr_50(self) -> float:
        return self._atr(50)

    @property
    def regime(self) -> VolRegime:
        fast, slow = self.atr_fast, self.atr_slow
        if slow == 0:
            return VolRegime.STABLE
        ratio = fast / slow
        if ratio > 1.10:
            return VolRegime.EXPANDING
        elif ratio < 0.90:
            return VolRegime.CONTRACTING
        return VolRegime.STABLE

    @property
    def vol_ratio_14_50(self) -> float:
        return self.atr_14 / self.atr_50 if self.atr_50 else 1.0

    def stop_distance(self, price: float,
                      multiplier: float = 1.0) -> float:
        return self.atr_fast * multiplier

    def max_leverage(self, price: float, risk_pct: float = 0.02,
                     sl_multiplier: float = 1.0,
                     hard_cap: int = 150) -> float:
        sd = self.stop_distance(price, sl_multiplier)
        if sd == 0 or price == 0:
            return float(hard_cap)
        return min(risk_pct / (sd / price), float(hard_cap))


# ═══════════════════════════════════════════════
# SlippageTracker
# ═══════════════════════════════════════════════

class SlippageTracker:
    def __init__(self, window: int = 100):
        self.records: Deque[Tuple[float, float]] = deque(maxlen=window)

    def record(self, expected: float, actual: float,
               latency_ms: float):
        self.records.append(
            (abs(actual - expected) / expected, latency_ms))

    @property
    def avg_slippage_pct(self) -> float:
        if not self.records:
            return 0.001
        return sum(s for s, _ in self.records) / len(self.records)

    @property
    def avg_latency_ms(self) -> float:
        if not self.records:
            return 200.0
        return sum(l for _, l in self.records) / len(self.records)

    @property
    def p95_slippage_pct(self) -> float:
        if len(self.records) < 5:
            return 0.002
        sl = sorted(s for s, _ in self.records)
        return sl[min(int(len(sl) * 0.95), len(sl) - 1)]

    def sample_count(self) -> int:
        return len(self.records)


# ═══════════════════════════════════════════════
# ColdStartManager
# ═══════════════════════════════════════════════

class ColdStartManager:
    PHASE_0_THRESHOLD = 50
    PHASE_1_THRESHOLD = 100
    MIN_WINRATE_ADVANCE = 0.40
    REGRESSION_WINRATE = 0.35

    def __init__(self):
        self.total_trades: int = 0
        self.phase: BotPhase = BotPhase.PHASE_0

    def record_trade(self, wins: int, losses: int, kelly_f: float):
        self.total_trades = wins + losses
        total = self.total_trades
        wr = wins / total if total > 0 else 0.0
        if wr < self.REGRESSION_WINRATE and total >= 20:
            if self.phase == BotPhase.PHASE_2:
                self.phase = BotPhase.PHASE_1
                return
            elif self.phase == BotPhase.PHASE_1:
                self.phase = BotPhase.PHASE_0
                return
        if self.phase == BotPhase.PHASE_0:
            if total >= self.PHASE_0_THRESHOLD \
               and wr >= self.MIN_WINRATE_ADVANCE:
                self.phase = BotPhase.PHASE_1
        elif self.phase == BotPhase.PHASE_1:
            if total >= self.PHASE_1_THRESHOLD and kelly_f > 0:
                self.phase = BotPhase.PHASE_2

    @property
    def is_paper(self) -> bool:
        return self.phase == BotPhase.PHASE_0

    @property
    def size_scale(self) -> float:
        if self.phase == BotPhase.PHASE_0:
            return 0.0
        elif self.phase == BotPhase.PHASE_1:
            return 0.10
        return 1.0


# ═══════════════════════════════════════════════
# MODULE 1 — StorylineEngine
# ═══════════════════════════════════════════════

class StorylineEngine:
    def __init__(self):
        self.weekly_direction: Direction = Direction.NEUTRAL
        self.daily_direction: Direction = Direction.NEUTRAL
        self.intraday_bias: Direction = Direction.NEUTRAL
        self.poc_history: List[Tuple[datetime, float]] = []
        self.exhaustion_signals: List[ExhaustionSignal] = []

    def update_mtf(self, weekly: Direction, daily: Direction):
        self.weekly_direction = weekly
        self.daily_direction = daily

    def update_intraday_bias(self, bias: Direction):
        self.intraday_bias = bias

    def is_aligned(self) -> bool:
        if self.weekly_direction == Direction.NEUTRAL:
            return False
        return self.weekly_direction == self.daily_direction

    def is_4h_aligned(self) -> bool:
        if self.intraday_bias == Direction.NEUTRAL:
            return True
        return self.intraday_bias == self.weekly_direction

    def get_bias(self) -> Direction:
        if not self.is_aligned():
            return Direction.NEUTRAL
        if not self.is_4h_aligned():
            return Direction.NEUTRAL
        return self.weekly_direction

    def track_poc(self, ts: datetime, poc: float):
        self.poc_history.append((ts, poc))

    def poc_is_migrating(self, direction: Direction,
                         lookback: int = 5) -> bool:
        if len(self.poc_history) < lookback:
            return False
        recent = [p for _, p in self.poc_history[-lookback:]]
        if direction == Direction.LONG:
            return all(recent[i] <= recent[i + 1]
                       for i in range(len(recent) - 1))
        elif direction == Direction.SHORT:
            return all(recent[i] >= recent[i + 1]
                       for i in range(len(recent) - 1))
        return False

    def detect_exhaustion(self, candle_range: float,
                          avg_range: float, volume: float,
                          avg_volume: float, has_gap: bool,
                          is_flag: bool) -> Optional[ExhaustionSignal]:
        if candle_range > avg_range * 2 and volume > avg_volume * 2.5:
            s = ExhaustionSignal.CLIMAX_CANDLE
            self.exhaustion_signals.append(s)
            return s
        if has_gap and volume > avg_volume * 1.5:
            s = ExhaustionSignal.EXHAUSTION_GAP
            self.exhaustion_signals.append(s)
            return s
        if is_flag and candle_range < avg_range * 0.4:
            s = ExhaustionSignal.FINAL_FLAG
            self.exhaustion_signals.append(s)
            return s
        return None

    def should_protect_profit(self) -> bool:
        return len(self.exhaustion_signals) > 0

    def clear_exhaustion(self):
        self.exhaustion_signals.clear()


# ═══════════════════════════════════════════════
# 4H Observation Layer
# Custom boundaries: 08:00 / 12:00 / 16:00 / 20:00 UTC+8
# ═══════════════════════════════════════════════

@dataclass
class FourHourCandle:
    boundary_start: int
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float
    poc: float
    is_bullish: bool

    @property
    def range(self) -> float:
        return self.high - self.low

    @property
    def body(self) -> float:
        return abs(self.close - self.open)

    @property
    def upper_wick_pct(self) -> float:
        if self.range == 0:
            return 0.0
        body_top = max(self.open, self.close)
        return (self.high - body_top) / self.range

    @property
    def lower_wick_pct(self) -> float:
        if self.range == 0:
            return 0.0
        body_bot = min(self.open, self.close)
        return (body_bot - self.low) / self.range


@dataclass
class FourHourAssessment:
    timestamp: datetime
    boundary: int
    bias: Direction
    confidence: float
    reasons: List[str]
    prev_candle: Optional[FourHourCandle]
    gap_size: float
    poc_migrating: bool
    poc_direction: Direction

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp.isoformat(),
            "boundary": f"{self.boundary:02d}:00",
            "bias": self.bias.name,
            "confidence": round(self.confidence, 2),
            "reasons": self.reasons,
            "gap_size": round(self.gap_size, 4),
            "poc_migrating": self.poc_migrating,
            "poc_direction": self.poc_direction.name,
            "prev_candle": {
                "ohlc": (f"O={self.prev_candle.open:.2f} "
                         f"H={self.prev_candle.high:.2f} "
                         f"L={self.prev_candle.low:.2f} "
                         f"C={self.prev_candle.close:.2f}"),
                "bullish": self.prev_candle.is_bullish,
                "range": round(self.prev_candle.range, 2),
            } if self.prev_candle else None,
        }


class FourHourObserver:
    BOUNDARIES = [8, 12, 16, 20]
    BIAS_THRESHOLD = 3

    def __init__(self, storyline: StorylineEngine):
        self.storyline = storyline
        self.completed_candles: List[FourHourCandle] = []
        self.assessments: List[FourHourAssessment] = []
        self._current_boundary: Optional[int] = None
        self._current_open: Optional[float] = None
        self._current_high: float = 0.0
        self._current_low: float = float('inf')
        self._current_volume: float = 0.0
        self._current_vwap_num: float = 0.0
        self._boundary_crossed: bool = False
        self._last_assessment: Optional[FourHourAssessment] = None

    def _get_boundary(self, hour: int) -> Optional[int]:
        for i, b in enumerate(self.BOUNDARIES):
            next_b = (self.BOUNDARIES[(i + 1) % len(self.BOUNDARIES)])
            if next_b <= b:
                if hour >= b or hour < next_b:
                    return b
            else:
                if b <= hour < next_b:
                    return b
        return self.BOUNDARIES[-1]

    def _close_current_candle(self, close: float,
                               timestamp: datetime) -> FourHourCandle:
        vol = max(self._current_volume, 1.0)
        poc = self._current_vwap_num / vol if vol > 0 else close
        candle = FourHourCandle(
            boundary_start=self._current_boundary or 0,
            timestamp=timestamp,
            open=self._current_open or close,
            high=self._current_high,
            low=self._current_low,
            close=close,
            volume=self._current_volume,
            poc=poc,
            is_bullish=close >= (self._current_open or close))
        self.completed_candles.append(candle)
        if len(self.completed_candles) > 12:
            self.completed_candles = self.completed_candles[-12:]
        return candle

    def _start_new_candle(self, boundary: int, open_price: float):
        self._current_boundary = boundary
        self._current_open = open_price
        self._current_high = open_price
        self._current_low = open_price
        self._current_volume = 0.0
        self._current_vwap_num = 0.0

    def _assess(self, now: datetime, boundary: int,
                current_open: float) -> FourHourAssessment:
        score = 0
        reasons = []
        prev = (self.completed_candles[-1]
                if self.completed_candles else None)

        if prev:
            if prev.is_bullish:
                score += 2
                reasons.append(f"prev_4H bullish (+{prev.body:.2f})")
            else:
                score -= 2
                reasons.append(f"prev_4H bearish (-{prev.body:.2f})")

        poc_dir = Direction.NEUTRAL
        poc_mig = False
        if len(self.completed_candles) >= 3:
            pocs = [c.poc for c in self.completed_candles[-3:]]
            if all(pocs[i] <= pocs[i+1] for i in range(len(pocs)-1)):
                score += 2
                poc_dir = Direction.LONG
                poc_mig = True
                reasons.append("POC migrating UP (3 candles)")
            elif all(pocs[i] >= pocs[i+1] for i in range(len(pocs)-1)):
                score -= 2
                poc_dir = Direction.SHORT
                poc_mig = True
                reasons.append("POC migrating DOWN (3 candles)")

        gap = 0.0
        if prev:
            gap = current_open - prev.close
            gap_pct = gap / prev.close if prev.close else 0
            if gap_pct > 0.001:
                score += 1
                reasons.append(f"gap UP +{gap:.2f}")
            elif gap_pct < -0.001:
                score -= 1
                reasons.append(f"gap DOWN {gap:.2f}")

        if prev and prev.range > 0:
            close_pct = ((prev.close - prev.low) / prev.range)
            if close_pct >= 0.75:
                score += 1
                reasons.append(f"prev close in upper 25% ({close_pct:.0%})")
            elif close_pct <= 0.25:
                score -= 1
                reasons.append(f"prev close in lower 25% ({close_pct:.0%})")

        if prev:
            if prev.upper_wick_pct > 0.40:
                score -= 1
                reasons.append(f"upper wick rejection ({prev.upper_wick_pct:.0%})")
            if prev.lower_wick_pct > 0.40:
                score += 1
                reasons.append(f"lower wick rejection ({prev.lower_wick_pct:.0%})")

        if score >= self.BIAS_THRESHOLD:
            bias = Direction.LONG
        elif score <= -self.BIAS_THRESHOLD:
            bias = Direction.SHORT
        else:
            bias = Direction.NEUTRAL

        confidence = min(abs(score) / 6.0, 1.0)

        assessment = FourHourAssessment(
            timestamp=now, boundary=boundary, bias=bias,
            confidence=confidence, reasons=reasons,
            prev_candle=prev, gap_size=gap,
            poc_migrating=poc_mig, poc_direction=poc_dir)

        self.assessments.append(assessment)
        if len(self.assessments) > 50:
            self.assessments = self.assessments[-50:]
        self._last_assessment = assessment
        return assessment

    def update(self, now: datetime, high: float, low: float,
               close: float, volume: float = 0.0
               ) -> Optional[FourHourAssessment]:
        boundary = self._get_boundary(now.hour)
        if self._current_boundary is not None:
            self._current_high = max(self._current_high, high)
            self._current_low = min(self._current_low, low)
            self._current_volume += volume
            mid = (high + low) / 2
            self._current_vwap_num += mid * volume
        if boundary != self._current_boundary:
            if self._current_boundary is not None:
                self._close_current_candle(close, now)
            assessment = self._assess(now, boundary, close)
            self.storyline.update_intraday_bias(assessment.bias)
            self._start_new_candle(boundary, close)
            return assessment
        else:
            if self._current_boundary is None:
                self._current_boundary = boundary
                self._current_open = close
                self._current_high = high
                self._current_low = low
        return None

    @property
    def last_assessment(self) -> Optional[FourHourAssessment]:
        return self._last_assessment

    @property
    def current_bias(self) -> Direction:
        if self._last_assessment:
            return self._last_assessment.bias
        return Direction.NEUTRAL


# ═══════════════════════════════════════════════
# RESONANCE SCORER
# 7-dimension confluence evaluator, every 15 min
# ═══════════════════════════════════════════════

@dataclass
class ResonanceDimension:
    name: str
    score: int
    detail: str
    def to_dict(self) -> dict:
        return {"name": self.name, "score": self.score, "detail": self.detail}

@dataclass
class ResonanceSnapshot:
    timestamp: datetime
    direction: Direction
    dimensions: List[ResonanceDimension]
    total_score: int
    confirm_count: int
    threshold: int
    passed: bool
    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp.isoformat(),
            "direction": self.direction.name,
            "dimensions": [d.to_dict() for d in self.dimensions],
            "total_score": self.total_score,
            "confirmations": f"{self.confirm_count}/7",
            "threshold": f"{self.threshold}/7",
            "passed": self.passed,
        }


class ResonanceScorer:
    CONFIRM_THRESHOLD = 5
    EVAL_INTERVAL_MIN = 15

    def __init__(self):
        self.snapshots: List[ResonanceSnapshot] = []
        self.last_eval_time: Optional[datetime] = None
        self._current: Optional[ResonanceSnapshot] = None
        self.vwap_num: float = 0.0
        self.vwap_den: float = 0.0
        self._last_day: Optional[int] = None
        self.vol_history: Deque[float] = deque(maxlen=100)
        self.cvd_history: Deque[Tuple[datetime, float]] = deque(maxlen=30)
        self.price_history: Deque[Tuple[datetime, float]] = deque(maxlen=30)

    def update(self, now: datetime, price: float, volume: float, cvd: float):
        if self._last_day is not None and now.day != self._last_day:
            self.vwap_num = 0.0
            self.vwap_den = 0.0
        self._last_day = now.day
        self.vwap_num += price * volume
        self.vwap_den += volume
        self.vol_history.append(volume)
        self.cvd_history.append((now, cvd))
        self.price_history.append((now, price))

    @property
    def vwap(self) -> float:
        return self.vwap_num / self.vwap_den if self.vwap_den > 0 else 0.0

    @property
    def avg_volume(self) -> float:
        return sum(self.vol_history) / len(self.vol_history) if self.vol_history else 0.0

    def _slope(self, hist: Deque, lookback: int = 10) -> float:
        if len(hist) < 2:
            return 0.0
        data = list(hist)[-lookback:]
        return data[-1][1] - data[0][1]

    def should_evaluate(self, now: datetime) -> bool:
        if self.last_eval_time is None:
            return True
        return (now - self.last_eval_time).total_seconds() >= self.EVAL_INTERVAL_MIN * 60

    def evaluate(self, now, direction, price, volume, storyline, four_hour, l2, battlefield):
        dims = []
        is_long = direction == Direction.LONG

        # D1: 4H Bias
        h4 = four_hour.last_assessment
        if h4 and h4.bias == direction and h4.confidence >= 0.5:
            dims.append(ResonanceDimension("4H_BIAS", +1, f"4H={h4.bias.name} conf={h4.confidence:.2f}"))
        elif h4 and h4.bias == Direction.NEUTRAL:
            dims.append(ResonanceDimension("4H_BIAS", 0, "4H=NEUTRAL"))
        elif h4 and h4.bias == direction and h4.confidence < 0.5:
            dims.append(ResonanceDimension("4H_BIAS", 0, f"4H={h4.bias.name} low conf={h4.confidence:.2f}"))
        else:
            dims.append(ResonanceDimension("4H_BIAS", -1, f"4H={h4.bias.name if h4 else 'N/A'} vs {direction.name}"))

        # D2: CVD vs Price
        cvd_s = self._slope(self.cvd_history)
        price_s = self._slope(self.price_history)
        cvd_ok = (cvd_s > 0) if is_long else (cvd_s < 0)
        price_ok = (price_s > 0) if is_long else (price_s < 0)
        if cvd_ok and price_ok:
            dims.append(ResonanceDimension("CVD_PRICE", +1, f"aligned cvd={cvd_s:+.1f} price={price_s:+.1f}"))
        elif cvd_ok != price_ok:
            dims.append(ResonanceDimension("CVD_PRICE", 0, f"diverge cvd={cvd_s:+.1f} price={price_s:+.1f}"))
        else:
            dims.append(ResonanceDimension("CVD_PRICE", -1, f"against cvd={cvd_s:+.1f} price={price_s:+.1f}"))

        # D3: Absorption
        abs_dir = l2.detect_absorption(price, l2.last_aggressive_buy_vol, l2.last_aggressive_sell_vol, price_s)
        if abs_dir == direction:
            dims.append(ResonanceDimension("ABSORPTION", +1, f"absorption -> {direction.name}"))
        elif abs_dir is None:
            dims.append(ResonanceDimension("ABSORPTION", 0, "none detected"))
        else:
            dims.append(ResonanceDimension("ABSORPTION", -1, f"absorption -> {abs_dir.name}"))

        # D4: Real wall at VA edge
        va = battlefield.fcr_value_area
        walls = l2.get_real_walls()
        wall_ok = False
        wall_detail = "no walls near VA"
        if va and walls:
            atr = l2.atr.atr_fast
            for w in walls:
                if is_long and abs(w.price - va.val) < atr * 0.3:
                    wall_ok = True
                    wall_detail = f"wall {w.price:.1f} near VAL {va.val:.1f}"
                    break
                if not is_long and abs(w.price - va.vah) < atr * 0.3:
                    wall_ok = True
                    wall_detail = f"wall {w.price:.1f} near VAH {va.vah:.1f}"
                    break
        dims.append(ResonanceDimension("WALL_POSITION", +1 if wall_ok else 0, wall_detail))

        # D5: POC Migration
        if storyline.poc_is_migrating(direction):
            dims.append(ResonanceDimension("POC_MIGRATION", +1, f"POC -> {direction.name}"))
        else:
            opp = Direction.SHORT if is_long else Direction.LONG
            if storyline.poc_is_migrating(opp):
                dims.append(ResonanceDimension("POC_MIGRATION", -1, f"POC -> {opp.name} (opposite)"))
            else:
                dims.append(ResonanceDimension("POC_MIGRATION", 0, "POC stable"))

        # D6: Price vs VWAP
        v = self.vwap
        if v > 0:
            correct_side = (is_long and price > v) or (not is_long and price < v)
            near = abs(price - v) / v < 0.001
            if correct_side:
                dims.append(ResonanceDimension("VWAP_POSITION", +1, f"price={price:.1f} {'>' if is_long else '<'} VWAP={v:.1f}"))
            elif near:
                dims.append(ResonanceDimension("VWAP_POSITION", 0, f"price ~ VWAP ({v:.1f})"))
            else:
                dims.append(ResonanceDimension("VWAP_POSITION", -1, f"wrong side VWAP={v:.1f}"))
        else:
            dims.append(ResonanceDimension("VWAP_POSITION", 0, "VWAP not ready"))

        # D7: Volume expansion
        avg = self.avg_volume
        if avg > 0 and volume > 0:
            ratio = volume / avg
            if ratio >= 1.2:
                dims.append(ResonanceDimension("VOLUME_EXPANSION", +1, f"{ratio:.1f}x avg (expanding)"))
            elif ratio <= 0.7:
                dims.append(ResonanceDimension("VOLUME_EXPANSION", -1, f"{ratio:.1f}x avg (shrinking)"))
            else:
                dims.append(ResonanceDimension("VOLUME_EXPANSION", 0, f"{ratio:.1f}x avg (normal)"))
        else:
            dims.append(ResonanceDimension("VOLUME_EXPANSION", 0, "no vol data"))

        total = sum(d.score for d in dims)
        confirms = sum(1 for d in dims if d.score == +1)
        snap = ResonanceSnapshot(
            timestamp=now, direction=direction, dimensions=dims,
            total_score=total, confirm_count=confirms,
            threshold=self.CONFIRM_THRESHOLD,
            passed=confirms >= self.CONFIRM_THRESHOLD)
        self.snapshots.append(snap)
        if len(self.snapshots) > 200:
            self.snapshots = self.snapshots[-200:]
        self.last_eval_time = now
        self._current = snap
        return snap

    @property
    def current(self) -> Optional[ResonanceSnapshot]:
        return self._current

    @property
    def is_confirmed(self) -> bool:
        return self._current.passed if self._current else False

    def stats(self) -> dict:
        if not self.snapshots:
            return {"total_evals": 0}
        passed = sum(1 for s in self.snapshots if s.passed)
        names = ["4H_BIAS", "CVD_PRICE", "ABSORPTION", "WALL_POSITION",
                 "POC_MIGRATION", "VWAP_POSITION", "VOLUME_EXPANSION"]
        dim_rates = {}
        for i, n in enumerate(names):
            c = sum(1 for s in self.snapshots if len(s.dimensions) > i and s.dimensions[i].score == +1)
            dim_rates[n] = f"{c}/{len(self.snapshots)} ({c / len(self.snapshots):.0%})"
        return {
            "total_evals": len(self.snapshots),
            "passed": passed,
            "pass_rate": f"{passed / len(self.snapshots):.1%}",
            "avg_confirms": round(sum(s.confirm_count for s in self.snapshots) / len(self.snapshots), 1),
            "dimension_rates": dim_rates,
        }


# ═══════════════════════════════════════════════
# L2DataEngine
# ═══════════════════════════════════════════════

class L2DataEngine:
    ABSORPTION_BASE_RATIO = 3.0

    def __init__(self, atr: AdaptiveATR):
        self.atr = atr
        self.dom_snapshot: Dict[float, float] = {}
        self.tape: List[dict] = []
        self.walls: List[WallReading] = []
        self.snr_levels: List[SNRLevel] = []
        self.cvd: float = 0.0
        self.live_bids: List[DOMLevel] = []
        self.live_asks: List[DOMLevel] = []
        self.last_aggressive_buy_vol: float = 0.0
        self.last_aggressive_sell_vol: float = 0.0

    def update_cvd(self, side: str, volume: float):
        self.cvd += volume if side == "buy" else -volume

    def update_dom(self, bids: List[DOMLevel], asks: List[DOMLevel]):
        self.live_bids = bids[:10]
        self.live_asks = asks[:10]

    def update_aggressive_flow(self, buy_vol: float, sell_vol: float):
        self.last_aggressive_buy_vol = buy_vol
        self.last_aggressive_sell_vol = sell_vol

    def _absorption_threshold(self) -> float:
        return self.ABSORPTION_BASE_RATIO * self.atr.vol_ratio_14_50

    def detect_absorption(self, price, aggressive_buy, aggressive_sell, price_delta):
        max_move = self.atr.atr_14 * 0.02
        if abs(price_delta) > max_move:
            return None
        threshold = self._absorption_threshold()
        if aggressive_buy > aggressive_sell * threshold:
            return Direction.SHORT
        if aggressive_sell > aggressive_buy * threshold:
            return Direction.LONG
        return None

    def assess_wall(self, price, size, tested, pulled):
        existing = next((w for w in self.walls if abs(w.price - price) < 0.01), None)
        if existing is None:
            w = WallReading(price=price, size=size, is_real=not pulled,
                            pull_count=1 if pulled else 0, test_count=1 if tested else 0)
            self.walls.append(w)
            return w
        if pulled:
            existing.pull_count += 1
        if tested:
            existing.test_count += 1
        total = existing.test_count + existing.pull_count
        if total > 0:
            existing.is_real = (existing.test_count >= 2 and existing.pull_count / total < 0.3)
        existing.size = size
        return existing

    def get_real_walls(self):
        return [w for w in self.walls if w.is_real]

    def mark_snr(self, o, c, h, l, direction):
        bh = max(o, c)
        bl = min(o, c)
        self.snr_levels.append(SNRLevel(
            price=bh if direction == Direction.SHORT else bl,
            direction=direction, is_fresh=True, body_based=True))

    def invalidate_pierced_snr(self, high, low):
        for s in self.snr_levels:
            if s.is_fresh:
                if s.direction == Direction.LONG and low < s.price:
                    s.is_fresh = False
                elif s.direction == Direction.SHORT and high > s.price:
                    s.is_fresh = False

    def get_fresh_snr(self):
        return [s for s in self.snr_levels if s.is_fresh]

    def capture_orderbook_snapshot(self):
        return OrderBookSnapshot(
            top_10_bids=list(self.live_bids),
            top_10_asks=list(self.live_asks),
            aggressive_buy_volume=self.last_aggressive_buy_vol,
            aggressive_sell_volume=self.last_aggressive_sell_vol,
            real_walls=[{"price": w.price, "size": w.size, "test_count": w.test_count}
                        for w in self.get_real_walls()])


# ═══════════════════════════════════════════════
# BattlefieldEngine + EntryEngine
# ═══════════════════════════════════════════════

class BattlefieldEngine:
    def __init__(self, atr: AdaptiveATR):
        self.atr = atr
        self.fcr_value_area: Optional[ValueArea] = None

    def compute_fcr_value_area(self, profile, total_volume, va_pct=0.70):
        if not profile:
            raise ValueError("Empty volume profile")
        sorted_p = sorted(profile.keys())
        poc = max(profile, key=profile.get)
        target = total_volume * va_pct
        acc = profile[poc]
        pi = sorted_p.index(poc)
        lo, hi = pi, pi
        while acc < target:
            up = hi + 1 < len(sorted_p)
            dn = lo - 1 >= 0
            if not up and not dn:
                break
            vu = profile[sorted_p[hi + 1]] if up else -1
            vd = profile[sorted_p[lo - 1]] if dn else -1
            if vu >= vd:
                hi += 1
                acc += vu
            else:
                lo -= 1
                acc += vd
        self.fcr_value_area = ValueArea(
            vah=sorted_p[hi], val=sorted_p[lo], poc=poc, total_volume=total_volume)
        return self.fcr_value_area

    def detect_expanding_triangle(self, highs, lows):
        if len(highs) < 3 or len(lows) < 3:
            return False
        return (all(highs[i] < highs[i+1] for i in range(len(highs)-1))
                and all(lows[i] > lows[i+1] for i in range(len(lows)-1)))


class EntryEngine:
    VA_PIERCE_MAX_ATR_MULT = 0.5

    def __init__(self, bf, l2, storyline, atr):
        self.bf = bf
        self.l2 = l2
        self.storyline = storyline
        self.atr = atr

    def check_trap_reversal(self, close, low, high, va):
        max_pierce = self.atr.atr_fast * self.VA_PIERCE_MAX_ATR_MULT
        if low < va.val and close > va.val:
            if va.val - low < max_pierce:
                return Direction.LONG
        if high > va.vah and close < va.vah:
            if high - va.vah < max_pierce:
                return Direction.SHORT
        return None

    def check_confluence(self, price, snr, tl_price, tol=0.001):
        if tl_price is None:
            return False
        for s in snr:
            if (abs(price - s.price) / price < tol and abs(price - tl_price) / price < tol):
                s.trendline_confluence = True
                return True
        return False

    def evaluate_entry(self, close, low, high, tl_price=None):
        bias = self.storyline.get_bias()
        if bias == Direction.NEUTRAL:
            return None
        if self.storyline.should_protect_profit():
            return None
        va = self.bf.fcr_value_area
        if va is None:
            return None
        trap = self.check_trap_reversal(close, low, high, va)
        if trap and trap == bias:
            self.check_confluence(close, self.l2.get_fresh_snr(), tl_price)
            return trap
        return None

    def diagnose_trap_rejection(self, close, low, high, va):
        max_pierce = self.atr.atr_fast * self.VA_PIERCE_MAX_ATR_MULT
        pierce_below = max(0, va.val - low)
        pierce_above = max(0, high - va.vah)
        if pierce_below == 0 and pierce_above == 0:
            return "no VA edge pierce"
        if pierce_below > max_pierce or pierce_above > max_pierce:
            depth = max(pierce_below, pierce_above)
            return f"pierce too deep ({depth:.2f} > limit {max_pierce:.2f})"
        if pierce_below > 0 and close < va.val:
            return "close stayed below VAL"
        if pierce_above > 0 and close > va.vah:
            return "close stayed above VAH"
        return "unknown"


# ═══════════════════════════════════════════════
# TimeGuardEngine
# ═══════════════════════════════════════════════

class TimeGuardEngine:
    MAX_HOLD_HOURS = 3
    ASIA_ENTRY_START  = 9 * 60
    ASIA_ENTRY_END    = 10 * 60 + 30
    ASIA_DEADLINE     = 12 * 60
    EURO_GOLDEN_START = 15 * 60 + 15
    EURO_GOLDEN_END   = 16 * 60
    US_GOLDEN         = 22 * 60 + 30
    PREDICTED_CLOSE_ATR_MULT = 0.20

    def __init__(self, atr: AdaptiveATR):
        self.atr = atr

    @staticmethod
    def _m(dt: datetime) -> int:
        return dt.hour * 60 + dt.minute

    def check_expiry(self, t, now):
        return now - t.entry_time >= timedelta(hours=self.MAX_HOLD_HOURS)

    def is_entry_allowed(self, now):
        m = self._m(now)
        if self.ASIA_ENTRY_START <= m <= self.ASIA_ENTRY_END:
            return True
        if self.EURO_GOLDEN_START <= m <= self.EURO_GOLDEN_END:
            return True
        if abs(m - self.US_GOLDEN) <= 15:
            return True
        return False

    def is_asia_deadline(self, now):
        return self._m(now) >= self.ASIA_DEADLINE

    def was_asia_entry(self, t):
        m = self._m(t.entry_time)
        return self.ASIA_ENTRY_START <= m <= self.ASIA_ENTRY_END

    def should_exit_predicted_close(self, price, pred):
        tol = self.atr.atr_14 * self.PREDICTED_CLOSE_ATR_MULT
        return abs(price - pred) <= tol

    def enforce(self, t, now):
        if self.check_expiry(t, now):
            return "force_close_expiry"
        if self.was_asia_entry(t) and self.is_asia_deadline(now):
            return "force_close_asia_deadline"
        return "hold"

    def active_window_name(self, now):
        m = self._m(now)
        if self.ASIA_ENTRY_START <= m <= self.ASIA_ENTRY_END:
            return "ASIA_ENTRY"
        if self.EURO_GOLDEN_START <= m <= self.EURO_GOLDEN_END:
            return "EURO_GOLDEN"
        if abs(m - self.US_GOLDEN) <= 15:
            return "US_GOLDEN"
        return "OUTSIDE"


# ═══════════════════════════════════════════════
# StopLossEngine + KellyRiskManager
# ═══════════════════════════════════════════════

class StopLossEngine:
    MAX_RISK_PCT = 0.02
    SL_ATR_MULTIPLIER = 1.0

    def __init__(self, capital, atr, slippage):
        self.capital = capital
        self.atr = atr
        self.slippage = slippage
        self.consecutive_losses: int = 0

    def get_current_tier(self):
        cl = self.consecutive_losses
        if cl == 0: return DrawdownTier.TIER_0
        if cl == 1: return DrawdownTier.TIER_1
        if cl == 2: return DrawdownTier.TIER_2
        if cl == 3: return DrawdownTier.TIER_3
        return DrawdownTier.TIER_4

    def max_loss_amount(self):
        return self.capital * self.MAX_RISK_PCT * self.get_current_tier().scale

    def record_result(self, win):
        self.consecutive_losses = 0 if win else self.consecutive_losses + 1

    def compute_stop_price(self, entry, direction, fvg_origin=None):
        buf = self.atr.atr_fast * 0.15
        if fvg_origin is not None:
            return (fvg_origin - buf if direction == Direction.LONG else fvg_origin + buf)
        sd = self.atr.stop_distance(entry, self.SL_ATR_MULTIPLIER)
        return (entry - sd if direction == Direction.LONG else entry + sd)

    def compute_position_size(self, entry, stop, leverage, cold_scale=1.0):
        dist = abs(entry - stop) / entry
        eff = dist + self.slippage.p95_slippage_pct
        if eff == 0:
            return 0.0
        notional = self.max_loss_amount() / eff
        return (notional / leverage) * cold_scale


class KellyRiskManager:
    def __init__(self):
        self.win_count: int = 0
        self.loss_count: int = 0
        self.total_wins_amount: float = 0.0
        self.total_losses_amount: float = 0.0
        self.daily_consecutive_wins: int = 0

    def kelly_fraction(self):
        total = self.win_count + self.loss_count
        if total < 10:
            return 0.0
        p = self.win_count / total
        q = 1 - p
        aw = (self.total_wins_amount / self.win_count if self.win_count else 0)
        al = (self.total_losses_amount / self.loss_count if self.loss_count else 1)
        if al == 0:
            return 0.0
        b = aw / al
        k = (p * b - q) / b if b > 0 else 0.0
        return max(0.0, k * 0.5)

    def has_edge(self):
        return self.kelly_fraction() > 0

    def record_trade(self, pnl):
        if pnl > 0:
            self.win_count += 1
            self.total_wins_amount += pnl
            self.daily_consecutive_wins += 1
        else:
            self.loss_count += 1
            self.total_losses_amount += abs(pnl)
            self.daily_consecutive_wins = 0

    def should_shutdown(self):
        return self.daily_consecutive_wins >= 3

    def reset_daily(self):
        self.daily_consecutive_wins = 0


# ═══════════════════════════════════════════════
# MAIN ORCHESTRATOR — ETHOrderFlowBot v3
# ═══════════════════════════════════════════════

class ETHOrderFlowBot:
    LEVERAGE_HARD_CAP = 150

    def __init__(self, capital: float):
        self.capital = capital
        self.atr = AdaptiveATR()
        self.slippage = SlippageTracker()
        self.cold_start = ColdStartManager()
        self.storyline = StorylineEngine()
        self.four_hour = FourHourObserver(self.storyline)
        self.l2 = L2DataEngine(self.atr)
        self.battlefield = BattlefieldEngine(self.atr)
        self.entry = EntryEngine(self.battlefield, self.l2, self.storyline, self.atr)
        self.stop_loss = StopLossEngine(capital, self.atr, self.slippage)
        self.kelly = KellyRiskManager()
        self.time_guard = TimeGuardEngine(self.atr)
        self.resonance = ResonanceScorer()
        self.active_trade: Optional[TradeState] = None
        self.trade_log: List[TradeRecord] = []
        self.daily_trades: int = 0
        self.audit = SignalAuditLog()
        self.last_gate_chain: Optional[GateChainRecord] = None

    def feed_candle(self, high, low, close):
        self.atr.update(high, low, close)

    def _market_snapshot(self, candle_open, candle_high, candle_low,
                         candle_close, candle_volume=0.0):
        va = self.battlefield.fcr_value_area
        poc = (self.storyline.poc_history[-1][1] if self.storyline.poc_history else 0.0)
        return MarketSnapshot(
            atr_7=self.atr.atr_fast, atr_21=self.atr.atr_slow, atr_14=self.atr.atr_14,
            vol_regime=self.atr.regime.name, cvd=self.l2.cvd,
            candle_open=candle_open, candle_high=candle_high,
            candle_low=candle_low, candle_close=candle_close,
            candle_volume=candle_volume, poc=poc,
            fcr_vah=va.vah if va else 0.0, fcr_val=va.val if va else 0.0,
            fcr_poc=va.poc if va else 0.0)

    def tick(self, now, candle_open, candle_close, candle_high, candle_low,
             candle_volume=0.0, trendline_price=None, fvg_origin=None, predicted_close=None):
        # MANAGE OPEN POSITION
        if self.active_trade is not None:
            action = self.time_guard.enforce(self.active_trade, now)
            if action != "hold":
                return f"CLOSE: {action}"
            if predicted_close and self.time_guard.should_exit_predicted_close(candle_close, predicted_close):
                return "CLOSE: predicted_close_reached"
            if self.storyline.should_protect_profit():
                return "CLOSE: exhaustion_protection"
            return None

        # 4H OBSERVER UPDATE
        four_hour_result = self.four_hour.update(now, candle_high, candle_low, candle_close, candle_volume)

        # RESONANCE DATA UPDATE
        self.resonance.update(now, candle_close, candle_volume, self.l2.cvd)

        # RESONANCE EVALUATION
        bias_for_resonance = self.storyline.get_bias()
        if bias_for_resonance != Direction.NEUTRAL and self.resonance.should_evaluate(now):
            self.resonance.evaluate(now, bias_for_resonance, candle_close, candle_volume,
                                    self.storyline, self.four_hour, self.l2, self.battlefield)

        # BUILD GATE CHAIN
        chain = GateChainRecord(timestamp=now)
        rejected = False

        # Gate 0: 4H intraday bias
        if not rejected:
            h4_bias = self.storyline.intraday_bias
            if self.storyline.is_4h_aligned():
                val_str = f"4H={h4_bias.name}"
                if four_hour_result:
                    val_str += f",conf={four_hour_result.confidence:.2f},reasons={len(four_hour_result.reasons)}"
                chain.add("4h_bias", GateResult.PASS, value=val_str)
            else:
                chain.add("4h_bias", GateResult.REJECT,
                          reason=f"4H={h4_bias.name} contradicts W={self.storyline.weekly_direction.name}",
                          value=f"4H={h4_bias.name}")
                rejected = True

        # Gate 1: Walk-3-Rest-1
        if not rejected:
            if self.kelly.should_shutdown():
                chain.add("walk_3_rest_1", GateResult.REJECT, reason="3 consecutive wins",
                          value=str(self.kelly.daily_consecutive_wins))
                rejected = True
            else:
                chain.add("walk_3_rest_1", GateResult.PASS, value=str(self.kelly.daily_consecutive_wins))
        else:
            chain.add("walk_3_rest_1", GateResult.SKIP, reason="upstream rejected")

        # Gate 2: Time window
        if not rejected:
            if self.time_guard.is_entry_allowed(now):
                chain.add("time_window", GateResult.PASS, value=self.time_guard.active_window_name(now))
            else:
                chain.add("time_window", GateResult.REJECT, reason="outside golden window", value=now.strftime("%H:%M"))
                rejected = True
        else:
            chain.add("time_window", GateResult.SKIP, reason="upstream rejected")

        # Gate 3: Kelly edge
        if not rejected:
            total_t = self.kelly.win_count + self.kelly.loss_count
            if self.cold_start.phase == BotPhase.PHASE_2 and total_t >= 10:
                kf = self.kelly.kelly_fraction()
                if self.kelly.has_edge():
                    chain.add("kelly_edge", GateResult.PASS, value=f"f*={kf:.4f}")
                else:
                    chain.add("kelly_edge", GateResult.REJECT, reason="no mathematical edge", value=f"f*={kf:.4f}")
                    rejected = True
            else:
                chain.add("kelly_edge", GateResult.SKIP, reason=f"phase={self.cold_start.phase.value},trades={total_t}")
        else:
            chain.add("kelly_edge", GateResult.SKIP, reason="upstream rejected")

        # Gate 4: Storyline alignment
        bias = self.storyline.get_bias()
        if not rejected:
            if bias != Direction.NEUTRAL:
                chain.add("storyline_align", GateResult.PASS,
                          value=f"W={self.storyline.weekly_direction.name},D={self.storyline.daily_direction.name},4H={self.storyline.intraday_bias.name}")
            else:
                chain.add("storyline_align", GateResult.REJECT, reason="MTF not aligned",
                          value=f"W={self.storyline.weekly_direction.name},D={self.storyline.daily_direction.name},4H={self.storyline.intraday_bias.name}")
                rejected = True
        else:
            chain.add("storyline_align", GateResult.SKIP, reason="upstream rejected")

        # Gate 5: Exhaustion
        if not rejected:
            if self.storyline.should_protect_profit():
                sigs = [s.name for s in self.storyline.exhaustion_signals]
                chain.add("exhaustion_check", GateResult.REJECT, reason="exhaustion active", value=str(sigs))
                rejected = True
            else:
                chain.add("exhaustion_check", GateResult.PASS)
        else:
            chain.add("exhaustion_check", GateResult.SKIP, reason="upstream rejected")

        # Gate 6: Resonance
        if not rejected:
            rs = self.resonance.current
            if rs is not None:
                if rs.passed:
                    chain.add("resonance", GateResult.PASS, value=f"{rs.confirm_count}/7 score={rs.total_score}")
                else:
                    detail_str = ", ".join(f"{d.name}={d.score:+d}" for d in rs.dimensions)
                    chain.add("resonance", GateResult.REJECT,
                              reason=f"only {rs.confirm_count}/7 (need {rs.threshold})", value=detail_str)
                    rejected = True
            else:
                chain.add("resonance", GateResult.SKIP, reason="no resonance eval yet")
        else:
            chain.add("resonance", GateResult.SKIP, reason="upstream rejected")

        # Gate 7: FCR VA exists
        va = self.battlefield.fcr_value_area
        if not rejected:
            if va is not None:
                chain.add("fcr_va_exists", GateResult.PASS, value=f"VAH={va.vah},VAL={va.val}")
            else:
                chain.add("fcr_va_exists", GateResult.REJECT, reason="no FCR Value Area")
                rejected = True
        else:
            chain.add("fcr_va_exists", GateResult.SKIP, reason="upstream rejected")

        # Gate 8: Trap reversal
        trap_dir = None
        if not rejected and va is not None:
            trap_dir = self.entry.check_trap_reversal(candle_close, candle_low, candle_high, va)
            if trap_dir is not None:
                chain.add("trap_reversal", GateResult.PASS, value=f"dir={trap_dir.name}")
            else:
                reason = self.entry.diagnose_trap_rejection(candle_close, candle_low, candle_high, va)
                chain.add("trap_reversal", GateResult.REJECT, reason=reason)
                rejected = True
        else:
            chain.add("trap_reversal", GateResult.SKIP, reason="upstream rejected")

        # Gate 9: Direction match
        if not rejected and trap_dir is not None:
            if trap_dir == bias:
                chain.add("direction_match", GateResult.PASS, value=f"trap={trap_dir.name},bias={bias.name}")
            else:
                chain.add("direction_match", GateResult.REJECT, reason=f"trap={trap_dir.name} vs bias={bias.name}")
                rejected = True
        else:
            chain.add("direction_match", GateResult.SKIP, reason="upstream rejected")

        # Gate 10: Confluence (optional, not hard reject)
        if not rejected:
            fresh = self.l2.get_fresh_snr()
            has_conf = self.entry.check_confluence(candle_close, fresh, trendline_price)
            chain.add("confluence", GateResult.PASS if has_conf else GateResult.SKIP,
                      value=f"found={has_conf}", reason="" if has_conf else "no intersection")
        else:
            chain.add("confluence", GateResult.SKIP, reason="upstream rejected")

        # Gate 11: FVG origin
        if not rejected:
            if fvg_origin is not None:
                chain.add("fvg_origin", GateResult.PASS, value=f"origin={fvg_origin:.2f}")
            else:
                chain.add("fvg_origin", GateResult.REJECT, reason="no FVG origin for stop")
                rejected = True
        else:
            chain.add("fvg_origin", GateResult.SKIP, reason="upstream rejected")

        # Gate 12: Position size
        direction = trap_dir
        dyn_leverage = 0.0
        stop_price = 0.0
        size = 0.0
        if not rejected and direction is not None and fvg_origin is not None:
            dyn_leverage = self.atr.max_leverage(candle_close, StopLossEngine.MAX_RISK_PCT,
                                                  StopLossEngine.SL_ATR_MULTIPLIER, self.LEVERAGE_HARD_CAP)
            stop_price = self.stop_loss.compute_stop_price(candle_close, direction, fvg_origin)
            size = self.stop_loss.compute_position_size(candle_close, stop_price, dyn_leverage,
                                                         self.cold_start.size_scale)
            if size > 0 or self.cold_start.is_paper:
                chain.add("position_size", GateResult.PASS, value=f"size={size:.4f},lev={dyn_leverage:.1f}x")
            else:
                chain.add("position_size", GateResult.REJECT, reason="computed size <= 0")
                rejected = True
        else:
            chain.add("position_size", GateResult.SKIP, reason="upstream rejected")

        # DETERMINE FINAL ACTION
        if rejected:
            first_rej = chain.first_rejection
            if first_rej:
                action = f"BLOCKED: {first_rej.gate_name} -> {first_rej.reason}"
            else:
                action = None
        else:
            is_paper = self.cold_start.is_paper
            self.active_trade = TradeState(
                entry_price=candle_close, direction=direction, entry_time=now,
                stop_loss=stop_price, size=size if not is_paper else 0.0,
                leverage_used=dyn_leverage, is_paper=is_paper)
            self.daily_trades += 1
            action = (f"{'[PAPER] ' if is_paper else ''}ENTRY: {direction.name} @ {candle_close:.2f} | "
                      f"SL={stop_price:.2f} | Size={size:.4f} | Lev={dyn_leverage:.1f}x | "
                      f"Tier={self.stop_loss.get_current_tier().name} | Phase={self.cold_start.phase.value} | "
                      f"Vol={self.atr.regime.name}")

        chain.final_action = action or "NO_SIGNAL"

        # LOG TO AUDIT
        sig_type = SignalType.TRAP_REVERSAL
        sig_dir = direction.name if direction else bias.name
        mkt = self._market_snapshot(candle_open, candle_high, candle_low, candle_close, candle_volume)
        ob = self.l2.capture_orderbook_snapshot()
        self.audit.log(signal_type=sig_type, timestamp=now, direction=sig_dir, trigger_price=candle_close,
                       market=mkt, orderbook=ob, gate_chain=chain)
        self.last_gate_chain = chain
        return action if not rejected or action else None

    def close_trade(self, exit_price, reason, actual_fill=None, latency_ms=0.0):
        if self.active_trade is None:
            return
        t = self.active_trade
        if t.direction == Direction.LONG:
            pnl = (exit_price - t.entry_price) * t.size * t.leverage_used
        else:
            pnl = (t.entry_price - exit_price) * t.size * t.leverage_used
        if actual_fill is not None:
            self.slippage.record(exit_price, actual_fill, latency_ms)
        self.stop_loss.record_result(pnl > 0)
        self.kelly.record_trade(pnl)
        self.cold_start.record_trade(self.kelly.win_count, self.kelly.loss_count, self.kelly.kelly_fraction())
        self.trade_log.append(TradeRecord(
            entry_price=t.entry_price, exit_price=exit_price, direction=t.direction, pnl=pnl,
            slippage=(abs(exit_price - actual_fill) if actual_fill else 0.0),
            fill_latency_ms=latency_ms, leverage_used=t.leverage_used,
            is_paper=t.is_paper, timestamp=datetime.now()))
        self.active_trade = None
        print(f"[CLOSED] {reason} | PnL={pnl:+.2f} | Tier->{self.stop_loss.get_current_tier().name} | "
              f"Kelly={self.kelly.kelly_fraction():.3f} | Phase={self.cold_start.phase.value} | "
              f"Slip={self.slippage.avg_slippage_pct:.4%}")

    def audit_report(self):
        analyzer = SignalPerformanceAnalyzer(self.audit)
        analyzer.print_report()

    def export_audit(self, filepath="signal_audit.json"):
        self.audit.export_json(filepath)
        print(f"Audit log exported: {filepath} ({self.audit.count} entries)")

    def status(self):
        last = self.last_gate_chain
        h4 = self.four_hour.last_assessment
        return {
            "phase": self.cold_start.phase.value,
            "total_trades": len(self.trade_log),
            "total_signals_audited": self.audit.count,
            "atr_fast": round(self.atr.atr_fast, 2),
            "atr_slow": round(self.atr.atr_slow, 2),
            "vol_regime": self.atr.regime.name,
            "dynamic_leverage": round(
                self.atr.max_leverage(self.atr.closes[-1] if self.atr.closes else 0, 0.02, 1.0, 150), 1
            ) if self.atr.closes else "N/A",
            "drawdown_tier": self.stop_loss.get_current_tier().name,
            "kelly_f": round(self.kelly.kelly_fraction(), 4),
            "avg_slippage": f"{self.slippage.avg_slippage_pct:.4%}",
            "daily_consec_wins": self.kelly.daily_consecutive_wins,
            "storyline_bias": self.storyline.get_bias().name,
            "4h_bias": self.storyline.intraday_bias.name,
            "4h_confidence": (round(h4.confidence, 2) if h4 else "N/A"),
            "4h_candles_logged": len(self.four_hour.completed_candles),
            "resonance_confirmed": self.resonance.is_confirmed,
            "resonance_score": (f"{self.resonance.current.confirm_count}/7" if self.resonance.current else "N/A"),
            "resonance_evals": len(self.resonance.snapshots),
            "last_gate_result": (f"{last.pass_count}/{last.total_gates} gates passed" if last else "N/A"),
            "last_rejection": (f"{last.first_rejection.gate_name}: {last.first_rejection.reason}"
                               if last and last.first_rejection else "none"),
        }


# ═══════════════════════════════════════════════
# Self-test
# ═══════════════════════════════════════════════

if __name__ == "__main__":
    import random
    random.seed(42)

    print("=" * 60)
    print("ETH Bot v3.1 — 4H Observer Integration Test")
    print("=" * 60)

    bot = ETHOrderFlowBot(capital=10_000.0)

    # Build ATR history
    price = 2000.0
    for _ in range(25):
        noise = random.uniform(-40, 40)
        h = price + abs(noise)
        l = price - abs(noise) * 0.8
        c = price + noise * 0.5
        bot.feed_candle(h, l, c)
        price = c

    bot.storyline.update_mtf(Direction.LONG, Direction.LONG)

    # FCR VA
    mock_profile = {p: 100 + (80 if 1980 <= p <= 2010 else 0)
                    for p in range(1960, 2040)}
    bot.battlefield.compute_fcr_value_area(mock_profile, sum(mock_profile.values()))
    va = bot.battlefield.fcr_value_area

    print(f"\nATR(7)={bot.atr.atr_fast:.2f}  ATR(21)={bot.atr.atr_slow:.2f}  Regime={bot.atr.regime.name}")
    print(f"VA: VAH={va.vah}  POC={va.poc}  VAL={va.val}")

    # Phase 1: Simulate 4H candles
    print(f"\n{'─' * 60}")
    print("Phase 1: Building 4H candle history (3 bullish candles -> LONG bias)\n")

    four_h_scenarios = [
        (datetime(2026, 3, 29, 8, 0),  1980, 1995, 2000, 1975, 500),
        (datetime(2026, 3, 29, 12, 0), 1995, 2010, 2015, 1990, 600),
        (datetime(2026, 3, 29, 16, 0), 2010, 2025, 2030, 2005, 550),
    ]

    for ts, o, c, h, l, v in four_h_scenarios:
        for minute in range(0, 240, 15):
            t = ts + timedelta(minutes=minute)
            frac = minute / 240
            sub_c = o + (c - o) * frac + random.uniform(-3, 3)
            sub_h = sub_c + random.uniform(0, 5)
            sub_l = sub_c - random.uniform(0, 5)
            sub_h = max(sub_h, l)
            sub_l = min(sub_l, h)
            bot.feed_candle(sub_h, sub_l, sub_c)

        next_boundary = ts + timedelta(hours=4)
        result_4h = bot.four_hour.update(next_boundary, h, l, c, v)

        if result_4h:
            print(f"  [{next_boundary.strftime('%H:%M')}] 4H boundary crossed -> "
                  f"bias={result_4h.bias.name} conf={result_4h.confidence:.2f}")
            for r in result_4h.reasons:
                print(f"    |-- {r}")
        print()

    print(f"  4H intraday bias: {bot.storyline.intraday_bias.name}")
    print(f"  3-layer alignment: W={bot.storyline.weekly_direction.name} "
          f"D={bot.storyline.daily_direction.name} 4H={bot.storyline.intraday_bias.name} "
          f"-> bias={bot.storyline.get_bias().name}")

    # Phase 2: Test ticks
    print(f"\n{'─' * 60}")
    print("Phase 2: Tick evaluation with 4H bias gate\n")

    test_ticks = [
        (datetime(2026, 3, 29, 9, 15), 1988, 1985, 1990, va.val - 5, 100, 1970.0,
         "4H=LONG + Asia + VA pierce + FVG"),
        (datetime(2026, 3, 29, 15, 20), 1988, 1985, 1990, va.val - 5, 100, None,
         "4H=LONG + Euro golden + no FVG"),
    ]

    for now, o, c, h, l, v, fvg, desc in test_ticks:
        if bot.active_trade is not None:
            bot.active_trade = None
        result = bot.tick(now=now, candle_open=o, candle_close=c, candle_high=h,
                          candle_low=l, candle_volume=v, fvg_origin=fvg)
        gc = bot.last_gate_chain
        rej = gc.first_rejection
        print(f"[{desc}]")
        print(f"  Gates: {gc.pass_count}/{gc.total_gates}  "
              f"{'-> ' + rej.gate_name + ': ' + rej.reason if rej else '-> ALL PASSED'}")
        if result:
            print(f"  Result: {result}")
        print()

    # Phase 3: Force 4H SHORT conflict
    print(f"{'─' * 60}")
    print("Phase 3: 4H bias contradicts MTF -> should REJECT\n")

    bot.storyline.update_intraday_bias(Direction.SHORT)
    print(f"  Forced 4H={bot.storyline.intraday_bias.name} vs W={bot.storyline.weekly_direction.name}")

    if bot.active_trade is not None:
        bot.active_trade = None

    result = bot.tick(now=datetime(2026, 3, 29, 9, 30), candle_open=1988, candle_close=1985,
                      candle_high=1990, candle_low=va.val - 5, candle_volume=100, fvg_origin=1970.0)
    gc = bot.last_gate_chain
    rej = gc.first_rejection
    print(f"  Gates: {gc.pass_count}/{gc.total_gates}  "
          f"{'-> ' + rej.gate_name + ': ' + rej.reason if rej else '-> ALL PASSED'}")
    if result:
        print(f"  Result: {result}")

    # Audit Report
    print()
    bot.audit_report()
    bot.export_audit("/tmp/signal_audit_v3.json")

    # Status
    print("\n-- Bot Status --")
    for k, v in bot.status().items():
        print(f"  {k}: {v}")
