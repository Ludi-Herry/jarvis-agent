# Jarvis-Agent

**Jarvis-Agent** —— 自研的 TypeScript/Node 编码 agent（CLI + agent harness，陆凌华 / Luis）。核心架构：**有状态宿主 + 纯函数决策点**的 agent loop，事件流 day-1 解耦前端，渐进披露 skill，确定性交脚本、判断交模型。

> 设计依据不在本仓库重写，以知识库蓝图为准（见 `AGENTS.md`「唯一设计依据」）。

## 当前状态（2026-06-29）

| 阶段 | 状态 |
|---|---|
| Phase A 单 agent 跑起来（说话 / 调工具 / 压缩 / CLI / skill） | ✅ 完成 |
| Phase B 安全执行命令（PermissionGate + 命令解析 + Bash + 审批 + RuleResolver） | ✅ 完成（B1–B6 + B11） |
| 持久化段（JSONL 落盘 + 断点续跑） | ✅ 完成 |
| P1/P2 收尾 + 安全加固（cwd 约束 / finishReason / abort / 打包修 / 进程组 kill + 4 个 codex HIGH） | ✅ 完成 |
| **Phase C 多 agent（SubagentManager / roster）** | ⏭️ 下一步 |

`npm run typecheck / lint / test / build` 全绿（**370 测试**）。命令安全根（PermissionGate + 命令解析器 + bash 审批）经**六轮独立 codex 对抗核查**确认无破闸 HIGH（方法 / 严重度基线 / 历史见 `docs/security-review-baseline.md`）。

接手入口：
- **B 阶段 + 当前安全态 → `docs/handoff-B.md`**（顶部「当前状态更新」段）；
- 持久化段 → `docs/handoff-persistence.md`；A 阶段 → `docs/handoff-A.md`；
- Phase C 方向 → 项目 memory `c-phase-agent-roster-two-axes`。

## 这是什么

- **是**：一个有状态宿主 + 纯函数决策点的 agent loop，事件流第一天就解耦前端，确定性交脚本、判断交模型；危险 / 敏感操作运行时确定性拦截，改动级走人在环审批。
- **不是**：不预埋抽象层 / 插件系统 / 通用框架；反过度工程，目录按需才建。

首发模型 = **Doubao-Seed-2.1-pro**（火山方舟 ARK，OpenAI 兼容端点）；ModelProvider 抽象留好切换，将来 Kimi / DeepSeek 一行配置 drop-in。

## 快速开始

前置：Node ≥ 20（实测 24）。

```bash
npm install
```

**配置模型 key**（demo / REPL 需要）：复制 `.env.example` 为 `.env` 并填火山方舟 `ARK_API_KEY`（或设成环境变量）。`.env` 已 gitignore，key 永不入库。

```bash
cp .env.example .env   # 然后编辑 .env 填 ARK_API_KEY
```

## 命令

```bash
npm run dev         # 终端 REPL：带权限闸门 + bash + 交互审批 + 会话落盘（需 ARK_API_KEY）。Ctrl-C 中断 / /exit 退出
npm run resume      # 恢复 data/sessions/ 最近一个会话继续跑
npm run typecheck   # tsc --noEmit
npm test            # vitest（370 测试）
npm run build       # tsc 产出到 dist/
npm run lint        # eslint
npm run demo:a1     # A1：调 Doubao 一句话 → 流式增量 + 聚合 ModelResult
npm run demo:a2     # A2：模型读文件回答 → 工具闭环
npm run demo:a3     # A3：上下文满自动压缩
npm run demo:a5     # A5：commit 请求触发 git-commit skill
npm run demo:b1     # B1：权限闸门（读 allow / 改源码 ask / 读 .env deny）
npm run demo:b3     # B3：bash 安全闭环 + 危险 / 密钥拦截
```

## 目录

```
src/
  core/
    model/       # ModelProvider（Doubao 流式 + 错误脱敏）
    tools/       # ToolRegistry + read/write/grep（cwd 约束 safe-path）+ bash
    loop/        # AgentLoop：runAgent + 决策纯函数
    context/     # ContextManager：压缩 + 工具输出落盘
  runtime/
    event-bus.ts # EventBus
    permission/  # PermissionGate + 命令解析器（安全根）+ 敏感路径策略
    session/     # SessionStore：JSONL 落盘 + 断点续跑
  capabilities/
    skills/      # SkillRegistry：三级渐进披露
    rules/       # RuleResolver：三层规则就近合并
  surfaces/cli/  # 终端 REPL：render（纯）+ repl（壳）+ 审批 + commander 入口
skills/          # git-commit/SKILL.md
scripts/         # a1/a2/a3/a5 + b1/b3 demo（真连 Doubao / 真跑 bash）
test/            # vitest 单测（370）
docs/            # 各阶段 plan + handoff + security-review-baseline
data/            # 运行期会话日志（gitignore）
```

## 文档导航

- `AGENTS.md` — 项目规则层（命名 / 风格 / 工程纪律 / 命令 / 设计依据）。**动手前先读。**
- `docs/handoff-B.md` — **B 阶段 + 当前安全态**（顶部「当前状态更新」段是接手入口）。
- `docs/handoff-persistence.md` — 持久化段（JSONL + 断点续跑）。
- `docs/handoff-A.md` — Phase A 收尾交接（A0–A6）。
- `docs/security-review-baseline.md` — 独立 codex 安全复核怎么跑、按什么严重度尺子 + 历史。
- `docs/phase-A-plan.md` · `docs/phase-B-plan.md` · `docs/persistence-plan.md` — 各阶段完整方案。
- `docs/handoff-A1.md` — A0+A1 早期交接（已被 handoff-A.md 覆盖）。
