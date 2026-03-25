/**
 * 🤖 Bot 自动交易系统 — 五模组完整回测
 * ═══════════════════════════════════════════════════════════════
 * 模组一: 时间过滤器 (H4循环 + 交易窗口 + 强制平仓)
 * 模组二: SVP环境感知 (POC位移 + 定性定量K线 + 边缘回补)
 * 模组三: 进场触发 (攻击日 + 引线回补 + 支撑测试)
 * 模组四: 执行效能 (3小时时效律 + 平均波动止盈)
 * 模组五: 风险管理 (凯利公式 + 2%止损 + 走三退一)
 *
 * ETHUSDT | $500 本金 | 150x | 2026年3月
 */

// ═══════════════════════════════════════
// 核心常量
// ═══════════════════════════════════════
const LEVERAGE = 150;
const TAKER_FEE = 0.0004;
const INITIAL_CAPITAL = 500;
const UTC8_OFFSET = 8 * 3600000;

// ═══════════════════════════════════════
// 数据类型
// ═══════════════════════════════════════
interface K {
    ts: number; o: number; h: number; l: number; c: number; v: number;
}

interface TradeLog {
    date: string; window: string; side: string;
    entry: number; exit: number; qty: number;
    pnlPt: number; pnlNet: number; reason: string;
    kellyF: number; holdBars: number;
}

interface Result {
    mode: string; trades: number; wins: number; pnl: number;
    wr: number; avgW: number; avgL: number; dd: number; pf: number;
    logs: TradeLog[];
    exitReasons: Record<string, number>;
    windowStats: Record<string, { trades: number; wins: number; pnl: number }>;
    moduleStats: {
        timeFiltered: number;
        pocFiltered: number;
        noEntry: number;
        staleExit: number;
        avgRangeTP: number;
        kellyStopped: number;
        cooldownSkipped: number;
        noonForced: number;
    };
}

