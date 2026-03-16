/**
 * ⚙️ V80 "FINAL-SENSE" — 200x 物理规则风控
 * ═══════════════════════════════════════
 * 穿牆狙击入场 + 吸能止盈 + 牆压止盈
 * 4pt 锁死止损 + 6pt 保本 + 120s 冷却
 */

// ═══════════════════════════════════════
// 交易对 & API — 三币种监控
// ═══════════════════════════════════════
export const SYMBOL = "SOLUSDT";
export const ETH_SYMBOL = "ETHUSDT";
export const BTC_SYMBOL = "BTCUSDT";
export const BITUNIX_BASE = "https://fapi.bitunix.com";
export const BITUNIX_WS_PUBLIC = "wss://fapi.bitunix.com/public/";

// ═══════════════════════════════════════
// 交易对精度表
// ═══════════════════════════════════════
export const SYMBOL_PRECISION: Record<string, { qty: number; price: number }> = {
    SOLUSDT: { qty: 1, price: 3 },
    ETHUSDT: { qty: 3, price: 2 },
};

// ═══════════════════════════════════════
// V80 核心参数
// ═══════════════════════════════════════
export const LEVERAGE = 200;
export const ALLOW_SHORT = true;
export const SL_POINTS = 4.0;                  // 🛡️ 4pt 锁死 (强平≈5.3pt, SL 必须先跑)
export const TAKER_FEE = 0.0004;

// ═══════════════════════════════════════
// V80 入场：穿牆狙击
// ═══════════════════════════════════════
export const BTC_ENTRY_RATIO = 8.0;            // 海嘯級: BTC 领路 ≥ 8x
export const BREAKOUT_POWER_MIN = 3.0;         // 能量击穿 L1 牆 ≥ 3x
export const ENTRY_WALL_RATIO_LONG = 2.0;      // LONG: bid/ask 牆比 > 2.0 (支撑强)
export const ENTRY_WALL_RATIO_SHORT = 0.5;     // SHORT: bid/ask 牆比 < 0.5 (压制强)

// ═══════════════════════════════════════
// V80 出场：吸能 + 牆压
// ═══════════════════════════════════════
export const ABSORPTION_EFF_MIN = 0.15;        // 吸能止盈: 位移效率 < 0.15 (放量不动)
export const ABSORPTION_WALL_PRESS = 2.0;      // 吸能止盈: 同时须反向牆压 > 2x
export const ABSORPTION_PROFIT_MIN = 5;        // 吸能止盈: 最低盈利 5pt
export const WALL_PRESSURE_EXIT = 3.0;         // 牆压止盈: 前方牆/后方牆 > 3x
export const WALL_PRESSURE_PROFIT_MIN = 8;     // 牆压止盈: 最低盈利 8pt

// ═══════════════════════════════════════
// Zero-Risk Gate
// ═══════════════════════════════════════
export const ZERO_RISK_THRESHOLD = 6.0;        // V80: 6pt 保本 (覆盖单边手续费)
export const ZERO_RISK_SL_OFFSET = 1.0;

// ═══════════════════════════════════════
// Spread & Liquidity Gate
// ═══════════════════════════════════════
export const MAX_SPREAD_POINTS = 0.35;
export const MIN_DEPTH_ETH = 50;

// ═══════════════════════════════════════
// 保证金 — V80 精确子弹
// ═══════════════════════════════════════
export const MARGIN_DEFAULT = 10;              // V80: $10 ($70分7颗子弹)
export const MARGIN_TIERS: { minBalance: number; margin: number }[] = [
    { minBalance: 2000, margin: 400 },
    { minBalance: 1000, margin: 150 },
    { minBalance: 500,  margin: 60 },
];

export function getMargin(balance: number): number {
    for (const tier of MARGIN_TIERS) {
        if (balance >= tier.minBalance) return tier.margin;
    }
    return MARGIN_DEFAULT;
}

// ═══════════════════════════════════════
// 冷却 & 安全
// ═══════════════════════════════════════
export const COOLDOWN_MS = 120_000;            // 120s 冷却
export const MIN_HOLD_MS = 30_000;             // 最少持仓 30s
export const WS_LAG_MAX_MS = 500;
export const MAX_DAILY_TRADES = 1;             // 🔒 V80 受控: 今晚只准开 1 单
export const MAX_DAILY_LOSS = 20;              // V80: 日亏损上限 $20

// ═══════════════════════════════════════
// K线 & WS 引擎参数
// ═══════════════════════════════════════
export const CANDLE_LOOKBACK = 4;
export const CANDLE_POLL_MS = 30_000;
export const EFFICIENCY_WINDOW = 100;
export const AVG_VOL_WINDOW = 200;

// ═══════════════════════════════════════
// 时段限制 (UTC+8)
// ═══════════════════════════════════════
export const TRADE_HOUR_START = 0;
export const TRADE_HOUR_END = 23;

// ═══════════════════════════════════════
// 旧参数 (保留兼容, V80 不使用)
// ═══════════════════════════════════════
export const STRUCT_SL_BUFFER = 0;
export const WALL_RATIO_MIN = 4.5;
export const EFFICIENCY_MIN = 1.2;
