# Jarvis-Agent

**Jarvis-Agent** —— 自研的 TypeScript/Node 编码 agent（CLI + agent harness，陆凌华 / Luis）。核心架构：**有状态宿主 + 纯函数决策点**的 agent loop，事件流 day-1 解耦前端，渐进披露 skill，确定性交脚本、判断交模型。

> 设计依据不在本仓库重写，以知识库蓝图为准（见 `AGENTS.md`「唯一设计依据」）。**Phase A 已完成**：单 agent 能在终端跑起来——说话、调工具、压上下文、用 skill。

## 当前状态（2026-06-28）— Phase A 完成 ✅

| 里程碑 | 状态 |
|---|---|
| A0 脚手架 | ✅ |
| A1 能说话（ModelProvider + EventBus） | ✅ 完成并验收 |
| A2 能调工具（ToolRegistry + AgentLoop） | ✅ |
| A3 能压缩（ContextManager） | ✅ |
| A4 能在终端跑（CLI REPL） | ✅ |
| A5 能用 skill（SkillRegistry + git-commit） | ✅ |
| A6 验收收口（§5 清单全绿 + 文档 + 清理） | ✅ |

验收契约 §5 六条逐条有自动化测试覆盖（117 测试全绿），每个里程碑另有真连 Doubao 的实跑 demo。里程碑全貌与设计见 `docs/phase-A-plan.md`；Phase A 收尾交接见 `docs/handoff-A.md`。下一步为 **Phase B**（权限闸门 + Bash 工具等，尚未开工）。

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
npm run dev         # 终端 REPL：打字跟 agent 对话（需 ARK_API_KEY）。Ctrl-C 中断 / /exit 退出
npm run typecheck   # tsc --noEmit
npm test            # vitest（117 测试）
npm run build       # tsc 产出到 dist/
npm run lint        # eslint
npm run demo:a1     # A1：调 Doubao 一句话 → 流式增量 + 聚合 ModelResult（需 ARK_API_KEY）
npm run demo:a2     # A2：模型自己读文件回答 → 工具闭环
npm run demo:a3     # A3：上下文满了自动压缩，摘要进上下文后续答
npm run demo:a5     # A5：commit 请求触发 git-commit skill，产出规范 message
```

## 目录

```
src/
  core/
    model/       # ModelProvider（Doubao 流式，A1）
    tools/       # ToolRegistry + read/write/grep（A2）
    loop/        # AgentLoop：runAgent + 决策纯函数（A2）
    context/     # ContextManager：压缩 + 工具输出落盘（A3）
  runtime/       # EventBus（A1）
  capabilities/
    skills/      # SkillRegistry：三级渐进披露（A5）
  surfaces/cli/  # 终端 REPL：render（纯）+ repl（壳）+ commander 入口（A4）
skills/          # git-commit/SKILL.md（A5 技能内容）
scripts/         # a1/a2/a3/a5-demo.ts（各里程碑真连 Doubao 实跑）
test/            # vitest 单测（117）
docs/            # phase-A-plan.md · handoff-A1.md · handoff-A.md · next-session-A2-prompt.md
```

## 文档导航

- `AGENTS.md` — 项目规则层（命名 / 风格 / 工程纪律 / 命令 / 设计依据）。**动手前先读。**
- `docs/phase-A-plan.md` — Phase A 完整方案（7 模块设计 + A0–A6 里程碑 + 验收契约 + 不做边界 + D 阶段多模态备忘）。
- `docs/handoff-A.md` — **Phase A 收尾交接**：A0–A6 已建内容、关键决策、gotcha、§5 验收→测试映射、如何运行、Phase B 起点。
- `docs/handoff-A1.md` — A0+A1 当时的交接（早期细节，已被 handoff-A.md 覆盖）。
- `docs/next-session-A2-prompt.md` — A2 接手 prompt（历史留存）。
