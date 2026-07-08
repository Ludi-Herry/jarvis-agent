# 交接：Phase D 之后 + 发布前收口（给新会话）

> **2026-07-03 起的执行路线图在 `docs/handoff-release.md`**（受限无人值守先行 → worktree 写隔离 → GUI 裁决流 → UI/UX 打磨 → 可发布 v1，含 R1-R9 验收契约与对抗审查要求）。本页继续作为系统现状与不变量的权威来源。

> Phase D 腿3 整套**已全部落地 + 经 5 轮多裁判对抗核查 + 诚实文档化**——背景见 `docs/handoff-D.md`（主交接）、`docs/phase-D-leg3-checklist.md`（5 条全收口）、`docs/security-review-baseline.md`（审查历史 + 元教训）、memory `phase-d-goalloop-deterministic-legs`。
> Phase E 四条独立第一切片（vision / bash-allow / loop / shadow-git）**已全部合进本地 main**（见下「合并收口」）。
> OS sandbox Phase 3 v1 **已落地**：可信 goal-setter requirements、单 goal env contract、loop `--goal-setter-requirements-map`、sandbox / LLM / human 组合 verifier report、per-goal held-out hidden checks、resume path/hash fail-closed、sandbox audit evidence、runner cleanup、worktree baseline audit 与 `--fail-on-worktree-change` 都已接入并有真实 goal/loop smoke。builder 侧 `sandboxed_check` 已能在 OS sandbox 内跑 `typecheck/lint/test/build` 并把输出回灌给 builder；`browser_smoke(static-dist)` 已提供固定浏览器 smoke feedback；`goal_round_start` / `goal_round_end` 已提供只读 round/budget 进度事件；`npm run observe` 已提供只读 status / usage / audit / latestGoalBudget 入口；attended goal/loop 已记录 `approval_request` / `approval_result` 事件与 `data/approvals/*.jsonl` 审计；GUI human-review 能力/API 已落地，内置 Browser 裁决表单、human route provenance、`loop:finalize` goal/session/human audit/tracked diff hash/patch hash 交叉验证、R2 真实 cron 证据、R3 running-loop 急停证据均已补齐。当前交接重点改为：GUI UI/UX 打磨与 Luis 逐节验收；若 GUI 打磨改代码，再重跑四关卡并做发布前人工确认。

## 方向决策与当前状态（更新至 2026-07-03）

