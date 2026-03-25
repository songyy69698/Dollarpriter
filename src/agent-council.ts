/**
 * 🧠 Agent Council — 多 Agent 辩论式策略优化器
 * ═══════════════════════════════════════════════════════
 * 5个 AI Agent 角色分析亏损交易，互相辩论，产出可执行的策略优化建议。
 *
 * 角色:
 *   🗡️ Alpha   — 激进交易员，分析入场时机
 *   🛡️ Guardian — 风控官，分析SL/仓位
 *   📊 Quant   — 量化分析师，统计找模式
 *   🧠 Psych   — 交易心理师，检测过度交易
 *   ⚖️ Judge   — 裁判官，综合产出方案
 *
 * 独立运行: bun src/agent-council.ts
 * 嵌入运行: import { AgentCouncil } from "./agent-council"
 */

import { SelfReflector } from "./self-reflect";

// ═══════════════════════════════════════
// Gemini API 配置
// ═══════════════════════════════════════
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

function log(msg: string) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    console.log(`${ts} [council] ${msg}`);
}

// ═══════════════════════════════════════
// Agent 角色定义
// ═══════════════════════════════════════

interface AgentRole {
    name: string;
    emoji: string;
    systemPrompt: string;
}

const AGENTS: Record<string, AgentRole> = {
    alpha: {
        name: "Alpha",
        emoji: "🗡️",
        systemPrompt: `你是 Alpha，一个暴躁、贪婪、永不满足的短线交易老手。
你的每日目标是 $300-500 净利。达不到你就暴走。

你的工作方式:
- 看到亏损交易 → "又亏了？！入场时机到底看了没有？"
- 看到小赚 → "就赚 $5？Fire Candle 50pt 的行情你只吃 5 块钱？你在做慈善？"
- 看到最佳浮盈远大于实际盈利 → "最大浮盈 +35pt 你 +8pt 就跑了，剩下的全送给市场了！"
- 看到交易次数太少 → "一天才做 1 笔？行情明明有 3 次机会你都没抓到！"

你必须:
1. 逐笔审视每笔交易（赢单和亏单都要看）
2. 计算"差距"：今日 PnL vs $300 目标差多少
3. 指出哪里钱没赚到：是出太早？进太晚？还是机会没抓到？
4. 对怎么把每日利润推高到 $300-500 提出具体要求

语气：暴躁、不留情面、数据说话。回复用简体中文。`,
    },
    guardian: {
        name: "Guardian",
        emoji: "🛡️",
        systemPrompt: `你是 Guardian，一个极度保守的资金管家。你的信条是"先活下来，才能赚钱"。
你的目标是让本金稳定成长，绝不允许大起大落。

你的核心关注:
1. **杠杆控制**: 当前用 150x 杠杆合理吗？账户余额波动时应该动态调整杠杆吗？
2. **单笔风险**: 每笔亏损占本金的比例。超过 3% 就是红线。
3. **资金曲线**: 账户余额应该是平稳上升的曲线，不是过山车。
4. **回撤控制**: 最大回撤不应超过本金的 20%。
5. **锁利机制**: 赚到一定程度后，是否应该缩小仓位保住利润？
6. **仓位动态调整**: 赚钱时可以逐步加仓，亏钱时必须缩仓。

你必须:
1. 计算近期每笔交易的风险敞口（仓位 × 杠杆 × SL占比）
2. 评估当前本金的健康度
3. 给出具体的杠杆和仓位调整建议
4. 如果 Alpha 提出的利润目标会导致过度风险，你要明确反对

语气：谨慎、专业、数据驱动。回复用简体中文。`,
    },
    quant: {
        name: "Quant",
        emoji: "📊",
        systemPrompt: `你是 Quant，一个冷静务实的量化分析师。你不靠猜测，只靠数据。

你的工作方式:
1. **分析现有策略的统计表现**:
   - 做多 vs 做空哪个方向更赚？差多少？
   - 哪些 UTC 时段是"死亡时段"（亏多赢少）？
   - ATR 大小跟胜率有什么关系？
   - 赢单和亏单的持仓时间差异
   - SL 被扫的单子，被扫前平均浮盈过多少？SL是不是太紧？
   - 保本触发后真正盈利的比例是多少？

2. **找到更好的参数组合**:
   - 基于数据分析，建议调整哪些参数
   - 每个建议必须有数据支撑（"因为 X 时段胜率只有 30%，建议避开"）
   - 建议具体的参数值，不要说"适当调整"这种废话

3. **找到更好的方式**:
   - 现有的入场条件（3核心/4of5/5条件）哪种更赚？
   - 是否有被忽略的信号组合？
   - 是否某些过滤条件太严导致错过好机会？

你的输出必须包含数字、比率、对比。回复用简体中文。`,
    },
    psych: {
        name: "Psych",
        emoji: "🧠",
        systemPrompt: `你是 Psych，一个怀疑论者和质量检查员。你的工作是挑战其他 Agent（尤其是 Quant）的结论。

你的工作方式:
1. 看到 Quant 说"改参数X能提高胜率" → 你质疑:
   - "样本量够吗？10笔交易就下结论？"
   - "你测的是上涨行情，震荡行情也有效吗？"
   - "胜率提高了但回撤也变大了，真的更好？"
   - "只看了3个月数据，这不是过拟合吗？"

2. 看到 Alpha 说"要赚更多" → 你质疑:
   - "追求高利润必然要承担更大风险，你算过爆仓概率吗？"
   - "把 SL 放大赚更多，但一旦错了亏更惨"

3. 看到建议的参数改动 → 你检查:
   - 新旧参数之间的改善幅度有没有超过 5%？低于 5% 可能只是噪音
   - 在不同行情阶段（趋势/震荡/暴跌）都测过吗？
   - 有没有"幸存者偏差"？

你是团队的刹车。没有你的认可，任何改动都不应该通过。
语气：冷静、挑刺、逻辑严密。回复用简体中文。`,
    },
    judge: {
        name: "Judge",
        emoji: "⚖️",
        systemPrompt: `你是 Judge，Agent Council 的最终裁决者。你综合所有 Agent 的意见，做出最终决定。

你会收到以下 Agent 的分析:
- 🗡️ Alpha: 暴躁交易员，天天要赚$300-500
- 🛡️ Guardian: 资金管家，要保本金稳定成长
- 📊 Quant: 量化分析师，用数据找更好参数
- 🧠 Psych: 质疑者，挑战其他人的结论

你的裁定原则:
1. Alpha 和 Guardian 会有冲突（赚多 vs 安全）→ 你要找平衡点
2. Quant 的建议必须经过 Psych 质疑后依然成立才能采纳
3. 每条通过的建议必须有**证据**（数据、对比、统计显著性）
4. 最多给出 5 条可执行建议

输出格式（严格遵守）:
---
## 🏛️ Agent Council 裁定

### Alpha vs Guardian 平衡
[Alpha 想赚更多 vs Guardian 想控风险，你的裁定]

### 通过的优化建议
1. **[参数/方法]**: [当前] → [建议] | 证据: [数据支撑]
2. ...

### 被否决的建议
[Psych 成功质疑推翻的建议，以及否决理由]

### CEO 行动项
[CEO 需要做什么]
---

回复用简体中文，权威果断。`,
    },
};

