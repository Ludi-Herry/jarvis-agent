# Jarvis-Agent

**Jarvis-Agent** —— 自研的 TypeScript/Node 编码 agent（CLI + agent harness，陆凌华 / Luis）。核心架构：**有状态宿主 + 纯函数决策点**的 agent loop，事件流 day-1 解耦前端，渐进披露 skill，确定性交脚本、判断交模型。

> 设计依据不在本仓库重写，以知识库蓝图为准（见 `AGENTS.md`「唯一设计依据」）。

## 当前状态（2026-08-15）

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
| **CLI beta（当前主线）** | 🚧 R0/R0.5、统一 `jarvis` shell、只读 sessions、dynamic composition resume、headless/A0 合同、当前 Session Recall、typed config、checkpoint/rewind 基础与 TUI reducer/fallback 已落地；下一步为 A0 runner、Recall A/B、纯 TUI renderer 与真实任务验收 |
| **GUI 第一版（急停 + human-review MVP）** | ✅ observe 时间线、emergency stop 与 human-review 已落地；Desktop control surface 排在 CLI beta 与 TUI 之后继续打磨 |
| OS sandbox Phase 3 v1 + builder sandboxed checks + browser smoke feedback + 只读观测层 | ✅ 完成（trusted requirements / route map / composite verifier / `sandboxed_check` / `browser_smoke(static-dist)` / round budget events / `npm run observe`）；未覆盖范围：通用 app/browser/network verifier |
| propose_skill | ⛔ 已拍板 defer（投机性、判定偏弱、无证实复用场景） |
| 新增 verifier / route / scheduler 抽象 | ⛔ 已拍板不做；现有四套 map 足够（`verifier` / `hook` / `sandbox-check` / `goal-setter-requirements`） |

`npm run typecheck / lint / test` 与无输出 build compile 最近一轮全绿（测试数与当轮证据以 `docs/handoff-next.md` 为准；已有 `dist/` 未覆盖；Windows 平台专属 skip 见 `docs/cli-first-plan.md`）。命令安全根（PermissionGate + 命令解析器 + bash 审批）经**六轮独立 codex 对抗核查**确认无破闸 HIGH；goal 验收子系统（确定性三腿 + 腿3 裁判 + bash/Linux 密钥加固）经**多轮多裁判对抗核查**（codex + 独立 Claude 子代理，含一轮 4 裁判收尾）。Phase E 各切片与 Hooks slice-1/2 均经 **codex 跨模型对抗审查逐层加固**（vision 四轮 / bash 白名单 Path A 经 7 HIGH 撤回、保留命令级 Path B / Hooks 信任边界修 HIGH / slice-2 每切片 2 轮 SHIP）。方法 / 严重度基线 / 历史见 `docs/security-review-baseline.md`。

**产品路线更新（2026-08-15）**：采用 CLI-first 两阶段，再继续 Desktop control surface。v0.1 CLI beta 先完成可信结果、Session/机器协议与产品外壳；v0.2 的 checkpoint/rewind 基础、TUI reducer 与可靠回退已完成，全屏 renderer 待独立切片；v0.3 完成 Desktop UI/UX 与 Luis 逐节验收。旧 R1-R9 证据继续保留为历史记录，R6 已从 CLI beta blocker 移到 v0.3。

接手入口：
- **当前路线与验收 → `docs/cli-first-plan.md`**；**最新全景与下一步 → `docs/handoff-next.md`**；**Sol Pro 裁决与落地修正 → `docs/sol-pro-cli-trust-review.md`**；**ZCode/GLM-5.3 交接 → `docs/handoff-zcode-glm53.md`**；
- **Loop primitive 怎么选 → `docs/loop-primitives-guide.md`**；**Loop 重项收口记录（parallel resume / finalize / cron daemon）→ `docs/handoff-loop-remaining.md`**；**Phase D（GoalLoop + 三腿 + 腿3 裁判）→ `docs/handoff-D.md`**；**Hooks（tool-call / lifecycle / loop per-goal hook-map）→ `docs/handoff-hooks.md`**；
- **B 阶段 + 当前安全态 → `docs/handoff-B.md`**（顶部「当前状态更新」段）；
- **Phase C（多 agent）→ `docs/handoff-C.md`**；
- 持久化段 → `docs/handoff-persistence.md`；A 阶段 → `docs/handoff-A.md`；
- Phase C 方向回顾 / Phase D 衔接 → 项目 memory `c-phase-agent-roster-two-axes`。

