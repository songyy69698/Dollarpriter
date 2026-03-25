/**
 * 🔬 WS 实时 OF 策略验证器
 * 用 BitunixWSEngine 的真实逐笔大单数据 (非 K 线近似)
 * 每 10 秒采样，输出 Effort vs Result 四象限 + 模拟交易信号
 */
import { BitunixWSEngine } from "./bitunix-ws";

const ws = new BitunixWSEngine();
ws.start();

// 等连接
await new Promise(r => { const t = setInterval(() => { if (ws.connected) { clearInterval(t); r(undefined); } }, 500); });
console.log("✅ 已连接 WS\n");

// 状态追踪
let prevCVD = 0;
let prevPrice = 0;
let prevBigDelta = 0;
let sampleN = 0;
const history: any[] = [];

// 简易模拟交易
let inPos = false;
let posDir = "";
let entryPrice = 0;
let entryTime = "";
const trades: any[] = [];

// 偏向追踪 (用 Auction Sequence)
let bias = "none"; // "bull" | "bear" | "none"
let biasReason = "";
// 连续 Delta 方向追踪
const deltaHistory: number[] = [];

const SAMPLE_INTERVAL = 10_000; // 10秒
const RUN_DURATION = 5 * 60_000; // 5分钟观察

console.log("═══════════════════════════════════════════════════════════════");
console.log("  🔬 WS 实时 OF 策略验证 (5分钟)");
console.log("  数据源: Bitunix 逐笔大单 (≥3 ETH)");
console.log("═══════════════════════════════════════════════════════════════\n");

const startTime = Date.now();