// ═══════════════════════════════════════
// Gemini API 调用
// ═══════════════════════════════════════

async function callGemini(systemPrompt: string, userMessage: string): Promise<string> {
    if (!GEMINI_API_KEY) {
        return "❌ 未设置 GEMINI_API_KEY 环境变量";
    }

    const url = `${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const body = {
        system_instruction: {
            parts: [{ text: systemPrompt }],
        },
        contents: [
            {
                role: "user",
                parts: [{ text: userMessage }],
            },
        ],
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1500,
            topP: 0.9,
        },
    };

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const err = await res.text();
            log(`❌ Gemini API ${res.status}: ${err.slice(0, 200)}`);
            return `❌ API错误: ${res.status}`;
        }

        const data = (await res.json()) as any;
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        return text;
    } catch (e) {
        log(`❌ Gemini请求失败: ${e}`);
        return `❌ 请求失败: ${e}`;
    }
}

// ═══════════════════════════════════════
// 交易数据提取
// ═══════════════════════════════════════

function extractTradeContext(days: number = 14): string {
    const trades = SelfReflector.readRecentTrades(days);
    if (trades.length === 0) return "无交易记录";

    const analysis = SelfReflector.analyzePerformance(trades);
    const losses = trades.filter(t => t.netPnlU < 0);
    const wins = trades.filter(t => t.netPnlU > 0);

    // 构造精简的交易数据摘要
    let ctx = `## 交易数据摘要 (近${days}天)\n\n`;
    ctx += `总交易: ${analysis.totalTrades}笔 | 胜率: ${(analysis.winRate * 100).toFixed(0)}% | PnL: ${analysis.totalPnl >= 0 ? "+" : ""}${analysis.totalPnl.toFixed(1)}U\n`;
    ctx += `做多: ${analysis.longWins}/${analysis.longCount}(${analysis.longCount > 0 ? (analysis.longWinRate * 100).toFixed(0) : "—"}%) PnL ${analysis.longPnl >= 0 ? "+" : ""}${analysis.longPnl.toFixed(0)}U\n`;
    ctx += `做空: ${analysis.shortWins}/${analysis.shortCount}(${analysis.shortCount > 0 ? (analysis.shortWinRate * 100).toFixed(0) : "—"}%) PnL ${analysis.shortPnl >= 0 ? "+" : ""}${analysis.shortPnl.toFixed(0)}U\n`;
    ctx += `连亏: 当前${Math.abs(analysis.currentStreak)}笔 | 历史最大${analysis.maxLossStreak}笔\n`;
    ctx += `SL被扫: ${analysis.slTradeCount}笔 | 被扫前均浮盈+${analysis.slAvgBestProfit.toFixed(0)}pt\n`;
    ctx += `保本触发: ${analysis.breakevenCount}次 | ${(analysis.breakevenProfitRate * 100).toFixed(0)}%最终盈利\n`;
    ctx += `滑点: 均${analysis.avgSlippage.toFixed(1)}pt | 最大${analysis.maxSlippage.toFixed(1)}pt\n`;
    ctx += `持仓: 均${analysis.avgHoldMinutes.toFixed(0)}min | 赢单${analysis.winAvgHold.toFixed(0)}min | 亏单${analysis.lossAvgHold.toFixed(0)}min\n\n`;

    // 时段分析
    const sortedHours = Object.entries(analysis.hourlyStats).sort((a, b) => +a[0] - +b[0]);
    if (sortedHours.length > 0) {
        ctx += `## 时段(UTC)\n`;
        for (const [h, s] of sortedHours) {
            const wr = (s.wins / s.count * 100).toFixed(0);
            const icon = s.pnl >= 0 ? "🟢" : "🔴";
            ctx += `${icon} UTC ${String(h).padStart(2)}h: ${s.count}笔 胜率${wr}% PnL ${s.pnl >= 0 ? "+" : ""}${s.pnl.toFixed(0)}U\n`;
        }
        ctx += "\n";
    }

    // 最近亏损单明细（最多10笔）
    const recentLosses = losses.slice(-10);
    if (recentLosses.length > 0) {
        ctx += `## 最近${recentLosses.length}笔亏损单\n`;
        for (const t of recentLosses) {
            const d = new Date(t.ts);
            const utcH = d.getUTCHours();
            ctx += `- ${t.date.slice(5, 16)} UTC${utcH}h | ${t.side.toUpperCase()} ${t.qty}ETH `;
            ctx += `@ $${t.entryPrice.toFixed(0)} | PnL ${t.netPnlU.toFixed(1)}U | `;
            ctx += `SL=${t.slPt.toFixed(0)}pt 最佳浮盈+${t.bestProfitPt.toFixed(0)}pt `;
            ctx += `| ATR=${t.atr.toFixed(0)} Hold=${t.holdMinutes.toFixed(0)}min `;
            ctx += `| ${t.reason.slice(0, 30)}\n`;
        }
        ctx += "\n";
    }

    // 最近赢单（最多5笔作对比）
    const recentWins = wins.slice(-5);
    if (recentWins.length > 0) {
        ctx += `## 最近${recentWins.length}笔赢单（对比）\n`;
        for (const t of recentWins) {
            const d = new Date(t.ts);
            const utcH = d.getUTCHours();
            ctx += `- ${t.date.slice(5, 16)} UTC${utcH}h | ${t.side.toUpperCase()} ${t.qty}ETH `;
            ctx += `@ $${t.entryPrice.toFixed(0)} | PnL +${t.netPnlU.toFixed(1)}U | `;
            ctx += `最佳+${t.bestProfitPt.toFixed(0)}pt Hold=${t.holdMinutes.toFixed(0)}min\n`;
        }
        ctx += "\n";
    }

    // 当前策略参数
    ctx += `## 当前策略参数 (V104)\n`;
    ctx += `- 杠杆: 150x | 固定仓位: 2ETH\n`;
    ctx += `- Fire Candle: UTC 08-12 合成 | 实体≥35% | 范围≥35pt\n`;
    ctx += `- 诱导回踩: 深度≥5pt | 量能≥均量×1.3\n`;
    ctx += `- 5m入场: 回穿Fire Close | 强阳≥58% | 量能≥1.4x\n`;
    ctx += `- 动态SL: [15pt, 22pt] | 诱导低点+8pt\n`;
    ctx += `- 保本: +12pt | Trailing: -12pt | 分批TP: +30pt平50% / +100pt全平\n`;
    ctx += `- 每日: 最多4笔 | 亏损限$80 | 连亏2笔停\n`;
    ctx += `- Funding过滤: |Funding|>0.05%不逆势\n`;
    ctx += `- ATR: <avg20×0.62跳过 | >68跳过\n`;

    return ctx;
}

