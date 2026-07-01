# 交接：Phase D 之后 + Phase E 第一切片收口（给新会话）

> Phase D 腿3 整套**已全部落地 + 经 5 轮多裁判对抗核查 + 诚实文档化**——背景见 `docs/handoff-D.md`（主交接）、`docs/phase-D-leg3-checklist.md`（5 条全收口）、`docs/security-review-baseline.md`（审查历史 + 元教训）、memory `phase-d-goalloop-deterministic-legs`。
> Phase E 四条独立第一切片（vision / bash-allow / loop / shadow-git）**已全部合进本地 main**（见下「合并收口」）。本页交接 **两类剩余工作**：① 仍需 OS 沙箱的两件（leg3-checklist #2 客观路由 + #6 裁判 exec）；② Phase E 后续批（Hooks / skill 自动沉淀 + 各切片的 defer 残留）。

## 方向决策（2026-07-01，用户拍板）

- **Hooks 已扩到 slice-2 follow-up**：PreToolUse 阻断、PostToolUse 咨询与反馈回灌、result env、每-hook timeout、round/session lifecycle、多来源合并均已落地。详见 `docs/handoff-hooks.md`。
- **沙箱：跳过**。不做沙箱前置调研，也不做被沙箱卡住的两件（#2 客观路由 / #6 裁判 exec）。当前 `cannotVerify→park` / `fail-closed deny` 接受为**正确的能力天花板**（自主性封顶在「没人就拒/挂起」，attended 全好用）。将来真要无人值守跑危险/运行态操作，再回头开沙箱。下文「第一类」整节据此**暂不推进**。
- **skill 自动沉淀（`propose_skill`）：不做**（投机性、判定偏弱、无证实的复用场景）。下文该节仅作设计存档。
- **下一步工作**：① **接 vision 进 goal/loop 已完成**（2026-06-30，分支 `feat/vision-goal-loop`，未合并/未 push，四轮 codex 对抗审查 SHIP，625 测试——详见下「vision→goal/loop 接线」；注意最终**只接 builder 侧、裁判不给 vision**，与原文「/verifier」不同，理由见小节）；② shadow restore 确认、shadow snapshot 异步化、vision MIME sniff + 活体验证、loop mid-goal resume、per-goal verifier、并行目标/worktree first slice、cron first slice（含同工作区扫描锁 + stale 回收 + task 前心跳）已完成；剩余 loop 重项（并行 resume / 自动合并清理 / cron daemon）另审。

## GUI 就绪盘点（2026-07-01）

CLI 功能已实质收尾（A→E + Hooks slice-1/slice-2 follow-up）。GUI（晴天模式外壳，见 memory `ai-presence-intervention-levels`）接入的**三根架构支柱已就位**（day-1 解耦的回报），**不被剩余 CLI 小尾巴阻塞**：

1. **EventBus**：加 GUI = 加一个 `bus.subscribe`（`repl`/`goal-cli`/`loop-cli` 已各 subscribe → render；`goal-loop`/`loop` 内部 subscribe 挑 usage 计费）。core 不需改。
2. **注入式 Approver**：`Approver = (req: ApprovalRequest) => Promise<Approval>`（`permission-gate.ts`）**纯接口、不假设 TTY**；审批三件套（`renderApprovalRequest`/`detailOf`/`safeInline`，纯函数）+ `createInteractiveApprover` 是 CLI 实现，GUI 实现自己的 Approver（弹窗）即可复用三件套。
3. **JSONL 持久化 + load**：`loadSession`/`latestSessionPath`、`loadGoal`、`loadLoop`/`latestLoopPath` —— GUI 读历史会话 / goal / loop 齐全。

**Event 契约覆盖度**（`runtime/event-bus.ts`）：message_delta / tool_call / tool_result / state / usage / final / halt / verdict / goal_state / loop_halt / hook_output —— 主流程渲染够。

**GUI 前唯一的真前置（发现的缺口，均「加事件成员」级小改，不碰 core 逻辑）**：
- **审批不在事件流**（最值得先定）：Approver 是请求-响应回调，审批发生时**不 emit 事件、不进持久化**（CLI 靠 approver 内 render 显示）。GUI 必须注入自己的 Approver（这是注入式设计意图）；但若要**审批历史可观测 / 可审计**，需加 `approval_request`/`approval_result` 事件（emit 在 gate.check 前后或 approver 包装层）+ 落盘。做不做是 GUI 前的第一个选择。
- **round / budget 无专门事件**：GUI 想显示「第几轮 / token 预算条」，round 可从 goal_state 推、或随 slice-2 ⑤ round-hook 顺带加 round 事件；budget 剩余需加 budget 事件或查询接口。按 GUI 实际需求补，非阻塞。