## 这是什么

- **是**：一个有状态宿主 + 纯函数决策点的 agent loop，事件流第一天就解耦前端，确定性交脚本、判断交模型；危险 / 敏感操作运行时确定性拦截，改动级走人在环审批。
- **范围外**：不预埋抽象层 / 插件系统 / 通用框架；反过度工程，目录按需才建。

默认模型 = **Doubao-Seed-2.1-pro**（`doubao-seed-2-1-pro-260628`，走火山方舟 ARK 的 OpenAI 兼容端点）。Ark 上的 DeepSeek 家族 id（如 `deepseek-v4-pro-260425`，1M 上下文）仍可用——设 `ARK_MODEL` 即切、或当跨家族 `ARK_VERIFIER_MODEL` 裁判用，能力窗口由 `capabilityForModel` 按 model id 自动分派。将来正式切 DeepSeek 时走 DeepSeek 官方 API（届时加独立 provider 配置）；ModelProvider 抽象留好切换，Kimi 一行配置 drop-in。

## 快速开始

前置：Node ≥ 20（实测 24）。

```bash
npm install
```

**配置模型 key**（demo / REPL 需要）：复制 `.env.example` 为 `.env` 并填火山方舟 `ARK_API_KEY`。`.env` 已 gitignore，key 永不入库。Windows/macOS 仍接受启动环境变量；Linux 为避免 `/proc` 暴露，只接受运行时加载的 `.env`。

```bash
cp .env.example .env   # 然后编辑 .env 填 ARK_API_KEY
```

## 命令

源码工作区的统一入口是 `npm run jarvis -- <command>`；package bin 名称是 `jarvis`，当前由 `bin/jarvis.js` 加载同一 TypeScript 入口，避免依赖已有 `dist/`。help、version、status 和 doctor 都不需要模型 key：

```bash
npm run jarvis -- --help
npm run jarvis -- --version
npm run jarvis -- doctor
npm run jarvis -- status --json
npm run jarvis -- --cwd "H:/another project" doctor
```

`--cwd` 可写在子命令前后，根入口会先切换 workspace，再让目标命令读取 `.env`、工具路径和 `data/`。`doctor` 只做本地只读检查，输出 Node、cwd、凭据来源、Git baseline、sandbox 命令可用性和数据目录状态；`--json` 输出 `schemaVersion: 1`，密钥值不会进入结果。

Built-in file write 采用显式并发前置条件：`read` 会返回 opaque `fv1` version；更新已有文件必须传同一个 `expectedVersion`，创建新文件必须传 `createOnly:true`，成功结果包含 `postVersion`。冲突时工具要求重新读取，不能静默覆盖。该合同覆盖 Jarvis managed file tool 的 stale-baseline 检查与同进程竞态，并拒绝 symbolic-link leaf 和已有多 hard-link 文件；外部进程或已批准 bash 在最终检查到 rename 之间仍可能竞争，详见 `KNOWN_ISSUES.md`。

不确定该用哪个 primitive 时，先看 `docs/loop-primitives-guide.md`。快速判断：

