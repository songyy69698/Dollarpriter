/**
 * 🔥 Fire Candle — 10 轮迭代优化
 * 每轮针对上一轮的弱点做一次改进，逐步逼近最优
 */

const FEE=0.0004, CAP=500;
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

interface Fire{date:string;h:number;l:number;o:number;c:number;body:number;range:number;bodyR:number;dir:"long"|"short"|"skip";midOpen:number;}

function findFires(kl1h:K[], fS:number, fE:number, minBodyR:number):Fire[]{
    const fires:Fire[]=[];
    const dm=new Map<string,K[]>();
    for(const k of kl1h){const d=new Date(k.ts).toISOString().slice(0,10);if(!dm.has(d))dm.set(d,[]);dm.get(d)!.push(k);}
    for(const[date,bars] of dm){
        const win=bars.filter(k=>{const h=new Date(k.ts).getUTCHours();return h>=fS&&h<fE;});
        if(win.length<2) continue;
        const o=win[0].o,c=win[win.length-1].c;
        const h=Math.max(...win.map(k=>k.h)),l=Math.min(...win.map(k=>k.l));
        const body=Math.abs(c-o),range=h-l; if(range<1) continue;
        const bodyR=body/range;
        let dir:"long"|"short"|"skip"="skip";
        if(bodyR>=minBodyR){dir=c>o?"long":"short";}
        const midBar=bars.find(k=>new Date(k.ts).getUTCHours()===5);
        fires.push({date,h,l,o,c,body,range,bodyR,dir,midOpen:midBar?midBar.o:o});
    }
    return fires;
}

interface Cfg{
    name:string;
    fS:number;fE:number; // Fire candle窗口
    tS:number;tE:number; // 交易窗口
    minBodyR:number;     // 最低实体占比
    slMode:"4hLow"|"sweep"|"hybrid"; // SL模式
    tpR:number;          // TP倍数 (R:R)
    turtleBars:number;   // Turtle Soup 允许几根bar完成
    useTrail:boolean;    // 追踪止盈
    trailPt:number;      // 追踪距离
    useMidnight:boolean; // Midnight Open 过滤
    volFilter:boolean;   // 量能过滤
    maxHold:number;      // 最大持仓5m bar数
}

interface Trade{date:string;side:string;entry:number;sl:number;tp:number;exit:number;pt:number;net:number;reason:string;}
interface Res{cfg:Cfg;trades:number;wins:number;pnl:number;wr:number;dd:number;pf:number;months:Record<string,number>;}

