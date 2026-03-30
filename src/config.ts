/**
 * 🧠 V3 Order Flow Bot — 配置中心
 * ═══════════════════════════════════════
 * Bitunix ETHUSDT | 150x Max | 11-Gate Chain
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
// V3 核心参数
// ═══════════════════════════════════════
export const LEVERAGE = 150;
export const TAKER_FEE = 0.0004;

// ═══════════════════════════════════════
// V3 风控
// ═══════════════════════════════════════
export const MAX_DAILY_TRADES = 4;
export const MAX_DAILY_LOSS = 100;
export const SL_MIN_PT = 15.0;

// ═══════════════════════════════════════
// WS & K线引擎
// ═══════════════════════════════════════
export const EFFICIENCY_WINDOW = 100;
export const AVG_VOL_WINDOW = 200;

// Binance (K线数据)
export const BINANCE_BASE = "https://api.binance.com";

// ═══════════════════════════════════════
// V300 订单流检测阈值
// ═══════════════════════════════════════
export const VA_PERCENTAGE = 0.70;
export const ABSORPTION_VOL_MIN = 5;
export const ABSORPTION_PRICE_MAX = 0.5;
export const ABSORPTION_WINDOW_MS = 5_000;
export const SWEEP_LAYER_MIN = 3;
export const SWEEP_SPEED_MS = 2_000;
export const CVD_DIVERGE_THRESHOLD = 10;
export const FAKE_WALL_CANCEL_RATIO = 0.5;
export const DOM_LEVELS = 10;

// ═══════════════════════════════════════
// 冷却 & 安全
// ═══════════════════════════════════════
export const MIN_HOLD_MS = 5_000;
