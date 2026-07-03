# 交接：Phase D 之后 + Phase E 第一切片收口（给新会话）

> Phase D 腿3 整套**已全部落地 + 经 5 轮多裁判对抗核查 + 诚实文档化**——背景见 `docs/handoff-D.md`（主交接）、`docs/phase-D-leg3-checklist.md`（5 条全收口）、`docs/security-review-baseline.md`（审查历史 + 元教训）、memory `phase-d-goalloop-deterministic-legs`。
> Phase E 四条独立第一切片（vision / bash-allow / loop / shadow-git）**已全部合进本地 main**（见下「合并收口」）。
> OS sandbox Phase 3 v1 **已落地**：可信 goal-setter requirements、单 goal env contract、loop `--goal-setter-requirements-map`、sandbox / LLM / human 组合 verifier report、resume path/hash fail-closed、sandbox audit evidence、runner cleanup、worktree baseline audit 与 `--fail-on-worktree-change` 都已接入并有真实 goal/loop smoke。`npm run observe` 已提供只读 status / usage / audit 入口。当前交接重点改为：① Phase 3 v1 后的剩余 verifier/runtime 边界；② GUI human-review / approval / budget 事件；③ Phase E 后续 defer。

## 方向决策与当前状态（更新至 2026-07-02）

- **Hooks 已扩到 slice-2 follow-up**：PreToolUse 阻断、PostToolUse 咨询与反馈回灌、result env、每-hook timeout、round/session lifecycle、多来源合并均已落地。详见 `docs/handoff-hooks.md`。
- **OS sandbox Phase 3 v1 已落地**：`JARVIS_GOAL_SETTER_REQUIREMENTS_FILE` 提供单 goal 可信 route contract；`npm run loop -- --goal-setter-requirements-map <trusted-json>` 提供 per-goal route map；`sandbox-command` / `llm` / `human` 汇成同一个 verifier report；resume 必须匹配可信文件 path + SHA-256 hash；sandbox evidence 记录 backend、mounts、networkMode、limits、stdout/stderr；runner 默认清理 WSL payload temp roots；goal/loop 会记录 worktree status baseline，`--fail-on-worktree-change` 可把任何 drift 变成 deterministic reject。
- **剩余沙箱边界**：Phase 3 v1 只覆盖 goal-setter 预声明的窄 read-only inspection command（`git status/diff/log/ls-files`、`stat`、`wc`）。还没有通用 app / browser / network verifier；`human` route 仍然 `cannotVerify→park`；GUI human-review flow 未实现。`npm run observe` 只能汇总 JSONL 和 audit evidence，不能给 goal/loop 完成授权。
- **skill 自动沉淀（`propose_skill`）：不做**（投机性、判定偏弱、无证实的复用场景）。下文该节仅作设计存档。
- **只读观测层已落地**：`npm run observe` 读取 session / goal / loop / cron JSONL 与 sandbox audit evidence，输出运行态摘要、成本/轮次摘要、trusted contract metadata、worktree status 和 sandbox backend/mount/network/limits；`--json` 给 GUI/脚本消费；`--data-dir <path>` 可看非默认 `data/`。完成授权仍只来自 `decideVerdict`、deterministic checks、trusted requirement routes 和人工确认。
- **已完成的 Phase E/loop 收口**：接 vision 进 goal/loop、shadow restore 确认、shadow snapshot 异步化、vision MIME sniff + 活体验证、loop mid-goal resume、per-goal verifier、per-goal hook runner、并行目标/worktree first slice、parallel resume 最小 slice、loop finalize 只读报告、loop finalize `--merge` 交互 apply、loop finalize `--cleanup` 交互清理、cron first slice（含同工作区扫描锁 + stale 回收 + task 前心跳）、cron foreground daemon 均已完成；loop 重项收口记录见 `docs/handoff-loop-remaining.md`。

## GUI 就绪盘点（2026-07-01）

CLI 功能已实质收尾（A→E + Hooks slice-1/slice-2 follow-up）。GUI（晴天模式外壳，见 memory `ai-presence-intervention-levels`）接入的**三根架构支柱已就位**（day-1 解耦的回报），**不被剩余 CLI 小尾巴阻塞**：

