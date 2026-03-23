/**
 * 🧪 五重共振 参数扫描
 * ═══════════════════════════════════════
 * 扫描: MTF门槛(3~7) × 窗口组合 × RSI宽度 × ATR下限
 * 目标: 找到频率(≥1笔/周) + 胜率(≥50%) + 正EV的最佳组合
 */

const LEVERAGE = 150;
const TAKER_FEE = 0.0004;
const INITIAL = 500;
const QTY = 1.0;
const SL = 20; const BE = 12; const BE_OFF = 3; const TRAIL = 10;
const MAX_DT = 4; const MAX_DL = 150; const MAX_BARS = 12;

interface K { ts:number; o:number; h:number; l:number; c:number; v:number; }

async function fetchK(sym:string, iv:string, s:number, e:number): Promise<K[]> {
    const all:K[]=[]; let cur=s;
    while(cur<e){
        const url=`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${iv}&startTime=${cur}&endTime=${e}&limit=1500`;
        const r=await fetch(url); if(!r.ok){await Bun.sleep(5000);continue;}
        const d=(await r.json()) as any[][]; if(!d.length) break;
        for(const k of d) all.push({ts:k[0] as number,o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]});
        cur=(d[d.length-1][6] as number)+1; await Bun.sleep(150);
    }
    return all;
}

function poc(kl:K[]):number{ if(!kl.length)return 0; let m=0,p=0; for(const k of kl){if(k.v>m){m=k.v;p=(k.h+k.l+k.c)/3;}} return p; }
function rsi(c:number[],p=14):number{ if(c.length<p+1)return 50; let g=0,l=0; for(let i=c.length-p;i<c.length;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l+=-d;} const ag=g/p,al=l/p; return al===0?100:100-100/(1+ag/al); }
function atr(kl:K[],p=14):number{ if(kl.length<p)return 0; let s=0; for(let i=kl.length-p;i<kl.length;i++)s+=kl[i].h-kl[i].l; return s/p; }

const TFS=[
    {iv:"1d",th:50,hs:2},{iv:"12h",th:30,hs:2},{iv:"8h",th:20,hs:3},
    {iv:"4h",th:10,hs:6},{iv:"2h",th:8,hs:6},{iv:"1h",th:5,hs:12},
    {iv:"30m",th:4,hs:12},{iv:"15m",th:3,hs:16},
];

function mtf(ts:number,td:Map<string,K[]>):{sc:number;dir:string;poc:number}{
    let sc=0,pS=0,pW=0;
    const pw:Record<string,number>={"2h":1,"1h":3,"30m":3,"15m":2};
    for(const tf of TFS){
        const kl=td.get(tf.iv); if(!kl||kl.length<4) continue;
        const b=kl.filter(k=>k.ts<=ts); if(b.length<tf.hs*2) continue;
        const r=b.slice(-tf.hs),p=b.slice(-tf.hs*2,-tf.hs);
        const s=poc(r)-poc(p);
        if(s>tf.th)sc++;else if(s<-tf.th)sc--;
        const w=pw[tf.iv]||0; const p1=poc(r);
        if(w>0&&p1>0){pS+=p1*w;pW+=w;}
    }
    return {sc,dir:sc>0?"long":sc<0?"short":"",poc:pW>0?pS/pW:0};
}

function pocDir(k4h:K[],ts:number):number{
    const b=k4h.filter(k=>k.ts<=ts);
    if(b.length<2) return 0;
    return poc([b[b.length-1]])-poc([b[b.length-2]]);
}

function hasLongShadow(kl:K[],dir:string):boolean{
    for(const k of kl.slice(-3)){
        const range=k.h-k.l; if(range===0) continue;
        if(dir==="long"&&(k.h-Math.max(k.o,k.c))/range>0.4) return true;
        if(dir==="short"&&(Math.min(k.o,k.c)-k.l)/range>0.4) return true;
    }
    return false;
}

interface Cfg {
    mtfMin: number;
    windows: number[];
    rsiL: number; rsiH: number;
    atrMin: number;
    pocMin: number;
    pbZone: number;
}

interface Res {
    cfg: Cfg; trades:number; wins:number; pnl:number; wr:number;
    avgPt:number; dd:number; pf:number;
}

