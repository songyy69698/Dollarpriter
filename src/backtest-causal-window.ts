/**
 * 🧪 因果套利 + CEO窗口限定 回测
 * ═══════════════════════════════════════════════
 * 数据: Binance ETHUSDT 1m K线 (2026年1-3月)
 * 入场: 三窗口内 + taker_buy_volume 模拟买压>卖墙
 * 保护: ATR>55禁入 + EMA200趋势过滤
 * 出场: 扫描 SL/BE/Trail 参数组合
 *
 * 用法: bun run src/backtest-causal-window.ts
 */

// ═══ 固定参数 ═══
const LEVERAGE = 200;
const TAKER_FEE = 0.0004;
const INITIAL_CAPITAL = 200;
const MARGIN_PER_TRADE = 15;
const MAX_DAILY_TRADES = 3;
const MAX_DAILY_LOSS = 60;
const MAX_HOLD_BARS = 300;   // 1m × 300 = 5小时
const MIN_HOLD_BARS = 15;    // 最少15分钟

// V50 保护
const ATR_BAN_THRESHOLD = 55;    // ATR>55 不入场
const EMA200_PERIOD = 200;

// 因果套利阈值
const IMBALANCE_RATIOS = [1.5, 2.0, 2.5, 3.0]; // 扫描不同阈值

// ═══ 出场参数扫描空间 ═══
const SL_RANGE = [8, 10, 12, 15, 20];
const BE_RANGE = [5, 8, 10, 12];
const BE_OFF_RANGE = [1, 2, 3, 4];
const TRAIL_RANGE = [5, 8, 10, 12, 15];

// ═══ 窗口配置 (UTC+8) ═══
const WINDOWS = [
    { name: "08窗口", startH: 8, startM: 0, endH: 9, endM: 0 },
    { name: "15窗口", startH: 15, startM: 0, endH: 16, endM: 0 },
    { name: "22窗口", startH: 22, startM: 0, endH: 23, endM: 0 },
];

interface K1m {
    ts: number; o: number; h: number; l: number; c: number;
    v: number; tbv: number; // taker_buy_volume
}

interface Params {
    sl: number; be: number; bo: number; tr: number; imbRatio: number;
}

interface Pos {
    side: "long"|"short"; entry: number; qty: number;
    idx: number; beTrig: boolean; bestPt: number;
}

interface Result {
    p: Params; trades: number; wins: number; pnl: number;
    wr: number; avgW: number; avgL: number; dd: number;
    byWindow: Record<string, { trades: number; pnl: number }>;
}

// ═══ K线拉取 (1m, 含 taker_buy_volume) ═══
async function fetchK1m(s: number, e: number): Promise<K1m[]> {
    const all: K1m[] = []; let cur = s;
    while (cur < e) {
        const url = `https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=1m&startTime=${cur}&endTime=${e}&limit=1500`;
        const res = await fetch(url);
        if (!res.ok) { await Bun.sleep(3000); continue; }
        const data = (await res.json()) as any[][];
        if (!data.length) break;
        for (const k of data) {
            all.push({
                ts: k[0] as number, o: +k[1], h: +k[2], l: +k[3], c: +k[4],
                v: +k[5], tbv: +k[9], // index 9 = taker_buy_base_asset_volume
            });
        }
        cur = (data[data.length - 1][6] as number) + 1;
        const pct = ((cur - s) / (e - s) * 100).toFixed(1);
        process.stdout.write(`\r  📥 1m ${pct}% | ${all.length}根`);
        await Bun.sleep(100);
    }
    console.log(`\n  ✅ ${all.length} 根 1m K线`);
    return all;
}

// ═══ 指标计算 ═══
class Indicators {
    private c: number[] = [];
    private hs: number[] = [];
    private ls: number[] = [];
    private ema200 = 0;
    private ema200Ready = false;

    push(k: K1m) {
        this.c.push(k.c); this.hs.push(k.h); this.ls.push(k.l);
        // EMA200
        if (!this.ema200Ready) {
            if (this.c.length >= EMA200_PERIOD) {
                this.ema200 = this.c.slice(-EMA200_PERIOD).reduce((a, b) => a + b) / EMA200_PERIOD;
                this.ema200Ready = true;
            }
        } else {
            const m = 2 / (EMA200_PERIOD + 1);
            this.ema200 = k.c * m + this.ema200 * (1 - m);
        }
        // trim
        if (this.c.length > 1500) {
            this.c = this.c.slice(-1000); this.hs = this.hs.slice(-1000); this.ls = this.ls.slice(-1000);
        }
    }

    get ready() { return this.ema200Ready && this.c.length > EMA200_PERIOD; }
    get ema() { return this.ema200; }

    atr14(): number {
        const n = this.hs.length; if (n < 14) return 0;
        let s = 0;
        for (let i = n - 14; i < n; i++) s += this.hs[i] - this.ls[i];
        return s / 14;
    }
}

