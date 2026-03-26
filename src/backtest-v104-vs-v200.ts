/**
 * 📊 V104 vs V200 — 3/24 昨日对比回测
 * V104: Fire Candle (UTC 08-12判方向 → 12-22诱导回踩)
 * V200: 五模组 (时间过滤+POC位移+进场触发+均波TP+凯利风控)
 */

const FEE = 0.0004, CAP = 500, LEV = 150;
interface K { ts: number; o: number; h: number; l: number; c: number; v: number; }

async function fetchK(sym: string, iv: string, s: number, e: number): Promise<K[]> {
    const all: K[] = []; let cur = s;
    while (cur < e) {
        const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${iv}&startTime=${cur}&endTime=${e}&limit=1500`;
        const r = await fetch(url); if (!r.ok) { await Bun.sleep(3000); continue; }
        const d = (await r.json()) as any[][]; if (!d.length) break;
        for (const k of d) all.push({ ts: k[0] as number, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
        cur = (d[d.length - 1][6] as number) + 1; await Bun.sleep(150);
    }
    return all;
}

interface Trade { side: string; entry: number; exit: number; pt: number; net: number; reason: string; time: string; qty: number; }

// ═══════════════════════════════════════════════════════════════
// V104 Fire Candle 策略
// ═══════════════════════════════════════════════════════════════

function runV104(kl5m: K[], kl1h: K[], qty: number): { trades: Trade[]; pnl: number } {
    const trades: Trade[] = [];
    const FC_START = 8, FC_END = 12; // UTC Fire Candle 窗口
    const T_START = 12, T_END = 22;  // UTC 交易窗口
    const MIN_BODY_R = 0.4;
    const TURTLE_BARS = 3;
    const MAX_HOLD = 60; // 5m bars

    // 找 Fire Candle (当天 08-12 UTC)
    const dayBars1h = kl1h.filter(k => {
        const h = new Date(k.ts).getUTCHours();
        return h >= FC_START && h < FC_END;
    });
    if (dayBars1h.length < 2) return { trades, pnl: 0 };

    const fcO = dayBars1h[0].o, fcC = dayBars1h[dayBars1h.length - 1].c;
    const fcH = Math.max(...dayBars1h.map(k => k.h));
    const fcL = Math.min(...dayBars1h.map(k => k.l));
    const body = Math.abs(fcC - fcO), range = fcH - fcL;
    if (range < 1) return { trades, pnl: 0 };
    const bodyR = body / range;

    let dir: "long" | "short" | "skip" = "skip";
    if (bodyR >= MIN_BODY_R) dir = fcC > fcO ? "long" : "short";
    if (dir === "skip") return { trades, pnl: 0 };

    // 交易窗口 12-22 UTC
    const after = kl5m.filter(k => {
        const h = new Date(k.ts).getUTCHours();
        return h >= T_START && h <= T_END;
    });
    if (after.length < 5) return { trades, pnl: 0 };

    // 诱导回踩入场
    let ep = 0, sweepLow = 0, sweepHigh = 0, entryIdx = -1;
    let manipulated = false;

    for (let i = 1; i < after.length; i++) {
        const bar = after[i];
        if (ep > 0) break;
        if (dir === "long") {
            if (!manipulated && bar.l < fcC) manipulated = true;
            if (manipulated) {
                const lookback = after.slice(Math.max(0, i - TURTLE_BARS), i + 1);
                const recentLow = Math.min(...lookback.map(k => k.l));
                if (bar.c > fcC && bar.c > bar.o) {
                    ep = bar.c; sweepLow = recentLow; entryIdx = i;
                }
            }
        } else {
            if (!manipulated && bar.h > fcC) manipulated = true;
            if (manipulated) {
                const lookback = after.slice(Math.max(0, i - TURTLE_BARS), i + 1);
                const recentHigh = Math.max(...lookback.map(k => k.h));
                if (bar.c < fcC && bar.c < bar.o) {
                    ep = bar.c; sweepHigh = recentHigh; entryIdx = i;
                }
            }
        }
    }
    if (ep === 0) return { trades, pnl: 0 };

    // SL = 4H Low/High
    const sl = dir === "long" ? fcL - 1 : fcH + 1;
    const risk = dir === "long" ? ep - sl : sl - ep;
    if (risk <= 0 || risk > 500) return { trades, pnl: 0 };
    const tp = dir === "long" ? ep + risk * 2 : ep - risk * 2; // 2R TP

    // 模拟持仓
    const startIdx = kl5m.findIndex(k => k.ts === after[entryIdx].ts);
    if (startIdx < 0) return { trades, pnl: 0 };

    let exitP = 0, reason = "", bestPt = 0;
    for (let j = startIdx + 1; j < kl5m.length && j - startIdx < MAX_HOLD; j++) {
        const bar = kl5m[j];
        const pt = dir === "long" ? bar.c - ep : ep - bar.c;
        if (pt > bestPt) bestPt = pt;

        if (dir === "long") {
            if (bar.l <= sl) { exitP = sl; reason = "SL"; break; }
            if (bar.h >= tp) { exitP = tp; reason = "TP"; break; }
        } else {
            if (bar.h >= sl) { exitP = sl; reason = "SL"; break; }
            if (bar.l <= tp) { exitP = tp; reason = "TP"; break; }
        }
    }
    if (exitP === 0) {
        exitP = kl5m[Math.min(startIdx + MAX_HOLD - 1, kl5m.length - 1)].c;
        reason = "TIMEOUT";
    }

    const pt = dir === "long" ? exitP - ep : ep - exitP;
    const fee = (ep * qty + exitP * qty) * FEE;
    const net = pt * qty - fee;
    const entryTime = new Date(after[entryIdx].ts).toISOString().slice(11, 16);
    trades.push({ side: dir, entry: ep, exit: exitP, pt, net, reason, time: entryTime, qty });

    return { trades, pnl: trades.reduce((a, t) => a + t.net, 0) };
}

// ═══════════════════════════════════════════════════════════════
// V200 五模组策略
// ═══════════════════════════════════════════════════════════════

interface TradeWindow { name: string; startH: number; endH: number; isAsian: boolean; }

const TRADE_WINDOWS: TradeWindow[] = [
    { name: "亚盘确立", startH: 9, endH: 10, isAsian: true },     // UTC+8 09-10 → UTC 01-02
    { name: "规律最强", startH: 15, endH: 16, isAsian: false },   // UTC+8 15-16 → UTC 07-08
    { name: "波动峰值A", startH: 20, endH: 22, isAsian: false },  // UTC+8 20-22 → UTC 12-14
    { name: "波动峰值B", startH: 22, endH: 24, isAsian: false },  // UTC+8 22-24 → UTC 14-16
];

function utc8Hour(ts: number): number { return new Date(ts + 8 * 3600000).getUTCHours(); }
function utc8Date(ts: number): string { return new Date(ts + 8 * 3600000).toISOString().slice(0, 10); }

function calcPOC(k: K): number { return (k.h + k.l + k.c) / 3; }

function runV200(kl5m: K[], k1h: K[], k4h: K[]): { trades: Trade[]; pnl: number; pocLog: string[] } {
    const trades: Trade[] = [];
    const pocLog: string[] = [];
    let bal = CAP;
    const usedWindows = new Set<string>();

    // 共用参数
    const MAX_HOLD_BARS = 36; // 3小时 = 36根5m

    // avgH1Range — 只用入场前的 1h 数据
    const avgRange = k1h.length >= 14
        ? k1h.slice(-14).reduce((s, k) => s + (k.h - k.l), 0) / 14 : 30;
    const tpPt = avgRange * 0.7;

    for (let i = 50; i < kl5m.length; i++) {
        const k = kl5m[i];
        const h = utc8Hour(k.ts);
        const day = utc8Date(k.ts);

        // 模组一: 噪音过滤 (08-09 UTC+8)
        if (h >= 8 && h < 9) continue;

        // 检查交易窗口
        let activeWindow: TradeWindow | null = null;
        for (const w of TRADE_WINDOWS) {
            if (h >= w.startH && h < w.endH) { activeWindow = w; break; }
        }
        if (!activeWindow) continue;

        const winKey = `${day}_${activeWindow.name}`;
        if (usedWindows.has(winKey)) continue;

        // ═══ 模组二: POC 方向 (逐 bar 实时计算) ═══
        // 只用入场时刻已完全关闭的 4H K线 (closeTs <= 当前 bar 开盘时间)
        const closedK4h = k4h.filter(kk => kk.ts + 4 * 3600000 <= k.ts);
        let pocDir = "";
        let pocShift = 0;
        if (closedK4h.length >= 2) {
            const lastClosed = closedK4h[closedK4h.length - 1];
            const prevClosed = closedK4h[closedK4h.length - 2];
            pocShift = calcPOC(lastClosed) - calcPOC(prevClosed);
            if (pocShift > 5) pocDir = "long";
            else if (pocShift < -5) pocDir = "short";
        }

        if (!pocDir) continue;
        let dir: "long" | "short" = pocDir as any;

        // 定性定量确认 (最近3根5m)
        let avgVol = 0;
        for (let j = i - 20; j < i; j++) if (j >= 0) avgVol += kl5m[j].v;
        avgVol /= 20;
        let aggConflict = false;
        for (let j = i - 2; j <= i; j++) {
            if (j < 0) continue;
            const bar = kl5m[j];
            const body = Math.abs(bar.c - bar.o);
            const range = bar.h - bar.l;
            if (range > 1 && body / range > 0.7 && bar.v > avgVol * 1.5) {
                const aggDir = bar.c > bar.o ? "long" : "short";
                if (aggDir !== dir) { aggConflict = true; break; }
            }
        }
        if (aggConflict) continue;

        // 模组三: 进场触发
        const prev = kl5m[i - 1];
        let triggered = false;
        let triggerName = "";

        // 攻击日
        const prevRange = prev.h - prev.l;
        if (prevRange >= 2) {
            const prevUS = prev.h - Math.max(prev.o, prev.c);
            const prevLS = Math.min(prev.o, prev.c) - prev.l;
            const currBody = Math.abs(k.c - k.o);
            const currRange = k.h - k.l;
            if (dir === "short" && prevUS / prevRange > 0.4 && k.c < prev.l && currBody / (currRange + 0.01) > 0.5) {
                triggered = true; triggerName = "攻击日";
            }
            if (dir === "long" && prevLS / prevRange > 0.4 && k.c > prev.h && currBody / (currRange + 0.01) > 0.5) {
                triggered = true; triggerName = "攻击日";
            }
        }

        // 引线回补
        if (!triggered && i >= 3) {
            const prev2 = kl5m[i - 2];
            const prev2LS = Math.min(prev2.o, prev2.c) - prev2.l;
            const prev2Body = Math.abs(prev2.c - prev2.o);
            if (dir === "long" && prev2LS > prev2Body * 0.5 && prev2LS > 2) {
                if (prev.l < prev2.l && k.c > Math.min(prev2.o, prev2.c) && k.c > k.o) {
                    triggered = true; triggerName = "引线回补";
                }
            }
            const prev2US = prev2.h - Math.max(prev2.o, prev2.c);
            if (dir === "short" && prev2US > prev2Body * 0.5 && prev2US > 2) {
                if (prev.h > prev2.h && k.c < Math.max(prev2.o, prev2.c) && k.c < k.o) {
                    triggered = true; triggerName = "引线回补";
                }
            }
        }

        // 支撑/阻力测试
        if (!triggered && i >= 21) {
            const lookback = kl5m.slice(i - 20, i);
            let minL = Infinity, maxH = 0;
            for (const bar of lookback) { if (bar.l < minL) minL = bar.l; if (bar.h > maxH) maxH = bar.h; }
            let st = 0, rt = 0;
            for (const bar of lookback) {
                if (Math.abs(bar.l - minL) < 3) st++;
                if (Math.abs(bar.h - maxH) < 3) rt++;
            }
            if (dir === "long" && st >= 3 && Math.abs(k.l - minL) < 5) {
                triggered = true; triggerName = `支撑x${st}`;
            }
            if (dir === "short" && rt >= 3 && Math.abs(k.h - maxH) < 5) {
                triggered = true; triggerName = `阻力x${rt}`;
            }
        }

        if (!triggered) continue;
        if (avgVol > 0 && k.v < avgVol * 0.8) continue;

        // ═══ 当前4H方向对齐过滤 ═══
        const inProgressK4h = k4h.filter(kk => kk.ts <= k.ts && kk.ts + 4 * 3600000 > k.ts);
        const ref4h = closedK4h[closedK4h.length - 1];
        const range4h = ref4h.h - ref4h.l;
        const pricePos = range4h > 0 ? (k.c - ref4h.l) / range4h : 0.5;
        if (inProgressK4h.length > 0) {
            const curr4h = inProgressK4h[0];
            const curr4hBars = kl5m.filter(b => b.ts >= curr4h.ts && b.ts <= k.ts);
            if (curr4hBars.length >= 3) {
                const curr4hOpen = curr4hBars[0].o;
                const curr4hClose = curr4hBars[curr4hBars.length - 1].c;
                const curr4hMove = curr4hClose - curr4hOpen; // 正=涨 负=跌
                const curr4hDir = curr4hMove > 0 ? "long" : "short";
                const moveSize = Math.abs(curr4hMove);
                
                // 只拦截浅幅矛盾（移动 < 均波50%）
                // 如果已超跌/超涨（移动 ≥ 均波50%），允许逆势入场（均值回归）
                if (curr4hDir !== dir && moveSize < tpPt * 0.7) {
                    pocLog.push(`  ${new Date(k.ts + 8 * 3600000).toISOString().slice(11, 16)} ❌ 拦截 ${dir.toUpperCase()}: 当前4H ${curr4hDir.toUpperCase()} ${moveSize.toFixed(0)}pt 与POC矛盾`);
                    continue;
                }
            }
        }

        // 记录 POC 判断过程
        const lastC = closedK4h[closedK4h.length - 1];
        const prevC = closedK4h[closedK4h.length - 2];
        const utc8Ts = (ts: number) => new Date(ts + 8 * 3600000).toISOString().slice(11, 16);
        pocLog.push(`  ${utc8Ts(k.ts)} 入场 | 已关闭4H: ${utc8Ts(prevC.ts)}→${utc8Ts(lastC.ts)} POC=${calcPOC(prevC).toFixed(0)}→${calcPOC(lastC).toFixed(0)} 位移=${pocShift >= 0 ? "+" : ""}${pocShift.toFixed(1)}pt → ${dir.toUpperCase()} | 价格$${k.c.toFixed(0)} 4H[${ref4h.l.toFixed(0)}-${ref4h.h.toFixed(0)}] pos=${(pricePos*100).toFixed(0)}%`);

        // 模组五: 2% SL
        const slPt = Math.max(10, Math.min(bal * 0.02, 40));
        const qty = Math.min(Math.max(0.1, (bal * 0.10) / slPt), 5.0);

        // 模拟持仓
        let exitP = 0, reason = "";
        const entryPrice = k.c;

        for (let j = i + 1; j < kl5m.length && j - i < MAX_HOLD_BARS; j++) {
            const bar = kl5m[j];
            const pt = dir === "long" ? bar.c - entryPrice : entryPrice - bar.c;
            const ptWorst = dir === "long" ? bar.l - entryPrice : entryPrice - bar.h;

            // 硬止损
            if (ptWorst <= -slPt) {
                exitP = dir === "long" ? entryPrice - slPt : entryPrice + slPt;
                reason = "SL"; break;
            }
            // 均波 TP
            if (pt >= tpPt) { exitP = bar.c; reason = "AVG_TP"; break; }

            // 亚盘12:00强平
            if (activeWindow.isAsian && utc8Hour(bar.ts) >= 12) {
                exitP = bar.c; reason = "NOON"; break;
            }
        }

        // 3H超时
        if (exitP === 0) {
            exitP = kl5m[Math.min(i + MAX_HOLD_BARS - 1, kl5m.length - 1)].c;
            reason = "3H_TIMEOUT";
        }

        usedWindows.add(winKey);
        const pt = dir === "long" ? exitP - entryPrice : entryPrice - exitP;
        const fee = (entryPrice * qty + exitP * qty) * FEE;
        const net = pt * qty - fee;
        bal += net;

        const entryTime = new Date(k.ts).toISOString().slice(11, 16);
        trades.push({ side: dir, entry: entryPrice, exit: exitP, pt, net, reason, time: entryTime, qty: Math.floor(qty * 10) / 10 });
    }

    return { trades, pnl: trades.reduce((a, t) => a + t.net, 0), pocLog };
}

// ═══════════════════════════════════════════════════════════════
// 主程序
// ═══════════════════════════════════════════════════════════════

async function main() {
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log("  📊 V104 Fire Candle vs V200 五模组 — 3/24 昨日对比");
    console.log("  ETHUSDT | $500 | 150x | 2026-03-24");
    console.log("═══════════════════════════════════════════════════════════════════\n");

    // 3/24 一整天
    const dayStart = new Date("2026-03-24T00:00:00Z").getTime();
    const dayEnd = new Date("2026-03-25T00:00:00Z").getTime();

    console.log("📥 拉取 5m K线...");
    const kl5m = await fetchK("ETHUSDT", "5m", dayStart - 6 * 3600000, dayEnd);
    console.log(`  5m: ${kl5m.length} 根`);

    console.log("📥 拉取 1h K线...");
    const k1h = await fetchK("ETHUSDT", "1h", dayStart - 7 * 86400000, dayEnd);
    console.log(`  1h: ${k1h.length} 根`);

    console.log("📥 拉取 4h K线...");
    const k4h = await fetchK("ETHUSDT", "4h", dayStart - 14 * 86400000, dayEnd);
    console.log(`  4h: ${k4h.length} 根`);

    // 3/24 的 1h 子集 (V104)
    const k1h_324 = k1h.filter(k => {
        const d = new Date(k.ts).toISOString().slice(0, 10);
        return d === "2026-03-24";
    });

    // 3/24 的 5m 子集
    const kl5m_324 = kl5m.filter(k => k.ts >= dayStart && k.ts < dayEnd);

    console.log(`  3/24 子集: 1h=${k1h_324.length} 5m=${kl5m_324.length}\n`);

    // ═══ V104 ═══
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log("  🔥 V104 Fire Candle");
    console.log("═══════════════════════════════════════════════════════════════════");

    // 先看 Fire Candle 信号
    const fcBars = k1h_324.filter(k => {
        const h = new Date(k.ts).getUTCHours();
        return h >= 8 && h < 12;
    });
    if (fcBars.length >= 2) {
        const fcO = fcBars[0].o, fcC = fcBars[fcBars.length - 1].c;
        const fcH = Math.max(...fcBars.map(k => k.h)), fcL = Math.min(...fcBars.map(k => k.l));
        const body = Math.abs(fcC - fcO), range = fcH - fcL;
        const bodyR = range > 0 ? body / range : 0;
        console.log(`  Fire Candle (08-12 UTC): O=${fcO.toFixed(1)} C=${fcC.toFixed(1)}`);
        console.log(`  H=${fcH.toFixed(1)} L=${fcL.toFixed(1)} | Body/Range=${(bodyR * 100).toFixed(0)}%`);
        console.log(`  方向: ${bodyR >= 0.4 ? (fcC > fcO ? "📈 LONG" : "📉 SHORT") : "⏸️ 实体不足"}`);
    } else {
        console.log("  ⚠️ 08-12 UTC 数据不足");
    }

    const v104 = runV104(kl5m, k1h_324, 2.0); // V104 固定 2ETH
    console.log(`\n  笔数: ${v104.trades.length} | 净利: $${v104.pnl >= 0 ? "+" : ""}${v104.pnl.toFixed(2)}`);
    if (v104.trades.length > 0) {
        console.log("  ────────────────────────────────────────────────────────────");
        console.log("  时间  | 方向  | 仓位  | 入场      | 出场      | 点数     | 净盈亏    | 出场");
        console.log("  " + "─".repeat(75));
        for (const t of v104.trades) {
            console.log(
                `  ${t.time} | ${t.side.padEnd(5)} | ${t.qty.toFixed(1)}E | ` +
                `$${t.entry.toFixed(1).padStart(7)} | $${t.exit.toFixed(1).padStart(7)} | ` +
                `${(t.pt >= 0 ? "+" : "") + t.pt.toFixed(1).padStart(7)} | ` +
                `$${(t.net >= 0 ? "+" : "") + t.net.toFixed(1).padStart(7)} | ${t.reason}`
            );
        }
    } else {
        console.log("  ⚠️ 无交易信号");
    }

    // ═══ V200 ═══
    console.log("\n═══════════════════════════════════════════════════════════════════");
    console.log("  🤖 V200 五模组 Bot");
    console.log("═══════════════════════════════════════════════════════════════════");

    // POC 方向 — 不再显示错误的全局值
    console.log(`  ⚠️ POC 改为逐 bar 实时计算 (修复未来窥视)`);

    const v200 = runV200(kl5m, k1h, k4h);

    // 显示 POC 判断过程
    if (v200.pocLog.length > 0) {
        console.log(`\n  📐 逐笔 POC 判断:`);
        for (const log of v200.pocLog) console.log(log);
    }

    console.log(`\n  笔数: ${v200.trades.length} | 净利: $${v200.pnl >= 0 ? "+" : ""}${v200.pnl.toFixed(2)}`);
    if (v200.trades.length > 0) {
        console.log("  ────────────────────────────────────────────────────────────");
        console.log("  时间  | 方向  | 仓位  | 入场      | 出场      | 点数     | 净盈亏    | 出场     | 触发");
        console.log("  " + "─".repeat(85));
        for (const t of v200.trades) {
            console.log(
                `  ${t.time} | ${t.side.padEnd(5)} | ${t.qty.toFixed(1)}E | ` +
                `$${t.entry.toFixed(1).padStart(7)} | $${t.exit.toFixed(1).padStart(7)} | ` +
                `${(t.pt >= 0 ? "+" : "") + t.pt.toFixed(1).padStart(7)} | ` +
                `$${(t.net >= 0 ? "+" : "") + t.net.toFixed(1).padStart(7)} | ${t.reason}`
            );
        }
    } else {
        console.log("  ⚠️ 无交易信号");
    }

    // ═══ 对比 ═══
    console.log("\n═══════════════════════════════════════════════════════════════════");
    console.log("  📊 3/24 对比总结");
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log("  策略     | 笔数 | 净利       | 均盈亏");
    console.log("  " + "─".repeat(50));

    const v104Avg = v104.trades.length > 0 ? v104.pnl / v104.trades.length : 0;
    const v200Avg = v200.trades.length > 0 ? v200.pnl / v200.trades.length : 0;
    const v104Mark = v104.pnl > v200.pnl ? " 🏆" : "";
    const v200Mark = v200.pnl > v104.pnl ? " 🏆" : "";

    console.log(
        `  V104     | ${String(v104.trades.length).padStart(4)} | $${(v104.pnl >= 0 ? "+" : "") + v104.pnl.toFixed(0).padStart(7)} | $${v104Avg.toFixed(1).padStart(6)}/笔${v104Mark}`
    );
    console.log(
        `  V200     | ${String(v200.trades.length).padStart(4)} | $${(v200.pnl >= 0 ? "+" : "") + v200.pnl.toFixed(0).padStart(7)} | $${v200Avg.toFixed(1).padStart(6)}/笔${v200Mark}`
    );

    console.log(`\n${"═".repeat(70)}\n`);
}

main().catch(console.error);
export {};
