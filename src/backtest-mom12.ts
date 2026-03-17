/**
 * 🧪 mom12>50 做空 + K棒实体影线 + 成交量确认 + CEO窗口
 * ═══════════════════════════════════════════════════════════
 * 入场逻辑:
 *   ① 窗口: 08/15/22 UTC+8
 *   ② 动量: 过去12根5m K线涨幅 > 阈值pt → 做空
 *   ③ K棒: 实体占比小+上影线长 = 上方拒绝 (不看红绿!)
 *   ④ 成交量: 当前量 > 均量×倍数 = 放量确认
 *   ⑤ V50保护: ATR<55 + EMA200趋势
 *
 * 出场: 扫描 SL/BE/Trail
 * 数据: Binance ETHUSDT 5m K线 (2026年1-3月)
 *
 * 用法: bun run src/backtest-mom12.ts
 */

const LEVERAGE = 200;
const TAKER_FEE = 0.0004;
const INITIAL_CAPITAL = 200;
const MARGIN_PER_TRADE = 15;
const MAX_DAILY_TRADES = 3;
const MAX_DAILY_LOSS = 60;
const MAX_HOLD_BARS = 60;    // 5m×60=5h
const MIN_HOLD_BARS = 3;     // 最少15分钟
const EMA200_PERIOD = 200;
const ATR_BAN = 55;

// ═══ 扫描空间 ═══
const MOM_THRESHOLDS = [30, 40, 50, 60, 70];   // 动量阈值
const VOL_MULTS = [1.0, 1.5, 2.0];             // 成交量倍数门槛
const SL_RANGE = [8, 10, 12, 15, 20];
const BE_RANGE = [5, 8, 10, 12];
const BE_OFF_RANGE = [1, 2, 3];
const TRAIL_RANGE = [5, 8, 10, 12, 15];

// 窗口
const WINDOWS = [
    { name: "08窗口", sH: 8, eH: 9 },
    { name: "15窗口", sH: 15, eH: 16 },
    { name: "22窗口", sH: 22, eH: 23 },
];

// 也测试做多 (mom12 < -阈值 → 跌太多 → 做多赌反弹)
const MODES = ["short_only", "both"] as const;

interface K5 { ts: number; o: number; h: number; l: number; c: number; v: number; }
interface P {
    momTh: number; volMult: number; sl: number; be: number; bo: number; tr: number;
    mode: "short_only" | "both";
}
interface Pos {
    side: "long"|"short"; entry: number; qty: number;
    idx: number; beTrig: boolean; bestPt: number;
}
interface Res {
    p: P; trades: number; wins: number; pnl: number;
    wr: number; avgW: number; avgL: number; dd: number;
    byW: Record<string, { t: number; pnl: number }>;
}