// ═══ 因果信号检测 (1m K线模拟) ═══
// buyPressure = taker_buy_volume (主动买)
// sellPressure = volume - taker_buy_volume (主动卖)
// askWall ≈ sellPressure 的移动平均 (挂单墙近似)
// bidWall ≈ buyPressure 的移动平均

class CausalDetector {
    private buyRing: number[] = [];
    private sellRing: number[] = [];
    private readonly RING_SIZE = 10; // 10分钟滚动窗口

    push(k: K1m) {
        const buy = k.tbv;
        const sell = k.v - k.tbv;
        this.buyRing.push(buy);
        this.sellRing.push(sell);
        if (this.buyRing.length > this.RING_SIZE) this.buyRing.shift();
        if (this.sellRing.length > this.RING_SIZE) this.sellRing.shift();
    }

    get ready() { return this.buyRing.length >= this.RING_SIZE; }

    /** 当前K线买压 vs 卖方均量墙 */
    getBuyImbalance(): number {
        if (!this.ready) return 0;
        const curBuy = this.buyRing[this.buyRing.length - 1];
        // 卖方墙 = 过去10根卖量均值
        const avgSell = this.sellRing.slice(0, -1).reduce((a, b) => a + b, 0) / (this.RING_SIZE - 1);
        return avgSell > 0 ? curBuy / avgSell : 0;
    }

    /** 当前K线卖压 vs 买方均量墙 */
    getSellImbalance(): number {
        if (!this.ready) return 0;
        const curSell = this.sellRing[this.sellRing.length - 1];
        const avgBuy = this.buyRing.slice(0, -1).reduce((a, b) => a + b, 0) / (this.RING_SIZE - 1);
        return avgBuy > 0 ? curSell / avgBuy : 0;
    }
}

// ═══ 窗口检查 ═══
function getActiveWindow(ts: number): typeof WINDOWS[0] | null {
    const utc8 = new Date(ts + 8 * 3600000);
    const h = utc8.getUTCHours(), m = utc8.getUTCMinutes();
    const hm = h * 60 + m;
    for (const w of WINDOWS) {
        const ws = w.startH * 60 + w.startM;
        const we = w.endH * 60 + w.endM;
        if (hm >= ws && hm < we) return w;
    }
    return null;
}

// ═══ 出场检查 ═══
function checkExit(pos: Pos, price: number, bars: number, p: Params) {
    const pt = pos.side === "long" ? price - pos.entry : pos.entry - price;
    if (pt > pos.bestPt) pos.bestPt = pt;

    // 硬止损
    if (pt <= -p.sl) {
        const ep = pos.side === "long" ? pos.entry - p.sl : pos.entry + p.sl;
        return { close: true, ep, reason: "SL" };
    }
    if (bars < MIN_HOLD_BARS) return null;
    // 保本
    if (!pos.beTrig && pt >= p.be) pos.beTrig = true;
    // 跟踪
    if (pos.beTrig && pos.bestPt > p.be) {
        const tSl = pos.side === "long"
            ? pos.entry + pos.bestPt - p.tr
            : pos.entry - pos.bestPt + p.tr;
        const beF = pos.side === "long"
            ? pos.entry + p.bo
            : pos.entry - p.bo;
        const eff = pos.side === "long" ? Math.max(tSl, beF) : Math.min(tSl, beF);
        if ((pos.side === "long" && price <= eff) || (pos.side === "short" && price >= eff))
            return { close: true, ep: price, reason: `TR +${pos.bestPt.toFixed(1)}→${pt.toFixed(1)}` };
    }
    // 超时
    if (bars >= MAX_HOLD_BARS) return { close: true, ep: price, reason: "TIME" };
    return null;
}