1. **EventBus**：加 GUI = 加一个 `bus.subscribe`（`repl`/`goal-cli`/`loop-cli` 已各 subscribe → render；`goal-loop`/`loop` 内部 subscribe 挑 usage 计费）。core 不需改。
2. **注入式 Approver**：`Approver = (req: ApprovalRequest) => Promise<Approval>`（`permission-gate.ts`）**纯接口、不假设 TTY**；审批三件套（`renderApprovalRequest`/`detailOf`/`safeInline`，纯函数）+ `createInteractiveApprover` 是 CLI 实现，GUI 实现自己的 Approver（弹窗）即可复用三件套。
3. **JSONL 持久化 + load**：`loadSession`/`latestSessionPath`、`loadGoal`、`loadLoop`/`latestLoopPath` —— GUI 读历史会话 / goal / loop 齐全。

**Event 契约覆盖度**（`runtime/event-bus.ts`）：message_delta / tool_call / tool_result / state / usage / final / halt / verdict / goal_state / loop_halt / hook_output —— 主流程渲染够。

**GUI 前唯一的真前置（发现的缺口，均「加事件成员」级小改，不碰 core 逻辑）**：
- **审批不在事件流**（最值得先定）：Approver 是请求-响应回调，审批发生时**不 emit 事件、不进持久化**（CLI 靠 approver 内 render 显示）。GUI 必须注入自己的 Approver（这是注入式设计意图）；但若要**审批历史可观测 / 可审计**，需加 `approval_request`/`approval_result` 事件（emit 在 gate.check 前后或 approver 包装层）+ 落盘。做不做是 GUI 前的第一个选择。
- **round / budget 无专门事件**：GUI 想显示「第几轮 / token 预算条」，round 可从 goal_state 推、或随 slice-2 ⑤ round-hook 顺带加 round 事件；budget 剩余需加 budget 事件或查询接口。按 GUI 实际需求补，非阻塞。
- **usage/status/audit 只读入口已补**：`npm run observe` 按 primitive 汇总 turns、tokens、halt reason、verdict、trusted contract path/hash、sandbox backend/mount/network/limits。该视图只能做观测，不能给 goal/loop 完成授权。

**结论**：GUI 可开工。前置 = ①本页 + README 已同步（done）+ ②上面「审批事件」取舍 + 按需补 round/budget 事件。loop primitive 选择入口见 `docs/loop-primitives-guide.md`。loop 重项已收口，记录见 `docs/handoff-loop-remaining.md`；`human` route 的 GUI review flow、通用 app/browser/network verifier 仍待补。

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

Phase 3 v1 已解决早前「#2 客观路由」和「#6 裁判只读命令取证」的最小安全切片：goal-setter 在仓库 / workspace / worktree 外提供 trusted requirements；每条 requirement 显式选择 `sandbox-command`、`llm` 或 `human`；sandbox route 只跑窄 inspection command；LLM route 只看 LLM-routed subset；human route 统一 park。真实 goal/loop smoke 已证明 repo/worktree 外 map、WSL2 read-only audit evidence、resume path/hash fail-closed、runner cleanup 和 worktree baseline audit 链路可跑。

### 已落地能力

- **trusted goal-setter requirements**：`version: 1`，per requirement `id/text/route`，`sandbox-command` 必须带 allow-scoped command，`llm`/`human` 禁止带 command。
- **single-goal env contract**：`JARVIS_GOAL_SETTER_REQUIREMENTS_FILE` 在 `.env` 加载前捕获，加载后从 `process.env` 删除，并禁止与 legacy `JARVIS_SANDBOX_CHECKS_FILE` 同时出现。
- **loop route map**：`--goal-setter-requirements-map <trusted-json>` 按 objective index 提供 route contract，路径必须在 repo/worktree 外；resume 要求同一路径和同一 hash。
- **composite verifier report**：sandbox、LLM、human 三路按 requirement id 合并；LLM 不能评价 command-backed 或 human-routed 条目。
- **sandbox audit evidence**：report 保留 command、stdout/stderr、backend、mounts、networkMode、limits，方便后续人工复核。
- **worktree baseline audit**：每个 goal 运行前后记录 `git status --porcelain --untracked-files=all`；`--fail-on-worktree-change` 适合 no-edit/read-only goal，把 status drift 变成 reject。

### 仍未覆盖

- **无通用 app/browser/network verifier**：Phase 3 v1 没有 package script、解释器、browser driving、GUI app、network check 或完整 runtime command 路线。运行态需求如果超出窄 inspection scope，继续靠 LLM route 的文本证据或 `human` route park。
- **human route 仍 park**：`human` requirement 只会生成 `cannotVerify`，没有 CLI/GUI 审批结果回写 verifier report 的闭环。
- **无 GUI human-review flow**：GUI 可接 Approver，但还没有把 human review 变成持久化事件、人工裁决、report merge、audit trail 的产品流程。
- **status/usage/audit 入口只有只读版**：`npm run observe` 已能汇总最新 goal/loop/cron 状态、tokens、rounds、halt reason、trusted contract metadata、sandbox evidence。它只负责观察和复核辅助，不能改变 verdict。

