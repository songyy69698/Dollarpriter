/**
 * ⚙️ V69 "NO-EXCUSE" — 200x 绝地狙击配置
 * ═══════════════════════════════════════
 * $48 残局回血 + 绝对因果 + 光速保本
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
// 核心参数 — V69 NO-EXCUSE
// ═══════════════════════════════════════
export const LEVERAGE = 200;
export const ALLOW_SHORT = true;
export const SL_POINTS = 10.0;                 // V69: 10pt 硬止损 (200x生存极限)
export const TAKER_FEE = 0.0004;

// ═══════════════════════════════════════
// 15M 结构性入场
// ═══════════════════════════════════════
export const BTC_ENTRY_RATIO = 5.5;            // V69: 5.5x 只抓大户清场的「真因」
export const WALL_RATIO_MIN = 4.5;             // V69: 買賣牆比 ≥ 4.5x 才准进场
export const EFFICIENCY_MIN = 1.2;             // V69: 效率 ≥ 1.2 才进场
export const CANDLE_LOOKBACK = 4;              // V-FINAL: 看最近 4 根 15M K线 (更严格入场)
export const CANDLE_POLL_MS = 30_000;          // K线轮询间隔 30s


// ═══════════════════════════════════════
// Iron Guard — 结构性出场
// ═══════════════════════════════════════
export const STRUCT_SL_BUFFER = 0;             // V-FINAL: 无缓冲 (精确 prev 15M High/Low)

// ═══════════════════════════════════════
// Zero-Risk Gate
// ═══════════════════════════════════════
export const ZERO_RISK_THRESHOLD = 8.0;        // V69: 8pt 光速保本
export const ZERO_RISK_SL_OFFSET = 1.0;        // 保本SL偏移 (entry+1pt)

// ═══════════════════════════════════════
// Spread & Liquidity Gate
// ═══════════════════════════════════════
export const MAX_SPREAD_POINTS = 0.35;
export const MIN_DEPTH_ETH = 50;

// ═══════════════════════════════════════
// 复利保证金阶梯
// ═══════════════════════════════════════
export const MARGIN_DEFAULT = 15;              // V69: $15 (剩$48分成3颗子弹)
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
export const COOLDOWN_MS = 30_000;             // V69: 冷却 30s (15M策略不需太短)
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
export const TRADE_HOUR_END = 23;              // V69: 24h 趋势交易
