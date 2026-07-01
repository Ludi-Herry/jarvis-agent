# Jarvis-Agent

**Jarvis-Agent** —— 自研的 TypeScript/Node 编码 agent（CLI + agent harness，陆凌华 / Luis）。核心架构：**有状态宿主 + 纯函数决策点**的 agent loop，事件流 day-1 解耦前端，渐进披露 skill，确定性交脚本、判断交模型。

> 设计依据不在本仓库重写，以知识库蓝图为准（见 `AGENTS.md`「唯一设计依据」）。

## 当前状态（2026-07-01）

| 阶段 | 状态 |
|---|---|
| Phase A 单 agent 跑起来（说话 / 调工具 / 压缩 / CLI / skill） | ✅ 完成 |
| Phase B 安全执行命令（PermissionGate + 命令解析 + Bash + 审批 + RuleResolver） | ✅ 完成（B1–B6 + B11） |
| 持久化段（JSONL 落盘 + 断点续跑） | ✅ 完成 |
| P1/P2 收尾 + 安全加固（cwd 约束 / finishReason / abort / 打包修 / 进程组 kill + 4 个 codex HIGH） | ✅ 完成 |
| Phase C 多 agent（SubagentManager / roster / 视角评审面板） | ✅ 完成（C1–C5） |
| Phase D 自主（GoalLoop + 确定性三腿〔canonical 重跑 + 篡改检测 + held-out 隐藏断言〕+ 独立 LLM 裁判） | ✅ 完成（D1–D9 + held-out） |
| Phase E 多能力（多 goal Loop 调度 + 外置 vision + 命令级 bash session-allow + shadow-git 旁路历史） | ✅ 完成（4 切片合入 main） |
| Hooks（PreToolUse 阻断 + PostToolUse 咨询；slice-2 ① 反馈回灌对话 + ② bash session-allow 暴露 goal/loop） | ✅ slice-1 + slice-2 ①② 完成 |
| **下一步：Hooks slice-2 剩余（③ 每-hook timeout / ④ 多来源配置 / ⑤ round·session 事件 / 传 result）+ GUI（晴天模式外壳）** | ⏭️ Hooks 剩余交接 codex / GUI 待开（就绪盘点见 handoff-next） |
| 沙箱两件（#2 客观路由 / #6 裁判 exec）+ propose_skill | ⛔ 已拍板 defer（能力天花板：`cannotVerify→park` 是正确 fail-closed） |

`npm run typecheck / lint / test / build` 全绿（**646 测试**）。命令安全根（PermissionGate + 命令解析器 + bash 审批）经**六轮独立 codex 对抗核查**确认无破闸 HIGH；goal 验收子系统（确定性三腿 + 腿3 裁判 + bash/Linux 密钥加固）经**多轮多裁判对抗核查**（codex + 独立 Claude 子代理，含一轮 4 裁判收尾）。Phase E 各切片与 Hooks slice-1/2 均经 **codex 跨模型对抗审查逐层加固**（vision 四轮 / bash 白名单 Path A 经 7 HIGH 撤回、保留命令级 Path B / Hooks 信任边界修 HIGH / slice-2 每切片 2 轮 SHIP）。方法 / 严重度基线 / 历史见 `docs/security-review-baseline.md`。