## 第二类：Phase E 切片现状 + 剩余

### 已在 main（四切片，各自的诚实边界 / defer）

- **vision（`src/core/tools/vision-tool.ts` + `src/core/model/vision.ts`）**：异构委派 + 坐标锚点（memory `openhanako-outer-vision-multimodal`）——主推理模型保持纯文本,`vision` 工具读本地图像→base64→调远端 VLM→返回**结构化坐标文本**进主对话。`ARK_VISION_MODEL` 设了才注册（同腿3 opt-in）；capability=`network`（发图出网→gate 判 ask、无 approver fail-closed）；路径走 `safeResolve`；MIME 按 magic bytes sniff，扩展名不再决定出网类型。已用 `doubao-seed-2-1-pro-260628` 真连验证：请求形状可用，坐标输出采用 0-1024 视觉网格，`VISION_PROMPT` 已同步该契约。已接 goal/loop builder 侧（2026-06-30，分支 `feat/vision-goal-loop`；裁判刻意不给 vision——见上「vision→goal/loop 接线」小节）。codex 审查修过 1 HIGH（错误通道回灌 key/data-URL,已套 `describeModelError`+`redactSecrets`）。**defer**：视频/原生多模态/图上画 mark/多图。
- **loop（`src/capabilities/goal/loop.ts` + `src/surfaces/cli/loop-cli.ts`）**：runGoal 之上的多目标外循环——耐久队列 + 顺序排空 + 崩溃安全 resume（已完成 mid-goal resume：cwd loop log 只提供 queue/contract/goalId；已记录的 attempt 会由 runGoal 复核后再写 fresh finish；active goal 继续剩余 round 并恢复 turns/tokens/breaker；terminal complete 必须重跑验收，baseline/pinned 不信 goal log，CLI 重新 snapshot baseline、腿3开启时重新派生 pinned；session header 缺失/不匹配 fail-closed；loop token budget 由本轮复核后的 goal tokens 记录）+ per-goal 异构 verifier（`--verifier-map <cwd外 JSON>` 按 objective index 覆盖腿3模型；配置 realpath 后拒 cwd 内；schema 严格校验；resume 一律必须显式传 cwd 外 `--verifier-map`，deterministic-only 恢复也用可信空 map `{"goals":[]}`，防止 cwd 日志被篡改后静默降级）+ per-goal hook runner（`--hook-map <cwd外 JSON>` 按 objective index 覆盖 hook runner；hook-map 与每个 `hookPath` 都 realpath + 拒 cwd 内；覆盖不合并；resume 一律必须显式传 cwd 外 `--hook-map`，无 per-goal hooks 用可信空 map `{"goals":[]}`，历史记录若带 hook-map 则必须传同一规范化路径；串行限定）+ 并行目标/worktree resume slice（`--parallel 2..4`，恢复时必须显式传 `--worktree-root <cwd外dir>`，与 hooks 配置互斥，不自动 delete/push）+ loop finalize 只读报告（`npm run loop:finalize -- --loop <id>`，只汇总状态和 proposal）+ loop finalize `--merge` 交互 apply（必须输入 `merge <loopId>`，只合入 verified + tracked diff proposal）+ loop finalize `--cleanup` 交互清理（必须输入 `cleanup <loopId>`，只清理有 merge-applied 审计且当前 clean 的 worktree，使用 `git worktree remove` 无 `--force`）+ cron first slice（`npm run cron -- --cron-map <cwd外 JSON>` 单次 due 扫描，task 必须 `unattended:true`，同工作区扫描锁 + stale 回收 + task 前心跳，仍不常驻）+ cron foreground daemon（`npm run cron:daemon -- --cron-map <cwd外 JSON> [--poll-ms <n>]`，daemon lock + scan lock，`task-started/task-finished/parked` JSONL，SIGINT/SIGTERM 释放锁退出，不自动 resume/merge/cleanup，不后台 fork）+ 6 条数值硬停止 + 跨 goal 裁判健康监控（`VerifierHealthMonitor` 按 verifier key 分桶）。**零完成授权**（loop.ts / parallel-loop.ts 不 import runGoal/decideVerdict）。入口 `npm run loop -- <objectives 文件>` / `resume:loop`,默认 attended / `--unattended` fail-closed / `--resume`+`--force`。**诚实边界**：① 跨 goal 监控**仅腿3开启的目标才活**（默认 loop 不开腿3,监控正确惰性；异构 verifier 不混算）；② **held-out 腿没接**（per-objective 秘密,共享文件对异构队列无意义,要 held-out 用单 goal `npm run goal`）；③ off-bus token 计费漏腿3/pinned 派生（已文档化）。loop 重项收口记录见 `docs/handoff-loop-remaining.md`；cron daemon 的计划和失败模式测试清单见 `docs/superpowers/plans/2026-07-02-cron-daemon-plan.md`。
- **bash-allow（`src/runtime/permission/permission-gate.ts` + `decide.ts`）**：**命令级 session-allow（Path B）**——`allow-session` 对 bash 按**精确命令串**记（批一次 `git status` 只解锁 `git status` 再用,绝不解锁别的命令）,非 exec 工具才按工具名记；只短路 `ask`,永不翻 `deny`。**配置层 bash auto-allow 被拒（Path A 撤回,对抗审查 7 HIGH:分析器是 deny-oracle 非 allow-oracle,in-repo allow-list 在 agent 处理不可信仓时即被攻击者掌控）**——rules 只能 deny/收窄,不能 allow bash。**slice-2 ② 已落地（2026-07-01，经 2 轮 codex 对抗审查）**：attended goal-cli/loop-cli 的 approver 改为复用 `src/surfaces/cli/interactive-approver.ts`，**对 bash 也暴露命令级 `allow-session`（`s`）**——goal 内 / loop 整个队列对该精确命令串不再重问（loop 跨队列共享一个 gate）。**仅 bash**：非 bash 工具（write/vision）不显示 `[s]`、输入 `s` 重提示（codex MEDIUM 修复——通用 `parseApprovalChoice` 会顺带给 write/vision 工具级 session 豁免，已在 approver 层堵死，gate 零改）。**无人值守 loop 仍 fail-closed**（`--unattended` 无 approver）。**HIGH defer（codex）**：命令级 grant 假设「同命令串=同行为」，对调度器命令（`npm test`/`make` 等，行为由 `package.json`/`Makefile` 定义、builder 可后续改写）不成立=TOCTOU 残留（Path B 固有、REPL 早已有，本切片暴露到自主 goal/loop 后可达性放大）；真修需「命令串+行为文件指纹」绑定=动 permission-gate 安全核心，**defer**，缓解=attended-only（人在 `s` 时看到精确命令）+ 非 bash 零 session。**真无人值守 bash 仍 fail-closed,等 OS 沙箱**（memory `restore-bash-session-allow`：别用命令模式 allow-list 当无人值守自治）。
- **shadow-git（`src/capabilities/shadow/shadow-git.ts`）+ 已接 goal-loop & loop-cli**：agent 改动的旁路 git 历史——独立 `--git-dir=data/shadow --work-tree=cwd`（不碰用户 `.git`）、`init/snapshot/log/restore`、复用 `runCommand`、**best-effort**（任何 git 失败/抛出都吞,off-verdict-path,绝不破坏被观测的运行）。`JARVIS_SHADOW_GIT=1` opt-in（默认 off,不静默建 shadow 仓）;`npm run shadow -- log / restore <sha>` 审计/回滚。codex HIGH（密钥快照）已修：shadow 的 `info/exclude` 复用 **harness 自己的密钥策略（`sensitive.ts`）,不靠项目 .gitignore**,任意深度匹配。restore 交互确认已落地：默认拒绝、EOF/空输入拒绝、仅明确 `allow-once` 后覆盖工作树。snapshot 异步化已落地：每轮等 `git add -A` 捕获当前工作树后继续下一轮，commit/rev-parse 后台串行跑；goal 结束前 drain，并在当前顺序 loop 路径下避免跨 goal 对同一 shadow repo 并发写。