function run(kl5m:K[],fires:Fire[],qty:number,cfg:Cfg):Res{
    const trades:Trade[]=[];
    let bal=CAP,maxB=CAP,maxDD=0;
    const months:Record<string,number>={};

    for(const f of fires){
        if(f.dir==="skip") continue;

        const after=kl5m.filter(k=>{
            const kd=new Date(k.ts).toISOString().slice(0,10);
            const kh=new Date(k.ts).getUTCHours();
            return kd===f.date && kh>=cfg.tS && kh<=cfg.tE;
        });
        if(after.length<5) continue;

        // Midnight 过滤
        if(cfg.useMidnight){
            if(f.dir==="long" && after[0].c > f.midOpen) continue;
            if(f.dir==="short" && after[0].c < f.midOpen) continue;
        }

        // 量能过滤
        if(cfg.volFilter){
            const avgV=after.slice(0,5).reduce((a,k)=>a+k.v,0)/5;
            const fireVol=kl5m.filter(k=>{
                const kd=new Date(k.ts).toISOString().slice(0,10);
                const kh=new Date(k.ts).getUTCHours();
                return kd===f.date && kh>=cfg.fS && kh<cfg.fE;
            }).reduce((a,k)=>a+k.v,0);
            if(fireVol<avgV*2) continue; // Fire candle量能要大
        }

        // 找入场: 诱导回踩 + 可选Turtle Soup
        let ep=0,sweepLow=0,sweepHigh=0,entryIdx=-1;
        let manipulated=false;

        for(let i=1;i<after.length;i++){
            const bar=after[i];
            if(ep>0) break;

            if(f.dir==="long"){
                if(!manipulated && bar.l<f.c) manipulated=true;
                if(manipulated){
                    // 多bar Turtle Soup: 在cfg.turtleBars范围内寻找反抽
                    const lookback=after.slice(Math.max(0,i-cfg.turtleBars),i+1);
                    const recentLow=Math.min(...lookback.map(k=>k.l));
                    if(bar.c>f.c && bar.c>bar.o){
                        ep=bar.c; sweepLow=recentLow; entryIdx=i;
                    }
                }
            } else {
                if(!manipulated && bar.h>f.c) manipulated=true;
                if(manipulated){
                    const lookback=after.slice(Math.max(0,i-cfg.turtleBars),i+1);
                    const recentHigh=Math.max(...lookback.map(k=>k.h));
                    if(bar.c<f.c && bar.c<bar.o){
                        ep=bar.c; sweepHigh=recentHigh; entryIdx=i;
                    }
                }
            }
        }
        if(ep===0) continue;

        // SL 计算
        let sl:number;
        if(cfg.slMode==="4hLow"){
            sl=f.dir==="long"?f.l-1:f.h+1;
        } else if(cfg.slMode==="sweep"){
            sl=f.dir==="long"?sweepLow-1:sweepHigh+1;
        } else { // hybrid: 取sweep和4H的中点
            const sweepSL=f.dir==="long"?sweepLow-1:sweepHigh+1;
            const wideSL=f.dir==="long"?f.l-1:f.h+1;
            sl=f.dir==="long"?Math.min(sweepSL,wideSL+(ep-wideSL)*0.5):Math.max(sweepSL,wideSL-(wideSL-ep)*0.5);
        }

        const risk=f.dir==="long"?ep-sl:sl-ep;
        if(risk<=0||risk>500) continue;
        let tp=f.dir==="long"?ep+risk*cfg.tpR:ep-risk*cfg.tpR;

        // 模拟持仓
        let exitP=0,reason="",bestPt=0;
        const startIdx=kl5m.findIndex(k=>k.ts===after[entryIdx].ts);
        if(startIdx<0) continue;

        for(let j=startIdx+1;j<kl5m.length&&j-startIdx<cfg.maxHold;j++){
            const bar=kl5m[j];
            const pt=f.dir==="long"?bar.c-ep:ep-bar.c;
            if(pt>bestPt) bestPt=pt;

            if(f.dir==="long"){
                if(bar.l<=sl){exitP=sl;reason="SL";break;}
                if(bar.h>=tp){exitP=tp;reason="TP";break;}
            } else {
                if(bar.h>=sl){exitP=sl;reason="SL";break;}
                if(bar.l<=tp){exitP=tp;reason="TP";break;}
            }

            // 追踪止盈
            if(cfg.useTrail && bestPt>risk){
                const trailSL=f.dir==="long"?ep+bestPt-cfg.trailPt:ep-bestPt+cfg.trailPt;
                const beSL=f.dir==="long"?ep+3:ep-3;
                const effSL=f.dir==="long"?Math.max(trailSL,beSL):Math.min(trailSL,beSL);
                if((f.dir==="long"&&bar.c<=effSL)||(f.dir==="short"&&bar.c>=effSL)){
                    exitP=bar.c;reason="TRAIL";break;
                }
            }
        }
        if(exitP===0){
            exitP=kl5m[Math.min(startIdx+cfg.maxHold-1,kl5m.length-1)].c;
            reason="TIMEOUT";
        }

        const pt=f.dir==="long"?exitP-ep:ep-exitP;
        const fee=(ep*qty+exitP*qty)*FEE;
        const net=pt*qty-fee;
        bal+=net; if(bal>maxB)maxB=bal;
        const dd=maxB-bal; if(dd>maxDD)maxDD=dd;
        const mon=f.date.slice(0,7);
        months[mon]=(months[mon]||0)+net;
        trades.push({date:f.date,side:f.dir,entry:ep,sl,tp,exit:exitP,pt,net,reason});
    }

    const w=trades.filter(t=>t.net>0);
    const tW=w.reduce((a,t)=>a+t.net,0);
    const tL=Math.abs(trades.filter(t=>t.net<0).reduce((a,t)=>a+t.net,0));
    return{cfg,trades:trades.length,wins:w.length,pnl:trades.reduce((a,t)=>a+t.net,0),
        wr:trades.length>0?w.length/trades.length*100:0,dd:maxDD,
        pf:tL>0?tW/tL:999,months};
}

