/**
 * 🧪 四大策略对比回测
 * ═══════════════════════════════════════
 * Plan A: 4H裸K (第一根4H K线H/L突破→回踩→反转)
 * Plan B: 三重TF+堡垒 (15m范围→5m突破+堡垒→EMA/CCI确认)
 * Plan C: 订单流增强 (Plan A + 模拟大单Delta过滤)
 * Plan D: AI多滤 (SuperTrend + EMA + MACD + ADX + 量)
 * ═══════════════════════════════════════
 * ETHUSDT | $500 | 150x | 2026.01-03
 */

const LEV=150, FEE=0.0004, CAP=500, QTY=1.0;
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

// ══════ 通用指标 ══════
function ema(c:number[],p:number):number{
    if(c.length<p) return c[c.length-1]||0;
    let e=c.slice(0,p).reduce((a,b)=>a+b)/p; const m=2/(p+1);
    for(let i=p;i<c.length;i++) e=c[i]*m+e*(1-m); return e;
}
function rsiCalc(c:number[],p=14):number{
    if(c.length<p+1)return 50; let g=0,l=0;
    for(let i=c.length-p;i<c.length;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l+=-d;}
    const ag=g/p,al=l/p; return al===0?100:100-100/(1+ag/al);
}
function atrCalc(kl:K[],p=14):number{
    if(kl.length<p)return 0; let s=0;
    for(let i=kl.length-p;i<kl.length;i++){
        const tr=Math.max(kl[i].h-kl[i].l, i>0?Math.abs(kl[i].h-kl[i-1].c):0, i>0?Math.abs(kl[i].l-kl[i-1].c):0);
        s+=tr;
    }
    return s/p;
}
// CCI = (TP - SMA(TP)) / (0.015 × mean deviation)
function cciCalc(kl:K[],p=20):number{
    if(kl.length<p) return 0;
    const tps=kl.slice(-p).map(k=>(k.h+k.l+k.c)/3);
    const sma=tps.reduce((a,b)=>a+b)/p;
    const md=tps.reduce((a,b)=>a+Math.abs(b-sma),0)/p;
    return md===0?0:(tps[tps.length-1]-sma)/(0.015*md);
}
// SuperTrend (简化版)
function superTrend(kl:K[],p=10,mult=3):{up:boolean;val:number}{
    const a=atrCalc(kl,p); const k=kl[kl.length-1];
    const mid=(k.h+k.l)/2;
    const upper=mid+mult*a, lower=mid-mult*a;
    return k.c>mid?{up:true,val:lower}:{up:false,val:upper};
}
// MACD
function macd(c:number[]):{macd:number;signal:number;hist:number}{
    const e12=ema(c,12),e26=ema(c,26); const m=e12-e26;
    // 简化: signal ≈ EMA9 of recent closes' MACD
    const sig=m*0.8; // 近似
    return {macd:m,signal:sig,hist:m-sig};
}
// ADX 简化
function adxCalc(kl:K[],p=14):number{
    if(kl.length<p+1) return 25;
    let pdm=0,ndm=0,tr=0;
    for(let i=kl.length-p;i<kl.length;i++){
        const up=kl[i].h-kl[i-1].h, dn=kl[i-1].l-kl[i].l;
        pdm+=(up>dn&&up>0)?up:0; ndm+=(dn>up&&dn>0)?dn:0;
        tr+=Math.max(kl[i].h-kl[i].l,Math.abs(kl[i].h-kl[i-1].c),Math.abs(kl[i].l-kl[i-1].c));
    }
    if(tr===0) return 0;
    const pdi=pdm/tr*100, ndi=ndm/tr*100;
    const dx=Math.abs(pdi-ndi)/(pdi+ndi||1)*100;
    return dx;
}

// ══════ 交易引擎 ══════
interface Pos{s:"long"|"short";e:number;sl:number;tp:number;i:number;best:number;}
interface Res{name:string;trades:number;wins:number;pnl:number;wr:number;avgPt:number;dd:number;pf:number;
    months:Record<string,number>;longs:number;shorts:number;}