| 想交出去的东西 | 入口 | 用法 |
|---|---|---|
| check / 临时探索 | `jarvis run [prompt]` | 人持续看着，适合定位、试探、单次修复；prompt 先执行，随后保留交互会话 |
| stop condition / 单目标达标 | `jarvis goal` | 目标可验证，适合跑到达标自停 |
| queue / 多目标排空 | `jarvis loop` | 多个 goal，支持 resume、可信 map、并行 worktree |
| trigger / 计划触发 | `jarvis cron run` | 可信 cwd 外 cron map，单次 due scan |
| routine / 前台常驻调度 | `jarvis cron daemon` | 前台 daemon，负责锁、JSONL、信号退出 |
| review / apply / cleanup | `jarvis finalize` | 并行 worktree 完成后的只读报告、交互 merge/cleanup |
| sessions / 恢复前检查 | `jarvis sessions list|show` | 只读显示身份、integrity、composition、pending effect 与恢复建议 |
| checkpoints / 回退 | `jarvis checkpoints list|show`、`jarvis rewind` | 只读检查独立 audit；conversation rewind 创建新 Session，`--files` 经预览与一次性确认恢复文件 |
| status / usage / audit | `jarvis status` | 只读汇总 JSONL 和 sandbox audit evidence，不给完成授权 |
| GUI / timeline / stop / review | `npm run gui` | 本地观测面板，复用 observe contract，提供急停控制和 human-review 裁决 |