- **Hooks 已扩到 slice-2 follow-up**：PreToolUse 阻断、PostToolUse 咨询与反馈回灌、result env、每-hook timeout、round/session lifecycle、多来源合并均已落地。详见 `docs/handoff-hooks.md`。
- **OS sandbox Phase 3 v1 已落地**：`JARVIS_GOAL_SETTER_REQUIREMENTS_FILE` 提供单 goal 可信 route contract；`npm run loop -- --goal-setter-requirements-map <trusted-json>` 提供 per-goal route map；`sandbox-command` / `llm` / `human` 汇成同一个 verifier report；resume 必须匹配可信文件 path + SHA-256 hash；sandbox evidence 记录 backend、mounts、networkMode、limits、stdout/stderr；runner 默认清理 WSL payload temp roots；goal/loop 会记录 worktree status baseline，`--fail-on-worktree-change` 可把任何 drift 变成 deterministic reject。
- **sandboxed builder checks 已落地**：`goal-cli` / `loop-cli` 的 builder registry 现在注册 `sandboxed_check`，只接受 `typecheck/lint/test/build` 四个枚举，映射到 `npm run typecheck` / `npm run lint` / `npm test` / `npm run build`。host cwd 只读挂载，复制到 sandbox-local work dir 时排除 `.env`、`.ssh`、私钥、credentials、registry auth 等 secret-shaped 路径，再禁网运行；非零 exit code 作为 stdout/stderr 反馈回 builder，帮助无人值守 loop 自我迭代。
- **autonomous coding smoke 已落地**：`test/capabilities/goal/autonomous-coding-smoke.test.ts` 覆盖 builder 写错代码 → `sandboxed_check(test)` 红 → 读取反馈修复 → `sandboxed_check(test)` 绿 → `update_goal(complete)` → 独立 check 授权完成；同时覆盖“绿色 builder feedback 没有 `update_goal` claim 时仍 blocked”。
- **fixed browser smoke feedback 已落地最小切片**：`goal-cli` / `loop-cli` 的 builder registry 现在注册 `browser_smoke`，只接受 `profile: "static-dist"`，打开 sandbox-local copy 里的 `dist/index.html`，禁网运行，独立 HOME/cache/temp，不接用户浏览器 profile。手动入口是 `npm run sandbox:browser-smoke`；缺预批准浏览器时返回 skipped/unavailable 反馈。设计记录见 `docs/superpowers/plans/2026-07-03-fixed-browser-smoke-feedback-design.md`。
- **真实模型 autonomous coding smoke 已补手动脚本**：`npm run sandbox:autonomous-model-smoke` 在临时 fixture 里让真实 builder 先看 `sandboxed_check(test)` 红灯、改代码、再跑绿灯、最后 claim complete。该脚本需要模型 key，不进默认测试，不自动清理/merge。
- **unattended worktree write 已落地最小权限切片（2026-07-03）**：`--unattended --parallel` 的 per-goal gate 会注入 `goalWorktreeWriteRoot`，仅 built-in `write` 的 literal/effective realpath 都留在该 goal worktree 内才自动 allow；`.git`、sensitive path、symlink/junction/`..`/absolute/Windows namespaced escape 全拒绝。plain `--unattended` 仍对 write fail-closed；bash/vision/network/unknown write-like tools 仍 fail-closed。goal worktree 会桥接宿主 `node_modules` 供 deterministic checks 使用，文件工具不能跟随该链接读写宿主依赖。codex 两轮审查 no HIGH；真实 smoke 已证明 write 成功、bash 拒绝、宿主 `git status` 零漂移。稳定全绿轮 `2026-07-03T17-06-40-512Z` 使用 `VITEST_MAX_WORKERS=1` 跑 `--unattended --parallel 2`，2/2 goals `verified` + `complete`。
- **发布收口检查状态（2026-07-03 第二轮）**：R2/R3/R5/R7/R9 已补齐当前非 UX 证据。R2：`r2-readonly-20260703-124756` 真实间隔 cron daemon 成功 6 次，false verified `0`。R3：内置 Browser 点击急停，`data/control/emergency-stop.jsonl` 记录 `2026-07-03T20:01:55.048Z`，loop `2026-07-03T20-01-28-688Z` 写入 `loop-halted emergency-stop`。R5：内置 Browser 验证页面内联备注表单，`data/human-reviews/g-human-gui-smoke.jsonl` 写入 audit，goal `complete / verified`。R7：human-review trusted route provenance 与 `loop:finalize` latest attempt、goal/session、human audit、tracked diff hash、patch hash 交叉验证已修，最终 codex 复审 `HIGH? no`。R9：version `0.1.0`、`CHANGELOG.md`、`RELEASE_NOTES.md`、`KNOWN_ISSUES.md` 已补。最终本地四关卡已通过：`npm run typecheck`、`npm run lint`、`npm run build`、`npm test`（102 files / 1060 passed / 1 skipped）。R6 GUI UI/UX 打磨与 Luis 验收仍未做；GUI 打磨若改代码，发布前需再次跑四关卡。
- **Phase 3 v1 边界**：trusted verifier route 仍只覆盖 goal-setter 预声明的窄 read-only inspection command（`git status/diff/log/ls-files`、`stat`、`wc`）。`sandboxed_check` 和 `browser_smoke` 都是 builder 反馈工具，不能证明 trusted requirement、不能改写 verdict、不能给 goal/loop 完成授权。通用 app / browser / network verifier 不在当前抽象范围；`local-preview` browser smoke 仍等 loopback-only sandbox proof；`human` route 先 `cannotVerify→park`，随后可由 GUI human-review 记录人工裁决证据并交回 `decideVerdict`。`npm run observe` 只能汇总 JSONL 和 audit evidence，不能给 goal/loop 完成授权。
- **skill 自动沉淀（`propose_skill`）：不做**。允许人工沉淀高频、稳定、可验证的 skill；未来若重开自动沉淀，必须先有重复信号、held-out 验证、安全审查和人审 gate。
- **新增 verifier / route / scheduler 抽象：不做**。现有 `--verifier-map`、`--hook-map`、`--sandbox-check-map`、`--goal-setter-requirements-map` 四套 map 已足够；后续只允许修 bug、收窄边界、同步文档，不能再加第 5 套 map 或新调度/路由层。
- **只读观测层已落地**：`goal_round_start` / `goal_round_end` 提供实时轮次、turn/token、预算上限、claim/verdict/state 进度事件；`npm run observe` 读取 session / goal / loop / cron / approval JSONL 与 sandbox audit evidence，输出运行态摘要、`latestGoalBudget`、trusted contract metadata、worktree status、approval counts、sandbox backend/mount/network/limits，以及 `activity.recent` 最近事件流；`--json` 给 GUI/脚本消费，当前 `ObservationReport` 为 `schemaVersion: 1`，带 `meta.source.dataDir` 与 `authority.mode: "observation-only"`。`--data-dir <path>` 可看非默认 `data/`。完成授权仍只来自 `decideVerdict`、deterministic checks、trusted requirement routes 和人工确认。
- **已完成的 Phase E/loop 收口**：接 vision 进 goal/loop、shadow restore 确认、shadow snapshot 异步化、vision MIME sniff + 活体验证、loop mid-goal resume、per-goal verifier、per-goal hook runner、并行目标/worktree first slice、parallel resume 最小 slice、loop finalize 只读报告、loop finalize `--merge` 交互 apply、loop finalize `--cleanup` 交互清理、cron first slice（含同工作区扫描锁 + stale 回收 + task 前心跳）、cron foreground daemon 均已完成；loop 重项收口记录见 `docs/handoff-loop-remaining.md`。

