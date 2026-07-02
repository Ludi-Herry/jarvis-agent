# Jarvis-Agent

**Jarvis-Agent** —— 自研的 TypeScript/Node 编码 agent（CLI + agent harness，陆凌华 / Luis）。核心架构：**有状态宿主 + 纯函数决策点**的 agent loop，事件流 day-1 解耦前端，渐进披露 skill，确定性交脚本、判断交模型。

> 设计依据不在本仓库重写，以知识库蓝图为准（见 `AGENTS.md`「唯一设计依据」）。

## 当前状态（2026-07-02）

| 阶段 | 状态 |
|---|---|
| Phase A 单 agent 跑起来（说话 / 调工具 / 压缩 / CLI / skill） | ✅ 完成 |
| Phase B 安全执行命令（PermissionGate + 命令解析 + Bash + 审批 + RuleResolver） | ✅ 完成（B1–B6 + B11） |
| 持久化段（JSONL 落盘 + 断点续跑） | ✅ 完成 |
| P1/P2 收尾 + 安全加固（cwd 约束 / finishReason / abort / 打包修 / 进程组 kill + 4 个 codex HIGH） | ✅ 完成 |
| Phase C 多 agent（SubagentManager / roster / 视角评审面板） | ✅ 完成（C1–C5） |
| Phase D 自主（GoalLoop + 确定性三腿〔canonical 重跑 + 篡改检测 + held-out 隐藏断言〕+ 独立 LLM 裁判） | ✅ 完成（D1–D9 + held-out） |
| Phase E 多能力（多 goal Loop 调度 + 外置 vision + 命令级 bash session-allow + shadow-git 旁路历史） | ✅ 完成（4 切片合入 main） |
| Hooks（PreToolUse 阻断 + PostToolUse 咨询/反馈；tool result env；per-hook timeout；round/session lifecycle；多来源；loop per-goal hook-map） | ✅ 完成，剩余仅保留 defer |
| **下一步：GUI（晴天模式外壳）** | ⏭️ GUI 可开工；loop 重项已收口 |
| 沙箱两件（#2 客观路由 / #6 裁判 exec）+ propose_skill | ⛔ 已拍板 defer（能力天花板：`cannotVerify→park` 是正确 fail-closed） |

`npm run typecheck / lint / test / build` 全绿（**870 测试，Windows 下 1 个 POSIX SIGINT smoke 跳过**）。命令安全根（PermissionGate + 命令解析器 + bash 审批）经**六轮独立 codex 对抗核查**确认无破闸 HIGH；goal 验收子系统（确定性三腿 + 腿3 裁判 + bash/Linux 密钥加固）经**多轮多裁判对抗核查**（codex + 独立 Claude 子代理，含一轮 4 裁判收尾）。Phase E 各切片与 Hooks slice-1/2 均经 **codex 跨模型对抗审查逐层加固**（vision 四轮 / bash 白名单 Path A 经 7 HIGH 撤回、保留命令级 Path B / Hooks 信任边界修 HIGH / slice-2 每切片 2 轮 SHIP）。方法 / 严重度基线 / 历史见 `docs/security-review-baseline.md`。

接手入口：
- **Loop primitive 怎么选 → `docs/loop-primitives-guide.md`**；**最新全景 + Phase E/Hooks 现状 + 下一步（GUI 就绪盘点）→ `docs/handoff-next.md`**；**Loop 重项收口记录（parallel resume / finalize / cron daemon）→ `docs/handoff-loop-remaining.md`**；**Phase D（GoalLoop + 三腿 + 腿3 裁判）→ `docs/handoff-D.md`**；**Hooks（tool-call / lifecycle / loop per-goal hook-map）→ `docs/handoff-hooks.md`**；
- **B 阶段 + 当前安全态 → `docs/handoff-B.md`**（顶部「当前状态更新」段）；
- **Phase C（多 agent）→ `docs/handoff-C.md`**；
- 持久化段 → `docs/handoff-persistence.md`；A 阶段 → `docs/handoff-A.md`；
- Phase C 方向回顾 / Phase D 衔接 → 项目 memory `c-phase-agent-roster-two-axes`。