```bash
npm run jarvis -- run "inspect the current changes" # 统一入口；省略 prompt 时进入普通 REPL
npm run jarvis -- resume                            # 恢复当前 cwd 最近会话
npm run jarvis -- goal "<objective>"               # 单目标 GoalLoop
npm run jarvis -- loop <objectives-file>             # 多目标队列
npm run jarvis -- sessions list --json               # 只读会话清单；无需模型 key
npm run jarvis -- sessions show <session-id>          # 只读查看单个会话的恢复证据
npm run jarvis -- checkpoints list <session-id>       # 只读列出独立 checkpoint audit
npm run jarvis -- checkpoints show <session-id> <checkpoint-id> --json
npm run jarvis -- rewind <session-id> <checkpoint-id> # 创建新的 conversation Session；来源日志保持原样
npm run jarvis -- rewind <session-id> <checkpoint-id> --files # bounded preview + allow-once 后恢复文件
npm run jarvis -- --no-tui run                        # TTY 下也固定使用 line REPL
npm run jarvis -- doctor --json                      # 本地只读就绪诊断

# 下列旧 npm scripts 保留一个版本周期作为兼容入口
npm run dev         # 终端 REPL：带权限闸门 + bash + 交互审批 + 会话落盘（需 ARK_API_KEY）。Ctrl-C 中断 / /exit 退出
npm run resume      # 恢复 data/sessions/ 最近一个会话继续跑
npm run goal        # goal 模式：npm run goal -- "<objective>"；默认要求 Git tamper baseline；无 Git 仅可显式 --allow-no-git，结果最高为 checks-only
npm run loop        # loop 模式（Phase E）：npm run loop -- <objectives-file>；默认要求 Git；含 blocked goal 时以 blocked-goals 非零退出；plain --unattended 继续 fail-closed；parallel 仅放行对应 worktree 内 built-in write
npm run resume:loop -- --verifier-map <trusted-json> --hook-map <trusted-json> --sandbox-check-map <trusted-json> # 恢复最近 loop：恢复模式来自 cwd 外可信 map；无 per-goal verifier / hooks / sandbox checks 时各用 {"goals":[]}；原 loop 若带任一 map，恢复必须传同一个可信 map；若原 loop 使用 goal-setter requirements map，恢复也必须传同一路径和哈希的 --goal-setter-requirements-map
npm run loop:finalize -- --loop <id> # 只读 finalize report：汇总 parallel worktree 的 logged verdict / status / diff，生成人工审阅 merge proposal；不 cleanup
npm run loop:finalize -- --loop <id> --merge # 交互式 apply：必须输入 merge <loopId>；只合入 verified + tracked diff proposal，untracked/conflict/缺 verdict 停下；不 cleanup
npm run loop:finalize -- --loop <id> --cleanup # 交互式清理：必须输入 cleanup <loopId>；只移除有 merge-applied 审计且当前 clean 的 worktree；使用 git worktree remove，不强删、不删日志
npm run cron -- --cron-map <trusted-json> # cron 单次扫描：可信 cwd 外计划文件，到期任务触发普通 loop；task 必须 unattended:true；带同工作区扫描锁 + stale 回收 + task 前心跳；记录 data/cron/loop-cron.jsonl，不常驻
npm run cron:daemon -- --cron-map <trusted-json> [--poll-ms <n>] # cron 前台 daemon：可信 cwd 外计划文件；默认 poll=60000；daemon lock + scan lock；写 data/cron/loop-cron-daemon.jsonl；SIGINT/SIGTERM 释放锁退出；不自动 resume/merge/cleanup，不后台 fork
npm run observe     # 只读观测：汇总 status / usage / audit / integrity；显示 Session 格式与 pending tool effects；坏 JSONL 返回 partial + exit 7；--json 输出 schemaVersion=1 给 GUI/脚本
npm run gui         # 本地 GUI 第一版：http://127.0.0.1:4317 起，时间线 + 急停键 + human-review 裁决；若端口占用会自动向后找可用端口
npm run typecheck   # tsc --noEmit
npm test            # vitest（测试数与平台专属 skip 以 docs/handoff-next.md 最近一轮证据为准）
npm run build       # tsc 产出到 dist/
npm run lint        # eslint
npm run demo:a1     # A1：调 ARK 模型一句话 → 流式增量 + 聚合 ModelResult
npm run demo:a2     # A2：模型读文件回答 → 工具闭环
npm run demo:a3     # A3：上下文满自动压缩
npm run demo:a5     # A5：commit 请求触发 git-commit skill
npm run demo:b1     # B1：权限闸门（读 allow / 改源码 ask / 读 .env deny）
npm run demo:b3     # B3：bash 安全闭环 + 危险 / 密钥拦截
npm run demo:c1     # C1：主 agent 派调研专家（能力分发轴，真连 ARK）
npm run demo:c2     # C2：视角评审面板（六顶帽并行评审同一产物）
npm run demo:d1     # D1：自主跑一个 goal 到达标自停（确定性两条腿验收，真连 ARK）
npm run demo:d2     # D2：腿3 独立裁判（双模型，第二模型读文件逐条打分 → verdict；需 ARK_VERIFIER_MODEL）
npm run demo:d3     # D3：held-out 隐藏断言腿（真活被秘密校验 verified / 伪造实现被同一秘密校验 rejected）
npm run sandbox:smoke # OS sandbox 无下载 WSL2 能力探针（不接入生产运行时）
npm run sandbox:runner-smoke # sandboxed_exec + wsl2-unshare 真实链路探针（显式注入，不默认启用）
npm run sandbox:goal-smoke # GoalLoop + trusted sandbox check plan + wsl2-unshare 端到端 smoke（opt-in）
npm run sandbox:browser-smoke # 固定 static-dist browser smoke：builder/manual feedback only，不给完成授权
npm run sandbox:autonomous-model-smoke # 可选真实模型自主编码 smoke：临时 fixture，需模型 key，不进默认测试
```

## OS sandbox trusted checks

Runtime temp cleanup: the WSL runner creates host-known `/tmp/jarvis-wsl2-unshare-*` payload roots and cleans them by default, including a best-effort host-side cleanup after WSL spawn errors or host-side timeouts. `retainTempDirs: true` is reserved for smoke/debug inspection.

### Builder sandboxed checks

`npm run goal` and `npm run loop` register a builder-only `sandboxed_check` tool. It accepts only `check=typecheck|lint|test|build`, mapping to `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`.