接手入口：
- **最新全景 + Phase E/Hooks 现状 + 下一步（GUI 就绪盘点）→ `docs/handoff-next.md`**；**Phase D（GoalLoop + 三腿 + 腿3 裁判）→ `docs/handoff-D.md`**；**Hooks（slice-1 + slice-2 ①②）→ `docs/handoff-hooks.md`**；
- **B 阶段 + 当前安全态 → `docs/handoff-B.md`**（顶部「当前状态更新」段）；
- **Phase C（多 agent）→ `docs/handoff-C.md`**；
- 持久化段 → `docs/handoff-persistence.md`；A 阶段 → `docs/handoff-A.md`；
- Phase C 方向回顾 / Phase D 衔接 → 项目 memory `c-phase-agent-roster-two-axes`。

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
npm run goal        # goal 模式：npm run goal -- "<objective>" 自主跑到达标自停（确定性两腿；JARVIS_HELDOUT_CHECKS_FILE 加 held-out 隐藏断言；ARK_VERIFIER_MODEL=不同模型 启用腿3 独立裁判）
npm run loop        # loop 模式（Phase E）：npm run loop -- <objectives-file> 多 goal 队列顺序排空、崩溃安全 resume；默认 attended / --unattended fail-closed / --resume(+--force)
npm run resume:loop # 恢复 data/loops/ 最近一个 loop 继续
npm run typecheck   # tsc --noEmit
npm test            # vitest（646 测试）
npm run build       # tsc 产出到 dist/
npm run lint        # eslint
npm run demo:a1     # A1：调 Doubao 一句话 → 流式增量 + 聚合 ModelResult
npm run demo:a2     # A2：模型读文件回答 → 工具闭环
npm run demo:a3     # A3：上下文满自动压缩
npm run demo:a5     # A5：commit 请求触发 git-commit skill
npm run demo:b1     # B1：权限闸门（读 allow / 改源码 ask / 读 .env deny）
npm run demo:b3     # B3：bash 安全闭环 + 危险 / 密钥拦截
npm run demo:c1     # C1：主 agent 派调研专家（能力分发轴，真连 Doubao）
npm run demo:c2     # C2：视角评审面板（六顶帽并行评审同一产物）
npm run demo:d1     # D1：自主跑一个 goal 到达标自停（确定性两条腿验收，真连 Doubao）
npm run demo:d2     # D2：腿3 独立裁判（双模型，第二模型读文件逐条打分 → verdict；需 ARK_VERIFIER_MODEL）
npm run demo:d3     # D3：held-out 隐藏断言腿（真活被秘密校验 verified / 伪造实现被同一秘密校验 rejected）
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
    subagents/   # SubagentManager + derive 护栏 + roster + task 委派工具 + 视角评审面板
    goal/        # GoalLoop + 确定性三腿验收 + 腿3 裁判 + Loop 多 goal 调度（decideVerdict / 熔断 / VerifierHealthMonitor）
    hooks/       # 工具调用 hooks（PreToolUse 阻断 / PostToolUse 咨询 + 反馈回灌）；opt-in JARVIS_HOOKS
    shadow/      # shadow-git：agent 改动的旁路 git 历史；opt-in JARVIS_SHADOW_GIT
  surfaces/cli/  # 终端 REPL + goal-cli + loop-cli：render（纯）+ repl + 审批（interactive-approver 三件套）+ commander 入口
skills/          # git-commit/SKILL.md
agents/          # researcher/ROLE.md（子 agent 角色花名册）
scripts/         # a1/a2/a3/a5 + b1/b3 + c1/c2 + d1 demo（真连 Doubao / 真跑 bash）
test/            # vitest 单测（646）
docs/            # 各阶段 plan + handoff + security-review-baseline
data/            # 运行期会话日志（gitignore）
```

## 文档导航

- `AGENTS.md` — 项目规则层（命名 / 风格 / 工程纪律 / 命令 / 设计依据）。**动手前先读。**
- `docs/handoff-D.md` — **Phase D（GoalLoop 自主验收，全部完成）接手入口**；`docs/handoff-next.md` — 之后两类待办的新会话交接。
- `docs/handoff-C.md` — Phase C（多 agent / SubagentManager）接手入口。
- `docs/handoff-B.md` — B 阶段 + 当前安全态（顶部「当前状态更新」段是接手入口）。
- `docs/handoff-persistence.md` — 持久化段（JSONL + 断点续跑）。
- `docs/handoff-A.md` — Phase A 收尾交接（A0–A6）。
- `docs/security-review-baseline.md` — 独立 codex 安全复核怎么跑、按什么严重度尺子 + 历史。
- `docs/phase-A-plan.md` · `docs/phase-B-plan.md` · `docs/phase-C-plan.md` · `docs/phase-D-plan.md` · `docs/persistence-plan.md` — 各阶段完整方案。
- `docs/handoff-A1.md` — A0+A1 早期交接（已被 handoff-A.md 覆盖）。
