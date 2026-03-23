/**
 * 🔍 V95 订单流监控器 — 观察模式（不交易）
 * ═══════════════════════════════════════════════════
 * 连接 Bitunix WS，实时监控大单 Delta
 * 每 30 秒打印大单状态
 * 关键信号通过 TG 通知 CEO
 *
 * 用法: bun src/orderflow-monitor.ts
 */

import { BitunixWSEngine, CausalSnapshot } from "./bitunix-ws";
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";

function ts() { return new Date().toLocaleTimeString("en-US", { hour12: false }); }

// ═══ TG 通知（可选） ═══
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";

async function sendTG(msg: string) {
    if (!TG_TOKEN || !TG_CHAT) return;
    try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: "HTML" }),
        });
    } catch {}
}

// ═══ 信号定义 ═══
interface OrderFlowSignal {
    ts: number;
    type: "BIG_SELL" | "BIG_BUY" | "WALL_COLLAPSE" | "WALL_BUILD";
    price: number;
    bigNetDelta: number;
    bigCVD: number;
    bigRatio: number;
    bigOrderCount: number;
    askWall: number;
    bidWall: number;
    pocDir: string;
    description: string;
}

// ═══ 主程序 ═══
async function main() {
    console.log("═══════════════════════════════════════════════════");
    console.log("  🔍 V95 订单流监控器 — 观察模式");
    console.log("  📊 连接 Bitunix WS, 监控 ETH 大单 Delta");
    console.log("  ⚠️  仅监控不交易, 按 Ctrl+C 退出");
    console.log("═══════════════════════════════════════════════════\n");

    // 确保数据目录存在
    if (!existsSync("data")) mkdirSync("data", { recursive: true });

    const ws = new BitunixWSEngine();
    ws.start();

    console.log(`${ts()} 🔌 连接 Bitunix WS...\n`);

    // 等待连接
    await new Promise<void>((resolve) => {
        const check = setInterval(() => {
            if (ws.connected) { clearInterval(check); resolve(); }
        }, 500);
    });

    console.log(`${ts()} ✅ 已连接, 开始监控...\n`);
    await sendTG("🔍 V95 订单流监控器已启动\n观察模式 — 不交易");

    let signalCount = 0;
    let lastSignalTs = 0;

    // 每 30 秒打印一次状态
    setInterval(() => {
        const s = ws.getSnapshot();
        // 注意: SYMBOL=ETHUSDT 时, ETH 数据在 price/buyDelta/askWallVol 等主字段中
        // ethPrice/ethConnected 来自 eth 追踪器(无数据), 应使用 price/connected
        if (!s.connected || s.price <= 0) {
            console.log(`${ts()} ⚠️  主币种未连接`);
            return;
        }

        const bigDir = s.ethBigNetDelta > 0 ? "🟢买" : s.ethBigNetDelta < 0 ? "🔴卖" : "⚪️平";
        const cvdDir = s.ethBigCVD > 0 ? "↑" : s.ethBigCVD < 0 ? "↓" : "→";
        const pocDir = s.ethPOCDir === "long" ? "↑多" : s.ethPOCDir === "short" ? "↓空" : "→";

        console.log(
            `${ts()} ETH $${s.price.toFixed(2)} | ` +
            `大单${bigDir} Δ=${s.ethBigNetDelta.toFixed(1)}ETH | ` +
            `CVD${cvdDir}${s.ethBigCVD.toFixed(1)} | ` +
            `占比${(s.ethBigRatio * 100).toFixed(0)}% | ` +
            `${s.ethBigOrderCount}笔 | ` +
            `墙A:${s.askWallVol.toFixed(1)} B:${s.bidWallVol.toFixed(1)} | ` +
            `POC${pocDir}`
        );

        // ═══ 信号检测 ═══
        const now = Date.now();
        const cooldown = now - lastSignalTs > 120_000; // 2 分钟冷却

        // 信号1: 大单持续卖出 (CVD < -10 ETH + 大单占比 > 40%)
        if (s.ethBigCVD < -10 && s.ethBigRatio > 0.4 && s.ethBigOrderCount >= 3 && cooldown) {
            const signal: OrderFlowSignal = {
                ts: now, type: "BIG_SELL", price: s.price,
                bigNetDelta: s.ethBigNetDelta, bigCVD: s.ethBigCVD,
                bigRatio: s.ethBigRatio, bigOrderCount: s.ethBigOrderCount,
                askWall: s.askWallVol, bidWall: s.bidWallVol,
                pocDir: s.ethPOCDir,
                description: `🔴 机构卖压! CVD=${s.ethBigCVD.toFixed(1)} Δ=${s.ethBigNetDelta.toFixed(1)} 占比=${(s.ethBigRatio*100).toFixed(0)}%`,
            };
            logSignal(signal);
            lastSignalTs = now;
            signalCount++;
        }

        // 信号2: 大单持续买入 (CVD > 10 ETH + 大单占比 > 40%)
        if (s.ethBigCVD > 10 && s.ethBigRatio > 0.4 && s.ethBigOrderCount >= 3 && cooldown) {
            const signal: OrderFlowSignal = {
                ts: now, type: "BIG_BUY", price: s.price,
                bigNetDelta: s.ethBigNetDelta, bigCVD: s.ethBigCVD,
                bigRatio: s.ethBigRatio, bigOrderCount: s.ethBigOrderCount,
                askWall: s.askWallVol, bidWall: s.bidWallVol,
                pocDir: s.ethPOCDir,
                description: `🟢 机构买入! CVD=${s.ethBigCVD.toFixed(1)} Δ=${s.ethBigNetDelta.toFixed(1)} 占比=${(s.ethBigRatio*100).toFixed(0)}%`,
            };
            logSignal(signal);
            lastSignalTs = now;
            signalCount++;
        }

        // 信号3: 卖方墙崩塌 (墙体变化率 < -50%)
        if (s.ethBigNetDelta < -3 && cooldown) {
            // 检查 bidWall 变化 — 使用 snapshot 的墙变化率
            const wallCollapse = s.bidWallVol > 0 && s.ethBigSellDelta > s.ethBigBuyDelta * 1.5;
            if (wallCollapse) {
            const signal: OrderFlowSignal = {
                ts: now, type: "WALL_COLLAPSE", price: s.price,
                bigNetDelta: s.ethBigNetDelta, bigCVD: s.ethBigCVD,
                bigRatio: s.ethBigRatio, bigOrderCount: s.ethBigOrderCount,
                askWall: s.askWallVol, bidWall: s.bidWallVol,
                pocDir: s.ethPOCDir,
                description: `💥 大单卖压+墙崩! NetΔ=${s.ethBigNetDelta.toFixed(1)}`,
            };
            logSignal(signal);
            lastSignalTs = now;
            signalCount++;
            }
        }
    }, 30_000);

    // 每 5 分钟统计
    setInterval(() => {
        console.log(`\n${ts()} ──── 5min 统计 | 信号数: ${signalCount} ────\n`);
    }, 300_000);
}

function logSignal(signal: OrderFlowSignal) {
    const line = JSON.stringify(signal) + "\n";
    appendFileSync("data/orderflow-signals.jsonl", line);

    console.log(`\n  ⚡ ${signal.description}`);
    console.log(`     价格: $${signal.price.toFixed(2)} | 墙 A:${signal.askWall.toFixed(1)} B:${signal.bidWall.toFixed(1)} | POC: ${signal.pocDir}\n`);

    // TG 通知
    const msg = `⚡ <b>${signal.type}</b>\n` +
        `ETH $${signal.price.toFixed(2)}\n` +
        `${signal.description}\n` +
        `大单: ${signal.bigOrderCount}笔 | 占比: ${(signal.bigRatio*100).toFixed(0)}%\n` +
        `<i>观察模式 — 不交易</i>`;
    sendTG(msg);
}

main().catch(e => { console.error("💥", e); process.exit(1); });