The tool mounts the current goal cwd read-only, copies it into a sandbox-local work directory while excluding secret-shaped paths such as `.env`, `.ssh`, private keys, credentials files, and registry auth files, disables network, and returns stdout/stderr/exit code to the builder. Non-zero exits are normal feedback so the builder can keep fixing. Completion authority still stays in `runGoal` / `decideVerdict`, deterministic checks, trusted requirement routes, and human review.

### Fixed browser smoke feedback

`npm run goal` and `npm run loop` also register a builder-only `browser_smoke` tool. The first supported profile is fixed to `profile=static-dist`, which opens `dist/index.html` from a sandbox-local copy with `networkMode: "none"`. The model cannot supply commands, URLs, hosts, ports, browser executable paths, or extra env.

The manual entry is `npm run sandbox:browser-smoke`. It uses a preinstalled sandbox-local browser if one exists, or an operator-provided trusted launch env such as `JARVIS_BROWSER_SMOKE_BROWSER=/usr/bin/chromium`. It does not download browsers, does not use the user's browser profile, and keeps HOME/cache/temp under the sandbox work directory.

Browser smoke output is feedback for the builder or a human smoke pass. It cannot prove trusted requirements, cannot merge into `VerifierReport`, cannot change `decideVerdict`, and cannot mark a goal complete. `local-preview` remains blocked until the sandbox backend has a proven loopback-only mode with no external route and no host service access.

### Autonomous coding smoke scripts

`test/capabilities/goal/autonomous-coding-smoke.test.ts` is the CI-safe smoke for the autonomous coding loop: a scripted builder writes a bad fix, reads `sandboxed_check(test)` red output, repairs it, gets green feedback, then completion still flows through `update_goal(complete)` plus the independent deterministic checks.

`npm run sandbox:autonomous-model-smoke` is the opt-in real-model version. It creates a temp fixture outside this repo, gives the builder only normal file tools plus `sandboxed_check(test)`, and requires red-to-green evidence before `update_goal(complete)`. It needs a model key and is intentionally absent from the default test suite.

### Read-only observation contract

`npm run observe -- --json` emits `ObservationReport` schema version 1. The report includes `meta.generatedAt`, `meta.source.dataDir`, the fixed log scope (`sessions/goals/loops/cron/cronDaemon/approvals`), additive `integrity` diagnostics, Session format/pending-tool status, `status.latestGoalBudget`, effective-state fields, deduplicated token usage, audit summaries, and `activity.recent`. Syntax-damaged/unreadable JSONL plus Session v2 header/version/sequence corruption returns a partial report with exit 7. Legacy `queue-empty` records linked to blocked goals are normalized to effective `blocked-goals`; a recorded cron exit 0 linked to that loop is marked inconsistent.

New sessions use append-only Session JSONL v2. Each record has a contiguous `seq`; the header records the active base prompt, effective tool schemas, and versioned dynamic-addendum provenance. REPL records `skill-registry-v1` plus a hash of the parsed Skill manifest; goal/loop record `none-v1`. Request receipts retain model-input hashes/counts, and tool receipts move through `planned / committed / unknown`. Assistant tool intent is persisted before gate/tool execution, and a known terminal tool receipt is persisted before its model-facing tool message. An uncertain tool or child-agent execution writes `unknown` and halts before a final answer. Resume blocks on unresolved effects, partial v2 composition, identity/projection contradictions, source/manifest drift, ambiguous activation, or request-addendum mismatch; it never replays an unknown side effect automatically. Legacy v1 sessions remain readable with partial receipt/composition coverage and cannot authorize `loop:finalize` merge evidence.

`jarvis sessions list|show [--json]` is a read-only inspection surface for Session identity, integrity, composition, pending effects, and resume advice. It never loads a provider or gains completion authority. Session ids use one narrow cross-platform filename contract: separators, traversal, absolute/namespaced paths, Windows device aliases, unsafe trailing suffixes, symlinks/junctions, and filename/header identity mismatches fail closed. Human sessions/resume/REPL error text strips terminal controls from every untrusted field; JSON retains standard JSON escaping and never adds ANSI.

