/**
 * 🔍 赢单入场逻辑反推器
 * ═══════════════════════════════════════════════════════
 * 拉取每笔盈利交易入场时刻的 K 线，分析入场前的指标状态
 * 用法: bun src/reverse-signal.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const BITUNIX_BASE = "https://fapi.bitunix.com";
const API_KEY = process.env.BITUNIX_API_KEY || "";
const SECRET_KEY = process.env.BITUNIX_SECRET_KEY || "";

const DATA_DIR = join(process.cwd(), "data");
const REPORT_FILE = join(DATA_DIR, "analysis-report.json");
const OUTPUT_FILE = join(DATA_DIR, "signal-patterns.json");

// ═══ 签名 ═══
function sign(queryParams = ""): Record<string, string> {
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const timestamp = Date.now().toString();
    const digestInput = nonce + timestamp + API_KEY + queryParams;
    const digest = new Bun.CryptoHasher("sha256").update(digestInput).digest("hex");
    const signature = new Bun.CryptoHasher("sha256").update(digest + SECRET_KEY).digest("hex");
    return { "api-key": API_KEY, sign: signature, nonce, timestamp };
}

// ═══ 拉取 K 线 ═══
async function fetchKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<any[]> {
    // Bitunix 要求 interval 格式为 "5m" 而非 "5"
    const params = [
        `endTime${endTime}`,
        `interval${interval}`,
        `startTime${startTime}`,
        `symbol${symbol}`,
    ].sort().join("");

    const headers = sign(params);
    const urlParams = new URLSearchParams({
        symbol, interval,
        startTime: String(startTime),
        endTime: String(endTime),
    });

    const url = `${BITUNIX_BASE}/api/v1/futures/market/kline?${urlParams}`;
    const res = await fetch(url, {
        headers: { ...headers, "Content-Type": "application/json", language: "en-US" },
    });

    let data: any;
    try {
        data = await res.json();
    } catch {
        return [];
    }

    if (String(data?.code) !== "0") return [];
    return (data?.data || []).sort((a: any, b: any) => +a.time - +b.time);
}

// ═══ 指标计算 ═══
function calcEMA(closes: number[], period: number): number {
    if (closes.length < period) return closes[closes.length - 1] || 0;
    let ema = closes.slice(0, period).reduce((a, b) => a + b) / period;
    const m = 2 / (period + 1);
    for (let i = period; i < closes.length; i++) ema = closes[i] * m + ema * (1 - m);
    return ema;
}

function calcATR(klines: { h: number; l: number; c: number }[], period = 14): number {
    if (klines.length < period + 1) return 0;
    let sum = 0;
    for (let i = klines.length - period; i < klines.length; i++) {
        const tr = Math.max(
            klines[i].h - klines[i].l,
            Math.abs(klines[i].h - klines[i - 1]?.c || 0),
            Math.abs(klines[i].l - klines[i - 1]?.c || 0),
        );
        sum += tr;
    }
    return sum / period;
}

function detectPattern(klines: { o: number; h: number; l: number; c: number }[]): string[] {
    const patterns: string[] = [];
    const n = klines.length;
    if (n < 3) return patterns;

    const last = klines[n - 1];
    const prev = klines[n - 2];
    const prev2 = klines[n - 3];

    const lastBody = Math.abs(last.c - last.o);
    const lastRange = last.h - last.l;
    const prevBody = Math.abs(prev.c - prev.o);

    // 长上影线 (做空信号)
    const upperWick = last.h - Math.max(last.o, last.c);
    if (upperWick > lastBody * 2 && lastRange > 0) {
        patterns.push("LONG_UPPER_WICK");
    }

    // 看跌吞没
    if (prev.c > prev.o && last.c < last.o && last.o >= prev.c && last.c <= prev.o) {
        patterns.push("BEARISH_ENGULFING");
    }

    // 连续下跌
    if (last.c < last.o && prev.c < prev.o && prev2.c < prev2.o) {
        patterns.push("THREE_BLACK_CROWS");
    }

    // 放量下跌
    // (需要volume数据)

    // 价格突破EMA下方
    const closes = klines.map(k => k.c);
    const ema20 = calcEMA(closes, 20);
    if (last.c < ema20 && prev.c > ema20) {
        patterns.push("BREAK_BELOW_EMA20");
    }

    // EMA 空头排列 (3 < 7 < 20)
    const ema3 = calcEMA(closes, 3);
    const ema7 = calcEMA(closes, 7);
    if (ema3 < ema7 && ema7 < ema20) {
        patterns.push("EMA_BEARISH_ALIGN");
    }

    // 价格在 EMA20 下方
    if (last.c < ema20) {
        patterns.push("BELOW_EMA20");
    }

    // 大阴线
    if (last.c < last.o && lastBody > lastRange * 0.6) {
        patterns.push("BIG_BEAR_CANDLE");
    }

    return patterns;
}

interface TradeContext {
    tradeDate: string;
    direction: string;
    entryPrice: number;
    exitPrice: number;
    netPnlU: number;
    grossPnlPt: number;
    holdMinutes: number;
    hour: number;
    dayOfWeek: number;
    isBot: boolean;
    // K线分析
    ema3: number;
    ema7: number;
    ema20: number;
    atr14: number;
    priceVsEma20: number;     // 价格相对 EMA20 距离 (pt)
    ema3VsEma7: number;       // EMA3-EMA7 距离
    ema7VsEma20: number;      // EMA7-EMA20 距离
    volRatio: number;          // 入场那根K线量/前20根均量
    priceChangeBeforeEntry: number;  // 入场前30分钟价格变化%
    patterns: string[];        // K线形态
    entryCandle: { o: number; h: number; l: number; c: number } | null;
}

async function main() {
    console.log("═══════════════════════════════════════");
    console.log("  🔍 赢单入场逻辑反推器");
    console.log("═══════════════════════════════════════\n");

    // 读取分析报告
    const report = JSON.parse(readFileSync(REPORT_FILE, "utf-8"));
    const allTrades = report.allTrades as any[];

    // 筛选赢单: netPnlU > 50 (滤掉太小的赢) 且 SHORT 方向
    const bigWins = allTrades
        .filter(t => t.netPnlU > 50 && t.direction === "SHORT")
        .sort((a, b) => b.netPnlU - a.netPnlU);

    console.log(`📊 大额赢单 (SHORT, >$50): ${bigWins.length} 笔`);
    console.log(`   分析前 100 笔（按利润排序）...\n`);

    const samplesToAnalyze = bigWins.slice(0, 100);
    const contexts: TradeContext[] = [];
    let processed = 0;

    for (const trade of samplesToAnalyze) {
        const entryTs = trade.openTs;
        const symbol = "ETHUSDT"; // 所有交易都是ETH

        // 拉取入场前 2 小时的 5m K 线 (24根)
        const klineStart = entryTs - 2 * 3600_000;
        const klineEnd = entryTs + 5 * 60_000; // 入场后多拉1根

        const rawKlines = await fetchKlines(symbol, "5m", klineStart, klineEnd);
        if (rawKlines.length < 5) {
            console.log(`  ⚠️ K线不足: ${trade.openDate} (${rawKlines.length}根)`);
            await Bun.sleep(300);
            continue;
        }

        // 转换K线格式
        const klines = rawKlines.map((k: any) => ({
            o: +k.open, h: +k.high, l: +k.low, c: +k.close,
            v: +(k.quoteVol || k.vol || k.volume || 0),
            ts: +k.time,
        }));

        // 找到入场时的那根K线 (最接近 entryTs 的)
        let entryIdx = klines.length - 1;
        for (let i = 0; i < klines.length; i++) {
            if (klines[i].ts >= entryTs) { entryIdx = Math.max(0, i - 1); break; }
        }

        // 截取入场时刻及之前的K线
        const relevantKlines = klines.slice(0, entryIdx + 1);
        if (relevantKlines.length < 5) {
            await Bun.sleep(300);
            continue;
        }

        const closes = relevantKlines.map(k => k.c);
        const ema3 = calcEMA(closes, 3);
        const ema7 = calcEMA(closes, 7);
        const ema20 = calcEMA(closes, 20);
        const atr = calcATR(relevantKlines);

        // 量比
        const vols = relevantKlines.slice(-21, -1).map(k => k.v);
        const avgVol = vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : 1;
        const entryVol = relevantKlines[relevantKlines.length - 1].v;
        const volRatio = avgVol > 0 ? entryVol / avgVol : 0;

        // 入场前30分钟价格变化
        const lookback = Math.min(6, relevantKlines.length - 1); // 6根5mK线=30分钟
        const priceStart = relevantKlines[relevantKlines.length - 1 - lookback].c;
        const priceEnd = relevantKlines[relevantKlines.length - 1].c;
        const priceChange = priceStart > 0 ? (priceEnd - priceStart) / priceStart * 100 : 0;

        // K线形态检测
        const patterns = detectPattern(relevantKlines);

        const entryCandle = relevantKlines[relevantKlines.length - 1];

        contexts.push({
            tradeDate: trade.openDate,
            direction: trade.direction,
            entryPrice: trade.entryPrice,
            exitPrice: trade.exitPrice,
            netPnlU: trade.netPnlU,
            grossPnlPt: trade.grossPnlPt,
            holdMinutes: trade.holdMinutes,
            hour: trade.hour,
            dayOfWeek: trade.dayOfWeek,
            isBot: trade.isBot,
            ema3, ema7, ema20,
            atr14: atr,
            priceVsEma20: priceEnd - ema20,
            ema3VsEma7: ema3 - ema7,
            ema7VsEma20: ema7 - ema20,
            volRatio,
            priceChangeBeforeEntry: +priceChange.toFixed(3),
            patterns,
            entryCandle: { o: entryCandle.o, h: entryCandle.h, l: entryCandle.l, c: entryCandle.c },
        });

        processed++;
        if (processed % 10 === 0) {
            console.log(`  ✅ ${processed}/${samplesToAnalyze.length} 笔完成`);
        }

        await Bun.sleep(300); // 限流
    }

    console.log(`\n📊 共分析 ${contexts.length} 笔赢单\n`);

    // ═══ 模式统计 ═══
    console.log("═══════════════════════════════════════");
    console.log("  🎯 赢单入场模式统计");
    console.log("═══════════════════════════════════════");

    // 1. EMA 排列
    const bearishAlign = contexts.filter(c => c.ema3 < c.ema7 && c.ema7 < c.ema20);
    console.log(`\n📐 EMA 空头排列 (3<7<20): ${bearishAlign.length}/${contexts.length} (${(bearishAlign.length / contexts.length * 100).toFixed(0)}%)`);

    // 2. 价格在 EMA20 下方
    const belowEma20 = contexts.filter(c => c.priceVsEma20 < 0);
    console.log(`📉 价格在 EMA20 下方: ${belowEma20.length}/${contexts.length} (${(belowEma20.length / contexts.length * 100).toFixed(0)}%)`);

    // 3. 入场前价格下跌
    const preDrop = contexts.filter(c => c.priceChangeBeforeEntry < -0.1);
    console.log(`📉 入场前30分钟下跌>0.1%: ${preDrop.length}/${contexts.length} (${(preDrop.length / contexts.length * 100).toFixed(0)}%)`);

    // 4. K线形态分布
    console.log("\n📊 入场时 K 线形态:");
    const patternCounts: Record<string, number> = {};
    for (const c of contexts) {
        for (const p of c.patterns) {
            patternCounts[p] = (patternCounts[p] || 0) + 1;
        }
    }
    const sortedPatterns = Object.entries(patternCounts).sort((a, b) => b[1] - a[1]);
    for (const [pattern, count] of sortedPatterns) {
        console.log(`  ${pattern}: ${count}/${contexts.length} (${(count / contexts.length * 100).toFixed(0)}%)`);
    }

    // 5. ATR 统计
    const atrs = contexts.map(c => c.atr14).filter(v => v > 0);
    const avgAtr = atrs.length > 0 ? atrs.reduce((a, b) => a + b) / atrs.length : 0;
    const minAtr = Math.min(...atrs);
    const maxAtr = Math.max(...atrs);
    console.log(`\n📏 ATR(14) 范围: ${minAtr.toFixed(2)} ~ ${maxAtr.toFixed(2)} | 均值: ${avgAtr.toFixed(2)}`);

    // 6. 量比统计
    const avgVolRatio = contexts.reduce((s, c) => s + c.volRatio, 0) / contexts.length;
    const highVol = contexts.filter(c => c.volRatio > 1.5);
    console.log(`📊 均量比: ${avgVolRatio.toFixed(2)}x | 放量(>1.5x): ${highVol.length}/${contexts.length} (${(highVol.length / contexts.length * 100).toFixed(0)}%)`);

    // 7. EMA 间距
    const avgEma3vs7 = contexts.reduce((s, c) => s + c.ema3VsEma7, 0) / contexts.length;
    const avgEma7vs20 = contexts.reduce((s, c) => s + c.ema7VsEma20, 0) / contexts.length;
    console.log(`\n📐 EMA 间距:`);
    console.log(`  EMA3-EMA7 均值: ${avgEma3vs7.toFixed(2)}pt (${avgEma3vs7 < 0 ? "空头" : "多头"}扩张)`);
    console.log(`  EMA7-EMA20 均值: ${avgEma7vs20.toFixed(2)}pt (${avgEma7vs20 < 0 ? "空头" : "多头"}扩张)`);

    // 8. 入场时段分布
    console.log("\n⏰ 赢单入场时段分布:");
    const hourCounts: Record<number, number> = {};
    for (const c of contexts) {
        hourCounts[c.hour] = (hourCounts[c.hour] || 0) + 1;
    }
    const sortedHours = Object.entries(hourCounts).sort((a, b) => +b[1] - +a[1]);
    for (const [hour, count] of sortedHours.slice(0, 8)) {
        console.log(`  ${hour.padStart(2)}:00 | ${String(count).padStart(3)}笔 | ${"█".repeat(Math.ceil(count / contexts.length * 50))}`);
    }

    // 9. 预入场价格变化分布
    console.log("\n📉 入场前30分钟价格变化分布:");
    const changeBuckets = [
        { label: "暴跌 <-0.5%", min: -Infinity, max: -0.5 },
        { label: "下跌 -0.5%~-0.1%", min: -0.5, max: -0.1 },
        { label: "横盘 -0.1%~+0.1%", min: -0.1, max: 0.1 },
        { label: "上涨 >+0.1%", min: 0.1, max: Infinity },
    ];
    for (const b of changeBuckets) {
        const count = contexts.filter(c => c.priceChangeBeforeEntry >= b.min && c.priceChangeBeforeEntry < b.max).length;
        console.log(`  ${b.label.padEnd(20)} | ${count}笔 (${(count / contexts.length * 100).toFixed(0)}%)`);
    }

    // ═══ 综合结论 ═══
    console.log("\n═══════════════════════════════════════");
    console.log("  💡 反推的入场信号规则");
    console.log("═══════════════════════════════════════");

    const rules: string[] = [];

    if (bearishAlign.length / contexts.length > 0.5) {
        rules.push(`✅ EMA空头排列 (EMA3<EMA7<EMA20) — ${(bearishAlign.length / contexts.length * 100).toFixed(0)}% 的赢单满足`);
    }
    if (belowEma20.length / contexts.length > 0.5) {
        rules.push(`✅ 价格在 EMA20 下方 — ${(belowEma20.length / contexts.length * 100).toFixed(0)}% 的赢单满足`);
    }
    if (preDrop.length / contexts.length > 0.3) {
        rules.push(`✅ 入场前30分钟已有明显下跌 — ${(preDrop.length / contexts.length * 100).toFixed(0)}% 的赢单满足`);
    }
    for (const [pattern, count] of sortedPatterns) {
        if (count / contexts.length > 0.3) {
            rules.push(`✅ K线形态: ${pattern} — ${(count / contexts.length * 100).toFixed(0)}% 出现`);
        }
    }

    for (const r of rules) console.log(`  ${r}`);

    // 保存完整数据
    writeFileSync(OUTPUT_FILE, JSON.stringify({
        generatedAt: new Date().toISOString(),
        totalAnalyzed: contexts.length,
        rules,
        stats: {
            bearishAlignPct: +(bearishAlign.length / contexts.length * 100).toFixed(1),
            belowEma20Pct: +(belowEma20.length / contexts.length * 100).toFixed(1),
            preDropPct: +(preDrop.length / contexts.length * 100).toFixed(1),
            avgAtr: +avgAtr.toFixed(2),
            avgVolRatio: +avgVolRatio.toFixed(2),
            avgEma3vs7: +avgEma3vs7.toFixed(2),
            avgEma7vs20: +avgEma7vs20.toFixed(2),
            patterns: patternCounts,
            hourDistribution: hourCounts,
        },
        trades: contexts,
    }, null, 2));

    console.log(`\n📁 完整数据已保存: ${OUTPUT_FILE}`);
    console.log("═══════════════════════════════════════\n");
}

main().catch(e => { console.error("💥 分析失败:", e); process.exit(1); });