**结论**：GUI 可开工。前置 = ①本页 + README 已同步（done）+ ②上面「审批事件」取舍 + 按需补 round/budget 事件。剩余 loop defer（并行 resume / 自动合并清理 / cron daemon）是**并行 backlog，不阻塞 GUI**；沙箱 #2/#6 是能力天花板（非代码活）。

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

goal 完成验收 = **确定性三腿（canonical 重跑 + 篡改检测 + held-out 隐藏断言）+ 独立只读 LLM 裁判（腿3，opt-in）**，`decideVerdict` 纯函数定 verdict、不信 builder 自评、不信 LLM 自报。Phase D 提交链：`f2e6e15`(腿3) → `006fe8a`(held-out) → `ee02737`(bash 脱敏) → `eeb5f05`(删死 monitor #6) → `d752fb9`(cannotVerify #2) → `a2a3c07`(收尾审查修复) → Linux /proc 根因修。

## 第一类：需 OS 沙箱的两件（同一堵墙）

#2 客观路由 和 #6 裁判 exec **撞同一个根问题**：验收里没有「可信地跑东西」的办法。当前裁判是**纯文件取证**（read/grep），跑不了命令、驱不动 app，运行态需求恒 `cannotVerify` → park 交人（fail-closed，安全但不自主）。

### #6 — 让裁判能跑只读命令 / 驱动 app
- **要什么**：裁判验运行态需求（"CLI 跑出 X"、"build 产物能用"）需要执行,但执行=跑任意代码=任意副作用。
- **为什么 defer**：无 OS 级沙箱（容器/seccomp/只读 fs/网络命名空间），「只读 exec」做不到真只读——跑解释器/app 就是跑任意代码。命令分析器能挡 shell 层危险/密钥/网络,挡不住程序内副作用。且给裁判 exec 会削弱「裁判被注入也不能行动」这条核心安全属性。
- **做的话**：先有沙箱基建；裁判 exec 工具走沙箱（只读 fs 挂载 + 无网 + 资源限），输出回 decideVerdict。或退一步：给裁判**只读 inspection 命令白名单**（git log/diff/status、ls/find/stat/wc,**排除解释器/app-runner**）——能多取证、不跑任意代码,但仍验不了运行态行为。当前用户已拍板「保纯读」（见 leg3-checklist #6）,要改先问。

### #2 — 确定性主客观分流（客观需求跑命令验、不烧裁判）
- **现状**：防作弊覆盖面**已结构性满足**（所有 pinned 都交裁判、无「标客观」旋钮可绕）。剩的是省算力/自主杠杆。
- **为什么 defer**：「客观需求→有命令→跑命令验」需**可信的 per-需求命令**。但决策 #1 定了 `pinned = LLM 推导`的文本清单——goal-setter 给不了「还没生成的需求」预挂命令,LLM 自派生命令=弱测试 reward-hacking（held-out 腿存在正因如此）。
- **做的话**：需要「goal-setter 提供 (需求, 命令) 对」的新模式（客观项 harness 跑命令验、主观项 LLM 裁判,路由是纯函数 `有命令→客观`、builder 改不动）。这是新数据模型 + 配置负担 + 验收路径 + 一轮审查。或与上面的沙箱裁判合流。

> **共同前置**：先有 OS 沙箱（或 goal-setter-authored-requirements 模式）。没有它,这两件的「自主验运行态」都做不成,当前 park-to-human 是正确的 fail-closed 行为。

## 第二类：Phase E 切片现状 + 剩余

### 已在 main（四切片，各自的诚实边界 / defer）

- **vision（`src/core/tools/vision-tool.ts` + `src/core/model/vision.ts`）**：异构委派 + 坐标锚点（memory `openhanako-outer-vision-multimodal`）——主推理模型保持纯文本,`vision` 工具读本地图像→base64→调远端 VLM→返回**结构化坐标文本**进主对话。`ARK_VISION_MODEL` 设了才注册（同腿3 opt-in）；capability=`network`（发图出网→gate 判 ask、无 approver fail-closed）；路径走 `safeResolve`；MIME 按 magic bytes sniff，扩展名不再决定出网类型。已用 `doubao-seed-2-1-pro-260628` 真连验证：请求形状可用，坐标输出采用 0-1024 视觉网格，`VISION_PROMPT` 已同步该契约。已接 goal/loop builder 侧（2026-06-30，分支 `feat/vision-goal-loop`；裁判刻意不给 vision——见上「vision→goal/loop 接线」小节）。codex 审查修过 1 HIGH（错误通道回灌 key/data-URL,已套 `describeModelError`+`redactSecrets`）。**defer**：视频/原生多模态/图上画 mark/多图。
- **loop（`src/capabilities/goal/loop.ts` + `src/surfaces/cli/loop-cli.ts`）**：runGoal 之上的多目标外循环——耐久队列 + 顺序排空 + 崩溃安全 resume（已完成 mid-goal resume：cwd loop log 只提供 queue/contract/goalId；已记录的 attempt 会由 runGoal 复核后再写 fresh finish；active goal 继续剩余 round 并恢复 turns/tokens/breaker；terminal complete 必须重跑验收，baseline/pinned 不信 goal log，CLI 重新 snapshot baseline、腿3开启时重新派生 pinned；session header 缺失/不匹配 fail-closed；loop token budget 由本轮复核后的 goal tokens 记录）+ per-goal 异构 verifier（`--verifier-map <cwd外 JSON>` 按 objective index 覆盖腿3模型；配置 realpath 后拒 cwd 内；schema 严格校验；resume 一律必须显式传 cwd 外 `--verifier-map`，deterministic-only 恢复也用可信空 map `{"goals":[]}`，防止 cwd 日志被篡改后静默降级）+ 并行目标/worktree first slice（`--parallel 2..4`，fresh queue only，与 hooks 配置互斥，不自动 merge/delete/push）+ cron first slice（`npm run cron -- --cron-map <cwd外 JSON>` 单次 due 扫描，task 必须 `unattended:true`，同工作区扫描锁 + stale 回收 + task 前心跳，仍不常驻）+ 6 条数值硬停止 + 跨 goal 裁判健康监控（`VerifierHealthMonitor` 按 verifier key 分桶）。**零完成授权**（loop.ts / parallel-loop.ts 不 import runGoal/decideVerdict）。入口 `npm run loop -- <objectives 文件>` / `resume:loop`,默认 attended / `--unattended` fail-closed / `--resume`+`--force`。**诚实边界**：① 跨 goal 监控**仅腿3开启的目标才活**（默认 loop 不开腿3,监控正确惰性；异构 verifier 不混算）；② **held-out 腿没接**（per-objective 秘密,共享文件对异构队列无意义,要 held-out 用单 goal `npm run goal`）；③ off-bus token 计费漏腿3/pinned 派生（已文档化）。**defer**：并行 resume、自动 merge/cleanup、per-goal hook runner、cron daemon。
- **bash-allow（`src/runtime/permission/permission-gate.ts` + `decide.ts`）**：**命令级 session-allow（Path B）**——`allow-session` 对 bash 按**精确命令串**记（批一次 `git status` 只解锁 `git status` 再用,绝不解锁别的命令）,非 exec 工具才按工具名记；只短路 `ask`,永不翻 `deny`。**配置层 bash auto-allow 被拒（Path A 撤回,对抗审查 7 HIGH:分析器是 deny-oracle 非 allow-oracle,in-repo allow-list 在 agent 处理不可信仓时即被攻击者掌控）**——rules 只能 deny/收窄,不能 allow bash。**slice-2 ② 已落地（2026-07-01，经 2 轮 codex 对抗审查）**：attended goal-cli/loop-cli 的 approver 改为复用 `src/surfaces/cli/interactive-approver.ts`，**对 bash 也暴露命令级 `allow-session`（`s`）**——goal 内 / loop 整个队列对该精确命令串不再重问（loop 跨队列共享一个 gate）。**仅 bash**：非 bash 工具（write/vision）不显示 `[s]`、输入 `s` 重提示（codex MEDIUM 修复——通用 `parseApprovalChoice` 会顺带给 write/vision 工具级 session 豁免，已在 approver 层堵死，gate 零改）。**无人值守 loop 仍 fail-closed**（`--unattended` 无 approver）。**HIGH defer（codex）**：命令级 grant 假设「同命令串=同行为」，对调度器命令（`npm test`/`make` 等，行为由 `package.json`/`Makefile` 定义、builder 可后续改写）不成立=TOCTOU 残留（Path B 固有、REPL 早已有，本切片暴露到自主 goal/loop 后可达性放大）；真修需「命令串+行为文件指纹」绑定=动 permission-gate 安全核心，**defer**，缓解=attended-only（人在 `s` 时看到精确命令）+ 非 bash 零 session。**真无人值守 bash 仍 fail-closed,等 OS 沙箱**（memory `restore-bash-session-allow`：别用命令模式 allow-list 当无人值守自治）。
- **shadow-git（`src/capabilities/shadow/shadow-git.ts`）+ 已接 goal-loop & loop-cli**：agent 改动的旁路 git 历史——独立 `--git-dir=data/shadow --work-tree=cwd`（不碰用户 `.git`）、`init/snapshot/log/restore`、复用 `runCommand`、**best-effort**（任何 git 失败/抛出都吞,off-verdict-path,绝不破坏被观测的运行）。`JARVIS_SHADOW_GIT=1` opt-in（默认 off,不静默建 shadow 仓）;`npm run shadow -- log / restore <sha>` 审计/回滚。codex HIGH（密钥快照）已修：shadow 的 `info/exclude` 复用 **harness 自己的密钥策略（`sensitive.ts`）,不靠项目 .gitignore**,任意深度匹配。restore 交互确认已落地：默认拒绝、EOF/空输入拒绝、仅明确 `allow-once` 后覆盖工作树。snapshot 异步化已落地：每轮等 `git add -A` 捕获当前工作树后继续下一轮，commit/rev-parse 后台串行跑；goal 结束前 drain，并在当前顺序 loop 路径下避免跨 goal 对同一 shadow repo 并发写。

### 未起 / 移交

- **Hooks：已落地**——PreToolUse 阻断 + PostToolUse 咨询/反馈回灌 + result env + per-hook timeout + round/session lifecycle + 多来源配置合并，见 `docs/handoff-hooks.md`。剩余 defer：PostToolUse 输出不能阻断/改判；无人值守 bash 自治等 OS 沙箱。
- **skill 自动沉淀**：设计已定，**2026-07-01 决定不做**（见「方向决策」）——下节仅设计存档。

## skill 自动沉淀（设计已定，判定偏弱 → 本会话按用户原则未实现）

设计：一个 `propose_skill` 工具——入参 `{name, description, triggers, body}`,组装成正确 SKILL.md frontmatter、`safeResolve` 写到 `skills/<name>/SKILL.md`,**人审 gate = 现有 PermissionGate**（writes-files→ask,用户在批准框看到 skill 内容批/拒）,下次加载生效（不热重载）。本质=「agent 在人审下自创 skill」,是 `write` 工具的薄包装。做的话:工具放 `src/core/tools/`（同 createBashTool 范式）、REPL 条件注册、faked ctx + 临时目录测试、codex 审查。

> **为什么未做**：交接文档自身已标它「投机性、判定偏弱」——SkillRegistry 已能只读加载 `<dir>/<name>/SKILL.md`,「自动沉淀」真实价值**取决于是否真有复用场景**,这与用户原则「不预埋未证明需要的抽象 / 新功能先判值不值得做」冲突。**要做先确认有真实复用场景**,否则就是给一个能力找用途。

## 上手顺序（新会话）

1. 读 `docs/handoff-D.md`（Phase D 主交接：架构、两种 verified 模式、最高优先级不变量、gotcha、关键文件）。
2. 读本页：先看「方向决策（2026-07-01）」（沙箱已跳过、propose_skill 不做、下一步=vision 接线）+「Phase E 合并收口」（main 现状）+「第二类」（切片 defer）。「第一类」（沙箱两件）按决策**暂不推进**。
3. memory `phase-d-goalloop-deterministic-legs`（不变量 + 历轮教训）、`restore-bash-session-allow`（白名单）、`phase-e-loop-scheduling`、`openhanako-outer-vision-multimodal`（vision 接线背景）、`hooks-slice-1`、`codex-for-adversarial-review`（对抗审查用 codex）。
4. `docs/security-review-baseline.md`（审查方法 + 严重度尺子 + 历史 + 元教训：组件级 review 挡不住系统级不可达 / OS 语义坑 / 死 guardrail 成对出现）。

## 别破的不变量（改验收代码前必读）

- `decideVerdict`：腿1/腿2/held-out 在任何 report 评分前判 rejected（注入不可绕）；唯一 verified 窄分支（每条 pinned proves+matched + feature works + pinned 非空 + cnv 空）；空 pinned→verified 不可达；兜底永不默认 verified；`cannotVerify`→park 不 reject、`contradicts`→优先 reject。
- **最高优先级不变量**：腿3 启用 ⇒ `runVerifier` 永返回 report（失败合成 couldNotVerify、非可选返回类型）+ goal-loop `report===undefined` 边界防御 ⇒ 永不回落假阳性 verified。
- held-out 命令/输出绝不进 builder 上下文（continuation 泛化 / 事件不带 / goalStore 落盘前 `{passed, results:[]}`）。
- 写 guardrail 必配**走真实接线的触发单测**（component 级测试漏过「接线后不可达」——VerifierMonitor 与 recordNonReject 都栽在这）。
- 密钥：model-facing bash 脱敏 env + `ps`/`/proc/environ` 分析器拦 + **Linux 用 .env 别用启动 env**（`assertKeyNotInLaunchEnv`）；**shadow exclude = harness 密钥边界**（复用 `sensitive.ts`,改 shadow 别只信项目 .gitignore）；vision 错误通道套 `describeModelError`+`redactSecrets`。
