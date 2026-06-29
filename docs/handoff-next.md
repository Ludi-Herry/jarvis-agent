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
- **Loop 调度**（cron 长跑）：多 goal 会话的入口——**也是「跨 goal 裁判健康监控」的落点**（本会话删的 per-goal `VerifierMonitor` 不可达,couldNotVerify 率是跨 goal 信号,Loop 落地后以跨 goal 形态重加 + 真 integration 触发单测,见 security-baseline #6 收口轮）。
- **bash 无人值守白名单**：当前 bash 每次人审（B11）。无人值守自治要上 scoped allow-list,配 memory `restore-bash-session-allow`（B 加固时故意删了 session-allow,按白名单约束恢复、别无条件加回）。`decide.ts:121` / `permission-gate.ts:97` 有对应 TODO。
- **skill 自动沉淀**（人审 gate）、**多模态**（参考 memory `openhanako-outer-vision-multimodal`）、**shadow-git**。

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
