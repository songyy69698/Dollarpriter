/**
 * 🧪 统一策略体系回测 V1.1
 * ═══════════════════════════════════════════════════
 * 12 大知识来源汇总策略：
 *   五重共振 + Judas Swing + 回调入场 + 窗口收盘
 *   分层出场: SL20pt → BE12+3 → Trailing10 → 窗口平仓
 *   对比: 基线(无过滤) vs 五重共振 vs 完整统一策略
 */

const LEVERAGE = 150;
const TAKER_FEE = 0.0004;
const INITIAL_CAPITAL = 500;
const FIXED_QTY = 1.0;
const SL_PT = 20;
const BREAKEVEN_PT = 12;
const BREAKEVEN_OFFSET = 3;
const TRAILING_PT = 10;
const MAX_DAILY_TRADES = 3;
const MAX_DAILY_LOSS = 150;
const MAX_HOLD_BARS = 12; // 窗口最长1小时=12根5m
const MTF_MIN = 6;
const PB_ZONE = 5;
const MAX_CHASE_PT = 15;

// ═══ 数据类型 ═══
interface K { ts: number; o: number; h: number; l: number; c: number; v: number; }

// ═══ 数据获取 ═══
async function fetchK(symbol: string, interval: string, sMs: number, eMs: number): Promise<K[]> {
    const all: K[] = []; let cur = sMs;
    while (cur < eMs) {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cur}&endTime=${eMs}&limit=1500`;
        const res = await fetch(url); if (!res.ok) { await Bun.sleep(5000); continue; }
        const data = (await res.json()) as any[][];
        if (!data.length) break;
        for (const k of data) all.push({ ts: k[0] as number, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
        cur = (data[data.length - 1][6] as number) + 1;
        await Bun.sleep(150);
    }
    return all;
}

// ═══ 指标计算 ═══
function calcPOC(kl: K[]): number {
    if (!kl.length) return 0;
    let maxV = 0, poc = 0;
    for (const k of kl) { if (k.v > maxV) { maxV = k.v; poc = (k.h + k.l + k.c) / 3; } }
    return poc;
}

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

function calcEMA(closes: number[], period: number): number {
    if (closes.length < period) return closes[closes.length - 1] || 0;
    let ema = closes.slice(0, period).reduce((a, b) => a + b) / period;
    const m = 2 / (period + 1);
    for (let i = period; i < closes.length; i++) ema = closes[i] * m + ema * (1 - m);
    return ema;
}

// ═══ 日振幅计算 ═══
function getDayRange(kl: K[], ts: number): { usedPct: number; dayHL: number; dayAvg: number } {
    const d = new Date(ts + 8 * 3600000).toISOString().slice(0, 10);
    const dayBars = kl.filter(k => {
        const kd = new Date(k.ts + 8 * 3600000).toISOString().slice(0, 10);
        return kd === d && k.ts <= ts;
    });
    if (dayBars.length < 2) return { usedPct: 0, dayHL: 0, dayAvg: 129 };
    const dayH = Math.max(...dayBars.map(k => k.h));
    const dayL = Math.min(...dayBars.map(k => k.l));
    const dayHL = dayH - dayL;
    const avgDayRange = 129; // ETH 平均日振幅 129pt (78天数据)
    return { usedPct: dayHL / avgDayRange * 100, dayHL, dayAvg: avgDayRange };
}

// ═══ K棒结构检测 ═══
function hasLongShadow(kl: K[], dir: string, count = 3): boolean {
    if (kl.length < count) return false;
    const recent = kl.slice(-count);
    for (const k of recent) {
        const body = Math.abs(k.c - k.o);
        const range = k.h - k.l;
        if (range === 0) continue;
        if (dir === "long") {
            const upperShadow = k.h - Math.max(k.o, k.c);
            if (upperShadow / range > 0.4) return true; // 长上影 → 做多危险
        } else {
            const lowerShadow = Math.min(k.o, k.c) - k.l;
            if (lowerShadow / range > 0.4) return true; // 长下影 → 做空危险
        }
    }
    return false;
}

// ═══ Judas Swing: 开盘第一根K线影线反转 ═══
function judasSwing(k: K): string | null {
    const body = Math.abs(k.c - k.o);
    const upperShadow = k.h - Math.max(k.o, k.c);
    const lowerShadow = Math.min(k.o, k.c) - k.l;
    // 做空: 上影线 > 实体
    if (upperShadow > body && upperShadow > 1.0) return "short";
    // 做多: 下影线 > 实体
    if (lowerShadow > body && lowerShadow > 1.0) return "long";
    return null;
}

// ═══ MTF-POC 共振 ═══
const TF_SIMS = [
    { interval: "1d", threshold: 50, halfSplit: 2 },
    { interval: "12h", threshold: 30, halfSplit: 2 },
    { interval: "8h", threshold: 20, halfSplit: 3 },
    { interval: "4h", threshold: 10, halfSplit: 6 },
    { interval: "2h", threshold: 8, halfSplit: 6 },
    { interval: "1h", threshold: 5, halfSplit: 12 },
    { interval: "30m", threshold: 4, halfSplit: 12 },
    { interval: "15m", threshold: 3, halfSplit: 16 },
];

function getMtf(ts: number, tfData: Map<string, K[]>): { score: number; dir: string; poc: number } {
    let sc = 0, pS = 0, pW = 0;
    const pw: Record<string, number> = { "2h": 1, "1h": 3, "30m": 3, "15m": 2 };
    for (const tf of TF_SIMS) {
        const kl = tfData.get(tf.interval); if (!kl || kl.length < 4) continue;
        const b = kl.filter(k => k.ts <= ts); if (b.length < tf.halfSplit * 2) continue;
        const r = b.slice(-tf.halfSplit), p = b.slice(-tf.halfSplit * 2, -tf.halfSplit);
        const s = calcPOC(r) - calcPOC(p);
        if (s > tf.threshold) sc++; else if (s < -tf.threshold) sc--;
        const w = pw[tf.interval] || 0; const poc1 = calcPOC(r);
        if (w > 0 && poc1 > 0) { pS += poc1 * w; pW += w; }
    }
    return { score: sc, dir: sc > 0 ? "long" : sc < 0 ? "short" : "", poc: pW > 0 ? pS / pW : 0 };
}

// ═══ POC 前4H 方向 ═══
function getPocDir(k4h: K[], ts: number): number {
    const before = k4h.filter(k => k.ts <= ts);
    if (before.length < 2) return 0;
    const curr = before[before.length - 1];
    const prev = before[before.length - 2];
    return calcPOC([curr]) - calcPOC([prev]);
}

// ═══ 出场引擎 ═══
interface Pos {
    side: "long" | "short"; entry: number; qty: number; idx: number;
    beTrig: boolean; bestPt: number; windowEnd: number;
}

function checkExit(pos: Pos, price: number, bars: number, windowClose: boolean):
    { close: boolean; ep: number; reason: string } | null {
    const pt = pos.side === "long" ? price - pos.entry : pos.entry - price;
    if (pt > pos.bestPt) pos.bestPt = pt;

    // 层1: 硬止损 20pt
    if (pt <= -SL_PT) return { close: true, ep: price, reason: "SL" };

    // 层2: 保本触发
    if (!pos.beTrig && pt >= BREAKEVEN_PT) pos.beTrig = true;

    // 层3: 保本+跟踪
    if (pos.beTrig && pos.bestPt > BREAKEVEN_PT) {
        const trail = pos.side === "long"
            ? pos.entry + pos.bestPt - TRAILING_PT
            : pos.entry - pos.bestPt + TRAILING_PT;
        const be = pos.side === "long"
            ? pos.entry + BREAKEVEN_OFFSET
            : pos.entry - BREAKEVEN_OFFSET;
        const eff = pos.side === "long" ? Math.max(trail, be) : Math.min(trail, be);
        if ((pos.side === "long" && price <= eff) || (pos.side === "short" && price >= eff))
            return { close: true, ep: price, reason: "TRAIL" };
    }

    // 层4: 窗口收盘平仓
    if (windowClose) return { close: true, ep: price, reason: "WIN_CLOSE" };

    // 层5: 超时
    if (bars >= MAX_HOLD_BARS) return { close: true, ep: price, reason: "TIMEOUT" };

    return null;
}

// ═══ 策略模式 ═══
type StratMode = "baseline" | "five_resonance" | "unified" | "unified_judas";

interface TradeLog {
    date: string; window: number; side: string; entry: number; exit: number;
    pnlPt: number; pnlNet: number; reason: string;
}

interface Result {
    mode: StratMode; trades: number; wins: number; pnl: number; wr: number;
    avgW: number; avgL: number; dd: number; pf: number; monthPnl: Record<string, number>;
    exitReasons: Record<string, number>; logs: TradeLog[];
}

// ═══ 主引擎 ═══
function run(kl1m: K[], mode: StratMode, tfData: Map<string, K[]>, k4h: K[]): Result {
    let bal = INITIAL_CAPITAL, pos: Pos | null = null;
    let trades = 0, ws = 0, netPnl = 0;
    const wp: number[] = [], lp: number[] = [];
    let maxB = INITIAL_CAPITAL, maxDD = 0;
    let curD = "", dT = 0, dP = 0;
    const wT = new Set<string>();
    const monthPnl: Record<string, number> = {};
    const exitReasons: Record<string, number> = {};
    const logs: TradeLog[] = [];

    for (let i = 0; i < kl1m.length; i++) {
        const k = kl1m[i];
        const utc8 = new Date(k.ts + 8 * 3600000);
        const d = utc8.toISOString().slice(0, 10);
        const mon = d.slice(0, 7);
        const h = utc8.getUTCHours(), m = utc8.getUTCMinutes();

        if (d !== curD) { curD = d; dT = 0; dP = 0; }
        if (i < 100) continue;

        // ═══ 持仓管理 ═══
        if (pos) {
            const bars = i - pos.idx;
            const isWindowEnd = (i + 1 < kl1m.length)
                ? new Date(kl1m[i + 1].ts + 8 * 3600000).getUTCHours() !== new Date(pos.windowEnd).getUTCHours()
                : true;
            const worst = pos.side === "long" ? k.l : k.h;
            const ex = checkExit(pos, worst, bars, false) || checkExit(pos, k.c, bars, isWindowEnd);
            if (ex?.close) {
                const pt = pos.side === "long" ? ex.ep - pos.entry : pos.entry - ex.ep;
                const fee = (pos.entry * pos.qty + ex.ep * pos.qty) * TAKER_FEE;
                const net = pt * pos.qty - fee;
                bal += net; trades++; dT++; dP += net; netPnl += net;
                monthPnl[mon] = (monthPnl[mon] || 0) + net;
                exitReasons[ex.reason] = (exitReasons[ex.reason] || 0) + 1;
                if (net > 0) { ws++; wp.push(net); } else lp.push(net);
                if (bal > maxB) maxB = bal;
                const dd = maxB - bal; if (dd > maxDD) maxDD = dd;
                logs.push({ date: d, window: new Date(pos.windowEnd).getUTCHours(),
                    side: pos.side, entry: pos.entry, exit: ex.ep,
                    pnlPt: pt, pnlNet: net, reason: ex.reason });
                pos = null;
            }
            continue;
        }

        // ═══ 入场条件检查 ═══
        if (dT >= MAX_DAILY_TRADES || dP <= -MAX_DAILY_LOSS || bal < 50) continue;

        // 窗口过滤: 15/19/22 (UTC+8)
        const windows = [15, 19, 22];
        if (!windows.includes(h)) continue;
        if (h === 19 && m >= 30) continue; // 19窗仅30分钟
        if (h !== 19 && m >= 60) continue;

        // 窗口开头前10分钟内开单(5m粒度)
        if (m > 10) continue;

        const key = `${d}_${h}`;
        if (wT.has(key)) continue;

        // MTF-POC
        const mtf = getMtf(k.ts, tfData);
        if (Math.abs(mtf.score) < MTF_MIN || !mtf.dir) continue;

        // ═══ baseline: 仅 MTF + 窗口 ═══
        if (mode === "baseline") {
            wT.add(key);
            const windowEndMs = k.ts + (h === 19 ? 30 : 60) * 60000;
            pos = { side: mtf.dir as "long" | "short", entry: k.c, qty: FIXED_QTY,
                idx: i, beTrig: false, bestPt: 0, windowEnd: windowEndMs };
            continue;
        }

        // ═══ 五重共振过滤 ═══
        const closes = kl1m.slice(Math.max(0, i - 200), i + 1).map(x => x.c);
        const recentBars = kl1m.slice(Math.max(0, i - 20), i + 1);

        // ① POC方向 > 5pt
        const pocDir = getPocDir(k4h, k.ts);
        if (mode !== "baseline") {
            if (mtf.dir === "long" && pocDir < 5) continue;
            if (mtf.dir === "short" && pocDir > -5) continue;
        }

        // ② RSI 过滤
        const rsi = calcRSI(closes);
        if (mtf.dir === "long" && rsi > 60) continue;
        if (mtf.dir === "short" && rsi < 40) continue;

        // ③ ATR 波动
        const atr = calcATR(recentBars);
        if (atr < 8 || atr > 55) continue;

        // ④ K棒结构 (近3根无反向长影线)
        const recent3 = kl1m.slice(Math.max(0, i - 3), i + 1);
        if (hasLongShadow(recent3, mtf.dir)) continue;

        // ⑤ 日振幅已用%
        const dayInfo = getDayRange(kl1m, k.ts);
        let finalDir = mtf.dir;
        if (dayInfo.usedPct > 70) {
            // 22窗口: 跟势(续行62%) / 15窗口: 反转(63%)
            if (h === 22) {
                // 跟 POC 方向
            } else {
                // 反转方向
                finalDir = mtf.dir === "long" ? "short" : "long";
            }
        }

        if (mode === "five_resonance") {
            // 回调过滤
            if (mtf.poc > 0) {
                const dist = k.c - mtf.poc;
                if (finalDir === "long" && dist > PB_ZONE) continue;
                if (finalDir === "short" && dist < -PB_ZONE) continue;
                if (Math.abs(dist) > MAX_CHASE_PT) continue;
            }
            wT.add(key);
            const windowEndMs = k.ts + (h === 19 ? 30 : 60) * 60000;
            pos = { side: finalDir as "long" | "short", entry: k.c, qty: FIXED_QTY,
                idx: i, beTrig: false, bestPt: 0, windowEnd: windowEndMs };
            continue;
        }

        // ═══ 统一策略: 五重共振 + 回调 + 可选 Judas Swing ═══
        // 回调过滤
        if (mtf.poc > 0) {
            const dist = k.c - mtf.poc;
            if (finalDir === "long" && dist > PB_ZONE) continue;
            if (finalDir === "short" && dist < -PB_ZONE) continue;
            if (Math.abs(dist) > MAX_CHASE_PT) continue;
        }

        // Judas Swing (开盘第一根K线影线确认)
        if (mode === "unified_judas") {
            const js = judasSwing(k);
            if (!js) continue;
            // Judas Swing 方向要和 MTF 方向一致
            if (js !== finalDir) continue;
        }

        // POC>50pt 禁追
        if (Math.abs(pocDir) > 50) {
            if ((pocDir > 50 && finalDir === "long") || (pocDir < -50 && finalDir === "short")) continue;
        }

        wT.add(key);
        const windowEndMs = k.ts + (h === 19 ? 30 : 60) * 60000;
        pos = { side: finalDir as "long" | "short", entry: k.c, qty: FIXED_QTY,
            idx: i, beTrig: false, bestPt: 0, windowEnd: windowEndMs };
    }

    // 收尾可能还有持仓
    if (pos && kl1m.length > 0) {
        const lk = kl1m[kl1m.length - 1];
        const pt = pos.side === "long" ? lk.c - pos.entry : pos.entry - lk.c;
        const fee = (pos.entry * pos.qty + lk.c * pos.qty) * TAKER_FEE;
        const net = pt * pos.qty - fee;
        bal += net; trades++; netPnl += net;
        if (net > 0) { ws++; wp.push(net); } else lp.push(net);
    }

    const tW = wp.reduce((a, b) => a + b, 0);
    const tL = Math.abs(lp.reduce((a, b) => a + b, 0));

    return {
        mode, trades, wins: ws, pnl: netPnl,
        wr: trades > 0 ? ws / trades * 100 : 0,
        avgW: wp.length > 0 ? tW / wp.length : 0,
        avgL: lp.length > 0 ? lp.reduce((a, b) => a + b, 0) / lp.length : 0,
        dd: maxDD, pf: tL > 0 ? tW / tL : 999,
        monthPnl, exitReasons, logs
    };
}

// ═══ 主程序 ═══
async function main() {
    console.log("═══════════════════════════════════════════════════════════");
    console.log("  🧪 统一策略体系 V1.1 回测");
    console.log("  $500 本金 | 150x | 1 ETH | ETHUSDT | 2026.01-03");
    console.log("  窗口: 15/19/22 (UTC+8) | SL:20pt BE:12+3 Trail:10");
    console.log("═══════════════════════════════════════════════════════════\n");

    const sMs = new Date("2026-01-01T00:00:00Z").getTime();
    const eMs = new Date("2026-03-21T00:00:00Z").getTime();

    console.log("📥 拉取 5m K线...");
    const kl1m = await fetchK("ETHUSDT", "5m", sMs, eMs);
    console.log(`  5m: ${kl1m.length} 根`);

    console.log("📥 拉取 4H K线 (POC方向用)...");
    const k4h = await fetchK("ETHUSDT", "4h", sMs - 30 * 86400000, eMs);
    console.log(`  4h: ${k4h.length} 根`);

    console.log("📥 拉取 MTF 多时间框架数据...");
    const tfData = new Map<string, K[]>();
    for (const tf of ["1d", "12h", "8h", "4h", "2h", "1h", "30m", "15m"]) {
        const kl = await fetchK("ETHUSDT", tf, sMs - 30 * 86400000, eMs);
        tfData.set(tf, kl);
        process.stdout.write(` ${tf}:${kl.length}`);
        await Bun.sleep(200);
    }

    console.log("\n\n🔬 运行 4 个策略方案对比...\n");

    const modes: StratMode[] = ["baseline", "five_resonance", "unified", "unified_judas"];
    const labels: Record<StratMode, string> = {
        "baseline":       "① 基线(仅MTF+窗口)",
        "five_resonance": "② 五重共振",
        "unified":        "③ 统一策略(无Judas)",
        "unified_judas":  "④ 统一+Judas Swing",
    };

    const results: Result[] = [];
    for (const m of modes) {
        const r = run(kl1m, m, tfData, k4h);
        results.push(r);
    }

    // ═══ 输出结果 ═══
    console.log("═══════════════════════════════════════════════════════════════════════════════");
    console.log("  📊 策略方案对比");
    console.log("═══════════════════════════════════════════════════════════════════════════════");
    console.log("   # | 策略                   | 笔数 | 胜率   | 净利      | 均盈   | 均亏    | 回撤   | 盈亏比");
    console.log("  " + "-".repeat(95));

    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const mark = i === results.length - 1 ? "" :
            results.reduce((best, cur) => cur.pnl > best.pnl ? cur : best).mode === r.mode ? " 🏆" : "";
        console.log(
            `  ${String(i + 1).padStart(2)} | ${labels[r.mode].padEnd(22)} | ${String(r.trades).padStart(4)} | ` +
            `${r.wr.toFixed(1).padStart(5)}% | $${((r.pnl >= 0 ? "+" : "") + r.pnl.toFixed(0)).padStart(7)} | ` +
            `$${r.avgW.toFixed(1).padStart(5)} | $${r.avgL.toFixed(1).padStart(6)} | ` +
            `$${r.dd.toFixed(0).padStart(5)} | ${r.pf.toFixed(2)}${mark}`
        );
    }

    // ═══ 冠军月度明细 ═══
    const best = results.reduce((a, b) => a.pnl > b.pnl ? a : b);
    console.log(`\n═══════════════════════════════════════════════════════════════════════════════`);
    console.log(`  🏆 冠军策略: ${labels[best.mode]}`);
    console.log(`═══════════════════════════════════════════════════════════════════════════════`);

    console.log("\n  📅 月度明细:");
    const months = Object.keys(best.monthPnl).sort();
    for (const m of months) {
        const v = best.monthPnl[m];
        const bar = v >= 0 ? "█".repeat(Math.min(Math.floor(v / 10), 30)) : "▒".repeat(Math.min(Math.floor(-v / 10), 30));
        console.log(`    ${m}: ${v >= 0 ? "+" : ""}$${v.toFixed(0).padStart(6)} ${v >= 0 ? "🟢" : "🔴"} ${bar}`);
    }

    console.log("\n  📤 出场原因分布:");
    for (const [reason, count] of Object.entries(best.exitReasons)) {
        const pct = (count / best.trades * 100).toFixed(0);
        console.log(`    ${reason.padEnd(10)}: ${String(count).padStart(3)} 笔 (${pct}%)`);
    }

    console.log("\n  📋 最近 10 笔交易:");
    const recentLogs = best.logs.slice(-10);
    console.log("    日期       | 窗口 | 方向  | 入场    | 出场    | 点数    | 净盈亏   | 出场原因");
    console.log("    " + "-".repeat(85));
    for (const t of recentLogs) {
        console.log(
            `    ${t.date} | ${String(t.window).padStart(2)}时 | ${t.side.padEnd(5)} | ` +
            `$${t.entry.toFixed(1)} | $${t.exit.toFixed(1)} | ${(t.pnlPt >= 0 ? "+" : "") + t.pnlPt.toFixed(1).padStart(6)} | ` +
            `$${(t.pnlNet >= 0 ? "+" : "") + t.pnlNet.toFixed(1).padStart(6)} | ${t.reason}`
        );
    }

    // ═══ 最终余额 ═══
    console.log("\n  💰 最终资金状况:");
    console.log(`    初始: $${INITIAL_CAPITAL} → 最终: $${(INITIAL_CAPITAL + best.pnl).toFixed(0)} (${best.pnl >= 0 ? "+" : ""}${(best.pnl / INITIAL_CAPITAL * 100).toFixed(1)}%)`);
    console.log(`    最大回撤: $${best.dd.toFixed(0)} (${(best.dd / INITIAL_CAPITAL * 100).toFixed(1)}%)`);
    console.log(`    日均交易: ${(best.trades / 80).toFixed(1)} 笔/天`);

    console.log("\n═══════════════════════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
