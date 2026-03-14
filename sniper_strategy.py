"""
🎯 Sniper 策略引擎 v2.5 — 最终战斗版
═══════════════════════════════════════
CEO 指令:
  · 固定生死线: SL=8pt TP1=18pt TP2=30pt 保证金=$65 (0爆仓铁律)
  · 优质位阶: POC + VAH + VAL (比单一POC更多机会)
  · CVD/OBI: 只在实盘生效 (回测数据不精确)
  · 无休眠: 有信号就做, 不漏大行情
  · 1H方向过滤: v2验证的决定性因素

入场:
  A. Value Area Rejection — POC/VAH/VAL ±3pt + 300%爆量 + 5pt影线 → LIMIT
  B. Exhaustion Climax — 25pt/60m + 力竭 + 背离 + 1H顺 → MARKET

实盘额外过滤 (回测中跳过):
  · CVD 5分钟累积背离
  · 盘口失衡 (OBI) top5 bid/ask ≥ 60%

交易所: Bitunix (执行) | 数据源: Binance (WebSocket)
"""
import time
import logging
from typing import Any, Dict, List, Optional
from collections import deque
from dataclasses import dataclass, field

logger = logging.getLogger("sniper.strategy")

# ═══════════════════════════════════════════════
# v2.5 固定参数 (回测验证: $500→$4038, 57.1%, 0爆仓)
# ═══════════════════════════════════════════════

# ── 固定生死线 ──  
SL_PT              = 8.0     # 硬止损 (在爆仓10.2pt之内)
TP1_PT             = 18.0    # TP1
TP2_PT             = 30.0    # TP2
TP1_CLOSE_PCT      = 0.60    # TP1 平60%
BREAKEVEN_TRIGGER  = 10.0    # +10pt触发保本
BREAKEVEN_OFFSET   = 0.5     # 保本移到入场+0.5pt
MARGIN_PER_TRADE   = 65.0    # $65/笔
LEVERAGE           = 200     # 200x

# ── A: Value Area Rejection ──
VA_ZONE_PT         = 3.0     # 价格在 POC/VAH/VAL ± 3pt 内
VA_VOL_SPIKE       = 3.0     # 成交速度 ≥ 3x (300%)
VA_WICK_MIN_PT     = 5.0     # 1m 影线 ≥ 5pt
VA_MAX_BODY_PCT    = 0.40    # 实体占比 ≤ 40%

# ── B: Exhaustion Climax ──
EXH_VELOCITY_PT       = 25.0   # 移动 ≥ 25pt
EXH_VELOCITY_CANDLES  = 60     # 60根1m窗口 (≈1小时)
EXH_STALL_CANDLES     = 3      # 力竭后无新高低的K线数
EXH_1H_FILTER         = True   # 🔑 1H方向过滤

# ── 实盘额外过滤 (回测中自动跳过) ──
LIVE_CVD_ENABLED   = True    # CVD背离 (实盘aggTrade累积)
LIVE_CVD_WINDOW    = 5       # 5分钟窗口
LIVE_OBI_ENABLED   = True    # 盘口失衡 (实盘depth20)
LIVE_OBI_THRESHOLD = 0.60    # bid/(bid+ask) ≥ 60%

# ── 共通 ──
COOLDOWN_SEC       = 300     # 5分钟冷却
SPREAD_MAX_PT      = 3.0     # 价差 > 3pt 不入场


@dataclass
class Signal:
    """交易信号"""
    strategy: str       # "va_rejection" 或 "exhaustion_climax"
    side: str           # "long" 或 "short"
    order_type: str     # "LIMIT" 或 "MARKET"
    price: float        # 入场价
    sl_price: float     # SL价 (固定8pt)
    tp1_price: float    # TP1
    tp2_price: float    # TP2
    level_name: str     # 触发位阶 "poc"/"vah"/"val"
    reason: str
    confidence: float
    ts: float = field(default_factory=time.time)