// ═══════════════════════════════════════
// 辩论引擎
// ═══════════════════════════════════════

export class AgentCouncil {

    /** 运行完整的多Agent辩论（3轮） */
    static async runCouncil(days: number = 14): Promise<{ report: string; tgReport: string }> {
        if (!GEMINI_API_KEY) {
            return {
                report: "❌ 未设置 GEMINI_API_KEY",
                tgReport: "❌ 未设置 GEMINI\\_API\\_KEY 环境变量",
            };
        }

        log("🏛️ Agent Council 召开中...");
        const startMs = Date.now();

        // Step 1: 提取交易数据
        const tradeData = extractTradeContext(days);
        if (tradeData === "无交易记录") {
            return {
                report: "⚠️ 无交易记录",
                tgReport: "⚠️ 无交易记录，无法召开 Council",
            };
        }
        log(`📊 数据提取完成`);

        // ═══ Round 1: Alpha / Guardian / Quant 独立分析（并行）═══
        log("🗡️🛡️📊 Round 1: 三位 Agent 独立分析...");
        const round1Prompt = `以下是近期的交易数据，请从你的专业角度分析，给出具体的优化建议。\n\n${tradeData}`;

        const [alphaR, guardianR, quantR] = await Promise.all([
            callGemini(AGENTS.alpha.systemPrompt, round1Prompt),
            callGemini(AGENTS.guardian.systemPrompt, round1Prompt),
            callGemini(AGENTS.quant.systemPrompt, round1Prompt),
        ]);
        log(`✅ Round 1 完成`);

        // ═══ Round 2: Psych 质疑 Alpha 和 Quant ═══
        log("🧠 Round 2: Psych 质疑中...");
        const psychPrompt =
            `以下是 Alpha（交易员）和 Quant（量化师）的分析和建议。请从你的质疑者角度挑战他们的结论。\n\n` +
            `### 🗡️ Alpha 的意见:\n${alphaR}\n\n` +
            `### 📊 Quant 的建议:\n${quantR}\n\n` +
            `### 原始交易数据（供你交叉验证）:\n${tradeData.slice(0, 2000)}`;

        const psychR = await callGemini(AGENTS.psych.systemPrompt, psychPrompt);
        log(`✅ Round 2 完成`);

        // ═══ Round 3: Judge 综合裁定 ═══
        log("⚖️ Round 3: Judge 综合裁定...");
        const judgePrompt =
            `以下是 Agent Council 的完整辩论记录，请做出最终裁定。\n\n` +
            `### 🗡️ Alpha（暴躁交易员）:\n${alphaR}\n\n` +
            `### 🛡️ Guardian（资金管家）:\n${guardianR}\n\n` +
            `### 📊 Quant（量化师）:\n${quantR}\n\n` +
            `### 🧠 Psych（质疑者）对 Alpha 和 Quant 的挑战:\n${psychR}`;

        const judgeResult = await callGemini(AGENTS.judge.systemPrompt, judgePrompt);
        log(`✅ Round 3 完成`);

        const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
        log(`🏛️ Council 完成! 耗时${elapsed}秒`);

        // 组装完整报告
        const fullReport =
            `# 🏛️ Agent Council 策略优化报告\n\n` +
            `> 生成时间: ${new Date().toISOString().slice(0, 19)} | 耗时: ${elapsed}s | 分析${days}天数据\n\n` +
            `---\n\n` +
            `## Round 1: 独立分析\n\n` +
            `### 🗡️ Alpha（暴躁交易员）\n${alphaR}\n\n---\n\n` +
            `### 🛡️ Guardian（资金管家）\n${guardianR}\n\n---\n\n` +
            `### 📊 Quant（量化师）\n${quantR}\n\n---\n\n` +
            `## Round 2: 质疑环节\n\n` +
            `### 🧠 Psych（质疑者）\n${psychR}\n\n---\n\n` +
            `## Round 3: 最终裁定\n\n` +
            `### ⚖️ Judge\n${judgeResult}`;

        // TG 版本（精简，只发 Judge 裁定）
        const tgReport =
            `🏛️ *Agent Council 报告* (${elapsed}s)\n` +
            `──────────\n` +
            `${judgeResult.slice(0, 3500)}`;

        return { report: fullReport, tgReport };
    }

