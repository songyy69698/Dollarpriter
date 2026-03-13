/**
 * 🧪 SOL 狙击手 v2.0 — 历史回测引擎
 * ═══════════════════════════════════════════════════════
 * 三模式: A 独立狙击 / B 联动共振 / C BTC领路自动切换
 * 三币种: SOLUSDT + BTCUSDT + ETHUSDT
 *
 * 用法: bun run src/backtest.ts
 */

// ═══════════════════════════════════════════════════════
// 回测专用参数 (MODE=BACKTEST: 阈值降低适配稀疏K线)
// ═══════════════════════════════════════════════════════

const LEVERAGE = 200;
const IMBALANCE_RATIO = 3.5;            // 回测 3.5x (实盘 5.5x)
const BTC_IMBALANCE_RATIO = 3.0;
const SOL_RESONANCE_RATIO = 2.5;
const BTC_AUTO_SWITCH_RATIO = 3.5;
const SOL_MIN_EFFICIENCY = 1.5;
const ETH_MIN_EFFICIENCY = 0.8;
const EFFICIENCY_ABS_THRESHOLD = 1.5;
const STOP_LOSS_PCT = 0.0015;
const BE_TARGET_PCT = 0.0012;
const DUMP_EFF_THRESHOLD = 0.15;
const DUMP_VOL_MULT = 2;
const MIN_PROFIT_FOR_DECAY = 0.003;     // 至少赚 0.3% 才触发效率衰竭止盈
const TAKER_FEE = 0.0004;
const COOLDOWN_BARS = 1;
const MAX_DAILY_TRADES = 10;
const MAX_DAILY_LOSS = 100;
const MARGIN_PER_TRADE = 50;
const INITIAL_CAPITAL = 200;
const ENABLE_MOMENTUM_CHECK = false;    // 回测禁用惯性 (K线无法模拟1.5秒)
const ENABLE_BREAKEVEN_EXIT = false;    // 禁用保本回落 → 让利润奔跑
const MAX_HOLD_BARS = 60;               // 最大持仓 60 根K线 (1小时) 防死扛
const MOMENTUM_MIN_PCT = 0.0005;
const TRADE_HOUR_START = 0;
const TRADE_HOUR_END = 19;
const EFFICIENCY_WINDOW = 100;
const AVG_VOL_WINDOW = 200;
const VOL_SPIKE_MULT = 3;

// ═══════════════════════════════════════════════════════
// 数据结构
// ═══════════════════════════════════════════════════════

interface Kline {
    openTime: number; open: number; high: number; low: number; close: number;
    volume: number; closeTime: number; quoteVolume: number; trades: number;
    takerBuyVol: number; takerBuyQuote: number;
}

interface SimSnapshot {
    price: number; buyDelta: number; sellDelta: number;
    askWallVol: number; bidWallVol: number;
    efficiency: number; avgEfficiency: number;
    avgVol: number; recentVol: number;
    isEfficiencyDecay: boolean; utcHour: number;
}

interface BtcSimSnapshot {
    buyDelta: number; sellDelta: number;
    askWallVol: number; bidWallVol: number;
}

interface TradeResult {
    date: string; entryTime: string; exitTime: string;
    side: "long" | "short"; entryPrice: number; exitPrice: number;
    margin: number; qty: number; grossPnl: number; fee: number; netPnl: number;
    reason: string; mode: "sniper" | "resonance" | "auto-switch";
    targetSymbol: string;
}

interface DailyResult { date: string; trades: number; pnl: number; balance: number; }

// ═══════════════════════════════════════════════════════
// Binance K 线获取
// ═══════════════════════════════════════════════════════

