/**
 * ⚙️ V52.4 "Logic Leader" — 配置参数
 * ═══════════════════════════════════════
 * 双条件入场 + Fee Shield 5pt + 15s持仓保护 + $18保证金
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
// 核心参数 — V52.2 Fee Shield Recovery
// ═══════════════════════════════════════
export const LEVERAGE = 200;
export const ALLOW_SHORT = true;               // 多空双向开关
export const SL_POINTS = 8.0;                  // 固定 8 点硬止损 (永远有效)
export const TP_POINTS = 25.0;                 // 固定 25 点止盈
export const FEE_SHIELD_POINTS = 5.0;          // 🛡️ Fee Shield: 算法出场必须 >= 5pt 才允许 (V52.4)
export const MIN_HOLD_MS = 15_000;             // ⏱️ 15 秒最低持仓 (仅硬SL例外) (V52.4)
export const HARD_TIMEOUT_MS = 1_200_000;      // ⏰ 20 分钟硬超时 (1,200,000ms)

// ═══════════════════════════════════════
// Spread & Liquidity Gate
// ═══════════════════════════════════════
export const MAX_SPREAD_POINTS = 0.35;         // 价差 > 0.35pt 禁止进场
export const MIN_DEPTH_ETH = 50;               // Top3 深度 < 50 ETH 禁止进场

// ═══════════════════════════════════════
// BTC-SOL 联动共振参数 (模式 B)
// ═══════════════════════════════════════
export const BTC_IMBALANCE_RATIO = 4.0;        // BTC: 联动共振 4.0x (V52.4)
export const SOL_RESONANCE_RATIO = 2.5;        // SOL: 2.5 倍共振跟进
export const IMBALANCE_RATIO = 5.5;            // SOL 独立: 5.5 倍绝对失衡

// ═══════════════════════════════════════
// BTC 领路自动切换参数 (模式 C)
// ═══════════════════════════════════════
// V52.4 双条件入场:
//   条件 A: BTC >= 4.0x AND ETH效率 >= 1.0 (BTC 强力驱动)
//   条件 B: BTC >= 2.5x AND ETH效率 >= 2.0 (ETH 强效率驱动)
export const BTC_LEAD_STRONG = 4.0;            // 条件 A: BTC 强力 4.0x
export const ETH_EFF_WITH_STRONG_BTC = 1.0;    // 条件 A: ETH效率 >= 1.0
export const BTC_LEAD_WEAK = 2.5;              // 条件 B: BTC 弱力 2.5x
export const ETH_EFF_WITH_WEAK_BTC = 2.0;      // 条件 B: ETH效率 >= 2.0
export const SOL_MIN_EFFICIENCY = 1.0;         // SOL 最低效率门槛 (V52.4 放宽)
export const ETH_MIN_EFFICIENCY = 1.0;         // ETH 效率门槛 (V52.4 放宽)

// ═══════════════════════════════════════
// 效率 & 进场门槛
// ═══════════════════════════════════════
export const EFFICIENCY_ABS_THRESHOLD = 2.0;   // 绝对效率门槛 (V52.4 放宽)
export const EFFICIENCY_DECAY = 0.2;           // 效率衰竭阈值
export const VOL_SPIKE_MULT = 3;               // 成交量暴增倍数

// ═══════════════════════════════════════
// CVD 方向一致性确认
// ═══════════════════════════════════════
export const CVD_CONFIRM_TICKS = 3;            // Delta 方向确认: 最近 3 笔必须方向一致

// ═══════════════════════════════════════
// 放量倒货止盈 (Dump Detection)
// ═══════════════════════════════════════
export const DUMP_EFF_THRESHOLD = 0.15;
export const DUMP_VOL_MULT = 1.5;              // 成交量暴增 1.5 倍

// ═══════════════════════════════════════
// 仓位 & 风控
// ═══════════════════════════════════════
export const MARGIN_DEFAULT = 18;              // $18/单 (余额 $140 可扛 ~6 连亏) — V52.4
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
