# Phase D 第一批方案 · GoalLoop + 确定性两条腿验收

> 类型：历史实现计划。本文保留 Phase D 第一批 GoalLoop 与两腿验收设计；腿3和 held-out 的落地结果见 `docs/handoff-D.md` 与 `docs/phase-D-leg3-checklist.md`。
> 落地依据：知识库蓝图 §9 + `agent-harness-Part7-Guardian验收设计`。A/B/C 见各自 plan。

## 一句话目标

让 agent **会自主跑到达标自停**——蓝图 §9 最强调、生产最稀缺的「裁判≠运动员」。第一批：① **GoalLoop**（目标做成一等持久对象、状态机、多轮续跑自停）；② **确定性两条腿验收**（`update_goal(complete)` 不直接终态化——腿1 harness 自己重跑四关卡采信真退出码、腿2 git diff 测试篡改检测）。完成判定**不靠 builder 自评**。腿3 独立 LLM 裁判留接口、下一批做。

## §1 关键决策

### 三个方向（用户拍板）
1. **验收深度 = GoalLoop + 确定性两条腿**：decideVerdict 三态齐全，腿3 留接口（本批：两腿干净 + 无 report → verified，**显式分支非兜底**）。
2. **腿3 裁判模型方向 = 另一个 Doubao 模型 ID**（本批不实现）。seam：`SubagentManager.providerFor` 的 `role.model` 只是 metadata、永远回退父 provider——腿3 要注入第二个 `createProvider(config2)` + 断言 verifier≠builder，留 `verifierProvider` 注入位。
3. **范围 = 只做核心 GoalLoop + 验收**；Hooks / skill 自动沉淀 / Loop 调度（cron）/ 多模态全推后。

### 工程决策（Plan agent 已读代码核实）
1. **GoalLoop 组合**：复用同一 messages 数组（builder 要看到上轮 + 反馈）；continuation 注入成需要持久化和 round-trip 的 **user 消息**，systemAddendum 不进入 messages 且不会被压缩；整个 goal **一个 bus**；token 累计**订阅 bus `usage` 事件**。
2. **update_goal 拦截**：**闭包共享 claim 状态**（镜像 `createDelegateTool`），runAgent 返回后读；**不强制停该轮**（靠 builder prompt 约定调完即停，runAgent 契约不变、不需知道 goal）。
3. **腿1 跑 check**：抽 `runCommand`（bash 工具把退出码塞进文本 note，拿不到结构化 code）；命令来源 = **配置固定列表**（缺省 npm typecheck/lint/test/build），**绝不沾 `claim.verification`**；**不过 gate**（harness 自发起、builder 不可控的固定命令）。
4. **腿2 篡改检测**：纯函数 `classifyTestDiff`（删 test / 新增 skip.only.xit / 测试数骤降）；判不了语义弱化（记缺口、腿3 补）；**baseline 在 goal 创建时拍**（HEAD sha + 测试文件 blobHash 快照、落盘）→ 对 goal 前脏改动免疫 + 重启可比。
5. **GoalStore**：独立 JSONL（不扩 SessionStore）；`objectiveHash=sha256` 验收前 assert；goal↔session 两文件交叉引用（goal-created.sessionId）。
6. **预算 + 熔断**：不改 `Budget`；goal 级 `GoalBudget{maxRounds, maxTotalTurns?, maxTotalTokens?}`；熔断器**真接进 runGoal**（rejected 走同一 `rejectAndMaybeHalt` → `recordReject` 读返回 → halt 时 emit guardrail + forceBlocked）。

### 实现注记（D1 已落地，对 plan 的微调）
- **goal-store 放 `src/capabilities/goal/`**（不放 plan 原写的 `runtime/goal/`）：那会让 runtime 层 import capabilities 层的 goal 类型，形成 `runtime→capabilities` 反向循环。goal 模块自包含（像 subagents），goal-store 只用 node fs。
- **EventBus 的 verdict/goal_state 事件用 inline 字面联合**（不 import goal.ts），让 runtime 的 event-bus 不依赖 capabilities。

## §2 架构（核心洞察）

**GoalLoop = runAgent 之上的目标驱动外循环，runAgent 完全不需知道 goal 存在**。runGoal 持有 messages + bus + claim 闭包：跑 `runAgent`（builder + `update_goal` 工具，复用同一 messages）→ builder claim complete 写进闭包、约定调完即停 → runAgent 干净返回 → 跑确定性两条腿 + `decideVerdict` → `advanceGoalState`：rejected 把腿1 observed 包成 `<verification_feedback>` user 消息续跑 / verified 完成 / couldNotVerify 交人。

