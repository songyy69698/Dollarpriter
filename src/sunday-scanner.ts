/**
 * 🧠 周日策略判断器 — 每周日/周一早上跑一次
 * ═══════════════════════════════════════════════════════
 * 分析过去7天的市场数据，推荐本周策略模式:
 *   - 趋势方向 (做多 / 做空 / 双向)
 *   - 波动水平 (高波→Mom12可能触发 / 低波→少做或不做)
 *   - 成交量活跃度
 *   - 本周推荐
 *
 * 用法: bun run src/sunday-scanner.ts
 */

const BINANCE = "https://api.binance.com";

async function fetchK(symbol: string, interval: string, s: number, e: number) {
    const a: any[] = []; let c = s;
    while (c < e) {
        const r = await fetch(`${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${c}&endTime=${e}&limit=1500`);
        const d = (await r.json()) as any[][]; if (!d.length) break;
        for (const k of d) a.push({ ts: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
        c = (d[d.length - 1][6] as number) + 1;
        await Bun.sleep(100);
    }
    return a;
}

async function main() {
    const now = Date.now();
    const utc8 = new Date(now + 8 * 3600000);
    const dayName = ["日", "一", "二", "三", "四", "五", "六"][utc8.getUTCDay()];

    console.log("═══════════════════════════════════════════════════════════");
    console.log(`  🧠 周${dayName}策略判断器 | ${utc8.toISOString().slice(0, 10)} ${utc8.toISOString().slice(11, 16)} UTC+8`);
    console.log("═══════════════════════════════════════════════════════════\n");

    // ═══ 拉数据 ═══
    const d7 = now - 7 * 24 * 3600000;   // 过去7天
    const d14 = now - 14 * 24 * 3600000; // 过去14天(对比用)

    const [k1h, k5m_7d] = await Promise.all([
        fetchK("ETHUSDT", "1h", d14, now),
        fetchK("ETHUSDT", "5m", d7, now),
    ]);
    console.log(`📥 1h: ${k1h.length}根 | 5m: ${k5m_7d.length}根\n`);

    // ═══ 1. 趋势分析 ═══
    const last7d = k1h.filter(k => k.ts >= d7);
    const prev7d = k1h.filter(k => k.ts >= d14 && k.ts < d7);

    const thisWeekOpen = last7d[0]?.o || 0;
    const thisWeekClose = last7d[last7d.length - 1]?.c || 0;
    const thisWeekHi = Math.max(...last7d.map((k: any) => k.h));
    const thisWeekLo = Math.min(...last7d.map((k: any) => k.l));
    const thisWeekChg = ((thisWeekClose - thisWeekOpen) / thisWeekOpen * 100);
    const thisWeekRange = thisWeekHi - thisWeekLo;

    const prevWeekOpen = prev7d.length > 0 ? prev7d[0].o : thisWeekOpen;
    const prevWeekClose = prev7d.length > 0 ? prev7d[prev7d.length - 1].c : thisWeekOpen;
    const prevWeekChg = prev7d.length > 0 ? ((prevWeekClose - prevWeekOpen) / prevWeekOpen * 100) : 0;

    console.log("── 📈 趋势分析 ──");
    console.log(`  上周: $${prevWeekOpen.toFixed(0)} → $${prevWeekClose.toFixed(0)} (${prevWeekChg >= 0 ? "+" : ""}${prevWeekChg.toFixed(1)}%)`);
    console.log(`  本周: $${thisWeekOpen.toFixed(0)} → $${thisWeekClose.toFixed(0)} (${thisWeekChg >= 0 ? "+" : ""}${thisWeekChg.toFixed(1)}%) 振幅$${thisWeekRange.toFixed(0)}`);

    const sameDir = (thisWeekChg > 0 && prevWeekChg > 0) || (thisWeekChg < 0 && prevWeekChg < 0);
    console.log(`  惯性: ${sameDir ? "📈 同向延续" : "🔄 方向反转"}`);

    // EMA20/50 on 1h
    const closes = k1h.map((k: any) => k.c);
    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);
    const price = thisWeekClose;
    const aboveEma20 = price > ema20;
    const aboveEma50 = price > ema50;
    const ema20Above50 = ema20 > ema50;

    console.log(`  EMA20=$${ema20.toFixed(0)} EMA50=$${ema50.toFixed(0)} 价=$${price.toFixed(0)}`);
    console.log(`  ${aboveEma20 ? "价>EMA20 📈" : "价<EMA20 📉"} | ${aboveEma50 ? "价>EMA50 📈" : "价<EMA50 📉"} | ${ema20Above50 ? "EMA20>50 📈" : "EMA20<50 📉"}`);

    // ═══ 2. 波动率 ═══
    console.log("\n── 📊 波动率分析 ──");
    const atr14_1h = calcATR(k1h, 14);
    const atr14_5m = calcATR(k5m_7d, 14);
    const avgDailyRange = thisWeekRange / 7;

    console.log(`  ATR14(1h): $${atr14_1h.toFixed(1)} | ATR14(5m): $${atr14_5m.toFixed(1)}`);
    console.log(`  日均振幅: $${avgDailyRange.toFixed(0)}`);

    const highVol = atr14_1h > 40 || avgDailyRange > 80;
    const lowVol = atr14_1h < 15 && avgDailyRange < 30;
    console.log(`  判断: ${highVol ? "🔥 高波动 → Mom12容易触发" : lowVol ? "😴 低波动 → 信号少" : "📊 中等波动"}`);

    // ═══ 3. 成交量 ═══
    console.log("\n── 📊 成交量分析 ──");
    const vols = k5m_7d.map((k: any) => k.v);
    const avgVol = vols.reduce((a: number, b: number) => a + b, 0) / vols.length;
    const recentVols = vols.slice(-48); // 最近4小时
    const recentAvgVol = recentVols.reduce((a: number, b: number) => a + b, 0) / recentVols.length;
    const volTrend = recentAvgVol / avgVol;

    console.log(`  7天均量: ${avgVol.toFixed(0)} | 近4h均量: ${recentAvgVol.toFixed(0)} (${volTrend.toFixed(1)}x)`);
    console.log(`  ${volTrend > 1.5 ? "📈 放量中" : volTrend < 0.5 ? "📉 缩量中" : "➡️ 正常"}`);

    // ═══ 4. 窗口分析 (过去7天) ═══
    console.log("\n── ⏰ 窗口表现 (过去7天) ──");
    const WINS = [{ n: "08", s: 8, e: 9 }, { n: "15", s: 15, e: 16 }, { n: "22", s: 22, e: 23 }];
    for (const w of WINS) {
        let ups = 0, downs = 0, totalRange = 0, count = 0;
        let curD = "", openP = 0, hiP = 0, loP = 99999;

        for (const k of k5m_7d) {
            const u = new Date(k.ts + 8 * 3600000);
            const h = u.getUTCHours();
            if (h < w.s || h >= w.e) continue;
            const d = u.toISOString().slice(0, 10);
            if (d !== curD) {
                if (curD && openP > 0) {
                    const lastC = k5m_7d.filter((kk: any) => {
                        const uu = new Date(kk.ts + 8 * 3600000);
                        return uu.toISOString().slice(0, 10) === curD && uu.getUTCHours() >= w.s && uu.getUTCHours() < w.e;
                    });
                    if (lastC.length > 0) {
                        const closeP = lastC[lastC.length - 1].c;
                        if (closeP > openP) ups++; else downs++;
                        totalRange += hiP - loP;
                        count++;
                    }
                }
                curD = d; openP = k.o; hiP = k.h; loP = k.l;
            }
            if (k.h > hiP) hiP = k.h;
            if (k.l < loP) loP = k.l;
        }

        const avgR = count > 0 ? totalRange / count : 0;
        const bias = ups > downs ? "偏多📈" : downs > ups ? "偏空📉" : "中性➡️";
        console.log(`  ${w.n}窗口: 涨${ups}/跌${downs} | 均振幅${avgR.toFixed(0)}pt | ${bias}`);
    }

    // ═══ 5. RSI 位置 ═══
    const rsi14 = calcRSI(closes, 14);
    console.log(`\n── RSI ──`);
    console.log(`  RSI14(1h): ${rsi14.toFixed(0)} ${rsi14 < 30 ? "🟢超卖" : rsi14 > 70 ? "🔴超买" : rsi14 < 40 ? "偏低" : rsi14 > 60 ? "偏高" : "中性"}`);

    // ═══ 6. 综合推荐 ═══
    console.log("\n══════════════════════════════════════════════════════");
    console.log("  🎯 本周策略推荐");
    console.log("══════════════════════════════════════════════════════\n");

    // 趋势得分
    let bullScore = 0, bearScore = 0;
    if (thisWeekChg > 2) bullScore += 2;
    if (thisWeekChg < -2) bearScore += 2;
    if (aboveEma20) bullScore++; else bearScore++;
    if (aboveEma50) bullScore++; else bearScore++;
    if (ema20Above50) bullScore++; else bearScore++;
    if (rsi14 < 35) bullScore++; // 超卖=反弹机会
    if (rsi14 > 65) bearScore++; // 超买=回调机会

    const trendBias = bullScore > bearScore + 1 ? "LONG" :
        bearScore > bullScore + 1 ? "SHORT" : "BOTH";

    console.log(`  趋势偏向: ${trendBias === "LONG" ? "📈 做多" : trendBias === "SHORT" ? "📉 做空" : "↔️ 双向"} (多${bullScore}/空${bearScore})`);
    console.log(`  波动等级: ${highVol ? "🔥高 → Mom12大概率触发" : lowVol ? "😴低 → 少做单" : "📊中 → 正常节奏"}`);

    // 策略推荐
    if (highVol) {
        console.log(`\n  ✅ 推荐: Mom12>40 + ${trendBias === "LONG" ? "只做多" : trendBias === "SHORT" ? "只做空" : "双向"}`);
        console.log(`     原因: 高波动期，Mom12容易触发(ATR=${atr14_1h.toFixed(0)}, 日振=$${avgDailyRange.toFixed(0)})`);
        console.log(`     窗口: 三窗口全开`);
        console.log(`     预期: 本周有2-3次交易机会`);
    } else if (lowVol) {
        console.log(`\n  ⚠️ 推荐: 暂停交易或最小仓位`);
        console.log(`     原因: 低波动期，信号质量差(ATR=${atr14_1h.toFixed(0)}, 日振=$${avgDailyRange.toFixed(0)})`);
        console.log(`     预期: 本周可能0-1次机会`);
    } else {
        console.log(`\n  📊 推荐: Mom12>40 保持运行 + ${trendBias === "LONG" ? "偏做多" : trendBias === "SHORT" ? "偏做空" : "双向"}`);
        console.log(`     原因: 中等波动，保持耐心等信号`);
        console.log(`     预期: 本周可能1-2次机会`);
    }

    // 操作清单
    console.log(`\n  ─── 操作清单 ───`);
    console.log(`  1. Bot保持${highVol || !lowVol ? "🟢运行" : "🔴暂停"}`);
    console.log(`  2. 方向: ${trendBias === "LONG" ? "只接受做多信号" : trendBias === "SHORT" ? "只接受做空信号" : "多空都接受"}`);
    console.log(`  3. 仓位: $${lowVol ? "30(减仓)" : highVol ? "50(标准)" : "50(标准)"}/单`);
    console.log(`  4. 下次判断: 下周日/周一早上再跑本工具`);
}

function ema(data: number[], period: number): number {
    if (data.length < period) return data[data.length - 1] || 0;
    let e = data.slice(0, period).reduce((a, b) => a + b) / period;
    const m = 2 / (period + 1);
    for (let i = period; i < data.length; i++) e = data[i] * m + e * (1 - m);
    return e;
}

function calcATR(kl: any[], period: number): number {
    const n = kl.length;
    if (n < period) return 0;
    let s = 0;
    for (let i = n - period; i < n; i++) s += kl[i].h - kl[i].l;
    return s / period;
}

function calcRSI(closes: number[], period: number): number {
    const n = closes.length;
    if (n < period + 1) return 50;
    let g = 0, l = 0;
    for (let i = n - period; i < n; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) g += d; else l += -d;
    }
    const ag = g / period, al = l / period;
    return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

main().catch(console.error);