// ═══ 单次回测 ═══
function run(kl: K1m[], p: Params): Result {
    const ind = new Indicators();
    const causal = new CausalDetector();
    let bal = INITIAL_CAPITAL, pos: Pos | null = null;
    let trades = 0, wins = 0, netPnl = 0;
    const wp: number[] = [], lp: number[] = [];
    let maxB = INITIAL_CAPITAL, maxDD = 0;
    let curD = "", dT = 0, dP = 0;
    const wTraded = new Set<string>();
    const byWindow: Record<string, { trades: number; pnl: number }> = {};
    for (const w of WINDOWS) byWindow[w.name] = { trades: 0, pnl: 0 };

    let lastEntryWindow = "";

    for (let i = 0; i < kl.length; i++) {
        const k = kl[i];
        ind.push(k);
        causal.push(k);
        const d = new Date(k.ts + 8 * 3600000).toISOString().slice(0, 10);
        if (d !== curD) { curD = d; dT = 0; dP = 0; wTraded.clear(); }

        if (!ind.ready || !causal.ready) continue;

        // 持仓
        if (pos) {
            const bars = i - pos.idx;
            const worst = pos.side === "long" ? k.l : k.h;
            const ex = checkExit(pos, worst, bars, p) || checkExit(pos, k.c, bars, p);
            if (ex?.close) {
                const pt = pos.side === "long" ? ex.ep - pos.entry : pos.entry - ex.ep;
                const gr = pt * pos.qty;
                const fee = (pos.entry * pos.qty + ex.ep * pos.qty) * TAKER_FEE;
                const net = gr - fee;
                bal += net; trades++; dT++; dP += net; netPnl += net;
                if (net > 0) { wins++; wp.push(net); } else lp.push(net);
                if (bal > maxB) maxB = bal;
                const dd = maxB - bal; if (dd > maxDD) maxDD = dd;
                if (lastEntryWindow && byWindow[lastEntryWindow]) {
                    byWindow[lastEntryWindow].trades++;
                    byWindow[lastEntryWindow].pnl += net;
                }
                pos = null;
            }
            continue;
        }

        // 开仓检查
        if (dT >= MAX_DAILY_TRADES || dP <= -MAX_DAILY_LOSS || bal < MARGIN_PER_TRADE) continue;

        // 窗口检查
        const w = getActiveWindow(k.ts);
        if (!w) continue;
        const wKey = `${d}_${w.name}`;
        if (wTraded.has(wKey)) continue;

        // V50 保护: ATR > 55 禁入
        const atr = ind.atr14();
        if (atr > ATR_BAN_THRESHOLD) continue;

        // 因果信号
        const buyImb = causal.getBuyImbalance();
        const sellImb = causal.getSellImbalance();

        let side: "long" | "short" | "" = "";

        if (buyImb > p.imbRatio) {
            // V50 EMA200 趋势: 做多需价格在 EMA200 上方
            if (k.c > ind.ema) side = "long";
        }
        if (!side && sellImb > p.imbRatio) {
            // 做空需价格在 EMA200 下方
            if (k.c < ind.ema) side = "short";
        }

        if (!side) continue;

        wTraded.add(wKey);
        lastEntryWindow = w.name;
        const margin = Math.min(MARGIN_PER_TRADE, bal);
        const qty = (margin * LEVERAGE) / k.c;
        pos = { side, entry: k.c, qty, idx: i, beTrig: false, bestPt: 0 };
    }

    // 末尾强平
    if (pos && kl.length > 0) {
        const lk = kl[kl.length - 1];
        const pt = pos.side === "long" ? lk.c - pos.entry : pos.entry - lk.c;
        const gr = pt * pos.qty, fee = (pos.entry * pos.qty + lk.c * pos.qty) * TAKER_FEE;
        const net = gr - fee; bal += net; trades++; netPnl += net;
        if (net > 0) { wins++; wp.push(net); } else lp.push(net);
    }

    return {
        p, trades, wins, pnl: netPnl,
        wr: trades > 0 ? wins / trades * 100 : 0,
        avgW: wp.length > 0 ? wp.reduce((a, b) => a + b, 0) / wp.length : 0,
        avgL: lp.length > 0 ? lp.reduce((a, b) => a + b, 0) / lp.length : 0,
        dd: maxDD, byWindow,
    };
}

