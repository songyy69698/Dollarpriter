/**
 * 📊 V200 五模组回测 — M1 Tape Reading 版
 * ═══════════════════════════════════════════
 * 核心改进:
 * 1. POC 只做 BIAS（不硬过滤方向）
 * 2. 入场触发: M1 连续攻击性 K 棒 (taker buy/sell ratio)
 * 3. SL: M1 结构低/高点（非固定 2%）
 * 4. 多日回测 (3/22-3/25)
 */

const FEE = 0.0004, CAP = 500, LEV = 150;

interface K {
    ts: number; o: number; h: number; l: number; c: number; v: number;
    tbv: number; // taker buy volume
}

async function fetchK(sym: string, iv: string, s: number, e: number): Promise<K[]> {
    const all: K[] = []; let cur = s;
    while (cur < e) {
        const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${iv}&startTime=${cur}&endTime=${e}&limit=1500`;
        const r = await fetch(url); if (!r.ok) { await Bun.sleep(3000); continue; }
        const d = (await r.json()) as any[][]; if (!d.length) break;
        for (const k of d) all.push({
            ts: k[0] as number, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
            tbv: +k[9], // taker buy base asset volume
        });
        cur = (d[d.length - 1][6] as number) + 1; await Bun.sleep(200);
    }
    return all;
}

interface Trade {
    day: string; time: string; side: string; entry: number; exit: number;
    pt: number; net: number; reason: string; trigger: string;
    qty: number; slPt: number;
}

// ═══ 工具 ═══
function utc8H(ts: number): number { return new Date(ts + 8 * 3600000).getUTCHours(); }
function utc8Date(ts: number): string { return new Date(ts + 8 * 3600000).toISOString().slice(0, 10); }
function utc8Time(ts: number): string { return new Date(ts + 8 * 3600000).toISOString().slice(11, 16); }

// ═══ 真实 Volume Profile 引擎 (从 M1 K线构建) ═══
const VP_BIN = 1.0;          // 价格分桶 1pt (与 bitunix-ws.ts 一致)
const VP_WINDOW = 4 * 3600000; // 4小时滚动窗口

/**
 * 从 M1 K线构建真实 Volume Profile，找出 POC
 * 将每根 M1 的成交量分配到其典型价格(H+L+C)/3 对应的 1pt 桶中
 * POC = 成交量最大的价格桶
 */
function calcRealVPPOC(m1: K[], endTs: number, windowMs: number = VP_WINDOW): number {
    const cutoff = endTs - windowMs;
    const volMap = new Map<number, number>();

    for (const bar of m1) {
        if (bar.ts < cutoff || bar.ts > endTs) continue;
        if (bar.v <= 0) continue;
        // 将成交量分配到典型价格对应的桶
        const typicalPrice = (bar.h + bar.l + bar.c) / 3;
        const bin = Math.round(typicalPrice / VP_BIN) * VP_BIN;
        volMap.set(bin, (volMap.get(bin) || 0) + bar.v);
    }

    // 找最大成交量的价格桶 = POC
    let maxVol = 0, poc = 0;
    for (const [price, vol] of volMap) {
        if (vol > maxVol) { maxVol = vol; poc = price; }
    }
    return poc;
}

// ═══ 交易窗口 ═══
interface TW { name: string; startH: number; endH: number; isAsian: boolean; }
const WINDOWS: TW[] = [
    { name: "亚盘", startH: 9, endH: 10, isAsian: true },
    { name: "规律", startH: 15, endH: 16, isAsian: false },
    { name: "峰A", startH: 20, endH: 22, isAsian: false },
    { name: "峰B", startH: 22, endH: 24, isAsian: false },
];

// ═══════════════════════════════════════════════════
// M1 Tape Reading 触发器
// ═══════════════════════════════════════════════════

/**
 * M1 入场时机检测 — 只在策略指定的方向上找攻击性吃单
 * @param wantedDir - 策略层已确定的方向 (POC)
 * 条件 (最近6根M1中):
 *   - 有 2+ 根在指定方向上的攻击性 K 棒
 *   - Taker buy ratio > 0.55 (做多) 或 < 0.45 (做空)
 *   - 量能 >= 均量 * 0.8
 *   - 总位移 > 1.5pt
 * 返回 true = 时机到了可以入场
 */
function detectM1EntryTiming(m1: K[], idx: number, avgVol1m: number, wantedDir: "long" | "short"): boolean {
    if (idx < 5) return false;
    const recent = m1.slice(Math.max(0, idx - 5), idx + 1);

    // 在指定方向上找连续攻击序列
    for (let start = 0; start < recent.length - 1; start++) {
        let len = 0, move = 0;
        for (let j = start; j < recent.length; j++) {
            const bar = recent[j];
            const tbr = bar.v > 0 ? bar.tbv / bar.v : 0.5;
            const volOk = bar.v >= avgVol1m * 0.8;

            let isAggressive = false;
            if (wantedDir === "long") {
                isAggressive = bar.c > bar.o && tbr > 0.52 && volOk;
                if (isAggressive) { len++; move += bar.c - bar.o; }
                else if (len > 0) break; // 序列中断
                else continue; // 还没开始
            } else {
                isAggressive = bar.c < bar.o && tbr < 0.48 && volOk;
                if (isAggressive) { len++; move += bar.o - bar.c; }
                else if (len > 0) break;
                else continue;
            }
        }
        if (len >= 2 && move > 1.5) return true;
    }
    return false;
}

/**
 * M1 结构性 SL: 找最近 10 根 M1 的极值
 * 做多: SL = 最近10根M1的最低点 - 1pt
 * 做空: SL = 最近10根M1的最高点 + 1pt
 */
function calcM1StructureSL(m1: K[], idx: number, dir: "long" | "short"): number {
    const lookback = m1.slice(Math.max(0, idx - 9), idx + 1);
    if (dir === "long") {
        const low = Math.min(...lookback.map(k => k.l));
        return low - 1;
    } else {
        const high = Math.max(...lookback.map(k => k.h));
        return high + 1;
    }
}

// ═══════════════════════════════════════════════════
// V200 M1 回测引擎
// ═══════════════════════════════════════════════════

function runDay(dayStr: string, m1: K[], k1h: K[], k4h: K[]): { trades: Trade[]; log: string[] } {
    const trades: Trade[] = [];
    const log: string[] = [];
    let bal = CAP;
    const usedWindows = new Set<string>();
    const MAX_HOLD = 180; // 3H = 180根M1

    // 均波 TP
    const avgRange = k1h.length >= 14
        ? k1h.slice(-14).reduce((s, k) => s + (k.h - k.l), 0) / 14 : 30;
    const tpPt = avgRange * 0.7;

    // M1 均量 (滚动)
    const calcAvgVol1m = (idx: number): number => {
        const start = Math.max(0, idx - 60); // 最近60根M1均量
        let total = 0, count = 0;
        for (let j = start; j < idx; j++) { total += m1[j].v; count++; }
        return count > 0 ? total / count : 1;
    };

    for (let i = 60; i < m1.length; i++) {
        const bar = m1[i];
        const h = utc8H(bar.ts);
        const day = utc8Date(bar.ts);
        if (day !== dayStr) continue;

        // 噪音过滤 08-09
        if (h >= 8 && h < 9) continue;

        // 检查窗口
        let activeW: TW | null = null;
        for (const w of WINDOWS) { if (h >= w.startH && h < w.endH) { activeW = w; break; } }
        if (!activeW) continue;

        const wk = `${day}_${activeW.name}`;
        if (usedWindows.has(wk)) continue;

        // ═══ POC 方向 (真实 VP) ═══
        // 用 M1 成交量构建连续两个 4H 窗口的 Volume Profile
        // 当前 4H 窗口 POC vs 前一个 4H 窗口 POC = 位移方向
        const currPOC = calcRealVPPOC(m1, bar.ts, VP_WINDOW);           // 过去4H的VP POC
        const prevPOC = calcRealVPPOC(m1, bar.ts - VP_WINDOW, VP_WINDOW); // 再前4H的VP POC
        if (currPOC === 0 || prevPOC === 0) continue;
        const pocShift = currPOC - prevPOC;
        let pocBias: "long" | "short" | "" = "";
        if (pocShift > 5) pocBias = "long";
        else if (pocShift < -5) pocBias = "short";
        if (!pocBias) continue;

        // ═══ M1 Tape Reading 触发 ═══
        const avgVol1m = calcAvgVol1m(i);
        // ═══ M1 入场时机 (只在 POC 方向上找攻击吃单) ═══
        const entryReady = detectM1EntryTiming(m1, i, avgVol1m, pocBias);
        if (!entryReady) continue;

        const dir = pocBias; // 方向由策略(POC)决定，M1只确认时机

        // ═══ V104 固定 SL 20pt ═══
        const clampedSL = 20;

        // 仓位: 2% risk / 20pt SL
        const riskAmt = bal * 0.02;
        let qty = riskAmt / clampedSL;
        qty = Math.max(0.1, Math.min(qty, 5.0));
        qty = Math.floor(qty * 10) / 10;

        const entryPrice = bar.c;
        log.push(`  ${utc8Time(bar.ts)} ✅ ${dir.toUpperCase()} @$${entryPrice.toFixed(1)} | POC=${pocShift >= 0 ? "+" : ""}${pocShift.toFixed(0)}pt | M1攻击 | SL=20pt | ${qty}E`);

        // ═══ V104 多层出场逻辑 ═══
        // Layer 1: 硬SL (M1结构)
        // Layer 2: 保本 6pt → SL移到入场价
        // Layer 3: trailing 12pt
        // Layer 4: 分批TP 35pt → 关50%
        // Layer 5: 全平 100pt
        const BREAKEVEN_PT = 6;
        const TRAILING_PT = 12;
        const PARTIAL_TP_PT = 35;
        const FULL_TP_PT = 100;

        let exitP = 0, reason = "";
        let breakevenHit = false;
        let trailingActive = false;
        let trailingHigh = 0;
        let partialClosed = false;
        let remainQty = qty;
        let partialPnl = 0;

        for (let j = i + 1; j < m1.length && j - i < MAX_HOLD; j++) {
            const b = m1[j];
            const ptBest = dir === "long" ? b.h - entryPrice : entryPrice - b.l;
            const ptWorst = dir === "long" ? b.l - entryPrice : entryPrice - b.h;
            const pt = dir === "long" ? b.c - entryPrice : entryPrice - b.c;

            // 更新 trailing high
            if (ptBest > trailingHigh) trailingHigh = ptBest;

            // Layer 1: 硬SL
            const activeSL = breakevenHit ? 0 : clampedSL; // 保本后SL=0
            if (!breakevenHit && ptWorst <= -clampedSL) {
                exitP = dir === "long" ? entryPrice - clampedSL : entryPrice + clampedSL;
                reason = "SL"; break;
            }

            // Layer 2: 保本触发
            if (!breakevenHit && ptBest >= BREAKEVEN_PT) {
                breakevenHit = true;
                trailingActive = true;
            }

            // 保本后被打回入场价 → 平保出场
            if (breakevenHit && ptWorst <= 0) {
                exitP = entryPrice;
                reason = "保本"; break;
            }

            // Layer 4: 分批TP 35pt → 关50%
            if (!partialClosed && ptBest >= PARTIAL_TP_PT) {
                partialClosed = true;
                const closeQty = remainQty * 0.5;
                partialPnl = PARTIAL_TP_PT * closeQty;
                remainQty -= closeQty;
            }

            // Layer 3: trailing 12pt
            if (trailingActive && trailingHigh - pt >= TRAILING_PT && trailingHigh >= BREAKEVEN_PT) {
                exitP = dir === "long" ? entryPrice + (trailingHigh - TRAILING_PT) : entryPrice - (trailingHigh - TRAILING_PT);
                reason = `Trailing(${trailingHigh.toFixed(0)}-${TRAILING_PT})`; break;
            }

            // Layer 5: 全平100pt
            if (pt >= FULL_TP_PT) {
                exitP = b.c; reason = "全平100pt"; break;
            }

            // 亚盘12:00强平
            if (activeW.isAsian && utc8H(b.ts) >= 12) { exitP = b.c; reason = "NOON"; break; }
        }
        if (exitP === 0) {
            exitP = m1[Math.min(i + MAX_HOLD - 1, m1.length - 1)].c;
            reason = "3H_TIMEOUT";
        }

        usedWindows.add(wk);
        const pt = dir === "long" ? exitP - entryPrice : entryPrice - exitP;
        // 分批平仓: partial 按 PARTIAL_TP_PT 获利, remain 按 exitP 获利
        const remainPnl = pt * remainQty;
        const grossPnl = partialPnl + remainPnl;
        const fee = (entryPrice * qty + exitP * qty) * FEE;
        const net = grossPnl - fee;
        bal += net;

        trades.push({
            day, time: utc8Time(bar.ts), side: dir, entry: entryPrice, exit: exitP,
            pt, net, reason, trigger: `M1攻击`, qty, slPt: clampedSL,
        });
    }

    return { trades, log };
}

// ═══════════════════════════════════════════════════
// 主程序 — 多日回测
// ═══════════════════════════════════════════════════

async function main() {
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log("  📊 V200 M1 Tape Reading 回测 — ETHUSDT");
    console.log("  改进: M1攻击吃单触发 + M1结构SL + POC仅做BIAS");
    console.log("═══════════════════════════════════════════════════════════════════\n");

    const days = ["2026-03-22", "2026-03-23", "2026-03-24", "2026-03-25"];
    const firstDay = new Date(days[0] + "T00:00:00Z").getTime();
    const lastDay = new Date(days[days.length - 1] + "T00:00:00Z").getTime() + 86400000;

    // 拉取数据
    console.log("📥 拉取 1m K线 (含 taker volume)...");
    const m1All = await fetchK("ETHUSDT", "1m", firstDay - 3600000, lastDay);
    console.log(`  1m: ${m1All.length} 根`);

    console.log("📥 拉取 1h K线...");
    const k1hAll = await fetchK("ETHUSDT", "1h", firstDay - 7 * 86400000, lastDay);
    console.log(`  1h: ${k1hAll.length} 根`);

    console.log("📥 拉取 4h K线...");
    const k4hAll = await fetchK("ETHUSDT", "4h", firstDay - 14 * 86400000, lastDay);
    console.log(`  4h: ${k4hAll.length} 根\n`);

    let totalTrades: Trade[] = [];
    let totalPnl = 0;

    for (const dayStr of days) {
        const dayTs = new Date(dayStr + "T00:00:00Z").getTime();
        const nextDayTs = dayTs + 86400000;

        // 裁剪数据
        const m1Day = m1All.filter(k => k.ts >= dayTs - 3600000 && k.ts < nextDayTs);
        const k1hDay = k1hAll.filter(k => k.ts < dayTs); // 只用历史
        const k4hDay = k4hAll.filter(k => k.ts < nextDayTs);

        const { trades, log } = runDay(dayStr, m1Day, k1hDay, k4hDay);

        // 日线
        const dayM1 = m1All.filter(k => k.ts >= dayTs && k.ts < nextDayTs);
        const dayO = dayM1[0]?.o || 0, dayC = dayM1[dayM1.length - 1]?.c || 0;
        const dayH = Math.max(...dayM1.map(k => k.h));
        const dayL = Math.min(...dayM1.map(k => k.l));
        const dayPnl = trades.reduce((a, t) => a + t.net, 0);

        console.log("═══════════════════════════════════════════════════════════════════");
        console.log(`  📅 ${dayStr} | O=$${dayO.toFixed(0)} H=$${dayH.toFixed(0)} L=$${dayL.toFixed(0)} C=$${dayC.toFixed(0)} | ${dayC >= dayO ? "📈+" : "📉"}${(dayC - dayO).toFixed(0)}pt`);
        console.log("═══════════════════════════════════════════════════════════════════");

        if (log.length > 0) {
            for (const l of log) console.log(l);
        }

        if (trades.length > 0) {
            console.log(`\n  笔数: ${trades.length} | 净利: $${dayPnl >= 0 ? "+" : ""}${dayPnl.toFixed(1)}`);
            console.log("  时间  | 方向  | 仓位  | 入场      | 出场      | SL   | 点数     | 净盈亏    | 出场");
            console.log("  " + "─".repeat(90));
            for (const t of trades) {
                console.log(
                    `  ${t.time} | ${t.side.padEnd(5)} | ${t.qty.toFixed(1)}E | ` +
                    `$${t.entry.toFixed(1).padStart(7)} | $${t.exit.toFixed(1).padStart(7)} | ` +
                    `${t.slPt.toFixed(0).padStart(4)} | ` +
                    `${(t.pt >= 0 ? "+" : "") + t.pt.toFixed(1).padStart(7)} | ` +
                    `$${(t.net >= 0 ? "+" : "") + t.net.toFixed(1).padStart(7)} | ${t.reason}`
                );
            }
        } else {
            console.log("  ⚠️ 无交易信号");
        }
        console.log();

        totalTrades.push(...trades);
        totalPnl += dayPnl;
    }

    // ═══ 汇总 ═══
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log("  📊 4日汇总 (3/22-3/25)");
    console.log("═══════════════════════════════════════════════════════════════════");

    const wins = totalTrades.filter(t => t.net > 0);
    const losses = totalTrades.filter(t => t.net <= 0);
    const winRate = totalTrades.length > 0 ? (wins.length / totalTrades.length * 100).toFixed(0) : "0";
    const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.net, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, t) => a + t.net, 0) / losses.length : 0;

    console.log(`  总笔数: ${totalTrades.length} | 胜: ${wins.length} 负: ${losses.length} | 胜率: ${winRate}%`);
    console.log(`  总净利: $${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(1)}`);
    console.log(`  均盈: $${avgWin >= 0 ? "+" : ""}${avgWin.toFixed(1)} | 均亏: $${avgLoss.toFixed(1)}`);
    if (avgLoss !== 0) console.log(`  盈亏比: ${(Math.abs(avgWin / avgLoss)).toFixed(2)}`);

    // 按日汇总
    console.log("\n  ─── 每日明细 ───");
    for (const d of days) {
        const dt = totalTrades.filter(t => t.day === d);
        const dp = dt.reduce((a, t) => a + t.net, 0);
        const dw = dt.filter(t => t.net > 0).length;
        console.log(`  ${d}: ${dt.length}笔 ${dw}胜${dt.length - dw}负 | $${dp >= 0 ? "+" : ""}${dp.toFixed(1)}`);
    }
    console.log(`\n${"═".repeat(67)}\n`);
}

main().catch(console.error);
export {};