function run(kl:K[], cfg:Cfg, td:Map<string,K[]>, k4h:K[]): Res {
    let bal=INITIAL, pos:{s:"long"|"short";e:number;i:number;beTrig:boolean;bestPt:number}|null=null;
    let trades=0,ws=0,net=0; const wp:number[]=[],lp:number[]=[];
    let maxB=INITIAL,maxDD=0,curD="",dT=0,dP=0;
    const wT=new Set<string>();

    for(let i=0;i<kl.length;i++){
        const k=kl[i];
        const u8=new Date(k.ts+8*3600000);
        const d=u8.toISOString().slice(0,10);
        const h=u8.getUTCHours(),m=u8.getUTCMinutes();
        if(d!==curD){curD=d;dT=0;dP=0;}
        if(i<100) continue;

        if(pos){
            const bars=i-pos.i;
            const pt=pos.s==="long"?k.c-pos.e:pos.e-k.c;
            const wst=pos.s==="long"?k.l-pos.e:pos.e-k.h;
            if(pt>pos.bestPt) pos.bestPt=pt;
            let closed=false,ep=k.c,reason="";
            // SL
            if(wst<=-SL){closed=true;ep=pos.s==="long"?pos.e-SL:pos.e+SL;reason="SL";}
            // BE+Trail
            if(!closed){
                if(!pos.beTrig&&pt>=BE) pos.beTrig=true;
                if(pos.beTrig&&pos.bestPt>BE){
                    const tl=pos.s==="long"?pos.e+pos.bestPt-TRAIL:pos.e-pos.bestPt+TRAIL;
                    const be=pos.s==="long"?pos.e+BE_OFF:pos.e-BE_OFF;
                    const eff=pos.s==="long"?Math.max(tl,be):Math.min(tl,be);
                    if((pos.s==="long"&&k.c<=eff)||(pos.s==="short"&&k.c>=eff)){closed=true;ep=k.c;reason="TRAIL";}
                }
            }
            // Timeout / window close
            if(!closed&&bars>=MAX_BARS){closed=true;ep=k.c;reason="WIN";}
            if(closed){
                const rpt=pos.s==="long"?ep-pos.e:pos.e-ep;
                const fee=(pos.e*QTY+ep*QTY)*TAKER_FEE;
                const n=rpt*QTY-fee;
                bal+=n;trades++;dT++;dP+=n;net+=n;
                if(n>0){ws++;wp.push(n);}else lp.push(n);
                if(bal>maxB)maxB=bal; const dd=maxB-bal; if(dd>maxDD)maxDD=dd;
                pos=null;
            }
            continue;
        }

        if(dT>=MAX_DT||dP<=-MAX_DL||bal<50) continue;
        if(!cfg.windows.includes(h)) continue;
        if(m>10) continue;
        const key=`${d}_${h}`; if(wT.has(key)) continue;

        // MTF
        const mt=mtf(k.ts,td);
        if(Math.abs(mt.sc)<cfg.mtfMin||!mt.dir) continue;

        // POC方向
        const pd=pocDir(k4h,k.ts);
        if(mt.dir==="long"&&pd<cfg.pocMin) continue;
        if(mt.dir==="short"&&pd>-cfg.pocMin) continue;

        // RSI
        const closes=kl.slice(Math.max(0,i-200),i+1).map(x=>x.c);
        const r=rsi(closes);
        if(mt.dir==="long"&&r>cfg.rsiH) continue;
        if(mt.dir==="short"&&r<cfg.rsiL) continue;

        // ATR
        const a=atr(kl.slice(Math.max(0,i-20),i+1));
        if(a<cfg.atrMin||a>55) continue;

        // K棒结构
        if(hasLongShadow(kl.slice(Math.max(0,i-3),i+1),mt.dir)) continue;

        // 回调
        if(mt.poc>0){
            const dist=k.c-mt.poc;
            if(mt.dir==="long"&&dist>cfg.pbZone) continue;
            if(mt.dir==="short"&&dist<-cfg.pbZone) continue;
            if(Math.abs(dist)>15) continue;
        }

        wT.add(key);
        pos={s:mt.dir as "long"|"short",e:k.c,i,beTrig:false,bestPt:0};
    }

    if(pos&&kl.length>0){
        const lk=kl[kl.length-1]; const pt=pos.s==="long"?lk.c-pos.e:pos.e-lk.c;
        const fee=(pos.e*QTY+lk.c*QTY)*TAKER_FEE; const n=pt*QTY-fee;
        bal+=n;trades++;net+=n; if(n>0){ws++;wp.push(n);}else lp.push(n);
    }

    const tW=wp.reduce((a,b)=>a+b,0), tL=Math.abs(lp.reduce((a,b)=>a+b,0));
    return {
        cfg, trades, wins:ws, pnl:net,
        wr:trades>0?ws/trades*100:0,
        avgPt:trades>0?net/trades:0,
        dd:maxDD, pf:tL>0?tW/tL:trades>0?999:0
    };
}