function engine(kl5m:K[], signals:{i:number;s:"long"|"short";sl:number;tp:number}[], name:string, useTrail=false):Res{
    let bal=CAP,pos:Pos|null=null;
    let trades=0,ws=0,net=0,longs=0,shorts=0;
    const wp:number[]=[],lp:number[]=[];
    let maxB=CAP,maxDD=0;
    const months:Record<string,number>={};
    let curD="",dT=0,dP=0;

    // 按索引排信号
    const sigMap=new Map<number,typeof signals[0]>();
    for(const s of signals) sigMap.set(s.i,s);

    for(let i=0;i<kl5m.length;i++){
        const k=kl5m[i];
        const d=new Date(k.ts+8*3600000).toISOString().slice(0,10);
        const mon=d.slice(0,7);
        if(d!==curD){curD=d;dT=0;dP=0;}

        if(pos){
            const pt=pos.s==="long"?k.c-pos.e:pos.e-k.c;
            const wst=pos.s==="long"?k.l:k.h;
            if(pt>pos.best) pos.best=pt;

            let closed=false,ep=k.c;
            // SL hit
            if(pos.s==="long"&&wst<=pos.sl){closed=true;ep=pos.sl;}
            if(pos.s==="short"&&wst>=pos.sl){closed=true;ep=pos.sl;}
            // TP hit
            if(!closed){
                if(pos.s==="long"&&k.h>=pos.tp){closed=true;ep=pos.tp;}
                if(pos.s==="short"&&k.l<=pos.tp){closed=true;ep=pos.tp;}
            }
            // Trailing (Plan B &D)
            if(!closed&&useTrail&&pos.best>10){
                const trail=pos.s==="long"?pos.e+pos.best-8:pos.e-pos.best+8;
                if((pos.s==="long"&&k.c<=trail)||(pos.s==="short"&&k.c>=trail)){closed=true;ep=k.c;}
            }
            // 超时 3小时
            if(!closed&&i-pos.i>=36){closed=true;ep=k.c;}

            if(closed){
                const rpt=pos.s==="long"?ep-pos.e:pos.e-ep;
                const fee=(pos.e*QTY+ep*QTY)*FEE; const n=rpt*QTY-fee;
                bal+=n;trades++;dT++;dP+=n;net+=n;
                months[mon]=(months[mon]||0)+n;
                if(n>0){ws++;wp.push(n);}else lp.push(n);
                if(bal>maxB)maxB=bal; const dd=maxB-bal; if(dd>maxDD)maxDD=dd;
                pos=null;
            }
            continue;
        }

        if(dT>=4||dP<=-150||bal<50) continue;
        const sig=sigMap.get(i);
        if(!sig) continue;

        if(sig.s==="long") longs++; else shorts++;
        pos={s:sig.s,e:k.c,sl:sig.sl,tp:sig.tp,i,best:0};
    }
    // 收尾
    if(pos){
        const lk=kl5m[kl5m.length-1]; const pt=pos.s==="long"?lk.c-pos.e:pos.e-lk.c;
        const fee=(pos.e*QTY+lk.c*QTY)*FEE; const n=pt*QTY-fee;
        bal+=n;trades++;net+=n; if(n>0){ws++;wp.push(n);}else lp.push(n);
    }
    const tW=wp.reduce((a,b)=>a+b,0),tL=Math.abs(lp.reduce((a,b)=>a+b,0));
    return{name,trades,wins:ws,pnl:net,wr:trades>0?ws/trades*100:0,
        avgPt:trades>0?net/trades:0,dd:maxDD,pf:tL>0?tW/tL:999,months,longs,shorts};
}

