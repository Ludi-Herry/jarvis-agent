# Checkpoint / rewind 与 TUI 状态机合同

> 状态：2026-08-15 冻结并完成基础实现。Checkpoint 首版只接 `jarvis run/resume`；GoalLoop、全屏 renderer 与视觉组件保持后续切片。最终 Reviewer 与提交 SHA 以 `docs/handoff-next.md` 为准。

## 1. 不变量

- `decideVerdict` 继续是唯一完成授权入口。checkpoint、rewind、TUI、审计与展示都不能产生 `verified/complete`。
- Session v1/v2 schema、receipt 与 compaction record 保持原样。用户 checkpoint 使用独立 append-only JSONL。
- 旧 Session 日志不重写、不截断、不删除。conversation rewind 创建新的 v2 Session，并保留来源关系于 checkpoint 审计。
- 文件恢复不调用 `git reset --hard`，不接触用户仓库的 `.git`，不自动 push/merge，也不声称可回退网络、数据库、消息、凭据或其他外部副作用。
- Headless JSONL v1 不增加事件。TUI 动作审计使用独立日志，renderer 只能消费状态与 effect。

## 2. Checkpoint audit v1

每个 Session 对应 `data/checkpoints/<sessionId>.jsonl`。路径解析复用 Session ID 的窄跨平台规则，并拒绝 symbolic link、junction/reparse 与 canonical escape。

`checkpoint` 记录字段：

- `schemaVersion: 1`、连续 `seq`、`at`、`t: "checkpoint"`；
- `checkpointId`、`sessionId`、`cwd`；
- `phase: "before-user-prompt" | "before-model-wave" | "manual"`；
- `cursor: { sessionSeq, recordCount, messageCount }`，指向已完成 integrity/identity 校验的 v2 Session 前缀；
- `shadow: { status: "captured", ref } | { status: "unavailable", reason }`，错误详情经过有界单行净化；
- `effects: { managedFileWrites, external: "none-observed" | "possible" | "unknown", canRewindConversation, canRewindFiles }`。只写计数和保守分类，不写 tool arguments、文件内容、凭据或模型文本。

`rewind` 记录字段：连续沿用同一 audit `seq`，包含 `checkpointId`、`sourceSessionId`、可选 `forkSessionId`、`mode: "conversation" | "conversation-and-files"`、`outcome: "created" | "declined" | "blocked" | "failed"` 和有界 reason。审计记录不改变 Session 或 verdict authority。

只有明确尾部截断可保留已解析前缀；中间损坏、seq gap、重复 id、文件名/header identity 不一致、v1/partial composition、pending/unknown tool effect 全部拒绝 rewind。`ENOENT` 映射 exit 2；需要确认、dirty 或 drift 映射 exit 3；I/O/损坏映射 exit 7。

## 3. 创建与 rewind

