/**
 * 📊 Bitunix 历史交易拉取器
 * ═══════════════════════════════
 * 从 Bitunix API 拉取所有历史成交记录，写入 data/trades-history.jsonl
 * 用法: bun src/pull-trades.ts
 */

import { appendFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const BITUNIX_BASE = "https://fapi.bitunix.com";
const API_KEY = process.env.BITUNIX_API_KEY || "";
const SECRET_KEY = process.env.BITUNIX_SECRET_KEY || "";

if (!API_KEY || !SECRET_KEY) {
    console.error("❌ 缺少环境变量 BITUNIX_API_KEY / BITUNIX_SECRET_KEY");
    process.exit(1);
}

const DATA_DIR = join(process.cwd(), "data");
const OUTPUT_FILE = join(DATA_DIR, "trades-history.jsonl");

// ═══ 签名 (复用 executor 逻辑) ═══
function sign(queryParams = "", body = ""): Record<string, string> {
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const timestamp = Date.now().toString();
    const digestInput = nonce + timestamp + API_KEY + queryParams + body;
    const digest = new Bun.CryptoHasher("sha256").update(digestInput).digest("hex");
    const signature = new Bun.CryptoHasher("sha256").update(digest + SECRET_KEY).digest("hex");
    return { "api-key": API_KEY, sign: signature, nonce, timestamp };
}

interface TradeRecord {
    tradeId: string;
    orderId: string;
    symbol: string;
    side: string;        // BUY / SELL
    tradeSide: string;   // OPEN / CLOSE
    price: number;
    qty: number;
    fee: number;
    realizedPnl: number;
    ts: number;
    date: string;
}

// ═══ 拉取历史成交 ═══
async function fetchHistoryTrades(
    symbol: string,
    startTime?: number,
    endTime?: number,
    skip = 0,
    limit = 100,
): Promise<any[]> {
    const params: string[] = [];
    if (endTime) params.push(`endTime${endTime}`);
    params.push(`limit${limit}`);
    if (skip > 0) params.push(`skip${skip}`);
    if (startTime) params.push(`startTime${startTime}`);
    params.push(`symbol${symbol}`);
    const queryStr = params.sort().join("");

    const headers = sign(queryStr);

    const urlParams = new URLSearchParams();
    urlParams.set("symbol", symbol);
    urlParams.set("limit", String(limit));
    if (skip > 0) urlParams.set("skip", String(skip));
    if (startTime) urlParams.set("startTime", String(startTime));
    if (endTime) urlParams.set("endTime", String(endTime));

    const url = `${BITUNIX_BASE}/api/v1/futures/trade/get_history_trades?${urlParams.toString()}`;
    const res = await fetch(url, {
        headers: { ...headers, "Content-Type": "application/json", language: "en-US" },
    });
    let data: any;
    try {
        const text = await res.text();
        data = JSON.parse(text);
    } catch {
        console.error(`  ⚠️ trades API 返回非JSON (HTTP ${res.status}), 跳过`);
        return [];
    }

    if (String(data?.code) !== "0") {
        console.error(`❌ API 错误: code=${data?.code} msg=${data?.msg}`);
        return [];
    }

    return data?.data?.tradeList || data?.data || [];
}

// ═══ 拉取历史订单 ═══
async function fetchHistoryOrders(
    symbol: string,
    startTime?: number,
    endTime?: number,
    skip = 0,
    limit = 100,
): Promise<any[]> {
    const params: string[] = [];
    if (endTime) params.push(`endTime${endTime}`);
    params.push(`limit${limit}`);
    if (skip > 0) params.push(`skip${skip}`);
    if (startTime) params.push(`startTime${startTime}`);
    params.push(`symbol${symbol}`);
    const queryStr = params.sort().join("");

    const headers = sign(queryStr);

    const urlParams = new URLSearchParams();
    urlParams.set("symbol", symbol);
    urlParams.set("limit", String(limit));
    if (skip > 0) urlParams.set("skip", String(skip));
    if (startTime) urlParams.set("startTime", String(startTime));
    if (endTime) urlParams.set("endTime", String(endTime));

    const url = `${BITUNIX_BASE}/api/v1/futures/trade/get_history_orders?${urlParams.toString()}`;
    const res = await fetch(url, {
        headers: { ...headers, "Content-Type": "application/json", language: "en-US" },
    });

    let data: any;
    try {
        const text = await res.text();
        data = JSON.parse(text);
    } catch {
        console.error(`  ⚠️ orders API 返回非JSON (HTTP ${res.status}), 跳过`);
        return [];
    }

    if (String(data?.code) !== "0") {
        console.error(`❌ API 错误: code=${data?.code} msg=${data?.msg}`);
        return [];
    }

    return data?.data?.orderList || data?.data || [];
}

// ═══ 主流程 ═══
async function main() {
    console.log("═══════════════════════════════════════");
    console.log("  📊 Bitunix 历史交易拉取器");
    console.log("═══════════════════════════════════════");

    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

    const symbols = ["ETHUSDT", "SOLUSDT", "BTCUSDT"];
    let totalTrades = 0;
    let totalOrders = 0;

    // 清空输出文件
    writeFileSync(OUTPUT_FILE, "");

    // 拉取最近 90 天
    const endTime = Date.now();
    const startTime = endTime - 90 * 24 * 3600_000;

    for (const symbol of symbols) {
        console.log(`\n🔍 拉取 ${symbol} 交易记录...`);

        // ═══ 历史成交 ═══
        let skip = 0;
        let hasMore = true;
        let symbolTrades = 0;

        while (hasMore) {
            const trades = await fetchHistoryTrades(symbol, startTime, endTime, skip, 100);
            if (trades.length === 0) { hasMore = false; break; }

            for (const t of trades) {
                const record = {
                    type: "trade",
                    tradeId: t.tradeId || t.trade_id || "",
                    orderId: t.orderId || t.order_id || "",
                    symbol: t.symbol || symbol,
                    side: t.side || "",
                    tradeSide: t.tradeSide || t.trade_side || "",
                    price: +(t.price || 0),
                    qty: +(t.qty || t.quantity || 0),
                    fee: +(t.fee || t.commission || 0),
                    realizedPnl: +(t.realizedPnl || t.realized_pnl || t.profit || 0),
                    ts: +(t.ctime || t.time || t.timestamp || 0),
                    date: t.ctime ? new Date(+t.ctime).toISOString() : "",
                    // 原始数据保留
                    raw: t,
                };
                appendFileSync(OUTPUT_FILE, JSON.stringify(record) + "\n");
                symbolTrades++;
            }

            skip += trades.length;
            if (trades.length < 100) hasMore = false;

            // 限流保护
            await Bun.sleep(500);
        }

        console.log(`  ✅ ${symbol} 成交: ${symbolTrades} 笔`);
        totalTrades += symbolTrades;

        // ═══ 历史订单 ═══
        skip = 0;
        hasMore = true;
        let symbolOrders = 0;

        while (hasMore) {
            const orders = await fetchHistoryOrders(symbol, startTime, endTime, skip, 100);
            if (orders.length === 0) { hasMore = false; break; }

            for (const o of orders) {
                const record = {
                    type: "order",
                    orderId: o.orderId || o.order_id || "",
                    symbol: o.symbol || symbol,
                    side: o.side || "",
                    tradeSide: o.tradeSide || o.trade_side || "",
                    orderType: o.orderType || o.order_type || "",
                    price: +(o.price || 0),
                    avgPrice: +(o.avgPrice || o.avg_price || 0),
                    qty: +(o.qty || o.quantity || 0),
                    filledQty: +(o.filledQty || o.filled_qty || 0),
                    fee: +(o.fee || o.commission || 0),
                    realizedPnl: +(o.realizedPnl || o.realized_pnl || o.profit || 0),
                    status: o.status || "",
                    ts: +(o.ctime || o.time || o.timestamp || 0),
                    date: o.ctime ? new Date(+o.ctime).toISOString() : "",
                    raw: o,
                };
                appendFileSync(OUTPUT_FILE, JSON.stringify(record) + "\n");
                symbolOrders++;
            }

            skip += orders.length;
            if (orders.length < 100) hasMore = false;
            await Bun.sleep(500);
        }

        console.log(`  ✅ ${symbol} 订单: ${symbolOrders} 笔`);
        totalOrders += symbolOrders;
    }

    console.log("\n═══════════════════════════════════════");
    console.log(`  📊 完成! 共 ${totalTrades} 笔成交 + ${totalOrders} 笔订单`);
    console.log(`  📁 写入: ${OUTPUT_FILE}`);
    console.log("═══════════════════════════════════════");

    // 统计摘要
    if (totalTrades + totalOrders > 0) {
        const { readFileSync } = await import("fs");
        const lines = readFileSync(OUTPUT_FILE, "utf-8").trim().split("\n");
        let wins = 0, losses = 0, totalPnl = 0;
        for (const line of lines) {
            try {
                const r = JSON.parse(line);
                if (r.type === "trade" && r.tradeSide === "CLOSE") {
                    if (r.realizedPnl > 0) wins++;
                    else if (r.realizedPnl < 0) losses++;
                    totalPnl += r.realizedPnl;
                }
            } catch {}
        }
        console.log(`\n  📈 平仓统计: ${wins}赢 / ${losses}亏 | 总PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} USDT`);
    }
}

main().catch(e => { console.error("💥 拉取失败:", e); process.exit(1); });