class SniperStrategy:
    """Sniper v2.5 策略引擎"""

    def __init__(self, live_mode: bool = True):
        """
        live_mode=True: 实盘, CVD/OBI过滤生效
        live_mode=False: 回测, CVD/OBI跳过
        """
        self._live_mode = live_mode
        self._last_signal_ts: float = 0.0
        self._velocity_cooldown: float = 0.0

        # CVD追踪 (实盘时从aggTrade累积)
        self._cvd_history: deque = deque(maxlen=600)
        self._cumulative_delta: float = 0.0

    def evaluate(self, snap: Dict[str, Any], klines_1m: List[Dict[str, Any]],
                 klines_1h: Optional[List[Dict[str, Any]]] = None) -> Optional[Signal]:
        """
        评估市场状态
        snap: ws_data.get_snapshot()
        klines_1m: ws_data.get_last_1m_klines(70)
        klines_1h: ws_data.get_last_1h_klines(2)
        """
        now = time.time()
        price = snap.get("price", 0)
        if price <= 0:
            return None

        # 更新CVD (实盘模式)
        if self._live_mode:
            delta = snap.get("realtime_delta", 0)
            self._cumulative_delta += delta
            self._cvd_history.append((now, self._cumulative_delta))

        # ── 共通过滤 ──
        if now - self._last_signal_ts < COOLDOWN_SEC:
            return None
        if not snap.get("spread_safe", False):
            return None
        if snap.get("poc_24h", 0) <= 0:
            return None
        if snap.get("liq_emergency", False):
            return None

        # ── A: Value Area Rejection (POC + VAH + VAL) ──
        sig = self._check_va_rejection(snap, klines_1m, price, now)
        if sig:
            self._last_signal_ts = now
            return sig

        # ── B: Exhaustion Climax ──
        sig = self._check_exhaustion(snap, klines_1m, price, now, klines_1h)
        if sig:
            self._last_signal_ts = now
            return sig

        return None

    # ═══════════════════════════════════════════════
    # A: Value Area Rejection (POC + VAH + VAL)
    # ═══════════════════════════════════════════════

    def _check_va_rejection(self, snap: Dict[str, Any],
                             klines_1m: List[Dict[str, Any]],
                             price: float, now: float) -> Optional[Signal]:
        """
        检查 POC/VAH/VAL 三个位阶的拒绝信号
        """
        poc = snap["poc_24h"]
        vah = snap.get("vah_24h", 0)
        val = snap.get("val_24h", 0)

        # 构建位阶清单
        levels = [("poc", poc)]
        if vah > 0:
            levels.append(("vah", vah))
        if val > 0:
            levels.append(("val", val))

        # 按距离排序, 检查最近的
        levels.sort(key=lambda x: abs(price - x[1]))

        for level_name, level_price in levels:
            if abs(price - level_price) > VA_ZONE_PT:
                continue

            # 成交暴增 ≥ 3x
            speed_ratio = snap.get("agg_speed_ratio", 1.0)
            if speed_ratio < VA_VOL_SPIKE:
                continue

            # 影线检查 (上根已收盘K线)
            if len(klines_1m) < 2:
                continue
            prev_k = klines_1m[-2]
            body = abs(prev_k["c"] - prev_k["o"])
            total_range = prev_k["h"] - prev_k["l"]
            if total_range < VA_WICK_MIN_PT:
                continue
            if body / total_range > VA_MAX_BODY_PCT:
                continue

            upper_wick = prev_k["h"] - max(prev_k["c"], prev_k["o"])
            lower_wick = min(prev_k["c"], prev_k["o"]) - prev_k["l"]

            side = None
            wick_pt = 0
            if lower_wick >= VA_WICK_MIN_PT:
                side = "long"
                wick_pt = lower_wick
            elif upper_wick >= VA_WICK_MIN_PT:
                side = "short"
                wick_pt = upper_wick

            if side is None:
                continue

            # 实盘: 盘口失衡过滤 (OBI)
            if self._live_mode and LIVE_OBI_ENABLED:
                if not self._check_obi(snap, side):
                    logger.debug(f"OBI过滤: {side} @ {level_name} {level_price:.2f}")
                    continue

            # 构建信号 (固定SL/TP)
            if side == "long":
                sl = level_price - SL_PT
                tp1 = level_price + TP1_PT
                tp2 = level_price + TP2_PT
            else:
                sl = level_price + SL_PT
                tp1 = level_price - TP1_PT
                tp2 = level_price - TP2_PT

            confidence = min(100.0, speed_ratio * 15 + wick_pt * 3)
            # VAH/VAL 信心加成
            if level_name in ("vah", "val"):
                confidence *= 1.2

            reason = (f"{level_name.upper()}拒绝{'↑' if side=='long' else '↓'} "
                      f"@{level_price:.2f} wick={wick_pt:.1f}pt "
                      f"vol={speed_ratio:.1f}x")

            return Signal(
                strategy="va_rejection", side=side, order_type="LIMIT",
                price=level_price, sl_price=sl, tp1_price=tp1, tp2_price=tp2,
                level_name=level_name, reason=reason, confidence=confidence
            )

        return None

    # ═══════════════════════════════════════════════
    # B: Exhaustion Climax
    # ═══════════════════════════════════════════════

    def _check_exhaustion(self, snap: Dict[str, Any],
                           klines_1m: List[Dict[str, Any]],
                           price: float, now: float,
                           klines_1h: Optional[List[Dict[str, Any]]] = None) -> Optional[Signal]:
        """
        Exhaustion Climax v2.5:
          1. 60根1m内移动 > 25pt
          2. 3根1m 无法创新高/新低
          3. Delta背离 (回测=单根, 实盘=CVD)
          4. 当前K线反转
          5. 1H方向过滤
          6. 实盘: OBI过滤
        """
        if now < self._velocity_cooldown:
            return None

        if len(klines_1m) < EXH_VELOCITY_CANDLES + 5:
            return None

        # Step 1: Velocity — 60根1m内移动
        price_start = klines_1m[-(EXH_VELOCITY_CANDLES + 1)]["c"]
        move = price - price_start
        abs_move = abs(move)

        if abs_move < EXH_VELOCITY_PT:
            return None

        # Step 2: 力竭
        recent_3 = klines_1m[-4:-1]
        if move > 0:
            peak = max(k["h"] for k in klines_1m[-6:-1]) if len(klines_1m) >= 6 else klines_1m[-2]["h"]
            stalled = all(k["h"] < peak for k in recent_3)
            trend_dir = "up"
        else:
            trough = min(k["l"] for k in klines_1m[-6:-1]) if len(klines_1m) >= 6 else klines_1m[-2]["l"]
            stalled = all(k["l"] > trough for k in recent_3)
            trend_dir = "down"

        if not stalled:
            return None

        # Step 3: 背离检测
        if self._live_mode and LIVE_CVD_ENABLED:
            # 实盘: CVD累积背离 (更精确)
            if not self._check_cvd_divergence(trend_dir, now):
                return None
        else:
            # 回测: 单根Delta (v2逻辑)
            delta = snap.get("realtime_delta", 0)
            if trend_dir == "up" and delta > 0:
                return None
            if trend_dir == "down" and delta < 0:
                return None

        # Step 4: K线反转
        current_k = klines_1m[-1]
        current_green = current_k["c"] > current_k["o"]
        if trend_dir == "up" and current_green:
            return None
        if trend_dir == "down" and not current_green:
            return None

        # 方向
        side = "short" if trend_dir == "up" else "long"

        # Step 5: 1H方向过滤
        if EXH_1H_FILTER and klines_1h and len(klines_1h) >= 1:
            last_1h = klines_1h[-1]
            h_dir = "up" if last_1h["c"] > last_1h["o"] else "down"
            if side == "long" and h_dir != "up":
                return None
            if side == "short" and h_dir != "down":
                return None

        # Step 6: 实盘 OBI 过滤
        if self._live_mode and LIVE_OBI_ENABLED:
            if not self._check_obi(snap, side):
                logger.debug(f"OBI过滤: exhaustion {side}")
                return None

        # 固定 SL/TP
        if side == "long":
            sl = price - SL_PT
            tp1 = price + TP1_PT
            tp2 = price + TP2_PT
        else:
            sl = price + SL_PT
            tp1 = price - TP1_PT
            tp2 = price - TP2_PT

        confidence = min(100.0, abs_move * 2 + 20)
        self._velocity_cooldown = now + COOLDOWN_SEC

        delta_val = snap.get("realtime_delta", 0)
        reason = (f"力竭{trend_dir}→{side} move={abs_move:.0f}pt "
                  f"delta={delta_val:+.0f} stall={EXH_STALL_CANDLES}K")

        return Signal(
            strategy="exhaustion_climax", side=side, order_type="MARKET",
            price=price, sl_price=sl, tp1_price=tp1, tp2_price=tp2,
            level_name="exhaustion", reason=reason, confidence=confidence
        )

    # ═══════════════════════════════════════════════
    # 实盘过滤器 (回测中自动跳过)
    # ═══════════════════════════════════════════════

    def _check_cvd_divergence(self, trend_dir: str, now: float) -> bool:
        """CVD 5分钟累积背离 (仅实盘)"""
        cutoff = now - LIVE_CVD_WINDOW * 60
        cvd_window = [(t, c) for t, c in self._cvd_history if t >= cutoff]
        if len(cvd_window) < 10:
            return True  # 数据不足, 放行 (保守)

        cvd_change = cvd_window[-1][1] - cvd_window[0][1]

        if trend_dir == "up" and cvd_change < 0:
            return True   # 价涨CVD跌 = 背离 ✅
        if trend_dir == "down" and cvd_change > 0:
            return True   # 价跌CVD涨 = 背离 ✅
        return False      # 无背离 ❌

    def _check_obi(self, snap: Dict[str, Any], side: str) -> bool:
        """盘口失衡 (仅实盘, 需要真实depth20)"""
        bid_vol = snap.get("total_bid_depth", 0)
        ask_vol = snap.get("total_ask_depth", 0)
        total = bid_vol + ask_vol
        if total <= 0:
            return True  # 无数据, 放行

        bid_pct = bid_vol / total

        if side == "long" and bid_pct >= LIVE_OBI_THRESHOLD:
            return True   # 买盘占优, 支持做多 ✅
        if side == "short" and (1 - bid_pct) >= LIVE_OBI_THRESHOLD:
            return True   # 卖盘占优, 支持做空 ✅
        return False      # 盘口不支持 ❌
