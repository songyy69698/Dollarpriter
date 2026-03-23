/**
 * 🎯 V10 三步结构转变入场回测
 *
 * V96缺陷: 一根阳线收回Close = 太粗糙
 * V10精准入场:
 *   做多: ①价格跌破Close做操纵低点 ②反弹后回踩不破低(Higher Low) ③突破反弹高点 = 入场
 *   做空: ①价格涨破Close做操纵高点 ②回落后反弹不破高(Lower High) ③跌破回落低点 = 入场
 *
 * $500 | ETH | 每笔亏$25-50
 */
const FEE = 0.0004, CAP = 500;
interface K { ts: number; o: number; h: number; l: number; c: number; v: number; }
async function fetchK(s: string, iv: string, st: number, e: number): Promise<K[]> {
    const a: K[] = []; let c = st;
    while (c < e) { const u = `https://api.binance.com/api/v3/klines?symbol=${s}&interval=${iv}&startTime=${c}&endTime=${e}&limit=1500`;
        const r = await fetch(u); if (!r.ok) { await Bun.sleep(5000); continue; } const d = await r.json() as any[][]; if (!d.length) break;
        for (const k of d) a.push({ ts: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }); c = d[d.length - 1][6] + 1; await Bun.sleep(150); } return a; }

interface Fire { date: string; h: number; l: number; o: number; c: number; bodyR: number; range: number; dir: "long" | "short"; }
function findFires(kl: K[]): Fire[] {
    const f: Fire[] = []; const dm = new Map<string, K[]>();
    for (const k of kl) { const d = new Date(k.ts).toISOString().slice(0, 10); if (!dm.has(d)) dm.set(d, []); dm.get(d)!.push(k); }
    for (const [dt, bars] of dm) {
        const w = bars.filter(k => { const h = new Date(k.ts).getUTCHours(); return h >= 8 && h < 12; });
        if (w.length < 2) continue;
        const o = w[0].o, c = w[w.length - 1].c, h = Math.max(...w.map(k => k.h)), l = Math.min(...w.map(k => k.l));
        const body = Math.abs(c - o), range = h - l; if (range < 3) continue;
        const dir = c > o ? "long" as const : "short" as const;
        f.push({ date: dt, h, l, o, c, bodyR: body / range, range, dir });
    } return f;
}

/**
 * V10 三步结构转变入场 (做多)
 * Step 1: 价格跌破Close → 记录manipLow (操纵低点)
 * Step 2: 价格反弹 → 记录bouncHigh → 回踩不破manipLow → Higher Low确认
 * Step 3: 价格突破bounceHigh → 入场做多
 */
