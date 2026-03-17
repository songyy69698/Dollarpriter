/**
 * 🎯 V91 因果套利 + 平衡型出场
 * ═══════════════════════════════════════
 * 入场: 买压>卖墙×2.5 + 效率>均值 (实时盘口)
 * 出场: SL12 → 保本10+3 → 跟踪10
 * 核心: 盘口因果edge入场 + 大盈亏比出场
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
// V90 核心参数
// ═══════════════════════════════════════
export const LEVERAGE = 200;
export const TAKER_FEE = 0.0004;

// ═══════════════════════════════════════
// V90 入场: 时段窗口 + RSI + VWAP + 日振幅
// ═══════════════════════════════════════
export const ENTRY_QTY = 3.0;              // CEO: 每单 3 ETH

export interface WindowConfig {
    name: string;
    startHour: number;
    startMin: number;
    endHour: number;
    endMin: number;
}

/** CEO 规划的三个交易窗口 (UTC+8) — 多空双向观察 */
export const TRADE_WINDOWS: WindowConfig[] = [
    { name: "08窗口", startHour: 8, startMin: 0, endHour: 9, endMin: 0 },
    { name: "15窗口", startHour: 15, startMin: 0, endHour: 16, endMin: 0 },
    { name: "22窗口", startHour: 22, startMin: 0, endHour: 23, endMin: 0 },
];

// RSI 阈值
export const RSI_OVERSOLD = 30;             // 超卖 < 30
export const RSI_OVERBOUGHT = 70;           // 超买 > 70
export const RSI_PERIOD = 14;

// VWAP 偏离阈值 (%)
export const VWAP_DEV_MIN = 0.5;            // 偏离 VWAP ≥ 0.5%

// 日振幅阈值
export const RANGE_LOW_THRESHOLD = 0.5;     // 08:00 做多: 日振已用 < 50%
export const RANGE_HIGH_THRESHOLD = 0.6;    // 15:00 做空: 日振已用 > 60%
export const RANGE_FULL_THRESHOLD = 0.7;    // 22:00 做多: 日振已用 > 70%

// ═══════════════════════════════════════
// V91 出场: 平衡型 (SL12→保本10+3→跟踪10)
// ═══════════════════════════════════════
export const INITIAL_SL_PT = 12.0;          // 初始止损 12pt (给呼吸空间)
export const BREAKEVEN_PT = 10.0;           // 浮盈 10pt → 移 SL 到入场+3pt
export const BREAKEVEN_SL_OFFSET = 3.0;     // 保本后 SL = 入场 + 3pt (锁利)
export const TRAILING_PT = 10.0;            // 跟踪距离 10pt (让利润跑)
export const MAX_HOLD_BARS = 60;            // 最长持仓 60 根 5m = 5 小时

// ═══════════════════════════════════════
// 冷却 & 安全
// ═══════════════════════════════════════
export const COOLDOWN_MS = 3_600_000;       // 1 小时冷却
export const MIN_HOLD_MS = 5_000;           // 最少持仓 5s
export const WS_LAG_MAX_MS = 500;
export const MAX_DAILY_TRADES = 3;          // 日限 3 单 (每窗口 1 单)
export const MAX_DAILY_LOSS = 80;           // 3 单全亏 = $72, 留 buffer

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

// ═══════════════════════════════════════
// Binance API (指标计算用)
// ═══════════════════════════════════════
export const BINANCE_BASE = "https://api.binance.com";
