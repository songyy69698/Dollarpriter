/**
 * 📊 V300 订单流策略回测 — 战场标记 + FVG/陷阱反转
 * ════════════════════════════════════════════════
 * 架构:
 * 1. 模拟 Battlefield Marker (M1级别 VAH/VAL/POC)
 * 2. 模拟 Trap Reversal (破H/L后M1收回VA，结合 Taker Ratio 模拟吸收)
 * 3. 模拟 FVG Breakout (穿边界留缺口，回踩FVG后吞噬确认)
 * 4. 模拟 订单流 SL/TP (FVG极值SL，VA外侧SL，TP=30-50pt)
 */

import { TP_MIN_PT, TP_MAX_PT, FVG_MIN_GAP_PT, ENGULF_BODY_RATIO, VA_PERCENTAGE } from "./config";

// 由于 V300 强依赖 Websocket，这边用 Taker Volume 模拟 L2
const FEE = 0.0004;
const CAP = 500;
const LEV = 150;

interface K {
    ts: number; o: number; h: number; l: number; c: number; v: number; tbv: number;
}

// 工具函数
function utc8H(ts: number): number { return new Date(ts + 8 * 3600000).getUTCHours(); }
function utc8M(ts: number): number { return new Date(ts + 8 * 3600000).getUTCMinutes(); }
function utc8Date(ts: number): string { return new Date(ts + 8 * 3600000).toISOString().slice(0, 10); }
function utc8Time(ts: number): string { return new Date(ts + 8 * 3600000).toISOString().slice(11, 16); }

// ═══ 锚定窗口 ═══
const ANCHOR_WINDOWS = [
    { name: "AM锚定",     startH: 9,  startM: 30, endH: 9,  endM: 45 },
    { name: "PM锚定",     startH: 21, startM: 30, endH: 21, endM: 45 },
    { name: "黄金单边",   startH: 15, startM: 15, endH: 15, endM: 30 },
    { name: "假突破",     startH: 22, startM: 30, endH: 22, endM: 45 },
];

interface Range { name: string; h: number; l: number; vah: number; val: number; poc: number; ts: number; }

function isInWindow(h: number, m: number, w: any): boolean {
    const mins = h * 60 + m;
    const s = w.startH * 60 + w.startM;
    const e = w.endH * 60 + w.endM;
    return mins >= s && mins < e;
}

// 计算当前窗口的 Range
function calcRange(m1Set: K[], name: string, endTs: number): Range {
    let high = 0, low = Infinity, totalVol = 0;
    const volMap = new Map<number, number>();
    const BIN = 0.5;

    for (const k of m1Set) {
        if (k.h > high) high = k.h;
        if (k.l < low) low = k.l;
        totalVol += k.v;

        const bin = Math.round(k.c / BIN) * BIN;
        volMap.set(bin, (volMap.get(bin) || 0) + k.v);
    }

    let maxVol = 0, poc = 0;
    for (const [p, v] of volMap) if (v > maxVol) { maxVol = v; poc = p; }

    const sorted = Array.from(volMap.entries()).sort((a, b) => a[0] - b[0]);
    const target = totalVol * 0.7;
    const pIdx = sorted.findIndex(([p]) => p === poc);
    if (pIdx === -1) return { name, h: high, l: low, vah: high, val: low, poc, ts: endTs };

    let acc = sorted[pIdx][1], lo = pIdx, hi = pIdx;
    while (acc < target && (lo > 0 || hi < sorted.length - 1)) {
        const lv = lo > 0 ? sorted[lo - 1][1] : 0;
        const hv = hi < sorted.length - 1 ? sorted[hi + 1][1] : 0;
        if (lv >= hv && lo > 0) { lo--; acc += sorted[lo][1]; }
        else if (hi < sorted.length - 1) { hi++; acc += sorted[hi][1]; }
        else if (lo > 0) { lo--; acc += sorted[lo][1]; }
        else break;
    }
    return { name, h: high, l: low, vah: sorted[hi][0], val: sorted[lo][0], poc, ts: endTs };
}