## GUI 就绪盘点（更新至 2026-07-03）

CLI 功能已实质收尾（A→E + Hooks slice-1/slice-2 follow-up）。GUI（晴天模式外壳，见 memory `ai-presence-intervention-levels`）接入的**三根架构支柱已就位**（day-1 解耦的回报），**不被剩余 CLI 小尾巴阻塞**：

1. **EventBus**：加 GUI = 加一个 `bus.subscribe`（`repl`/`goal-cli`/`loop-cli` 已各 subscribe → render；`goal-loop`/`loop` 内部 subscribe 挑 usage 计费）。core 不需改。
2. **注入式 Approver**：`Approver = (req: ApprovalRequest) => Promise<Approval>`（`permission-gate.ts`）**纯接口、不假设 TTY**；审批三件套（`renderApprovalRequest`/`detailOf`/`safeInline`，纯函数）+ `createInteractiveApprover` 是 CLI 实现，GUI 实现自己的 Approver（弹窗）即可复用三件套。
3. **JSONL 持久化 + load**：`loadSession`/`latestSessionPath`、`loadGoal`、`loadLoop`/`latestLoopPath` —— GUI 读历史会话 / goal / loop 齐全。

**Event 契约覆盖度**（`runtime/event-bus.ts`）：message_delta / tool_call / tool_result / state / usage / final / halt / verdict / goal_state / goal_round_start / goal_round_end / loop_halt / hook_output / approval_request / approval_result —— 主流程渲染够，审批历史和轮次预算进度可观测。

**GUI 前唯一的真前置（发现的缺口，均「加事件成员」级小改，不碰 core 逻辑）**：
- **审批事件前置已补**：attended `goal` / `loop` 的 injected approver 已由 `createApprovalEventApprover(...)` 包装，审批前后 emit `approval_request` / `approval_result`，并写入 `data/approvals/*.jsonl`。记录只包含 safe detail（如 write path、bash command preview），不记录 write content。GUI 可展示审批历史；`human` route 的人工裁决已通过 `data/human-reviews/*.jsonl` 单独留审计。
- **round / budget 事件已补**：`runGoal` 每轮 emit `goal_round_start` / `goal_round_end`，包含当前 round、maxRounds、累计 turns/tokens、可选总预算、claim status、verdict 和 resulting state。事件只给 GUI 进度条 / 状态面板消费，不进入 verifier report。
- **usage/status/audit 只读入口已补**：`npm run observe` 按 primitive 汇总 turns、tokens、`latestGoalBudget`、halt reason、verdict、trusted contract path/hash、approval counts、sandbox backend/mount/network/limits，并输出 `activity.recent` 给 GUI 时间线。JSON 输出已有 versioned contract 与 explicit authority 字段；该视图只能做观测，不能给 goal/loop 完成授权。

**结论**：GUI 已开工并完成第一版晴天模式外壳 + human-review 能力层/API。前置 = 审批历史事件、round/budget 事件、只读 observe JSON contract 已接展示层；`npm run gui` 提供 observe 时间线、emergency stop 与 `human` route 裁决入口。R5 的内置 Browser 裁决入口已改成页面内联表单并复验通过；后续重点是 UI/UX 打磨和 Luis 验收。loop primitive 选择入口见 `docs/loop-primitives-guide.md`。loop 重项已收口，记录见 `docs/handoff-loop-remaining.md`；通用 app/browser/network 运行态检查保持范围外。

### GUI 第一版（2026-07-03）

