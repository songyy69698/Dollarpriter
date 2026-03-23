/**
 * 🔥 V96 每日交易回测 — bodyRatio阈值测试
 * 核心问题: V96 bodyRatio≥40%过滤掉了近半的交易日
 * V10: 每天只需收盘价，不过滤K线形态
 */
const FEE = 0.0004, CAP = 500;
interface K { ts: number; o: number; h: number; l: number; c: number; v: number; }

async function fetchK(sym: string, iv: string, s: number, e: number): Promise<K[]> {
    const all: K[] = []; let cur = s;
    while (cur < e) {
        const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${iv}&startTime=${cur}&endTime=${e}&limit=1500`;
        const r = await fetch(url); if (!r.ok) { await Bun.sleep(5000); continue; }
        const d = (await r.json()) as any[][]; if (!d.length) break;
        for (const k of d) all.push({ ts: k[0] as number, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
        cur = (d[d.length - 1][6] as number) + 1; await Bun.sleep(150);
    }
    return all;
}

interface Fire {
    date: string; h: number; l: number; o: number; c: number;
    bodyR: number; range: number; dir: "long" | "short" | "skip";
}

function findFires(kl1h: K[], fS: number, fE: number, minBR: number): Fire[] {
    const fires: Fire[] = [];
    const dm = new Map<string, K[]>();
    for (const k of kl1h) { const d = new Date(k.ts).toISOString().slice(0, 10); if (!dm.has(d)) dm.set(d, []); dm.get(d)!.push(k); }
    for (const [date, bars] of dm) {
        const win = bars.filter(k => { const h = new Date(k.ts).getUTCHours(); return h >= fS && h < fE; });
        if (win.length < 2) continue;
        const o = win[0].o, c = win[win.length - 1].c;
        const h = Math.max(...win.map(k => k.h)), l = Math.min(...win.map(k => k.l));
        const body = Math.abs(c - o), range = h - l; if (range < 3) continue;
        const bodyR = body / range;
        let dir: "long" | "short" | "skip" = "skip";
        if (minBR === 0) {
            // V10模式: 只看收盘价方向
            dir = c > o ? "long" : "short";
        } else if (bodyR >= minBR) {
            dir = c > o ? "long" : "short";
        }
        fires.push({ date, h, l, o, c, bodyR, range, dir });
    }
    return fires;
}

function run(kl5m: K[], fires: Fire[], riskPct: number, tpR: number, label: string) {
    const trades: { net: number; date: string }[] = [];
    let bal = CAP, maxB = CAP, maxDD = 0;
    const months: Record<string, number> = {};

    for (const f of fires) {
        if (f.dir === "skip") continue;
        const after = kl5m.filter(k => {
            const d = new Date(k.ts);
            return d.toISOString().slice(0, 10) === f.date && d.getUTCHours() >= 12 && d.getUTCHours() <= 20;
        });
        if (after.length < 5) continue;

        let ep = 0, entryIdx = -1, manipulated = false;
        for (let i = 1; i < after.length; i++) {
            const bar = after[i];
            if (ep > 0) break;
            if (f.dir === "long") {
                if (!manipulated && bar.l < f.c) manipulated = true;
                if (manipulated && bar.c > f.c && bar.c > bar.o && after[i - 1].c < f.c) { ep = bar.c; entryIdx = i; }
            } else {
                if (!manipulated && bar.h > f.c) manipulated = true;
                if (manipulated && bar.c < f.c && bar.c < bar.o && after[i - 1].c > f.c) { ep = bar.c; entryIdx = i; }
            }
        }
        if (ep === 0) continue;

        const sl = f.dir === "long" ? f.l - 1 : f.h + 1;
        const risk = f.dir === "long" ? ep - sl : sl - ep;
        if (risk <= 0 || risk > 500) continue;
        const tp = f.dir === "long" ? ep + risk * tpR : ep - risk * tpR;
        const riskAmt = bal * riskPct;
        let qty = riskAmt / risk;
        qty = Math.max(0.01, Math.round(qty * 1000) / 1000);

        const startIdx = kl5m.findIndex(k => k.ts === after[entryIdx].ts);
        if (startIdx < 0) continue;
        let exitP = 0;
        for (let j = startIdx + 1; j < kl5m.length && j - startIdx < 120; j++) {
            const bar = kl5m[j];
            if (f.dir === "long") { if (bar.l <= sl) { exitP = sl; break; } if (bar.h >= tp) { exitP = tp; break; } }
            else { if (bar.h >= sl) { exitP = sl; break; } if (bar.l <= tp) { exitP = tp; break; } }
        }
        if (exitP === 0) exitP = kl5m[Math.min(startIdx + 119, kl5m.length - 1)].c;

        const pt = f.dir === "long" ? exitP - ep : ep - exitP;
        const fee = (ep * qty + exitP * qty) * FEE;
        const net = pt * qty - fee;
        bal += net; if (bal > maxB) maxB = bal;
        const dd = maxB - bal; if (dd > maxDD) maxDD = dd;
        const mon = f.date.slice(0, 7);
        months[mon] = (months[mon] || 0) + net;
        trades.push({ net, date: f.date });
    }

    const w = trades.filter(t => t.net > 0);
    const tW = w.reduce((a, t) => a + t.net, 0);
    const tL = Math.abs(trades.filter(t => t.net < 0).reduce((a, t) => a + t.net, 0));
    const days = new Set(trades.map(t => t.date)).size;
    const ms = Object.entries(months).sort().map(([m, v]) => `${m.slice(5)}:${v >= 0 ? "+" : ""}${v.toFixed(0)}`).join(" ");

    console.log(
        `  ${label.padEnd(28)} | ${String(trades.length).padStart(3)} | ${String(days).padStart(3)} | ` +
        `${w.length}/${trades.length}(${trades.length > 0 ? (w.length / trades.length * 100).toFixed(0) : 0}%) | ` +
        `$${(trades.reduce((a, t) => a + t.net, 0) >= 0 ? "+" : "") + trades.reduce((a, t) => a + t.net, 0).toFixed(0).padStart(6)} | ` +
        `$${maxDD.toFixed(0).padStart(5)} | ${(tL > 0 ? tW / tL : 999).toFixed(2).padStart(5)} | $${bal.toFixed(0)} | ${ms}`
    );
    return { pnl: trades.reduce((a, t) => a + t.net, 0), pf: tL > 0 ? tW / tL : 999, trades: trades.length, days };
}

async function main() {
    console.log("═══════════════════════════════════════════════════════════");
    console.log("  🔥 V96 每日交易回测");
    console.log("═══════════════════════════════════════════════════════════\n");

    const sMs = new Date("2026-01-01T00:00:00Z").getTime();
    const eMs = new Date("2026-03-23T00:00:00Z").getTime();

    console.log("📥 拉取数据...");
    const kl1h = await fetchK("ETHUSDT", "1h", sMs - 7 * 86400000, eMs);
    const kl5m = await fetchK("ETHUSDT", "5m", sMs, eMs);
    console.log(`  1h:${kl1h.length} 5m:${kl5m.length}\n`);

    console.log("═══ bodyRatio阈值测试 (2%风险, 3R) ═══");
    console.log(`  ${"方案".padEnd(28)} | 笔数 | 天数 | 胜率      | 净利     | 回撤   | PF    | 余额 | 月度`);
    console.log(`  ${"-".repeat(95)}`);

    for (const br of [0.4, 0.3, 0.2, 0.1, 0]) {
        const fires = findFires(kl1h, 8, 12, br);
        const total = fires.length;
        const active = fires.filter(f => f.dir !== "skip").length;
        run(kl5m, fires, 0.02, 3, `bodyR≥${(br * 100).toFixed(0)}%(${active}/${total}天)`);
    }

    console.log("\n═══ 最优bodyR=0 + 不同风险% ═══");
    console.log(`  ${"方案".padEnd(28)} | 笔数 | 天数 | 胜率      | 净利     | 回撤   | PF    | 余额 | 月度`);
    console.log(`  ${"-".repeat(95)}`);
    const fires0 = findFires(kl1h, 8, 12, 0);
    for (const rp of [0.01, 0.02, 0.03, 0.05]) {
        run(kl5m, fires0, rp, 3, `每日交易+${(rp * 100).toFixed(0)}%风险`);
    }

    console.log("\n═══ 每日交易 + 不同TP ═══");
    console.log(`  ${"方案".padEnd(28)} | 笔数 | 天数 | 胜率      | 净利     | 回撤   | PF    | 余额 | 月度`);
    console.log(`  ${"-".repeat(95)}`);
    for (const tp of [2, 3, 4, 5]) {
        run(kl5m, fires0, 0.02, tp, `每日+2%+${tp}R`);
    }

    console.log("\n═══ 完成 ═══");
}

main().catch(console.error);
export {};
