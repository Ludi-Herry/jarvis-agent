# agent-harness

自研的 TypeScript/Node **agent-code CLI + agent harness**（陆凌华 / Luis）。核心架构：**有状态宿主 + 纯函数决策点**的 agent loop，事件流 day-1 解耦前端，渐进披露 skill，确定性交脚本、判断交模型。

> 设计依据不在本仓库重写，以知识库蓝图为准（见 `AGENTS.md`「唯一设计依据」）。当前处于 **Phase A**（让单 agent 在终端跑起来）。

## 当前状态（2026-06-27）

| 里程碑 | 状态 |
|---|---|
| A0 脚手架 | ✅ 完成 |
| **A1 能说话**（ModelProvider + EventBus） | ✅ 完成并验收 |
| A2 能调工具（ToolRegistry + AgentLoop 骨架） | ◀ 下一步 |
| A3–A6（压缩 / CLI / skill / 验收收口） | 未开始 |

里程碑全貌与设计见 `docs/phase-A-plan.md`；A0+A1 交接见 `docs/handoff-A1.md`。

## 这是什么

- **是**：一个有状态宿主 + 纯函数决策点的 agent loop，事件流第一天就解耦前端，确定性交脚本、判断交模型。
- **不是**：不预埋抽象层 / 插件系统 / 通用框架；反过度工程，目录按需才建。

首发模型 = **Doubao-Seed-2.1-pro**（火山方舟 ARK，OpenAI 兼容端点）；ModelProvider 抽象留好切换，将来 Kimi / DeepSeek 一行配置 drop-in。

## 快速开始

前置：Node ≥ 20（实测 24）。

```bash
npm install
```

**配置模型 key**（demo 需要）：复制 `.env.example` 为 `.env` 并填入火山方舟的 `ARK_API_KEY`（或把它设成环境变量）。`.env` 已被 gitignore，key 永不入库。

```bash
cp .env.example .env   # 然后编辑 .env 填 ARK_API_KEY
```

## 命令

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest（44 测试）
npm run build       # tsc 产出到 dist/
npm run lint        # eslint
npm run demo:a1     # A1 演示：调 Doubao 一句话 → 流式增量 + 聚合 ModelResult（需 ARK_API_KEY）
```

## 目录

```
src/
  core/        # ModelProvider（A1 已实装 model/）·（A2+）AgentLoop · ToolRegistry · ContextManager
  runtime/     # EventBus（A1 已实装）
  capabilities/# SkillRegistry（A5）
  surfaces/cli/# CLI（A4，现为占位）
scripts/       # a1-demo.ts（A1 调用演示）
test/          # vitest 单测
docs/          # phase-A-plan.md（设计）· handoff-A1.md（交接）· next-session-A2-prompt.md
```

## 文档导航

- `AGENTS.md` — 项目规则层（命名 / 风格 / 工程纪律 / 命令 / 设计依据）。**动手前先读。**
- `docs/phase-A-plan.md` — Phase A 完整方案（7 模块设计 + A0–A6 里程碑 + 验收契约 + 不做边界 + D 阶段多模态备忘）。
- `docs/handoff-A1.md` — A0+A1 已完成内容、决策、gotcha、验证证据。
- `docs/next-session-A2-prompt.md` — A2 接手 prompt（可直接喂给下一个会话）。