- `npm run gui` 启动本地 HTTP UI（默认 `127.0.0.1:4317`，端口占用时向后探测）。
- UI 数据来自 `loadWorkspaceObservation`，与 `npm run observe -- --json` 同源；时间线展示 `activity.recent` 最近事件，并保留 session / goal / loop / cron / approvals / sandbox / worktree / authority 摘要。
- GUI server 已补切片 0 安全修复：只接受 loopback `Host` header，`POST /api/emergency-stop` 与 `POST /api/human-reviews/:goalId/decide` 都要求 `x-jarvis-gui: 1`，`--host` 绑定非 loopback 时打印无认证控制面警告。
- GUI human-review MVP 已补切片 3 最小闭环：`GET /api/human-reviews` 列出 parked human requirements，`POST /api/human-reviews/:goalId/decide` 要求 `x-jarvis-gui: 1`，裁决会追加 `data/human-reviews/<goalId>.jsonl`、写入新 goal round、合成 verifier report，并由 `decideVerdict` 给出最终 verdict；若 goal 属于 loop，同步补写新的 `goal-finished` 记录供 `loop:finalize` 读取。
- R5 当前状态：GUI 页面已使用内联备注输入，内置 Browser 复验通过；备注在 1.5s auto-refresh 后仍保留，提交后 `data/human-reviews/g-human-gui-smoke.jsonl` 写入 audit，goal `complete / verified`。
- 急停按钮写 `data/control/emergency-stop.json`，并追加 `data/control/emergency-stop.jsonl` 审计。`goal`、`loop`、`cron`、`cron:daemon` 只响应晚于自身启动时间的停机请求，并把同一个 `AbortSignal` 传给模型流、bash、deterministic checks、sandbox checks 与 loop 调度。
- GUI 保持窄控制面：不启动 goal、不创建 trusted requirement、不运行 verifier、不 merge code、不编辑 map、不做 agent identity / connector / team collaboration。human-review 只把人工判断记录成 verifier evidence，完成授权仍由 `decideVerdict` 产生。

## vision→goal/loop 接线（2026-06-30，方向决策 ① 完成）

vision defer ③「未接 goal/loop」补完——**只接 builder 侧，裁判（leg 3）刻意不给 vision**。分支 `feat/vision-goal-loop`（基于 main，**未合并/未 push**），四关卡全绿（625 测试），经**四轮 codex 跨模型对抗审查**（盲批→decoy→截断→bidi 逐层堵死）SHIP。

- **builder 接线**：goal-cli/loop-cli 镜像 REPL 条件注册（`resolveVisionConfig` + opt-in `ARK_VISION_MODEL` + `createVisionTool`）。network→gate ask→attended 人批准 / unattended 无 approver fail-closed deny（无静默出图）。loop-cli 跨 goal 共享一个无状态 visionTool 实例。
- **裁判不给 vision（架构决策，用户确认）**：network=发图出网=行动，给裁判会破坏「裁判被注入也不能行动」核心属性。`verifier.ts`/`goal-loop.ts` **零改**——`buildVerifierRegistry`=`buildDefaultRegistry().subset(['read','grep'])`+read-only 断言，vision 是 CLI 层单独注册不进 default registry，结构性隔离。视觉验收需求→裁判 cannotVerify→park 交人（与运行态需求同一天花板）。
- **审批 UI 三件套加固（对抗审查驱动）**：审批显示的是被注入者可控的 args，盲批/decoy/截断/bidi 都是真实绕过（四轮逐层挖出）。修复=approver 显示 `detailOf` 且 **tool-aware**（按 `req.toolName` 取字段，防 decoy/padding 隐藏 egress 目标）+ egress 目标（image/path）**完整显示不截断**（防藏 basename）+ `safeInline` 剥控制符/换行/U+2028-2029/bidi（防终端注入 + 视觉欺骗）。三件套是「新接任何 network/egress 工具到 approver」的复用模板。
- **关键文件**：`src/surfaces/cli/{goal-cli,loop-cli,approval}.ts`、`test/cli/approval.test.ts`、`test/capabilities/goal/verifier.test.ts`。
- **剩余 follow-up**（不阻断）：完整路径病态 flood（attended UX，codex 判不阻断）；vision 自身 defer（视频时间维/原生多模态/图上画 mark/多图）。MIME sniff + 活体验证已在 2026-07-01 落地。

## Phase E 合并收口（2026-07-01）

四条第一切片按「自包含→纠缠」顺序合进 **main**（4 个 merge commit + 1 个接线 commit），**四关卡全过：582 测试 / typecheck 0 / build 0 / lint 0**。**未 push**（按自主红线，push 待人工明示）。

| 切片 | 合并 commit | 现状 |
|---|---|---|
| multimodal-vision | `1ebb4ae` | 自包含，零冲突 |
| bash-command-scoped-session-allow | `7d5d1d7` | 只动 permission 层 |
| loop-scheduling | `c7609bb` | loop 机器 + loop-cli |
| shadow-git | `289f7e4` | 旁路 git 历史 |
| shadow→loop-cli 接线 | `7ade42d` | 合并后补：loop-cli 现也 opt-in 构造 ShadowGit、跨整个队列共享 |

合并冲突**仅 2 处且均 trivial**：本页 `handoff-next.md`（已整篇重写）、`package.json` 的 scripts（loop 与 shadow 都在 `goal` 行后插，三条脚本全留）。**源码零冲突**——四切片改的源文件完全 disjoint。测试数演进：527(基线) → 543(vision) → 545(bash) → 572(loop) → 582(shadow)。

