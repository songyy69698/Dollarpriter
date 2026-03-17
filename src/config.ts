/**
 * 🏁 V80.3 DYNAMIC-STRIKE — 200x 物理规则风控
 * ═══════════════════════════════════════
 * 动态ETH仓位(1.5/3/5) + 吸能止盈 + 4pt止损
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
export const BTC_ENTRY_RATIO = 6.0;            // CEO: 领路 6x 就开枪
export const BREAKOUT_POWER_MIN = 3.0;         // 能量击穿 L1 牆 ≥ 3x
export const ENTRY_WALL_RATIO_LONG = 2.0;      // LONG: bid/ask 牆比 > 2.0 (支撑强)
export const ENTRY_WALL_RATIO_SHORT = 0.5;     // SHORT: bid/ask 牆比 < 0.5 (压制强)

// ═══════════════════════════════════════
// V80 出场：吸能 + 牆压
// ═══════════════════════════════════════
export const ABSORPTION_EFF_MIN = 0.15;        // 吸能止盈: 位移效率 < 0.15 (放量不动)
export const ABSORPTION_WALL_PRESS = 2.0;      // 吸能止盈: 同时须反向牆压 > 2x
export const ABSORPTION_PROFIT_MIN = 6;        // V80.3: 吸能止盈 ≥ 6pt
export const WALL_PRESSURE_EXIT = 3.0;         // 牆压止盈: 前方牆/后方牆 > 3x
export const WALL_PRESSURE_PROFIT_MIN = 6;     // V80.3: 同步 6pt

// ═══════════════════════════════════════
// Zero-Risk Gate
// ═══════════════════════════════════════
export const ZERO_RISK_THRESHOLD = 8.0;        // V80.3: 8pt 保本
export const ZERO_RISK_SL_OFFSET = 1.0;        // SL→Entry+1

// ═══════════════════════════════════════
// Spread & Liquidity Gate
// ═══════════════════════════════════════
export const MAX_SPREAD_POINTS = 0.35;
export const MIN_DEPTH_ETH = 50;

// ═══════════════════════════════════════
// 保证金 — V80 精确子弹
// ═══════════════════════════════════════
export const MARGIN_DEFAULT = 60;              // CEO: $60 子彈加大 ($400本金)
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
export const COOLDOWN_MS = 3_600_000;           // 1小时冷却 (每小时最多1单)
export const MIN_HOLD_MS = 30_000;             // 最少持仓 30s
export const WS_LAG_MAX_MS = 500;
export const MAX_DAILY_TRADES = 3;             // V80.3: 日限 3 单
export const MAX_DAILY_LOSS = 60;              // $400本金: 日亏换上限 $60

// ═══════════════════════════════════════
// K线 & WS 引擎参数
// ═══════════════════════════════════════
export const CANDLE_LOOKBACK = 4;
export const CANDLE_POLL_MS = 30_000;
export const EFFICIENCY_WINDOW = 100;
export const AVG_VOL_WINDOW = 200;

// ═══════════════════════════════════════
// V80.1 时段模式
// ═══════════════════════════════════════
export type TimeMode = "TREND" | "SCALP" | "ANTIFAKE" | "TITAN" | "SLEEP";

export interface TimeModeConfig {
    mode: TimeMode;
    btcThreshold: number;
    slPoints: number;
    allowBreakout: boolean;    // 是否允许追单
}

/** 根据 UTC+8 小时返回当前时段配置 */
export function getTimeMode(hour: number, minute: number = 0): TimeModeConfig {
    // 03:01-07:59 SLEEP
    if (hour >= 3 && hour < 8) {
        return { mode: "SLEEP", btcThreshold: Infinity, slPoints: 0, allowBreakout: false };
    }
    // 19:00-20:30 ANTIFAKE
    if (hour === 19 || (hour === 20 && minute <= 30)) {
        return { mode: "ANTIFAKE", btcThreshold: 6, slPoints: 6, allowBreakout: false };
    }
    // 20:31-03:00 TITAN
    if (hour >= 21 || hour < 3 || (hour === 20 && minute > 30)) {
        return { mode: "TITAN", btcThreshold: 6, slPoints: 6, allowBreakout: true };
    }
    // 08:00-10:59 TREND
    if (hour >= 8 && hour < 11) {
        return { mode: "TREND", btcThreshold: 6, slPoints: 4, allowBreakout: true };
    }
    // 11:00-18:59 SCALP
    return { mode: "SCALP", btcThreshold: 6, slPoints: 4, allowBreakout: true };
}

// ═══════════════════════════════════════
// V80.1 振幅疲劳仪
// ═══════════════════════════════════════
export const FATIGUE_BLOCK_THRESHOLD = 0.7;    // fatigue > 0.7 禁止追单
export const FATIGUE_HARVEST_THRESHOLD = 0.9;  // fatigue > 0.9 启动收割 / 允许反转
export const AMPLITUDE_HISTORY_DAYS = 70;      // 平均振幅计算天数
export const REVERSAL_BTC_THRESHOLD = 15;      // 反转单 BTC 门槛
export const REVERSAL_EFF_MAX = 0.1;           // 反转单 吸收效率上限

