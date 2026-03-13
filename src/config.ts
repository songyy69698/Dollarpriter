/**
 * ⚙️ SOL 狙击手 v2.0 — 配置参数
 * ═══════════════════════════════════════
 * BTC 领路 + SOL/ETH 自动切换 + 200x 因果套利
 */

// ═══════════════════════════════════════
// 交易对 & API — 三币种监控
// ═══════════════════════════════════════
export const SYMBOL = "SOLUSDT";               // 默认主交易对
export const ETH_SYMBOL = "ETHUSDT";           // ETH 备选交易对
export const BTC_SYMBOL = "BTCUSDT";           // BTC 联动监控
export const BITUNIX_BASE = "https://fapi.bitunix.com";
export const BITUNIX_WS_PUBLIC = "wss://fapi.bitunix.com/public/";

// ═══════════════════════════════════════
// 交易对精度表 (动态切换用)
// ═══════════════════════════════════════
export const SYMBOL_PRECISION: Record<string, { qty: number; price: number }> = {
    SOLUSDT: { qty: 1, price: 3 },             // SOL: 0.1 SOL, $xxx.xxx
    ETHUSDT: { qty: 3, price: 2 },             // ETH: 0.001 ETH, $xxxx.xx
};

// ═══════════════════════════════════════
// 核心因果参数 — SOL 独立狙击 (模式 A)
// ═══════════════════════════════════════
export const LEVERAGE = 200;
export const IMBALANCE_RATIO = 5.5;            // SOL 独立: 5.5 倍绝对失衡
export const ALLOW_SHORT = true;               // 多空双向开关: true=多空都做, false=只做多
export const STOP_LOSS_PCT = 0.0015;           // 0.15% 物理止损
export const BE_TARGET_PCT = 0.0012;           // 0.12% 保本锁定

// ═══════════════════════════════════════
// BTC-SOL 联动共振参数 (模式 B)
// ═══════════════════════════════════════
export const BTC_IMBALANCE_RATIO = 3.0;        // BTC: 3.0 倍冲击力
export const SOL_RESONANCE_RATIO = 2.5;        // SOL: 2.5 倍共振跟进

// ═══════════════════════════════════════
// BTC 领路自动切换参数 (模式 C)
// ═══════════════════════════════════════
export const BTC_AUTO_SWITCH_RATIO = 3.0;      // BTC 3.0 倍触发自动切换判断
export const SOL_MIN_EFFICIENCY = 1.0;         // SOL 最低效率门槛 (REAL模式)
export const ETH_MIN_EFFICIENCY = 0.8;         // ETH 兜底效率门槛

// ═══════════════════════════════════════
// 效率 & 进场门槛
// ═══════════════════════════════════════
export const EFFICIENCY_ABS_THRESHOLD = 1.0;   // 绝对效率门槛 (REAL模式)
export const EFFICIENCY_DECAY = 0.2;           // 效率衰竭阈值
export const VOL_SPIKE_MULT = 3;               // 成交量暴增倍数

// ═══════════════════════════════════════
// 1.5 秒惯性校验 (Momentum Check) — 仅实盘
// ═══════════════════════════════════════
export const MOMENTUM_CHECK_MS = 1500;
export const MOMENTUM_MIN_PCT = 0.0005;        // 0.05%

// ═══════════════════════════════════════
// 放量倒货止盈 (Dump Detection)
// ═══════════════════════════════════════
export const DUMP_EFF_THRESHOLD = 0.15;
export const DUMP_VOL_MULT = 1.5;              // 成交量暴增 1.5 倍 (因大)

// ═══════════════════════════════════════
// 效率衰竭止盈最低利润门槛
// ═══════════════════════════════════════
export const MIN_PROFIT_FOR_DECAY = 0.001; // 至少赚 0.1% 才触发因果衰竭止盈

// ═══════════════════════════════════════
// 仓位 & 风控
// ═══════════════════════════════════════
export const MARGIN_DEFAULT = 20;              // $200 / 10份 = $20/单
export const TAKER_FEE = 0.0004;

// ═══════════════════════════════════════
// 冷却 & 安全
// ═══════════════════════════════════════
export const COOLDOWN_MS = 15_000;
export const WS_LAG_MAX_MS = 500;
export const MAX_DAILY_TRADES = 10;
export const MAX_DAILY_LOSS = 100;

// ═══════════════════════════════════════
// 效率追踪 (滑动窗口)
// ═══════════════════════════════════════
export const EFFICIENCY_WINDOW = 100;
export const AVG_VOL_WINDOW = 200;

// ═══════════════════════════════════════
// 时段限制 (UTC+8)
// ═══════════════════════════════════════
export const TRADE_HOUR_START = 0;
export const TRADE_HOUR_END = 19;