> 接线债已清：合并前 `npm run goal` 走 shadow 快照、`npm run loop` 不走（loop-cli 不构造 ShadowGit）。`7ade42d` 已镜像 goal-cli 范式，loop 现在也 opt-in（`JARVIS_SHADOW_GIT`）、且整个队列共享同一 `data/shadow` 仓（历史贯穿全 loop）。

## 一句话现状（goal 验收）

goal 完成验收 = **确定性三腿（canonical 重跑 + 篡改检测 + held-out 隐藏断言）+ 独立 verifier report**，report 可由 LLM-only、legacy sandbox-only，或 Phase 3 v1 的 `sandbox-command` / `llm` / `human` route 组合产生。`decideVerdict` 纯函数定 verdict、不信 builder 自评、不信 LLM 自报；command-backed evidence 只能证明绑定到同一 trusted requirement id 的条目。Phase D 提交链：`f2e6e15`(腿3) → `006fe8a`(held-out) → `ee02737`(bash 脱敏) → `eeb5f05`(删死 monitor #6) → `d752fb9`(cannotVerify #2) → `a2a3c07`(收尾审查修复) → Linux /proc 根因修。

## 第一类：Phase 3 v1 后的剩余边界

Phase 3 v1 已解决早前「#2 客观路由」和「#6 裁判只读命令取证」的最小安全切片：goal-setter 在仓库 / workspace / worktree 外提供 trusted requirements；每条 requirement 显式选择 `sandbox-command`、`llm` 或 `human`；sandbox route 只跑窄 inspection command；LLM route 只看 LLM-routed subset；human route 首轮统一 park，之后可由 GUI human-review 写回人工裁决 evidence。真实 goal/loop smoke 已证明 repo/worktree 外 map、WSL2 read-only audit evidence、resume path/hash fail-closed、runner cleanup 和 worktree baseline audit 链路可跑。

### 已落地能力

- **trusted goal-setter requirements**：`version: 1`，per requirement `id/text/route`，`sandbox-command` 必须带 allow-scoped command，`llm`/`human` 禁止带 command；可选 `heldOutCommands` 作为 hidden deterministic checks。
- **single-goal env contract**：`JARVIS_GOAL_SETTER_REQUIREMENTS_FILE` 在 `.env` 加载前捕获，加载后从 `process.env` 删除，并禁止与 legacy `JARVIS_SANDBOX_CHECKS_FILE` 同时出现。
- **loop route map**：`--goal-setter-requirements-map <trusted-json>` 按 objective index 提供 route contract 和 per-goal `heldOutCommands`，路径必须在 repo/worktree 外；resume 要求同一路径和同一 hash。
- **composite verifier report**：sandbox、LLM、human 三路按 requirement id 合并；LLM 不能评价 command-backed 或 human-routed 条目。
- **sandbox audit evidence**：report 保留 command、stdout/stderr、backend、mounts、networkMode、limits，方便后续人工复核。
- **worktree baseline audit**：每个 goal 运行前后记录 `git status --porcelain --untracked-files=all`；`--fail-on-worktree-change` 适合 no-edit/read-only goal，把 status drift 变成 reject。
- **loop per-objective held-out**：通过 cwd 外 `--goal-setter-requirements-map` 的每个 goal entry 配 `heldOutCommands`，只传给 `runGoal`，不打印命令内容，不写入 cwd goal log。

### 仍未覆盖

- **无通用 app/browser/network verifier**：builder 已能通过 `sandboxed_check` 跑固定项目检查脚本并读取失败输出，也能通过 `browser_smoke(static-dist)` 做固定静态页面 smoke feedback。trusted verifier route 仍没有解释器、任意 browser driving、GUI app、network check 或完整 runtime command 路线。运行态需求如果超出窄 inspection scope，继续靠 LLM route 的文本证据或 `human` route park。
- **human route 仍先 park**：`human` requirement 首轮生成 `cannotVerify`，随后 GUI human-review 可把人工 approve/reject 写回 verifier report 并留 audit trail；重跑 goal 后仍按新一轮 report 重新判断，不静默继承旧裁决。
- **GUI human-review MVP 代码/API 已落地，R5/R7 非 UX 阻塞已修**：能力层覆盖 parked 列表、单条 requirement approve/reject、备注审计、report merge、`decideVerdict` 重算和 loop finish 补记；GUI 入口改为页面内联备注表单，内置 Browser 已验证 audit 写入与最终 `complete / verified`。R7 已收口：pending item 只来自 trusted `route: "human"` 的 pinned requirement；`loop:finalize` 生成 merge proposal 前交叉验证 latest attempt、goal/session、state/outcome、human-review audit 与 tracked diff hash，merge apply 前重算 patch hash。
- **status/usage/audit 入口只有只读版**：`npm run observe` 已能汇总最新 goal/loop/cron 状态、tokens、rounds、`latestGoalBudget`、halt reason、trusted contract metadata、approval counts、sandbox evidence、`activity.recent` 最近事件流，并通过 `schemaVersion: 1` JSON contract 暴露给 GUI/脚本。它只负责观察和复核辅助，不能改变 verdict。

## 第二类：Phase E 切片现状 + 剩余

### 已在 main（四切片，各自的诚实边界 / defer）

- **vision（`src/core/tools/vision-tool.ts` + `src/core/model/vision.ts`）**：异构委派 + 坐标锚点（memory `openhanako-outer-vision-multimodal`）——主推理模型保持纯文本,`vision` 工具读本地图像→base64→调远端 VLM→返回**结构化坐标文本**进主对话。`ARK_VISION_MODEL` 设了才注册（同腿3 opt-in）；capability=`network`（发图出网→gate 判 ask、无 approver fail-closed）；路径走 `safeResolve`；MIME 按 magic bytes sniff，扩展名不再决定出网类型。已用 `doubao-seed-2-1-pro-260628` 真连验证：请求形状可用，坐标输出采用 0-1024 视觉网格，`VISION_PROMPT` 已同步该契约。已接 goal/loop builder 侧（2026-06-30，分支 `feat/vision-goal-loop`；裁判刻意不给 vision——见上「vision→goal/loop 接线」小节）。codex 审查修过 1 HIGH（错误通道回灌 key/data-URL,已套 `describeModelError`+`redactSecrets`）。**defer**：视频/原生多模态/图上画 mark/多图。
- **loop（`src/capabilities/goal/loop.ts` + `src/surfaces/cli/loop-cli.ts`）**：runGoal 之上的多目标外循环——耐久队列 + 顺序排空 + 崩溃安全 resume（已完成 mid-goal resume：cwd loop log 只提供 queue/contract/goalId；已记录的 attempt 会由 runGoal 复核后再写 fresh finish；active goal 继续剩余 round 并恢复 turns/tokens/breaker；terminal complete 必须重跑验收，baseline/pinned 不信 goal log，CLI 重新 snapshot baseline、腿3开启时重新派生 pinned；session header 缺失/不匹配 fail-closed；loop token budget 由本轮复核后的 goal tokens 记录）+ per-goal 异构 verifier（`--verifier-map <cwd外 JSON>` 按 objective index 覆盖腿3模型；配置 realpath 后拒 cwd 内；schema 严格校验；resume 一律必须显式传 cwd 外 `--verifier-map`，deterministic-only 恢复也用可信空 map `{"goals":[]}`，防止 cwd 日志被篡改后静默降级）+ per-goal hook runner（`--hook-map <cwd外 JSON>` 按 objective index 覆盖 hook runner；hook-map 与每个 `hookPath` 都 realpath + 拒 cwd 内；覆盖不合并；resume 一律必须显式传 cwd 外 `--hook-map`，无 per-goal hooks 用可信空 map `{"goals":[]}`，历史记录若带 hook-map 则必须传同一规范化路径；串行限定）+ per-goal held-out hidden checks（`--goal-setter-requirements-map` 的 goal entry 可带 `heldOutCommands`，只进 runGoal held-out leg）+ 并行目标/worktree resume slice（`--parallel 2..4`，恢复时必须显式传 `--worktree-root <cwd外dir>`，与 hooks 配置互斥，不自动 delete/push；`--unattended --parallel` 仅自动放行该 goal worktree 内 built-in `write`，其他行动仍 fail-closed）+ loop finalize 只读报告（`npm run loop:finalize -- --loop <id>`，只汇总状态和 proposal）+ loop finalize `--merge` 交互 apply（必须输入 `merge <loopId>`，只合入 verified + tracked diff proposal）+ loop finalize `--cleanup` 交互清理（必须输入 `cleanup <loopId>`，只清理有 merge-applied 审计且当前 clean 的 worktree，使用 `git worktree remove` 无 `--force`）+ cron first slice（`npm run cron -- --cron-map <cwd外 JSON>` 单次 due 扫描，task 必须 `unattended:true`，同工作区扫描锁 + stale 回收 + task 前心跳，仍不常驻）+ cron foreground daemon（`npm run cron:daemon -- --cron-map <cwd外 JSON> [--poll-ms <n>]`，daemon lock + scan lock，`task-started/task-finished/parked` JSONL，SIGINT/SIGTERM 释放锁退出，不自动 resume/merge/cleanup，不后台 fork）+ 6 条数值硬停止 + 跨 goal 裁判健康监控（`VerifierHealthMonitor` 按 verifier key 分桶）。**零完成授权**（loop.ts / parallel-loop.ts 不 import runGoal/decideVerdict）。入口 `npm run loop -- <objectives 文件>` / `resume:loop`,默认 attended / plain `--unattended` write/bash fail-closed / `--unattended --parallel` worktree 内 write-only auto-allow / `--resume`+`--force`。**诚实边界**：① 跨 goal 监控**仅腿3开启的目标才活**（默认 loop 不开腿3,监控正确惰性；异构 verifier 不混算）；② off-bus token 计费漏腿3/pinned 派生（已文档化）。loop 重项收口记录见 `docs/handoff-loop-remaining.md`；cron daemon 的计划和失败模式测试清单见 `docs/superpowers/plans/2026-07-02-cron-daemon-plan.md`。
- **bash-allow（`src/runtime/permission/permission-gate.ts` + `decide.ts`）**：**命令级 session-allow（Path B）**——`allow-session` 对 bash 按**精确命令串**记（批一次 `git status` 只解锁 `git status` 再用,绝不解锁别的命令）,非 exec 工具才按工具名记；只短路 `ask`,永不翻 `deny`。**配置层 bash auto-allow 被拒（Path A 撤回,对抗审查 7 HIGH:分析器是 deny-oracle 非 allow-oracle,in-repo allow-list 在 agent 处理不可信仓时即被攻击者掌控）**——rules 只能 deny/收窄,不能 allow bash。**slice-2 ② 已落地（2026-07-01，经 2 轮 codex 对抗审查）**：attended goal-cli/loop-cli 的 approver 改为复用 `src/surfaces/cli/interactive-approver.ts`，**对 bash 也暴露命令级 `allow-session`（`s`）**——goal 内 / loop 整个队列对该精确命令串不再重问（loop 跨队列共享一个 gate）。**仅 bash**：非 bash 工具（write/vision）不显示 `[s]`、输入 `s` 重提示（codex MEDIUM 修复——通用 `parseApprovalChoice` 会顺带给 write/vision 工具级 session 豁免，已在 approver 层堵死，gate 零改）。**无人值守 bash 仍 fail-closed**（`--unattended` 无 approver；worktree write 例外不影响 bash）。**HIGH defer（codex）**：命令级 grant 假设「同命令串=同行为」，对调度器命令（`npm test`/`make` 等，行为由 `package.json`/`Makefile` 定义、builder 可后续改写）不成立=TOCTOU 残留（Path B 固有、REPL 早已有，本切片暴露到自主 goal/loop 后可达性放大）；真修需「命令串+行为文件指纹」绑定=动 permission-gate 安全核心，**defer**，缓解=attended-only（人在 `s` 时看到精确命令）+ 非 bash 零 session。**真无人值守 bash 自治等 OS 沙箱**（memory `restore-bash-session-allow`：别用命令模式 allow-list 当无人值守自治）。
- **shadow-git（`src/capabilities/shadow/shadow-git.ts`）+ 已接 goal-loop & loop-cli**：agent 改动的旁路 git 历史——独立 `--git-dir=data/shadow --work-tree=cwd`（不碰用户 `.git`）、`init/snapshot/log/restore`、复用 `runCommand`、**best-effort**（任何 git 失败/抛出都吞,off-verdict-path,绝不破坏被观测的运行）。`JARVIS_SHADOW_GIT=1` opt-in（默认 off,不静默建 shadow 仓）;`npm run shadow -- log / restore <sha>` 审计/回滚。codex HIGH（密钥快照）已修：shadow 的 `info/exclude` 复用 **harness 自己的密钥策略（`sensitive.ts`）,不靠项目 .gitignore**,任意深度匹配。restore 交互确认已落地：默认拒绝、EOF/空输入拒绝、仅明确 `allow-once` 后覆盖工作树。snapshot 异步化已落地：每轮等 `git add -A` 捕获当前工作树后继续下一轮，commit/rev-parse 后台串行跑；goal 结束前 drain，并在当前顺序 loop 路径下避免跨 goal 对同一 shadow repo 并发写。

### 未起 / 移交

- **Hooks：已落地**——PreToolUse 阻断 + PostToolUse 咨询/反馈回灌 + result env + per-hook timeout + round/session lifecycle + 多来源配置合并，见 `docs/handoff-hooks.md`。剩余 defer：PostToolUse 输出不能阻断/改判；无人值守 bash 自治等 OS 沙箱。
- **post-v1 standing goals**：GUI R6 收口后再考虑的持续健康能力，当前不是发布 blocker，也不新增 R10。完成物若值得长期成立，未来可登记为只读、可解释、低 flaky 的 predicate，映射到现有 `cron:daemon` + cwd 外 trusted `goal-setter-requirements` + `sandbox-command` + `observe`；repo 内 `goals/<name>.md` 只能做候选说明，不当完成授权来源；违约时只报警/park/列嫌疑清单，不自动修复；不新增 verifier / route / scheduler 抽象。
- **skill 自动沉淀**：`propose_skill` 继续不做（见「方向决策」）。保留人工沉淀准则：高频、稳定、可验证、能减少人工验收成本的流程才新增 `SKILL.md`。

## skill 沉淀边界（保守准则）

Jarvis 现阶段只做人工沉淀，不做 `propose_skill`。SkillRegistry 已能只读加载 `<dir>/<name>/SKILL.md`；新增 skill 的价值来自真实复用场景，不来自给 agent 增加一个自我扩展按钮。

- Skill：教 agent “怎么做”，适合流程、检查清单、领域判断和 gotchas。
- Tool：给 agent 一个明确可执行动作，带权限分类和 side effect。
- MCP：让 agent 够到外部数据源或应用。
- Subagent：独立上下文、独立指令、受限工具面的专用 agent。

**手动 skill 沉淀准则**：重复出现、步骤稳定、可验证、能减少人工验收成本时，再新增具体 `SKILL.md`；优先沉淀 frontend visual verification、loop rollout checklist、安全 review checklist 这类项目内检查。确定性步骤优先脚本化，skill 负责触发条件、判断步骤、验收标准、禁区和 gotchas。不写“展示思考过程 / 解释推理”类要求；未来若重开自动沉淀，先补重复信号、held-out 验证、安全审查和人审 gate。

## 上手顺序（新会话）

1. 读 `docs/handoff-D.md`（Phase D 主交接：架构、两种 verified 模式、最高优先级不变量、gotcha、关键文件）。
2. 读本页：先看「方向决策与当前状态（更新至 2026-07-03）」+「第一类：Phase 3 v1 后的剩余边界」+「GUI 就绪盘点」。旧的「沙箱跳过」判断已过期。
3. 查 Phase 3 细节：`README.md` 的「OS sandbox trusted checks」、`docs/os-sandbox-research.md` 的「Phase 3 - verifier exec and objective routing / Status on 2026-07-02」、`docs/superpowers/plans/2026-07-02-os-sandbox-phase3-design.md`。
4. 要查 loop 重项收口边界时读 `docs/handoff-loop-remaining.md`；要查 cron daemon 设计读 `docs/superpowers/plans/2026-07-02-cron-daemon-plan.md`。
5. memory `phase-d-goalloop-deterministic-legs`（不变量 + 历轮教训）、`restore-bash-session-allow`（白名单）、`phase-e-loop-scheduling`、`openhanako-outer-vision-multimodal`（vision 接线背景）、`hooks-slice-1`、`codex-for-adversarial-review`（对抗审查用 codex）。
6. `docs/security-review-baseline.md`（审查方法 + 严重度尺子 + 历史 + 元教训：组件级 review 挡不住系统级不可达 / OS 语义坑 / 死 guardrail 成对出现）。

## 别破的不变量（改验收代码前必读）

- `decideVerdict`：腿1/腿2/held-out 在任何 report 评分前判 rejected（注入不可绕）；唯一 verified 窄分支（每条 pinned proves+matched + feature works + pinned 非空 + cnv 空）；空 pinned→verified 不可达；兜底永不默认 verified；`cannotVerify`→park 不 reject、`contradicts`→优先 reject。
- **最高优先级不变量**：腿3 启用 ⇒ `runVerifier` 永返回 report（失败合成 couldNotVerify、非可选返回类型）+ goal-loop `report===undefined` 边界防御 ⇒ 永不回落假阳性 verified。
- **Phase 3 trust boundary**：goal-setter requirements / sandbox check map 只能来自 repo / workspace / worktree 外可信文件；resume path/hash mismatch fail-closed；cwd JSONL、audit evidence、`observe` 视图都不能扩大 route、替换 trusted contract、生成 verified/complete。
- **route 分权**：`sandbox-command` 只能证明同 id command-backed requirement；LLM 只能评分 `llm` route；`human` route 先 park，GUI human-review 只能把人工裁决作为新 evidence 写回，最终 verdict 仍由 `decideVerdict` 算。
- **不新增抽象**：不得再新增 verifier / route / scheduler 抽象或第 5 套 map；现有四套 map 是收口边界。
- held-out 命令/输出绝不进 builder 上下文（continuation 泛化 / 事件不带 / goalStore 落盘前 `{passed, results:[]}`）。
- 写 guardrail 必配**走真实接线的触发单测**（component 级测试漏过「接线后不可达」——VerifierMonitor 与 recordNonReject 都栽在这）。
- 密钥：model-facing bash 脱敏 env + `ps`/`/proc/environ` 分析器拦 + **Linux 用 .env 别用启动 env**（`assertKeyNotInLaunchEnv`）；**shadow exclude = harness 密钥边界**（复用 `sensitive.ts`,改 shadow 别只信项目 .gitignore）；vision 错误通道套 `describeModelError`+`redactSecrets`。