const timer = setInterval(() => {
    const s = ws.getSnapshot();
    if (!s.connected || s.price <= 0) return;

    const now = Date.now();
    const elapsed = ((now - startTime) / 1000).toFixed(0);
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });

    const cvd = s.ethBigCVD;
    const bigDelta = s.ethBigNetDelta;
    const price = s.price;
    const poc = s.ethPOC;

    // 斜率
    const cvdSlope = prevCVD !== 0 ? cvd - prevCVD : 0;
    const priceVelocity = prevPrice > 0 ? price - prevPrice : 0;
    const deltaChange = bigDelta - prevBigDelta;

    // Effort & Result
    const effort = Math.abs(cvdSlope);
    const result = Math.abs(priceVelocity);

    // 四象限 (用真实大单数据，不用 K 线近似)
    const EFFORT_THRESHOLD = 20;  // 大单 CVD 变化 > 20 ETH = 显著
    const RESULT_THRESHOLD = 2;   // 价格 > 2pt/10s = 显著

    let quadrant = "";
    let emoji = "";

    if (effort > EFFORT_THRESHOLD && result > RESULT_THRESHOLD) {
        const effortDir = cvdSlope > 0 ? "多" : "空";
        const resultDir = priceVelocity > 0 ? "多" : "空";
        if (effortDir === resultDir) {
            quadrant = `INITIATIVE_${resultDir}`;
            emoji = resultDir === "多" ? "🚀" : "💥";
        } else {
            quadrant = `DIVERGE`;
            emoji = "⚡";
        }
    } else if (effort > EFFORT_THRESHOLD && result <= RESULT_THRESHOLD) {
        const dir = cvdSlope > 0 ? "买打不涨→看空" : "卖打不跌→看多";
        quadrant = `ABSORB_${dir}`;
        emoji = "🛡️";
    } else if (effort <= EFFORT_THRESHOLD && result > RESULT_THRESHOLD) {
        quadrant = "SWEEP";
        emoji = "⚠️";
    } else {
        quadrant = "QUIET";
        emoji = "😴";
    }

    // Delta 方向追踪 (for Auction Sequence)
    deltaHistory.push(cvdSlope);
    if (deltaHistory.length > 5) deltaHistory.shift();

    // Auction Sequence: 连续3个同向 + result递减
    if (deltaHistory.length >= 3) {
        const last3 = deltaHistory.slice(-3);
        const allPos = last3.every(d => d > 5);
        const allNeg = last3.every(d => d < -5);
        if (allPos && result < 1) {
            bias = "bear";
            biasReason = "Failed Buy Auction (连续3次买压无果)";
        } else if (allNeg && result < 1) {
            bias = "bull";
            biasReason = "Failed Sell Auction (连续3次卖压无果)";
        }
        // Initiative 翻转偏向
        if (quadrant === "INITIATIVE_多" && effort > 50) {
            bias = "bull"; biasReason = "强 Initiative 多";
        }
        if (quadrant === "INITIATIVE_空" && effort > 50) {
            bias = "bear"; biasReason = "强 Initiative 空";
        }
    }

    // 模拟交易
    if (inPos) {
        const pnl = posDir === "short" ? entryPrice - price : price - entryPrice;
        // SL
        if (pnl <= -15) {
            trades.push({ entryTime, exitTime: ts, dir: posDir, entry: entryPrice, exit: price, pnl: -15, reason: "SL" });
            inPos = false;
        }
        // 反向 Absorption 止盈 (赚>3pt)
        else if (posDir === "short" && quadrant.includes("ABSORB") && quadrant.includes("看多") && pnl > 3) {
            trades.push({ entryTime, exitTime: ts, dir: posDir, entry: entryPrice, exit: price, pnl, reason: "反向ABS" });
            inPos = false;
        }
        else if (posDir === "long" && quadrant.includes("ABSORB") && quadrant.includes("看空") && pnl > 3) {
            trades.push({ entryTime, exitTime: ts, dir: posDir, entry: entryPrice, exit: price, pnl, reason: "反向ABS" });
            inPos = false;
        }
    }

    // 入场信号 (顺偏向 + Absorption)
    if (!inPos && quadrant.includes("ABSORB")) {
        if (quadrant.includes("看空") && (bias === "bear" || bias === "none")) {
            inPos = true; posDir = "short"; entryPrice = price; entryTime = ts;
            console.log(`  🔴 做空信号! $${price.toFixed(2)} | Effort=${effort.toFixed(0)} Result=${result.toFixed(2)} | 偏向=${bias}(${biasReason})`);
        }
        if (quadrant.includes("看多") && (bias === "bull" || bias === "none")) {
            inPos = true; posDir = "long"; entryPrice = price; entryTime = ts;
            console.log(`  🟢 做多信号! $${price.toFixed(2)} | Effort=${effort.toFixed(0)} Result=${result.toFixed(2)} | 偏向=${bias}(${biasReason})`);
        }
    }

    // 输出
    const posStatus = inPos ? `持${posDir} $${entryPrice.toFixed(2)} PnL=${(posDir==="short"?entryPrice-price:price-entryPrice).toFixed(1)}` : "空仓";
    console.log(
        `${ts} ${emoji} ${quadrant.padEnd(22)} | ` +
        `E=${effort.toFixed(0).padStart(4)} R=${priceVelocity>=0?"+":""}${priceVelocity.toFixed(2).padStart(6)} | ` +
        `$${price.toFixed(2)} CVD=${cvd.toFixed(0)} Δ=${bigDelta.toFixed(0)} | ` +
        `偏向=${bias} | ${posStatus}`
    );

    history.push({ ts, quadrant, effort, result: priceVelocity, price, cvd, bigDelta, bias });

    prevCVD = cvd;
    prevPrice = price;
    prevBigDelta = bigDelta;
    sampleN++;
}, SAMPLE_INTERVAL);

// 5分钟后总结
setTimeout(() => {
    clearInterval(timer);
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  📊 5分钟实时验证总结");
    console.log("═══════════════════════════════════════════════════════════════");

    // 象限分布
    const counts: any = {};
    for (const h of history) {
        const q = h.quadrant.split("_")[0];
        counts[q] = (counts[q] || 0) + 1;
    }
    console.log("\n  象限分布:");
    for (const [q, c] of Object.entries(counts)) console.log(`    ${q}: ${c}次`);

    // 交易
    console.log("\n  模拟交易:");
    if (trades.length === 0) console.log("    无交易信号触发");
    for (const t of trades) {
        console.log(`    ${t.pnl > 0 ? "✅" : "❌"} ${t.dir} ${t.entryTime}→${t.exitTime} $${t.entry.toFixed(2)}→$${t.exit.toFixed(2)} ${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(1)}pt (${t.reason})`);
    }

    // 价格
    if (history.length > 1) {
        const f = history[0], l = history[history.length - 1];
        console.log(`\n  价格: $${f.price.toFixed(2)} → $${l.price.toFixed(2)} (${(l.price - f.price >= 0 ? "+" : "")}${(l.price - f.price).toFixed(2)}pt)`);
        console.log(`  最终偏向: ${l.bias}`);
    }
    console.log("═══════════════════════════════════════════════════════════════");
    process.exit(0);
}, RUN_DURATION + 5000);