## §3 模块设计（`src/capabilities/goal/` + 改动）
- **`goal.ts`**（D1✅）：类型（Goal 不可变 objective + objectiveHash / GoalState / GoalBudget / DeterministicChecks / VerifierReport[腿3 deferred]）。
- **`state.ts`**（D1✅，纯）：`advanceGoalState`（assertNever）。
- **`verdict.ts`**（D1✅，纯）：`decideVerdict`——腿1 失败→rejected、腿2 篡改→rejected、两腿干净+无 report→verified（显式）、有 report→fail-closed couldNotVerify（腿3 deferred）。
- **`goal-store.ts`**（D1✅）：`GoalRecord` 联合 + 纯 `parseGoalLog/replayGoal` + `FileGoalStore` + `hashObjective`。
- **`checks.ts`**（D2）：`runDeterministicChecks`（腿1 跑 check + 腿2 baseline 比对）+ 纯 `classifyTestDiff`。
- **`update-goal-tool.ts`**（D3）：`update_goal` 工具（read-only、enum complete|blocked、闭包 claim、防 reward-hacking 描述）。
- **`goal-loop.ts`**（D3）：`runGoal` 编排 + 熔断接线。
- 改动：`src/core/tools/run-command.ts`（从 bash.ts 抽，D2）；`src/runtime/event-bus.ts`（halt +guardrail、+verdict/goal_state，D1✅）；CLI goal 模式 + render（D4）。

## §4 里程碑
- **D1**✅ 类型 + state/verdict/goal-store 纯函数/持久化 + EventBus 扩展 + 单测 + 本文档。
- **D2** run-command 抽取（先确认 bash 零回归）+ checks（腿1+腿2 + 纯 classifyTestDiff）+ 触发单测。
- **D3** update_goal 工具 + runGoal 编排 + 熔断接线 + 触发单测（含 integration「连续 3 reject 真 halt→blocked」）。
- **D4** CLI goal 模式（独立子命令）+ render 新事件 + `demo:d1`（真连 Doubao）。
- **D5** 收口：验收映射 + handoff-D + README/AGENTS 刷新 + 独立核查 + memory。

## §5 验收契约
1. 自主续跑：给 objective，agent 多轮干活、跑到验收过自停。
2. 不信自评：claim complete 必跑腿1/腿2，腿1 失败 → 不 complete。
3. 防删测试凑绿：腿2 检测删/skip/数量骤降 → 强制 rejected。
4. objective 不可变：验收前 assert objectiveHash 未变。
5. 熔断非死代码：连续 reject → halt → blocked（真接线 + integration 单测）。
6. fail-closed：decideVerdict 兜底永不默认 verified；verified 仅显式两腿干净路径可达。

## §6 防作弊契约（每条配触发单测）
| 风险 | 修法 | 触发单测 |
|---|---|---|
| builder 自评放过 | claim 不终态化，必跑两条腿 | `claim_complete_does_not_complete_when_leg1_fails`（D3） |
| 删测试凑绿 | 纯 classifyTestDiff + baseline 比对 | `rejected_when_test_file_deleted/_skip_added/_count_drops`（D2）+ decideVerdict（D1✅） |
| 腿1 命令被换 trivial | checkCommands 只从 config | `leg1_commands_come_from_config_not_claim`（D2/D3） |
| 熔断死代码 | recordReject 真调 + 读返回 | **integration** `goalloop_halts_to_blocked_after_3_consecutive_rejects`（D3） |
| objective 被改后验收 | assert objectiveHash 未变 | `verification_asserts_objective_unchanged`（D3） |
| **verified 默认方向反转** | 两腿干净+无 report = 显式分支，兜底 couldNotVerify | 属性测试 `verified ⇒ 两腿clean`（D1✅）+ fail-closed 兜底 |

## §7 本批 verified 的诚实边界
本批 verified = **仅确定性两条腿**（四关卡全绿 + 测试未篡改）。拦不住「写了通过 check 但没真做到 objective」——那是腿3 语义裁判的职责。`decideVerdict` 签名让「腿3 缺席」显式可见（`report?` 可选），verified 不会悄悄可达。腿3 接入后收紧。

## §8 残留 / 不做（YAGNI，留后续批）
腿3 独立 LLM 裁判（含 verifier 角色 spawn / prompt / policy / 熔断 couldNotVerify 率监控）；pinned requirements 推导；Hooks；skill 自动沉淀；Loop 调度（cron）；shadow-git；多模态。都待后续批。
