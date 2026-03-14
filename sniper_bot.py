"""
🎯 ETH Sniper Bot v2 — 主控入口
═══════════════════════════════════
asyncio 架构, 3个并发协程:
  1. ws_data — Binance WS 数据引擎
  2. strategy_loop — 每100ms评估入场条件
  3. position_monitor — 持仓时每200ms检查SL/TP/保本

200x | $65保证金 | SL=8pt | TP1=18pt(60%) | TP2=30pt(100%)
"""
import asyncio
import os
import sys
import time
import logging
import signal
from datetime import datetime, timezone, timedelta

# 模块
from ws_data import BinanceWSEngine      # type: ignore[import-untyped]
from sniper_strategy import SniperStrategy, Signal  # type: ignore[import-untyped]
from sniper_executor import SniperExecutor  # type: ignore[import-untyped]
from sniper_risk import (  # type: ignore[import-untyped]
    MARGIN_PER_TRADE, MAX_DAILY_LOSS, MAX_DAILY_TRADES,
    COOLDOWN_SEC, MAX_CONCURRENT, SL_PT, TP1_PT, TP2_PT,
    BREAKEVEN_TRIGGER
)

TZ8 = timezone(timedelta(hours=8))

# ═══════════════════════════════════════════════
# 日志
# ═══════════════════════════════════════════════
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("sniper_bot.log", encoding="utf-8"),
    ]
)
logger = logging.getLogger("sniper")

# ═══════════════════════════════════════════════
# Telegram 通知 (复用现有)
# ═══════════════════════════════════════════════
try:
    import requests as _req
    TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

    def notify_tg(msg: str):
        if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
            return
        try:
            _req.post(f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
                      json={"chat_id": TELEGRAM_CHAT_ID, "text": msg, "parse_mode": "Markdown"},
                      timeout=5)
        except Exception:
            pass
except ImportError:
    def notify_tg(msg: str):
        pass