A clean `sessions show` result says `ready-for-resume-check`, because inspection has no current invocation composition to compare. The actual REPL resume validates the current base composition and dynamic addendum, then displays `compatibility: exact` with the matched dynamic source and manifest hash before continuing. Only explicit `ENOENT` is treated as not found (exit 2); other filesystem failures and code-less operational semantic read failures remain visible as unreadable/partial state (exit 7).

The path guarantee covers static selection: symbolic links, junctions/reparse escapes, canonical targets outside `data/sessions`, and filename/header identity mismatches are refused before resume. An adversarial same-user process can still replace a checked path before a later read; current Session logs also lack a cross-process writer lock and cryptographic authenticity. File-handle binding remains a future hardening step if hostile concurrent local mutation becomes part of the supported threat model.

`jarvis run` and `jarvis resume` enable `history_search` / `history_turn` for the current Session by default. The host fixes the Session identity; model input cannot select another id or path. Every call reuses the existing Session id/path, integrity, and header checks, then projects only append-only message records: compaction snapshots and system messages are ignored, the current in-progress turn is excluded, and tool output requires explicit opt-in. Results are size-bounded historical quotations with common secret patterns redacted; stale file receipts and `fv1` versions are removed, and terminal/bidi controls are inert. Recall cannot prove current files, grant permission, or grant completion. `--no-recall` removes both tools and the prompt boundary byte-for-byte so pre-Recall v2 composition can still resume exactly and so later A/B runs can use the same entry point. Goal/loop Recall remains outside this first slice.

Typed config schema v1 reads `%USERPROFILE%/.jarvis/config.toml`, project `.jarvis/config.toml`, and project-local `.jarvis/config.local.toml`; the project-local file is ignored by Git by default. Precedence is built-in → user → nonblank `ARK_MODEL`/`ARK_BASE_URL` compatibility env → CLI. Project layers may only add capability denies; model and preset selection there fail closed. Credential-like TOML keys, malformed or oversized files, unsafe/unbounded endpoints, unreadable files, and invalid schema values are rejected without echoing values. Unknown keys warn by default and fail under `--strict-config`; `--ignore-user-config` records the skipped user layer.

`jarvis config path|show|validate|preset` is read-only and reports observation-only authority. `config show --effective --sources [--json]` exposes credential-free effective values and exact provenance. `inspect` allows read-only tools while denying write, code execution, and network; `safe` allows reads and asks for the other three capability classes. `safe` also disables the unattended parallel-worktree write shortcut, so headless writes emit an approval pair and fail closed. `run`, `goal`, and every per-goal `loop` gate consume the same resolved policy. Explicit user/CLI model, user/environment/CLI endpoint, preset, and permission changes are bound into the existing system-prompt composition hash; unchanged defaults retain the legacy prompt byte-for-byte, and actual resume also checks the recorded model/cwd before claiming exact compatibility.

