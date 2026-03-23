/**
 * 🔥 V96 三项优化回测
 * 基于10轮反思验证的3个可优化项，逐一回测对比
 *
 * 优化1: 回踩深度限制 — 穿越Close不超过区间的X%
 * 优化2: 5m确认升级 — 要求Higher Low结构（不只是阳线收回）
 * 优化3: SL细化 — 用回踩极值替代固定4H Low
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
    body: number; range: number; bodyR: number; dir: "long" | "short" | "skip";
}

function findFires(kl1h: K[], fS: number, fE: number, minBodyR: number): Fire[] {
    const fires: Fire[] = [];
    const dm = new Map<string, K[]>();
    for (const k of kl1h) { const d = new Date(k.ts).toISOString().slice(0, 10); if (!dm.has(d)) dm.set(d, []); dm.get(d)!.push(k); }
    for (const [date, bars] of dm) {
        const win = bars.filter(k => { const h = new Date(k.ts).getUTCHours(); return h >= fS && h < fE; });
        if (win.length < 2) continue;
        const o = win[0].o, c = win[win.length - 1].c;
        const h = Math.max(...win.map(k => k.h)), l = Math.min(...win.map(k => k.l));
        const body = Math.abs(c - o), range = h - l; if (range < 1) continue;
        const bodyR = body / range;
        let dir: "long" | "short" | "skip" = "skip";
        if (bodyR >= minBodyR) { dir = c > o ? "long" : "short"; }
        fires.push({ date, h, l, o, c, body, range, bodyR, dir });
    }
    return fires;
}

interface Cfg {
    name: string;
    // 基础参数
    fS: number; fE: number; tS: number; tE: number;
    minBodyR: number; tpR: number; maxHold: number; turtleBars: number;
    useTrail: boolean; trailPt: number;
    // 优化1: 回踩深度限制
    maxRetracePct: number;      // 回踩不超过区间的X% (0=不限)
    // 优化2: 5m确认升级
    requireHigherLow: boolean;  // 要求Higher Low结构
    // 优化3: SL细化
    slMode: "4hLow" | "sweepLow" | "hybrid";  // SL用4H Low还是回踩极值
}

interface Trade { date: string; side: string; entry: number; sl: number; tp: number; exit: number; pt: number; net: number; reason: string; }
interface Res { cfg: Cfg; trades: number; wins: number; pnl: number; wr: number; dd: number; pf: number; months: Record<string, number>; }

function run(kl5m: K[], fires: Fire[], qty: number, cfg: Cfg): Res {
    const trades: Trade[] = [];
    let bal = CAP, maxB = CAP, maxDD = 0;
    const months: Record<string, number> = {};

    for (const f of fires) {
        if (f.dir === "skip") continue;

        const after = kl5m.filter(k => {
            const kd = new Date(k.ts).toISOString().slice(0, 10);
            const kh = new Date(k.ts).getUTCHours();
            return kd === f.date && kh >= cfg.tS && kh <= cfg.tE;
        });
        if (after.length < 5) continue;

        // 找入场
        let ep = 0, entryIdx = -1, manipulated = false;
        let sweepExtreme = 0;  // 回踩极值
        let prevLow = 999999, prevHigh = 0;  // 用于Higher Low检测

        for (let i = 1; i < after.length; i++) {
            const bar = after[i];
            if (ep > 0) break;

            if (f.dir === "long") {
                // 检测回踩（价格跌破Close）
                if (!manipulated && bar.l < f.c) {
                    // 优化1: 回踩深度限制
                    if (cfg.maxRetracePct > 0) {
                        const retraceDepth = f.c - bar.l;
                        const maxAllowed = f.range * cfg.maxRetracePct;
                        if (retraceDepth > maxAllowed) continue; // 回踩太深，跳过这根bar
                    }
                    manipulated = true;
                    sweepExtreme = bar.l;
                    prevLow = bar.l;
                }
                if (manipulated) {
                    // 更新回踩极值
                    if (bar.l < sweepExtreme) sweepExtreme = bar.l;
                    
                    // 基础确认: 阳线收回Close上方
                    const basicConfirm = bar.c > f.c && bar.c > bar.o;
                    
                    if (basicConfirm) {
                        // 优化2: 要求Higher Low
                        if (cfg.requireHigherLow) {
                            // 当前bar的低点必须高于之前的低点
                            if (bar.l <= prevLow) {
                                prevLow = bar.l; // 更新低点继续等
                                continue;
                            }
                        }
                        ep = bar.c; entryIdx = i;
                    }
                    prevLow = Math.min(prevLow, bar.l);
                }
            } else { // short
                if (!manipulated && bar.h > f.c) {
                    if (cfg.maxRetracePct > 0) {
                        const retraceDepth = bar.h - f.c;
                        const maxAllowed = f.range * cfg.maxRetracePct;
                        if (retraceDepth > maxAllowed) continue;
                    }
                    manipulated = true;
                    sweepExtreme = bar.h;
                    prevHigh = bar.h;
                }
                if (manipulated) {
                    if (bar.h > sweepExtreme) sweepExtreme = bar.h;
                    const basicConfirm = bar.c < f.c && bar.c < bar.o;
                    if (basicConfirm) {
                        if (cfg.requireHigherLow) {
                            // 做空: 要求Lower High
                            if (bar.h >= prevHigh) {
                                prevHigh = bar.h;
                                continue;
                            }
                        }
                        ep = bar.c; entryIdx = i;
                    }
                    prevHigh = Math.max(prevHigh, bar.h);
                }
            }
        }
        if (ep === 0) continue;

        // 优化3: SL计算
        let sl: number;
        if (cfg.slMode === "4hLow") {
            sl = f.dir === "long" ? f.l - 1 : f.h + 1;
        } else if (cfg.slMode === "sweepLow") {
            sl = f.dir === "long" ? sweepExtreme - 1 : sweepExtreme + 1;
        } else { // hybrid: 取两者更近的那个
            const wide = f.dir === "long" ? f.l - 1 : f.h + 1;
            const tight = f.dir === "long" ? sweepExtreme - 1 : sweepExtreme + 1;
            sl = f.dir === "long" ? Math.max(wide, tight) : Math.min(wide, tight);
        }

        const risk = f.dir === "long" ? ep - sl : sl - ep;
        if (risk <= 0 || risk > 500) continue;
        const tp = f.dir === "long" ? ep + risk * cfg.tpR : ep - risk * cfg.tpR;

        // 模拟持仓
        const startIdx = kl5m.findIndex(k => k.ts === after[entryIdx].ts);
        if (startIdx < 0) continue;
        let exitP = 0, reason = "", bestPt = 0;
        for (let j = startIdx + 1; j < kl5m.length && j - startIdx < cfg.maxHold; j++) {
            const bar = kl5m[j];
            const pt = f.dir === "long" ? bar.c - ep : ep - bar.c;
            if (pt > bestPt) bestPt = pt;
            if (f.dir === "long") {
                if (bar.l <= sl) { exitP = sl; reason = "SL"; break; }
                if (bar.h >= tp) { exitP = tp; reason = "TP"; break; }
            } else {
                if (bar.h >= sl) { exitP = sl; reason = "SL"; break; }
                if (bar.l <= tp) { exitP = tp; reason = "TP"; break; }
            }
            if (cfg.useTrail && bestPt > risk) {
                const ts = f.dir === "long" ? ep + bestPt - cfg.trailPt : ep - bestPt + cfg.trailPt;
                const be = f.dir === "long" ? ep + 3 : ep - 3;
                const eff = f.dir === "long" ? Math.max(ts, be) : Math.min(ts, be);
                if ((f.dir === "long" && bar.c <= eff) || (f.dir === "short" && bar.c >= eff)) {
                    exitP = bar.c; reason = "TRAIL"; break;
                }
            }
        }
        if (exitP === 0) {
            exitP = kl5m[Math.min(startIdx + cfg.maxHold - 1, kl5m.length - 1)].c;
            reason = "TIMEOUT";
        }

        const pt = f.dir === "long" ? exitP - ep : ep - exitP;
        const fee = (ep * qty + exitP * qty) * FEE;
        const net = pt * qty - fee;
        bal += net; if (bal > maxB) maxB = bal;
        const dd = maxB - bal; if (dd > maxDD) maxDD = dd;
        const mon = f.date.slice(0, 7);
        months[mon] = (months[mon] || 0) + net;
        trades.push({ date: f.date, side: f.dir, entry: ep, sl, tp, exit: exitP, pt, net, reason });
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

function printTable(label: string, results: Res[]) {
    results.sort((a, b) => b.pnl - a.pnl);
    console.log(`\n${"─".repeat(70)}`);
    console.log(`  ${label}`);
    console.log(`${"─".repeat(70)}`);
    console.log(`  ${"方案".padEnd(28)} | 笔数 | 胜率  | 净利     | 回撤   | PF`);
    console.log(`  ${"-".repeat(65)}`);
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const mark = i === 0 ? " 🏆" : "";
        console.log(
            `  ${r.cfg.name.padEnd(28)} | ${String(r.trades).padStart(4)} | ${r.wr.toFixed(0).padStart(4)}% | $${(r.pnl >= 0 ? "+" : "") + r.pnl.toFixed(0).padStart(6)} | $${r.dd.toFixed(0).padStart(5)} | ${r.pf.toFixed(2)}${mark}`
        );
    }
    console.log(`  → 冠军: ${results[0].cfg.name}`);
}

async function main() {
    console.log("═══════════════════════════════════════════════════════════");
    console.log("  🔥 V96 三项优化回测验证");
    console.log("  ETHUSDT | $500 | 2026.01-03");
    console.log("═══════════════════════════════════════════════════════════\n");

    const sMs = new Date("2026-01-01T00:00:00Z").getTime();
    const eMs = new Date("2026-03-23T00:00:00Z").getTime();

    console.log("📥 拉取数据...");
    const kl1h = await fetchK("ETHUSDT", "1h", sMs - 7 * 86400000, eMs);
    const kl5m = await fetchK("ETHUSDT", "5m", sMs, eMs);
    console.log(`  1h:${kl1h.length} 5m:${kl5m.length}`);

    const fires = findFires(kl1h, 8, 12, 0.4);
    const base: Cfg = {
        name: "", fS: 8, fE: 12, tS: 12, tE: 22,
        minBodyR: 0.4, tpR: 3, maxHold: 120, turtleBars: 3,
        useTrail: false, trailPt: 15,
        maxRetracePct: 0, requireHigherLow: false, slMode: "4hLow"
    };

    // ═══ 基线: V96原版 ═══
    const baseline = run(kl5m, fires, 1.0, { ...base, name: "V96 原版（基线）" });
    console.log(`\n📊 基线: V96原版 → ${baseline.trades}笔 ${baseline.wr.toFixed(0)}%胜 $${baseline.pnl >= 0 ? "+" : ""}${baseline.pnl.toFixed(0)} PF=${baseline.pf.toFixed(2)}`);

    // ═══ 优化1: 回踩深度限制 ═══
    const opt1: Res[] = [
        run(kl5m, fires, 1.0, { ...base, name: "V96 原版(不限深度)", maxRetracePct: 0 }),
        run(kl5m, fires, 1.0, { ...base, name: "回踩≤30%区间", maxRetracePct: 0.3 }),
        run(kl5m, fires, 1.0, { ...base, name: "回踩≤40%区间", maxRetracePct: 0.4 }),
        run(kl5m, fires, 1.0, { ...base, name: "回踩≤50%区间", maxRetracePct: 0.5 }),
        run(kl5m, fires, 1.0, { ...base, name: "回踩≤60%区间", maxRetracePct: 0.6 }),
        run(kl5m, fires, 1.0, { ...base, name: "回踩≤80%区间", maxRetracePct: 0.8 }),
    ];
    printTable("🔬 优化1: 回踩深度限制（V10四分位概念）", opt1);

    // ═══ 优化2: 5m确认升级 ═══
    const opt2: Res[] = [
        run(kl5m, fires, 1.0, { ...base, name: "V96 原版(只看阳线收回)" }),
        run(kl5m, fires, 1.0, { ...base, name: "+Higher Low确认", requireHigherLow: true }),
        run(kl5m, fires, 1.0, { ...base, name: "+HL确认+回踩≤50%", requireHigherLow: true, maxRetracePct: 0.5 }),
        run(kl5m, fires, 1.0, { ...base, name: "+HL确认+回踩≤40%", requireHigherLow: true, maxRetracePct: 0.4 }),
    ];
    printTable("🔬 优化2: 5m确认升级（V4 Higher Low结构）", opt2);

    // ═══ 优化3: SL细化 ═══
    const opt3: Res[] = [
        run(kl5m, fires, 1.0, { ...base, name: "V96 原版(SL=4H Low)" }),
        run(kl5m, fires, 1.0, { ...base, name: "SL=回踩极值(sweep)", slMode: "sweepLow" }),
        run(kl5m, fires, 1.0, { ...base, name: "SL=混合(取更近)", slMode: "hybrid" }),
        run(kl5m, fires, 1.0, { ...base, name: "sweep+回踩≤50%", slMode: "sweepLow", maxRetracePct: 0.5 }),
        run(kl5m, fires, 1.0, { ...base, name: "sweep+HL确认", slMode: "sweepLow", requireHigherLow: true }),
    ];
    printTable("🔬 优化3: SL细化（V8附近关键价位）", opt3);

    // ═══ 终极组合: 三项优化叠加 ═══
    const combo: Res[] = [
        run(kl5m, fires, 1.0, { ...base, name: "V96 原版" }),
        run(kl5m, fires, 1.0, { ...base, name: "全部三项优化", maxRetracePct: 0.5, requireHigherLow: true, slMode: "sweepLow" }),
        run(kl5m, fires, 1.0, { ...base, name: "回踩50%+sweepSL", maxRetracePct: 0.5, slMode: "sweepLow" }),
        run(kl5m, fires, 1.0, { ...base, name: "HL确认+sweepSL", requireHigherLow: true, slMode: "sweepLow" }),
        run(kl5m, fires, 1.0, { ...base, name: "回踩50%+HL确认", maxRetracePct: 0.5, requireHigherLow: true }),
        // 加跟踪止盈的组合
        run(kl5m, fires, 1.0, { ...base, name: "V96+Trail15(基线对比)", useTrail: true, trailPt: 15 }),
        run(kl5m, fires, 1.0, { ...base, name: "三项优化+Trail15", maxRetracePct: 0.5, requireHigherLow: true, slMode: "sweepLow", useTrail: true, trailPt: 15 }),
        run(kl5m, fires, 1.0, { ...base, name: "sweepSL+Trail15", slMode: "sweepLow", useTrail: true, trailPt: 15 }),
    ];
    printTable("🏆 终极组合: 三项优化叠加对比", combo);

    // 输出月度明细
    console.log(`\n${"═".repeat(70)}`);
    console.log("  📅 月度明细（前4强）");
    console.log(`${"═".repeat(70)}`);
    combo.sort((a, b) => b.pnl - a.pnl);
    for (let i = 0; i < Math.min(4, combo.length); i++) {
        const r = combo[i];
        const ms = Object.entries(r.months).sort().map(([m, v]) => `${m.slice(5)}:${v >= 0 ? "+" : ""}${v.toFixed(0)}`).join(" | ");
        console.log(`  ${r.cfg.name}: ${ms}`);
    }

    console.log(`\n${"═".repeat(70)}`);
    console.log("  🏁 回测完成！数据说了算");
    console.log(`${"═".repeat(70)}\n`);
}

main().catch(console.error);
export {};