class SniperBot:
    """Sniper Bot 主控"""

    def __init__(self):
        # .env 加载
        try:
            from dotenv import load_dotenv  # type: ignore
            load_dotenv()
        except ImportError:
            pass

        api_key = os.environ.get("BITUNIX_API_KEY", "")
        secret_key = os.environ.get("BITUNIX_SECRET_KEY", "")
        if not api_key or not secret_key:
            logger.error("❌ 请设置 BITUNIX_API_KEY 和 BITUNIX_SECRET_KEY")
            sys.exit(1)

        self.ws = BinanceWSEngine()
        self.strategy = SniperStrategy(live_mode=True)  # v2.5: 实盘模式, CVD/OBI生效
        self.executor = SniperExecutor(api_key, secret_key)

        self._running = False
        self._paused = True  # 启动时暂停, 等 CEO 确认
        self._scan_count = 0
        self._last_heartbeat = 0.0

    async def run(self):
        """主入口"""
        logger.info("=" * 60)
        logger.info("  🎯 ETH Sniper Bot v2")
        logger.info("=" * 60)
        logger.info(f"  💰 保证金: ${MARGIN_PER_TRADE}/笔 | 200x")
        logger.info(f"  🛡️ SL: {SL_PT}pt | TP1: {TP1_PT}pt(60%) | TP2: {TP2_PT}pt(100%)")
        logger.info(f"  🏁 保本: +{BREAKEVEN_TRIGGER}pt | 冷却: {COOLDOWN_SEC}s")
        logger.info(f"  📊 日限: {MAX_DAILY_TRADES}笔 | 日亏上限: ${MAX_DAILY_LOSS}")
        logger.info("=" * 60)

        # 启动组件
        self.ws.start()  # 后台线程, 含 REST bootstrap
        await self.executor.start()

        # 等待数据就绪
        logger.info("⏳ 等待 WS 数据就绪...")
        while not self.ws.is_ready():
            await asyncio.sleep(0.5)
        logger.info("✅ 数据就绪!")

        # 同步持仓
        await self.executor.sync_positions()
        balance = await self.executor.get_balance()
        logger.info(f"💰 账户余额: ${balance:.2f}")
        notify_tg(f"🎯 *Sniper Bot v2 已启动*\n💰 余额: ${balance:.2f}\n📌 处于暂停状态, 请发「开」启动")

        self._running = True

        try:
            # 并发运行
            await asyncio.gather(
                self._strategy_loop(),
                self._position_monitor(),
                self._heartbeat(),
            )
        except asyncio.CancelledError:
            pass
        finally:
            self.ws.stop()
            await self.executor.stop()
            logger.info("🛑 Bot 已停止")

    # ═══════════════════════════════════════════════
    # 协程 1: 策略扫描 (每100ms)
    # ═══════════════════════════════════════════════

    async def _strategy_loop(self):
        """每100ms检查策略条件"""
        while self._running:
            try:
                await asyncio.sleep(0.1)  # 100ms

                if self._paused:
                    continue

                # 已有仓位 → 不入场
                if self.executor.in_position:
                    continue

                # 日限检查
                if self.executor.daily_trades >= MAX_DAILY_TRADES:
                    continue
                if self.executor.daily_pnl <= -MAX_DAILY_LOSS:
                    if self._scan_count % 100 == 0:
                        logger.warning(f"🛑 日亏 ${self.executor.daily_pnl:.1f} 达上限, 停机")
                    continue

                # 获取快照 + K线数据
                snap = self.ws.get_snapshot()
                klines_1m = self.ws.get_last_1m_klines(70)   # 60+给Exhaustion窗口
                klines_1h = self.ws.get_last_1h_klines(24)   # v3: 24根给休眠模式均量

                if not snap.get("connected"):
                    continue

                self._scan_count += 1

                # 策略评估 (含1H方向过滤)
                sig = self.strategy.evaluate(snap, klines_1m, klines_1h)
                if sig is None:
                    continue

                # 🎯 触发信号!
                logger.info(f"🎯 信号! [{sig.strategy}] {sig.side.upper()} "
                           f"@ {sig.price:.2f} | {sig.reason} | conf={sig.confidence:.0f}")
                notify_tg(f"🎯 *{sig.strategy}*\n"
                          f"方向: {sig.side.upper()} | 位阶: {sig.level_name.upper()}\n"
                          f"入场: {sig.price:.2f}\n"
                          f"SL: {sig.sl_price:.2f}(8pt) | "
                          f"TP1: {sig.tp1_price:.2f} | TP2: {sig.tp2_price:.2f}\n"
                          f"原因: {sig.reason}")

                # 执行! (v2.5: 固定保证金)
                success = await self.executor.atomic_entry(
                    side=sig.side,
                    order_type=sig.order_type,
                    price=sig.price,
                    sl_price=sig.sl_price,
                    tp1_price=sig.tp1_price,
                    tp2_price=sig.tp2_price,
                    current_price=snap["price"],
                )

                if success:
                    notify_tg(f"✅ 已入场 {sig.side.upper()} | SL自动挂单")
                else:
                    notify_tg(f"❌ 入场失败")

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"策略循环异常: {e}")
                await asyncio.sleep(1)

    # ═══════════════════════════════════════════════
    # 协程 2: 持仓监控 (每200ms)
    # ═══════════════════════════════════════════════

    async def _position_monitor(self):
        """每200ms检查持仓SL/TP/保本"""
        while self._running:
            try:
                await asyncio.sleep(0.2)  # 200ms

                if not self.executor.in_position:
                    continue

                snap = self.ws.get_snapshot()
                price = snap.get("price", 0)
                if price <= 0:
                    continue

                result = await self.executor.check_position(price)
                if result:
                    msg = f"📦 {result} | PnL今日: ${self.executor.daily_pnl:+.1f}"
                    logger.info(msg)
                    notify_tg(msg)

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"持仓监控异常: {e}")
                await asyncio.sleep(1)

    # ═══════════════════════════════════════════════
    # 协程 3: 心跳 (每60秒)
    # ═══════════════════════════════════════════════

    async def _heartbeat(self):
        """每60秒打印状态"""
        while self._running:
            try:
                await asyncio.sleep(60)
                snap = self.ws.get_snapshot()
                price = snap.get("price", 0)
                poc = snap.get("poc_24h", 0)
                poc_dist = abs(price - poc) if poc > 0 else 0
                speed = snap.get("agg_speed_1m", 0)
                delta = snap.get("realtime_delta", 0)
                msgs = snap.get("msg_count", 0)

                status = "🔴暂停" if self._paused else ("📦持仓" if self.executor.in_position else "🟢狙击中")

                logger.info(
                    f"📡 [{status}] ${price:.2f} | POC${poc:.0f}({poc_dist:.0f}pt) | "
                    f"⚡{speed:.0f}/s Δ{delta:+.0f} | "
                    f"PnL${self.executor.daily_pnl:+.1f} 第{self.executor.daily_trades}笔 | "
                    f"扫{self._scan_count} 📨{msgs}"
                )

                # 每日重置 (UTC+8 00:00)
                now_h = datetime.now(TZ8).hour
                if now_h == 0 and time.time() - self._last_heartbeat > 3600:
                    self.executor.daily_pnl = 0.0
                    self.executor.daily_trades = 0
                    logger.info("🔄 每日重置")

                self._last_heartbeat = time.time()

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"心跳异常: {e}")


# ═══════════════════════════════════════════════
# 入口
# ═══════════════════════════════════════════════
async def main():
    bot = SniperBot()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: asyncio.create_task(_shutdown(bot)))

    await bot.run()


async def _shutdown(bot: SniperBot):
    logger.info("🛑 收到停止信号...")
    bot._running = False


if __name__ == "__main__":
    asyncio.run(main())
