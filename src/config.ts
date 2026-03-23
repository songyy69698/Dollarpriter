/**
 * 🔥 V104 混合止盈版 — $250→$500
 * ═══════════════════════════════════════
 * 15m结构 + 5m 5条件入场 + 分批止盈
 * +35pt锁50% | trailing -12pt | 动态SL
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
export const LEVERAGE = 150;                // V92R: 150x
export const TAKER_FEE = 0.0004;
export const MARGIN_PER_TRADE = 50;         // 回退用
export const FIXED_QTY = 2.0;               // V104: 固定2ETH

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
    reverseDir?: boolean;  // V92R: 反POC方向
}

/** V104: Fire Candle 时间窗口 (UTC) */
export const FIRE_CANDLE_START_UTC = 8;    // Fire Candle 开始 UTC 08:00
export const FIRE_CANDLE_END_UTC = 12;     // Fire Candle 结束 UTC 12:00
export const TRADE_START_UTC = 12;          // 交易窗口开始 UTC 12:00
export const TRADE_END_UTC = 20;            // 交易窗口结束 UTC 20:00
export const FIRE_MIN_BODY_RATIO = 0.35;   // V104: 实体占比 ≥35%
export const FIRE_MIN_RANGE_PT = 35;       // V104: Fire范围 ≥35pt (三月6笔100%胜)

// V104: 诱导回踩过滤
export const INDUCEMENT_MIN_DEPTH_PT = 5;   // V104: 诱导深度 ≥5pt (回测最优)
export const INDUCEMENT_VOL_MULT = 1.3;     // 诱导量 > 均量×1.3

// V104: 5m入场5条件参数
export const ENTRY_VOL_MULT = 1.4;          // 入场量 > 均量×1.4
export const ENTRY_BODY_RATIO = 0.58;       // 入场阳线实体 ≥58%
export const ENTRY_RSI_MIN = 42;            // RSI下限
export const ENTRY_RSI_MAX = 65;            // RSI上限

// V104: Funding Rate 极端过滤
export const FUNDING_EXTREME = 0.0005;      // |Funding| > 0.05% → 不逆势

// V104: ATR 动态SL
export const SL_ATR_FLOOR = 15;             // ATR低→SL最少15pt
export const SL_ATR_CEILING = 22;           // ATR高→SL最多22pt
export const SL_ATR_BASELINE = 30;          // ATR基准值(正常波动)
export const SL_INDUCEMENT_PAD = 8;         // 诱导低点向外8pt

/** 兼容旧版 */
export const TRADE_WINDOWS: WindowConfig[] = [
    { name: "Fire窗口", startHour: 20, startMin: 0, endHour: 4, endMin: 0, reverseDir: false },
];

// ═══════════════════════════════════════
// V104 出场: 分批止盈 + trailing + 动态SL
// ═══════════════════════════════════════
export const SL_ATR_MULT = 1.0;
export const SL_MIN_PT = 15.0;              // V104: SL下限15pt
export const SL_MAX_PT = 22.0;              // V104: SL上限22pt
export const INITIAL_SL_PT = 18.0;          // V104: 默认SL 18pt
export const TP_RR_RATIO = 5;               // 保留兼容
export const TARGET_BALANCE = 500;          // 🎯 达标停止
export const BREAKEVEN_PT = 12.0;           // V104: +12pt 移保本 (回测最优)
export const BREAKEVEN_SL_OFFSET = 2.0;     // V104: 保本SL +2pt
export const TRAILING_PT = 12.0;            // V104: trailing -12pt
export const PARTIAL_TP_PT = 35;            // V104: +35pt 平50%
export const FULL_TP_PT = 100;              // V104: +100pt 全平
export const MAX_HOLD_BARS = 120;           // 10小时超时

// ═══════════════════════════════════════
// V92 动态仓位 (每单风险 ≤ 账户 1%)
// ═══════════════════════════════════════
export const RISK_PCT = 0.10;               // V96实测: 每单最大亏损 = 账户 × 10%
export const POS_SIZE_LEVERAGE = 15;        // 仓位计算用15x (保守)

// ═══════════════════════════════════════
// 冷却 & 安全
// ═══════════════════════════════════════
export const COOLDOWN_MS = 60_000;
export const MIN_HOLD_MS = 5_000;
export const WS_LAG_MAX_MS = 500;
export const MAX_DAILY_TRADES = 4;           // V104: 每天4笔
export const MAX_DAILY_LOSS = 80;            // V104: $80日亏损限制
export const MAX_CONSEC_LOSSES = 2;          // V104: 连亏2笔停当天

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
export const ENTRY_QTY = 3.0;              // V92R: 固定3ETH

// ═══════════════════════════════════════
// Binance API (K线数据用)
// ═══════════════════════════════════════
export const BINANCE_BASE = "https://api.binance.com";
export const RSI_PERIOD = 14;

// ═══════════════════════════════════════
// MTF-POC 共振 + 回调入场
// ═══════════════════════════════════════
export const MTF_ENABLED = true;                // 启用 MTF 共振过滤
export const MTF_MIN_SCORE = 6;                 // 至少6/12个TF方向一致
export const MTF_REFRESH_MS = 60_000;           // 每60秒刷新
export const PULLBACK_ZONE_PT = 5;              // POC ±5pt = 回调到位
export const MAX_CHASE_PT = 15;                 // 超过POC 15pt = 不追