// ══════ Plan A: 4H裸K ══════
function planA(kl5m:K[],kl4h:K[]):{i:number;s:"long"|"short";sl:number;tp:number}[]{
    const signals:ReturnType<typeof planA>=[];
    // 为每个交易日找第一根4H K线
    const dayMap=new Map<string,K>();
    for(const k of kl4h){
        const d=new Date(k.ts+8*3600000).toISOString().slice(0,10);
        if(!dayMap.has(d)) dayMap.set(d,k);
    }

    for(let i=20;i<kl5m.length;i++){
        const k=kl5m[i];
        const u8=new Date(k.ts+8*3600000);
        const d=u8.toISOString().slice(0,10);
        const h=u8.getUTCHours();

        // 只在 16-23时段交易 (亚盘后)
        if(h<16||h>23) continue;

        const ref=dayMap.get(d);
        if(!ref) continue;

        const H=ref.h, L=ref.l, range=H-L;
        if(range<5) continue; // 太小没意义

        // 四分位
        const q25=L+range*0.25, q75=L+range*0.75;

        // 突破 H 后回踩到 q75 以下 = 做空 (counter-trade)
        const prev5=kl5m.slice(Math.max(0,i-6),i);
        const prevHit=prev5.some(p=>p.h>H); // 前面突破过H
        if(prevHit && k.c<q75 && k.c>L){
            const sl=H+range*0.1; // SL在极值上方
            const tp=k.c-(sl-k.c)*2; // TP=SL×2
            if(tp>L-range*0.5){ // 合理范围
                signals.push({i,s:"short",sl,tp});
                continue;
            }
        }

        // 跌破 L 后回踩到 q25 以上 = 做多 (counter-trade)
        const prevBreak=prev5.some(p=>p.l<L);
        if(prevBreak && k.c>q25 && k.c<H){
            const sl=L-range*0.1;
            const tp=k.c+(k.c-sl)*2;
            if(tp<H+range*0.5){
                signals.push({i,s:"long",sl,tp});
                continue;
            }
        }
    }
    return signals;
}

// ══════ Plan B: 三重TF+堡垒 ══════
function planB(kl5m:K[],kl15m:K[]):{i:number;s:"long"|"short";sl:number;tp:number}[]{
    const signals:ReturnType<typeof planB>=[];

    for(let i=40;i<kl5m.length;i++){
        const k=kl5m[i];
        const u8=new Date(k.ts+8*3600000);
        const h=u8.getUTCHours();
        if(h<8||h>23) continue;

        // 1. 15m range: 找最近3根15m的范围
        const ts=k.ts;
        const r15=kl15m.filter(x=>x.ts<=ts).slice(-3);
        if(r15.length<3) continue;
        const rangeH=Math.max(...r15.map(x=>x.h));
        const rangeL=Math.min(...r15.map(x=>x.l));
        const range=rangeH-rangeL;
        if(range<3||range>80) continue;

        // 2. 5m breakout: 价格突破15m range
        const prev3=kl5m.slice(Math.max(0,i-3),i);
        const wasInside=prev3.every(p=>p.c<=rangeH && p.c>=rangeL);

        // 3. EMA确认
        const closes=kl5m.slice(Math.max(0,i-50),i+1).map(x=>x.c);
        const ema9=ema(closes,9), ema21=ema(closes,21);

        // 4. CCI确认
        const recentK=kl5m.slice(Math.max(0,i-25),i+1);
        const cci=cciCalc(recentK);

        // 5. Volume确认
        const vols=kl5m.slice(Math.max(0,i-20),i).map(x=>x.v);
        const avgVol=vols.reduce((a,b)=>a+b,0)/vols.length;

        // 做多: 突破上沿 + EMA9>EMA21 + CCI>0 + 放量
        if(wasInside && k.c>rangeH && ema9>ema21 && cci>0 && k.v>avgVol*1.2){
            const fortress=rangeH; // 堡垒 = 突破位
            const sl=rangeL-1; // SL = 范围底部
            const slDist=k.c-sl;
            const tp=k.c+slDist*2;
            signals.push({i,s:"long",sl,tp});
            continue;
        }

        // 做空: 跌破下沿 + EMA9<EMA21 + CCI<0 + 放量
        if(wasInside && k.c<rangeL && ema9<ema21 && cci<0 && k.v>avgVol*1.2){
            const sl=rangeH+1;
            const slDist=sl-k.c;
            const tp=k.c-slDist*2;
            signals.push({i,s:"short",sl,tp});
            continue;
        }
    }
    return signals;
}

