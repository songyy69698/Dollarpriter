/**
 * 🔬 V96 逐笔交易分析 — 找出赢/输的关键因素
 * 
 * 目标: 分析每笔交易的特征，找出精准过滤条件
 * 让每日交易的同时维持高胜率
 */
const FEE = 0.0004, CAP = 500;
interface K { ts: number; o: number; h: number; l: number; c: number; v: number; }

async function fetchK(sym: string, iv: string, s: number, e: number): Promise<K[]> {
    const all: K[] = []; let cur = s;
    while (cur < e) {
        const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${iv}&startTime=${cur}&endTime=${e}&limit=1500`;
        const r = await fetch(url); if (!r.ok) { await Bun.sleep(5000); continue; }
        const d = (await r.json()) as any[][]; if (!d.length) break;
        for (const k of d) all.push({ ts: k[0] as number, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
        cur = (d[d.length - 1][6] as number) + 1; await Bun.sleep(150);
    }
    return all;
}

interface Fire {
    date: string; h: number; l: number; o: number; c: number;
    bodyR: number; range: number; dir: "long" | "short";
    vol: number;  // 4H总成交量
    upperWick: number; lowerWick: number; // 上下影线比例
}

function findFires(kl1h: K[]): Fire[] {
    const fires: Fire[] = [];
    const dm = new Map<string, K[]>();
    for (const k of kl1h) { const d = new Date(k.ts).toISOString().slice(0, 10); if (!dm.has(d)) dm.set(d, []); dm.get(d)!.push(k); }
    for (const [date, bars] of dm) {
        const win = bars.filter(k => { const h = new Date(k.ts).getUTCHours(); return h >= 8 && h < 12; });
        if (win.length < 2) continue;
        const o = win[0].o, c = win[win.length - 1].c;
        const h = Math.max(...win.map(k => k.h)), l = Math.min(...win.map(k => k.l));
        const body = Math.abs(c - o), range = h - l; if (range < 3) continue;
        const bodyR = body / range;
        const dir = c > o ? "long" as const : "short" as const;
        const vol = win.reduce((a, k) => a + k.v, 0);
        // 上影线和下影线的比例
        const upperWick = c > o ? (h - c) / range : (h - o) / range;
        const lowerWick = c > o ? (o - l) / range : (c - l) / range;
        fires.push({ date, h, l, o, c, bodyR, range, dir, vol, upperWick, lowerWick });
    }
    return fires;
}

interface TradeDetail {
    date: string; dir: string;
    // Fire Candle特征
    bodyR: number; range: number; vol: number; upperWick: number; lowerWick: number;
    // 入场特征
    entryTime: string; manipDepth: number; manipDepthPct: number;
    // 结果
    result: "WIN" | "LOSS" | "TIMEOUT";
    net: number; slPt: number; holdBars: number;
    // 上下文
    prevDayDir: string; prevDayResult: string;
    entryHour: number;
}

async function main() {
    console.log("═══════════════════════════════════════════════════════════");
    console.log("  🔬 V96 逐笔交易深度分析");
    console.log("═══════════════════════════════════════════════════════════\n");

    const sMs = new Date("2026-01-01T00:00:00Z").getTime();
    const eMs = new Date("2026-03-23T00:00:00Z").getTime();
    console.log("📥 拉取数据...");
    const kl1h = await fetchK("ETHUSDT", "1h", sMs - 7 * 86400000, eMs);
    const kl5m = await fetchK("ETHUSDT", "5m", sMs, eMs);
    console.log(`  1h:${kl1h.length} 5m:${kl5m.length}\n`);

    const fires = findFires(kl1h);
    const allTrades: TradeDetail[] = [];
    let prevDir = "", prevResult = "";

    for (const f of fires) {
        const after = kl5m.filter(k => {
            const d = new Date(k.ts);
            return d.toISOString().slice(0, 10) === f.date && d.getUTCHours() >= 12 && d.getUTCHours() <= 20;
        });
        if (after.length < 5) continue;

        let ep = 0, entryIdx = -1, manipulated = false, manipExtreme = 0;
        for (let i = 1; i < after.length; i++) {
            const bar = after[i];
            if (ep > 0) break;
            if (f.dir === "long") {
                if (!manipulated && bar.l < f.c) {
                    manipulated = true;
                    manipExtreme = bar.l;
                }
                if (manipulated) {
                    if (bar.l < manipExtreme) manipExtreme = bar.l;
                    if (bar.c > f.c && bar.c > bar.o && after[i - 1].c < f.c) { ep = bar.c; entryIdx = i; }
                }
            } else {
                if (!manipulated && bar.h > f.c) {
                    manipulated = true;
                    manipExtreme = bar.h;
                }
                if (manipulated) {
                    if (bar.h > manipExtreme) manipExtreme = bar.h;
                    if (bar.c < f.c && bar.c < bar.o && after[i - 1].c > f.c) { ep = bar.c; entryIdx = i; }
                }
            }
        }
        if (ep === 0) { prevDir = f.dir; prevResult = "SKIP"; continue; }

        const sl = f.dir === "long" ? f.l - 1 : f.h + 1;
        const risk = f.dir === "long" ? ep - sl : sl - ep;
        if (risk <= 0 || risk > 500) continue;
        const tp = f.dir === "long" ? ep + risk * 3 : ep - risk * 3;

        const startIdx = kl5m.findIndex(k => k.ts === after[entryIdx].ts);
        if (startIdx < 0) continue;
        let exitP = 0, reason = "", holdBars = 0;
        for (let j = startIdx + 1; j < kl5m.length && j - startIdx < 120; j++) {
            holdBars = j - startIdx;
            const bar = kl5m[j];
            if (f.dir === "long") { if (bar.l <= sl) { exitP = sl; reason = "SL"; break; } if (bar.h >= tp) { exitP = tp; reason = "TP"; break; } }
            else { if (bar.h >= sl) { exitP = sl; reason = "SL"; break; } if (bar.l <= tp) { exitP = tp; reason = "TP"; break; } }
        }
        if (exitP === 0) { exitP = kl5m[Math.min(startIdx + 119, kl5m.length - 1)].c; reason = "TIMEOUT"; holdBars = 120; }

        const pt = f.dir === "long" ? exitP - ep : ep - exitP;
        const net = pt * 1.0 - (ep + exitP) * FEE;
        const manipDepth = f.dir === "long" ? f.c - manipExtreme : manipExtreme - f.c;
        const entryH = new Date(after[entryIdx].ts).getUTCHours();

        allTrades.push({
            date: f.date, dir: f.dir,
            bodyR: f.bodyR, range: f.range, vol: f.vol,
            upperWick: f.upperWick, lowerWick: f.lowerWick,
            entryTime: new Date(after[entryIdx].ts).toISOString().slice(11, 16),
            manipDepth, manipDepthPct: f.range > 0 ? manipDepth / f.range : 0,
            result: net > 0 ? "WIN" : reason === "TIMEOUT" ? "TIMEOUT" : "LOSS",
            net, slPt: risk, holdBars,
            prevDayDir: prevDir, prevDayResult: prevResult,
            entryHour: entryH,
        });
        prevDir = f.dir;
        prevResult = net > 0 ? "WIN" : "LOSS";
    }

    // ═══ 分析1: bodyR分组统计 ═══
    console.log("═══ 分析1: bodyR分组 ═══");
    const brGroups = [
        { label: "0-20%", filter: (t: TradeDetail) => t.bodyR < 0.2 },
        { label: "20-40%", filter: (t: TradeDetail) => t.bodyR >= 0.2 && t.bodyR < 0.4 },
        { label: "40-60%", filter: (t: TradeDetail) => t.bodyR >= 0.4 && t.bodyR < 0.6 },
        { label: "60%+", filter: (t: TradeDetail) => t.bodyR >= 0.6 },
    ];
    for (const g of brGroups) {
        const t = allTrades.filter(g.filter);
        const w = t.filter(x => x.result === "WIN");
        const pnl = t.reduce((a, x) => a + x.net, 0);
        console.log(`  ${g.label.padEnd(8)} | ${t.length}笔 | ${w.length}赢(${t.length > 0 ? (w.length / t.length * 100).toFixed(0) : 0}%) | $${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}`);
    }

    // ═══ 分析2: 回踩深度分组 ═══
    console.log("\n═══ 分析2: 回踩深度(占区间%) ═══");
    const mdGroups = [
        { label: "<10%", filter: (t: TradeDetail) => t.manipDepthPct < 0.1 },
        { label: "10-30%", filter: (t: TradeDetail) => t.manipDepthPct >= 0.1 && t.manipDepthPct < 0.3 },
        { label: "30-50%", filter: (t: TradeDetail) => t.manipDepthPct >= 0.3 && t.manipDepthPct < 0.5 },
        { label: "50%+", filter: (t: TradeDetail) => t.manipDepthPct >= 0.5 },
    ];
    for (const g of mdGroups) {
        const t = allTrades.filter(g.filter);
        const w = t.filter(x => x.result === "WIN");
        const pnl = t.reduce((a, x) => a + x.net, 0);
        console.log(`  ${g.label.padEnd(8)} | ${t.length}笔 | ${w.length}赢(${t.length > 0 ? (w.length / t.length * 100).toFixed(0) : 0}%) | $${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}`);
    }

    // ═══ 分析3: SL大小分组 ═══
    console.log("\n═══ 分析3: SL大小(pt) ═══");
    const slGroups = [
        { label: "<30pt", filter: (t: TradeDetail) => t.slPt < 30 },
        { label: "30-60pt", filter: (t: TradeDetail) => t.slPt >= 30 && t.slPt < 60 },
        { label: "60-100pt", filter: (t: TradeDetail) => t.slPt >= 60 && t.slPt < 100 },
        { label: "100pt+", filter: (t: TradeDetail) => t.slPt >= 100 },
    ];
    for (const g of slGroups) {
        const t = allTrades.filter(g.filter);
        const w = t.filter(x => x.result === "WIN");
        const pnl = t.reduce((a, x) => a + x.net, 0);
        console.log(`  ${g.label.padEnd(8)} | ${t.length}笔 | ${w.length}赢(${t.length > 0 ? (w.length / t.length * 100).toFixed(0) : 0}%) | $${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}`);
    }

    // ═══ 分析4: 入场时间 ═══
    console.log("\n═══ 分析4: 入场时间(UTC) ═══");
    const hourGroups = [
        { label: "12-14h", filter: (t: TradeDetail) => t.entryHour >= 12 && t.entryHour < 14 },
        { label: "14-16h", filter: (t: TradeDetail) => t.entryHour >= 14 && t.entryHour < 16 },
        { label: "16-18h", filter: (t: TradeDetail) => t.entryHour >= 16 && t.entryHour < 18 },
        { label: "18-20h", filter: (t: TradeDetail) => t.entryHour >= 18 && t.entryHour <= 20 },
    ];
    for (const g of hourGroups) {
        const t = allTrades.filter(g.filter);
        const w = t.filter(x => x.result === "WIN");
        const pnl = t.reduce((a, x) => a + x.net, 0);
        console.log(`  ${g.label.padEnd(8)} | ${t.length}笔 | ${w.length}赢(${t.length > 0 ? (w.length / t.length * 100).toFixed(0) : 0}%) | $${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}`);
    }

    // ═══ 分析5: 方向 ═══
    console.log("\n═══ 分析5: 方向 ═══");
    for (const dir of ["long", "short"]) {
        const t = allTrades.filter(x => x.dir === dir);
        const w = t.filter(x => x.result === "WIN");
        const pnl = t.reduce((a, x) => a + x.net, 0);
        console.log(`  ${dir.padEnd(8)} | ${t.length}笔 | ${w.length}赢(${t.length > 0 ? (w.length / t.length * 100).toFixed(0) : 0}%) | $${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}`);
    }

    // ═══ 分析6: 区间大小 ═══
    console.log("\n═══ 分析6: 4H区间大小 ═══");
    const rangeGroups = [
        { label: "<30pt", filter: (t: TradeDetail) => t.range < 30 },
        { label: "30-60pt", filter: (t: TradeDetail) => t.range >= 30 && t.range < 60 },
        { label: "60-100pt", filter: (t: TradeDetail) => t.range >= 60 && t.range < 100 },
        { label: "100pt+", filter: (t: TradeDetail) => t.range >= 100 },
    ];
    for (const g of rangeGroups) {
        const t = allTrades.filter(g.filter);
        const w = t.filter(x => x.result === "WIN");
        const pnl = t.reduce((a, x) => a + x.net, 0);
        console.log(`  ${g.label.padEnd(8)} | ${t.length}笔 | ${w.length}赢(${t.length > 0 ? (w.length / t.length * 100).toFixed(0) : 0}%) | $${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}`);
    }

    // ═══ 分析7: 影线比 ═══
    console.log("\n═══ 分析7: 反向影线比（做多看上影线，做空看下影线）═══");
    const wickGroups = [
        { label: "<10%", filter: (t: TradeDetail) => (t.dir === "long" ? t.upperWick : t.lowerWick) < 0.1 },
        { label: "10-25%", filter: (t: TradeDetail) => { const w = t.dir === "long" ? t.upperWick : t.lowerWick; return w >= 0.1 && w < 0.25; } },
        { label: "25%+", filter: (t: TradeDetail) => (t.dir === "long" ? t.upperWick : t.lowerWick) >= 0.25 },
    ];
    for (const g of wickGroups) {
        const t = allTrades.filter(g.filter);
        const w = t.filter(x => x.result === "WIN");
        const pnl = t.reduce((a, x) => a + x.net, 0);
        console.log(`  ${g.label.padEnd(8)} | ${t.length}笔 | ${w.length}赢(${t.length > 0 ? (w.length / t.length * 100).toFixed(0) : 0}%) | $${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}`);
    }

    // ═══ 分析8: 前一天结果 ═══
    console.log("\n═══ 分析8: 前一天结果影响 ═══");
    for (const pr of ["WIN", "LOSS", "SKIP", ""]) {
        const t = allTrades.filter(x => x.prevDayResult === pr);
        const w = t.filter(x => x.result === "WIN");
        if (t.length === 0) continue;
        const pnl = t.reduce((a, x) => a + x.net, 0);
        console.log(`  前天${(pr || "首日").padEnd(6)} | ${t.length}笔 | ${w.length}赢(${(w.length / t.length * 100).toFixed(0)}%) | $${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}`);
    }

    // ═══ 综合结论 ═══
    console.log("\n═══ 输单特征分析 ═══");
    const losses = allTrades.filter(t => t.result === "LOSS");
    const wins = allTrades.filter(t => t.result === "WIN");
    console.log(`  赢单平均: bodyR=${(wins.reduce((a, t) => a + t.bodyR, 0) / wins.length * 100).toFixed(0)}% range=${(wins.reduce((a, t) => a + t.range, 0) / wins.length).toFixed(0)}pt SL=${(wins.reduce((a, t) => a + t.slPt, 0) / wins.length).toFixed(0)}pt 回踩${(wins.reduce((a, t) => a + t.manipDepthPct, 0) / wins.length * 100).toFixed(0)}%`);
    console.log(`  输单平均: bodyR=${(losses.reduce((a, t) => a + t.bodyR, 0) / losses.length * 100).toFixed(0)}% range=${(losses.reduce((a, t) => a + t.range, 0) / losses.length).toFixed(0)}pt SL=${(losses.reduce((a, t) => a + t.slPt, 0) / losses.length).toFixed(0)}pt 回踩${(losses.reduce((a, t) => a + t.manipDepthPct, 0) / losses.length * 100).toFixed(0)}%`);

    console.log("\n═══ 完成 ═══");
}

main().catch(console.error);
export {};
