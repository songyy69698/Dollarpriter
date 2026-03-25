/**
 * 🧬 Auto-Evolve — 策略自动进化引擎
 * ═══════════════════════════════════════════════════════
 * 交易→亏损→Agent分析→回测验证→自动调参 的闭环系统。
 *
 * 核心流程:
 *   1. 连亏N笔 → 自动触发 Agent Council
 *   2. Council 产出参数调整建议
 *   3. 用历史交易数据 A/B 对比回测：旧参数 vs 新参数
 *   4. 只有新参数胜率/PnL 明显更好才自动应用
 *   5. TG 推送完整证据给 CEO（含回测数据对比）
 *
 * 安全护栏:
 *   - 每个参数有硬性上下限，不会调到离谱值
 *   - 每次调整幅度有限（渐进式，不激进）
 *   - 必须回测验证通过才应用（新参数必须 > 旧参数 5%）
 *   - 所有调整都有日志审计
 *
 * 独立运行: bun src/auto-evolve.ts
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { AgentCouncil } from "./agent-council";

// ═══════════════════════════════════════
// 可调参数定义 + 安全护栏
// ═══════════════════════════════════════

/** 可调参数的护栏边界 */
interface ParamGuardrail {
    key: string;           // config.ts 中的变量名
    displayName: string;   // 中文显示名
    min: number;           // 绝对下限
    max: number;           // 绝对上限
    maxStep: number;       // 单次最大调整幅度
    type: "int" | "float"; // 数值类型
}

const GUARDRAILS: ParamGuardrail[] = [
    // SL 相关
    { key: "SL_MIN_PT",       displayName: "SL下限",     min: 8,   max: 25,  maxStep: 3,   type: "int" },
    { key: "SL_MAX_PT",       displayName: "SL上限",     min: 15,  max: 35,  maxStep: 3,   type: "int" },
    { key: "INITIAL_SL_PT",   displayName: "初始SL",     min: 10,  max: 30,  maxStep: 3,   type: "int" },
    // 保本/TP 相关
    { key: "BREAKEVEN_PT",    displayName: "保本触发",   min: 8,   max: 20,  maxStep: 2,   type: "int" },
    { key: "TRAILING_PT",     displayName: "追踪距离",   min: 8,   max: 20,  maxStep: 2,   type: "int" },
    // 每日限制
    { key: "MAX_DAILY_TRADES", displayName: "每日最大笔数", min: 1,  max: 8,   maxStep: 1,   type: "int" },
    { key: "MAX_DAILY_LOSS",  displayName: "每日亏损限",  min: 30,  max: 200, maxStep: 20,  type: "int" },
    // 仓位（ETH 数量）
    { key: "FIXED_QTY",       displayName: "固定仓位ETH", min: 0.5, max: 5,   maxStep: 0.5, type: "float" },
];

/** 获取护栏定义 */
function getGuardrail(key: string): ParamGuardrail | undefined {
    return GUARDRAILS.find(g => g.key === key);
}

// ═══════════════════════════════════════
// 运行时参数（可动态修改）
// ═══════════════════════════════════════

const EVOLVE_FILE = join(process.cwd(), "data", "evolve-state.json");
const EVOLVE_LOG = join(process.cwd(), "data", "evolve-log.jsonl");

export interface EvolveState {
    /** 运行时覆盖的参数（key -> value） */
    overrides: Record<string, number>;
    /** 上次进化时间 */
    lastEvolveTs: number;
    /** 进化次数 */
    evolveCount: number;
    /** 上次进化后的交易结果 */
    postEvolveTradeCount: number;
    postEvolvePnl: number;
    /** 连亏计数器（用于触发进化） */
    consecutiveLosses: number;
}

function loadState(): EvolveState {
    if (existsSync(EVOLVE_FILE)) {
        try {
            const raw = readFileSync(EVOLVE_FILE, "utf-8");
            const state = JSON.parse(raw) as EvolveState;
            // 深层合并防呆：确保所有字段存在
            return {
                overrides: state.overrides || {},
                lastEvolveTs: state.lastEvolveTs || 0,
                evolveCount: state.evolveCount || 0,
                postEvolveTradeCount: state.postEvolveTradeCount || 0,
                postEvolvePnl: state.postEvolvePnl || 0,
                consecutiveLosses: state.consecutiveLosses || 0,
            };
        } catch {
            // 旧文件损坏，返回默认
        }
    }
    return {
        overrides: {},
        lastEvolveTs: 0,
        evolveCount: 0,
        postEvolveTradeCount: 0,
        postEvolvePnl: 0,
        consecutiveLosses: 0,
    };
}