// ══════ Plan C: 订单流增强 (Plan A + Delta过滤) ══════
function planC(kl5m:K[],kl4h:K[]):{i:number;s:"long"|"short";sl:number;tp:number}[]{
    const baseSignals=planA(kl5m,kl4h);
    const filtered:typeof baseSignals=[];

    for(const sig of baseSignals){
        const k=kl5m[sig.i];
        // 模拟 Delta: 用 taker buy ratio 推算
        // 上涨K线 close>open → 买方主导
        const recent=kl5m.slice(Math.max(0,sig.i-10),sig.i+1);
        let buyVol=0,sellVol=0;
        for(const r of recent){
            if(r.c>=r.o) buyVol+=r.v*(r.c-r.l)/(r.h-r.l||1);
            else sellVol+=r.v*(r.h-r.c)/(r.h-r.l||1);
        }
        const delta=buyVol-sellVol;
        const totalVol=recent.reduce((a,b)=>a+b.v,0);
        const deltaRatio=totalVol>0?Math.abs(delta)/totalVol:0;

        // Delta 需与信号方向一致且强度>30%
        if(sig.s==="long" && delta>0 && deltaRatio>0.3) filtered.push(sig);
        if(sig.s==="short" && delta<0 && deltaRatio>0.3) filtered.push(sig);
    }
    return filtered;
}

// ══════ Plan D: AI多滤 ══════
function planD(kl5m:K[]):{i:number;s:"long"|"short";sl:number;tp:number}[]{
    const signals:ReturnType<typeof planD>=[];

    for(let i=60;i<kl5m.length;i++){
        const k=kl5m[i];
        const u8=new Date(k.ts+8*3600000);
        const h=u8.getUTCHours();
        if(h<8||h>23) continue;

        const recentK=kl5m.slice(Math.max(0,i-60),i+1);
        const closes=recentK.map(x=>x.c);

        // 1. SuperTrend
        const st=superTrend(recentK);

        // 2. EMA 交叉
        const ema9=ema(closes,9), ema21=ema(closes,21);

        // 3. MACD
        const mc=macd(closes);

        // 4. ADX (趋势强度)
        const adx=adxCalc(recentK);
        if(adx<20) continue; // 趋势不够强

        // 5. Delta Volume >30%
        const vols=kl5m.slice(Math.max(0,i-10),i+1);
        let buyV=0,sellV=0;
        for(const v of vols){
            if(v.c>=v.o) buyV+=v.v; else sellV+=v.v;
        }
        const totalV=buyV+sellV;
        const dRatio=totalV>0?Math.abs(buyV-sellV)/totalV:0;
        if(dRatio<0.3) continue;

        const a=atrCalc(recentK);
        if(a<3) continue;

        // 做多: ST看多 + EMA9>21 + MACD>0 + ADX>20 + 买方>30%
        if(st.up && ema9>ema21 && mc.hist>0 && buyV>sellV){
            const sl=k.c-a*2;
            const tp=k.c+a*4;
            signals.push({i,s:"long",sl,tp});
            continue;
        }

        // 做空: ST看空 + EMA9<21 + MACD<0 + ADX>20 + 卖方>30%
        if(!st.up && ema9<ema21 && mc.hist<0 && sellV>buyV){
            const sl=k.c+a*2;
            const tp=k.c-a*4;
            signals.push({i,s:"short",sl,tp});
            continue;
        }
    }
    return signals;
}

