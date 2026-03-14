/**
 * ⚙️ V66 "LEVIATHAN" — 配置参数
 * ═══════════════════════════════════════
 * 15M 结构性趋势交易 + Iron Guard + 复利
 */

// ═══════════════════════════════════════
// 交易对 & API — 三币种监控
// ═══════════════════════════════════════
export const SYMBOL = "SOLUSDT";               // 默认主交易对
export const ETH_SYMBOL = "ETHUSDT";           // ETH 主力交易对
export const BTC_SYMBOL = "BTCUSDT";           // BTC 联动监控
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
// 核心参数 — V66 LEVIATHAN
// ═══════════════════════════════════════
export const LEVERAGE = 200;
export const ALLOW_SHORT = true;
export const SL_POINTS = 8.0;                  // 初始硬止损 8pt (永远有效)
export const TAKER_FEE = 0.0004;

// ═══════════════════════════════════════
// 15M 结构性入场
// ═══════════════════════════════════════
export const BTC_ENTRY_RATIO = 4.0;            // BTC Lead 入场门槛
export const CANDLE_LOOKBACK = 2;              // 看最近 2 根 15M K线
export const CANDLE_POLL_MS = 30_000;          // K线轮询间隔 30s

// ═══════════════════════════════════════
// Iron Guard — 结构性出场
// ═══════════════════════════════════════
export const STRUCT_SL_BUFFER = 1.5;           // 结构止损缓冲 (prev 15M high/low ±1.5pt)

// ═══════════════════════════════════════
// Zero-Risk Gate
// ═══════════════════════════════════════
export const ZERO_RISK_THRESHOLD = 20.0;       // 利润 ≥ 20pt → SL移到entry+1pt
export const ZERO_RISK_SL_OFFSET = 1.0;        // Zero-Risk SL偏移

// ═══════════════════════════════════════
// Spread & Liquidity Gate
// ═══════════════════════════════════════
export const MAX_SPREAD_POINTS = 0.35;
export const MIN_DEPTH_ETH = 50;

// ═══════════════════════════════════════
// 复利保证金阶梯
// ═══════════════════════════════════════
export const MARGIN_DEFAULT = 20;              // 基础 $20 (余额 <$500)
export const MARGIN_TIERS: { minBalance: number; margin: number }[] = [
    { minBalance: 2000, margin: 400 },
    { minBalance: 1000, margin: 150 },
    { minBalance: 500,  margin: 60 },
];

/** 根据余额自动计算保证金 */
export function getMargin(balance: number): number {
    for (const tier of MARGIN_TIERS) {
        if (balance >= tier.minBalance) return tier.margin;
    }
    return MARGIN_DEFAULT;
}

// ═══════════════════════════════════════
// 冷却 & 安全
// ═══════════════════════════════════════
export const COOLDOWN_MS = 30_000;             // V66: 冷却 30s (15M策略不需太短)
export const WS_LAG_MAX_MS = 500;
export const MAX_DAILY_TRADES = 10;
export const MAX_DAILY_LOSS = 100;

// ═══════════════════════════════════════
// 效率追踪 (保留用于WS引擎)
// ═══════════════════════════════════════
export const EFFICIENCY_WINDOW = 100;
export const AVG_VOL_WINDOW = 200;

// ═══════════════════════════════════════
// 时段限制 (UTC+8)
// ═══════════════════════════════════════
export const TRADE_HOUR_START = 0;
export const TRADE_HOUR_END = 23;              // V66: 24h 趋势交易
