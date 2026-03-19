/**
 * 🎯 V92 六重共振 + 动态风控
 * ═══════════════════════════════════════
 * 入场: POC+RSI+量+ATR+K棒+疲劳 六重过滤
 * 出场: 动态SL(ATR) → 保本12+3 → 跟踪10 + TP(1:1.5RR)
 * 仓位: 每单风险≤账户1% 动态计算
 */

// ═══════════════════════════════════════
// 交易对 & API
// ═══════════════════════════════════════
export const SYMBOL = "ETHUSDT";
export const ETH_SYMBOL = "ETHUSDT";
export const BTC_SYMBOL = "BTCUSDT";
export const BITUNIX_BASE = "https://fapi.bitunix.com";
export const BITUNIX_WS_PUBLIC = "wss://fapi.bitunix.com/public/";

// ═══════════════════════════════════════
// 精度表
// ═══════════════════════════════════════
export const SYMBOL_PRECISION: Record<string, { qty: number; price: number }> = {
    SOLUSDT: { qty: 1, price: 3 },
    ETHUSDT: { qty: 3, price: 2 },
};

// ═══════════════════════════════════════
// 核心参数
// ═══════════════════════════════════════
export const LEVERAGE = 200;                // Bitunix实际杠杆(保持200x可小仓开)
export const TAKER_FEE = 0.0004;
export const MARGIN_PER_TRADE = 50;         // 回退用 (动态仓位优先)

// ═══════════════════════════════════════
// V92 入场参数 (六重共振)
// ═══════════════════════════════════════
export const MOM12_THRESHOLD = 40;          // (保留向后兼容)
export const VOL_MULTIPLIER = 2.0;          // 成交量 > 均量 × 2
export const BAR_UPPER_SHADOW_MIN = 0.25;   // 上影线占比 > 25%
export const BAR_BODY_MAX = 0.65;           // 或 实体占比 < 65%
export const ATR_BAN_THRESHOLD = 55;        // ATR > 55 禁入
export const EMA200_PERIOD = 200;
export const ATR_MIN = 8;                   // V92: ATR(14) ≥ 8pt 才有波动
export const RSI_FLOOR = 30;                // V92: RSI < 30 不做空
export const RSI_CEILING = 70;              // V92: RSI > 70 不做多

// ═══════════════════════════════════════
// V92 Funding Rate 过滤
// ═══════════════════════════════════════
export const FUNDING_LONG_MAX = 0.0005;     // Funding > 0.05% 不追多
export const BINANCE_FAPI = "https://fapi.binance.com";

// ═══════════════════════════════════════
// V92 日振幅反转模式
// ═══════════════════════════════════════
export const DAY_RANGE_REVERSAL_PCT = 0.8;  // 日振>80% → 非22窗强制反转
export const HOLD_EXTEND_PT = 20;           // 22窗有利>20pt → 延仓

export interface WindowConfig {
    name: string;
    startHour: number;
    startMin: number;
    endHour: number;
    endMin: number;
}

/** CEO 规划的四个交易窗口 (UTC+8) */
export const TRADE_WINDOWS: WindowConfig[] = [
    { name: "08窗口", startHour: 8, startMin: 0, endHour: 9, endMin: 0 },
    { name: "15窗口", startHour: 15, startMin: 0, endHour: 16, endMin: 0 },
    { name: "19窗口", startHour: 19, startMin: 0, endHour: 19, endMin: 30 },  // 美股盘前
    { name: "22窗口", startHour: 22, startMin: 0, endHour: 23, endMin: 0 },
];

// ═══════════════════════════════════════
// V92 出场: 动态SL(ATR) + TP(1:1.5RR) + 保本12+3 + 跟踪10
// ═══════════════════════════════════════
export const SL_ATR_MULT = 1.0;             // SL = 1.0 × 15m ATR(14)
export const SL_MIN_PT = 15.0;              // SL下限 15pt
export const SL_MAX_PT = 20.0;              // SL上限 20pt
export const INITIAL_SL_PT = 15.0;          // 回退固定值 (动态优先)
export const TP_RR_RATIO = 1.5;             // TP = SL × 1.5 (盈亏比1:1.5)
export const BREAKEVEN_PT = 12.0;           // 浮盈 12pt → 移保本
export const BREAKEVEN_SL_OFFSET = 3.0;     // 保本后 SL = 入场 + 3pt
export const TRAILING_PT = 10.0;            // 跟踪距离 10pt
export const MAX_HOLD_BARS = 120;           // 10小时超时

// ═══════════════════════════════════════
// V92 动态仓位 (每单风险 ≤ 账户 1%)
// ═══════════════════════════════════════
export const RISK_PCT = 0.01;               // 每单最大亏损 = 账户 × 1%
export const POS_SIZE_LEVERAGE = 15;        // 仓位计算用15x (保守)

// ═══════════════════════════════════════
// 冷却 & 安全
// ═══════════════════════════════════════
export const COOLDOWN_MS = 60_000;
export const MIN_HOLD_MS = 5_000;
export const WS_LAG_MAX_MS = 500;
export const MAX_DAILY_TRADES = 4;           // V92: 4窗口最多4单
export const MAX_DAILY_LOSS = 100;           // V92: $100 日亏损限制

// ═══════════════════════════════════════
// Spread & Liquidity Gate
// ═══════════════════════════════════════
export const MAX_SPREAD_POINTS = 0.35;
export const MIN_DEPTH_ETH = 50;

// ═══════════════════════════════════════
// K线 & WS 引擎
// ═══════════════════════════════════════
export const CANDLE_LOOKBACK = 4;
export const CANDLE_POLL_MS = 30_000;
export const EFFICIENCY_WINDOW = 100;
export const AVG_VOL_WINDOW = 200;
export const ENTRY_QTY = 3.0;              // 向后兼容

// ═══════════════════════════════════════
// Binance API (K线数据用)
// ═══════════════════════════════════════
export const BINANCE_BASE = "https://api.binance.com";