// ══════ 主程序 ══════
async function main(){
    console.log("═══════════════════════════════════════════════════════════");
    console.log("  🧪 四大策略对比回测 — Plan A / B / C / D");
    console.log("  $500 | 150x | 1 ETH | ETHUSDT | 2026.01-03");
    console.log("═══════════════════════════════════════════════════════════\n");

    const sMs=new Date("2026-01-01T00:00:00Z").getTime();
    const eMs=new Date("2026-03-21T00:00:00Z").getTime();

    console.log("📥 拉取数据...");
    const kl5m=await fetchK("ETHUSDT","5m",sMs,eMs);
    console.log(`  5m: ${kl5m.length}根`);
    const kl4h=await fetchK("ETHUSDT","4h",sMs-7*86400000,eMs);
    console.log(`  4h: ${kl4h.length}根`);
    const kl15m=await fetchK("ETHUSDT","15m",sMs,eMs);
    console.log(`  15m: ${kl15m.length}根`);

    // ═══ 生成信号 ═══
    console.log("\n🔬 生成信号...");
    const sigA=planA(kl5m,kl4h); console.log(`  Plan A: ${sigA.length} 个信号`);
    const sigB=planB(kl5m,kl15m); console.log(`  Plan B: ${sigB.length} 个信号`);
    const sigC=planC(kl5m,kl4h); console.log(`  Plan C: ${sigC.length} 个信号`);
    const sigD=planD(kl5m); console.log(`  Plan D: ${sigD.length} 个信号`);

    // ═══ 去重: 每日最多1信号/策略 ═══
    function dedup(sigs:typeof sigA){
        const seen=new Set<string>(); const out:typeof sigA=[];
        for(const s of sigs){
            const d=new Date(kl5m[s.i].ts+8*3600000).toISOString().slice(0,10);
            const key=`${d}_${s.s}`;
            if(seen.has(key)) continue; seen.add(key); out.push(s);
        }
        return out;
    }

    const dA=dedup(sigA), dB=dedup(sigB), dC=dedup(sigC), dD=dedup(sigD);

    // ═══ 运行引擎 ═══
    console.log("\n🏃 运行回测...");
    const rA=engine(kl5m,dA,"Plan A: 4H裸K",false);
    const rB=engine(kl5m,dB,"Plan B: 三重TF+堡垒",true);
    const rC=engine(kl5m,dC,"Plan C: 订单流增强",false);
    const rD=engine(kl5m,dD,"Plan D: AI多滤",true);

    const all=[rA,rB,rC,rD].sort((a,b)=>b.pnl-a.pnl);

    // ═══ 输出 ═══
    console.log("\n═══════════════════════════════════════════════════════════════════════════════════");
    console.log("  📊 四大策略对比结果 (按净利排序)");
    console.log("═══════════════════════════════════════════════════════════════════════════════════");
    console.log("   # | 策略                    | 笔数 | 多/空  | 胜率   | 净利     | 均盈亏  | 回撤   | PF");
    console.log("  "+"-".repeat(95));

    for(let i=0;i<all.length;i++){
        const r=all[i];
        const mark=i===0?" 🏆":"";
        console.log(
            `  ${String(i+1).padStart(2)} | ${r.name.padEnd(23)} | ${String(r.trades).padStart(4)} | ${r.longs}L/${r.shorts}S | `+
            `${r.wr.toFixed(0).padStart(4)}%  | $${(r.pnl>=0?"+":"")+r.pnl.toFixed(0).padStart(6)} | $${r.avgPt.toFixed(1).padStart(5)} | `+
            `$${r.dd.toFixed(0).padStart(5)} | ${r.pf.toFixed(2)}${mark}`
        );
    }

    // ═══ 每策略月度明细 ═══
    console.log("\n═══════════════════════════════════════════════════════════════════════════════════");
    console.log("  📅 月度明细");
    console.log("═══════════════════════════════════════════════════════════════════════════════════");

    for(const r of all){
        console.log(`\n  ${r.name}:`);
        const ms=Object.keys(r.months).sort();
        for(const m of ms){
            const v=r.months[m];
            const icon=v>=0?"🟢":"🔴";
            console.log(`    ${m}: ${v>=0?"+":""}$${v.toFixed(0).padStart(6)} ${icon}`);
        }
        if(!ms.length) console.log("    (无交易)");
    }

    // ═══ 最终资金对比 ═══
    console.log("\n═══════════════════════════════════════════════════════════════════════════════════");
    console.log("  💰 最终资金对比 (初始 $500)");
    console.log("═══════════════════════════════════════════════════════════════════════════════════");
    for(const r of all){
        const final=CAP+r.pnl;
        const roi=(r.pnl/CAP*100).toFixed(1);
        const bar=r.pnl>=0?"█".repeat(Math.min(Math.floor(r.pnl/5),40)):"▒".repeat(Math.min(Math.floor(-r.pnl/5),40));
        console.log(`  ${r.name.padEnd(25)} → $${final.toFixed(0).padStart(5)} (${r.pnl>=0?"+":""}${roi}%) ${r.pnl>=0?"🟢":"🔴"} ${bar}`);
    }

    console.log("\n═══════════════════════════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
export {};