function findV10Entry(bars: K[], close: number, dir: "long" | "short"): { ep: number; idx: number; manipExt: number } | null {
    // 状态机
    let phase: "WAIT_MANIP" | "WAIT_BOUNCE" | "WAIT_HL" | "WAIT_BREAK" = "WAIT_MANIP";
    let manipExt = 0;    // 操纵极值
    let bounceExt = 0;   // 反弹极值
    let hlConfirmed = false;

    for (let i = 1; i < bars.length; i++) {
        const b = bars[i];

        if (dir === "long") {
            switch (phase) {
                case "WAIT_MANIP":
                    // Step 1: 等价格跌破Close
                    if (b.l < close) {
                        manipExt = b.l;
                        phase = "WAIT_BOUNCE";
                    }
                    break;
                case "WAIT_BOUNCE":
                    // 更新操纵低点
                    if (b.l < manipExt) manipExt = b.l;
                    // Step 2: 价格反弹到Close上方 → 记录bounceHigh
                    if (b.h > close) {
                        bounceExt = b.h;
                        phase = "WAIT_HL";
                    }
                    break;
                case "WAIT_HL":
                    // 更新反弹高点
                    if (b.h > bounceExt) bounceExt = b.h;
                    // 价格回踩: 检查是否形成Higher Low
                    if (b.l < manipExt) {
                        // 破了操纵低点 → 结构失效 → 重置，新的manipLow
                        manipExt = b.l;
                        bounceExt = 0;
                        phase = "WAIT_BOUNCE";
                    } else if (b.l > manipExt && b.c < bounceExt) {
                        // 回踩但没破低 → Higher Low形成
                        hlConfirmed = true;
                        phase = "WAIT_BREAK";
                    }
                    break;
                case "WAIT_BREAK":
                    // Step 3: 突破bounceHigh → 入场
                    if (b.c > bounceExt && b.c > b.o) {
                        return { ep: b.c, idx: i, manipExt };
                    }
                    // 如果又跌破manipLow → 结构彻底失败
                    if (b.l < manipExt) {
                        manipExt = b.l;
                        bounceExt = 0;
                        hlConfirmed = false;
                        phase = "WAIT_BOUNCE";
                    }
                    break;
            }
        } else { // SHORT - 镜像逻辑
            switch (phase) {
                case "WAIT_MANIP":
                    if (b.h > close) {
                        manipExt = b.h;
                        phase = "WAIT_BOUNCE";
                    }
                    break;
                case "WAIT_BOUNCE":
                    if (b.h > manipExt) manipExt = b.h;
                    if (b.l < close) {
                        bounceExt = b.l;
                        phase = "WAIT_HL";
                    }
                    break;
                case "WAIT_HL":
                    if (b.l < bounceExt) bounceExt = b.l;
                    if (b.h > manipExt) {
                        manipExt = b.h;
                        bounceExt = 0;
                        phase = "WAIT_BOUNCE";
                    } else if (b.h < manipExt && b.c > bounceExt) {
                        // Lower High形成
                        hlConfirmed = true;
                        phase = "WAIT_BREAK";
                    }
                    break;
                case "WAIT_BREAK":
                    if (b.c < bounceExt && b.c < b.o) {
                        return { ep: b.c, idx: i, manipExt };
                    }
                    if (b.h > manipExt) {
                        manipExt = b.h;
                        bounceExt = 0;
                        hlConfirmed = false;
                        phase = "WAIT_BOUNCE";
                    }
                    break;
            }
        }
    }
    return null;
}

/** V96原版入场 (对照组) */
function findV96Entry(bars: K[], close: number, dir: "long" | "short"): { ep: number; idx: number; manipExt: number } | null {
    let manip = false, manipExt = 0;
    for (let i = 1; i < bars.length; i++) {
        const b = bars[i];
        if (dir === "long") {
            if (!manip && b.l < close) { manip = true; manipExt = b.l; }
            if (manip) { if (b.l < manipExt) manipExt = b.l;
                if (b.c > close && b.c > b.o && bars[i - 1].c < close) return { ep: b.c, idx: i, manipExt };
            }
        } else {
            if (!manip && b.h > close) { manip = true; manipExt = b.h; }
            if (manip) { if (b.h > manipExt) manipExt = b.h;
                if (b.c < close && b.c < b.o && bars[i - 1].c > close) return { ep: b.c, idx: i, manipExt };
            }
        }
    }
    return null;
}

interface Cfg { name: string; entryMode: "v96" | "v10"; riskPct: number; tpR: number; slMode: "4hLow" | "manipLow"; }
interface Res { cfg: Cfg; t: number; w: number; pnl: number; wr: number; dd: number; pf: number; fb: number; m: Record<string, number>; d: number; }