## 这是什么

- **是**：一个有状态宿主 + 纯函数决策点的 agent loop，事件流第一天就解耦前端，确定性交脚本、判断交模型；危险 / 敏感操作运行时确定性拦截，改动级走人在环审批。
- **范围外**：不预埋抽象层 / 插件系统 / 通用框架；反过度工程，目录按需才建。

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

不确定该用哪个入口时，先看 `docs/loop-primitives-guide.md`。快速判断：

| 想交出去的东西 | 入口 | 用法 |
|---|---|---|
| check / 临时探索 | `npm run dev` | 人持续看着，适合定位、试探、单次修复 |
| stop condition / 单目标达标 | `npm run goal` | 目标可验证，适合跑到达标自停 |
| queue / 多目标排空 | `npm run loop` | 多个 goal，支持 resume、可信 map、并行 worktree |
| trigger / 计划触发 | `npm run cron` | 可信 cwd 外 cron map，单次 due scan |
| routine / 前台常驻调度 | `npm run cron:daemon` | 前台 daemon，负责锁、JSONL、信号退出 |
| review / apply / cleanup | `npm run loop:finalize` | 并行 worktree 完成后的只读报告、交互 merge/cleanup |

```bash
npm run dev         # 终端 REPL：带权限闸门 + bash + 交互审批 + 会话落盘（需 ARK_API_KEY）。Ctrl-C 中断 / /exit 退出
npm run resume      # 恢复 data/sessions/ 最近一个会话继续跑
npm run goal        # goal 模式：npm run goal -- "<objective>" 自主跑到达标自停（确定性两腿；JARVIS_HELDOUT_CHECKS_FILE 加 held-out 隐藏断言；ARK_VERIFIER_MODEL=不同模型 启用腿3 独立裁判）
npm run loop        # loop 模式（Phase E）：npm run loop -- <objectives-file> 多 goal 队列顺序排空、崩溃安全 resume；默认 attended / --unattended fail-closed / --resume(+--force)；可 --parallel 2..4 用 cwd 外 worktree 并行跑，parallel resume 必须显式带 --worktree-root（与任何 hooks 配置互斥）；可 --hook-map <trusted-json> 给串行 goal 配 cwd 外 hook 覆盖；可 --sandbox-check-map <trusted-json> 给每个 goal 配 repo/worktree 外 sandbox checks；可 --goal-setter-requirements-map <trusted-json> 给每个 goal 配 repo/worktree 外 requirement route map
npm run resume:loop -- --verifier-map <trusted-json> --hook-map <trusted-json> --sandbox-check-map <trusted-json> # 恢复最近 loop：恢复模式来自 cwd 外可信 map；无 per-goal verifier / hooks / sandbox checks 时各用 {"goals":[]}；原 loop 若带任一 map，恢复必须传同一个可信 map；若原 loop 使用 goal-setter requirements map，恢复也必须传同一路径和哈希的 --goal-setter-requirements-map
npm run loop:finalize -- --loop <id> # 只读 finalize report：汇总 parallel worktree 的 logged verdict / status / diff，生成人工审阅 merge proposal；不 cleanup
npm run loop:finalize -- --loop <id> --merge # 交互式 apply：必须输入 merge <loopId>；只合入 verified + tracked diff proposal，untracked/conflict/缺 verdict 停下；不 cleanup
npm run loop:finalize -- --loop <id> --cleanup # 交互式清理：必须输入 cleanup <loopId>；只移除有 merge-applied 审计且当前 clean 的 worktree；使用 git worktree remove，不强删、不删日志
npm run cron -- --cron-map <trusted-json> # cron 单次扫描：可信 cwd 外计划文件，到期任务触发普通 loop；task 必须 unattended:true；带同工作区扫描锁 + stale 回收 + task 前心跳；记录 data/cron/loop-cron.jsonl，不常驻
npm run cron:daemon -- --cron-map <trusted-json> [--poll-ms <n>] # cron 前台 daemon：可信 cwd 外计划文件；默认 poll=60000；daemon lock + scan lock；写 data/cron/loop-cron-daemon.jsonl；SIGINT/SIGTERM 释放锁退出；不自动 resume/merge/cleanup，不后台 fork
npm run typecheck   # tsc --noEmit
npm test            # vitest（870 测试，Windows 下 1 个 POSIX SIGINT smoke 跳过）
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
npm run sandbox:smoke # OS sandbox 无下载 WSL2 能力探针（不接入生产运行时）
npm run sandbox:runner-smoke # sandboxed_exec + wsl2-unshare 真实链路探针（显式注入，不默认启用）
npm run sandbox:goal-smoke # GoalLoop + trusted sandbox check plan + wsl2-unshare 端到端 smoke（opt-in）
```