### 未起 / 移交

- **Hooks：已落地**——PreToolUse 阻断 + PostToolUse 咨询/反馈回灌 + result env + per-hook timeout + round/session lifecycle + 多来源配置合并，见 `docs/handoff-hooks.md`。剩余 defer：PostToolUse 输出不能阻断/改判；无人值守 bash 自治等 OS 沙箱。
- **skill 自动沉淀**：设计已定，**2026-07-01 决定不做**（见「方向决策」）——下节仅设计存档。

## skill 自动沉淀（设计已定，判定偏弱 → 本会话按用户原则未实现）

设计：一个 `propose_skill` 工具——入参 `{name, description, triggers, body}`,组装成正确 SKILL.md frontmatter、`safeResolve` 写到 `skills/<name>/SKILL.md`,**人审 gate = 现有 PermissionGate**（writes-files→ask,用户在批准框看到 skill 内容批/拒）,下次加载生效（不热重载）。本质=「agent 在人审下自创 skill」,是 `write` 工具的薄包装。做的话:工具放 `src/core/tools/`（同 createBashTool 范式）、REPL 条件注册、faked ctx + 临时目录测试、codex 审查。

> **为什么未做**：交接文档自身已标它「投机性、判定偏弱」——SkillRegistry 已能只读加载 `<dir>/<name>/SKILL.md`,「自动沉淀」真实价值**取决于是否真有复用场景**,这与用户原则「不预埋未证明需要的抽象 / 新功能先判值不值得做」冲突。**要做先确认有真实复用场景**,否则就是给一个能力找用途。