function run(k5: K[], fires: Fire[], cfg: Cfg): Res {
    const trades: { net: number; date: string }[] = []; let bal = CAP, maxB = CAP, maxDD = 0; const months: Record<string, number> = {};
    for (const f of fires) {
        const after = k5.filter(k => { const d = new Date(k.ts); return d.toISOString().slice(0, 10) === f.date && d.getUTCHours() >= 12 && d.getUTCHours() <= 20; });
        if (after.length < 10) continue;

        const entry = cfg.entryMode === "v10" ? findV10Entry(after, f.c, f.dir) : findV96Entry(after, f.c, f.dir);
        if (!entry) continue;

        // SL
        let sl: number;
        if (cfg.slMode === "manipLow") {
            sl = f.dir === "long" ? entry.manipExt - 1 : entry.manipExt + 1;
        } else {
            sl = f.dir === "long" ? f.l - 1 : f.h + 1;
        }
        const risk = f.dir === "long" ? entry.ep - sl : sl - entry.ep;
        if (risk <= 0 || risk > 500) continue;
        const tp = f.dir === "long" ? entry.ep + risk * cfg.tpR : entry.ep - risk * cfg.tpR;
        const rA = bal * cfg.riskPct; let qty = rA / risk; qty = Math.max(0.01, Math.round(qty * 1000) / 1000);

        const si = k5.findIndex(k => k.ts === after[entry.idx].ts); if (si < 0) continue;
        let exitP = 0;
        for (let j = si + 1; j < k5.length && j - si < 120; j++) { const b = k5[j];
            if (f.dir === "long") { if (b.l <= sl) { exitP = sl; break; } if (b.h >= tp) { exitP = tp; break; } }
            else { if (b.h >= sl) { exitP = sl; break; } if (b.l <= tp) { exitP = tp; break; } } }
        if (exitP === 0) exitP = k5[Math.min(si + 119, k5.length - 1)].c;
        const pt = f.dir === "long" ? exitP - entry.ep : entry.ep - exitP;
        const net = pt * qty - (entry.ep * qty + exitP * qty) * FEE;
        bal += net; if (bal > maxB) maxB = bal; const dd = maxB - bal; if (dd > maxDD) maxDD = dd;
        const mon = f.date.slice(0, 7); months[mon] = (months[mon] || 0) + net;
        trades.push({ net, date: f.date });
    }
    const w = trades.filter(t => t.net > 0); const tW = w.reduce((a, t) => a + t.net, 0);
    const tL = Math.abs(trades.filter(t => t.net < 0).reduce((a, t) => a + t.net, 0));
    return { cfg, t: trades.length, w: w.length, pnl: trades.reduce((a, t) => a + t.net, 0),
        wr: trades.length > 0 ? w.length / trades.length * 100 : 0, dd: maxDD,
        pf: tL > 0 ? tW / tL : 999, fb: bal, m: months, d: new Set(trades.map(t => t.date)).size };
}

function print(label: string, results: Res[]) {
    results.sort((a, b) => b.pf - a.pf);  // 按PF排序
    console.log(`\n${"─".repeat(110)}`);
    console.log(`  ${label}`);
    console.log(`${"─".repeat(110)}`);
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const ms = Object.entries(r.m).sort().map(([k, v]) => `${k.slice(5)}:${v >= 0 ? "+" : ""}${v.toFixed(0)}`).join(" ");
        const ret = ((r.fb - CAP) / CAP * 100).toFixed(0);
        const avgPer = r.t > 0 ? r.pnl / r.t : 0;
        console.log(`  ${r.cfg.name.padEnd(40)} | ${String(r.t).padStart(2)}笔 ${String(r.d).padStart(2)}天 ${r.wr.toFixed(0).padStart(2)}% PF=${r.pf.toFixed(2).padStart(5)} | $${r.fb.toFixed(0).padStart(5)}(${ret.padStart(4)}%) DD=$${r.dd.toFixed(0).padStart(4)} | 均$${avgPer.toFixed(0).padStart(4)}/笔 | ${ms}${i === 0 ? " 🏆" : ""}`);
    }
}

