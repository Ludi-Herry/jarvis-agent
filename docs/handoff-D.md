# 交接：Phase D 第一批完成（GoalLoop + 确定性两条腿验收，2026-06-29）

给接手者（人或 AI）。读完这页你应知道：Phase D 第一批做了什么、关键决策与 gotcha、验收怎么映射到测试、安全边界、怎么运行、下一步。完整设计见 `phase-D-plan.md`；C 阶段见 `handoff-C.md`；项目规则见根 `AGENTS.md`。

## 一句话状态

**Phase D 第一批全部完成**：agent 能**自主跑 goal 到达标自停**——`update_goal(complete)` 不直接终态化，走**确定性两条腿验收**（腿1 harness 自己重跑四关卡采信真退出码、腿2 git diff 测试篡改检测），完成判定**不靠 builder 自评**。`npm run typecheck / lint / test / build` 全绿（**446 测试**，+31）。`demo:d1` 真连 Doubao 跑通一个 goal 到 verified。腿3 独立 LLM 裁判**留接口、本批未做**。

## 架构一句话

**GoalLoop = runAgent 之上的目标驱动外循环，runAgent 完全不需知道 goal 存在**。`runGoal` 持有一个 messages 数组 + 一个 bus + 一个 claim 闭包槽：每轮跑 `runAgent`（builder + `update_goal` 工具，复用同一 messages）→ builder claim complete 写进闭包、约定调完即停 → runAgent 干净返回 → `runDeterministicChecks`（腿1+腿2）+ `decideVerdict` → `advanceGoalState`：rejected 把腿1 实测 observed 包成 `<verification_feedback>` user 消息续跑 / verified 完成 / couldNotVerify/blocked 交人。

## 各里程碑（含 commit）

| 里程碑 | commit | 内容 |
|---|---|---|
| D1 类型 + 纯函数 + 持久化 | ba5424e | `goal.ts`（Goal 不可变 objective+hash / 状态机 / GoalBudget / DeterministicChecks / VerifierReport[腿3 deferred]）+ `state.ts`（advanceGoalState assertNever）+ `verdict.ts`（decideVerdict 两腿+显式 verified 分支+fail-closed 兜底）+ `goal-store.ts`（GoalRecord/parse/replay/FileGoalStore/hashObjective）+ EventBus 扩展 |
| D2 确定性两条腿 + runCommand | b0bbf4f | `run-command.ts`（从 bash.ts 抽 execute→runCommand，bash 零回归）+ `checks.ts`（腿1 重跑 check 采信真退出码 + 纯 classifyTestDiff 腿2） |
| D3 update_goal + GoalLoop + 熔断 | 2a6b84d | `update-goal-tool.ts`（read-only/enum/闭包 claim/takeClaim/防 reward-hacking 描述）+ `goal-loop.ts`（runGoal + VerifierCircuitBreaker 真接线）+ assertObjectiveUnchanged |
| D4 CLI goal 模式 + demo | 7ee36d0 | `goal-cli.ts`（独立入口 `npm run goal`，交互 approver + git baseline）+ render 新事件 + `demo:d1` 真连 Doubao PASSED |
| D5 收口 | （本提交） | 验收映射 + 本交接 + README/AGENTS 刷新 + 独立核查（两裁判核出并修 oracle 中性化 HIGH）+ memory |

## §5 验收契约 → 测试映射（全绿）

| 验收条目 | 覆盖测试 / 证据 |
|---|---|
| 1 自主续跑到达标自停 | `goal-loop` "completes only when…clean checks" · `demo:d1`（真连 Doubao，objective→build→verify→complete） |
| 2 不信自评（claim 必过两条腿） | `goal-loop` "does NOT complete when leg 1 fails" · "does NOT complete when tests tampered" |
| 3 防删测试凑绿 | `checks` `classifyTestDiff`（deleted / skip-only / count-drop）· `verdict` "rejected when tests tampered" |
| 4 objective 不可变 | `goal-loop` "assertObjectiveUnchanged…throws for a changed one" |
| 5 熔断非死代码 | `goal-loop` **integration** "halts to blocked after 3 consecutive rejects before maxRounds"（calls==3 + guardrail event）· 类级 trips/latch/reset |
| 6 fail-closed | `verdict` "verified ONLY when both legs clean AND no report" · 属性测试 "verified ⇒ 两腿clean" · "a present report is fail-closed" |

