/**
 * 🧪 V91 增强型参数扫描回测 — 出场参数优化 v3
 * ═══════════════════════════════════════════════════════
 * 核心思路:
 *   入场: 窗口+RSI偏向+VWAP偏离+趋势 (放宽阈值, 保证样本量)
 *   出场: 参数扫描 SL/BE/Trail × 4种增强模式
 *
 * 数据: Binance ETHUSDT 5m K线 (2026年1-3月)
 * 用法: bun run src/backtest-v91.ts
 */

const LEVERAGE = 200;
const TAKER_FEE = 0.0004;
const INITIAL_CAPITAL = 200;
const MARGIN_PER_TRADE = 15;       // $15保证金 ≈ 1.5ETH, 控制单笔风险
const MAX_DAILY_TRADES = 3;
const MAX_DAILY_LOSS = 60;
const RSI_PERIOD = 14;
const MAX_HOLD_BARS = 60;
const MIN_HOLD_BARS = 2;

// ═══ 参数扫描空间 ═══
const SL_RANGE = [8, 10, 12, 15, 18, 20];
const BE_RANGE = [5, 8, 10, 12, 15];
const BE_OFF_RANGE = [1, 2, 3, 4, 5];
const TRAIL_RANGE = [5, 8, 10, 12, 15, 20];

type Mode = "base" | "atr_trail" | "split_tp" | "filtered";

interface K5 { ts: number; o: number; h: number; l: number; c: number; v: number; }
interface Params { sl: number; be: number; bo: number; tr: number; mode: Mode; }
interface Pos {
    side: "long"|"short"; entry: number; qty: number; qty2: number; margin: number;
    idx: number; beTrig: boolean; bestPt: number; partClosed: boolean; partPnl: number;
}
interface Result {
    p: Params; trades: number; wins: number; pnl: number;
    wr: number; avgW: number; avgL: number; dd: number;
}

