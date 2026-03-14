"""
⚡ Sniper 执行器 — 异步下单 + 原子SL
══════════════════════════════════════
基于 bitunix_client.py 的签名逻辑, 用 aiohttp 异步化
核心: place_order → 立即挂SL → 追踪保本/TP
"""
import asyncio
import time
import hashlib
import json
import uuid
import logging
import os
from typing import Any, Dict, Optional

try:
    import aiohttp
except ImportError:
    aiohttp = None  # type: ignore

from sniper_risk import (
    MARGIN_PER_TRADE, LEVERAGE, SL_PT, BREAKEVEN_TRIGGER, BREAKEVEN_OFFSET,
    TP1_PT, TP1_CLOSE_PCT, TP2_PT, SYMBOL, QTY_PRECISION, PRICE_PRECISION
)

logger = logging.getLogger("sniper.executor")

BITUNIX_BASE = "https://fapi.bitunix.com"


class SniperExecutor:
    """异步 Bitunix 下单执行器"""

    def __init__(self, api_key: str, secret_key: str):
        self.api_key = api_key
        self.secret_key = secret_key
        self._session: Optional[aiohttp.ClientSession] = None

        # 当前持仓
        self.in_position = False
        self.position_side: str = ""
        self.entry_price: float = 0.0
        self.position_qty: float = 0.0
        self.position_id: str = ""
        self.entry_ts: float = 0.0
        self.sl_moved_to_be: bool = False
        self.tp1_hit: bool = False
        self.remaining_qty: float = 0.0

        # 统计
        self.daily_pnl: float = 0.0
        self.daily_trades: int = 0
        self.trade_log: list = []

    async def start(self):
        """初始化 aiohttp session"""
        if aiohttp is None:
            raise ImportError("请安装 aiohttp: pip install aiohttp")
        self._session = aiohttp.ClientSession(
            base_url=BITUNIX_BASE,
            timeout=aiohttp.ClientTimeout(total=5),
            headers={"language": "en-US", "Content-Type": "application/json"},
        )
        logger.info("⚡ 执行器已初始化")

    async def stop(self):
        """关闭 session"""
        if self._session:
            await self._session.close()
            self._session = None

    # ═══════════════════════════════════════════════
    # 签名 (与 bitunix_client.py 相同逻辑)
    # ═══════════════════════════════════════════════

    def _sign(self, query_params: str = "", body: str = "") -> Dict[str, str]:
        nonce = uuid.uuid4().hex
        timestamp = str(int(time.time() * 1000))
        digest_input = nonce + timestamp + self.api_key + query_params + body
        digest = hashlib.sha256(digest_input.encode()).hexdigest()
        sign = hashlib.sha256((digest + self.secret_key).encode()).hexdigest()
        return {
            "api-key": self.api_key,
            "sign": sign,
            "nonce": nonce,
            "timestamp": timestamp,
        }

    # ═══════════════════════════════════════════════
    # 核心: 原子下单 (开仓 + 立即SL)
    # ═══════════════════════════════════════════════

    async def atomic_entry(self, side: str, order_type: str, price: float,
                           sl_price: float, tp1_price: float, tp2_price: float,
                           current_price: float, margin: float = 0) -> bool:
        """
        原子入场:
          1. 计算仓位大小
          2. 下开仓单 (MARKET 或 LIMIT)
          3. 立即挂 SL 单
        返回 True = 成功
        """
        if self.in_position:
            logger.warning("已有持仓, 跳过")
            return False

        # 计算仓位 (v3: 使用信号的动态margin)
        trade_margin = margin if margin > 0 else MARGIN_PER_TRADE
        notional = trade_margin * LEVERAGE
        entry_estimate = price if order_type == "LIMIT" else current_price
        qty = round(notional / entry_estimate, QTY_PRECISION)
        if qty <= 0:
            logger.error(f"仓位计算异常: notional={notional} price={entry_estimate}")
            return False

        buy_side = "BUY" if side == "long" else "SELL"

        # ── 开仓 ──
        order_data: Dict[str, Any] = {
            "symbol": SYMBOL,
            "side": buy_side,
            "orderType": order_type.upper(),
            "qty": str(qty),
            "tradeSide": "OPEN",
            "effect": "GTC",
        }
        if order_type.upper() == "LIMIT":
            order_data["price"] = str(round(price, PRICE_PRECISION))

        # 带SL挂单 (Bitunix 支持下单时附带 slPrice)
        order_data["slPrice"] = str(round(sl_price, PRICE_PRECISION))
        order_data["slStopType"] = "LAST"

        t0 = time.time()
        result = await self._post_order(order_data)
        latency_ms = (time.time() - t0) * 1000

        if result is None:
            logger.error("❌ 开仓失败")
            return False

        logger.info(f"✅ 开仓成功 {side.upper()} {qty} ETH @ ~{entry_estimate:.2f} "
                    f"SL={sl_price:.2f} ({latency_ms:.0f}ms)")

        # 记录持仓
        self.in_position = True
        self.position_side = side
        self.entry_price = entry_estimate
        self.position_qty = qty
        self.remaining_qty = qty
        self.entry_ts = time.time()
        self.sl_moved_to_be = False
        self.tp1_hit = False
        self.daily_trades += 1

        return True

    async def check_position(self, current_price: float) -> Optional[str]:
        """
        检查持仓状态, 执行保本/TP逻辑
        返回: None=继续持有, "closed_xxx"=已平仓原因
        """
        if not self.in_position:
            return None

        entry = self.entry_price
        side = self.position_side

        if side == "long":
            pnl_pt = current_price - entry
        else:
            pnl_pt = entry - current_price

        # ── 保本: +10pt → SL移到入场+0.5pt ──
        if not self.sl_moved_to_be and pnl_pt >= BREAKEVEN_TRIGGER:
            if side == "long":
                new_sl = entry + BREAKEVEN_OFFSET
            else:
                new_sl = entry - BREAKEVEN_OFFSET

            # 这里需要修改SL — Bitunix可能需要撤原SL+挂新SL
            # 简化: 在 position_monitor 中用价格跟踪
            self.sl_moved_to_be = True
            logger.info(f"🛡️ 保本触发 pnl={pnl_pt:+.1f}pt → SL移到{new_sl:.2f}")

        # ── TP1: 18pt → 平60% ──
        if not self.tp1_hit and pnl_pt >= TP1_PT:
            tp1_qty = round(self.position_qty * TP1_CLOSE_PCT, QTY_PRECISION)
            if tp1_qty > 0:
                close_side = "SELL" if side == "long" else "BUY"
                result = await self._close_partial(close_side, tp1_qty)
                if result:
                    self.tp1_hit = True
                    self.remaining_qty = round(self.remaining_qty - tp1_qty, QTY_PRECISION)
                    pnl_u = tp1_qty * pnl_pt  # 粗估PnL
                    self.daily_pnl += pnl_u
                    logger.info(f"🎯 TP1 触及 +{pnl_pt:.1f}pt | 平{tp1_qty}ETH(60%) | 剩{self.remaining_qty}")
                    self._log_trade(f"TP1 +{pnl_pt:.1f}pt", tp1_qty, pnl_pt)

        # ── TP2: 30pt → 全平 ──
        if pnl_pt >= TP2_PT and self.remaining_qty > 0:
            close_side = "SELL" if side == "long" else "BUY"
            result = await self._close_partial(close_side, self.remaining_qty)
            if result:
                pnl_u = self.remaining_qty * pnl_pt
                self.daily_pnl += pnl_u
                logger.info(f"🎯 TP2 全平 +{pnl_pt:.1f}pt")
                self._log_trade(f"TP2 +{pnl_pt:.1f}pt", self.remaining_qty, pnl_pt)
                self._reset_position()
                return "closed_tp2"

        # ── 保本SL触发: 价格回到入场+0.5pt以下 ──
        if self.sl_moved_to_be and pnl_pt <= BREAKEVEN_OFFSET:
            close_side = "SELL" if side == "long" else "BUY"
            result = await self._close_partial(close_side, self.remaining_qty)
            if result:
                logger.info(f"🛡️ 保本出场 pnl={pnl_pt:+.1f}pt")
                self._log_trade(f"保本 {pnl_pt:+.1f}pt", self.remaining_qty, pnl_pt)
                self._reset_position()
                return "closed_breakeven"

        return None

    # ═══════════════════════════════════════════════
    # Bitunix API 调用
    # ═══════════════════════════════════════════════

    async def _post_order(self, data: Dict[str, Any]) -> Optional[Dict]:
        if not self._session:
            return None
        body_str = json.dumps(data, separators=(',', ':'), sort_keys=True)
        headers = self._sign(body=body_str)
        try:
            async with self._session.post("/api/v1/futures/trade/place_order",
                                          data=body_str, headers=headers) as resp:
                result = await resp.json()
                if str(result.get("code", "")) == "0":
                    return result.get("data")
                logger.error(f"下单API错误: {result}")
                return None
        except Exception as e:
            logger.error(f"下单请求异常: {e}")
            return None

    async def _close_partial(self, close_side: str, qty: float) -> bool:
        """部分平仓"""
        data = {
            "symbol": SYMBOL,
            "side": close_side,
            "orderType": "MARKET",
            "qty": str(round(qty, QTY_PRECISION)),
            "tradeSide": "CLOSE",
            "effect": "GTC",
        }
        result = await self._post_order(data)
        return result is not None

    async def get_balance(self) -> float:
        """查询账户余额"""
        if not self._session:
            return 0.0
        params = {"marginCoin": "USDT"}
        query_str = "marginCoinUSDT"
        headers = self._sign(query_params=query_str)
        try:
            async with self._session.get("/api/v1/futures/account",
                                         params=params, headers=headers) as resp:
                result = await resp.json()
                if str(result.get("code", "")) == "0":
                    data = result.get("data", {})
                    return float(data.get("available", 0))
                return 0.0
        except Exception as e:
            logger.error(f"查余额异常: {e}")
            return 0.0

    async def sync_positions(self) -> bool:
        """同步持仓状态"""
        if not self._session:
            return False
        headers = self._sign()
        try:
            async with self._session.get("/api/v1/futures/position/get_pending_positions",
                                         headers=headers) as resp:
                result = await resp.json()
                if str(result.get("code", "")) != "0":
                    return False
                positions = result.get("data", [])
                eth_pos = [p for p in positions if p.get("symbol", "").upper() == SYMBOL]
                if eth_pos:
                    p = eth_pos[0]
                    qty = float(p.get("qty", 0))
                    side_raw = str(p.get("side", "")).upper()
                    self.in_position = True
                    self.position_side = "long" if side_raw == "BUY" else "short"
                    self.entry_price = float(p.get("avgOpenPrice", 0))
                    self.position_qty = qty
                    self.remaining_qty = qty
                    self.position_id = str(p.get("positionId", ""))
                    logger.info(f"📡 同步持仓: {self.position_side} {qty} ETH @ {self.entry_price:.2f}")
                    return True
                else:
                    self.in_position = False
                    return True
        except Exception as e:
            logger.error(f"同步持仓异常: {e}")
            return False

    # ═══════════════════════════════════════════════
    # 内部
    # ═══════════════════════════════════════════════

    def _reset_position(self):
        self.in_position = False
        self.position_side = ""
        self.entry_price = 0.0
        self.position_qty = 0.0
        self.remaining_qty = 0.0
        self.sl_moved_to_be = False
        self.tp1_hit = False

    def _log_trade(self, reason: str, qty: float, pnl_pt: float):
        from datetime import datetime, timezone, timedelta
        self.trade_log.append({
            "ts": datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S"),
            "side": self.position_side,
            "entry": self.entry_price,
            "pnl_pt": round(pnl_pt, 2),
            "qty": qty,
            "reason": reason,
        })