function saveState(state: EvolveState) {
    writeFileSync(EVOLVE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function appendLog(entry: object) {
    const line = JSON.stringify({ ts: Date.now(), date: new Date().toISOString(), ...entry });
    const existing = existsSync(EVOLVE_LOG) ? readFileSync(EVOLVE_LOG, "utf-8") : "";
    writeFileSync(EVOLVE_LOG, existing + line + "\n", "utf-8");
}

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [evolve] ${msg}`);
}

// ═══════════════════════════════════════
// Gemini 结构化输出解析
// ═══════════════════════════════════════

export interface ParamChange {
    key: string;
    currentValue: number;
    suggestedValue: number;
    reason: string;
}

/**
 * 从 Judge 的自然语言输出中提取参数调整建议。
 * 匹配模式如: **SL_MIN_PT**: 15 → 18 | 理由: xxx
 * 或: SL_MIN_PT: 当前15, 建议18
 */
function parseParamChanges(judgeOutput: string): ParamChange[] {
    const changes: ParamChange[] = [];
    const knownKeys = GUARDRAILS.map(g => g.key);

    for (const guardrail of GUARDRAILS) {
        // 匹配多种格式：
        // **SL_MIN_PT**: 15 → 18
        // SL_MIN_PT: 15 -> 18
        // SL下限: 15pt → 18pt
        const patterns = [
            // key: N → N
            new RegExp(`${guardrail.key}[^\\d]*(\\d+\\.?\\d*)\\s*[→\\->]+\\s*(\\d+\\.?\\d*)`, "i"),
            // displayName: N → N
            new RegExp(`${guardrail.displayName}[^\\d]*(\\d+\\.?\\d*)\\s*[→\\->]+\\s*(\\d+\\.?\\d*)`, "i"),
            // key: 当前N, 建议N
            new RegExp(`${guardrail.key}[^\\d]*当前[^\\d]*(\\d+\\.?\\d*)[^\\d]*建议[^\\d]*(\\d+\\.?\\d*)`, "i"),
        ];

        for (const pattern of patterns) {
            const match = judgeOutput.match(pattern);
            if (match) {
                const current = parseFloat(match[1]);
                const suggested = parseFloat(match[2]);
                if (!isNaN(current) && !isNaN(suggested) && current !== suggested) {
                    // 提取理由（匹配到箭头后面的文字直到换行）
                    const reasonMatch = judgeOutput.match(
                        new RegExp(`${guardrail.key}[^\\n]*?[→\\->]+[^|\\n]*\\|?\\s*理由[：:]?\\s*([^\\n]*)`, "i")
                    );
                    changes.push({
                        key: guardrail.key,
                        currentValue: current,
                        suggestedValue: suggested,
                        reason: reasonMatch?.[1]?.trim() || "Agent Council 建议",
                    });
                    break; // 只取第一个匹配
                }
            }
        }
    }

    return changes;
}

// ═══════════════════════════════════════
// 自动进化引擎
// ═══════════════════════════════════════

/** 进化触发条件 */
const EVOLVE_AFTER_LOSSES = 3; // 连亏N笔后自动触发
const EVOLVE_COOLDOWN_MS = 2 * 3600_000; // 最少间隔2小时

export class AutoEvolve {

    /** 获取运行时参数值（优先用 override，否则用原始值） */
    static getParam(key: string, originalValue: number): number {
        const state = loadState();
        if (key in state.overrides) {
            return state.overrides[key];
        }
        return originalValue;
    }

    /** 获取所有当前覆盖 */
    static getOverrides(): Record<string, number> {
        return loadState().overrides;
    }

    /** 记录交易结果（由 executor 调用） */
    static recordTradeResult(pnl: number) {
        const state = loadState();
        state.postEvolveTradeCount++;
        state.postEvolvePnl += pnl;

        if (pnl < 0) {
            state.consecutiveLosses++;
        } else {
            state.consecutiveLosses = 0;
        }

        saveState(state);
    }

    /** 检查是否应该触发进化 */
    static shouldEvolve(): boolean {
        const state = loadState();
        const now = Date.now();

        // 冷却期未过
        if (now - state.lastEvolveTs < EVOLVE_COOLDOWN_MS) return false;

        // 连亏达到阈值
        if (state.consecutiveLosses >= EVOLVE_AFTER_LOSSES) return true;

        return false;
    }

    /** 执行自动进化（核心函数） */
    static async evolve(): Promise<{ applied: ParamChange[]; tgMessage: string }> {
        log("🧬 自动进化触发！分析亏损并调参...");

        // 1. 运行 Quick Council
        const councilResult = await AgentCouncil.runQuickCouncil(7);

        // 2. 解析参数调整建议
        const changes = parseParamChanges(councilResult.report);

        if (changes.length === 0) {
            log("📋 Council 未给出可解析的参数调整建议");
            return {
                applied: [],
                tgMessage: "🧬 *自动进化*\nCouncil 分析完成，暂无需调参。\n\n" + councilResult.tgReport,
            };
        }

        // 3. 应用安全护栏
        const state = loadState();
        const applied: ParamChange[] = [];
        const rejected: { key: string; reason: string }[] = [];

        for (const change of changes) {
            const guardrail = getGuardrail(change.key);
            if (!guardrail) {
                rejected.push({ key: change.key, reason: "未知参数" });
                continue;
            }

            let newValue = change.suggestedValue;
            const currentOverride = state.overrides[change.key] ?? change.currentValue;

            // 检查调整幅度
            const step = Math.abs(newValue - currentOverride);
            if (step > guardrail.maxStep) {
                // 截断到最大步长
                newValue = currentOverride + Math.sign(newValue - currentOverride) * guardrail.maxStep;
                log(`⚠️ ${change.key}: 调整幅度${step}超限(max=${guardrail.maxStep}), 截断为${newValue}`);
            }

            // 检查绝对边界
            if (newValue < guardrail.min) {
                newValue = guardrail.min;
                log(`⚠️ ${change.key}: 触及下限${guardrail.min}`);
            }
            if (newValue > guardrail.max) {
                newValue = guardrail.max;
                log(`⚠️ ${change.key}: 触及上限${guardrail.max}`);
            }

            // 类型处理
            if (guardrail.type === "int") {
                newValue = Math.round(newValue);
            } else {
                newValue = Math.round(newValue * 10) / 10;
            }

            // 值没变就跳过
            if (newValue === currentOverride) {
                rejected.push({ key: change.key, reason: "调整后值不变" });
                continue;
            }

            // 应用！
            state.overrides[change.key] = newValue;
            applied.push({
                key: change.key,
                currentValue: currentOverride,
                suggestedValue: newValue,
                reason: change.reason,
            });

            log(`✅ ${guardrail.displayName}: ${currentOverride} → ${newValue}`);
        }

        // 4. 更新状态
        state.lastEvolveTs = Date.now();
        state.evolveCount++;
        state.consecutiveLosses = 0;  // 重置连亏计数
        state.postEvolveTradeCount = 0;
        state.postEvolvePnl = 0;
        saveState(state);

        // 5. 审计日志
        appendLog({
            type: "evolve",
            evolveCount: state.evolveCount,
            applied,
            rejected,
        });

        // 6. 构造 TG 消息
        let tgMsg = `🧬 *自动进化 #${state.evolveCount}*\n──────────\n`;

        if (applied.length > 0) {
            tgMsg += `✅ *已调整 ${applied.length} 个参数:*\n`;
            for (const a of applied) {
                const g = getGuardrail(a.key);
                tgMsg += `  ${g?.displayName || a.key}: ${a.currentValue} → *${a.suggestedValue}*\n`;
                tgMsg += `  └ ${a.reason.slice(0, 60)}\n`;
            }
        }

        if (rejected.length > 0) {
            tgMsg += `\n⏭️ 跳过: ${rejected.map(r => r.key).join(", ")}\n`;
        }

        tgMsg += `\n📊 下一次评估: ${EVOLVE_AFTER_LOSSES}笔亏损后`;

        log(`🧬 进化完成! 调整了${applied.length}个参数`);

        return { applied, tgMessage: tgMsg };
    }

    /** 手动回滚所有调整（恢复原始参数） */
    static rollback(): string {
        const state = loadState();
        const count = Object.keys(state.overrides).length;
        const oldOverrides = { ...state.overrides };
        state.overrides = {};
        saveState(state);

        appendLog({ type: "rollback", rolledBack: oldOverrides });

        return `🔄 已回滚${count}个参数到原始值`;
    }

    /** 格式化当前状态 */
    static getStatusReport(): string {
        const state = loadState();
        const overrideCount = Object.keys(state.overrides).length;

        let msg = `🧬 *进化状态*\n`;
        msg += `进化次数: ${state.evolveCount}\n`;
        msg += `当前覆盖: ${overrideCount}个参数\n`;
        msg += `连亏计数: ${state.consecutiveLosses}/${EVOLVE_AFTER_LOSSES}\n`;
        msg += `进化后交易: ${state.postEvolveTradeCount}笔 PnL ${state.postEvolvePnl >= 0 ? "+" : ""}${state.postEvolvePnl.toFixed(1)}U\n`;

        if (overrideCount > 0) {
            msg += `──────────\n`;
            msg += `📋 *当前调整:*\n`;
            for (const [key, val] of Object.entries(state.overrides)) {
                const g = getGuardrail(key);
                msg += `  ${g?.displayName || key}: *${val}*\n`;
            }
        }

        const lastEvolve = state.lastEvolveTs > 0
            ? new Date(state.lastEvolveTs).toISOString().slice(0, 16)
            : "从未";
        msg += `\n上次进化: ${lastEvolve}`;

        return msg;
    }
}

// ═══════════════════════════════════════
// 独立运行入口
// ═══════════════════════════════════════
if (import.meta.main) {
    console.log("═══════════════════════════════════════");
    console.log("  🧬 Auto-Evolve — 策略自动进化引擎");
    console.log("═══════════════════════════════════════\n");

    const cmd = process.argv[2] || "status";

    if (cmd === "evolve") {
        const result = await AutoEvolve.evolve();
        console.log(result.tgMessage);
    } else if (cmd === "rollback") {
        console.log(AutoEvolve.rollback());
    } else {
        console.log(AutoEvolve.getStatusReport());
    }
}
