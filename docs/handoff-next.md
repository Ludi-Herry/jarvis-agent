# 交接：Phase D 腿3 之后的待办（给新会话）

> 这页只交接 **两类剩余工作**：① 需 OS 沙箱才能做的两件（leg3-checklist #2 客观路由 + #6 裁判 exec）；② Phase D 后续批（Hooks / Loop 调度 / 多模态 / bash 白名单 / shadow-git / skill 自动沉淀）。
> Phase D 腿3 整套**已全部落地 + 经 5 轮多裁判对抗核查 + 诚实文档化**，不需要再动——背景见 `docs/handoff-D.md`（主交接）、`docs/phase-D-leg3-checklist.md`（5 条全收口）、`docs/security-review-baseline.md`（审查历史 + 元教训）、项目 memory `phase-d-goalloop-deterministic-legs`。

## 一句话现状

goal 完成验收 = **确定性三腿（canonical 重跑 + 篡改检测 + held-out 隐藏断言）+ 独立只读 LLM 裁判（腿3，opt-in）**，`decideVerdict` 纯函数定 verdict、不信 builder 自评、不信 LLM 自报。**527 测试全绿**，四关卡过。本会话提交链：`f2e6e15`(腿3) → `006fe8a`(held-out) → `ee02737`(bash 脱敏) → `eeb5f05`(删死 monitor #6) → `d752fb9`(cannotVerify #2) → `a2a3c07`(收尾审查修复) → 本批(Linux /proc 根因修)。

## 第一类：需 OS 沙箱的两件（同一堵墙）

#2 客观路由 和 #6 裁判 exec **撞同一个根问题**：验收里没有「可信地跑东西」的办法。当前裁判是**纯文件取证**（read/grep），跑不了命令、驱不动 app，运行态需求恒 `cannotVerify` → park 交人（fail-closed，安全但不自主）。

### #6 — 让裁判能跑只读命令 / 驱动 app
- **要什么**：裁判验运行态需求（"CLI 跑出 X"、"build 产物能用"）需要执行,但执行=跑任意代码=任意副作用。
- **为什么 defer**：无 OS 级沙箱（容器/seccomp/只读 fs/网络命名空间），「只读 exec」做不到真只读——跑解释器/app 就是跑任意代码。命令分析器能挡 shell 层危险/密钥/网络,挡不住程序内副作用。且给裁判 exec 会削弱「裁判被注入也不能行动」这条核心安全属性。
- **做的话**：先有沙箱基建；裁判 exec 工具走沙箱（只读 fs 挂载 + 无网 + 资源限），输出回 decideVerdict。或退一步：给裁判**只读 inspection 命令白名单**（git log/diff/status、ls/find/stat/wc，**排除解释器/app-runner**）——能多取证、不跑任意代码,但仍验不了运行态行为。当前用户已拍板「保纯读」（见 leg3-checklist #6）,要改先问。

### #2 — 确定性主客观分流（客观需求跑命令验、不烧裁判）
- **现状**：防作弊覆盖面**已结构性满足**（所有 pinned 都交裁判、无「标客观」旋钮可绕）。剩的是省算力/自主杠杆。
- **为什么 defer**：「客观需求→有命令→跑命令验」需**可信的 per-需求命令**。但决策 #1 定了 `pinned = LLM 推导`的文本清单——goal-setter 给不了「还没生成的需求」预挂命令,LLM 自派生命令=弱测试 reward-hacking（held-out 腿存在正因如此）。
- **做的话**：需要「goal-setter 提供 (需求, 命令) 对」的新模式（客观项 harness 跑命令验、主观项 LLM 裁判,路由是纯函数 `有命令→客观`、builder 改不动）。这是新数据模型 + 配置负担 + 验收路径 + 一轮审查。或与上面的沙箱裁判合流。

> **共同前置**：先有 OS 沙箱（或 goal-setter-authored-requirements 模式）。没有它,这两件的「自主验运行态」都做不成,当前 park-to-human 是正确的 fail-closed 行为。

## 第二类：Phase D 后续批（独立、可单独起）

按 memory `restore-bash-session-allow` 和各工作区 `loop-and-goal-design-checklist.md` 推进：

- **Hooks**（把自动化挂到时刻）：硬约束/必跑检查用 hooks 落地。
- **Loop 调度（2026-06-30 第一切片已落地,经对抗审查 + 修复)**:`runLoop`(`capabilities/goal/loop.ts`)= runGoal 之上的多目标外循环——耐久队列 + 顺序排空 + 崩溃安全 resume(纯重放,绝不重跑已完成)+ 6 条数值硬停止 + **跨 goal 裁判健康监控重生**(`VerifierHealthMonitor`,couldNotVerify 跨 goal 累积,cnv 正交于 consecutive-blocked 使其可达;入口 `npm run loop -- <objectives 文件>` / `resume:loop`)。**零完成授权**(loop.ts 不 import runGoal/decideVerdict,completed 逐字拷 runGoal state)。`loop-store.ts` append-only + replayLoop;`loop-cli.ts` 组合根(每目标新建 tools registry,默认 attended / `--unattended` fail-closed / `--resume`+`--force`)。
  - **对抗审查结论(49 agent,crown jewel 复核)**:跨 goal 监控**不是死护栏**——在 leg-3 启用(`ARK_VERIFIER_MODEL`)模式下可达且设计正确,默认无 verifier 时惰性是对的(没共享裁判就没健康信号)。修了 4 个 MEDIUM:① 崩溃落在停机决定与 recordHalted 之间→resume 绕过 NEEDS_HUMAN 闸门(根因修:runLoop 顶部按种子状态预检 consecutive-blocked/monitor.isTripped + loop-cli 从重建状态推导 needs-human)② token 非真硬上限(加 per-goal token 帽)③ rl 错误路径不关→进程挂(try/finally)④ token 计费漏 leg-3/pinned 派生(off-bus,已诚实文档化)。
  - **诚实边界 / 残留(都已在 loop-cli 注释写明)**:① headline 跨 goal 监控**仅在 `ARK_VERIFIER_MODEL` 设了才活**(默认 `npm run loop` 不开 leg-3);② **held-out 腿没接**(per-objective 秘密,一个共享文件对异构队列无意义,要 held-out 用单 goal `npm run goal`)→ loop 默认验收门槛 = leg1+leg2(同 goal-cli 无 held-out);③ 真无人值守 bash 仍 fail-closed(沙箱前置,见 bash 白名单条)。**defer**:并行目标(需 worktree)、cron 守护、mid-goal 续跑、off-bus token 计费 plumbing、per-goal 异构 verifier。`docs/security-review-baseline.md` 是权限系统专用、未记本轮(Loop 非权限子系统)。