async function main() {
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log("  🎯 V10 三步结构转变入场 vs V96 一根阳线入场");
    console.log("  $500 | ETH | 10%复利");
    console.log("═══════════════════════════════════════════════════════════════════\n");
    const sMs = new Date("2026-01-01T00:00:00Z").getTime(), eMs = new Date("2026-03-23T00:00:00Z").getTime();
    console.log("📥 拉取数据...");
    const kl1h = await fetchK("ETHUSDT", "1h", sMs - 7 * 86400000, eMs);
    const kl5m = await fetchK("ETHUSDT", "5m", sMs, eMs);
    console.log(`  1h:${kl1h.length} 5m:${kl5m.length}`);
    const fires = findFires(kl1h);
    console.log(`  Fire Candles: ${fires.length}天`);

    // R1: V96 vs V10 入场方式对比 (SL=4H Low)
    print("🔬 R1: 入场方式对比 (10%复利, SL=4H Low)", [
        run(kl5m, fires, { name: "V96 一根阳线+3R", entryMode: "v96", riskPct: 0.10, tpR: 3, slMode: "4hLow" }),
        run(kl5m, fires, { name: "V96 一根阳线+5R", entryMode: "v96", riskPct: 0.10, tpR: 5, slMode: "4hLow" }),
        run(kl5m, fires, { name: "V10 结构转变+3R", entryMode: "v10", riskPct: 0.10, tpR: 3, slMode: "4hLow" }),
        run(kl5m, fires, { name: "V10 结构转变+5R", entryMode: "v10", riskPct: 0.10, tpR: 5, slMode: "4hLow" }),
    ]);

    // R2: V10 + manipLow SL (更紧SL = 更大仓位)
    print("🔬 R2: V10 + 操纵低点SL (更紧=仓位更大)", [
        run(kl5m, fires, { name: "V10+4H Low SL+3R", entryMode: "v10", riskPct: 0.10, tpR: 3, slMode: "4hLow" }),
        run(kl5m, fires, { name: "V10+操纵低SL+3R", entryMode: "v10", riskPct: 0.10, tpR: 3, slMode: "manipLow" }),
        run(kl5m, fires, { name: "V10+4H Low SL+5R", entryMode: "v10", riskPct: 0.10, tpR: 5, slMode: "4hLow" }),
        run(kl5m, fires, { name: "V10+操纵低SL+5R", entryMode: "v10", riskPct: 0.10, tpR: 5, slMode: "manipLow" }),
    ]);

    // R3: 不同风险% (V10)
    print("🔬 R3: V10 + 不同风险%", [
        run(kl5m, fires, { name: "V10+5%+3R+manipSL", entryMode: "v10", riskPct: 0.05, tpR: 3, slMode: "manipLow" }),
        run(kl5m, fires, { name: "V10+8%+3R+manipSL", entryMode: "v10", riskPct: 0.08, tpR: 3, slMode: "manipLow" }),
        run(kl5m, fires, { name: "V10+10%+3R+manipSL", entryMode: "v10", riskPct: 0.10, tpR: 3, slMode: "manipLow" }),
        run(kl5m, fires, { name: "V10+10%+5R+manipSL", entryMode: "v10", riskPct: 0.10, tpR: 5, slMode: "manipLow" }),
        run(kl5m, fires, { name: "V10+5%+5R+manipSL", entryMode: "v10", riskPct: 0.05, tpR: 5, slMode: "manipLow" }),
    ]);

    // R4: 终极对比
    print("🏆 R4: 终极对比", [
        run(kl5m, fires, { name: "V96原版(10%+3R+4hSL)", entryMode: "v96", riskPct: 0.10, tpR: 3, slMode: "4hLow" }),
        run(kl5m, fires, { name: "V10结构(10%+3R+4hSL)", entryMode: "v10", riskPct: 0.10, tpR: 3, slMode: "4hLow" }),
        run(kl5m, fires, { name: "V10结构(10%+3R+manipSL)", entryMode: "v10", riskPct: 0.10, tpR: 3, slMode: "manipLow" }),
        run(kl5m, fires, { name: "V10结构(10%+5R+manipSL)", entryMode: "v10", riskPct: 0.10, tpR: 5, slMode: "manipLow" }),
    ]);

    console.log(`\n${"═".repeat(110)}`);
    console.log("  🏁 完成");
    console.log(`${"═".repeat(110)}\n`);
}
main().catch(console.error);
export {};