## OS sandbox trusted checks

Runtime temp cleanup: the WSL runner creates host-known `/tmp/jarvis-wsl2-unshare-*` payload roots and cleans them by default, including a best-effort host-side cleanup after WSL spawn errors or host-side timeouts. `retainTempDirs: true` is reserved for smoke/debug inspection.

### Goal-setter requirements contract

`JARVIS_GOAL_SETTER_REQUIREMENTS_FILE` is the newer single-goal route contract for `npm run goal`. Set it in the launch environment and keep the JSON file outside the repository / workspace. `goal-cli` captures this variable before loading `.env`, then deletes it from `process.env`, so repo-authored `.env` cannot select verifier routes and the builder cannot read the path back through bash.

Do not set `JARVIS_GOAL_SETTER_REQUIREMENTS_FILE` together with `JARVIS_SANDBOX_CHECKS_FILE`; the CLI rejects the ambiguous configuration. Use the old `JARVIS_SANDBOX_CHECKS_FILE` only for legacy sandbox-only plans.

```json
{
  "version": 1,
  "requirements": [
    {
      "id": "r1",
      "text": "The package manifest can be inspected inside the OS sandbox.",
      "route": "sandbox-command",
      "command": "stat package.json"
    },
    {
      "id": "r2",
      "text": "README documents the goal-setter requirements entry point.",
      "route": "llm"
    },
    {
      "id": "r3",
      "text": "A human checks whether the CLI wording is clear.",
      "route": "human"
    }
  ]
}
```

Route behavior:

- `sandbox-command`: command is required and must pass the narrow inspection allow scope. The WSL2 sandbox result maps to `proves`, `contradicts`, or `cannotVerify`.
- `llm`: only these requirements are sent to the independent LLM verifier. Command-backed and human-routed requirements are not in that prompt.
- `human`: always parks as `cannotVerify` for manual review.

PowerShell example:

```powershell
$plan = Join-Path $env:TEMP 'jarvis-goal-setter-requirements.json'
@'
{
  "version": 1,
  "requirements": [
    {
      "id": "r1",
      "text": "The package manifest can be inspected inside the OS sandbox.",
      "route": "sandbox-command",
      "command": "stat package.json"
    },
    {
      "id": "r2",
      "text": "README documents the goal-setter requirements entry point.",
      "route": "llm"
    }
  ]
}
'@ | Set-Content -Path $plan -Encoding utf8NoBOM

$env:JARVIS_GOAL_SETTER_REQUIREMENTS_FILE = $plan
$env:ARK_VERIFIER_MODEL = '<different-verifier-model>'
npm run goal -- "Update README so the goal-setter requirements entry point is documented, then call update_goal complete."
```

Loop uses the same route contract with a `goals` array keyed by objective index:

```json
{
  "version": 1,
  "goals": [
    {
      "index": 0,
      "requirements": [
        {
          "id": "r1",
          "text": "The package manifest can be inspected inside the OS sandbox.",
          "route": "sandbox-command",
          "command": "stat package.json"
        },
        {
          "id": "r2",
          "text": "README documents the goal-setter requirements loop map.",
          "route": "llm"
        }
      ]
    }
  ]
}
```