// 模拟回转和FVG
function simulateDayV300(dayStr: string, m1: K[], k1h: K[]) {
    const trades: any[] = [];
    const _log: string[] = [];
    let bal = CAP;
    
    let activeRange: Range | null = null;
    let collecting: K[] = [];
    let curWinName = "";

    const avgH1Range = k1h.length >= 14 ? k1h.slice(-14).reduce((s, k) => s + (k.h - k.l), 0) / 14 : 30;
    const tpDist = Math.max(30, Math.min(avgH1Range * 0.7, 50));

    let fvgState: any = null; // { side, low, high, ts }

    for (let i = 20; i < m1.length; i++) {
        const bar = m1[i];
        const h = utc8H(bar.ts);
        const m = utc8M(bar.ts);
        const day = utc8Date(bar.ts);
        if (day !== dayStr) continue;

        // 维护战场边界
        let inAnyWin = false;
        for (const w of ANCHOR_WINDOWS) {
            if (isInWindow(h, m, w)) {
                inAnyWin = true;
                if (curWinName !== w.name) {
                    curWinName = w.name;
                    collecting = [];
                }
                collecting.push(bar);
                break;
            } else if (curWinName === w.name) {
                // 窗口结束
                activeRange = calcRange(collecting, w.name, bar.ts);
                _log.push(`  ${utc8Time(bar.ts)} 🎯 标记 ${w.name}: H=${activeRange.h.toFixed(1)} L=${activeRange.l.toFixed(1)} VA=${activeRange.val.toFixed(1)}-${activeRange.vah.toFixed(1)}`);
                curWinName = "";
                collecting = [];
                fvgState = null;
            }
        }
        if (inAnyWin) continue; // 在锚定内不开单
        if (!activeRange) continue;

        // 不在锚定内，进行策略扫描
        const price = bar.c;
        if (price > activeRange.val && price < activeRange.vah) continue; // VA内禁追

        let signal: any = null;

        // 1. Trap Reversal (找最近5根是否假突破)
        const brokeH = m1.slice(i-3, i+1).some(k => k.h > activeRange!.h);
        const brokeL = m1.slice(i-3, i+1).some(k => k.l < activeRange!.l);
        const tbRatio = bar.v > 0 ? bar.tbv / bar.v : 0.5;

        // 模拟吸收:
        // 如果破了High，且当前收在VAH以下，且高TakerBuy(买单被吸收)，做空
        if (brokeH && bar.c <= activeRange.vah && bar.c >= activeRange.val) {
            if (tbRatio > 0.55 && bar.c < bar.o) { // 强买但收阴
                signal = { side: "short", mode: "Trap", sl: activeRange.vah + 2 };
            }
        }
        // 如果破了Low，且当前收在VAL以上，且低TakerBuy(卖单被吸收)，做多
        if (!signal && brokeL && bar.c >= activeRange.val && bar.c <= activeRange.vah) {
            if (tbRatio < 0.45 && bar.c > bar.o) { // 强卖但收阳
                signal = { side: "long", mode: "Trap", sl: activeRange.val - 2 };
            }
        }

        // 2. FVG
        if (!signal) {
            const prev = m1[i-1];
            // 检测是否有 FVG
            if (prev.h < m1[i+1]?.l && price > activeRange.h) fvgState = { side: "long", l: prev.h, h: m1[i+1]?.l };
            if (prev.l > m1[i+1]?.h && price < activeRange.l) fvgState = { side: "short", h: prev.l, l: m1[i+1]?.h };

            // 吞噬回踩
            if (fvgState) {
                if (fvgState.side === "long" && bar.l <= fvgState.h && bar.l >= fvgState.l) {
                    if (bar.c > bar.o && (bar.c - bar.o)/(bar.h - bar.l) >= 0.6) {
                        signal = { side: "long", mode: "FVG", sl: fvgState.l - 1 };
                        fvgState = null;
                    }
                } else if (fvgState.side === "short" && bar.h >= fvgState.l && bar.h <= fvgState.h) {
                    if (bar.c < bar.o && (bar.o - bar.c)/(bar.h - bar.l) >= 0.6) {
                        signal = { side: "short", mode: "FVG", sl: fvgState.h + 1 };
                        fvgState = null;
                    }
                }
            }
        }

        if (signal) {
            // 开单
            let slPt = Math.abs(signal.sl - price);
            slPt = Math.max(15, Math.min(slPt, 25)); // 截断
            
            const qty = Math.floor(Math.max(0.1, (bal * 0.02) / slPt) * 10) / 10;
            const entryP = price;

            _log.push(`  ${utc8Time(bar.ts)} 🚀 V300 ${signal.mode} ${signal.side.toUpperCase()} @$${entryP.toFixed(1)} | SL=${slPt.toFixed(1)}pt TP=${tpDist.toFixed(1)}pt | ${qty}E`);

            let exitP = 0, reason = "";
            const maxHold = 180;
            
            // 追踪 Climax
            const avgVol = m1.slice(i-20, i).reduce((s,k)=>s+k.v, 0)/20 || 1;

            for (let j = i + 1; j < m1.length && j - i < maxHold; j++) {
                const b = m1[j];
                const ptBest = signal.side === "long" ? b.h - entryP : entryP - b.l;
                const ptWorst = signal.side === "long" ? b.l - entryP : entryP - b.h;
                
                // 1. SL
                if (ptWorst <= -slPt) {
                    exitP = signal.side === "long" ? entryP - slPt : entryP + slPt;
                    reason = "SL"; break; 
                }
                // 2. TP
                if (ptBest >= tpDist) {
                    exitP = signal.side === "long" ? entryP + tpDist : entryP - tpDist;
                    reason = "TP"; break;
                }
                // 3. Climax
                const ptNow = signal.side === "long" ? b.c - entryP : entryP - b.c;
                if (ptNow > 10 && b.v >= avgVol * 3.0) {
                    exitP = b.c; reason = "Climax"; break;
                }
                // 4. Noon
                if (h >= 9 && h <= 12 && utc8H(b.ts) >= 12) {
                    exitP = b.c; reason = "NOON"; break;
                }
            }

            if (!exitP) { exitP = m1[Math.min(i + maxHold - 1, m1.length - 1)].c; reason = "3H_TIMEOUT"; }
            
            const pt = signal.side === "long" ? exitP - entryP : entryP - exitP;
            const net = pt * qty - (entryP * qty + exitP * qty) * FEE;
            bal += net;

            trades.push({
                day, time: utc8Time(bar.ts), side: signal.side, entry: entryP, exit: exitP,
                pt, net, reason, trigger: signal.mode, qty, slPt
            });

            i += 60; // 冷却 60 bar
        }
    }
    return { trades, log: _log };
}

