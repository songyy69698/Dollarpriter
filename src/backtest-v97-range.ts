/**
 * 🔥 V97 4H 区间回收 — 10 轮迭代 + V96 对比
 * 视频8 Data Trader 已验证: BTC胜率72% EUR胜率83%
 *
 * 核心: 标记4H区间(H/L) → 等5m突破 → 回收区间内 → 反向开单
 *       不预判方向，让市场告诉我们
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

// ═══ 4H 区间 ═══
interface Range4H {
    date: string;
    h: number; l: number;
    o: number; c: number;
    range: number;
    bodyR: number;
    dir: "long" | "short" | "skip";  // V96用
    totalVol: number;
}

function findRanges(kl1h: K[], fS: number, fE: number): Range4H[] {
    const ranges: Range4H[] = [];
    const dm = new Map<string, K[]>();
    for (const k of kl1h) { const d = new Date(k.ts).toISOString().slice(0, 10); if (!dm.has(d)) dm.set(d, []); dm.get(d)!.push(k); }
    for (const [date, bars] of dm) {
        const win = bars.filter(k => { const h = new Date(k.ts).getUTCHours(); return h >= fS && h < fE; });
        if (win.length < 2) continue;
        const o = win[0].o, c = win[win.length - 1].c;
        const h = Math.max(...win.map(k => k.h)), l = Math.min(...win.map(k => k.l));
        const range = h - l; if (range < 3) continue;
        const body = Math.abs(c - o);
        const bodyR = body / range;
        const totalVol = win.reduce((a, k) => a + k.v, 0);
        let dir: "long" | "short" | "skip" = "skip";
        if (bodyR >= 0.4) { dir = c > o ? "long" : "short"; }
        ranges.push({ date, h, l, o, c, range, bodyR, dir, totalVol });
    }
    return ranges;
}

// ═══ 策略配置 ═══
interface Cfg {
    name: string;
    mode: "v96" | "v97";       // v96=延续 v97=回收
    fS: number; fE: number;     // Fire/区间窗口
    tS: number; tE: number;     // 交易窗口
    tpR: number;                // TP倍数
    minBodyR: number;           // V96用: 最低实体比
    minRange: number;           // V97用: 最小区间点数
    maxSweepPt: number;         // V97用: 最大突破距离
    volFilter: boolean;         // 量能过滤
    useTrail: boolean;          // 跟踪止盈
    trailPt: number;
    maxHold: number;            // 最大持仓bar数
    turtleBars: number;        // V96用
}

interface Trade { date: string; side: string; entry: number; sl: number; tp: number; exit: number; pt: number; net: number; reason: string; }
interface Res { cfg: Cfg; trades: number; wins: number; pnl: number; wr: number; dd: number; pf: number; months: Record<string, number>; }

function run(kl5m: K[], ranges: Range4H[], qty: number, cfg: Cfg): Res {
    const trades: Trade[] = [];
    let bal = CAP, maxB = CAP, maxDD = 0;
    const months: Record<string, number> = {};

    for (const r of ranges) {
        // ═══ V96: Fire Candle 延续 ═══
        if (cfg.mode === "v96") {
            if (r.dir === "skip") continue;

            const after = kl5m.filter(k => {
                const kd = new Date(k.ts).toISOString().slice(0, 10);
                const kh = new Date(k.ts).getUTCHours();
                return kd === r.date && kh >= cfg.tS && kh <= cfg.tE;
            });
            if (after.length < 5) continue;

            // 量能过滤
            if (cfg.volFilter) {
                const avgV = after.slice(0, 5).reduce((a, k) => a + k.v, 0) / 5;
                if (r.totalVol < avgV * 10) continue;
            }

            // 找入场
            let ep = 0, entryIdx = -1, manipulated = false;
            for (let i = 1; i < after.length; i++) {
                const bar = after[i];
                if (ep > 0) break;
                if (r.dir === "long") {
                    if (!manipulated && bar.l < r.c) manipulated = true;
                    if (manipulated) {
                        const lb = after.slice(Math.max(0, i - cfg.turtleBars), i + 1);
                        if (bar.c > r.c && bar.c > bar.o) { ep = bar.c; entryIdx = i; }
                    }
                } else {
                    if (!manipulated && bar.h > r.c) manipulated = true;
                    if (manipulated) {
                        if (bar.c < r.c && bar.c < bar.o) { ep = bar.c; entryIdx = i; }
                    }
                }
            }
            if (ep === 0) continue;

            const sl = r.dir === "long" ? r.l - 1 : r.h + 1;
            const risk = r.dir === "long" ? ep - sl : sl - ep;
            if (risk <= 0 || risk > 500) continue;
            const tp = r.dir === "long" ? ep + risk * cfg.tpR : ep - risk * cfg.tpR;

            // 模拟持仓
            const startIdx = kl5m.findIndex(k => k.ts === after[entryIdx].ts);
            if (startIdx < 0) continue;
            let exitP = 0, reason = "", bestPt = 0;
            for (let j = startIdx + 1; j < kl5m.length && j - startIdx < cfg.maxHold; j++) {
                const bar = kl5m[j];
                const pt = r.dir === "long" ? bar.c - ep : ep - bar.c;
                if (pt > bestPt) bestPt = pt;
                if (r.dir === "long") {
                    if (bar.l <= sl) { exitP = sl; reason = "SL"; break; }
                    if (bar.h >= tp) { exitP = tp; reason = "TP"; break; }
                } else {
                    if (bar.h >= sl) { exitP = sl; reason = "SL"; break; }
                    if (bar.l <= tp) { exitP = tp; reason = "TP"; break; }
                }
                if (cfg.useTrail && bestPt > risk) {
                    const ts = r.dir === "long" ? ep + bestPt - cfg.trailPt : ep - bestPt + cfg.trailPt;
                    const be = r.dir === "long" ? ep + 3 : ep - 3;
                    const eff = r.dir === "long" ? Math.max(ts, be) : Math.min(ts, be);
                    if ((r.dir === "long" && bar.c <= eff) || (r.dir === "short" && bar.c >= eff)) {
                        exitP = bar.c; reason = "TRAIL"; break;
                    }
                }
            }
            if (exitP === 0) {
                exitP = kl5m[Math.min(startIdx + cfg.maxHold - 1, kl5m.length - 1)].c;
                reason = "TIMEOUT";
            }

            const pt = r.dir === "long" ? exitP - ep : ep - exitP;
            const fee = (ep * qty + exitP * qty) * FEE;
            const net = pt * qty - fee;
            bal += net; if (bal > maxB) maxB = bal;
            const dd = maxB - bal; if (dd > maxDD) maxDD = dd;
            const mon = r.date.slice(0, 7);
            months[mon] = (months[mon] || 0) + net;
            trades.push({ date: r.date, side: r.dir, entry: ep, sl, tp, exit: exitP, pt, net, reason });
            continue;
        }

        // ═══ V97: 4H 区间回收 ═══
        if (r.range < cfg.minRange) continue;

        const after = kl5m.filter(k => {
            const kd = new Date(k.ts).toISOString().slice(0, 10);
            const kh = new Date(k.ts).getUTCHours();
            return kd === r.date && kh >= cfg.tS && kh <= cfg.tE;
        });
        if (after.length < 5) continue;

        // 量能过滤
        if (cfg.volFilter) {
            const avgV = after.slice(0, 5).reduce((a, k) => a + k.v, 0) / 5;
            if (r.totalVol < avgV * 10) continue;
        }

        // 找突破 → 回收
        let breakDir: "up" | "down" | null = null;
        let sweepExtreme = 0;
        let ep = 0, entryIdx = -1;
        let side: "long" | "short" = "long";

        for (let i = 1; i < after.length; i++) {
            const bar = after[i];
            if (ep > 0) break;

            // 检测突破
            if (!breakDir) {
                if (bar.c > r.h) {
                    breakDir = "up"; sweepExtreme = bar.h;
                } else if (bar.c < r.l) {
                    breakDir = "down"; sweepExtreme = bar.l;
                }
                continue;
            }

            // 更新突破极值
            if (breakDir === "up" && bar.h > sweepExtreme) sweepExtreme = bar.h;
            if (breakDir === "down" && bar.l < sweepExtreme) sweepExtreme = bar.l;

            // 检查突破距离限制
            const sweepDist = breakDir === "up" ? sweepExtreme - r.h : r.l - sweepExtreme;
            if (sweepDist > cfg.maxSweepPt) { breakDir = null; sweepExtreme = 0; continue; }

            // 回收到区间内 = 入场信号
            if (breakDir === "up" && bar.c < r.h && bar.c > r.l) {
                // 向上突破后回收 → 做空
                ep = bar.c; entryIdx = i; side = "short";
            } else if (breakDir === "down" && bar.c > r.l && bar.c < r.h) {
                // 向下突破后回收 → 做多
                ep = bar.c; entryIdx = i; side = "long";
            }
        }

        if (ep === 0) continue;

        // SL = 突破极值 + 1pt
        const sl = side === "long" ? sweepExtreme - 1 : sweepExtreme + 1;
        const risk = side === "long" ? ep - sl : sl - ep;
        if (risk <= 0 || risk > 500) continue;
        const tp = side === "long" ? ep + risk * cfg.tpR : ep - risk * cfg.tpR;

        // 模拟持仓
        const startIdx = kl5m.findIndex(k => k.ts === after[entryIdx].ts);
        if (startIdx < 0) continue;
        let exitP = 0, reason = "", bestPt = 0;
        for (let j = startIdx + 1; j < kl5m.length && j - startIdx < cfg.maxHold; j++) {
            const bar = kl5m[j];
            const pt = side === "long" ? bar.c - ep : ep - bar.c;
            if (pt > bestPt) bestPt = pt;
            if (side === "long") {
                if (bar.l <= sl) { exitP = sl; reason = "SL"; break; }
                if (bar.h >= tp) { exitP = tp; reason = "TP"; break; }
            } else {
                if (bar.h >= sl) { exitP = sl; reason = "SL"; break; }
                if (bar.l <= tp) { exitP = tp; reason = "TP"; break; }
            }
            if (cfg.useTrail && bestPt > risk) {
                const ts = side === "long" ? ep + bestPt - cfg.trailPt : ep - bestPt + cfg.trailPt;
                const be = side === "long" ? ep + 3 : ep - 3;
                const eff = side === "long" ? Math.max(ts, be) : Math.min(ts, be);
                if ((side === "long" && bar.c <= eff) || (side === "short" && bar.c >= eff)) {
                    exitP = bar.c; reason = "TRAIL"; break;
                }
            }
        }
        if (exitP === 0) {
            exitP = kl5m[Math.min(startIdx + cfg.maxHold - 1, kl5m.length - 1)].c;
            reason = "TIMEOUT";
        }

        const pt = side === "long" ? exitP - ep : ep - exitP;
        const fee = (ep * qty + exitP * qty) * FEE;
        const net = pt * qty - fee;
        bal += net; if (bal > maxB) maxB = bal;
        const dd = maxB - bal; if (dd > maxDD) maxDD = dd;
        const mon = r.date.slice(0, 7);
        months[mon] = (months[mon] || 0) + net;
        trades.push({ date: r.date, side, entry: ep, sl, tp, exit: exitP, pt, net, reason });
    }

    const w = trades.filter(t => t.net > 0);
    const tW = w.reduce((a, t) => a + t.net, 0);
    const tL = Math.abs(trades.filter(t => t.net < 0).reduce((a, t) => a + t.net, 0));
    return {
        cfg, trades: trades.length, wins: w.length,
        pnl: trades.reduce((a, t) => a + t.net, 0),
        wr: trades.length > 0 ? w.length / trades.length * 100 : 0,
        dd: maxDD, pf: tL > 0 ? tW / tL : 999, months
    };
}

async function main() {
    console.log("═══════════════════════════════════════════════════════════");
    console.log("  🔥 V96 vs V97 — 4H区间回收对比 + 10轮迭代");
    console.log("  ETHUSDT | $500 | 2026.01-03");
    console.log("═══════════════════════════════════════════════════════════\n");

    const sMs = new Date("2026-01-01T00:00:00Z").getTime();
    const eMs = new Date("2026-03-23T00:00:00Z").getTime();

    console.log("📥 拉取数据...");
    const kl1h = await fetchK("ETHUSDT", "1h", sMs - 7 * 86400000, eMs);
    const kl5m = await fetchK("ETHUSDT", "5m", sMs, eMs);
    console.log(`  1h:${kl1h.length} 5m:${kl5m.length}\n`);

    const v96base: Cfg = { name: "", mode: "v96", fS: 8, fE: 12, tS: 12, tE: 22, tpR: 3, minBodyR: 0.4, minRange: 0, maxSweepPt: 999, volFilter: false, useTrail: false, trailPt: 15, maxHold: 120, turtleBars: 3 };
    const v97base: Cfg = { name: "", mode: "v97", fS: 8, fE: 12, tS: 12, tE: 22, tpR: 2, minBodyR: 0, minRange: 5, maxSweepPt: 100, volFilter: false, useTrail: false, trailPt: 15, maxHold: 120, turtleBars: 1 };

    // ═══ 第一部分: V96 vs V97 Head-to-Head ═══
    console.log("─".repeat(70));
    console.log("  🥊 V96 vs V97 正面对决");
    console.log("─".repeat(70));

    const headToHead: Cfg[] = [
        { ...v96base, name: "V96 Fire(原版)" },
        { ...v96base, name: "V96+Trail", useTrail: true },
        { ...v96base, name: "V96+Vol", volFilter: true },
        { ...v97base, name: "V97 回收(基线)" },
        { ...v97base, name: "V97+Trail", useTrail: true },
        { ...v97base, name: "V97+Vol", volFilter: true },
        { ...v97base, name: "V97+Vol+Trail", volFilter: true, useTrail: true },
    ];

    const ranges = findRanges(kl1h, 8, 12);

    console.log(`  ${"方案".padEnd(22)} | 笔数 | 胜率  | 净利     | 回撤   | PF     | 月度`);
    console.log(`  ${"-".repeat(90)}`);
    for (const cfg of headToHead) {
        const res = run(kl5m, ranges, 1.0, cfg);
        const mark = res.pnl > 300 ? " 🏆" : res.pnl > 0 ? " ✅" : " ❌";
        const ms = Object.entries(res.months).sort().map(([m, v]) => `${m.slice(5)}:${v >= 0 ? "+" : ""}${v.toFixed(0)}`).join(" | ");
        console.log(
            `  ${cfg.name.padEnd(22)} | ${String(res.trades).padStart(4)} | ${res.wr.toFixed(0).padStart(4)}% | $${(res.pnl >= 0 ? "+" : "") + res.pnl.toFixed(0).padStart(6)} | $${res.dd.toFixed(0).padStart(5)} | ${res.pf.toFixed(2).padStart(5)}  | ${ms}${mark}`
        );
    }

    // ═══ 第二部分: V97 10轮迭代 ═══
    const rounds: { round: number; change: string; cfgs: Cfg[] }[] = [
        // R1: 区间窗口
        { round: 1, change: "区间窗口: 04-08 vs 06-10 vs 08-12 vs 00-04(亚盘)", cfgs: [
            { ...v97base, name: "04-08 UTC", fS: 4, fE: 8, tS: 8, tE: 22 },
            { ...v97base, name: "06-10 UTC", fS: 6, fE: 10, tS: 10, tE: 22 },
            { ...v97base, name: "08-12 UTC", fS: 8, fE: 12, tS: 12, tE: 22 },
            { ...v97base, name: "00-04 亚盘", fS: 0, fE: 4, tS: 4, tE: 22 },
        ]},
        // R2: TP倍数
        { round: 2, change: "TP盈亏比: 1.5R vs 2R vs 2.5R vs 3R", cfgs: [
            { ...v97base, name: "TP=1.5R", tpR: 1.5 },
            { ...v97base, name: "TP=2.0R", tpR: 2.0 },
            { ...v97base, name: "TP=2.5R", tpR: 2.5 },
            { ...v97base, name: "TP=3.0R", tpR: 3.0 },
        ]},
        // R3: 最小区间
        { round: 3, change: "最小区间: 3pt vs 5pt vs 10pt vs 15pt", cfgs: [
            { ...v97base, name: "Range≥3pt", minRange: 3 },
            { ...v97base, name: "Range≥5pt", minRange: 5 },
            { ...v97base, name: "Range≥10pt", minRange: 10 },
            { ...v97base, name: "Range≥15pt", minRange: 15 },
        ]},
        // R4: 最大突破距离
        { round: 4, change: "最大突破距离: 30pt vs 50pt vs 100pt vs 无限", cfgs: [
            { ...v97base, name: "Sweep≤30pt", maxSweepPt: 30 },
            { ...v97base, name: "Sweep≤50pt", maxSweepPt: 50 },
            { ...v97base, name: "Sweep≤100pt", maxSweepPt: 100 },
            { ...v97base, name: "Sweep≤999pt", maxSweepPt: 999 },
        ]},
        // R5: 追踪止盈
        { round: 5, change: "追踪止盈: 无 vs 10pt vs 15pt vs 20pt", cfgs: [
            { ...v97base, name: "无追踪" },
            { ...v97base, name: "Trail=10pt", useTrail: true, trailPt: 10 },
            { ...v97base, name: "Trail=15pt", useTrail: true, trailPt: 15 },
            { ...v97base, name: "Trail=20pt", useTrail: true, trailPt: 20 },
        ]},
        // R6: 量能过滤
        { round: 6, change: "量能过滤: 无 vs 有", cfgs: [
            { ...v97base, name: "无Vol过滤" },
            { ...v97base, name: "+Vol过滤", volFilter: true },
        ]},
        // R7: 交易窗口结束
        { round: 7, change: "交易窗口: 12-18 vs 12-20 vs 12-22 vs 12-02", cfgs: [
            { ...v97base, name: "12-18 UTC", tE: 18 },
            { ...v97base, name: "12-20 UTC", tE: 20 },
            { ...v97base, name: "12-22 UTC", tE: 22 },
        ]},
        // R8: 最大持仓时间
        { round: 8, change: "最大持仓: 30bar vs 60bar vs 120bar vs 240bar", cfgs: [
            { ...v97base, name: "Hold≤30", maxHold: 30 },
            { ...v97base, name: "Hold≤60", maxHold: 60 },
            { ...v97base, name: "Hold≤120", maxHold: 120 },
            { ...v97base, name: "Hold≤240", maxHold: 240 },
        ]},
        // R9: V97+Vol+Trail组合
        { round: 9, change: "最佳组合: V97 + Vol + Trail + 不同TP", cfgs: [
            { ...v97base, name: "V97+Vol+T15+2R", volFilter: true, useTrail: true, trailPt: 15, tpR: 2 },
            { ...v97base, name: "V97+Vol+T15+2.5R", volFilter: true, useTrail: true, trailPt: 15, tpR: 2.5 },
            { ...v97base, name: "V97+Vol+T15+3R", volFilter: true, useTrail: true, trailPt: 15, tpR: 3 },
            { ...v97base, name: "V97+Vol+T20+2R", volFilter: true, useTrail: true, trailPt: 20, tpR: 2 },
        ]},
        // R10: 终极PK
        { round: 10, change: "终极PK: V96冠军 vs V97冠军", cfgs: [
            { ...v96base, name: "V96最优", turtleBars: 3, useTrail: true, trailPt: 15 },
            { ...v97base, name: "V97最优(估)", volFilter: true, useTrail: true, trailPt: 15, tpR: 2 },
            { ...v97base, name: "V97激进", useTrail: true, trailPt: 10, tpR: 2.5, maxSweepPt: 50 },
            { ...v97base, name: "V97保守", volFilter: true, useTrail: true, trailPt: 20, tpR: 2, maxSweepPt: 30 },
        ]},
    ];

    for (const rd of rounds) {
        console.log(`\n${"─".repeat(70)}`);
        console.log(`  🔄 Round ${rd.round}: ${rd.change}`);
        console.log(`${"─".repeat(70)}`);

        const results: Res[] = [];
        for (const cfg of rd.cfgs) {
            const fires = findRanges(kl1h, cfg.fS, cfg.fE);
            results.push(run(kl5m, fires, 1.0, cfg));
        }
        results.sort((a, b) => b.pnl - a.pnl);

        console.log(`  ${"方案".padEnd(22)} | 笔数 | 胜率  | 净利     | 回撤   | PF`);
        console.log(`  ${"-".repeat(65)}`);
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const mark = i === 0 ? " 🏆" : "";
            console.log(
                `  ${r.cfg.name.padEnd(22)} | ${String(r.trades).padStart(4)} | ${r.wr.toFixed(0).padStart(4)}% | $${(r.pnl >= 0 ? "+" : "") + r.pnl.toFixed(0).padStart(6)} | $${r.dd.toFixed(0).padStart(5)} | ${r.pf.toFixed(2)}${mark}`
            );
        }
        console.log(`  → 冠军: ${results[0].cfg.name}`);
    }

    console.log(`\n${"═".repeat(70)}`);
    console.log("  🏁 回测完成！用以上数据决定V97方案");
    console.log(`${"═".repeat(70)}\n`);
}

main().catch(console.error);
export {};