防作弊：每道护栏（腿1/腿2/熔断/objective/fail-closed 兜底）都有「真触发」单测；无删/skip 测试。

## 关键决策

- **裁判≠运动员，走确定性两条腿**（用户拍板）：完成判定不信 builder 自报 status——腿1 harness 真重跑四关卡采信真退出码，腿2 检测测试篡改。最防作弊、不需第二模型、最便宜。
- **GoalLoop 不改 runAgent**：runGoal 是外循环，runAgent 仍是注入式单消息内循环、不知道 goal。复用同一 messages（builder 看到上轮 + 反馈），continuation 注入成 user 消息（持久 + 可压缩，不是 systemAddendum）。
- **腿1 命令只从 config，绝不沾 claim**：`checkCommands` 来自 deps（缺省四关卡常量），builder 的 `verification` 只当提示——堵「报个 trivial 命令蒙混」。腿1 不过 gate（harness 自发起的固定命令，builder 不可控）。
- **decideVerdict 兜底永不默认 verified**：verified 仅「两腿 clean && report===undefined」显式分支；任何未识别组合 → couldNotVerify。
- **熔断真接进 runGoal**（修 Part7 P0-2 死代码）：两条 reject 路径都经 `recordReject` 读返回，连续 3 reject → halt → blocked。
- **目录**：goal 全在 `src/capabilities/goal/`（含 goal-store，不放 runtime/goal/）——避免 runtime→capabilities 反向循环。

## 本批 verified 的诚实边界（重要）

本批 verified = **仅确定性两条腿**（四关卡全绿 + 测试未被篡改）。它**拦不住「写了通过 check 但没真做到 objective」**——那是腿3 语义裁判的职责（本批未做）。`decideVerdict(checks, report?)` 的签名让「腿3 缺席」显式可见：`report` 可选，两腿干净 + 无 report 才走 verified 显式分支；一旦腿3 接入产出 report，把 verdict.ts 里那个 fail-closed 分支换成完整 evidence×scope 表（Part7 §3.2/§4）即收紧。

## 安全（goal 验收不被绕）

完成判定的防作弊靠三条结构保证，各有触发单测：① claim 不终态化、必跑确定性两条腿；② checkCommands 只从 config、腿1 采信真退出码；③ 熔断真接线 + objective 不可变 assert + fail-closed 兜底。

**独立核查**：D5 跑两个独立裁判（codex gpt-5.5 xhigh + 独立 Claude 子代理），聚焦「goal 验收有没有被绕 / 熔断是否死代码 / verified 是否悄悄可达 / builder 能否换 trivial check」。结论见下。

> **独立核查结论（2026-06-29，两个独立裁判）**：codex（gpt-5.5 xhigh）+ 独立 Claude 子代理**各自独立**抓到同一个 HIGH——**检查命令的 oracle 可被 builder 中性化**：腿1 跑的 `npm test/build` 等，其定义在 `package.json` scripts / tsconfig / eslint/vitest config，这些文件原不在腿2 的 `test/` 监控范围；builder 改 `package.json` 的 `"test":"exit 0"` 就能让四关卡全绿且腿2 看不到 → 假 verified（走配置而非 test/ 文件）。**已修**：腿2 把 check-oracle 文件（package.json/lockfile/tsconfig/eslint/vitest/jest config）纳入篡改检测、改用全工作区 diff、git 失败 fail-closed、空 checkCommands fail-closed、SKIP 正则扩 focus 标记；+4 触发单测钉死 + post-fix 复核。其余不变量（claim 不终态化、checkCommands 只从 config、熔断真接线、verified 仅显式分支兜底 fail-closed、objective 不可变）两裁判均确认未破。**这正是「裁判≠运动员」的回报**：确定性 backstop 的「可信根」（验收脚本/配置）本身可被运动员改写——判定逻辑没错，错在信任了 builder 可写的 oracle，两个独立裁判同点收敛抓出。
>
> **残留 LOW（已接受 / 记缺口）**：① check scripts 间接引用的子脚本（package.json scripts 调的 .js）本批未纳入 oracle 检测——scripts 定义本身已捕获，深层脚本待腿3/后续；② classifyTestDiff 的净增减是跨文件全局计数（A 删真用例、B 加 trivial 可互抵）、注释整段 it 仍匹配 CASE——语义弱化留腿3；③ `assertObjectiveUnchanged` 本批进程内近似 no-op（objective 同源创建期、运行中无改写路径），价值在 resume/replay 路径，作为 defense-in-depth 放对位置。

