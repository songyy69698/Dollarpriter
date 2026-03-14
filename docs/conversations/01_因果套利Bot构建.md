# 因果套利 Bot (Causal Arbitrage Bot) — 初始构建

> **对话 ID**: `fbea3c9d-b512-4079-9053-a408acba8c26`
> **日期**: 2026-03-13
> **主题**: Cashprinter Bot 构建与部署

---

## 项目结构

```
Cashprinter/
├── package.json          # Bun + TypeScript
├── tsconfig.json
├── .env                  # Bitunix + Telegram 凭证
├── .gitignore
└── src/
    ├── config.ts         # ⚙️ 核心数学参数
    ├── bitunix-ws.ts     # 🔌 Bitunix WS 数据引擎
    ├── executor.ts       # ⚡ Bitunix 下单/出场引擎
    ├── strategy.ts       # 🧠 因果套利策略
    ├── telegram.ts       # 📱 TG 通知 + 指令
    └── main.ts           # 🎯 主控制器
```

## 核心策略逻辑

| 阶段 | 条件 | 动作 |
|---|---|---|
| **进场 (多)** | 买压 > 卖墙 × 2.5 且 效率 > 均值 | 200x MARKET 开多 |
| **进场 (空)** | 卖压 > 买墙 × 2.5 且 效率 > 均值 | 200x MARKET 开空 |
| **小损止损** | pnl < -0.15% | 立即平仓 (因果断裂) |
| **保本锁定** | pnl > +0.12% | SL 移至进场价 (零风险) |
| **效率衰竭** | volume > 均量×3 且 效率 < 0.2 | 大利润止盈 |

## 架构方案

基于 CEO 提供的策略蓝图，构建全新的**因果套利交易机器人**。核心逻辑：通过 Bitunix 原生 WebSocket 监控逐笔成交(Trade)和深度盘口(Depth)，当**主动买单量 > 卖盘挂牌量 × 2.5 倍**（因大于果的阻力）时，200倍杠杆进场；持仓后以 **0.15% 小损止损** + **效率衰竭大利润止盈** 管理风险。

### 核心参数

| 参数 | 值 | 说明 |
|---|---|---|
| `LEVERAGE` | 200 | 200倍杠杆 |
| `IMBALANCE_RATIO` | 2.5 | 主动买单 > 卖盘墙 × 2.5 才进场 |
| `STOP_LOSS_PCT` | 0.0015 | 0.15% 物理止损 |
| `BE_TARGET_PCT` | 0.0012 | 0.12% 后移至保本位 |
| `EFFICIENCY_DECAY` | 0.2 | 效率 < 0.2 时判定衰竭止盈 |
| `VOL_SPIKE_MULT` | 3 | 成交量 > 均量 × 3 + 效率低 → 止盈 |

### Bitunix WebSocket 数据引擎

- 端点：`wss://fapi.bitunix.com/public/`
- 订阅频道：Trade Channel + Depth Channel
- 输出 `CausalSnapshot` 接口

### 出场逻辑

- ✅ Bitunix Double-SHA256 签名机制
- ✅ MARKET 下单 + Atomic STOP_MARKET 止损
- ✅ 仓位同步 (`syncPositions`)
- ✅ 余额查询 (`getBalance`)
- ✅ 取消订单 / 部分平仓 / 强制平仓

## 环境变量

| Key | 描述 |
|---|---|
| `BITUNIX_API_KEY` | Bitunix API Key |
| `BITUNIX_SECRET_KEY` | Bitunix Secret |
| `TELEGRAM_BOT_TOKEN` | TG Bot Token |
| `TELEGRAM_CHAT_ID` | TG Chat ID |

## 编译验证

```
✅ Bundled 6 modules in 13ms → main.js 31.89 KB
```
