/**
 * 🔬 MTF-POC 共振评分引擎 — 12 时间框架 POC 方向投票 + 回调入场
 * ═══════════════════════════════════════════════════════════════
 * 从 Binance 拉取 12 个时间框架 K线, 计算每个 TF 的 POC 方向
 * 汇总为共振评分 (-12 ~ +12)
 * 搭配回调入场: 价格必须回调到 POC 附近才允许开单
 */

import {
    BINANCE_BASE,
    MTF_ENABLED, MTF_MIN_SCORE, MTF_REFRESH_MS,
    PULLBACK_ZONE_PT, MAX_CHASE_PT,
} from "./config";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [mtf-poc] ${msg}`);
}

// ═══════════════════════════════════════════════
// 时间框架定义
// ═══════════════════════════════════════════════

interface TfConfig {
    name: string;          // 显示名
    interval: string;      // Binance API interval
    limit: number;         // 拉取 K 线数量
    halfSplit: number;     // 前后对比的分割点 (前half vs 后half)
    threshold: number;     // POC 位移阈值 (pt)
    refreshPriority: number; // 刷新优先级 (1=最频繁)
}

const TF_CONFIGS: TfConfig[] = [
    { name: "1d",  interval: "1d",  limit: 4,  halfSplit: 2,  threshold: 50,  refreshPriority: 12 },
    { name: "12h", interval: "12h", limit: 4,  halfSplit: 2,  threshold: 30,  refreshPriority: 11 },
    { name: "8h",  interval: "8h",  limit: 6,  halfSplit: 3,  threshold: 20,  refreshPriority: 10 },
    { name: "6h",  interval: "6h",  limit: 8,  halfSplit: 4,  threshold: 15,  refreshPriority: 9 },
    { name: "4h",  interval: "4h",  limit: 12, halfSplit: 6,  threshold: 10,  refreshPriority: 8 },
    { name: "2h",  interval: "2h",  limit: 12, halfSplit: 6,  threshold: 8,   refreshPriority: 7 },
    { name: "1h",  interval: "1h",  limit: 24, halfSplit: 12, threshold: 5,   refreshPriority: 6 },
    { name: "30m", interval: "30m", limit: 24, halfSplit: 12, threshold: 4,   refreshPriority: 5 },
    { name: "15m", interval: "15m", limit: 32, halfSplit: 16, threshold: 3,   refreshPriority: 4 },
    { name: "5m",  interval: "5m",  limit: 48, halfSplit: 24, threshold: 2,   refreshPriority: 3 },
    { name: "3m",  interval: "3m",  limit: 40, halfSplit: 20, threshold: 1.5, refreshPriority: 2 },
    { name: "1m",  interval: "1m",  limit: 60, halfSplit: 30, threshold: 1,   refreshPriority: 1 },
];

// ═══════════════════════════════════════════════
// 单个时间框架的 K 线与 POC 数据
// ═══════════════════════════════════════════════

interface Kline {
    ts: number; o: number; h: number; l: number; c: number; v: number;
}

export interface TfDetail {
    name: string;
    poc: number;        // 当前窗口 POC
    prevPoc: number;    // 前窗口 POC
    slope: number;      // POC 位移
    vote: number;       // +1 / 0 / -1
    klineCount: number; // 实际 K 线数
}

export interface MtfScore {
    score: number;                          // -12 ~ +12
    dir: "long" | "short" | "";             // 多数方向
    absScore: number;                       // |score|
    details: TfDetail[];                    // 12 个 TF 明细
    nearestPOC: number;                     // 中周期 POC 加权均值
    pullbackStatus: "ready" | "chasing" | "waiting"; // 回调状态
    enabled: boolean;
}

// ═══════════════════════════════════════════════
// MTF-POC 引擎
// ═══════════════════════════════════════════════

export class MtfPocEngine {
    private tfData: Map<string, Kline[]> = new Map();
    private tfDetails: TfDetail[] = [];
    private lastRefreshTs = 0;
    private lastBootstrapTs = 0;
    private refreshCycle = 0;
    private _ready = false;
    private _lastScore: MtfScore = {
        score: 0, dir: "", absScore: 0, details: [],
        nearestPOC: 0, pullbackStatus: "waiting", enabled: MTF_ENABLED,
    };

    get ready(): boolean { return this._ready; }

    // ═══════════════════════════════════════════════
    // 启动预加载 — 顺序拉取所有 12 个 TF
    // ═══════════════════════════════════════════════

    async bootstrap(): Promise<boolean> {
        if (!MTF_ENABLED) {
            log("⚠️ MTF 未启用");
            return false;
        }

        log("🔬 MTF-POC 预加载 12 个时间框架...");
        let successCount = 0;

        for (const tf of TF_CONFIGS) {
            const ok = await this.fetchTfKlines(tf);
            if (ok) successCount++;
            // 100ms 间隔避免 Binance 429
            await new Promise(r => setTimeout(r, 100));
        }

        this._ready = successCount >= 8; // 至少 8/12 个 TF 有数据
        this.recalcAll(0);

        log(`✅ MTF-POC 预加载完成: ${successCount}/12 TF | score=${this._lastScore.score} dir=${this._lastScore.dir}`);
        this.logDetails();
        this.lastBootstrapTs = Date.now();
        return this._ready;
    }

    // ═══════════════════════════════════════════════
    // 定期刷新 — 小周期刷更频繁
    // ═══════════════════════════════════════════════

    async refresh(currentPrice?: number): Promise<void> {
        if (!MTF_ENABLED || !this._ready) return;

        const now = Date.now();
        if (now - this.lastRefreshTs < MTF_REFRESH_MS) return;
        this.lastRefreshTs = now;
        this.refreshCycle++;

        // 每个周期刷新不同的 TF 组:
        // 周期 1: 1m, 3m, 5m (高频)
        // 周期 2: 15m, 30m
        // 周期 3: 1h, 2h
        // 周期 4: 4h, 6h, 8h, 12h, 1d (低频)
        const phase = this.refreshCycle % 4;
        let toRefresh: TfConfig[];

        switch (phase) {
            case 1: toRefresh = TF_CONFIGS.filter(t => t.refreshPriority <= 3); break;  // 1m,3m,5m
            case 2: toRefresh = TF_CONFIGS.filter(t => t.refreshPriority >= 4 && t.refreshPriority <= 5); break; // 15m,30m
            case 3: toRefresh = TF_CONFIGS.filter(t => t.refreshPriority >= 6 && t.refreshPriority <= 7); break; // 1h,2h
            case 0: toRefresh = TF_CONFIGS.filter(t => t.refreshPriority >= 8); break;  // 4h~1d
            default: toRefresh = [];
        }

        for (const tf of toRefresh) {
            await this.fetchTfKlines(tf);
            await new Promise(r => setTimeout(r, 80));
        }

        this.recalcAll(currentPrice || 0);

        // 每 5 个周期打印一次摘要
        if (this.refreshCycle % 5 === 0) {
            log(`🔬 MTF 刷新#${this.refreshCycle} | score=${this._lastScore.score} dir=${this._lastScore.dir} POC=$${this._lastScore.nearestPOC.toFixed(2)} pullback=${this._lastScore.pullbackStatus}`);
        }
    }

    // ═══════════════════════════════════════════════
    // 获取评分
    // ═══════════════════════════════════════════════

    getScore(currentPrice?: number): MtfScore {
        if (currentPrice && currentPrice > 0) {
            // 实时更新回调状态
            this._lastScore.pullbackStatus = this.calcPullbackStatus(
                currentPrice,
                this._lastScore.dir,
                this._lastScore.nearestPOC,
            );
        }
        return this._lastScore;
    }

    // ═══════════════════════════════════════════════
    // 拉取单个 TF 的 K 线
    // ═══════════════════════════════════════════════

    private async fetchTfKlines(tf: TfConfig): Promise<boolean> {
        try {
            const url = `${BINANCE_BASE}/api/v3/klines?symbol=ETHUSDT&interval=${tf.interval}&limit=${tf.limit}`;
            const res = await fetch(url);
            if (!res.ok) {
                log(`⚠️ ${tf.name} K线拉取失败: HTTP ${res.status}`);
                return false;
            }
            const data = (await res.json()) as any[][];
            const klines: Kline[] = data.map(k => ({
                ts: k[0] as number,
                o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
            }));
            if (klines.length < 4) {
                log(`⚠️ ${tf.name} K线不足: ${klines.length}`);
                return false;
            }
            this.tfData.set(tf.name, klines);
            return true;
        } catch (e) {
            log(`❌ ${tf.name} K线异常: ${e}`);
            return false;
        }
    }

    // ═══════════════════════════════════════════════
    // 重算所有 TF 的 POC + 评分
    // ═══════════════════════════════════════════════

    private recalcAll(currentPrice: number): void {
        this.tfDetails = [];
        let totalScore = 0;

        for (const tf of TF_CONFIGS) {
            const klines = this.tfData.get(tf.name);
            if (!klines || klines.length < 4) {
                this.tfDetails.push({
                    name: tf.name, poc: 0, prevPoc: 0, slope: 0, vote: 0,
                    klineCount: klines?.length || 0,
                });
                continue;
            }

            // 分割前后窗口计算 POC
            const split = Math.min(tf.halfSplit, Math.floor(klines.length / 2));
            const recentHalf = klines.slice(-split);       // 后半段 (当前窗口)
            const prevHalf = klines.slice(-split * 2, -split); // 前半段 (前窗口)

            const poc = this.calcPOC(recentHalf);
            const prevPoc = this.calcPOC(prevHalf);
            const slope = poc - prevPoc;

            let vote = 0;
            if (slope > tf.threshold) vote = 1;       // 上移 → 做多
            else if (slope < -tf.threshold) vote = -1; // 下移 → 做空

            totalScore += vote;
            this.tfDetails.push({
                name: tf.name, poc, prevPoc, slope, vote,
                klineCount: klines.length,
            });
        }

        // 计算 nearestPOC (中周期 POC 加权均值)
        const nearestPOC = this.calcNearestPOC();

        // 计算回调状态
        const dir = totalScore > 0 ? "long" as const
                  : totalScore < 0 ? "short" as const
                  : "" as const;
        const pullbackStatus = currentPrice > 0
            ? this.calcPullbackStatus(currentPrice, dir, nearestPOC)
            : "waiting" as const;

        this._lastScore = {
            score: totalScore,
            dir,
            absScore: Math.abs(totalScore),
            details: [...this.tfDetails],
            nearestPOC,
            pullbackStatus,
            enabled: MTF_ENABLED,
        };
    }

    // ═══════════════════════════════════════════════
    // POC 计算: 找成交量最大的 K 线, POC = (H+L+C)/3
    // ═══════════════════════════════════════════════

    private calcPOC(klines: Kline[]): number {
        if (klines.length === 0) return 0;
        let maxVol = 0, poc = 0;
        for (const k of klines) {
            if (k.v > maxVol) {
                maxVol = k.v;
                poc = (k.h + k.l + k.c) / 3;
            }
        }
        return poc;
    }

    // ═══════════════════════════════════════════════
    // 中周期 POC 加权均值 (1h/30m/15m 权重最高)
    // ═══════════════════════════════════════════════

    private calcNearestPOC(): number {
        // 权重: 1h=3, 30m=3, 15m=2, 5m=1, 2h=1
        const weights: Record<string, number> = {
            "2h": 1, "1h": 3, "30m": 3, "15m": 2, "5m": 1,
        };

        let wSum = 0, wTotal = 0;
        for (const detail of this.tfDetails) {
            const w = weights[detail.name];
            if (w && detail.poc > 0) {
                wSum += detail.poc * w;
                wTotal += w;
            }
        }
        return wTotal > 0 ? wSum / wTotal : 0;
    }

    // ═══════════════════════════════════════════════
    // 回调状态判断
    // ═══════════════════════════════════════════════

    private calcPullbackStatus(
        price: number,
        dir: "long" | "short" | "",
        nearestPOC: number,
    ): "ready" | "chasing" | "waiting" {
        if (!dir || nearestPOC <= 0 || price <= 0) return "waiting";

        const dist = price - nearestPOC; // 正=价格在POC上方

        if (dir === "long") {
            // 做多: 价格在 POC 附近或下方 = 回调到位
            if (dist <= PULLBACK_ZONE_PT) return "ready";      // POC 附近或下方 ✅
            if (dist > MAX_CHASE_PT) return "chasing";         // 太高不追 ❌
            return "waiting";                                   // 中间地带, 等回调
        } else {
            // 做空: 价格在 POC 附近或上方 = 回调到位
            if (dist >= -PULLBACK_ZONE_PT) return "ready";     // POC 附近或上方 ✅
            if (dist < -MAX_CHASE_PT) return "chasing";        // 太低不追 ❌
            return "waiting";
        }
    }

    // ═══════════════════════════════════════════════
    // 打印详细评分
    // ═══════════════════════════════════════════════

    logDetails(): void {
        const lines = this.tfDetails.map(d => {
            const arrow = d.vote > 0 ? "📈" : d.vote < 0 ? "📉" : "➡️";
            return `  ${d.name.padEnd(4)} ${arrow} POC=$${d.poc.toFixed(2)} slope=${d.slope >= 0 ? "+" : ""}${d.slope.toFixed(1)} (${d.klineCount}根)`;
        });
        log(`🔬 MTF 详情:\n${lines.join("\n")}`);
    }

    // ═══════════════════════════════════════════════
    // Telegram 格式化输出
    // ═══════════════════════════════════════════════

    formatTelegram(currentPrice?: number): string {
        const s = currentPrice ? this.getScore(currentPrice) : this._lastScore;
        const scoreBar = this.renderScoreBar(s.score);

        let msg = `🔬 *MTF-POC 共振* ${scoreBar}\n`;
        msg += `──────────\n`;
        msg += `📊 评分: *${s.score >= 0 ? "+" : ""}${s.score}*/12 → ${s.dir === "long" ? "📈多" : s.dir === "short" ? "📉空" : "➡️不明"}\n`;
        msg += `💰 中周期POC: $${s.nearestPOC.toFixed(2)}\n`;

        if (currentPrice && currentPrice > 0) {
            const dist = currentPrice - s.nearestPOC;
            msg += `📍 价格距POC: ${dist >= 0 ? "+" : ""}${dist.toFixed(1)}pt\n`;
        }

        const pbEmoji = s.pullbackStatus === "ready" ? "✅" : s.pullbackStatus === "chasing" ? "🚫" : "⏳";
        msg += `${pbEmoji} 回调: *${s.pullbackStatus}*\n`;
        msg += `──────────\n`;

        // 12 个 TF 紧凑排列
        const detailLines: string[] = [];
        for (let i = 0; i < s.details.length; i += 3) {
            const chunk = s.details.slice(i, i + 3);
            const line = chunk.map(d => {
                const arrow = d.vote > 0 ? "↑" : d.vote < 0 ? "↓" : "·";
                return `${d.name}${arrow}`;
            }).join(" ");
            detailLines.push(line);
        }
        msg += detailLines.join("\n");

        return msg;
    }

    private renderScoreBar(score: number): string {
        const abs = Math.abs(score);
        if (abs >= 10) return "🟢🟢🟢🟢🟢";
        if (abs >= 8)  return "🟢🟢🟢🟢";
        if (abs >= 6)  return "🟢🟢🟢";
        if (abs >= 4)  return "🟡🟡";
        if (abs >= 2)  return "🟡";
        return "🔴";
    }
}
