/**
 * 🔥 V104 精细扫描 — CEO指定参数组合
 */
const FEE=0.0004, CAP=250, QTY=2.0;
interface K{ts:number;o:number;h:number;l:number;c:number;v:number;}
async function fetchK(sym:string,iv:string,s:number,e:number):Promise<K[]>{
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
function ema(data:number[],p:number):number{
    if(data.length<p) return data[data.length-1]||0;
    const k=2/(p+1); let e=data[0];
    for(let i=1;i<data.length;i++) e=data[i]*k+e*(1-k);
    return e;
}
function rsi14(c:number[]):number{
    const n=c.length; if(n<16) return 50;
    let g=0,l=0;
    for(let i=n-15;i<n-1;i++){const d=c[i+1]-c[i]; if(d>0) g+=d; else l-=d;}
    if(l===0) return 100; return 100-(100/(1+(g/14)/(l/14)));
}

interface Fire{date:string;h:number;l:number;o:number;c:number;range:number;bodyR:number;dir:"long"|"short"|"skip";}
function findFires(kl1h:K[],minR:number,minB:number):Fire[]{
    const fires:Fire[]=[];
    const dm=new Map<string,K[]>();
    for(const k of kl1h){const d=new Date(k.ts).toISOString().slice(0,10);if(!dm.has(d))dm.set(d,[]);dm.get(d)!.push(k);}
    for(const[date,bars] of dm){
        const win=bars.filter(k=>{const h=new Date(k.ts).getUTCHours();return h>=8&&h<12;});
        if(win.length<3) continue;
        const o=win[0].o,c=win[win.length-1].c;
        const h=Math.max(...win.map(k=>k.h)),l=Math.min(...win.map(k=>k.l));
        const body=Math.abs(c-o),range=h-l; if(range<5) continue;
        if(range<minR) continue;
        const bodyR=body/range;
        let dir:"long"|"short"|"skip"="skip";
        if(bodyR>=minB) dir=c>o?"long":"short";
        fires.push({date,h,l,o,c,range,bodyR,dir});
    }
    return fires;
}

interface Cfg{
    name:string; minRange:number; minBody:number;
    indDepth:number; indVol:number;
    use15m:boolean;
    entryMode:"3cond"|"3core"|"5cond"|"4of5"; // 入场模式
    entryBodyR:number; entryVol:number; rsiMin:number; rsiMax:number;
    partialPt:number; trailPt:number; fullTP:number;
    bePt:number; beOff:number;
    slMode:"fixed"|"dynamic"; fixedSL:number;
}

interface Result{
    trades:number;wins:number;pnl:number;dd:number;pf:number;partials:number;
    maxWin:number;avgR:number;dailyAvg:number;
    reasons:Record<string,number>;
}

function run(kl5m:K[],kl15m:K[],fires:Fire[],cfg:Cfg):Result{
    let bal=CAP,maxB=CAP,maxDD=0,partials=0;
    const tradeNets:number[]=[];
    const reasons:Record<string,number>={};
    let maxWin=0;
    const tradeDays=new Set<string>();

    for(const f of fires){
        if(f.dir==="skip") continue;
        const day5m=kl5m.filter(k=>{
            const d=new Date(k.ts).toISOString().slice(0,10);
            const h=new Date(k.ts).getUTCHours();
            return d===f.date && h>=12 && h<=20;
        });
        if(day5m.length<5) continue;

        // 15m结构
        if(cfg.use15m){
            const day15m=kl15m.filter(k=>new Date(k.ts).toISOString().slice(0,10)===f.date);
            if(day15m.length>=55){
                const cl=day15m.map(k=>k.c);
                const e21=ema(cl,21),e55=ema(cl,55);
                if(f.dir==="long"&&e21<e55) continue;
                if(f.dir==="short"&&e21>e55) continue;
            }
        }

        let ep=0,indLow=0,indHigh=0,eIdx=-1,manipulated=false;
        const closes:number[]=[],vols:number[]=[];
        const pre5m=kl5m.filter(k=>{const d=new Date(k.ts).toISOString().slice(0,10);const h=new Date(k.ts).getUTCHours();return d===f.date&&h<12;});
        for(const k of pre5m){closes.push(k.c);vols.push(k.v);}

        for(let i=0;i<day5m.length;i++){
            const bar=day5m[i],prev=i>0?day5m[i-1]:null;
            closes.push(bar.c);vols.push(bar.v);
            if(ep>0) break;

            if(!manipulated){
                const avgV=vols.length>12?vols.slice(-13,-1).reduce((a,v)=>a+v,0)/12:0;
                if(f.dir==="long"){
                    const d=f.c-bar.l;
                    if(d>=cfg.indDepth&&(avgV<=0||bar.v>=avgV*cfg.indVol)){manipulated=true;indLow=bar.l;}
                } else {
                    const d=bar.h-f.c;
                    if(d>=cfg.indDepth&&(avgV<=0||bar.v>=avgV*cfg.indVol)){manipulated=true;indHigh=bar.h;}
                }
                continue;
            }
            if(f.dir==="long"&&bar.l<indLow) indLow=bar.l;
            if(f.dir==="short"&&bar.h>indHigh) indHigh=bar.h;
            if(!prev) continue;

            const bB=Math.abs(bar.c-bar.o),bR=bar.h-bar.l,bBR=bR>0?bB/bR:0;
            const rsi=rsi14(closes);
            const aV=vols.length>11?vols.slice(-11,-1).reduce((a,v)=>a+v,0)/10:0;

            let entry=false;
            if(cfg.entryMode==="5cond"){
                if(f.dir==="long"){
                    const c1=bar.c>f.c-4,c2=bar.c>bar.o&&bBR>=cfg.entryBodyR,c3=prev.c<f.c;
                    const c4=aV>0&&bar.v>=aV*cfg.entryVol,c5=rsi>cfg.rsiMin&&rsi<cfg.rsiMax;
                    entry=c1&&c2&&c3&&c4&&c5;
                } else {
                    const c1=bar.c<f.c+4,c2=bar.c<bar.o&&bBR>=cfg.entryBodyR,c3=prev.c>f.c;
                    const c4=aV>0&&bar.v>=aV*cfg.entryVol,c5=rsi>cfg.rsiMin&&rsi<cfg.rsiMax;
                    entry=c1&&c2&&c3&&c4&&c5;
                }
            } else if(cfg.entryMode==="4of5"){
                // 至少4/5条件
                if(f.dir==="long"){
                    const c1=bar.c>f.c-4?1:0, c2=bar.c>bar.o&&bBR>=cfg.entryBodyR?1:0, c3=prev.c<f.c?1:0;
                    const c4=aV>0&&bar.v>=aV*cfg.entryVol?1:0, c5=rsi>cfg.rsiMin&&rsi<cfg.rsiMax?1:0;
                    entry=(c1+c2+c3+c4+c5)>=4;
                } else {
                    const c1=bar.c<f.c+4?1:0, c2=bar.c<bar.o&&bBR>=cfg.entryBodyR?1:0, c3=prev.c>f.c?1:0;
                    const c4=aV>0&&bar.v>=aV*cfg.entryVol?1:0, c5=rsi>cfg.rsiMin&&rsi<cfg.rsiMax?1:0;
                    entry=(c1+c2+c3+c4+c5)>=4;
                }
            } else if(cfg.entryMode==="3core"){
                // 3核心条件: close回穿 + 强阳线 + 量能爆发
                if(f.dir==="long"){
                    entry=bar.c>f.c-4 && bar.c>bar.o && bBR>=cfg.entryBodyR && aV>0 && bar.v>=aV*cfg.entryVol;
                } else {
                    entry=bar.c<f.c+4 && bar.c<bar.o && bBR>=cfg.entryBodyR && aV>0 && bar.v>=aV*cfg.entryVol;
                }
            } else {
                // 3cond原版
                if(f.dir==="long") entry=bar.c>f.c&&bar.c>bar.o&&prev.c<f.c;
                else entry=bar.c<f.c&&bar.c<bar.o&&prev.c>f.c;
            }
            if(entry){ep=bar.c;eIdx=i;}
        }
        if(ep===0) continue;

        let slPt:number;
        if(cfg.slMode==="fixed") slPt=cfg.fixedSL;
        else { const ind=f.dir==="long"?ep-indLow+8:indHigh-ep+8; slPt=Math.max(15,Math.min(22,ind)); }

        let exitP=0,reason="",bestPt=0,partialNet=0;
        let pc=false,rQty=QTY,beT=false;
        const sI=kl5m.findIndex(k=>k.ts===day5m[eIdx].ts);
        if(sI<0) continue;

        for(let j=sI+1;j<kl5m.length&&j-sI<120;j++){
            const bar=kl5m[j];
            const ptHi=f.dir==="long"?bar.h-ep:ep-bar.l;
            const ptLo=f.dir==="long"?bar.l-ep:ep-bar.h;
            const pt=f.dir==="long"?bar.c-ep:ep-bar.c;
            if(ptHi>bestPt) bestPt=ptHi;

            if(ptLo<=-slPt){exitP=f.dir==="long"?ep-slPt:ep+slPt;reason="SL";break;}
            if(!beT&&ptHi>=cfg.bePt) beT=true;
            if(beT&&pt<cfg.bePt&&bestPt<cfg.partialPt){
                const beSL=f.dir==="long"?ep+cfg.beOff:ep-cfg.beOff;
                if((f.dir==="long"&&bar.l<=beSL)||(f.dir==="short"&&bar.h>=beSL)){exitP=beSL;reason="BE";break;}
            }
            if(!pc&&bestPt>=cfg.partialPt){
                const hQ=QTY/2;
                partialNet=cfg.partialPt*hQ-(ep*hQ+(f.dir==="long"?ep+cfg.partialPt:ep-cfg.partialPt)*hQ)*FEE;
                pc=true;rQty=QTY-hQ;partials++;
            }
            if(beT&&bestPt>cfg.bePt){
                const tSL=bestPt-cfg.trailPt;
                if(tSL>0&&pt<=tSL){exitP=f.dir==="long"?ep+tSL:ep-tSL;reason="TRAIL";break;}
            }
            if(ptHi>=cfg.fullTP){exitP=f.dir==="long"?ep+cfg.fullTP:ep-cfg.fullTP;reason="5R";break;}
        }
        if(exitP===0){exitP=kl5m[Math.min(sI+119,kl5m.length-1)].c;reason="TIMEOUT";}

        const fPt=f.dir==="long"?exitP-ep:ep-exitP;
        const rNet=fPt*rQty-(ep*rQty+exitP*rQty)*FEE;
        const tNet=partialNet+rNet;
        bal+=tNet; if(bal>maxB)maxB=bal;
        const dd=maxB-bal; if(dd>maxDD)maxDD=dd;
        tradeNets.push(tNet);
        reasons[reason]=(reasons[reason]||0)+1;
        if(tNet>maxWin) maxWin=tNet;
        tradeDays.add(f.date);
    }

    const w=tradeNets.filter(n=>n>0);
    const tW=w.reduce((a,n)=>a+n,0);
    const tL=Math.abs(tradeNets.filter(n=>n<=0).reduce((a,n)=>a+n,0));
    const totalDays=fires.filter(f=>f.dir!=="skip").length||1;
    return{
        trades:tradeNets.length,wins:w.length,pnl:bal-CAP,dd:maxDD,
        pf:tL>0?tW/tL:999,partials,maxWin,
        avgR:tradeNets.length>0?tradeNets.reduce((a,n)=>a+n,0)/tradeNets.length:0,
        dailyAvg:tradeNets.length/totalDays,
        reasons,
    };
}

async function main(){
    console.log("═══════════════════════════════════════════════════════════════════════");
    console.log("  🔥 V104 精细扫描 | CEO指定参数 | ETHUSDT | $250 | 2026.01-03.24");
    console.log("═══════════════════════════════════════════════════════════════════════\n");

    const sMs=new Date("2026-01-01T00:00:00Z").getTime();
    const eMs=new Date("2026-03-24T00:00:00Z").getTime();

    console.log("📥 拉取数据...");
    const kl1h=await fetchK("ETHUSDT","1h",sMs-7*86400000,eMs);
    const kl5m=await fetchK("ETHUSDT","5m",sMs,eMs);
    const kl15m=await fetchK("ETHUSDT","15m",sMs,eMs);
    console.log(`  1h:${kl1h.length} 15m:${kl15m.length} 5m:${kl5m.length}\n`);

    const base:Cfg={
        name:"",minRange:40,minBody:0.35,
        indDepth:5,indVol:1.3,
        use15m:true,entryMode:"3cond",
        entryBodyR:0.58,entryVol:1.4,rsiMin:42,rsiMax:65,
        partialPt:35,trailPt:12,fullTP:100,
        bePt:12,beOff:1.5,
        slMode:"dynamic",fixedSL:20,
    };

    const configs:Cfg[]=[
        // ═══ 基线 ═══
        {...base,name:"A1 V96原版",minRange:0,minBody:0.4,indDepth:0,indVol:1.0,use15m:false,entryMode:"3cond",slMode:"fixed",fixedSL:20,partialPt:999,trailPt:5,fullTP:100,bePt:12,beOff:3},

        // ═══ 组合1: Fire≥40+诱导≥5+5条件全中 ═══
        {...base,name:"B1 5条件全中",entryMode:"5cond"},
        // ═══ 组合2: Fire≥40+诱导≥5+4/5条件 ═══
        {...base,name:"B2 4of5条件",entryMode:"4of5"},
        // ═══ 组合3: Fire≥40+诱导≥5+3核心条件 ═══
        {...base,name:"B3 3核心条件",entryMode:"3core"},
        // ═══ 组合4: Fire≥40+诱导≥5+原版3条件 ═══
        {...base,name:"B4 原版3条件",entryMode:"3cond"},

        // ═══ 保本点对比 (用3核心+15m) ═══
        {...base,name:"C1 BE=6pt",entryMode:"3core",bePt:6,beOff:1.5},
        {...base,name:"C2 BE=12pt ★",entryMode:"3core",bePt:12,beOff:1.5},
        {...base,name:"C3 BE=15pt",entryMode:"3core",bePt:15,beOff:2.0},

        // ═══ 不用15m (对比15m效果) ═══
        {...base,name:"D1 无15m+3核心",entryMode:"3core",use15m:false},
        {...base,name:"D2 有15m+3核心",entryMode:"3core",use15m:true},

        // ═══ SL对比 ═══
        {...base,name:"E1 固定SL20",entryMode:"3core",slMode:"fixed",fixedSL:20},
        {...base,name:"E2 动态SL[15-22]",entryMode:"3core",slMode:"dynamic"},

        // ═══ 最优组合候选 ═══
        {...base,name:"★ 最优候选",entryMode:"3core",bePt:12,beOff:2.0,slMode:"dynamic",trailPt:12},
    ];

    console.log(`${"方案".padEnd(20)} | 笔数 | 胜率  | 净利     | 回撤  | PF     | 分批 | 最大赢 | 平均R  | 日均  | 出场分布`);
    console.log(`${"-".repeat(140)}`);

    for(const cfg of configs){
        const fires=findFires(kl1h,cfg.minRange,cfg.minBody);
        const r=run(kl5m,kl15m,fires,cfg);
        const rStr=Object.entries(r.reasons).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}:${v}`).join(" ");
        console.log(
            `${cfg.name.padEnd(20)} | ${String(r.trades).padStart(4)} | ${r.trades>0?(r.wins/r.trades*100).toFixed(0).padStart(4):"-   "}% | $${(r.pnl>=0?"+":"")+r.pnl.toFixed(0).padStart(6)} | $${r.dd.toFixed(0).padStart(4)} | ${r.pf.toFixed(2).padStart(6)} | ${String(r.partials).padStart(4)} | $${r.maxWin.toFixed(0).padStart(5)} | $${r.avgR.toFixed(1).padStart(5)} | ${r.dailyAvg.toFixed(2)} | ${rStr}`
        );
    }
    console.log(`\n${"═".repeat(70)}\n`);
}
main().catch(console.error);
export {};
