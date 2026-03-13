/**
 * 🧪 Dry Run 测试 — 三模式因果信号模拟
 * ═══════════════════════════════════════
 * 不接 WS、不开仓，纯 Console 输出因果数据
 * 用法: bun run src/dryrun.ts
 */

import {
    LEVERAGE, MARGIN_DEFAULT, IMBALANCE_RATIO,
    BTC_IMBALANCE_RATIO, SOL_RESONANCE_RATIO,
    BTC_AUTO_SWITCH_RATIO,
    SOL_MIN_EFFICIENCY, ETH_MIN_EFFICIENCY,
    EFFICIENCY_ABS_THRESHOLD,
    STOP_LOSS_PCT, BE_TARGET_PCT,
    MOMENTUM_CHECK_MS, MOMENTUM_MIN_PCT,
    SYMBOL, ETH_SYMBOL, BTC_SYMBOL,
} from "./config";

function ts() {
    return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function log(tag: string, msg: string) {
    console.log(`${ts()} [${tag}] ${msg}`);
}

function separator() {
    console.log("─".repeat(70));
}

// ═══════════════════════════════════════
// 模拟数据场景
// ═══════════════════════════════════════

interface MockTick {
    label: string;
    btcDelta: number;
    btcAskWall: number;
    solDelta: number;
    solAskWall: number;
    solEfficiency: number;
    solAvgEfficiency: number;
    ethEfficiency: number;
    ethAvgEfficiency: number;
    solPrice: number;
    ethPrice: number;
    btcPrice: number;
    solRecentVol: number;
    solAvgVol: number;
}

const scenarios: MockTick[] = [
    {
        label: "场景1: BTC 领路 → SOL 效率更高 (模式C→SOL)",
        btcDelta: 5.2, btcAskWall: 1.2,
        solDelta: 3.8, solAskWall: 1.5,
        solEfficiency: 2.1, solAvgEfficiency: 0.8,
        ethEfficiency: 0.6, ethAvgEfficiency: 0.5,
        solPrice: 142.350, ethPrice: 1985.20, btcPrice: 84520.0,
        solRecentVol: 120, solAvgVol: 80,
    },
    {
        label: "场景2: BTC 领路 → SOL 没反应 → ETH 兜底 (模式C→ETH)",
        btcDelta: 4.5, btcAskWall: 1.1,
        solDelta: 1.2, solAskWall: 2.0,
        solEfficiency: 0.3, solAvgEfficiency: 0.5,
        ethEfficiency: 1.2, ethAvgEfficiency: 0.7,
        solPrice: 142.100, ethPrice: 1988.50, btcPrice: 84680.0,
        solRecentVol: 50, solAvgVol: 80,
    },
    {
        label: "场景3: BTC-SOL 联动共振 (模式B)",
        btcDelta: 4.0, btcAskWall: 1.2,
        solDelta: 4.5, solAskWall: 1.5,
        solEfficiency: 1.8, solAvgEfficiency: 0.9,
        ethEfficiency: 0.5, ethAvgEfficiency: 0.4,
        solPrice: 143.200, ethPrice: 1990.00, btcPrice: 84900.0,
        solRecentVol: 150, solAvgVol: 80,
    },
    {
        label: "场景4: SOL 独立狙击 5.5x (模式A)",
        btcDelta: 1.5, btcAskWall: 1.0,
        solDelta: 9.0, solAskWall: 1.5,
        solEfficiency: 2.5, solAvgEfficiency: 1.0,
        ethEfficiency: 0.3, ethAvgEfficiency: 0.4,
        solPrice: 144.500, ethPrice: 1982.00, btcPrice: 84200.0,
        solRecentVol: 200, solAvgVol: 80,
    },
    {
        label: "场景5: 效率衰竭 — 放量倒货 (持仓中止盈触发)",
        btcDelta: 2.0, btcAskWall: 1.5,
        solDelta: 2.5, solAskWall: 2.0,
        solEfficiency: 0.08, solAvgEfficiency: 0.9,
        ethEfficiency: 0.08, ethAvgEfficiency: 0.5,
        solPrice: 145.100, ethPrice: 1995.00, btcPrice: 85000.0,
        solRecentVol: 350, solAvgVol: 80,
    },
    {
        label: "场景6: 全部不达标 — 继续等待",
        btcDelta: 1.0, btcAskWall: 1.5,
        solDelta: 1.5, solAskWall: 2.0,
        solEfficiency: 0.5, solAvgEfficiency: 0.6,
        ethEfficiency: 0.3, ethAvgEfficiency: 0.4,
        solPrice: 141.800, ethPrice: 1980.00, btcPrice: 83800.0,
        solRecentVol: 60, solAvgVol: 80,
    },
];

// ═══════════════════════════════════════
// Dry Run 引擎
// ═══════════════════════════════════════

function evaluateDryRun(tick: MockTick) {
    const btcRatio = tick.btcAskWall > 0 ? tick.btcDelta / tick.btcAskWall : 0;
    const solRatio = tick.solAskWall > 0 ? tick.solDelta / tick.solAskWall : 0;

    log("LOG", `BTC_Delta: ${tick.btcDelta}, Ask_Wall: ${tick.btcAskWall}, Ratio: ${btcRatio.toFixed(2)} -> ${btcRatio > BTC_AUTO_SWITCH_RATIO ? "触发进场因 ✅" : btcRatio > BTC_IMBALANCE_RATIO ? "联动因 ✅" : "未触发 ❌"}`);
    log("LOG", `SOL_Delta: ${tick.solDelta}, Ask_Wall: ${tick.solAskWall}, Ratio: ${solRatio.toFixed(2)} -> ${solRatio > IMBALANCE_RATIO ? "独立狙击 ✅" : solRatio > SOL_RESONANCE_RATIO ? "联动共振 ✅" : "SOL不够 ❌"}`);
    log("LOG", `SOL_Efficiency: ${tick.solEfficiency.toFixed(4)} (avg: ${tick.solAvgEfficiency.toFixed(4)}) -> ${tick.solEfficiency > SOL_MIN_EFFICIENCY ? "SOL爆发 ✅" : tick.solEfficiency < 0.15 && tick.solRecentVol > tick.solAvgVol * 2 ? "偵測到衰竭果 ⚠️" : "普通"}`);
    log("LOG", `ETH_Efficiency: ${tick.ethEfficiency.toFixed(4)} (avg: ${tick.ethAvgEfficiency.toFixed(4)}) -> ${tick.ethEfficiency > ETH_MIN_EFFICIENCY ? "ETH达标 ✅" : tick.ethEfficiency < 0.15 ? "偵測到衰竭果 ⚠️" : "ETH不够 ❌"}`);
    log("LOG", `SOL_Vol: ${tick.solRecentVol} / Avg: ${tick.solAvgVol} (${(tick.solRecentVol / tick.solAvgVol).toFixed(1)}x) -> ${tick.solRecentVol > tick.solAvgVol * 2 ? "放量 ⚠️" : "正常"}`);

    // 模式 C: BTC 领路自动切换
    if (btcRatio > BTC_AUTO_SWITCH_RATIO) {
        if (tick.solEfficiency > tick.ethEfficiency && tick.solEfficiency > SOL_MIN_EFFICIENCY) {
            log("SIGNAL", `🚀 模式C触发 → SOL: BTC=${btcRatio.toFixed(2)}x(>${BTC_AUTO_SWITCH_RATIO}) SOL效率${tick.solEfficiency}>${tick.ethEfficiency} & >${SOL_MIN_EFFICIENCY}`);
            log("DRY-RUN", `⏭️ [不开仓] IOC BUY ${SYMBOL} 200x @ $${tick.solPrice.toFixed(3)} M=$${MARGIN_DEFAULT}`);
            return "MODE_C_SOL";
        }
        if (tick.ethEfficiency > ETH_MIN_EFFICIENCY) {
            log("SIGNAL", `💎 模式C触发 → ETH: BTC=${btcRatio.toFixed(2)}x SOL效率${tick.solEfficiency}<${SOL_MIN_EFFICIENCY}, ETH效率${tick.ethEfficiency}>${ETH_MIN_EFFICIENCY}`);
            log("DRY-RUN", `⏭️ [不开仓] IOC BUY ${ETH_SYMBOL} 200x @ $${tick.ethPrice.toFixed(2)} M=$${MARGIN_DEFAULT}`);
            return "MODE_C_ETH";
        }
    }

    // 模式 B: 联动共振
    if (btcRatio > BTC_IMBALANCE_RATIO && solRatio > SOL_RESONANCE_RATIO) {
        log("SIGNAL", `🔥 模式B触发 → 联动共振: BTC=${btcRatio.toFixed(2)}x(>${BTC_IMBALANCE_RATIO}) SOL=${solRatio.toFixed(2)}x(>${SOL_RESONANCE_RATIO})`);
        log("DRY-RUN", `⏭️ [不开仓] IOC BUY ${SYMBOL} 200x @ $${tick.solPrice.toFixed(3)} M=$${MARGIN_DEFAULT}`);
        return "MODE_B";
    }

    // 模式 A: 独立狙击
    if (solRatio > IMBALANCE_RATIO && tick.solEfficiency > EFFICIENCY_ABS_THRESHOLD && tick.solEfficiency > tick.solAvgEfficiency) {
        log("SIGNAL", `🎯 模式A触发 → 独立狙击: SOL=${solRatio.toFixed(2)}x(>${IMBALANCE_RATIO}) 效率${tick.solEfficiency}>${EFFICIENCY_ABS_THRESHOLD} & >${tick.solAvgEfficiency}`);
        log("DRY-RUN", `⏭️ [不开仓] IOC BUY ${SYMBOL} 200x @ $${tick.solPrice.toFixed(3)} M=$${MARGIN_DEFAULT}`);
        return "MODE_A";
    }

    // 效率衰竭检测 (持仓中才有意义)
    if (tick.solEfficiency < 0.15 && tick.solRecentVol > tick.solAvgVol * 2) {
        log("EXIT", `💰 放量倒货止盈信号: 效率${tick.solEfficiency}<0.15 + 量${tick.solRecentVol}>${tick.solAvgVol}×2`);
        log("DRY-RUN", `⏭️ [不平仓] 若有持仓时会止盈出场`);
        return "DUMP_SIGNAL";
    }

    log("WAIT", `🔍 无信号 — 继续扫描...`);
    return "NO_SIGNAL";
}

// ═══════════════════════════════════════
// 主程序
// ═══════════════════════════════════════

console.log("════════════════════════════════════════════════════════════════════");
console.log("  🧪 SOL Sniper v2.0 — Dry Run 因果信号测试");
console.log("  📡 三模式: A独立狙击 / B联动共振 / C_BTC领路自动切换");
console.log("  🔒 IOC 防滑价 | 不会实际下单");
console.log("════════════════════════════════════════════════════════════════════");
console.log();
console.log(`  配置: ${SYMBOL} ${LEVERAGE}x | M=$${MARGIN_DEFAULT}`);
console.log(`  A: SOL ${IMBALANCE_RATIO}x + 效率>${EFFICIENCY_ABS_THRESHOLD}`);
console.log(`  B: BTC ${BTC_IMBALANCE_RATIO}x + SOL ${SOL_RESONANCE_RATIO}x`);
console.log(`  C: BTC ${BTC_AUTO_SWITCH_RATIO}x → SOL>${SOL_MIN_EFFICIENCY} / ETH>${ETH_MIN_EFFICIENCY}`);
console.log(`  SL: ${(STOP_LOSS_PCT * 100).toFixed(2)}% | BE: ${(BE_TARGET_PCT * 100).toFixed(2)}%`);
console.log(`  惯性: ${MOMENTUM_CHECK_MS}ms / ${(MOMENTUM_MIN_PCT * 100).toFixed(2)}%`);
console.log();

const results: Record<string, number> = {};

for (let i = 0; i < scenarios.length; i++) {
    const tick = scenarios[i];
    separator();
    console.log(`\n  📌 ${tick.label}`);
    console.log(`  💲 SOL: $${tick.solPrice.toFixed(3)} | ETH: $${tick.ethPrice.toFixed(2)} | BTC: $${tick.btcPrice.toFixed(0)}\n`);

    const result = evaluateDryRun(tick);
    results[result] = (results[result] || 0) + 1;
    console.log();
}

separator();
console.log("\n  📊 Dry Run 结果汇总:");
for (const [k, v] of Object.entries(results)) {
    const labels: Record<string, string> = {
        MODE_C_SOL: "🚀 C→SOL (BTC领路→SOL)",
        MODE_C_ETH: "💎 C→ETH (BTC领路→ETH)",
        MODE_B: "🔥 B 联动共振",
        MODE_A: "🎯 A 独立狙击",
        DUMP_SIGNAL: "💰 放量倒货信号",
        NO_SIGNAL: "🔍 无信号",
    };
    console.log(`    ${labels[k] || k}: ${v}次`);
}
console.log("\n  ✅ Dry Run 完毕 — 无实际下单\n");