// ═══ K线拉取 ═══
async function fetchK(s: number, e: number): Promise<K5[]> {
    const all: K5[] = []; let cur = s;
    while (cur < e) {
        const url = `https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=5m&startTime=${cur}&endTime=${e}&limit=1500`;
        const res = await fetch(url);
        if (!res.ok) { await Bun.sleep(5000); continue; }
        const data = (await res.json()) as any[][];
        if (!data.length) break;
        for (const k of data) all.push({ ts: k[0] as number, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
        cur = (data[data.length - 1][6] as number) + 1;
        process.stdout.write(`\r  📥 ${((cur - s) / (e - s) * 100).toFixed(1)}% | ${all.length}根`);
        await Bun.sleep(200);
    }
    console.log(`\n  ✅ ${all.length} 根 5m K线`);
    return all;
}

// ═══ 指标引擎 ═══
class Ind {
    private c: number[] = []; private hs: number[] = []; private ls: number[] = [];
    private dayHL: Map<string, [number, number, number, number]> = new Map(); // [hi,lo,pv,vol]
    private prevDayRange = 0;

    push(k: K5) {
        this.c.push(k.c); this.hs.push(k.h); this.ls.push(k.l);
        if (this.c.length > 800) {
            this.c = this.c.slice(-600); this.hs = this.hs.slice(-600); this.ls = this.ls.slice(-600);
        }
        const d = new Date(k.ts + 8*3600000).toISOString().slice(0,10);
        if (!this.dayHL.has(d)) {
            const pd = this.dayHL.get(this.prevDay(d));
            if (pd && pd[1] > 0) this.prevDayRange = (pd[0] - pd[1]) / pd[1] * 100;
            this.dayHL.set(d, [k.h, k.l, 0, 0]);
            for (const [dd] of this.dayHL) { if (dd < this.nDaysAgo(d, 3)) this.dayHL.delete(dd); }
        }
        const dd = this.dayHL.get(d)!;
        dd[0] = Math.max(dd[0], k.h); dd[1] = Math.min(dd[1], k.l);
        const tp = (k.h+k.l+k.c)/3; dd[2] += tp*k.v; dd[3] += k.v;
    }

    private prevDay(d: string) { const dt = new Date(d+"T00:00:00Z"); dt.setDate(dt.getDate()-1); return dt.toISOString().slice(0,10); }
    private nDaysAgo(d: string, n: number) { const dt = new Date(d+"T00:00:00Z"); dt.setDate(dt.getDate()-n); return dt.toISOString().slice(0,10); }

    get ready() { return this.c.length >= RSI_PERIOD + 10; }

    rsi(): number {
        const n = this.c.length; if (n < RSI_PERIOD+1) return 50;
        let g=0,lo=0;
        for (let i=n-RSI_PERIOD;i<n;i++){ const ch=this.c[i]-this.c[i-1]; if(ch>0) g+=ch; else lo-=ch; }
        g/=RSI_PERIOD; lo/=RSI_PERIOD;
        return lo===0?100:100-100/(1+g/lo);
    }

    atr(): number {
        const n=this.hs.length; if(n<RSI_PERIOD) return 1;
        let s=0; for(let i=n-RSI_PERIOD;i<n;i++) s+=this.hs[i]-this.ls[i];
        return s/RSI_PERIOD;
    }

    /** 7/21 EMA 方向 */
    trend(): number {
        const n = this.c.length; if(n<21) return 0;
        const s7 = this.c.slice(-7).reduce((a,b)=>a+b)/7;
        const s21 = this.c.slice(-21).reduce((a,b)=>a+b)/21;
        return s7>s21 ? 1 : s7<s21 ? -1 : 0;
    }

    /** 前3根K线波动/ATR */
    vol3(): number {
        const n=this.hs.length; if(n<3) return 1;
        const a=this.atr(); if(a<=0) return 1;
        let s=0; for(let i=n-3;i<n;i++) s+=this.hs[i]-this.ls[i];
        return (s/3)/a;
    }

    vwapDev(price: number, dateStr: string): number {
        const dd = this.dayHL.get(dateStr);
        if(!dd || dd[3]<=0) return 0;
        const vwap = dd[2]/dd[3]; return (price-vwap)/vwap*100;
    }

    usedRange(price: number, dateStr: string): number {
        if(this.prevDayRange<=0) return 0;
        const dd = this.dayHL.get(dateStr); if(!dd) return 0;
        const hi = Math.max(dd[0], price), lo = Math.min(dd[1], price);
        if(lo<=0) return 0; return ((hi-lo)/lo*100)/this.prevDayRange;
    }
}

// ═══ 入场: 窗口 + 放宽RSI + VWAP + 趋势 ═══
// 放宽阈值: RSI<45→看多倾向, RSI>55→看空倾向
// VWAP偏离>0.2% 确认方向
// EMA趋势一致 → 开单

function tryEntry(
    k: K5, ind: Ind, wTraded: Set<string>, filtered: boolean,
): { side:"long"|"short"; score: number; w: string } | null {
    const utc8 = new Date(k.ts + 8*3600000);
    const hm = utc8.getUTCHours()*60 + utc8.getUTCMinutes();
    const d = utc8.toISOString().slice(0,10);

    // 窗口检测 (仅窗口前半段开单, 避免末尾追高)
    let wn = "";
    if (hm>=480 && hm<510) wn="08";       // 08:00-08:30
    else if (hm>=900 && hm<930) wn="15";  // 15:00-15:30
    else if (hm>=1320 && hm<1350) wn="22"; // 22:00-22:30
    else return null;

    const key = `${d}_${wn}`;
    if (wTraded.has(key)) return null;
    if (!ind.ready) return null;

    const rsi = ind.rsi();
    const vwap = ind.vwapDev(k.c, d);
    const tr = ind.trend();
    const ur = ind.usedRange(k.c, d);

    // 方向判断: 需要至少2个信号一致
    let longScore = 0, shortScore = 0;

    // RSI 偏向 (放宽)
    if (rsi < 45) longScore++;    // RSI偏低→看多
    if (rsi > 55) shortScore++;   // RSI偏高→看空
    if (rsi < 35) longScore++;    // 强超卖
    if (rsi > 65) shortScore++;   // 强超买

    // VWAP 偏离
    if (vwap < -0.2) longScore++;  // 低于VWAP→看多(均值回归)
    if (vwap > 0.2) shortScore++;  // 高于VWAP→看空

    // 趋势
    if (tr > 0) longScore++;
    if (tr < 0) shortScore++;

    // 日振幅
    if (wn === "08" && ur < 0.3) longScore++;               // 早盘振幅低→做多空间
    if (wn === "15" && ur > 0.5) shortScore++;              // 午盘振幅高→做空
    if (wn === "22" && ur > 0.6) { longScore++; shortScore++; } // 晚盘波动大→双向

    let side: "long"|"short"|"" = "";
    let score = 0;

    if (longScore >= 2 && longScore > shortScore) { side = "long"; score = longScore; }
    else if (shortScore >= 2 && shortScore > longScore) { side = "short"; score = shortScore; }
    else return null;

    // filtered 模式: score>=3 才入场
    if (filtered && score < 3) return null;

    wTraded.add(key);
    return { side, score, w: wn };
}

// ═══ 出场检查 ═══
function checkExit(pos: Pos, price: number, bars: number, p: Params, atr: number) {
    const pt = pos.side==="long" ? price-pos.entry : pos.entry-price;
    if (pt > pos.bestPt) pos.bestPt = pt;

    if (pt <= -p.sl) {
        const ep = pos.side==="long" ? pos.entry-p.sl : pos.entry+p.sl;
        return { close:true, reason:"SL", ep };
    }
    if (bars < MIN_HOLD_BARS) return null;
    if (!pos.beTrig && pt >= p.be) pos.beTrig = true;

    // 分批止盈: 浮盈>=15pt平一半
    if (p.mode==="split_tp" && !pos.partClosed && pt>=15) {
        const hq=pos.qty/2;
        const gr=pt*hq, fee=(pos.entry*hq+price*hq)*TAKER_FEE;
        pos.partPnl = gr-fee; pos.partClosed=true; pos.qty2=pos.qty-hq;
    }

    // 跟踪止盈
    if (pos.beTrig && pos.bestPt > p.be) {
        let td = p.tr;
        if (p.mode==="atr_trail") td = Math.max(p.tr, atr*1.5);
        const tSl = pos.side==="long" ? pos.entry+pos.bestPt-td : pos.entry-pos.bestPt+td;
        const beF = pos.side==="long" ? pos.entry+p.bo : pos.entry-p.bo;
        const eff = pos.side==="long" ? Math.max(tSl,beF) : Math.min(tSl,beF);
        if ((pos.side==="long" && price<=eff)||(pos.side==="short" && price>=eff))
            return { close:true, reason:`TR +${pos.bestPt.toFixed(1)}→${pt.toFixed(1)}`, ep:price };
    }

    if (bars >= MAX_HOLD_BARS) return { close:true, reason:"TIME", ep:price };
    return null;
}

// ═══ 单次回测 ═══
function run(kl: K5[], p: Params): Result {
    const ind = new Ind();
    let bal = INITIAL_CAPITAL, pos: Pos|null = null;
    let trades=0, wins=0, netPnl=0;
    const wp: number[]=[], lp: number[]=[];
    let maxB = INITIAL_CAPITAL, maxDD=0;
    let curD="", dT=0, dP=0;
    const wT = new Set<string>();

    for (let i=0; i<kl.length; i++) {
        const k=kl[i]; ind.push(k);
        const d = new Date(k.ts+8*3600000).toISOString().slice(0,10);
        if(d!==curD){ curD=d; dT=0; dP=0; }
        if(i<100) continue;

        if (pos) {
            const bars=i-pos.idx;
            const worst = pos.side==="long" ? k.l : k.h;
            const atr=ind.atr();
            const ex = checkExit(pos, worst, bars, p, atr)
                    || checkExit(pos, k.c, bars, p, atr);
            if (ex?.close) {
                const aq = (p.mode==="split_tp" && pos.partClosed) ? pos.qty2 : pos.qty;
                const pt = pos.side==="long" ? ex.ep-pos.entry : pos.entry-ex.ep;
                const gr=pt*aq, fee=(pos.entry*aq+ex.ep*aq)*TAKER_FEE;
                const net=gr-fee+pos.partPnl;
                bal+=net; trades++; dT++; dP+=net; netPnl+=net;
                if(net>0){ wins++; wp.push(net); } else lp.push(net);
                if(bal>maxB) maxB=bal; const dd=maxB-bal; if(dd>maxDD) maxDD=dd;
                pos=null;
            }
            continue;
        }

        if(dT>=MAX_DAILY_TRADES || dP<=-MAX_DAILY_LOSS || bal<MARGIN_PER_TRADE) continue;
        const sig = tryEntry(k, ind, wT, p.mode==="filtered");
        if(!sig) continue;

        const margin = Math.min(MARGIN_PER_TRADE, bal);
        const qty = (margin*LEVERAGE)/k.c;
        pos = { side:sig.side, entry:k.c, qty, qty2:qty, margin, idx:i,
                beTrig:false, bestPt:0, partClosed:false, partPnl:0 };
    }

    // 月末
    if(pos && kl.length>0) {
        const lk=kl[kl.length-1];
        const aq = (p.mode==="split_tp"&&pos.partClosed)?pos.qty2:pos.qty;
        const pt=pos.side==="long"?lk.c-pos.entry:pos.entry-lk.c;
        const gr=pt*aq, fee=(pos.entry*aq+lk.c*aq)*TAKER_FEE;
        const net=gr-fee+pos.partPnl; bal+=net; trades++; netPnl+=net;
        if(net>0){ wins++; wp.push(net); } else lp.push(net);
    }

    return { p, trades, wins, pnl:netPnl,
        wr: trades>0 ? wins/trades*100 : 0,
        avgW: wp.length>0 ? wp.reduce((a,b)=>a+b,0)/wp.length : 0,
        avgL: lp.length>0 ? lp.reduce((a,b)=>a+b,0)/lp.length : 0,
        dd: maxDD };
}

// ═══ 主程序 ═══
async function main() {
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log("  🧪 V91 参数扫描回测 v3 | ETHUSDT 5m | 2026年1月-3月18日");
    console.log("  📊 入场: RSI偏向+VWAP+趋势 (放宽) | 出场: SL/BE/Trail × 4模式");
    console.log("  💰 $200 本金 | 200x | $15/单 | 每日3单");
    console.log("═══════════════════════════════════════════════════════════════════\n");

    const sMs = new Date("2026-01-01T00:00:00Z").getTime();
    const eMs = new Date("2026-03-18T00:00:00Z").getTime();
    const kl = await fetchK(sMs, eMs);
    if(!kl.length) { console.log("❌ 无数据!"); return; }

    // 生成参数组合
    const modes: Mode[] = ["base", "atr_trail", "split_tp", "filtered"];
    const combos: Params[] = [];
    for (const mode of modes) {
        for (const sl of SL_RANGE) {
            for (const be of BE_RANGE) {
                if(be>=sl) continue;
                for (const bo of BE_OFF_RANGE) {
                    if(bo>=be) continue;
                    for (const tr of TRAIL_RANGE) {
                        combos.push({ sl, be, bo, tr, mode });
                    }
                }
            }
        }
    }

    console.log(`\n🔬 组合: ${combos.length} | 扫描中...\n`);
    const res: Result[] = [];
    const t0 = performance.now();

    for (let i=0; i<combos.length; i++) {
        res.push(run(kl, combos[i]));
        if ((i+1)%200===0 || i===combos.length-1)
            process.stdout.write(`\r  ⚡ ${((i+1)/combos.length*100).toFixed(0)}% (${i+1}/${combos.length}) | ${((performance.now()-t0)/1000).toFixed(1)}s`);
    }
    console.log(`\n\n✅ ${((performance.now()-t0)/1000).toFixed(1)}s\n`);

    res.sort((a,b) => b.pnl - a.pnl);
    const ml: Record<string,string> = { base:"基础", atr_trail:"ATR跟踪", split_tp:"分批止盈", filtered:"入场过滤" };
    const profitable = res.filter(r=>r.pnl>0).length;

    console.log("═══════════════════════════════════════════════════════════════════");
    console.log("  🏆 TOP 30 最赚钱参数组合");
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log("  # | 模式     | SL  BE→+N Trail | 胜率 | 净利     | 笔数 | 均盈   均亏   | 回撤$");
    console.log("  "+"─".repeat(82));

    for (let i=0; i<Math.min(30,res.length); i++) {
        const r=res[i], p=r.p;
        console.log(
            `  ${String(i+1).padStart(2)} | ${ml[p.mode].padEnd(6)} | `+
            `${String(p.sl).padStart(2)} ${String(p.be).padStart(2)}→+${p.bo} ${String(p.tr).padStart(2)}  | `+
            `${r.wr.toFixed(0).padStart(3)}% | `+
            `${(r.pnl>=0?"+":"")+r.pnl.toFixed(2)}`.padStart(9)+` | `+
            `${String(r.trades).padStart(3)}  | `+
            `${r.avgW.toFixed(1).padStart(6)} ${r.avgL.toFixed(1).padStart(6)} | `+
            `$${r.dd.toFixed(0)}`
        );
    }

    // CEO 平衡型基准
    const base = res.find(r=>r.p.sl===12&&r.p.be===10&&r.p.bo===3&&r.p.tr===10&&r.p.mode==="base");
    if(base) {
        const rank=res.indexOf(base)+1;
        console.log(`\n  ─── CEO 平衡型 (SL=12 BE=10→+3 Trail=10) ───`);
        console.log(`  #${rank}/${res.length} | 胜率${base.wr.toFixed(0)}% | $${base.pnl>=0?"+":""}${base.pnl.toFixed(2)} | ${base.trades}笔 | 回撤$${base.dd.toFixed(0)}`);
    }

    // 旧策略
    const old = res.find(r=>r.p.sl===8&&r.p.be===5&&r.p.bo===1&&r.p.tr===5&&r.p.mode==="base");
    if(old) {
        console.log(`  ─── 旧策略 (SL=8 BE=5→+1 Trail=5) ───`);
        console.log(`  胜率${old.wr.toFixed(0)}% | $${old.pnl>=0?"+":""}${old.pnl.toFixed(2)} | ${old.trades}笔 | 回撤$${old.dd.toFixed(0)}`);
    }

    // 各模式冠军
    console.log(`\n═══════════════════════════════════════════════════════════════════`);
    console.log(`  📊 各模式冠军`);
    console.log(`═══════════════════════════════════════════════════════════════════`);
    for (const m of modes) {
        const best = res.filter(r=>r.p.mode===m).sort((a,b)=>b.pnl-a.pnl)[0];
        if(!best) continue;
        const p=best.p;
        console.log(`  ${ml[m].padEnd(8)} | SL=${p.sl} BE=${p.be}→+${p.bo} TR=${p.tr} | 胜率${best.wr.toFixed(0)}% | $${best.pnl>=0?"+":""}${best.pnl.toFixed(0)} | ${best.trades}笔 | DD=$${best.dd.toFixed(0)}`);
    }

    // WORST 5
    console.log(`\n  ─── 最差5个 ───`);
    for (let i=res.length-5; i<res.length; i++) {
        const r=res[i], p=r.p;
        console.log(`  ${ml[p.mode].padEnd(6)} SL=${p.sl} BE=${p.be}→+${p.bo} TR=${p.tr} | ${r.wr.toFixed(0)}% | $${r.pnl.toFixed(0)} | ${r.trades}笔 | DD=$${r.dd.toFixed(0)}`);
    }

    console.log(`\n  📈 盈利组合: ${profitable}/${res.length} (${(profitable/res.length*100).toFixed(1)}%)`);
    console.log(`  📊 ${kl.length} K线 | $${INITIAL_CAPITAL} | ${LEVERAGE}x | $${MARGIN_PER_TRADE}/单\n`);
}

main().catch(console.error);