async function fetchKlines(symbol: string, startMs: number, endMs: number): Promise<Kline[]> {
    const allKlines: Kline[] = [];
    let currentStart = startMs;
    while (currentStart < endMs) {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${currentStart}&endTime=${endMs}&limit=1500`;
        const res = await fetch(url);
        if (!res.ok) { await Bun.sleep(5000); continue; }
        const data = (await res.json()) as any[][];
        if (data.length === 0) break;
        for (const k of data) {
            allKlines.push({
                openTime: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4],
                volume: +k[5], closeTime: k[6], quoteVolume: +k[7], trades: +k[8],
                takerBuyVol: +k[9], takerBuyQuote: +k[10],
            });
        }
        currentStart = data[data.length - 1][6] + 1;
        const pct = ((currentStart - startMs) / (endMs - startMs) * 100).toFixed(1);
        process.stdout.write(`\r  📥 ${symbol} ${pct}% | ${allKlines.length}根`);
        await Bun.sleep(200);
    }
    console.log(`\n  ✅ ${symbol} ${allKlines.length} 根K线`);
    return allKlines;
}

// ═══════════════════════════════════════════════════════
// 快照模拟器
// ═══════════════════════════════════════════════════════

class SnapshotSimulator {
    private effRing: number[] = [];
    private volRing: number[] = [];
    private lastPrice = 0;

    convert(k: Kline): SimSnapshot {
        const price = k.close;
        const buyVol = k.takerBuyVol;
        const sellVol = k.volume - k.takerBuyVol;
        const vol = k.volume;
        const priceChange = this.lastPrice > 0 ? Math.abs(price - this.lastPrice) : Math.abs(k.close - k.open);
        const efficiency = vol > 0 ? priceChange / vol : 0;

        this.effRing.push(efficiency);
        if (this.effRing.length > EFFICIENCY_WINDOW) this.effRing.shift();
        this.volRing.push(vol);
        if (this.volRing.length > AVG_VOL_WINDOW) this.volRing.shift();

        const avgEfficiency = this.effRing.reduce((a, b) => a + b, 0) / (this.effRing.length || 1);
        const avgVol = this.volRing.reduce((a, b) => a + b, 0) / (this.volRing.length || 1);
        this.lastPrice = price;

        return {
            price, buyDelta: buyVol, sellDelta: sellVol,
            askWallVol: sellVol * 0.6, bidWallVol: buyVol * 0.6,
            efficiency, avgEfficiency, avgVol, recentVol: vol,
            isEfficiencyDecay: vol > avgVol * VOL_SPIKE_MULT && efficiency < 0.2,
            utcHour: new Date(k.openTime).getUTCHours(),
        };
    }

    reset() { this.effRing = []; this.volRing = []; this.lastPrice = 0; }
}

class BtcSimulator {
    convert(k: Kline): BtcSimSnapshot {
        const b = k.takerBuyVol, s = k.volume - k.takerBuyVol;
        return { buyDelta: b, sellDelta: s, askWallVol: s * 0.6, bidWallVol: b * 0.6 };
    }
}

// ═══════════════════════════════════════════════════════
// 策略 — 三模式 (镜像 strategy.ts v2.0)
// ═══════════════════════════════════════════════════════

function evaluateSignal(
    solSnap: SimSnapshot, btcSnap: BtcSimSnapshot | null, ethSnap: SimSnapshot | null,
): { side: "long" | "short"; reason: string; mode: "sniper" | "resonance" | "auto-switch"; targetSymbol: string; price: number } | null {
    if (solSnap.utcHour < TRADE_HOUR_START || solSnap.utcHour >= TRADE_HOUR_END) return null;
    if (solSnap.askWallVol <= 0 && solSnap.bidWallVol <= 0) return null;
    if (solSnap.avgEfficiency <= 0) return null;

    // 模式 C: BTC 领路自动切换
    if (btcSnap && btcSnap.askWallVol > 0) {
        const btcImb = btcSnap.buyDelta / btcSnap.askWallVol;
        if (btcImb > BTC_AUTO_SWITCH_RATIO) {
            const solEff = solSnap.efficiency;
            const ethEff = ethSnap?.efficiency ?? 0;
            if (solEff > ethEff && solEff > SOL_MIN_EFFICIENCY)
                return { side: "long", reason: `C→SOL BTC=${btcImb.toFixed(1)}x sEff=${solEff.toFixed(4)}`, mode: "auto-switch", targetSymbol: "SOLUSDT", price: solSnap.price };
            if (ethSnap && ethEff > ETH_MIN_EFFICIENCY)
                return { side: "long", reason: `C→ETH BTC=${btcImb.toFixed(1)}x eEff=${ethEff.toFixed(4)}`, mode: "auto-switch", targetSymbol: "ETHUSDT", price: ethSnap.price };
        }
    }
    if (btcSnap && btcSnap.bidWallVol > 0) {
        const btcSellImb = btcSnap.sellDelta / btcSnap.bidWallVol;
        if (btcSellImb > BTC_AUTO_SWITCH_RATIO) {
            const solEff = solSnap.efficiency;
            const ethEff = ethSnap?.efficiency ?? 0;
            if (solEff > ethEff && solEff > SOL_MIN_EFFICIENCY)
                return { side: "short", reason: `C→SOL空 BTC=${btcSellImb.toFixed(1)}x`, mode: "auto-switch", targetSymbol: "SOLUSDT", price: solSnap.price };
            if (ethSnap && ethEff > ETH_MIN_EFFICIENCY)
                return { side: "short", reason: `C→ETH空 BTC=${btcSellImb.toFixed(1)}x`, mode: "auto-switch", targetSymbol: "ETHUSDT", price: ethSnap.price };
        }
    }

    // 模式 B: 联动共振
    if (btcSnap && btcSnap.askWallVol > 0 && solSnap.askWallVol > 0) {
        const bI = btcSnap.buyDelta / btcSnap.askWallVol, sI = solSnap.buyDelta / solSnap.askWallVol;
        if (bI > BTC_IMBALANCE_RATIO && sI > SOL_RESONANCE_RATIO)
            return { side: "long", reason: `B联动 BTC=${bI.toFixed(1)}x SOL=${sI.toFixed(1)}x`, mode: "resonance", targetSymbol: "SOLUSDT", price: solSnap.price };
    }
    if (btcSnap && btcSnap.bidWallVol > 0 && solSnap.bidWallVol > 0) {
        const bI = btcSnap.sellDelta / btcSnap.bidWallVol, sI = solSnap.sellDelta / solSnap.bidWallVol;
        if (bI > BTC_IMBALANCE_RATIO && sI > SOL_RESONANCE_RATIO)
            return { side: "short", reason: `B联动空 BTC=${bI.toFixed(1)}x SOL=${sI.toFixed(1)}x`, mode: "resonance", targetSymbol: "SOLUSDT", price: solSnap.price };
    }

    // 模式 A: SOL 独立狙击
    if (solSnap.askWallVol > 0) {
        const imb = solSnap.buyDelta / solSnap.askWallVol;
        if (imb > IMBALANCE_RATIO && solSnap.efficiency > EFFICIENCY_ABS_THRESHOLD && solSnap.efficiency > solSnap.avgEfficiency)
            return { side: "long", reason: `A狙击 ${imb.toFixed(1)}x eff=${solSnap.efficiency.toFixed(4)}`, mode: "sniper", targetSymbol: "SOLUSDT", price: solSnap.price };
    }
    if (solSnap.bidWallVol > 0) {
        const imb = solSnap.sellDelta / solSnap.bidWallVol;
        if (imb > IMBALANCE_RATIO && solSnap.efficiency > EFFICIENCY_ABS_THRESHOLD && solSnap.efficiency > solSnap.avgEfficiency)
            return { side: "short", reason: `A狙击空 ${imb.toFixed(1)}x`, mode: "sniper", targetSymbol: "SOLUSDT", price: solSnap.price };
    }

    return null;
}

// ═══════════════════════════════════════════════════════
// 持仓
// ═══════════════════════════════════════════════════════

interface Position {
    side: "long" | "short"; entryPrice: number; qty: number; margin: number;
    entryIdx: number; entryTime: number; beTriggered: boolean;
    mode: "sniper" | "resonance" | "auto-switch"; targetSymbol: string;
}

function checkExit(pos: Position, price: number, decay: boolean, nextOpen: number | null, snap: SimSnapshot, holdBars: number) {
    const pct = pos.side === "long" ? (price - pos.entryPrice) / pos.entryPrice : (pos.entryPrice - price) / pos.entryPrice;

    // A. 惯性校验 — 回测禁用
    if (ENABLE_MOMENTUM_CHECK && nextOpen !== null && !pos.beTriggered) {
        const mp = pos.side === "long" ? (nextOpen - pos.entryPrice) / pos.entryPrice : (pos.entryPrice - nextOpen) / pos.entryPrice;
        if (mp < MOMENTUM_MIN_PCT) return { close: true, reason: `惯性 ${(mp * 100).toFixed(4)}%`, exitPrice: nextOpen };
    }
    // B. 物理止损 (死线)
    if (pct <= -STOP_LOSS_PCT) {
        const ep = pos.side === "long" ? pos.entryPrice * (1 - STOP_LOSS_PCT) : pos.entryPrice * (1 + STOP_LOSS_PCT);
        return { close: true, reason: `止损 ${(pct * 100).toFixed(3)}%`, exitPrice: ep };
    }
    // C. 保本锁定标记 (但不出场)
    if (!pos.beTriggered && pct >= BE_TARGET_PCT) pos.beTriggered = true;
    // D. 放量倒货止盈 (至少赚 0.3%)
    if (snap.efficiency < DUMP_EFF_THRESHOLD && snap.recentVol > snap.avgVol * DUMP_VOL_MULT && pct > MIN_PROFIT_FOR_DECAY)
        return { close: true, reason: `倒货 +${(pct * 100).toFixed(3)}%`, exitPrice: price };
    // E. 效率衰竭止盈 (至少赚 0.3%)
    if (decay && pct > MIN_PROFIT_FOR_DECAY)
        return { close: true, reason: `衰竭 +${(pct * 100).toFixed(3)}%`, exitPrice: price };
    // F. 保本后回落 — 「让利润奔跑」模式禁用
    if (ENABLE_BREAKEVEN_EXIT && pos.beTriggered && pct <= 0)
        return { close: true, reason: `保本 ${(pct * 100).toFixed(3)}%`, exitPrice: pos.entryPrice };
    // G. 持仓时间上限 (防死扛)
    if (holdBars >= MAX_HOLD_BARS) {
        const reason = pct > 0 ? `限时止盈 +${(pct * 100).toFixed(3)}%` : `限时止损 ${(pct * 100).toFixed(3)}%`;
        return { close: true, reason, exitPrice: price };
    }
    return null;
}

function calcPnl(pos: Position, ep: number) {
    const pt = pos.side === "long" ? ep - pos.entryPrice : pos.entryPrice - ep;
    const g = pt * pos.qty, f = (pos.entryPrice * pos.qty + ep * pos.qty) * TAKER_FEE;
    return { grossPnl: g, fee: f, netPnl: g - f };
}

// ═══════════════════════════════════════════════════════
// 回测引擎
// ═══════════════════════════════════════════════════════

function runBacktest(solKlines: Kline[], btcKlines: Kline[], ethKlines: Kline[]) {
    const solSim = new SnapshotSimulator();
    const btcSim = new BtcSimulator();
    const ethSim = new SnapshotSimulator();
    const trades: TradeResult[] = [];
    let balance = INITIAL_CAPITAL;
    let pos: Position | null = null;
    let cooldown = 0;
    let curDate = "", dTrades = 0, dPnl = 0;
    const daily: DailyResult[] = [];

    const btcMap = new Map<number, Kline>();
    for (const k of btcKlines) btcMap.set(k.openTime, k);
    const ethMap = new Map<number, Kline>();
    for (const k of ethKlines) ethMap.set(k.openTime, k);

    const warmup = Math.min(200, Math.floor(solKlines.length * 0.05));

    for (let i = 0; i < solKlines.length; i++) {
        const k = solKlines[i];
        const solSnap = solSim.convert(k);
        const dateStr = new Date(k.openTime).toISOString().slice(0, 10);
        const btcK = btcMap.get(k.openTime);
        const btcSnap = btcK ? btcSim.convert(btcK) : null;
        const ethK = ethMap.get(k.openTime);
        const ethSnap = ethK ? ethSim.convert(ethK) : null;

        if (dateStr !== curDate) {
            if (curDate) daily.push({ date: curDate, trades: dTrades, pnl: dPnl, balance });
            curDate = dateStr; dTrades = 0; dPnl = 0;
        }
        if (i < warmup) continue;

        if (pos) {
            // 根据持仓交易对选择价格源
            const priceK = pos.targetSymbol === "ETHUSDT" ? (ethK || k) : k;
            const worst = pos.side === "long" ? priceK.low : priceK.high;
            const best = pos.side === "long" ? priceK.high : priceK.low;
            const snapForExit = pos.targetSymbol === "ETHUSDT" ? (ethSnap || solSnap) : solSnap;
            const nextOpen = (i === pos.entryIdx + 1) ? priceK.open : null;

            const holdBars = i - pos.entryIdx;
            const sl = checkExit(pos, worst, false, nextOpen, snapForExit, holdBars);
            if (sl?.close) {
                const { grossPnl, fee, netPnl } = calcPnl(pos, sl.exitPrice);
                trades.push({ date: dateStr, entryTime: new Date(solKlines[pos.entryIdx].openTime).toISOString(), exitTime: new Date(k.openTime).toISOString(), side: pos.side, entryPrice: pos.entryPrice, exitPrice: sl.exitPrice, margin: pos.margin, qty: pos.qty, grossPnl, fee, netPnl, reason: sl.reason, mode: pos.mode, targetSymbol: pos.targetSymbol });
                balance += netPnl; dTrades++; dPnl += netPnl; cooldown = i + COOLDOWN_BARS; pos = null; continue;
            }

            if (!pos.beTriggered) {
                const bp = pos.side === "long" ? (best - pos.entryPrice) / pos.entryPrice : (pos.entryPrice - best) / pos.entryPrice;
                if (bp >= BE_TARGET_PCT) pos.beTriggered = true;
            }

            const ex = checkExit(pos, snapForExit.price, snapForExit.isEfficiencyDecay, null, snapForExit, i - pos.entryIdx);
            if (ex?.close) {
                const { grossPnl, fee, netPnl } = calcPnl(pos, ex.exitPrice);
                trades.push({ date: dateStr, entryTime: new Date(solKlines[pos.entryIdx].openTime).toISOString(), exitTime: new Date(k.openTime).toISOString(), side: pos.side, entryPrice: pos.entryPrice, exitPrice: ex.exitPrice, margin: pos.margin, qty: pos.qty, grossPnl, fee, netPnl, reason: ex.reason, mode: pos.mode, targetSymbol: pos.targetSymbol });
                balance += netPnl; dTrades++; dPnl += netPnl; cooldown = i + COOLDOWN_BARS; pos = null;
            }
            continue;
        }

        if (i <= cooldown || dTrades >= MAX_DAILY_TRADES || dPnl <= -MAX_DAILY_LOSS || balance < MARGIN_PER_TRADE) continue;

        const sig = evaluateSignal(solSnap, btcSnap, ethSnap);
        if (!sig) continue;

        const margin = Math.min(MARGIN_PER_TRADE, balance);
        const qty = (margin * LEVERAGE) / sig.price;
        pos = { side: sig.side, entryPrice: sig.price, qty, margin, entryIdx: i, entryTime: k.openTime, beTriggered: false, mode: sig.mode, targetSymbol: sig.targetSymbol };
    }

    if (pos && solKlines.length > 0) {
        const lastK = solKlines[solKlines.length - 1];
        const ep = pos.targetSymbol === "ETHUSDT" ? (ethMap.get(lastK.openTime)?.close ?? lastK.close) : lastK.close;
        const { grossPnl, fee, netPnl } = calcPnl(pos, ep);
        trades.push({ date: curDate, entryTime: new Date(solKlines[pos.entryIdx].openTime).toISOString(), exitTime: new Date(lastK.openTime).toISOString(), side: pos.side, entryPrice: pos.entryPrice, exitPrice: ep, margin: pos.margin, qty: pos.qty, grossPnl, fee, netPnl, reason: "月末强平", mode: pos.mode, targetSymbol: pos.targetSymbol });
        balance += netPnl; dTrades++; dPnl += netPnl;
    }
    if (curDate) daily.push({ date: curDate, trades: dTrades, pnl: dPnl, balance });

    return { trades, daily };
}

// ═══════════════════════════════════════════════════════
// 报告
// ═══════════════════════════════════════════════════════

function printReport(month: string, daily: DailyResult[], trades: TradeResult[]) {
    const total = daily.reduce((s, d) => s + d.trades, 0);
    const pnl = daily.reduce((s, d) => s + d.pnl, 0);
    const wins = trades.filter(t => t.netPnl > 0).length;
    const losses = trades.filter(t => t.netPnl <= 0).length;
    const wr = total > 0 ? (wins / total * 100).toFixed(1) : "0";
    const aw = wins > 0 ? (trades.filter(t => t.netPnl > 0).reduce((s, t) => s + t.netPnl, 0) / wins).toFixed(2) : "0";
    const al = losses > 0 ? (trades.filter(t => t.netPnl <= 0).reduce((s, t) => s + t.netPnl, 0) / losses).toFixed(2) : "0";
    const fb = daily.length > 0 ? daily[daily.length - 1].balance : INITIAL_CAPITAL;

    const sniperN = trades.filter(t => t.mode === "sniper").length;
    const resoN = trades.filter(t => t.mode === "resonance").length;
    const autoN = trades.filter(t => t.mode === "auto-switch").length;
    const solN = trades.filter(t => t.targetSymbol === "SOLUSDT").length;
    const ethN = trades.filter(t => t.targetSymbol === "ETHUSDT").length;

    console.log(`\n${"═".repeat(70)}`);
    console.log(`  📊 ${month} | $${INITIAL_CAPITAL} | ${LEVERAGE}x | SOL Sniper v2.0`);
    console.log(`${"═".repeat(70)}`);
    console.log(`  日期          | 交易 | 日PnL($)    | 余额($)`);
    console.log(`  ${"-".repeat(55)}`);
    for (const d of daily) {
        const ps = d.pnl >= 0 ? `+${d.pnl.toFixed(2)}` : d.pnl.toFixed(2);
        console.log(`  ${d.date}   |  ${String(d.trades).padStart(2)}  | ${ps.padStart(10)} | ${d.balance.toFixed(2).padStart(10)}`);
    }
    console.log(`  ${"-".repeat(55)}`);
    const ps = pnl >= 0 ? `+${pnl.toFixed(2)}` : pnl.toFixed(2);
    console.log(`  月计          | ${String(total).padStart(3)}  | ${ps.padStart(10)} | ${fb.toFixed(2).padStart(10)}`);
    console.log(`\n  胜率: ${wr}% (${wins}W/${losses}L) | 均盈$${aw} 均亏$${al}`);
    console.log(`  模式: A狙击=${sniperN} B联动=${resoN} C切换=${autoN}`);
    console.log(`  交易对: SOL=${solN} ETH=${ethN}`);

    const reasons: Record<string, number> = {};
    for (const t of trades) { const k = t.reason.replace(/[+-]?\d+\.\d+%?/g, "X").trim(); reasons[k] = (reasons[k] || 0) + 1; }
    console.log(`\n  出场:`);
    for (const [r, c] of Object.entries(reasons).sort((a, b) => b[1] - a[1]))
        console.log(`    ${String(c).padStart(3)}x | ${r}`);
}

// ═══════════════════════════════════════════════════════
// 主程序
// ═══════════════════════════════════════════════════════

async function main() {
    console.log("════════════════════════════════════════════════════════");
    console.log("  🧪 SOL Sniper v2.0 回测 | 三模式 三币种 | 2026年1-3月");
    console.log("════════════════════════════════════════════════════════\n");

    const months = [
        { label: "2026年1月", start: "2026-01-01T00:00:00Z", end: "2026-01-31T23:59:59Z" },
        { label: "2026年2月", start: "2026-02-01T00:00:00Z", end: "2026-02-28T23:59:59Z" },
        { label: "2026年3月", start: "2026-03-01T00:00:00Z", end: "2026-03-13T23:59:59Z" },
    ];

    const all: { label: string; daily: DailyResult[]; trades: TradeResult[] }[] = [];

    for (const m of months) {
        const s = new Date(m.start).getTime(), e = new Date(m.end).getTime();
        console.log(`\n📅 ${m.label}...`);
        const solK = await fetchKlines("SOLUSDT", s, e);
        const btcK = await fetchKlines("BTCUSDT", s, e);
        const ethK = await fetchKlines("ETHUSDT", s, e);
        if (solK.length === 0) { console.log(`  ⚠️ 无数据`); continue; }

        console.log(`  🔬 回测中 (SOL+BTC+ETH)...`);
        const r = runBacktest(solK, btcK, ethK);
        all.push({ label: m.label, ...r });
        printReport(m.label, r.daily, r.trades);
    }

    console.log(`\n${"═".repeat(70)}`);
    console.log("  📊 总结 — SOL Sniper v2.0");
    console.log(`${"═".repeat(70)}`);
    let gT = 0, gP = 0;
    for (const m of all) {
        const mt = m.daily.reduce((s, d) => s + d.trades, 0);
        const mp = m.daily.reduce((s, d) => s + d.pnl, 0);
        const fb = m.daily.length > 0 ? m.daily[m.daily.length - 1].balance : INITIAL_CAPITAL;
        gT += mt; gP += mp;
        const sN = m.trades.filter(t => t.mode === "sniper").length;
        const rN = m.trades.filter(t => t.mode === "resonance").length;
        const aN = m.trades.filter(t => t.mode === "auto-switch").length;
        const ps = mp >= 0 ? `+${mp.toFixed(2)}` : mp.toFixed(2);
        console.log(`  ${m.label}: ${mt}笔 (A=${sN} B=${rN} C=${aN}) | ${ps} | $${fb.toFixed(2)}`);
    }
    const gps = gP >= 0 ? `+${gP.toFixed(2)}` : gP.toFixed(2);
    console.log(`  ──────────────────────────────────────`);
    console.log(`  总计: ${gT}笔 | ${gps} (每月重置$200)\n`);
}

main().catch(console.error);