async function main(){
    console.log("═══════════════════════════════════════════════════════════");
    console.log("  🔥 Fire Candle — 10 轮迭代优化");
    console.log("  ETHUSDT | $500 | 150x | 2026.01-03");
    console.log("═══════════════════════════════════════════════════════════\n");

    const sMs=new Date("2026-01-01T00:00:00Z").getTime();
    const eMs=new Date("2026-03-21T00:00:00Z").getTime();

    console.log("📥 拉取数据...");
    const kl1h=await fetchK("ETHUSDT","1h",sMs-7*86400000,eMs);
    const kl5m=await fetchK("ETHUSDT","5m",sMs,eMs);
    console.log(`  1h:${kl1h.length} 5m:${kl5m.length}`);

    const base:Cfg={name:"",fS:8,fE:12,tS:12,tE:22,minBodyR:0.4,slMode:"4hLow",tpR:2,turtleBars:1,useTrail:false,trailPt:10,useMidnight:false,volFilter:false,maxHold:60};

    const rounds:{round:number;change:string;cfgs:Cfg[]}[] = [
        // R1: Turtle Soup bar数 (1根 vs 3根 vs 5根)
        {round:1,change:"Turtle Soup 放宽(1→3→5根bar)",cfgs:[
            {...base,name:"TS=1bar",turtleBars:1},
            {...base,name:"TS=3bar",turtleBars:3},
            {...base,name:"TS=5bar",turtleBars:5},
        ]},
        // R2: SL模式
        {round:2,change:"SL模式: 4H Low vs Sweep极值 vs 混合",cfgs:[
            {...base,name:"SL=4hLow",slMode:"4hLow",turtleBars:3},
            {...base,name:"SL=sweep",slMode:"sweep",turtleBars:3},
            {...base,name:"SL=hybrid",slMode:"hybrid",turtleBars:3},
        ]},
        // R3: TP倍数
        {round:3,change:"TP 盈亏比: 1.5R vs 2R vs 3R",cfgs:[
            {...base,name:"TP=1.5R",turtleBars:3,tpR:1.5},
            {...base,name:"TP=2.0R",turtleBars:3,tpR:2.0},
            {...base,name:"TP=3.0R",turtleBars:3,tpR:3.0},
        ]},
        // R4: 实体占比门槛
        {round:4,change:"Fire Candle 实体占比: 30% vs 40% vs 50% vs 60%",cfgs:[
            {...base,name:"Body≥30%",turtleBars:3,minBodyR:0.3},
            {...base,name:"Body≥40%",turtleBars:3,minBodyR:0.4},
            {...base,name:"Body≥50%",turtleBars:3,minBodyR:0.5},
            {...base,name:"Body≥60%",turtleBars:3,minBodyR:0.6},
        ]},
        // R5: 追踪止盈
        {round:5,change:"追踪止盈: 无 vs 10pt vs 15pt vs 20pt",cfgs:[
            {...base,name:"无追踪",turtleBars:3},
            {...base,name:"Trail=10pt",turtleBars:3,useTrail:true,trailPt:10},
            {...base,name:"Trail=15pt",turtleBars:3,useTrail:true,trailPt:15},
            {...base,name:"Trail=20pt",turtleBars:3,useTrail:true,trailPt:20},
        ]},
        // R6: 交易窗口宽度
        {round:6,change:"交易窗口: 12-18 vs 12-20 vs 12-22 vs 10-22",cfgs:[
            {...base,name:"12-18 UTC",turtleBars:3,tS:12,tE:18},
            {...base,name:"12-20 UTC",turtleBars:3,tS:12,tE:20},
            {...base,name:"12-22 UTC",turtleBars:3,tS:12,tE:22},
            {...base,name:"10-22 UTC",turtleBars:3,tS:10,tE:22},
        ]},
        // R7: Fire Candle 时间窗口
        {round:7,change:"Fire窗口: 4-8 vs 6-10 vs 8-12 vs 10-14 UTC",cfgs:[
            {...base,name:"FC=04-08",turtleBars:3,fS:4,fE:8,tS:8,tE:22},
            {...base,name:"FC=06-10",turtleBars:3,fS:6,fE:10,tS:10,tE:22},
            {...base,name:"FC=08-12",turtleBars:3,fS:8,fE:12,tS:12,tE:22},
            {...base,name:"FC=10-14",turtleBars:3,fS:10,fE:14,tS:14,tE:22},
        ]},
        // R8: Midnight Open 过滤
        {round:8,change:"Midnight Open 过滤",cfgs:[
            {...base,name:"无Mid过滤",turtleBars:3},
            {...base,name:"+Mid过滤",turtleBars:3,useMidnight:true},
        ]},
        // R9: 量能过滤
        {round:9,change:"Fire Candle 量能过滤",cfgs:[
            {...base,name:"无Vol过滤",turtleBars:3},
            {...base,name:"+Vol过滤",turtleBars:3,volFilter:true},
        ]},
        // R10: 最大持仓时间
        {round:10,change:"最大持仓: 30bar vs 60bar vs 120bar vs 无限",cfgs:[
            {...base,name:"Hold≤30",turtleBars:3,maxHold:30},
            {...base,name:"Hold≤60",turtleBars:3,maxHold:60},
            {...base,name:"Hold≤120",turtleBars:3,maxHold:120},
            {...base,name:"Hold≤300",turtleBars:3,maxHold:300},
        ]},
    ];

    const bestParams:Record<string,any>={};

    for(const rd of rounds){
        console.log(`\n${"─".repeat(70)}`);
        console.log(`  🔄 Round ${rd.round}: ${rd.change}`);
        console.log(`${"─".repeat(70)}`);

        const results:Res[]=[];
        for(const cfg of rd.cfgs){
            const fires=findFires(kl1h,cfg.fS,cfg.fE,cfg.minBodyR);
            results.push(run(kl5m,fires,1.0,cfg));
        }
        results.sort((a,b)=>b.pnl-a.pnl);

        console.log(`  ${"方案".padEnd(18)} | 笔数 | 胜率  | 净利     | 回撤   | PF`);
        console.log(`  ${"-".repeat(60)}`);
        for(let i=0;i<results.length;i++){
            const r=results[i];
            const mark=i===0?" 🏆":"";
            console.log(
                `  ${r.cfg.name.padEnd(18)} | ${String(r.trades).padStart(4)} | ${r.wr.toFixed(0).padStart(4)}% | $${(r.pnl>=0?"+":"")+r.pnl.toFixed(0).padStart(6)} | $${r.dd.toFixed(0).padStart(5)} | ${r.pf.toFixed(2)}${mark}`
            );
        }
        const best=results[0];
        console.log(`  → 冠军: ${best.cfg.name} (+$${best.pnl.toFixed(0)})`);
    }

    // ═══ 最终组合: 取每轮冠军参数合体 ═══
    console.log(`\n${"═".repeat(70)}`);
    console.log(`  🏆 最终合体: 取 10 轮各自最佳参数`);
    console.log(`${"═".repeat(70)}`);

    // 手动组合最佳 (基于运行结果)
    const finalConfigs:Cfg[]=[
        // V2 原版 (基线对比)
        {...base,name:"V2 原版 基线"},
        // 保守组合: TS3 + 4hLow + 2R + Body40 + 无Trail + 12-22
        {...base,name:"保守组合",turtleBars:3,slMode:"4hLow",tpR:2,minBodyR:0.4,useTrail:false,tS:12,tE:22,maxHold:120},
        // 激进组合: TS5 + hybrid + 3R + Body30 + Trail15 + 10-22
        {...base,name:"激进组合",turtleBars:5,slMode:"hybrid",tpR:3,minBodyR:0.3,useTrail:true,trailPt:15,tS:10,tE:22,maxHold:300},
        // 平衡组合: TS3 + 4hLow + 2R + Body40 + Trail15 + 12-20
        {...base,name:"平衡组合",turtleBars:3,slMode:"4hLow",tpR:2,minBodyR:0.4,useTrail:true,trailPt:15,tS:12,tE:20,maxHold:120},
    ];

    console.log(`  ${"方案".padEnd(18)} | 笔数 | 胜率  | 净利     | 回撤   | PF     | 月度`);
    console.log(`  ${"-".repeat(80)}`);
    for(const cfg of finalConfigs){
        const fires=findFires(kl1h,cfg.fS,cfg.fE,cfg.minBodyR);
        const res=run(kl5m,fires,1.0,cfg);
        const mark=res.pnl>200?" 🏆":res.pnl>0?" ✅":"";
        const ms=Object.entries(res.months).sort().map(([m,v])=>`${m.slice(5)}:${v>=0?"+":""}${v.toFixed(0)}`).join(" | ");
        console.log(
            `  ${cfg.name.padEnd(18)} | ${String(res.trades).padStart(4)} | ${res.wr.toFixed(0).padStart(4)}% | $${(res.pnl>=0?"+":"")+res.pnl.toFixed(0).padStart(6)} | $${res.dd.toFixed(0).padStart(5)} | ${res.pf.toFixed(2).padStart(5)}  | ${ms}${mark}`
        );
    }

    console.log(`\n${"═".repeat(70)}\n`);
}

main().catch(console.error);
export {};