`jarvis run/resume` writes user-facing checkpoints to independent `data/checkpoints/<sessionId>.jsonl` before a user prompt is appended and before each provider wave; `/checkpoint` adds a manual point. Audit failure stops before provider/tool I/O, while ShadowGit capture failure only disables file rewind. `jarvis rewind` revalidates the source bytes and creates a new v2 Session without rewriting the source. Plain assistant request ids are removed from the fork projection; any checkpoint containing receipt-bound tool history is marked ineligible and refused, so request/tool receipts are never copied or fabricated. `--files` retains a preflight commit, rejects protected/secret/link-like paths and drift, disables local hooks/external diff helpers, shows a bounded path/effect preview, and requires the exact `allow-once` response. Ordinary project-ignored files are force-captured through an explicit per-path allowlist (the harness's own structural/secret exclusions stay authoritative) so they participate in drift checks and restores, and a rewind never deletes a project-ignored file still on disk unless the target snapshot proves its absence. External effects remain outside rewind authority.

The TUI foundation is a pure reducer plus an independent bounded action audit and deterministic surface selection. `--headless` always selects machine JSONL; non-TTY, `--no-tui`, or a missing renderer selects the line REPL. A full-screen renderer is still a separate adapter and cannot change reducer transitions, Session, PermissionGate, checkpoint, AgentEvent, or completion authority. The frozen contract is `docs/checkpoint-tui-contract.md`.

The report also includes `authority: { mode: "observation-only", canCompleteGoals: false, canCompleteLoops: false }`. GUI or scripts can display and filter it, but they must not treat it as completion evidence.

`status.latestGoal.state` remains the raw state replayed from the goal JSONL for compatibility. `recordedState` repeats that audit value, while `effectiveState` can become `interrupted` when the final record of a halted loop leaves that active goal in flight; `effectiveReason` and `effectiveSource.loopId` explain the derivation. These fields are presentation-only and cannot write goal/loop state or authorize completion.

Every normal loop goal writes detailed rounds to `data/goals/<goalId>.jsonl`; the loop log also writes `goal-finished` token rollups. `usage.goalTokens` is the detailed goal-record total and `usage.loopTokens` is the overlapping loop rollup, so consumers must not add them. `usage.uniqueTotalTokens` deduplicates by goal id, taking the larger recorded value when both sources exist and retaining orphan loop rollups when a detailed goal log is missing. `usage.coverage` remains `partial` while verifier and pinned-requirement derivation calls stay off-bus; their unmeasured token amount is `unknown`. The GUI therefore shows Goal recorded and Loop rollup separately.

Goal runs emit `goal_round_start` / `goal_round_end` events with round number, max rounds, total turns/tokens, optional total limits, claim status, verdict, and resulting state. These events are read-only telemetry for GUI progress bars and status panes; they cannot update verifier reports or mark a goal complete.

Attended `goal` and `loop` runs emit `approval_request` / `approval_result` events around the injected human approver and append the same safe details to `data/approvals/*.jsonl`. These records omit write content and remain audit-only; they do not approve `human` verifier requirements or change verdicts.

Human-routed verifier requirements park as `cannotVerify` until a person reviews them in the GUI. The capability/API path writes a separate `data/human-reviews/<goalId>.jsonl` audit record, appends a new goal round with the merged verifier report, and calls `decideVerdict` to produce the final verdict. The GUI uses an inline review-note form; the built-in Browser verification confirmed the audit write and final `complete / verified` result, so R5 is closed.

### GUI first slice

`npm run gui` starts a local HTTP UI on `127.0.0.1:4317` by default. It serves a compact timeline built from the same `loadWorkspaceObservation` contract behind `npm run observe -- --json`, including `activity.recent` event rows and aggregate status cards, plus a visible emergency stop control and a human-review queue for parked verifier requirements.

The GUI server only accepts loopback `Host` headers (`127.0.0.1`, `localhost`, `[::1]`, with optional port). GUI control POSTs (`/api/emergency-stop` and `/api/human-reviews/:goalId/decide`) require `x-jarvis-gui: 1`, and binding `--host` to a non-loopback address prints an unauthenticated-control warning.

The stop control writes `data/control/emergency-stop.json` and appends `data/control/emergency-stop.jsonl`. Running `goal`, `loop`, `cron`, and `cron:daemon` watch that file and only honor stop requests newer than their own process start time. When honored, the shared `AbortSignal` is passed into model streams, bash, deterministic checks, sandbox checks, and loop scheduling so new agent actions stop promptly while existing JSONL logs remain available for review.

The GUI control surface is intentionally narrow. It does not start goals, create trusted requirements, run verifiers, merge code, edit maps, or create connector / identity / team-collaboration state. Its human-review action only records a person’s decision as verifier evidence; final goal state still comes from `decideVerdict`.

### Worktree status baseline

`npm run goal` and `npm run loop` capture `git status --porcelain --untracked-files=all` before each goal run and record the current status again inside `goal-round.checks.worktreeStatus`. Default policy is audit-only, so normal coding goals can finish with expected tracked changes.

Use `--fail-on-worktree-change` for read-only or no-edit goals. With that flag, any tracked or untracked status drift after the baseline becomes a deterministic reject before sandbox/LLM verifier routes run.

### Goal-setter requirements contract

`JARVIS_GOAL_SETTER_REQUIREMENTS_FILE` is the newer single-goal route contract for `npm run goal`. Set it in the launch environment and keep the JSON file outside the repository / workspace. `goal-cli` captures this variable before loading `.env`, then deletes it from `process.env`, so repo-authored `.env` cannot select verifier routes and the builder cannot read the path back through bash.

Do not set `JARVIS_GOAL_SETTER_REQUIREMENTS_FILE` together with `JARVIS_SANDBOX_CHECKS_FILE`; the CLI rejects the ambiguous configuration. Use the old `JARVIS_SANDBOX_CHECKS_FILE` only for legacy sandbox-only plans.

```json
{
  "version": 1,
  "heldOutCommands": ["node C:/trusted/jarvis/assert-goal.js"],
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
- `human`: parks as `cannotVerify`; the GUI human-review flow can later record approve/reject evidence, append an audit record, and let `decideVerdict` recompute the goal verdict.
- `heldOutCommands`: optional hidden assertions from the same cwd-outside trusted JSON. They run as the deterministic held-out leg, stay out of builder feedback, and are not written into cwd goal logs.

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
      "heldOutCommands": ["node C:/trusted/jarvis/assert-loop-goal-0.js"],
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

The loop header records the canonical requirements map path and SHA-256 hash. Resume requires the same path and hash, and the CLI rejects maps inside the current cwd, detected repo/workspace root, or parallel worktree root. Per-goal `heldOutCommands` are reloaded from that trusted map on each run/resume and only passed to `runGoal` as hidden deterministic checks.

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
    session/     # SessionStore：v1 兼容 + v2 seq/composition/request/tool 收据 + fail-closed 续跑
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
scripts/         # a1/a2/a3/a5 + b1/b3 + c1/c2 + d1 demo（真连 ARK / 真跑 bash）
test/            # vitest 单测（测试数以 docs/handoff-next.md 最近一轮证据为准；Windows 下 1 个 POSIX SIGINT smoke 跳过）
docs/            # 各阶段 plan + handoff + security-review-baseline
data/            # 运行期会话日志（gitignore）
```

## 文档导航

- `AGENTS.md` — 项目规则层（命名 / 风格 / 工程纪律 / 命令 / 设计依据）。**动手前先读。**
- `docs/cli-first-plan.md` — **当前产品路线与验收权威**：v0.1 CLI、v0.2 TUI/checkpoint、v0.3 Desktop。
- `docs/checkpoint-tui-contract.md` — checkpoint/rewind audit、checked file restore、TUI reducer/fallback 与 renderer 交接边界。
- `docs/handoff-next.md` — **当前系统状态、硬边界和后续顺序**。
- `docs/sol-pro-cli-trust-review.md` — GPT-5.6 Sol Pro 外部复核、已采纳项、实施后修正和当前发布裁决。
- `docs/handoff-zcode-glm53.md` — ZCode/GLM-5.3 的只读 sessions 首切片、停止条件与可复制任务说明。
- `docs/loop-primitives-guide.md`：**Loop primitive 选择指南**，dev / goal / loop / cron / cron:daemon / finalize 怎么选，以及 usage 观测和 skill 沉淀边界。
- `docs/handoff-D.md` — **Phase D（GoalLoop 自主验收，全部完成）接手入口**。
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