// K线拉取
async function fetchK(s: number, e: number): Promise<K5[]> {
    const all: K5[] = []; let cur = s;
    while (cur < e) {
        const url = `https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=5m&startTime=${cur}&endTime=${e}&limit=1500`;
        const r = await fetch(url);
        if (!r.ok) { await Bun.sleep(3000); continue; }
        const data = (await r.json()) as any[][];
        if (!data.length) break;
        for (const k of data)
            all.push({ ts: k[0] as number, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
        cur = (data[data.length - 1][6] as number) + 1;
        process.stdout.write(`\r  📥 5m ${((cur - s) / (e - s) * 100).toFixed(1)}% | ${all.length}根`);
        await Bun.sleep(150);
    }
    console.log(`\n  ✅ ${all.length} 根`);
    return all;
}

// 指标
class Ind {
    c: number[] = []; hs: number[] = []; ls: number[] = []; vs: number[] = [];
    ema = 0; emaReady = false;

    push(k: K5) {
        this.c.push(k.c); this.hs.push(k.h); this.ls.push(k.l); this.vs.push(k.v);
        if (!this.emaReady) {
            if (this.c.length >= EMA200_PERIOD) {
                this.ema = this.c.slice(-EMA200_PERIOD).reduce((a, b) => a + b) / EMA200_PERIOD;
                this.emaReady = true;
            }
        } else {
            const m = 2 / (EMA200_PERIOD + 1);
            this.ema = k.c * m + this.ema * (1 - m);
        }
        if (this.c.length > 500) {
            this.c = this.c.slice(-400); this.hs = this.hs.slice(-400);
            this.ls = this.ls.slice(-400); this.vs = this.vs.slice(-400);
        }
    }

    get ready() { return this.emaReady && this.c.length > 20; }

    atr14(): number {
        const n = this.hs.length; if (n < 14) return 0;
        let s = 0; for (let i = n - 14; i < n; i++) s += this.hs[i] - this.ls[i];
        return s / 14;
    }

    /** 12根K线动量 (最新close - 12根前close) */
    mom12(): number {
        const n = this.c.length;
        return n >= 13 ? this.c[n - 1] - this.c[n - 13] : 0;
    }

    /** 平均成交量 (过去20根) */
    avgVol(): number {
        const n = this.vs.length; if (n < 20) return 1;
        let s = 0; for (let i = n - 20; i < n; i++) s += this.vs[i];
        return s / 20;
    }

    /** 当前K线成交量 */
    curVol(): number {
        return this.vs.length > 0 ? this.vs[this.vs.length - 1] : 0;
    }

    /**
     * K棒形态分析 (不看红绿!)
     * 返回: { bodyRatio, upperShadow, lowerShadow }
     *   bodyRatio: 实体占总range的比例 (0~1, 小=十字星)
     *   upperShadow: 上影线占总range比例 (大=上方拒绝)
     *   lowerShadow: 下影线占总range比例 (大=下方拒绝)
     */
    barShape(): { bodyR: number; upperR: number; lowerR: number } {
        const n = this.c.length;
        if (n < 1) return { bodyR: 1, upperR: 0, lowerR: 0 };
        const i = n - 1;
        const h = this.hs[i], l = this.ls[i];
        const range = h - l;
        if (range <= 0) return { bodyR: 0, upperR: 0, lowerR: 0 };

        const o = n >= 2 ? this.c[i - 1] : this.c[i]; // 用前一根close作为open代理
        const c = this.c[i];
        const bodyTop = Math.max(o, c), bodyBot = Math.min(o, c);
        const body = bodyTop - bodyBot;

        return {
            bodyR: body / range,
            upperR: (h - bodyTop) / range,
            lowerR: (bodyBot - l) / range,
        };
    }
}

// 窗口检查
function getWin(ts: number): typeof WINDOWS[0] | null {
    const utc8 = new Date(ts + 8 * 3600000);
    const hm = utc8.getUTCHours() * 60 + utc8.getUTCMinutes();
    for (const w of WINDOWS) {
        if (hm >= w.sH * 60 && hm < w.eH * 60) return w;
    }
    return null;
}

// 出场
function chkExit(pos: Pos, price: number, bars: number, p: P) {
    const pt = pos.side === "long" ? price - pos.entry : pos.entry - price;
    if (pt > pos.bestPt) pos.bestPt = pt;
    if (pt <= -p.sl) return { ep: pos.side === "long" ? pos.entry - p.sl : pos.entry + p.sl, r: "SL" };
    if (bars < MIN_HOLD_BARS) return null;
    if (!pos.beTrig && pt >= p.be) pos.beTrig = true;
    if (pos.beTrig && pos.bestPt > p.be) {
        const tSl = pos.side === "long" ? pos.entry + pos.bestPt - p.tr : pos.entry - pos.bestPt + p.tr;
        const beF = pos.side === "long" ? pos.entry + p.bo : pos.entry - p.bo;
        const eff = pos.side === "long" ? Math.max(tSl, beF) : Math.min(tSl, beF);
        if ((pos.side === "long" && price <= eff) || (pos.side === "short" && price >= eff))
            return { ep: price, r: `TR` };
    }
    if (bars >= MAX_HOLD_BARS) return { ep: price, r: "TIME" };
    return null;
}

// 单次回测
function run(kl: K5[], p: P): Res {
    const ind = new Ind();
    let bal = INITIAL_CAPITAL, pos: Pos | null = null;
    let trades = 0, wins = 0, netPnl = 0;
    const wp: number[] = [], lp: number[] = [];
    let maxB = INITIAL_CAPITAL, maxDD = 0;
    let curD = "", dT = 0, dP = 0;
    const wT = new Set<string>();
    const byW: Record<string, { t: number; pnl: number }> = {};
    for (const w of WINDOWS) byW[w.name] = { t: 0, pnl: 0 };
    let lastW = "";

    for (let i = 0; i < kl.length; i++) {
        const k = kl[i]; ind.push(k);
        const d = new Date(k.ts + 8 * 3600000).toISOString().slice(0, 10);
        if (d !== curD) { curD = d; dT = 0; dP = 0; wT.clear(); }
        if (!ind.ready) continue;

        if (pos) {
            const bars = i - pos.idx;
            const worst = pos.side === "long" ? k.l : k.h;
            const ex = chkExit(pos, worst, bars, p) || chkExit(pos, k.c, bars, p);
            if (ex) {
                const pt = pos.side === "long" ? ex.ep - pos.entry : pos.entry - ex.ep;
                const net = pt * pos.qty - (pos.entry * pos.qty + ex.ep * pos.qty) * TAKER_FEE;
                bal += net; trades++; dT++; dP += net; netPnl += net;
                if (net > 0) { wins++; wp.push(net); } else lp.push(net);
                if (bal > maxB) maxB = bal; const dd = maxB - bal; if (dd > maxDD) maxDD = dd;
                if (lastW && byW[lastW]) { byW[lastW].t++; byW[lastW].pnl += net; }
                pos = null;
            }
            continue;
        }

        if (dT >= MAX_DAILY_TRADES || dP <= -MAX_DAILY_LOSS || bal < MARGIN_PER_TRADE) continue;

        const w = getWin(k.ts);
        if (!w) continue;
        const wKey = `${d}_${w.name}`;
        if (wT.has(wKey)) continue;

        // V50: ATR
        if (ind.atr14() > ATR_BAN) continue;

        // 动量
        const mom = ind.mom12();

        // 成交量确认
        const volOk = ind.curVol() >= ind.avgVol() * p.volMult;
        if (!volOk) continue;

        // K棒形态
        const bar = ind.barShape();

        let side: "long" | "short" | "" = "";

        // 做空: 涨太多 + 上影线长(上方拒绝) + 实体小(犹豫)
        if (mom > p.momTh) {
            // K棒确认: 上影线 > 30% 或 实体 < 60% (非强势大阳线)
            const barConfirm = bar.upperR > 0.3 || bar.bodyR < 0.6;
            // EMA200: 做空不需要在EMA下方 (因为是做空涨太多的回归)
            if (barConfirm) side = "short";
        }

        // 做多 (反向): 跌太多 + 下影线长(下方拒绝) + 实体小
        if (p.mode === "both" && !side && mom < -p.momTh) {
            const barConfirm = bar.lowerR > 0.3 || bar.bodyR < 0.6;
            if (barConfirm) side = "long";
        }

        if (!side) continue;

        wT.add(wKey);
        lastW = w.name;
        const margin = Math.min(MARGIN_PER_TRADE, bal);
        const qty = (margin * LEVERAGE) / k.c;
        pos = { side, entry: k.c, qty, idx: i, beTrig: false, bestPt: 0 };
    }

    // 末尾
    if (pos && kl.length > 0) {
        const lk = kl[kl.length - 1];
        const pt = pos.side === "long" ? lk.c - pos.entry : pos.entry - lk.c;
        const net = pt * pos.qty - (pos.entry * pos.qty + lk.c * pos.qty) * TAKER_FEE;
        bal += net; trades++; netPnl += net;
        if (net > 0) { wins++; wp.push(net); } else lp.push(net);
    }

    return {
        p, trades, wins, pnl: netPnl,
        wr: trades > 0 ? wins / trades * 100 : 0,
        avgW: wp.length > 0 ? wp.reduce((a, b) => a + b, 0) / wp.length : 0,
        avgL: lp.length > 0 ? lp.reduce((a, b) => a + b, 0) / lp.length : 0,
        dd: maxDD, byW,
    };
}

// ═══ 主程序 ═══
async function main() {
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log("  🧪 mom12做空 + K棒形态 + 成交量 + CEO窗口 | ETH 5m");
    console.log("  📊 K棒: 实体比+上影线 (不看红绿) | 量: 当前>均量×N");
    console.log("  🛡️ V50: ATR<55 | 窗口: 08/15/22");
    console.log("═══════════════════════════════════════════════════════════════════\n");

    const sMs = new Date("2026-01-01T00:00:00Z").getTime();
    const eMs = new Date("2026-03-18T00:00:00Z").getTime();
    const kl = await fetchK(sMs, eMs);
    if (!kl.length) { console.log("❌ 无数据!"); return; }

    // 生成参数组合
    const combos: P[] = [];
    for (const mode of MODES) {
        for (const momTh of MOM_THRESHOLDS) {
            for (const volMult of VOL_MULTS) {
                for (const sl of SL_RANGE) {
                    for (const be of BE_RANGE) {
                        if (be >= sl) continue;
                        for (const bo of BE_OFF_RANGE) {
                            if (bo >= be) continue;
                            for (const tr of TRAIL_RANGE) {
                                combos.push({ momTh, volMult, sl, be, bo, tr, mode });
                            }
                        }
                    }
                }
            }
        }
    }

    console.log(`\n🔬 组合: ${combos.length} | 开始...\n`);
    const res: Res[] = [];
    const t0 = performance.now();

    for (let i = 0; i < combos.length; i++) {
        res.push(run(kl, combos[i]));
        if ((i + 1) % 500 === 0 || i === combos.length - 1)
            process.stdout.write(`\r  ⚡ ${((i + 1) / combos.length * 100).toFixed(0)}% (${i + 1}/${combos.length}) | ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    }
    console.log(`\n\n✅ ${((performance.now() - t0) / 1000).toFixed(1)}s\n`);

    res.sort((a, b) => b.pnl - a.pnl);
    const profitable = res.filter(r => r.pnl > 0).length;

    // ═══ 输出 ═══
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log("  🏆 TOP 30");
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log("  #  | 模式 MOM VOL | SL  BE→+N TR | 胜率 | 净利      | 笔  | 均盈   均亏   | DD$");
    console.log("  " + "─".repeat(85));

    for (let i = 0; i < Math.min(30, res.length); i++) {
        const r = res[i], p = r.p;
        const md = p.mode === "short_only" ? "空" : "双";
        console.log(
            `  ${String(i + 1).padStart(2)} | ` +
            `${md}  ${String(p.momTh).padStart(2)} ${p.volMult.toFixed(1)} | ` +
            `${String(p.sl).padStart(2)} ${String(p.be).padStart(2)}→+${p.bo} ${String(p.tr).padStart(2)} | ` +
            `${r.wr.toFixed(0).padStart(3)}% | ` +
            `${(r.pnl >= 0 ? "+" : "") + r.pnl.toFixed(2)}`.padStart(10) + ` | ` +
            `${String(r.trades).padStart(3)} | ` +
            `${r.avgW.toFixed(1).padStart(6)} ${r.avgL.toFixed(1).padStart(6)} | ` +
            `$${r.dd.toFixed(0)}`
        );
    }

    // 冠军窗口拆解
    if (res.length > 0 && res[0].pnl > -INITIAL_CAPITAL) {
        const best = res[0];
        console.log(`\n  ─── 🥇 冠军窗口拆解 ───`);
        for (const [wn, wd] of Object.entries(best.byW))
            console.log(`  ${wn}: ${wd.t}笔 | $${wd.pnl >= 0 ? "+" : ""}${wd.pnl.toFixed(2)}`);
    }

    // 各动量阈值冠军
    console.log(`\n═══════════════════════════════════════════════════════════════════`);
    console.log(`  📊 各动量阈值冠军`);
    console.log(`═══════════════════════════════════════════════════════════════════`);
    for (const mt of MOM_THRESHOLDS) {
        const best = res.filter(r => r.p.momTh === mt).sort((a, b) => b.pnl - a.pnl)[0];
        if (!best) continue;
        const p = best.p;
        const pCount = res.filter(r => r.p.momTh === mt && r.pnl > 0).length;
        const tCount = res.filter(r => r.p.momTh === mt).length;
        const md = p.mode === "short_only" ? "空" : "双";
        console.log(
            `  MOM>${mt} | ${md} VOL×${p.volMult} SL=${p.sl} BE=${p.be}→+${p.bo} TR=${p.tr} | ` +
            `${best.wr.toFixed(0)}% | $${best.pnl >= 0 ? "+" : ""}${best.pnl.toFixed(0)} | ` +
            `${best.trades}笔 | DD=$${best.dd.toFixed(0)} | 盈利:${pCount}/${tCount}`
        );
    }

    // 做空 vs 双向
    console.log(`\n  ─── 模式对比 ───`);
    for (const mode of MODES) {
        const best = res.filter(r => r.p.mode === mode).sort((a, b) => b.pnl - a.pnl)[0];
        if (!best) continue;
        const label = mode === "short_only" ? "纯做空" : "双向";
        console.log(`  ${label}: $${best.pnl >= 0 ? "+" : ""}${best.pnl.toFixed(0)} | ${best.trades}笔 | ${best.wr.toFixed(0)}%`);
    }

    console.log(`\n  📈 盈利组合: ${profitable}/${res.length} (${(profitable / res.length * 100).toFixed(1)}%)`);
    console.log(`  📊 ${kl.length} 5m K线 | $${INITIAL_CAPITAL} | ${LEVERAGE}x | $${MARGIN_PER_TRADE}/单 | ATR<${ATR_BAN}\n`);
}

main().catch(console.error);