    /** 快速版: 只跑2个Agent (Quant + Guardian) + Judge，更省时省钱 */
    static async runQuickCouncil(days: number = 7): Promise<{ report: string; tgReport: string }> {
        if (!GEMINI_API_KEY) {
            return {
                report: "❌ 未设置 GEMINI_API_KEY",
                tgReport: "❌ 未设置 GEMINI\\_API\\_KEY",
            };
        }

        log("⚡ Quick Council 召开中...");
        const startMs = Date.now();

        const tradeData = extractTradeContext(days);
        if (tradeData === "无交易记录") {
            return { report: "⚠️ 无交易记录", tgReport: "⚠️ 无交易记录" };
        }

        const prompt = `以下是近期的交易数据，请从你的专业角度分析亏损原因，给出具体的优化建议。\n\n${tradeData}`;

        const [quantR, guardianR] = await Promise.all([
            callGemini(AGENTS.quant.systemPrompt, prompt),
            callGemini(AGENTS.guardian.systemPrompt, prompt),
        ]);

        const judgePrompt =
            `以下是2位专家的分析，请综合产出最终裁定。\n\n` +
            `### 📊 Quant:\n${quantR}\n\n` +
            `### 🛡️ Guardian:\n${guardianR}`;

        const judgeResult = await callGemini(AGENTS.judge.systemPrompt, judgePrompt);

        const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
        log(`⚡ Quick Council 完成! 耗时${elapsed}秒`);

        const tgReport =
            `⚡ *Quick Council* (${elapsed}s)\n` +
            `──────────\n` +
            `${judgeResult.slice(0, 3500)}`;

        return { report: judgeResult, tgReport };
    }
}

// ═══════════════════════════════════════
// 独立运行入口
// ═══════════════════════════════════════
if (import.meta.main) {
    console.log("═══════════════════════════════════════");
    console.log("  🏛️ Agent Council — 多Agent策略辩论");
    console.log("═══════════════════════════════════════\n");

    if (!GEMINI_API_KEY) {
        console.log("❌ 请设置环境变量 GEMINI_API_KEY");
        console.log("   export GEMINI_API_KEY=AIzaSy-xxxxx");
        process.exit(1);
    }

    const mode = process.argv[2] || "full";
    const days = parseInt(process.argv[3] || "14");

    console.log(`模式: ${mode === "quick" ? "⚡快速" : "🏛️完整"} | 分析${days}天数据\n`);

    let result: { report: string; tgReport: string };
    if (mode === "quick") {
        result = await AgentCouncil.runQuickCouncil(days);
    } else {
        result = await AgentCouncil.runCouncil(days);
    }

    console.log("\n" + result.report);

    console.log("\n═══ TG 报告 ═══");
    console.log(result.tgReport);
}