```bash
npm run loop -- objectives.txt --goal-setter-requirements-map <trusted-json-outside-repo-and-worktree>
npm run resume:loop -- --verifier-map <trusted-empty-or-full-map> --hook-map <trusted-empty-or-full-map> --goal-setter-requirements-map <same-trusted-json>
```

The loop header records the canonical requirements map path and SHA-256 hash. Resume requires the same path and hash, and the CLI rejects maps inside the current cwd, detected repo/workspace root, or parallel worktree root.

真实 loop CLI route-map smoke 已在 2026-07-02 跑通：`npm run loop -- <temp-objectives> --goal-setter-requirements-map <temp-map> --unattended` 输出 `Goal-setter requirements: per-goal route-map overrides 1/1 goals` 和 `sandboxed verifier...`，最终 `verified`、`complete`、`queue-empty`。该 smoke 使用 repo/worktree 外 map，两个 `sandbox-command` requirements 分别通过 WSL2 read-only sandbox 内的 `stat package.json` / `stat README.md` 验证。

`JARVIS_SANDBOX_CHECKS_FILE` 只接入单目标 `npm run goal`。它让 GoalLoop 在确定性四关卡通过后，用 WSL2 sandbox 运行一组可信的只读检查命令，并把结果映射成 verifier report；此时 LLM 腿3裁判会跳过。

Plan 必须放在仓库 / workspace 外。CLI 会拒绝 repo 内 plan，避免 builder 或仓库内容自己定义验收口径。命令范围也很窄：只允许 `git status`、`git diff`、`git log`、`git ls-files`、`stat`、`wc` 这类简单 inspection command；不支持 shell 组合、重定向、解释器、网络或写入。sandbox 不可用、命令被拒、超时或缺少 requirement check 都会走 `couldNotVerify`，不会回落到 raw bash。

运行时 WSL runner 默认清理 `/tmp/jarvis-wsl2-unshare-*` payload 目录；`sandbox:runner-smoke` / `sandbox:goal-smoke` 显式开启 retain 供检查。trusted JSON plan / map 由调用方放在仓库外，CLI 不自动删除。

最小 plan：

```json
{
  "requirements": [
    {
      "id": "r1",
      "text": "The repository package manifest exists and can be inspected inside the OS sandbox.",
      "command": "stat package.json"
    },
    {
      "id": "r2",
      "text": "The README can be inspected inside the OS sandbox.",
      "command": "wc -l README.md"
    }
  ]
}
```

PowerShell 最小运行方式：

```powershell
$plan = Join-Path $env:TEMP 'jarvis-sandbox-checks.json'
@'
{
  "requirements": [
    {
      "id": "r1",
      "text": "The repository package manifest exists and can be inspected inside the OS sandbox.",
      "command": "stat package.json"
    },
    {
      "id": "r2",
      "text": "The README can be inspected inside the OS sandbox.",
      "command": "wc -l README.md"
    }
  ]
}
'@ | Set-Content -Path $plan -Encoding utf8NoBOM

$env:JARVIS_SANDBOX_CHECKS_FILE = $plan
npm run goal -- "Sandbox CLI smoke: do not edit files. Confirm the existing package manifest and README are present, then call update_goal complete. No source changes are required."
```

真实 CLI smoke 已在 2026-07-02 跑通：`JARVIS_SANDBOX_CHECKS_FILE=<temp-plan> npm run goal -- "<objective>"` 输出 `sandboxed verifier...`，最终 `goal complete (rounds=1, verdict=verified)`。运行时 builder 曾尝试 `ls -la`，非交互审批 fail-closed 拒绝，之后通过 read/grep 完成，说明 sandbox checks 没有绕开 PermissionGate。

多目标 loop 使用 repo/worktree 外 map，按 objective index 配置：

```json
{
  "goals": [
    {
      "index": 0,
      "requirements": [
        {
          "id": "r1",
          "text": "The repository package manifest exists and can be inspected inside the OS sandbox.",
          "command": "stat package.json"
        }
      ]
    }
  ]
}
```