- **bash 无人值守白名单**：当前 bash 每次人审（B11）。无人值守自治要上 scoped allow-list,配 memory `restore-bash-session-allow`（B 加固时故意删了 session-allow,按白名单约束恢复、别无条件加回）。`decide.ts:121` / `permission-gate.ts:97` 有对应 TODO。
- **多模态 vision（2026-06-30 第一切片已落地,经 codex 对抗审查 + 修复)**:**异构委派 + 坐标锚点**(memory `openhanako-outer-vision-multimodal`)——主推理模型保持纯文本(Message 无图像 part),`vision` 工具(`src/core/tools/vision-tool.ts`)读本地图像→base64→调远端 VLM(`src/core/model/vision.ts` `createVisionComplete`,非流式)→返回**结构化坐标文本**(物体名 + bbox,`VISION_PROMPT` 钉死禁散文)进主对话。`resolveVisionConfig` 读 `ARK_VISION_MODEL`,**仅设了才注册**(同 leg-3 opt-in);capability=**`network`**(发图出网→gate 判 ask、无 approver fail-closed,不静默出网);路径走 `safeResolve`(cwd 限 + 拒涉密)。仅接进 REPL + `demo:vision`。
  - **codex 审查结论**:1 HIGH(我判 MEDIUM)——vision 是新的 model-facing 错误通道,原样回灌 `err.message` 绕过了主 provider 既有的 `describeModelError`/`redactSecrets`,端点回显 key/data-URL 会泄进上下文+session;**已修**(createVisionComplete 套 describeModelError + `redactSecrets` 扩 data-URL 脱敏)。顺带修 size-cap TOCTOU(读后按 buffer 复检)。路径/gate 主链路审查确认无静默绕过。
  - **诚实边界 / defer**:① **活体未验**(ARK vision 请求形状、坐标输出质量需真 key + vision 模型 id + 测试图,demo 接好但我没跑);② MIME 只看扩展不 sniff magic bytes;③ vision **未接 goal/loop/verifier**(只 REPL);④ 视频(kimi 时间维)、原生多模态、图上画 mark、多图/URL 图均 defer。
- **skill 自动沉淀**（人审 gate）、**shadow-git**。

## 上手顺序（新会话）

1. 读 `docs/handoff-D.md`（Phase D 主交接：架构、两种 verified 模式、最高优先级不变量、gotcha、关键文件）。
2. 读本页（剩余两类）+ `docs/phase-D-leg3-checklist.md` 顶部「落地状态」（5 条结论 + 残留）。
3. memory `phase-d-goalloop-deterministic-legs`（不变量 + 历轮教训）、`restore-bash-session-allow`（白名单）。
4. `docs/security-review-baseline.md`（审查方法 + 严重度尺子 + 历史 + 元教训：组件级 review 挡不住系统级不可达 / OS 语义坑 / 死 guardrail 成对出现）。

## 别破的不变量（改验收代码前必读）

- `decideVerdict`：腿1/腿2/held-out 在任何 report 评分前判 rejected（注入不可绕）；唯一 verified 窄分支（每条 pinned proves+matched + feature works + pinned 非空 + cnv 空）；空 pinned→verified 不可达；兜底永不默认 verified；`cannotVerify`→park 不 reject、`contradicts`→优先 reject。
- **最高优先级不变量**：腿3 启用 ⇒ `runVerifier` 永返回 report（失败合成 couldNotVerify、非可选返回类型）+ goal-loop `report===undefined` 边界防御 ⇒ 永不回落假阳性 verified。
- held-out 命令/输出绝不进 builder 上下文（continuation 泛化 / 事件不带 / goalStore 落盘前 `{passed, results:[]}`）。
- 写 guardrail 必配**走真实接线的触发单测**（component 级测试漏过「接线后不可达」——VerifierMonitor 与 recordNonReject 都栽在这）。
- 密钥：model-facing bash 脱敏 env + `ps`/`/proc/environ` 分析器拦 + **Linux 用 .env 别用启动 env**（`assertKeyNotInLaunchEnv`）。