// ═══════════════════════════════════════
// 数据获取 (复用项目模式)
// ═══════════════════════════════════════
async function fetchK(symbol: string, interval: string, sMs: number, eMs: number): Promise<K[]> {
    const all: K[] = []; let cur = sMs;
    while (cur < eMs) {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cur}&endTime=${eMs}&limit=1500`;
        const res = await fetch(url);
        if (!res.ok) { await Bun.sleep(5000); continue; }
        const data = (await res.json()) as any[][];
        if (!data.length) break;
        for (const k of data) all.push({ ts: k[0] as number, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
        cur = (data[data.length - 1][6] as number) + 1;
        await Bun.sleep(150);
    }
    return all;
}

// ═══════════════════════════════════════════════════════════════
// 模组一: 时间过滤器 (Time-Window Scheduler)
// ═══════════════════════════════════════════════════════════════

interface TradeWindow {
    name: string;
    startH: number; endH: number; // UTC+8 小时
    isAsian: boolean;              // 亚盘仓位 → 12:00午强制平仓
}

const TRADE_WINDOWS: TradeWindow[] = [
    { name: "亚盘确立",     startH: 9,  endH: 10, isAsian: true },
    { name: "规律最强",     startH: 15, endH: 16, isAsian: false },
    { name: "波动峰值A",    startH: 20, endH: 22, isAsian: false },
    { name: "波动峰值B",    startH: 22, endH: 24, isAsian: false },
];

const NOISE_ZONE_START = 8;  // UTC+8 08:00
const NOISE_ZONE_END = 9;    // UTC+8 09:00
const NOON_FORCE_CLOSE_H = 12; // UTC+8 12:00 强制平仓亚盘仓位

function utc8Hour(ts: number): number {
    return new Date(ts + UTC8_OFFSET).getUTCHours();
}

function utc8Min(ts: number): number {
    return new Date(ts + UTC8_OFFSET).getUTCMinutes();
}

function utc8Date(ts: number): string {
    return new Date(ts + UTC8_OFFSET).toISOString().slice(0, 10);
}

function isInNoiseZone(ts: number): boolean {
    const h = utc8Hour(ts);
    return h >= NOISE_ZONE_START && h < NOISE_ZONE_END;
}

function getActiveWindow(ts: number): TradeWindow | null {
    const h = utc8Hour(ts);
    for (const w of TRADE_WINDOWS) {
        if (h >= w.startH && h < w.endH) return w;
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════
// 模组二: SVP 环境感知 (POC & Volume Awareness)
// ═══════════════════════════════════════════════════════════════

/** 计算一组 K 线的 POC (Volume-Weighted Typical Price) */
function calcPOC(kl: K[]): number {
    if (!kl.length) return 0;
    let maxV = 0, poc = 0;
    for (const k of kl) {
        if (k.v > maxV) { maxV = k.v; poc = (k.h + k.l + k.c) / 3; }
    }
    return poc;
}

/** POC 位移: 比较前后两段 4H 的 POC */
function calcPocShift(k4h: K[], ts: number): { shift: number; dir: string } {
    const before = k4h.filter(k => k.ts <= ts);
    if (before.length < 2) return { shift: 0, dir: "" };
    const curr = before[before.length - 1];
    const prev = before[before.length - 2];
    const shift = calcPOC([curr]) - calcPOC([prev]);
    return { shift, dir: shift > 5 ? "long" : shift < -5 ? "short" : "" };
}

/** 定性定量 K 线: 大实体 + 放量 = 主力攻击 */
function isAggressiveBar(k: K, avgVol: number): { qualitative: boolean; quantitative: boolean; dir: string } {
    const body = Math.abs(k.c - k.o);
    const range = k.h - k.l;
    if (range < 1) return { qualitative: false, quantitative: false, dir: "" };

    const qualitative = body / range > 0.7;    // 大阳/大阴: 实体 > 70% 范围
    const quantitative = k.v > avgVol * 1.5;   // 成交量放大 > 1.5x 均量
    const dir = k.c > k.o ? "long" : "short";

    return { qualitative, quantitative, dir };
}

/** SVP 边缘检测: 价格远离 POC → 预期回补 */
function isNearValueEdge(price: number, poc: number, rangeStddev: number): boolean {
    return Math.abs(price - poc) > rangeStddev * 1.5;
}

/** 计算 K 线范围的标准差 */
function calcRangeStddev(kl: K[], period: number): number {
    if (kl.length < period) return 50;
    const ranges = kl.slice(-period).map(k => k.h - k.l);
    const avg = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    const variance = ranges.reduce((a, r) => a + (r - avg) ** 2, 0) / ranges.length;
    return Math.sqrt(variance);
}

// ═══════════════════════════════════════════════════════════════
// 模组三: 进场触发 (Entry Triggers)
// ═══════════════════════════════════════════════════════════════

/** 攻击日: 前根长影线 → 次根实体突破 */
function detectAttackDay(prev: K, curr: K): "long" | "short" | null {
    const prevRange = prev.h - prev.l;
    if (prevRange < 2) return null;

    const prevUpperShadow = prev.h - Math.max(prev.o, prev.c);
    const prevLowerShadow = Math.min(prev.o, prev.c) - prev.l;
    const currBody = Math.abs(curr.c - curr.o);
    const currRange = curr.h - curr.l;

    // 做空: 前根长上影线 → 次根实体突破影线高点
    if (prevUpperShadow / prevRange > 0.4 && curr.c < prev.l && currBody / (currRange + 0.01) > 0.5) {
        return "short";
    }

    // 做多: 前根长下影线 → 次根实体突破影线低点
    if (prevLowerShadow / prevRange > 0.4 && curr.c > prev.h && currBody / (currRange + 0.01) > 0.5) {
        return "long";
    }

    return null;
}

/** 引线回补: 跌破下影线后快速收回 */
function detectWickReclaim(kl: K[], idx: number): "long" | "short" | null {
    if (idx < 3) return null;

    const curr = kl[idx];
    const prev1 = kl[idx - 1];
    const prev2 = kl[idx - 2];

    // 做多引线回补: prev2 有下影线 → prev1 跌破该低点 → curr 收回至 prev2 的实体下沿之上
    const prev2LowerShadow = Math.min(prev2.o, prev2.c) - prev2.l;
    const prev2Body = Math.abs(prev2.c - prev2.o);
    if (prev2LowerShadow > prev2Body * 0.5 && prev2LowerShadow > 2) {
        const breakLevel = prev2.l;
        const reclaimLevel = Math.min(prev2.o, prev2.c);
        if (prev1.l < breakLevel && curr.c > reclaimLevel && curr.c > curr.o) {
            return "long";
        }
    }

    // 做空引线回补: prev2 有上影线 → prev1 突破该高点 → curr 收回至 prev2 的实体上沿之下
    const prev2UpperShadow = prev2.h - Math.max(prev2.o, prev2.c);
    if (prev2UpperShadow > prev2Body * 0.5 && prev2UpperShadow > 2) {
        const breakLevel = prev2.h;
        const reclaimLevel = Math.max(prev2.o, prev2.c);
        if (prev1.h > breakLevel && curr.c < reclaimLevel && curr.c < curr.o) {
            return "short";
        }
    }

    return null;
}

/** 支撑/阻力测试次数 (替代 DOM 真假墙) */
function detectLevelTest(kl: K[], idx: number, tolerance: number = 3): { support: number; resistance: number; supportLevel: number; resistanceLevel: number } {
    if (idx < 20) return { support: 0, resistance: 0, supportLevel: 0, resistanceLevel: 0 };

    const lookback = kl.slice(Math.max(0, idx - 20), idx);
    const curr = kl[idx];

    // 找最近的低点作为支撑
    let minL = Infinity, maxH = 0;
    for (const k of lookback) {
        if (k.l < minL) minL = k.l;
        if (k.h > maxH) maxH = k.h;
    }

    // 计算触碰次数
    let supportTests = 0, resistanceTests = 0;
    for (const k of lookback) {
        if (Math.abs(k.l - minL) < tolerance) supportTests++;
        if (Math.abs(k.h - maxH) < tolerance) resistanceTests++;
    }

    return { support: supportTests, resistance: resistanceTests, supportLevel: minL, resistanceLevel: maxH };
}

// ═══════════════════════════════════════════════════════════════
// 模组四: 执行效能 (Execution Efficiency)
// ═══════════════════════════════════════════════════════════════

const MAX_HOLD_BARS_5M = 36;   // 3小时 = 36根5m
const STALE_THRESHOLD_PT = 5;  // 3小时内波幅 < 5pt = 行情未发动

/** 计算 H1 平均波幅 */
function calcAvgH1Range(k1h: K[], ts: number, period: number = 14): number {
    const before = k1h.filter(k => k.ts <= ts);
    if (before.length < period) return 30; // 默认 30pt
    const recent = before.slice(-period);
    return recent.reduce((sum, k) => sum + (k.h - k.l), 0) / period;
}

/** 是否行情停滞 (3小时内无波动) */
function isStale(kl5m: K[], startIdx: number, currentIdx: number): boolean {
    if (currentIdx - startIdx < MAX_HOLD_BARS_5M) return false;
    const slice = kl5m.slice(startIdx, currentIdx + 1);
    const maxH = Math.max(...slice.map(k => k.h));
    const minL = Math.min(...slice.map(k => k.l));
    return (maxH - minL) < STALE_THRESHOLD_PT;
}

// ═══════════════════════════════════════════════════════════════
// 模组五: 风险管理 (Risk Engine)
// ═══════════════════════════════════════════════════════════════

/** 凯利公式: F = (bp - q) / b */
function kellyFraction(winRate: number, avgWin: number, avgLoss: number): number {
    if (avgLoss === 0 || winRate <= 0) return 0;
    const b = avgWin / Math.abs(avgLoss);  // 盈亏比
    const p = winRate;
    const q = 1 - p;
    const f = (b * p - q) / b;
    if (f <= 0) return 0;           // 预期值为负 → 禁止开单
    return Math.min(f, 0.25);       // 上限 25%，严禁 all-in
}

/** 2% 止损: 每笔亏损 ≤ 本金 2% */
function calcRisk2SL(balance: number, qty: number): number {
    const maxLoss = balance * 0.02;
    return maxLoss / qty;
}

/** 根据凯利比例计算仓位 */
function calcKellyQty(balance: number, kellyF: number, price: number, slPt: number): number {
    if (kellyF <= 0 || slPt <= 0) return 0;
    const riskAmount = balance * kellyF;
    const qty = riskAmount / slPt;
    // 以杠杆约束上限
    const maxQty = (balance * LEVERAGE) / price;
    return Math.min(qty, maxQty, 10.0);  // 硬上限 10 ETH
}

// ═══════════════════════════════════════════════════════════════
// 辅助指标
// ═══════════════════════════════════════════════════════════════

function calcRSI(closes: number[], p = 14): number {
    if (closes.length < p + 1) return 50;
    let g = 0, l = 0;
    for (let i = closes.length - p; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) g += d; else l += -d;
    }
    const ag = g / p, al = l / p;
    return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function calcATR(kl: K[], p = 14): number {
    if (kl.length < p) return 0;
    let s = 0;
    for (let i = kl.length - p; i < kl.length; i++) s += kl[i].h - kl[i].l;
    return s / p;
}

/** 计算窗口内均量(近20根5m) */
function getAvgVol(kl: K[], idx: number, lookback: number = 20): number {
    const start = Math.max(0, idx - lookback);
    const slice = kl.slice(start, idx);
    if (slice.length === 0) return 1;
    return slice.reduce((s, k) => s + k.v, 0) / slice.length;
}

// ═══════════════════════════════════════════════════════════════
// 持仓管理
// ═══════════════════════════════════════════════════════════════

interface Position {
    side: "long" | "short";
    entry: number;
    qty: number;
    idx: number;        // 入场 5m bar index
    window: TradeWindow;
    slPt: number;       // 止损点数
    tpPt: number;       // 止盈点数 (avgRange * 0.7)
    kellyF: number;     // 本次凯利比例
}

// ═══════════════════════════════════════════════════════════════
// 策略模式
// ═══════════════════════════════════════════════════════════════

type StratMode = "baseline" | "full_5module" | "no_kelly" | "wide_window";

const MODE_LABELS: Record<StratMode, string> = {
    baseline:     "① 基线(仅窗口+POC)",
    full_5module: "② 五模组全激活",
    no_kelly:     "③ 无凯利(固定仓位)",
    wide_window:  "④ 宽窗口(H4全覆盖)",
};

// ═══════════════════════════════════════════════════════════════
// 主引擎
// ═══════════════════════════════════════════════════════════════

function run(
    kl5m: K[], k1h: K[], k4h: K[],
    mode: StratMode
): Result {
    let bal = INITIAL_CAPITAL;
    let pos: Position | null = null;
    let trades = 0, wins = 0, netPnl = 0;
    const wp: number[] = [], lp: number[] = [];
    let maxB = INITIAL_CAPITAL, maxDD = 0;
    let curDay = "", dailyTrades = 0, dailyPnl = 0;
    const usedWindows = new Set<string>();
    const logs: TradeLog[] = [];
    const exitReasons: Record<string, number> = {};
    const windowStats: Record<string, { trades: number; wins: number; pnl: number }> = {};

    // 模组统计
    const ms = {
        timeFiltered: 0, pocFiltered: 0, noEntry: 0,
        staleExit: 0, avgRangeTP: 0, kellyStopped: 0,
        cooldownSkipped: 0, noonForced: 0,
    };

    // 走三退一: 连赢追踪
    let consecutiveWins = 0;
    let cooldownUntilDay = "";

    // 凯利公式滚动统计
    let rollingWins = 0, rollingTotal = 0;
    let rollingWinSum = 0, rollingLossSum = 0;

    // 宽窗口模式: 覆盖所有 H4 区块
    const wideWindows: TradeWindow[] = [
        { name: "H4-0004", startH: 0,  endH: 4,  isAsian: false },
        { name: "H4-0408", startH: 4,  endH: 8,  isAsian: false },
        { name: "H4-0812", startH: 8,  endH: 12, isAsian: true },
        { name: "H4-1216", startH: 12, endH: 16, isAsian: false },
        { name: "H4-1620", startH: 16, endH: 20, isAsian: false },
        { name: "H4-2024", startH: 20, endH: 24, isAsian: false },
    ];

    function getWindowForMode(ts: number): TradeWindow | null {
        if (mode === "wide_window") {
            const h = utc8Hour(ts);
            for (const w of wideWindows) {
                if (h >= w.startH && h < w.endH) return w;
            }
            return null;
        }
        return getActiveWindow(ts);
    }

    for (let i = 50; i < kl5m.length; i++) {
        const k = kl5m[i];
        const day = utc8Date(k.ts);
        const h = utc8Hour(k.ts);
        const m = utc8Min(k.ts);

        // 每日重置
        if (day !== curDay) {
            curDay = day;
            dailyTrades = 0;
            dailyPnl = 0;
            usedWindows.clear();
        }

        // ═══ 持仓管理 ═══
        if (pos) {
            const holdBars = i - pos.idx;
            const pt = pos.side === "long" ? k.c - pos.entry : pos.entry - k.c;
            const ptWorst = pos.side === "long" ? k.l - pos.entry : pos.entry - k.h;
            let exitPrice = 0, reason = "";

            // 层1: 硬止损 (Risk 2%)
            if (ptWorst <= -pos.slPt) {
                exitPrice = pos.side === "long" ? pos.entry - pos.slPt : pos.entry + pos.slPt;
                reason = "SL";
            }

            // 层2: 平均波动止盈 (模组四)
            if (!exitPrice && pt >= pos.tpPt) {
                exitPrice = k.c;
                reason = "AVG_TP";
                ms.avgRangeTP++;
            }

            // 层3: 亚盘仓位 12:00 强制平仓 (模组一)
            if (!exitPrice && pos.window.isAsian && h >= NOON_FORCE_CLOSE_H) {
                exitPrice = k.c;
                reason = "NOON_FORCE";
                ms.noonForced++;
            }

            // 层4: 3小时时效律 (模组四)
            if (!exitPrice && holdBars >= MAX_HOLD_BARS_5M) {
                if (isStale(kl5m, pos.idx, i)) {
                    exitPrice = k.c;
                    reason = "STALE_3H";
                    ms.staleExit++;
                } else {
                    // 有波动但超时 → 仍然平仓
                    exitPrice = k.c;
                    reason = "TIMEOUT_3H";
                }
            }

            // 层5: 窗口结束平仓 (当前窗口结束)
            if (!exitPrice) {
                const stillInWindow = getWindowForMode(k.ts);
                if (!stillInWindow || stillInWindow.name !== pos.window.name) {
                    exitPrice = k.c;
                    reason = "WIN_CLOSE";
                }
            }

            if (exitPrice > 0) {
                const finalPt = pos.side === "long" ? exitPrice - pos.entry : pos.entry - exitPrice;
                const fee = (pos.entry * pos.qty + exitPrice * pos.qty) * TAKER_FEE;
                const net = finalPt * pos.qty - fee;

                bal += net; trades++; dailyTrades++; dailyPnl += net; netPnl += net;

                // 更新凯利滚动统计
                rollingTotal++;
                if (net > 0) {
                    rollingWins++;
                    rollingWinSum += net;
                    wins++;
                    wp.push(net);
                    consecutiveWins++;
                } else {
                    rollingLossSum += Math.abs(net);
                    lp.push(net);
                    consecutiveWins = 0;
                }

                // 走三退一 (模组五)
                if (consecutiveWins >= 3 && mode !== "baseline") {
                    cooldownUntilDay = day; // 本日剩余时间不开单
                    consecutiveWins = 0;
                }

                if (bal > maxB) maxB = bal;
                const dd = maxB - bal;
                if (dd > maxDD) maxDD = dd;

                exitReasons[reason] = (exitReasons[reason] || 0) + 1;

                const wName = pos.window.name;
                if (!windowStats[wName]) windowStats[wName] = { trades: 0, wins: 0, pnl: 0 };
                windowStats[wName].trades++;
                if (net > 0) windowStats[wName].wins++;
                windowStats[wName].pnl += net;

                logs.push({
                    date: day, window: wName, side: pos.side,
                    entry: pos.entry, exit: exitPrice, qty: pos.qty,
                    pnlPt: finalPt, pnlNet: net, reason,
                    kellyF: pos.kellyF, holdBars,
                });
                pos = null;
            }
            continue;
        }

        // ═══ 入场条件检查 ═══
        if (bal < 30) continue;

        // 模组五: 走三退一冷却
        if (cooldownUntilDay === day && mode !== "baseline") {
            ms.cooldownSkipped++;
            continue;
        }

        // 模组一: 噪音过滤 (08-09 UTC+8)
        if (mode !== "baseline" && mode !== "wide_window") {
            if (isInNoiseZone(k.ts)) {
                ms.timeFiltered++;
                continue;
            }
        }

        // 检查交易窗口
        const activeWindow = getWindowForMode(k.ts);
        if (!activeWindow) continue;

        // 每窗口仅一笔
        const winKey = `${day}_${activeWindow.name}`;
        if (usedWindows.has(winKey)) continue;

        // 窗口前10分钟内寻找入场
        const minuteInWindow = (h - activeWindow.startH) * 60 + m;
        if (mode !== "wide_window" && minuteInWindow > 30) continue; // 窗口前30分钟内找点

        // ═══ 模组二: SVP 环境感知 ═══
        const pocInfo = calcPocShift(k4h, k.ts);

        if (mode !== "baseline") {
            // POC 无方向 → 跳过
            if (!pocInfo.dir) {
                ms.pocFiltered++;
                continue;
            }
        }

        // 定性定量 K 线检查 (15m 近3根)
        const avgVol = getAvgVol(kl5m, i, 20);
        let aggressiveDir = "";
        if (mode !== "baseline") {
            const k15mRecent = kl5m.slice(Math.max(0, i - 3), i + 1);
            for (const bar of k15mRecent) {
                const agg = isAggressiveBar(bar, avgVol);
                if (agg.qualitative && agg.quantitative) {
                    aggressiveDir = agg.dir;
                    break;
                }
            }
        }

        // 确定方向: POC方向为主，aggressive确认
        let dir: "long" | "short" | "" = "";
        if (mode === "baseline") {
            dir = pocInfo.dir as any || "";
            if (!dir) continue;
        } else {
            // POC方向优先
            if (pocInfo.dir === "long") dir = "long";
            else if (pocInfo.dir === "short") dir = "short";
            else continue;

            // aggressive方向若与POC矛盾 → 跳过
            if (aggressiveDir && aggressiveDir !== dir) {
                ms.pocFiltered++;
                continue;
            }
        }

        // SVP 边缘回补: 如果在边缘 → 预期反转
        if (mode !== "baseline") {
            const pocVal = calcPOC(k4h.filter(b => b.ts <= k.ts).slice(-1));
            const stddev = calcRangeStddev(kl5m.slice(Math.max(0, i - 50), i), 50);
            if (isNearValueEdge(k.c, pocVal, stddev)) {
                // 在 SVP 边缘 → 方向可能反转，额外确认
                if (dir === "long" && k.c > pocVal + stddev * 1.5) {
                    dir = "short"; // 高位边缘 → 看空回补
                } else if (dir === "short" && k.c < pocVal - stddev * 1.5) {
                    dir = "long";  // 低位边缘 → 看多回补
                }
            }
        }

        if (!dir) continue;

        // ═══ 模组三: 进场触发 ═══
        if (i < 2) continue;
        const prev = kl5m[i - 1];
        const prev2 = kl5m[i - 2];

        let triggered = false;

        if (mode === "baseline") {
            // 基线模式: POC方向直接进场
            triggered = true;
        } else {
            // 攻击日检测
            const attack = detectAttackDay(prev, k);
            if (attack === dir) triggered = true;

            // 引线回补检测
            if (!triggered) {
                const wick = detectWickReclaim(kl5m, i);
                if (wick === dir) triggered = true;
            }

            // 支撑/阻力测试 (替代真假墙)
            if (!triggered) {
                const levels = detectLevelTest(kl5m, i);
                if (dir === "long" && levels.support >= 3 && Math.abs(k.l - levels.supportLevel) < 5) {
                    triggered = true; // 多次测试支撑不破 → 做多
                }
                if (dir === "short" && levels.resistance >= 3 && Math.abs(k.h - levels.resistanceLevel) < 5) {
                    triggered = true; // 多次测试阻力不破 → 做空
                }
            }

            // 量价确认: 当前 bar 量能放大
            if (triggered && k.v < avgVol * 1.0) {
                triggered = false; // 无量不跟
                ms.noEntry++;
            }
        }

        if (!triggered) {
            ms.noEntry++;
            continue;
        }

        // ═══ 模组五: 风险计算 ═══

        // 凯利公式 (需要历史数据)
        let kF = 0.1; // 默认 10%
        if (mode === "full_5module" && rollingTotal >= 5) {
            const wr = rollingWins / rollingTotal;
            const avgW = rollingWins > 0 ? rollingWinSum / rollingWins : 1;
            const avgL = (rollingTotal - rollingWins) > 0
                ? rollingLossSum / (rollingTotal - rollingWins) : 1;
            kF = kellyFraction(wr, avgW, avgL);
            if (kF <= 0) {
                ms.kellyStopped++;
                continue; // 预期值为负 → 禁止开单
            }
        }

        // 2% 止损点数
        const avgRange = calcAvgH1Range(k1h, k.ts);
        const tpPt = avgRange * 0.7;     // 止盈: 均波 70%
        let qty: number;
        let slPt: number;

        if (mode === "no_kelly" || mode === "baseline") {
            qty = 1.5;  // 固定仓位
            slPt = 20;  // 固定止损
        } else {
            slPt = calcRisk2SL(bal, 1.0); // 先以 1ETH 计算基准
            slPt = Math.max(10, Math.min(slPt, 40)); // clamp [10, 40]
            qty = calcKellyQty(bal, kF, k.c, slPt);
            qty = Math.max(0.1, Math.min(qty, 5.0)); // clamp [0.1, 5]
        }

        // 开仓
        usedWindows.add(winKey);
        pos = {
            side: dir as "long" | "short",
            entry: k.c,
            qty,
            idx: i,
            window: activeWindow,
            slPt,
            tpPt,
            kellyF: kF,
        };
    }

    // 收尾: 收盘还有仓
    if (pos && kl5m.length > 0) {
        const lk = kl5m[kl5m.length - 1];
        const pt = pos.side === "long" ? lk.c - pos.entry : pos.entry - lk.c;
        const fee = (pos.entry * pos.qty + lk.c * pos.qty) * TAKER_FEE;
        const net = pt * pos.qty - fee;
        bal += net; trades++; netPnl += net;
        if (net > 0) { wins++; wp.push(net); } else lp.push(net);
        logs.push({
            date: utc8Date(lk.ts), window: pos.window.name, side: pos.side,
            entry: pos.entry, exit: lk.c, qty: pos.qty,
            pnlPt: pt, pnlNet: net, reason: "END",
            kellyF: pos.kellyF, holdBars: kl5m.length - 1 - pos.idx,
        });
    }

    const totalWin = wp.reduce((a, b) => a + b, 0);
    const totalLoss = Math.abs(lp.reduce((a, b) => a + b, 0));

    return {
        mode, trades, wins, pnl: netPnl,
        wr: trades > 0 ? wins / trades * 100 : 0,
        avgW: wp.length > 0 ? totalWin / wp.length : 0,
        avgL: lp.length > 0 ? lp.reduce((a, b) => a + b, 0) / lp.length : 0,
        dd: maxDD, pf: totalLoss > 0 ? totalWin / totalLoss : 999,
        logs, exitReasons, windowStats, moduleStats: ms,
    };
}

// ═══════════════════════════════════════════════════════════════
// 主程序
// ═══════════════════════════════════════════════════════════════

async function main() {
    console.log("═══════════════════════════════════════════════════════════════════════");
    console.log("  🤖 Bot 自动交易系统 — 五模组完整回测");
    console.log("  ETHUSDT | $500 本金 | 150x | 2026年3月");
    console.log("  模组: 时间过滤 + SVP感知 + 进场触发 + 执行效能 + 凯利风控");
    console.log("═══════════════════════════════════════════════════════════════════════\n");

    const sMs = new Date("2026-03-01T00:00:00Z").getTime();
    const eMs = new Date("2026-03-25T08:00:00Z").getTime(); // 到今天

    // 数据拉取
    console.log("📥 拉取 5m K线 (3月)...");
    const kl5m = await fetchK("ETHUSDT", "5m", sMs, eMs);
    console.log(`  5m: ${kl5m.length} 根`);

    console.log("📥 拉取 1h K线 (3月 + 前7天)...");
    const k1h = await fetchK("ETHUSDT", "1h", sMs - 7 * 86400000, eMs);
    console.log(`  1h: ${k1h.length} 根`);

    console.log("📥 拉取 4h K线 (3月 + 前14天)...");
    const k4h = await fetchK("ETHUSDT", "4h", sMs - 14 * 86400000, eMs);
    console.log(`  4h: ${k4h.length} 根`);

    console.log("\n🔬 运行 4 个策略方案对比...\n");

    // 运行所有模式
    const modes: StratMode[] = ["baseline", "full_5module", "no_kelly", "wide_window"];
    const results: Result[] = [];
    for (const m of modes) {
        const r = run(kl5m, k1h, k4h, m);
        results.push(r);
    }

    // ═══ 策略对比表 ═══
    console.log("═══════════════════════════════════════════════════════════════════════════════════════");
    console.log("  📊 策略方案对比");
    console.log("═══════════════════════════════════════════════════════════════════════════════════════");
    console.log("   # | 策略                   | 笔数 | 胜率   | 净利      | 均盈    | 均亏     | 回撤    | PF");
    console.log("  " + "─".repeat(95));

    const best = results.reduce((a, b) => a.pnl > b.pnl ? a : b);
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const mark = r.mode === best.mode ? " 🏆" : "";
        console.log(
            `  ${String(i + 1).padStart(2)} | ${MODE_LABELS[r.mode as StratMode].padEnd(22)} | ${String(r.trades).padStart(4)} | ` +
            `${r.wr.toFixed(1).padStart(5)}% | $${((r.pnl >= 0 ? "+" : "") + r.pnl.toFixed(0)).padStart(7)} | ` +
            `$${r.avgW.toFixed(1).padStart(6)} | $${r.avgL.toFixed(1).padStart(7)} | ` +
            `$${r.dd.toFixed(0).padStart(6)} | ${r.pf.toFixed(2)}${mark}`
        );
    }

    // ═══ 冠军详情 ═══
    console.log(`\n═══════════════════════════════════════════════════════════════════════════════════════`);
    console.log(`  🏆 冠军策略: ${MODE_LABELS[best.mode as StratMode]}`);
    console.log(`═══════════════════════════════════════════════════════════════════════════════════════`);

    // 窗口统计
    console.log("\n  📊 窗口统计:");
    console.log("    窗口           | 笔数 | 胜率  | 净利");
    console.log("    " + "─".repeat(50));
    for (const [wName, ws] of Object.entries(best.windowStats).sort()) {
        const wr = ws.trades > 0 ? (ws.wins / ws.trades * 100).toFixed(0) : "0";
        console.log(
            `    ${wName.padEnd(15)} | ${String(ws.trades).padStart(4)} | ${wr.padStart(4)}% | $${(ws.pnl >= 0 ? "+" : "") + ws.pnl.toFixed(0)}`
        );
    }

    // 出场原因
    console.log("\n  📤 出场原因分布:");
    for (const [reason, count] of Object.entries(best.exitReasons).sort((a, b) => b[1] - a[1])) {
        const pct = (count / best.trades * 100).toFixed(0);
        console.log(`    ${reason.padEnd(12)}: ${String(count).padStart(3)} 笔 (${pct}%)`);
    }

    // 模组统计
    console.log("\n  🔧 模组触发统计:");
    console.log(`    时间过滤拦截:     ${best.moduleStats.timeFiltered} 次`);
    console.log(`    POC过滤拦截:      ${best.moduleStats.pocFiltered} 次`);
    console.log(`    无入场触发:       ${best.moduleStats.noEntry} 次`);
    console.log(`    3H停滞出场:       ${best.moduleStats.staleExit} 次`);
    console.log(`    均波TP出场:       ${best.moduleStats.avgRangeTP} 次`);
    console.log(`    凯利禁止开单:     ${best.moduleStats.kellyStopped} 次`);
    console.log(`    走三退一冷却:     ${best.moduleStats.cooldownSkipped} 次`);
    console.log(`    亚盘午间强平:     ${best.moduleStats.noonForced} 次`);

    // 逐笔交易
    console.log("\n  📋 逐笔交易明细:");
    console.log("    日期       | 窗口          | 方向  | 仓位   | 入场      | 出场      | 点数     | 净盈亏    | 出场   | Kelly | 持仓");
    console.log("    " + "─".repeat(120));
    for (const t of best.logs) {
        console.log(
            `    ${t.date} | ${t.window.padEnd(13)} | ${t.side.padEnd(5)} | ${t.qty.toFixed(1).padStart(4)}E | ` +
            `$${t.entry.toFixed(1).padStart(7)} | $${t.exit.toFixed(1).padStart(7)} | ` +
            `${(t.pnlPt >= 0 ? "+" : "") + t.pnlPt.toFixed(1).padStart(7)} | ` +
            `$${(t.pnlNet >= 0 ? "+" : "") + t.pnlNet.toFixed(1).padStart(7)} | ` +
            `${t.reason.padEnd(6)} | ${(t.kellyF * 100).toFixed(0).padStart(3)}% | ${String(t.holdBars).padStart(3)}bar`
        );
    }

    // 最终资金
    console.log(`\n  💰 最终资金:`);
    console.log(`    初始: $${INITIAL_CAPITAL} → 最终: $${(INITIAL_CAPITAL + best.pnl).toFixed(0)} (${best.pnl >= 0 ? "+" : ""}${(best.pnl / INITIAL_CAPITAL * 100).toFixed(1)}%)`);
    console.log(`    最大回撤: $${best.dd.toFixed(0)} (${(best.dd / INITIAL_CAPITAL * 100).toFixed(1)}%)`);
    console.log(`    交易天数: ~25天 | 日均: ${(best.trades / 25).toFixed(1)} 笔/天`);

    // 凯利统计 (仅 full_5module)
    const km = results.find(r => r.mode === "full_5module");
    if (km && km.logs.length > 0) {
        const avgKelly = km.logs.reduce((s, t) => s + t.kellyF, 0) / km.logs.length;
        const maxKelly = Math.max(...km.logs.map(t => t.kellyF));
        console.log(`\n  📐 凯利公式统计 (五模组):`);
        console.log(`    平均凯利比例: ${(avgKelly * 100).toFixed(1)}%`);
        console.log(`    最大凯利比例: ${(maxKelly * 100).toFixed(1)}%`);
        console.log(`    凯利禁止开单: ${km.moduleStats.kellyStopped} 次`);
    }

    console.log(`\n${"═".repeat(90)}\n`);
}

main().catch(console.error);
export {};