async function main(){
    console.log("═══════════════════════════════════════════════════════════");
    console.log("  🔬 五重共振 参数扫描 (寻找频率-质量最佳平衡)");
    console.log("═══════════════════════════════════════════════════════════\n");

    const sMs=new Date("2026-01-01T00:00:00Z").getTime();
    const eMs=new Date("2026-03-21T00:00:00Z").getTime();

    console.log("📥 拉取数据...");
    const kl=await fetchK("ETHUSDT","5m",sMs,eMs);
    console.log(`  5m: ${kl.length}根`);
    const k4h=await fetchK("ETHUSDT","4h",sMs-30*86400000,eMs);
    console.log(`  4h: ${k4h.length}根`);

    const td=new Map<string,K[]>();
    for(const tf of ["1d","12h","8h","4h","2h","1h","30m","15m"]){
        const d=await fetchK("ETHUSDT",tf,sMs-30*86400000,eMs);
        td.set(tf,d); process.stdout.write(` ${tf}:${d.length}`);
        await Bun.sleep(200);
    }

    // ═══ 参数空间 ═══
    const configs: Cfg[] = [];

    const mtfMins = [3, 4, 5, 6];
    const windowSets: {name:string; wins:number[]}[] = [
        { name: "15/19/22", wins: [15,19,22] },
        { name: "08/15/19/22", wins: [8,15,19,22] },
        { name: "19/22", wins: [19,22] },
    ];
    const rsiPairs = [
        { l: 30, h: 70, name: "宽RSI(30-70)" },
        { l: 40, h: 60, name: "窄RSI(40-60)" },
    ];
    const atrMins = [3, 5, 8];
    const pocMins = [3, 5];
    const pbZones = [5, 10];

    for(const mtfMin of mtfMins){
        for(const ws of windowSets){
            for(const rs of rsiPairs){
                for(const am of atrMins){
                    for(const pm of pocMins){
                        for(const pb of pbZones){
                            configs.push({mtfMin,windows:ws.wins,rsiL:rs.l,rsiH:rs.h,atrMin:am,pocMin:pm,pbZone:pb});
                        }
                    }
                }
            }
        }
    }

    console.log(`\n\n🔬 扫描 ${configs.length} 个参数组合...\n`);

    const results: Res[] = [];
    for(const cfg of configs){
        results.push(run(kl,cfg,td,k4h));
    }

    // 过滤: 至少5笔 + 正EV
    const valid = results.filter(r => r.trades >= 5 && r.pnl > 0).sort((a,b) => {
        // 综合评分: pnl × 胜率权重
        const scoreA = a.pnl * (a.wr / 100);
        const scoreB = b.pnl * (b.wr / 100);
        return scoreB - scoreA;
    });

    console.log("═══════════════════════════════════════════════════════════════════════════════════════════════════");
    console.log("  📊 正期望值方案 TOP 15 (≥5笔 + 正EV + 按综合评分排序)");
    console.log("═══════════════════════════════════════════════════════════════════════════════════════════════════");
    console.log("   # | MTF | 窗口         | RSI    | ATR≥ | POC≥ | PB  | 笔数 | 胜率   | 净利    | 均盈亏  | 回撤   | PF");
    console.log("  "+"-".repeat(110));

    const top = valid.slice(0, 15);
    const winNames = (w:number[]) => w.map(h=>`${h}`).join("/");

    for(let i=0;i<top.length;i++){
        const r=top[i];
        const c=r.cfg;
        const mark=i===0?" 🏆":"";
        console.log(
            `  ${String(i+1).padStart(2)} | ${String(c.mtfMin).padStart(3)} | ${winNames(c.windows).padEnd(12)} | ${c.rsiL}-${c.rsiH} | ${String(c.atrMin).padStart(3)}  | ${String(c.pocMin).padStart(3)}  | ${String(c.pbZone).padStart(3)} | ${String(r.trades).padStart(4)} | ${r.wr.toFixed(0).padStart(4)}%  | $${(r.pnl>=0?"+":"")+r.pnl.toFixed(0).padStart(5)} | $${r.avgPt.toFixed(1).padStart(5)} | $${r.dd.toFixed(0).padStart(4)} | ${r.pf.toFixed(2)}${mark}`
        );
    }

    if(!valid.length){
        console.log("\n  ⚠️ 没有找到 ≥5笔 + 正EV 的组合！");
        console.log("  松开条件看所有结果...\n");
        const allSorted = results.filter(r=>r.trades>=3).sort((a,b)=>b.pnl-a.pnl);
        for(let i=0;i<Math.min(15,allSorted.length);i++){
            const r=allSorted[i];
            const c=r.cfg;
            console.log(
                `  ${String(i+1).padStart(2)} | MTF≥${c.mtfMin} | ${winNames(c.windows).padEnd(12)} | RSI${c.rsiL}-${c.rsiH} | ATR≥${c.atrMin} | POC≥${c.pocMin} | PB${c.pbZone} | ${r.trades}笔 ${r.wr.toFixed(0)}% $${r.pnl.toFixed(0)} DD$${r.dd.toFixed(0)}`
            );
        }
    }

    // 全量统计
    const positive = results.filter(r=>r.pnl>0);
    const active = results.filter(r=>r.trades>=5);
    console.log(`\n  📈 总扫描: ${configs.length} 组合 | 有交易(≥5笔): ${active.length} | 正EV: ${positive.length}`);

    console.log("\n═══════════════════════════════════════════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
