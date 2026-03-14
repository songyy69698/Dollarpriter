"""
⚡ Sniper 风控参数
═══════════════════
200x 杠杆下的生死线参数 (CEO spec)
"""

# ═══ 仓位 ═══
MARGIN_PER_TRADE   = 65.0    # $65 保证金 / 笔
LEVERAGE           = 200     # 200x 杠杆
# → 名义 = $65 × 200 = $13,000 ≈ 6.4 ETH

# ═══ 出场 ═══
SL_PT              = 8.0     # 硬停损 8pt (进场后立即挂)
BREAKEVEN_TRIGGER  = 10.0    # +10pt 触发保本
BREAKEVEN_OFFSET   = 0.5     # 保本 → SL移到入场+0.5pt (锁手续费)

TP1_PT             = 18.0    # TP1 = 18pt → 平 60%
TP1_CLOSE_PCT      = 0.60    # TP1 平仓比例

TP2_PT             = 30.0    # TP2 = 30pt → 全平
TP2_CLOSE_PCT      = 1.00    # TP2 剩余全平

# ═══ 风控 ═══
MAX_DAILY_LOSS     = 150.0   # 单日最大亏损 → 停机
MAX_DAILY_TRADES   = 20      # 单日最大笔数
COOLDOWN_SEC       = 300     # 5分钟冷却 (CEO spec)
MAX_CONCURRENT     = 1       # 同时最多1仓

# ═══ 物理验算 ═══
# SL距离 = 8pt / ~2035 = 0.39%
# 爆仓距 = 2035 / 200 = 10.2pt = 0.50%
# 8pt < 10pt → SL在爆仓之前 ✅
#
# 手续费 = $13000 × 0.04% × 2 = $10.4/笔 (taker双边)
# SL亏损 = $65 × 8/2035 × 200 = $51.1 + $10.4费 = $61.5
# TP1净利 = $65 × 18/2035 × 200 × 0.60 - $10.4 = $59.6
# TP2净利 = $65 × 30/2035 × 200 × 0.40 - $10.4 = $66.3
# TP全到 = $59.6 + $66.3 = $125.9
# 盈亏比 = 125.9/61.5 = 2.05:1

SYMBOL             = "ETHUSDT"
QTY_PRECISION      = 3       # ETH 小数位
PRICE_PRECISION    = 2       # 价格小数位