// ═══ 主程序 ═══
async function main() {
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log("  🧪 因果套利 + CEO窗口限定 回测 | ETHUSDT 1m | 2026年1-3月");
    console.log("  📊 入场: 窗口+买压>卖墙+EMA200+ATR<55");
    console.log("  💰 $200 | 200x | $15/单 | 3单/日");
    console.log("═══════════════════════════════════════════════════════════════════\n");

    const sMs = new Date("2026-01-01T00:00:00Z").getTime();
    const eMs = new Date("2026-03-18T00:00:00Z").getTime();
    const kl = await fetchK1m(sMs, eMs);
    if (!kl.length) { console.log("❌ 无数据!"); return; }

    // 生成参数组合
    const combos: Params[] = [];
    for (const imbRatio of IMBALANCE_RATIOS) {
        for (const sl of SL_RANGE) {
            for (const be of BE_RANGE) {
                if (be >= sl) continue;
                for (const bo of BE_OFF_RANGE) {
                    if (bo >= be) continue;
                    for (const tr of TRAIL_RANGE) {
                        combos.push({ sl, be, bo, tr, imbRatio });
                    }
                }
            }
        }
    }

    console.log(`\n🔬 组合: ${combos.length} (含${IMBALANCE_RATIOS.length}种失衡阈值) | 开始...\n`);
    const res: Result[] = [];
    const t0 = performance.now();

    for (let i = 0; i < combos.length; i++) {
        res.push(run(kl, combos[i]));
        if ((i + 1) % 100 === 0 || i === combos.length - 1)
            process.stdout.write(`\r  ⚡ ${((i + 1) / combos.length * 100).toFixed(0)}% (${i + 1}/${combos.length}) | ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    }
    const totalS = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`\n\n✅ ${totalS}s\n`);

    res.sort((a, b) => b.pnl - a.pnl);
    const profitable = res.filter(r => r.pnl > 0).length;

    // ═══ 输出 ═══
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log("  🏆 TOP 30 最赚钱参数组合");
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log("  #  | IMB  SL  BE→+N Trail | 胜率 | 净利      | 笔数 | 均盈   均亏   | DD$");
    console.log("  " + "─".repeat(80));

    for (let i = 0; i < Math.min(30, res.length); i++) {
        const r = res[i], p = r.p;
        console.log(
            `  ${String(i + 1).padStart(2)} | ` +
            `${p.imbRatio.toFixed(1)} ${String(p.sl).padStart(2)} ${String(p.be).padStart(2)}→+${p.bo} ${String(p.tr).padStart(2)}  | ` +
            `${r.wr.toFixed(0).padStart(3)}% | ` +
            `${(r.pnl >= 0 ? "+" : "") + r.pnl.toFixed(2)}`.padStart(10) + ` | ` +
            `${String(r.trades).padStart(3)}  | ` +
            `${r.avgW.toFixed(1).padStart(6)} ${r.avgL.toFixed(1).padStart(6)} | ` +
            `$${r.dd.toFixed(0)}`
        );
    }

    // 各窗口详细拆解 (Top 1)
    if (res.length > 0) {
        const best = res[0];
        console.log(`\n  ─── 🥇 冠军各窗口拆解 ───`);
        for (const [wn, wd] of Object.entries(best.byWindow)) {
            console.log(`  ${wn}: ${wd.trades}笔 | $${wd.pnl >= 0 ? "+" : ""}${wd.pnl.toFixed(2)}`);
        }
    }

    // 各失衡阈值最佳
    console.log(`\n═══════════════════════════════════════════════════════════════════`);
    console.log(`  📊 各失衡阈值冠军`);
    console.log(`═══════════════════════════════════════════════════════════════════`);
    for (const ir of IMBALANCE_RATIOS) {
        const best = res.filter(r => r.p.imbRatio === ir).sort((a, b) => b.pnl - a.pnl)[0];
        if (!best) continue;
        const p = best.p;
        const profitable_count = res.filter(r => r.p.imbRatio === ir && r.pnl > 0).length;
        const total_count = res.filter(r => r.p.imbRatio === ir).length;
        console.log(
            `  IMB=${ir.toFixed(1)}x | SL=${p.sl} BE=${p.be}→+${p.bo} TR=${p.tr} | ` +
            `胜率${best.wr.toFixed(0)}% | $${best.pnl >= 0 ? "+" : ""}${best.pnl.toFixed(0)} | ` +
            `${best.trades}笔 | DD=$${best.dd.toFixed(0)} | ` +
            `盈利组合:${profitable_count}/${total_count}`
        );
    }

    // CEO 平衡型对照
    const ceoBase = res.find(r =>
        r.p.sl === 12 && r.p.be === 10 && r.p.bo === 3 && r.p.tr === 10 && r.p.imbRatio === 2.5
    );
    if (ceoBase) {
        const rank = res.indexOf(ceoBase) + 1;
        console.log(`\n  ─── CEO 平衡型 (IMB=2.5 SL=12 BE=10→+3 TR=10) ───`);
        console.log(`  #${rank}/${res.length} | 胜率${ceoBase.wr.toFixed(0)}% | $${ceoBase.pnl >= 0 ? "+" : ""}${ceoBase.pnl.toFixed(2)} | ${ceoBase.trades}笔 | DD=$${ceoBase.dd.toFixed(0)}`);
    }

    // 最差5
    console.log(`\n  ─── 最差5个 ───`);
    for (let i = res.length - 5; i < res.length; i++) {
        if (i < 0) continue;
        const r = res[i], p = r.p;
        console.log(`  IMB=${p.imbRatio} SL=${p.sl} BE=${p.be}→+${p.bo} TR=${p.tr} | ${r.wr.toFixed(0)}% | $${r.pnl.toFixed(0)} | ${r.trades}笔`);
    }

    // 旧版24h对照 (无窗口限制, 用 IMB=2.5 SL=8 无保本无跟踪 模拟旧版)
    console.log(`\n  📈 盈利组合: ${profitable}/${res.length} (${(profitable / res.length * 100).toFixed(1)}%)`);
    console.log(`  📊 ${kl.length} 1m K线 | $${INITIAL_CAPITAL} | ${LEVERAGE}x | $${MARGIN_PER_TRADE}/单 | ${totalS}s\n`);
}

main().catch(console.error);