```bash
npm run loop -- objectives.txt --sandbox-check-map <trusted-json-outside-repo-and-worktree>
npm run resume:loop -- --verifier-map <trusted-empty-or-full-map> --hook-map <trusted-empty-or-full-map> --sandbox-check-map <trusted-empty-or-full-map>
```

配置了 sandbox checks 的 goal 会用 runtime-proof report 接管该 goal 的腿3结果；未配置的 goal 继续走普通 verifier / deterministic-only 路径。`--sandbox-check-map` 路径会写入 loop header 供 resume 校验，但实际配置内容每次都从当前命令传入的 repo/worktree 外 trusted map 读取。

Resume is fail-closed: if the original loop header is missing `sandboxCheckMapPath`, the current `--sandbox-check-map` is rejected because the original trusted file cannot be proven.

真实 loop CLI smoke 已在 2026-07-02 跑通：`npm run loop -- <temp-objectives> --sandbox-check-map <temp-map> --unattended` 输出 `sandboxed verifier...`，最终 `verified`、`complete`、`queue-empty`。该 smoke 使用 repo/worktree 外 map，builder 只通过 read 工具确认 `package.json` / `README.md`，sandbox checks 接管该 goal 的腿3结果。

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
    hooks/       # 工具调用 hooks（PreToolUse 阻断 / PostToolUse 咨询 + 反馈回灌）；opt-in JARVIS_HOOKS / loop --hook-map
    shadow/      # shadow-git：agent 改动的旁路 git 历史；opt-in JARVIS_SHADOW_GIT
  surfaces/cli/  # 终端 REPL + goal-cli + loop-cli：render（纯）+ repl + 审批（interactive-approver 三件套）+ commander 入口
skills/          # git-commit/SKILL.md
agents/          # researcher/ROLE.md（子 agent 角色花名册）
scripts/         # a1/a2/a3/a5 + b1/b3 + c1/c2 + d1 demo（真连 Doubao / 真跑 bash）
test/            # vitest 单测（870，Windows 下 1 个 POSIX SIGINT smoke 跳过）
docs/            # 各阶段 plan + handoff + security-review-baseline
data/            # 运行期会话日志（gitignore）
```

## 文档导航

- `AGENTS.md` — 项目规则层（命名 / 风格 / 工程纪律 / 命令 / 设计依据）。**动手前先读。**
- `docs/loop-primitives-guide.md`：**Loop primitive 选择指南**，dev / goal / loop / cron / cron:daemon / finalize 怎么选，以及 usage 观测和 skill 沉淀边界。
- `docs/handoff-D.md` — **Phase D（GoalLoop 自主验收，全部完成）接手入口**；`docs/handoff-next.md` — 之后待办 + GUI 就绪盘点。
- `docs/handoff-loop-remaining.md` — **Loop 重项收口记录**：parallel resume、finalize apply/cleanup、cron daemon 的边界与测试证据。
- `docs/handoff-codex.md` — **codex 自主接手宪法**（Claude 不可用后：硬不变量 + 同族自审盲区 + 边界钉死 + backlog）。
- `docs/os-sandbox-research.md` — **OS sandbox 调研与无下载 smoke 结果**：`SandboxRunner` 合同、WSL2 `unshare` 探针、后续 verifier exec 路线。
- `docs/handoff-C.md` — Phase C（多 agent / SubagentManager）接手入口。
- `docs/handoff-B.md` — B 阶段 + 当前安全态（顶部「当前状态更新」段是接手入口）。
- `docs/handoff-persistence.md` — 持久化段（JSONL + 断点续跑）。
- `docs/handoff-A.md` — Phase A 收尾交接（A0–A6）。
- `docs/security-review-baseline.md` — 独立 codex 安全复核怎么跑、按什么严重度尺子 + 历史。
- `docs/phase-A-plan.md` · `docs/phase-B-plan.md` · `docs/phase-C-plan.md` · `docs/phase-D-plan.md` · `docs/persistence-plan.md` — 各阶段完整方案。
- `docs/handoff-A1.md` — A0+A1 早期交接（已被 handoff-A.md 覆盖）。
