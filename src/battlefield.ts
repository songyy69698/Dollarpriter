/**
 * 🎯 V300 战场标记模块 (Battlefield Marker)
 * ═══════════════════════════════════════════════════
 * 在锚定时间窗口内自动记录 High/Low/VA/POC
 * 为策略引擎提供「定价范围」边界
 *
 * 锚定窗口 (UTC+8):
 *   AM锚定     09:30 - 09:45 (亚盘)
 *   PM锚定     21:30 - 21:45 (纽约盘)
 *   黄金单边   15:15 - 15:30 (单边强势期)
 *   假突破反转 22:30 - 22:45 (假突破反转期)
 */

import {
    ANCHOR_WINDOWS, BINANCE_BASE, VA_PERCENTAGE,
    POC_SHIFT_THRESHOLD,
} from "./config";
import type { AnchorConfig } from "./config";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [battlefield] ${msg}`);
}

// ═══════════════════════════════════════════════
// 锚定标记数据结构
// ═══════════════════════════════════════════════

export interface AnchorMark {
    name: string;
    ts: number;           // 标记时间
    high: number;         // 15min High
    low: number;          // 15min Low
    vah: number;          // Value Area High (70%)
    val: number;          // Value Area Low  (70%)
    poc: number;          // Point of Control
    totalVol: number;     // 总成交量
}

export interface ActiveRange {
    high: number;
    low: number;
    vah: number;
    val: number;
    poc: number;
    anchorName: string;
    pocDir: "long" | "short" | "";
    prevPOC: number;
}

// ═══════════════════════════════════════════════
// M1 K线结构
// ═══════════════════════════════════════════════

interface K1m {
    ts: number; o: number; h: number; l: number; c: number; v: number;
}

// ═══════════════════════════════════════════════
// 战场标记器
// ═══════════════════════════════════════════════

export class BattlefieldMarker {
    // 已完成的锚定标记 (最近4个)
    private marks: AnchorMark[] = [];

    // 正在收集中的锚定窗口
    private collectingName = "";
    private collectingKlines: K1m[] = [];
    private collectingStartTs = 0;

    // 上一次标记的日期+窗口名 (防重复)
    private markedKeys = new Set<string>();

    // M1 K线缓存
    private klines1m: K1m[] = [];
    private lastFetch1mTs = 0;

    /** 每 30s 由 main.ts 调用: 检查是否到了锚定时间 */
    async tick(): Promise<AnchorMark | null> {
        const now = Date.now();
        const utc8 = new Date(now + 8 * 3600000);
        const h = utc8.getUTCHours();
        const m = utc8.getUTCMinutes();
        const today = utc8.toISOString().slice(0, 10);

        // 检查每个锚定窗口
        for (const win of ANCHOR_WINDOWS) {
            const key = `${today}_${win.name}`;

            // 已标记过，跳过
            if (this.markedKeys.has(key)) continue;

            const inWindow = this.isInWindow(h, m, win);

            // 进入窗口 → 开始收集
            if (inWindow && this.collectingName !== win.name) {
                this.collectingName = win.name;
                this.collectingKlines = [];
                this.collectingStartTs = now;
                log(`📍 进入锚定窗口: ${win.name} (${win.startH}:${String(win.startM).padStart(2, "0")} UTC+8)`);
            }

            // 窗口结束 → 标记
            if (!inWindow && this.collectingName === win.name && this.collectingStartTs > 0) {
                // 拉取 M1 K线数据
                await this.refreshKlines1m();
                const mark = this.computeMark(win.name, now);
                if (mark) {
                    this.marks.push(mark);
                    if (this.marks.length > 8) this.marks = this.marks.slice(-4);
                    this.markedKeys.add(key);
                    log(`✅ 锚定标记完成: ${win.name} | H=${mark.high.toFixed(2)} L=${mark.low.toFixed(2)} VAH=${mark.vah.toFixed(2)} VAL=${mark.val.toFixed(2)} POC=${mark.poc.toFixed(2)}`);
                    this.collectingName = "";
                    this.collectingStartTs = 0;
                    return mark;
                }
                this.collectingName = "";
                this.collectingStartTs = 0;
            }
        }

        // 每日重置
        if (h === 0 && m === 0) {
            this.markedKeys.clear();
        }

        return null;
    }

    /** 获取当前活跃的定价范围 (最近一个锚定标记) */
    getActiveRange(): ActiveRange | null {
        if (this.marks.length === 0) return null;

        const latest = this.marks[this.marks.length - 1];
        const prev = this.marks.length >= 2 ? this.marks[this.marks.length - 2] : null;

        let pocDir: "long" | "short" | "" = "";
        const prevPOC = prev?.poc ?? 0;
        if (prev) {
            const pocShift = latest.poc - prev.poc;
            if (pocShift > POC_SHIFT_THRESHOLD) pocDir = "long";
            else if (pocShift < -POC_SHIFT_THRESHOLD) pocDir = "short";
        }

        return {
            high: latest.high,
            low: latest.low,
            vah: latest.vah,
            val: latest.val,
            poc: latest.poc,
            anchorName: latest.name,
            pocDir,
            prevPOC,
        };
    }

    /** 获取所有锚定标记 */
    getMarks(): AnchorMark[] { return this.marks; }

    /** 是否有活跃定价范围 */
    hasRange(): boolean { return this.marks.length > 0; }

    // ═══════════════════════════════════════════════
    // 内部方法
    // ═══════════════════════════════════════════════

    private isInWindow(h: number, m: number, win: AnchorConfig): boolean {
        const nowMin = h * 60 + m;
        const startMin = win.startH * 60 + win.startM;
        const endMin = win.endH * 60 + win.endM;
        return nowMin >= startMin && nowMin < endMin;
    }

    private async refreshKlines1m() {
        const now = Date.now();
        if (now - this.lastFetch1mTs < 15_000) return; // 至少 15s 间隔
        this.lastFetch1mTs = now;

        try {
            const start = now - 30 * 60_000; // 最近30分钟
            const url = `${BINANCE_BASE}/api/v3/klines?symbol=ETHUSDT&interval=1m&startTime=${start}&endTime=${now}&limit=30`;
            const res = await fetch(url);
            if (res.ok) {
                const raw = await res.json() as any[];
                this.klines1m = raw.map((k: any) => ({
                    ts: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
                }));
            }
        } catch (e) { log(`❌ M1 K线异常: ${e}`); }
    }

    private computeMark(name: string, now: number): AnchorMark | null {
        // 找到锚定窗口内的 M1 K线 (最近15分钟)
        const cutoff = now - 20 * 60_000; // 稍微放宽到20分钟
        const windowKlines = this.klines1m.filter(k => k.ts >= cutoff);

        if (windowKlines.length < 5) {
            log(`⚠️ ${name} K线不足 (${windowKlines.length}根)`);
            return null;
        }

        // 计算 High/Low
        let high = 0, low = Infinity;
        for (const k of windowKlines) {
            if (k.h > high) high = k.h;
            if (k.l < low) low = k.l;
        }

        // 计算 Volume Profile (bin=0.5pt)
        const BIN_SIZE = 0.5;
        const volMap = new Map<number, number>();
        let totalVol = 0;

        for (const k of windowKlines) {
            // 将每根 K 线的成交量均匀分布在 Low ~ High
            const range = k.h - k.l;
            if (range < 0.01) {
                const bin = Math.round(k.c / BIN_SIZE) * BIN_SIZE;
                volMap.set(bin, (volMap.get(bin) || 0) + k.v);
            } else {
                const steps = Math.max(1, Math.round(range / BIN_SIZE));
                const volPerStep = k.v / steps;
                for (let s = 0; s < steps; s++) {
                    const p = k.l + s * BIN_SIZE;
                    const bin = Math.round(p / BIN_SIZE) * BIN_SIZE;
                    volMap.set(bin, (volMap.get(bin) || 0) + volPerStep);
                }
            }
            totalVol += k.v;
        }

        // POC = 最大成交量的价格层级
        let maxVol = 0, poc = 0;
        for (const [p, v] of volMap) {
            if (v > maxVol) { maxVol = v; poc = p; }
        }

        // Value Area (70%): 从 POC 向两侧扩展
        const sorted = Array.from(volMap.entries()).sort((a, b) => a[0] - b[0]);
        const targetVol = totalVol * VA_PERCENTAGE;
        const pocIdx = sorted.findIndex(([p]) => p === poc);
        if (pocIdx === -1) return { name, ts: now, high, low, vah: high, val: low, poc, totalVol };

        let accVol = sorted[pocIdx][1];
        let lo = pocIdx, hi = pocIdx;

        while (accVol < targetVol && (lo > 0 || hi < sorted.length - 1)) {
            const loV = lo > 0 ? sorted[lo - 1][1] : 0;
            const hiV = hi < sorted.length - 1 ? sorted[hi + 1][1] : 0;
            if (loV >= hiV && lo > 0) { lo--; accVol += sorted[lo][1]; }
            else if (hi < sorted.length - 1) { hi++; accVol += sorted[hi][1]; }
            else if (lo > 0) { lo--; accVol += sorted[lo][1]; }
            else break;
        }

        return {
            name,
            ts: now,
            high,
            low,
            vah: sorted[hi][0],
            val: sorted[lo][0],
            poc,
            totalVol,
        };
    }
}