## gotcha / 已知小账

- **腿3 LLM 裁判未做**：verifier 角色 spawn / prompt / policy / couldNotVerify 率监控 / pinned requirements 推导都 deferred。seam：`SubagentManager.providerFor` 的 `role.model` 只是 metadata、永远回退父 provider——腿3 用「另一个 Doubao 模型 ID」不能靠 role.model，要注入第二个 `createProvider(config2)` + 断言 verifier≠builder。
- **腿2 检测范围**：全工作区 diff vs baseline，查 ① 测试文件（删/skip/focus 标记/数量骤降）② **check-oracle 文件**（package.json/lockfile/tsconfig/eslint/vitest/jest config 被改 → tamper，堵「把 `npm test` 改成 `exit 0`」中性化验收 oracle，H-1）。git diff 失败 → fail-closed。**判不了**：语义弱化（`toBe`→`toBeDefined`）+ check scripts 间接引用的子脚本——已知缺口，腿3/后续补。无 baseline（非 git 仓）→ 腿2 inert。
- **腿1 不过 gate**：harness 自跑配置固定命令（非模型注入），过 gate 反而会在验收中弹审批/被拒。安全前提是 checkCommands 不可被 builder 影响（代码硬保证）。
- **goal 模式的 builder write/bash 仍过 gate**：`npm run goal` 用交互 approver；自主性受 approval 约束（无人值守白名单是 Phase D 后续 + memory `restore-bash-session-allow`）。`demo:d1` 用自动 approver 演示。
- **熔断本批只连续阈值**（无滑窗）：Part7 §6.1 的滑窗在本状态机可达性存疑，故只留连续 3 阈值。

## 关键文件

```
src/capabilities/goal/
  goal.ts            # Goal/状态机/budget/checks/VerifierReport(腿3 deferred) 类型
  state.ts           # advanceGoalState 纯函数（assertNever）
  verdict.ts         # decideVerdict 纯函数（两腿 + 显式 verified + fail-closed 兜底）
  checks.ts          # runDeterministicChecks(腿1 真退出码) + 纯 classifyTestDiff(腿2)
  update-goal-tool.ts# update_goal(read-only/闭包 claim/防 reward-hacking) + takeClaim
  goal-loop.ts       # runGoal 外循环 + VerifierCircuitBreaker(真接线)
  goal-store.ts      # GoalRecord/parse/replay/FileGoalStore/hashObjective/assertObjectiveUnchanged
src/core/tools/run-command.ts   # 从 bash.ts 抽的 spawn/超时树杀/结构化退出码 runner
src/runtime/event-bus.ts        # +guardrail halt reason、+verdict/goal_state 事件
src/surfaces/cli/goal-cli.ts    # npm run goal -- "<objective>"（交互 approver + baseline）
src/surfaces/cli/render.ts      # +verdict/goal_state 渲染
scripts/d1-demo.ts              # 真连 Doubao 的活体验证
test/capabilities/goal/         # state/verdict/goal-store/checks/goal-loop（+27 测试）
```

## 怎么运行

- 四关卡：`npm run typecheck / lint / test / build`
- goal 模式：`npm run goal -- "<objective>"`（交互审批 + 自主验收，需 `ARK_API_KEY`）
- 活体 demo：`npm run demo:d1`（真连 Doubao 跑一个 goal 到 verified）

## 下一步（Phase D 后续批）

- **腿3 独立 LLM 裁判**（Part7 §3-§6 完整）：goal-verifier 角色 spawn（另一个 Doubao 模型、isolation、父∩只读白名单、approval=never、密钥禁读、evidence 脱敏）+ verifier prompt/schema/policy + pinned requirements 推导 + couldNotVerify 率监控。把 verdict.ts 的 fail-closed 分支换成完整 evidence×scope 表。
- **Hooks**（把自动化挂到时刻）、**skill 自动沉淀**（人审 gate）、**Loop 调度**（cron 长跑）、**多模态**、**shadow-git**、**bash 白名单**（无人值守自主，配 memory `restore-bash-session-allow`）。
