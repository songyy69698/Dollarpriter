/**
 * 🎯 V91 Mom12冠军策略 — 动量做空 + K棒形态 + 成交量
 * ═══════════════════════════════════════
 * 入场: 12根5m K线动量>40pt + 放量×2 + K棒上影线
 * 出场: SL8 → 保本5+1 → 跟踪15
 * 回测: $200→$939 (+$739) | 15笔 | 43%胜率
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
export const LEVERAGE = 200;
export const TAKER_FEE = 0.0004;
export const MARGIN_PER_TRADE = 50;         // $50/单 (200x=5ETH)

// ═══════════════════════════════════════
// Mom12 入场参数 (回测冠军)
// ═══════════════════════════════════════
export const MOM12_THRESHOLD = 40;          // 12根K线动量 > 40pt
export const VOL_MULTIPLIER = 2.0;          // 成交量 > 均量 × 2
export const BAR_UPPER_SHADOW_MIN = 0.25;   // 上影线占比 > 25%
export const BAR_BODY_MAX = 0.65;           // 或 实体占比 < 65%
export const ATR_BAN_THRESHOLD = 55;        // ATR > 55 禁入 (V50保护)
export const EMA200_PERIOD = 200;           // EMA200 趋势过滤

export interface WindowConfig {
    name: string;
    startHour: number;
    startMin: number;
    endHour: number;
    endMin: number;
}

/** CEO 规划的三个交易窗口 (UTC+8) */
export const TRADE_WINDOWS: WindowConfig[] = [
    { name: "08窗口", startHour: 8, startMin: 0, endHour: 9, endMin: 0 },
    { name: "15窗口", startHour: 15, startMin: 0, endHour: 16, endMin: 0 },
    { name: "22窗口", startHour: 22, startMin: 0, endHour: 23, endMin: 0 },
];

// ═══════════════════════════════════════
// 出场参数 (回测冠军: SL8→保本5+1→跟踪15)
// ═══════════════════════════════════════
export const INITIAL_SL_PT = 8.0;           // 止损 8pt
export const BREAKEVEN_PT = 5.0;            // 浮盈 5pt → 移保本
export const BREAKEVEN_SL_OFFSET = 1.0;     // 保本后 SL = 入场 + 1pt
export const TRAILING_PT = 15.0;            // 跟踪距离 15pt (让利润跑)
export const MAX_HOLD_BARS = 60;            // 5小时超时

// ═══════════════════════════════════════
// 冷却 & 安全
// ═══════════════════════════════════════
export const COOLDOWN_MS = 60_000;          // 1分钟冷却 (同窗口不重复)
export const MIN_HOLD_MS = 5_000;
export const WS_LAG_MAX_MS = 500;
export const MAX_DAILY_TRADES = 3;
export const MAX_DAILY_LOSS = 80;

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
