/**
 * 🧪 RSI vs EMA 趋势确认对比 — 找最佳组合
 * ═══════════════════════════════════════════════════
 * 基础: MTF≥6 + 4窗口 + 反转确认 + 回调PB±5
 * 对比趋势过滤: RSI / EMA7 / EMA20 / EMA50 / 无
 */

const LEVERAGE = 150;
const TAKER_FEE = 0.0004;
const INITIAL_CAPITAL = 500;
const FIXED_QTY = 1.0;
const SL_PT = 20;
const BREAKEVEN_PT = 12;
const BREAKEVEN_OFFSET = 3;
const TRAILING_PT = 10;
const MAX_DAILY_TRADES = 4;
const MAX_DAILY_LOSS = 150;
const MAX_HOLD_BARS = 120;
const MTF_MIN = 6;
const PB_ZONE = 5;

interface K5 { ts: number; o: number; h: number; l: number; c: number; v: number; }

async function fetchK(interval: string, sMs: number, eMs: number): Promise<K5[]> {
    const all: K5[] = []; let cur = sMs;
    while (cur < eMs) {
        const url = `https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=${interval}&startTime=${cur}&endTime=${eMs}&limit=1500`;
        const res = await fetch(url); if (!res.ok) { await Bun.sleep(5000); continue; }
        const data = (await res.json()) as any[][]; if (!data.length) break;
        for (const k of data) all.push({ ts: k[0] as number, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
        cur = (data[data.length - 1][6] as number) + 1; await Bun.sleep(150);
    }
    return all;
}

function calcPOC(kl: K5[]): number { if (!kl.length) return 0; let m=0,p=0; for(const k of kl){if(k.v>m){m=k.v;p=(k.h+k.l+k.c)/3;}} return p; }
function calcRSI(c: number[], p=14): number { if(c.length<p+1) return 50; let g=0,l=0; for(let i=c.length-p;i<c.length;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l+=-d;} const ag=g/p,al=l/p; return al===0?100:100-100/(1+ag/al); }
function calcATR(kl: K5[], p=14): number { if(kl.length<p) return 0; let s=0; for(let i=kl.length-p;i<kl.length;i++) s+=kl[i].h-kl[i].l; return s/p; }

// EMA 计算
function calcEMA(closes: number[], period: number): number {
    if (closes.length < period) return closes[closes.length - 1] || 0;
    let ema = closes.slice(0, period).reduce((a, b) => a + b) / period;
    const m = 2 / (period + 1);
    for (let i = period; i < closes.length; i++) ema = closes[i] * m + ema * (1 - m);
    return ema;
}

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

function getMtf(ts: number, tfData: Map<string, K5[]>): { score: number; dir: string; poc: number } {
    let sc=0,pS=0,pW=0;
    const pw: Record<string,number> = {"2h":1,"1h":3,"30m":3,"15m":2};
    for(const tf of TF_SIMS){
        const kl=tfData.get(tf.interval); if(!kl||kl.length<4) continue;
        const b=kl.filter(k=>k.ts<=ts); if(b.length<tf.halfSplit*2) continue;
        const r=b.slice(-tf.halfSplit),p=b.slice(-tf.halfSplit*2,-tf.halfSplit);
        const s=calcPOC(r)-calcPOC(p);
        if(s>tf.threshold)sc++;else if(s<-tf.threshold)sc--;
        const w=pw[tf.interval]||0; const poc1=calcPOC(r);
        if(w>0&&poc1>0){pS+=poc1*w;pW+=w;}
    }
    return {score:sc, dir:sc>0?"long":sc<0?"short":"", poc:pW>0?pS/pW:0};
}

function detectReversal(kl: K5[], dir: string): boolean {
    const n=kl.length; if(n<3) return false;
    const c=kl[n-1],p=kl[n-2],p2=kl[n-3];
    if(dir==="long"){return (c.c>c.o&&c.c>p.o)||(c.l>p.l&&p.l>p2.l&&c.c>c.o&&p.c>p.o);}
    return (c.c<c.o&&c.c<p.o)||(c.h<p.h&&p.h<p2.h&&c.c<c.o&&p.c<p.o);
}

interface Pos { side:"long"|"short"; entry:number; qty:number; idx:number; beTrig:boolean; bestPt:number; }
function checkExit(pos:Pos,price:number,bars:number):{close:boolean;ep:number}|null{
    const pt=pos.side==="long"?price-pos.entry:pos.entry-price;
    if(pt>pos.bestPt)pos.bestPt=pt;
    if(pt<=-SL_PT) return {close:true,ep:pos.side==="long"?pos.entry-SL_PT:pos.entry+SL_PT};
    if(!pos.beTrig&&pt>=BREAKEVEN_PT) pos.beTrig=true;
    if(pos.beTrig&&pos.bestPt>BREAKEVEN_PT){
        const ts=pos.side==="long"?pos.entry+pos.bestPt-TRAILING_PT:pos.entry-pos.bestPt+TRAILING_PT;
        const bs=pos.side==="long"?pos.entry+BREAKEVEN_OFFSET:pos.entry-BREAKEVEN_OFFSET;
        const eff=pos.side==="long"?Math.max(ts,bs):Math.min(ts,bs);
        if((pos.side==="long"&&price<=eff)||(pos.side==="short"&&price>=eff)) return {close:true,ep:price};
    }
    if(bars>=MAX_HOLD_BARS) return {close:true,ep:price};
    return null;
}

type TrendFilter = "none" | "rsi" | "ema3" | "ema7" | "ema20" | "ema50" | "ema3+7" | "ema7+20" | "ema3+7+20";
interface Res { filter: TrendFilter; trades:number; wins:number; pnl:number; wr:number; avgW:number; avgL:number; dd:number; pf:number; }

function run(kl: K5[], filter: TrendFilter, tfData: Map<string,K5[]>): Res {
    let bal=INITIAL_CAPITAL, pos:Pos|null=null;
    let trades=0,ws=0,netPnl=0;
    const wp:number[]=[],lp:number[]=[];
    let maxB=INITIAL_CAPITAL,maxDD=0,curD="",dT=0,dP=0;
    const wT=new Set<string>();

    for(let i=0;i<kl.length;i++){
        const k=kl[i];
        const d=new Date(k.ts+8*3600000).toISOString().slice(0,10);
        if(d!==curD){curD=d;dT=0;dP=0;}
        if(i<100) continue;

        if(pos){
            const bars=i-pos.idx;
            const worst=pos.side==="long"?k.l:k.h;
            const ex=checkExit(pos,worst,bars)||checkExit(pos,k.c,bars);
            if(ex?.close){
                const pt=pos.side==="long"?ex.ep-pos.entry:pos.entry-ex.ep;
                const fee=(pos.entry*pos.qty+ex.ep*pos.qty)*TAKER_FEE;
                const net=pt*pos.qty-fee;
                bal+=net;trades++;dT++;dP+=net;netPnl+=net;
                if(net>0){ws++;wp.push(net);}else lp.push(net);
                if(bal>maxB)maxB=bal; const dd=maxB-bal; if(dd>maxDD)maxDD=dd;
                pos=null;
            }
            continue;
        }
        if(dT>=MAX_DAILY_TRADES||dP<=-MAX_DAILY_LOSS||bal<50) continue;

        const utc8=new Date(k.ts+8*3600000);
        const h=utc8.getUTCHours(),m=utc8.getUTCMinutes();
        const wins=[8,15,19,22];
        if(!wins.includes(h)||m>=30) continue;
        const key=`${d}_${h}`; if(wT.has(key)) continue;

        const mtf=getMtf(k.ts,tfData);
        if(Math.abs(mtf.score)<MTF_MIN||!mtf.dir) continue;

        const atr=calcATR(kl.slice(Math.max(0,i-20),i+1));
        if(atr<3||atr>55) continue;

        // 回调
        if(mtf.poc>0){
            const dist=k.c-mtf.poc;
            if(mtf.dir==="long"&&dist>PB_ZONE) continue;
            if(mtf.dir==="short"&&dist<-PB_ZONE) continue;
        }

        // 反转确认
        const recent=kl.slice(Math.max(0,i-3),i+1);
        if(!detectReversal(recent,mtf.dir)) continue;

        // ═══ 趋势过滤 ═══
        const closes = kl.slice(Math.max(0, i - 200), i + 1).map(k => k.c);
        const price = k.c;

        if (filter === "rsi") {
            const rsi = calcRSI(closes);
            if (mtf.dir === "long" && rsi < 45) continue;
            if (mtf.dir === "short" && rsi > 55) continue;
        } else if (filter === "ema3") {
            const ema = calcEMA(closes, 3);
            if (mtf.dir === "long" && price < ema) continue;
            if (mtf.dir === "short" && price > ema) continue;
        } else if (filter === "ema7") {
            const ema = calcEMA(closes, 7);
            if (mtf.dir === "long" && price < ema) continue;
            if (mtf.dir === "short" && price > ema) continue;
        } else if (filter === "ema20") {
            const ema = calcEMA(closes, 20);
            if (mtf.dir === "long" && price < ema) continue;
            if (mtf.dir === "short" && price > ema) continue;
        } else if (filter === "ema50") {
            const ema = calcEMA(closes, 50);
            if (mtf.dir === "long" && price < ema) continue;
            if (mtf.dir === "short" && price > ema) continue;
        } else if (filter === "ema3+7") {
            const ema3 = calcEMA(closes, 3), ema7 = calcEMA(closes, 7);
            if (mtf.dir === "long" && ema3 < ema7) continue;
            if (mtf.dir === "short" && ema3 > ema7) continue;
        } else if (filter === "ema7+20") {
            const ema7 = calcEMA(closes, 7), ema20 = calcEMA(closes, 20);
            if (mtf.dir === "long" && ema7 < ema20) continue;
            if (mtf.dir === "short" && ema7 > ema20) continue;
        } else if (filter === "ema3+7+20") {
            const ema3 = calcEMA(closes, 3), ema7 = calcEMA(closes, 7), ema20 = calcEMA(closes, 20);
            // 三均线多头排列: EMA3 > EMA7 > EMA20
            if (mtf.dir === "long" && (ema3 < ema7 || ema7 < ema20)) continue;
            if (mtf.dir === "short" && (ema3 > ema7 || ema7 > ema20)) continue;
        }
        // filter === "none" → 不做趋势过滤

        wT.add(key);
        pos={side:mtf.dir as "long"|"short", entry:k.c, qty:FIXED_QTY, idx:i, beTrig:false, bestPt:0};
    }

    if(pos&&kl.length>0){
        const lk=kl[kl.length-1]; const pt=pos.side==="long"?lk.c-pos.entry:pos.entry-lk.c;
        const fee=(pos.entry*pos.qty+lk.c*pos.qty)*TAKER_FEE; const net=pt*pos.qty-fee;
        bal+=net;trades++;netPnl+=net; if(net>0){ws++;wp.push(net);}else lp.push(net);
    }

    const tW=wp.reduce((a,b)=>a+b,0), tL=Math.abs(lp.reduce((a,b)=>a+b,0));
    return { filter, trades, wins:ws, pnl:netPnl, wr:trades>0?ws/trades*100:0,
        avgW:wp.length>0?tW/wp.length:0, avgL:lp.length>0?lp.reduce((a,b)=>a+b,0)/lp.length:0,
        dd:maxDD, pf:tL>0?tW/tL:999 };
}

async function main() {
    console.log("═══════════════════════════════════════════════════════════");
    console.log("  🧪 RSI vs EMA 趋势确认对比");
    console.log("  基础: MTF≥6 + 4窗口 + 反转确认 + PB±5");
    console.log("═══════════════════════════════════════════════════════════\n");

    const sMs = new Date("2026-01-01T00:00:00Z").getTime();
    const eMs = new Date("2026-03-21T00:00:00Z").getTime();

    console.log("📥 拉取数据...");
    const kl5m = await fetchK("5m", sMs, eMs);
    console.log(`  5m: ${kl5m.length}根`);

    const tfData = new Map<string, K5[]>();
    for (const tf of ["1d","12h","8h","4h","2h","1h","30m","15m"]) {
        const kl = await fetchK(tf, sMs - 30*86400000, eMs);
        tfData.set(tf, kl);
        process.stdout.write(` ${tf}:${kl.length}`);
        await Bun.sleep(200);
    }

    const filters: TrendFilter[] = ["none", "rsi", "ema3", "ema7", "ema20", "ema50", "ema3+7", "ema7+20", "ema3+7+20"];
    const labels: Record<TrendFilter, string> = {
        "none": "❌ 无过滤",
        "rsi": "📉 RSI(14)",
        "ema3": "📊 EMA(3)",
        "ema7": "📊 EMA(7)",
        "ema20": "📊 EMA(20)",
        "ema50": "📊 EMA(50)",
        "ema3+7": "📊 EMA3>EMA7",
        "ema7+20": "📊 EMA7>EMA20",
        "ema3+7+20": "📊 EMA3>7>20",
    };

    console.log(`\n\n🔬 跑 ${filters.length} 个趋势过滤方案...\n`);
    const results: Res[] = [];
    for (const f of filters) {
        results.push(run(kl5m, f, tfData));
    }

    results.sort((a, b) => b.pnl - a.pnl);

    console.log("═══════════════════════════════════════════════════════════════════════════════");
    console.log("  📊 趋势过滤对比 (按净利排序)");
    console.log("═══════════════════════════════════════════════════════════════════════════════");
    console.log("   # | 趋势过滤       | 笔数 | 胜率   | 净利      | 均盈   | 均亏    | 回撤   | 盈亏比");
    console.log("  "+"-".repeat(90));

    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const mark = i === 0 ? " 🏆" : "";
        console.log(
            `  ${String(i+1).padStart(2)} | ${labels[r.filter].padEnd(14)} | ${String(r.trades).padStart(4)} | ${r.wr.toFixed(1).padStart(5)}% | $${((r.pnl>=0?"+":"")+r.pnl.toFixed(0)).padStart(7)} | $${r.avgW.toFixed(1).padStart(5)} | $${r.avgL.toFixed(1).padStart(6)} | $${r.dd.toFixed(0).padStart(5)} | ${r.pf.toFixed(2)}${mark}`
        );
    }

    console.log("\n═══════════════════════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