- REPL 在追加每个用户 prompt 前写 `before-user-prompt`；`runAgent` 在 Session 已同步且 provider I/O 尚未开始时写 `before-model-wave`。
- audit 写失败发生在 provider/tool side effect 前，当前 run 以 runtime failure 停止。ShadowGit 捕获失败只令 `canRewindFiles=false`，conversation checkpoint 仍可用。
- conversation rewind 重新读取并校验 source Session 与 checkpoint audit，按 `cursor.sessionSeq` 重放前缀，确认 `messageCount` 一致，再创建新 v2 Session。新 header 复制已记录的 model/cwd/composition；纯文本 assistant 的历史 `requestId` 从 fork projection 删除，含 tool message 或 tool-bearing assistant 的 checkpoint 标记为不可 rewind。request/tool receipt 不伪造、不复制。
- `jarvis checkpoints list <session-id> [--json]` 与 `show <session-id> <checkpoint-id> [--json]` 保持 observation-only。`jarvis rewind <session-id> <checkpoint-id>` 创建 conversation fork，并输出精确 `jarvis resume <new-id>`。
- `--files` 只接受带 ShadowGit ref 的 checkpoint。命令先创建可恢复的 preflight snapshot，展示 bounded diff、目标 checkpoint 与不可逆摘要，再要求一次性 `allow-once`。确认后重新验证 preflight fingerprint；dirty、并发 drift、受保护/凭据路径、link-like tree entry、hard-link 文件或未捕获状态一律拒绝。ShadowGit 命令清除继承 Git 环境、禁用仓库本地 hook、fsmonitor、external diff 与 textconv，并在写入前后复核 gitdir 的 link/reparse/hard-link 布局。
- 普通的 project-ignored 文件参与捕获与恢复：`git add -A` 遵守 project `.gitignore` 会把它们从快照、drift 与 restore 中静默抹掉，因此 snapshot 用两次 `--ignored` 清单的差集找出「仅被 project ignore 排除」的路径，逐条过 harness 名单后用显式 `add -f` 强制捕获（分批、绝不整仓 force）。shadow 自己的 structural/secret 排除仍是唯一安全边界；inventory 中出现的受保护路径（含 project `.gitignore` 用 `!` negation 翻掉 shadow 排除）一律 fail-closed。强制捕获的 ignored 目录展开时跳过 symbolic link、hard link 与 harness 拒绝的路径（跳过即不读不写，rewind 不会重建它们），展开总量受 `MAX_SNAPSHOT_PATHS` 约束。
- rewind 不会删除磁盘上仍存在的 project-ignored 文件，除非 target commit 带捕获标记（`shadow-capture: project-ignored-v1`）。带标记的 target 证明「树中缺失 = 当时磁盘不存在」，删除即精确回退；无标记的旧式 ref 无法证明缺失语义，删除不可逆，一律 fail-closed，手动移除该文件后 rewind 可继续。
- 文件 apply 成功后才把 fork 作为可继续入口；任何部分失败都写 `failed` audit、保留 preflight ref，并明确禁止把结果当完成证据。

## 4. TUI reducer v1

Codex 冻结纯状态机；后续 renderer 只能把状态渲染为全屏界面并把按键转成 action。

状态：`idle | model-running | tool-running | approval-pending | stopping | needs-human | closed`。状态附带稳定 run/tool/approval identity、FIFO prompt queue、可选 redirect prompt 和 approval 返回态。

动作与 effect：

| action | 主要 transition | effect |
|---|---|---|
| `submit(text, queue)` | active 保持；prompt 入 FIFO | `appendAudit` |
| `submit(text, redirect)` | active → `stopping` | `abortRun`、`appendAudit` |
| `event(EventBus)` | model/tool/approval identity 驱动状态 | 无副作用 |
| `runClosed(outcome, pendingEffects)` | 无 pending 时启动 redirect/FIFO；有 pending → `needs-human` | `startRun` 或 `appendAudit` |
| `esc` | active → `stopping`；idle 不变 | approval pending 先 `resolveApproval(deny)`，再 `abortRun` |
| 首次 `ctrlC` | active → `stopping`；idle → `closed` | `abortRun` 或 `exit(130)` |
| stopping 中再次 `ctrlC` | → `closed` | `exit(130)` |
| `approvalDecision` | 等待 `approval_result` 恢复原状态 | `resolveApproval` |
| `eof` | idle → `closed`；active 请求停止 | `exit` 或 `abortRun` |

Redirect 必须等 `runClosed`。若 pending/unknown effect 为真，状态进入 `needs-human`，不自动运行 redirect 或 queue。状态机是无状态纯函数，不读盘、不调用 AgentLoop/PermissionGate。

`model_started/finished`、`tool_execution_started/finished`、`approval_request/result` 映射到 reducer；`run.finished` 仍由 host 生成。queue、redirect、interrupt 与 approval 动作写入 `data/tui/<sessionId>.jsonl`，不进入 Session 或 headless v1。

## 5. Surface 选择与 GLM 交接

- `--headless` 永远选择 machine surface；非 TTY 或 `--no-tui` 永远选择 line REPL。
- TTY 仅在 renderer adapter 已注册时选择 TUI；缺 adapter 时显式回退 line REPL，不等待第二套输入源。
- GLM-5.3 可以在本合同和 reducer 测试 GO 后实现纯 renderer、布局、折叠与键位展示。它不能改 reducer transition、audit、AgentEvent、PermissionGate、Session、checkpoint 或完成授权。