**手动 skill 沉淀准则**：可保留为人工动作。重复出现、步骤稳定、能减少人工验收成本时，再新增具体 `SKILL.md`；优先沉淀 frontend visual verification、loop rollout checklist、安全 review checklist 这类项目内检查。确定性步骤优先写脚本，判断性步骤再写 skill 提示。`propose_skill` 继续不做。

## 上手顺序（新会话）

1. 读 `docs/handoff-D.md`（Phase D 主交接：架构、两种 verified 模式、最高优先级不变量、gotcha、关键文件）。
2. 读本页：先看「方向决策与当前状态（更新至 2026-07-02）」+「第一类：Phase 3 v1 后的剩余边界」+「GUI 就绪盘点」。旧的「沙箱跳过」判断已过期。
3. 查 Phase 3 细节：`README.md` 的「OS sandbox trusted checks」、`docs/os-sandbox-research.md` 的「Phase 3 - verifier exec and objective routing / Status on 2026-07-02」、`docs/superpowers/plans/2026-07-02-os-sandbox-phase3-design.md`。
4. 要查 loop 重项收口边界时读 `docs/handoff-loop-remaining.md`；要查 cron daemon 设计读 `docs/superpowers/plans/2026-07-02-cron-daemon-plan.md`。
5. memory `phase-d-goalloop-deterministic-legs`（不变量 + 历轮教训）、`restore-bash-session-allow`（白名单）、`phase-e-loop-scheduling`、`openhanako-outer-vision-multimodal`（vision 接线背景）、`hooks-slice-1`、`codex-for-adversarial-review`（对抗审查用 codex）。
6. `docs/security-review-baseline.md`（审查方法 + 严重度尺子 + 历史 + 元教训：组件级 review 挡不住系统级不可达 / OS 语义坑 / 死 guardrail 成对出现）。

## 别破的不变量（改验收代码前必读）

- `decideVerdict`：腿1/腿2/held-out 在任何 report 评分前判 rejected（注入不可绕）；唯一 verified 窄分支（每条 pinned proves+matched + feature works + pinned 非空 + cnv 空）；空 pinned→verified 不可达；兜底永不默认 verified；`cannotVerify`→park 不 reject、`contradicts`→优先 reject。
- **最高优先级不变量**：腿3 启用 ⇒ `runVerifier` 永返回 report（失败合成 couldNotVerify、非可选返回类型）+ goal-loop `report===undefined` 边界防御 ⇒ 永不回落假阳性 verified。
- **Phase 3 trust boundary**：goal-setter requirements / sandbox check map 只能来自 repo / workspace / worktree 外可信文件；resume path/hash mismatch fail-closed；cwd JSONL、audit evidence、`observe` 视图都不能扩大 route、替换 trusted contract、生成 verified/complete。
- **route 分权**：`sandbox-command` 只能证明同 id command-backed requirement；LLM 只能评分 `llm` route；`human` route 在 GUI human-review flow 落地前一直 park。
- held-out 命令/输出绝不进 builder 上下文（continuation 泛化 / 事件不带 / goalStore 落盘前 `{passed, results:[]}`）。
- 写 guardrail 必配**走真实接线的触发单测**（component 级测试漏过「接线后不可达」——VerifierMonitor 与 recordNonReject 都栽在这）。
- 密钥：model-facing bash 脱敏 env + `ps`/`/proc/environ` 分析器拦 + **Linux 用 .env 别用启动 env**（`assertKeyNotInLaunchEnv`）；**shadow exclude = harness 密钥边界**（复用 `sensitive.ts`,改 shadow 别只信项目 .gitignore）；vision 错误通道套 `describeModelError`+`redactSecrets`。