async function fetchMyK(sym: string, iv: string, s: number, e: number): Promise<K[]> {
    const all: K[] = []; let cur = s;
    while (cur < e) {
        const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${iv}&startTime=${cur}&endTime=${e}&limit=1500`;
        const r = await fetch(url); if (!r.ok) { await Bun.sleep(2000); continue; }
        const d = (await r.json()) as any[][]; if (!d.length) break;
        for (const k of d) all.push({ ts: k[0] as number, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], tbv: +k[9] });
        cur = (d[d.length - 1][6] as number) + 1; await Bun.sleep(100);
    }
    return all;
}

async function main() {
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log("  📊 V300 Order Flow / Battlefield 回测 — 模拟版");
    console.log("  包含: Trap Reversal, FVG Breakout, Climax TP, Anchor Windows");
    console.log("═══════════════════════════════════════════════════════════════════\n");

    const days = ["2026-03-22", "2026-03-23", "2026-03-24", "2026-03-25", "2026-03-26"];
    const firstDay = new Date(days[0] + "T00:00:00Z").getTime();
    const lastDay = new Date(days[days.length - 1] + "T00:00:00Z").getTime() + 86400000;

    console.log("📥 拉取 1m K线...");
    const m1All = await fetchMyK("ETHUSDT", "1m", firstDay - 4 * 3600000, lastDay);
    console.log("📥 拉取 1h K线...");
    const k1hAll = await fetchMyK("ETHUSDT", "1h", firstDay - 7 * 86400000, lastDay);

    let totalTrades: any[] = [];
    let totalPnl = 0;

    for (const dayStr of days) {
        const dayTs = new Date(dayStr + "T00:00:00Z").getTime();
        const nextDayTs = dayTs + 86400000;
        const m1Day = m1All.filter(k => k.ts >= dayTs - 4 * 3600000 && k.ts < nextDayTs);
        const k1hDay = k1hAll.filter(k => k.ts < dayTs);

        const { trades, log } = simulateDayV300(dayStr, m1Day, k1hDay);

        const dBar = m1All.filter(k => k.ts >= dayTs && k.ts < nextDayTs);
        const dO = dBar[0]?.o||0, dC = dBar[dBar.length-1]?.c||0;

        console.log(`\n📅 ${dayStr} | O=$${dO.toFixed(0)} C=$${dC.toFixed(0)} | ${(dC-dO)>0?"+":""}${(dC-dO).toFixed(0)}pt`);
        if (log.length) log.forEach(l => console.log(l));

        const dp = trades.reduce((a, t) => a + t.net, 0);
        if (trades.length > 0) {
            console.log(`\n  笔数: ${trades.length} | 净利: $${dp.toFixed(1)}`);
            for (const t of trades) {
                console.log(
                    `  ${t.time} | ${t.side.padEnd(5)} | ${t.qty.toFixed(1)}E | ` +
                    `$${t.entry.toFixed(1)} -> $${t.exit.toFixed(1)} | ` +
                    `${(t.pt>=0?"+":"")+t.pt.toFixed(1)}pt | ` +
                    `$${(t.net>=0?"+":"")+t.net.toFixed(1)} | ${t.reason} | ${t.trigger}`
                );
            }
        } else {
            console.log("  ⚠️ 无交易信号");
        }
        totalTrades.push(...trades);
        totalPnl += dp;
    }

    const wins = totalTrades.filter(t => t.net > 0);
    console.log("\n═══════════════════════════════════════════════════════════════════");
    console.log(`  📈 回测总结: ${days.length} 天`);
    console.log(`  总笔数: ${totalTrades.length} | 胜: ${wins.length} | 胜率: ${(wins.length/totalTrades.length*100 || 0).toFixed(0)}%`);
    console.log(`  总净利: $${totalPnl.toFixed(1)}`);
    console.log("═══════════════════════════════════════════════════════════════════\n");
}
main().catch(console.error);