Renderer 实现记录（2026-08-16）：纯渲染与键位解析在 `src/surfaces/cli/tui-renderer.ts`（frame 行无控制符、宽度感知折叠截断、`/redirect ` 行首前缀、approval 态 y/s/n）；终端 adapter 在 `src/surfaces/cli/tui-host.ts`（raw mode、30fps 全清重绘、resize、UTF-8 分片缓冲，stream 注入可测）；TUI 宿主 `src/surfaces/cli/tui-repl.ts` 复用 repl.ts 抽出的同一 `createReplRunner`（审批、checkpoint、recall、Session、agent-event 均单一实现，无第二副本），效果执行权在宿主、exit 前 drain 全部 action audit。TTY 下默认进入 TUI；`--no-tui`、非 TTY、headless 回退保持不变。折叠续行宽度含前缀缩进，截断以 `…` 标记。真实 TTY 的视觉验收（布局观感、键位手感）留给 Luis 按节验收。

## 6. 必须触发的测试

- checkpoint JSONL：连续 seq、尾部截断、中间损坏、重复 id、Windows device/path/reparse、非 `ENOENT` 读取错误。
- 自动打点：user message 尚未追加时的 checkpoint、provider 请求前的 model-wave checkpoint、audit 失败阻止 provider。
- conversation rewind：source 字节不变、新 Session 前缀正确、request/tool receipt 不伪造、pending/unknown/v1/composition drift 拒绝。
- file rewind：无确认、dirty、确认后竞态、untracked/受保护路径、空格路径、apply 失败与 preflight 恢复。
- project-ignored 捕获：单文件与目录嵌套普通文件的捕获/恢复、preview 与 apply 之间的 ignored-path drift 拒绝、negation 暴露 secret 的 fail-closed、无捕获标记 target 的防误删与手动移除后放行，以及真实 `rewind --files` 路径不误报成功。
- TUI transition matrix、EventBus adapter、approval cancel、redirect pending-effect 停止、双 Ctrl-C、TTY/`--no-tui`/非 TTY/headless fallback。

## 7. 当前门禁证据

- Renderer 切片（2026-08-16）：`tui-renderer/tui-host/tui-repl` 新增测试 33 个，连同既有 reducer/surface/line-REPL 组合 6 files / 64 passed；全量 139 files / 1594 passed / 2 skipped。`npm run typecheck`、`npm run lint`、`npm run build -- --noEmit` 与 whitespace 检查通过。真实 TTY 视觉验收待 Luis 逐节进行。

- 修复 Reviewer P1（project-ignored 文件从快照/drift/restore 静默消失，rewind 可误报成功）后新增 6 个触发测试：4 个 ShadowGit 层（单文件捕获恢复、目录嵌套、preview 后 drift、防误删）+ 1 个真实 `rewind --files` CLI 路径 + 1 个 negation 回归；修复前 RED 证据为 5 failed / 35 passed。
- 聚焦测试：ShadowGit + checkpoint CLI 40 passed；checkpoint/rewind/TUI/REPL 组合 10 files / 105 passed。
- 全量测试：134 files / 1538 passed / 2 skipped。
- `npm run typecheck`、`npm run lint`、`npm run build -- --noEmit` 已通过；tracked 与 untracked whitespace 检查通过；`dist/` 未在本切片重建。
- Session v1/v2 schema、`decideVerdict`、PermissionGate、GoalLoop 与四套 map 均未修改。
- 修复后独立 Reviewer 复核：GO（P0=0、P1=0、P2=0、P3=4）。P3 为 preview→apply 窗口内新建 ignored 文件不触发 drift、capture-marker 全文匹配的纵深缺口、`add -f` 批次按条数不按字节、ignore 分类临时文件固定名/EBUSY 清理，均不阻塞并已记录于 `docs/handoff-next.md`。代码提交为 `4afd1ba`，最终收口记录在 `docs/handoff-next.md`。
