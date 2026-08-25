# 交接：Phase C 完成（多 agent / SubagentManager，2026-06-29）

> 类型：历史阶段快照。测试数量与下一步只代表 2026-06-29；当前产品路线见 `docs/cli-first-plan.md`。

给接手者（人或 AI）。读完这页你应知道：Phase C 做了什么、关键决策与 gotcha、验收怎么映射到测试、安全边界、怎么运行、下一步从哪开始。完整设计见 `phase-C-plan.md`；B 阶段见 `handoff-B.md`；项目规则见根 `AGENTS.md`。

## 一句话状态

**Phase C 全部完成**：agent 能**显式委派子 agent**——两条轴都做实：① **按能力分发**（`task` 工具派专家，只回浓缩摘要）② **按视角评审面板**（N 个 read-only 评审 agent 并行读同一产物、各戴一顶视角帽）。子 agent 在**能力交集护栏**下构造时即不可越权、**复用父 gate** 因而不绕命令安全根、受 depth/预算/并发上限约束。`npm run typecheck / lint / test / build` 全绿（**415 测试**，+45）。两个里程碑各有真连 Doubao 的活体 demo（`demo:c1` 能力分发、`demo:c2` 视角面板）。

## 架构一句话

**子 agent = 在「父 context 的收窄变体」上递归跑 `runAgent`**——不写新 loop。`runAgent(ctx)` 本就注入式可递归；`SubagentManager.spawn/spawnRole` 构造收窄 ctx（subset 工具 + 严格更小 budget + 角色 systemPrompt + **独立 bus + 复用父 gate + 透传 signal + 不带 store**），跑完取 `finalText` 当浓缩摘要回灌主对话。depth 活在 manager 链（每层 clone 一个收窄的子 manager），**不碰 `AgentContext`**——这是对 370 既有测试零破坏的关键。

## 各里程碑（含 commit）

| 里程碑 | commit | 内容 |
|---|---|---|
| C1 纯函数 + 类型 | 5431e07 | `derive.ts`（deriveCapabilities/Tools/Depth/Budget，构造时护栏）+ `roster.ts`（AgentRole + loadRoster，参照 loadSkills）+ `never_escalates` 含能力维度。最小权限默认（角色无 capability → read-only） |
| C2 Manager + subset | 9ec118a | `registry.subset` + `ToolRegistry` 接口加一行 + `SubagentManager`；四条硬不变量各配触发单测（不带 store / 必带 gate / 独立 bus / 透传 signal）+ R2/R4/R6 |
| C3 delegate 工具 + 接线 | 13feb9d | `task` 工具（read-only）+ CLI 组装（index 加载 roster、repl 装 manager + 注册 task）+ 模型路由 YAGNI 回退；`demo:c1` 真连 Doubao PASSED |
| C4 视角面板 + 六顶帽 | e96b412 | `panel.ts`（runPanel 并行 + MAX_THREADS 信号量 + SIX_HATS 预设）+ `spawnRole`（按 role 对象 spawn）；并发上限 + R7 触发单测；`demo:c2` 真连 Doubao PASSED |
| C5 收口 | 7f4653a | 验收映射 + 本交接 + README/AGENTS 刷新 + 独立核查（两裁判核出并修嵌套委派 HIGH-1）+ memory |
| C6 压缩容错硬化（A 遗留） | （本提交） | run-agent 压缩调用包 try-catch：summarizer 失败跳过本轮压缩、不丢已完成的 turn；abort 仍传播。+2 触发单测。shadow-git 维持留到 D |

## §5 验收契约 → 测试映射（全绿）

| 验收条目 | 覆盖测试 / 证据 |
|---|---|
| 1 能力分发 | `delegate-tool` "child write still hits the approver…" · `subagent-manager` 闭环组 · `demo:c1` Run A/B（真连 Doubao） |
| 2 视角面板 | `panel` "returns one review per hat" · "R7 parallel read-only" · `demo:c2`（黑/黄/绿三帽视角分化） |
| 3 构造时不可越权 | `derive` `never_escalates`（能力 + 工具维度）· "R1 read-only child never gets bash" |
| 4 不绕命令安全根 | `subagent-manager` "R6 session-grant 契约" · `delegate-tool` "不绕 write 审批" · 子复用父 gate（write→ask、bash→每次人审） |
| 5 不污染会话 | `subagent-manager` "child ctx: no store…"（R3，子 ctx 永不带 store） |
| 6 不无限递归/烧钱 | `subagent-manager` "R4 depth cap"、"R5 子 budget<父" · `panel` 并发上限 |

防作弊：R1–R8 每道护栏 + 四条硬不变量都有「真触发」单测（无删/skip 测试、无降规则）；两个 demo 端到端真连 Doubao PASSED。

## 关键决策

- **显式委派，不自动触发**（用户拍板）：主 agent 显式调 `task`，harness 不替它判断该不该派。自动触发（model.judge）推后——可控、可预测、护栏简单。
- **能力交集是最强护栏**（构造时不可越权 > 事后检测）：子能力 = 父∩请求，`deriveTools` 叠 capability 过滤（R1）。即使角色 tools 写了 bash，read-only 子也拿不到。
- **子复用父 gate**：同一 `DefaultPermissionGate` 实例传子 ctx——子内 write/bash 仍每次过 gate。`sessionGrants` 按工具名共享，父 allow-session(write) 后子 write 静默放行（对 bash 无此问题，executes-code 永不进 grant）。这是有单测固定的既定契约；边界由子能力⊆父、safeResolve 锁 cwd、敏感路径先于 grant 硬 deny共同约束。
- **task 工具 = read-only**：委派本身无副作用（都在子内由子 gate 拦），不弹审批；成本靠 depth/budget/并发护栏，不靠 gate。
- **depth 不进 AgentContext**：由 manager 链跟踪，零破坏既有测试。
- **模型路由 YAGNI**：单 provider，`role.model` 作元数据 + 回退父 provider；`reasoningEffort` 已生效。第二 endpoint 出现再上路由层。
- **六顶帽是预设、不硬编码**：`SIX_HATS` 是 panel.ts 的预设数据；`runPanel` 接任意 `AgentRole[]`。

## 安全（子 agent 不绕命令安全根）

`task` 工具 + 子 agent **是新工具面**。三条结构保证「安全根不被绕过」，各有触发单测：
1. 子复用父 gate → executes-code 每次人审、sensitive-path 硬 deny 对子同样生效。
2. capability 交集（构造时不可越权）→ 子工具面恒 ⊆ 父。
3. depth/并发上限 + 严格更小 budget → 不无限递归、不烧钱。

**独立核查**：C5 按 `security-review-baseline.md` 跑了一轮独立 codex（gpt-5.5 xhigh），聚焦「子 agent 有没有绕 gate/越权」，**不重核命令解析器**。结论见下「独立核查结论」段。

> **独立核查结论（2026-06-29，两个独立裁判）**：codex（gpt-5.5 xhigh）+ 一个独立 Claude 子代理**各自独立**抓到同一个 HIGH——**嵌套委派的 depth/能力/预算收窄链断裂**。根因：`buildChildRegistry` 里子的 `task` 工具绑的 nested manager 复用了 root 的 registry/budget（`withDepth` 只改 depth），且 `childDepth===0` 的 fallback 没剔除继承的 root-bound `task` → 叶子能拿到「绑根 manager」的 task，下一跳 depth 复位 → 无界递归 + read-only 子能让后代从 root 派生出 write/bash（写仍过 gate，但「越权不可表示」的纵深防御被击穿）。**已修**：`buildChildRegistry` 现总是先剔除继承 task，仅 `childDepth>0` 才重绑一个用「子收窄 registry + 子收窄 budget」构造的 nested manager，每层从直接父派生；`spawnRole` 包 try-catch fail-closed。新增 2 个触发单测钉死（read-only 子委派不出 write、budget 12→6 链式收窄、depth-0 子无 task）。其余不变量（gate 复用→write/bash 仍过人审、store 不污染、signal 透传、R2 fail-closed、subset 只收窄）两裁判均确认未破。修后四关卡全绿（413 测试）+ post-fix 复核。**这正是「裁判≠运动员」的回报**：C2 设计 buildChildRegistry 时引入的跨层链式 bug（单层正确、depth≥2 失效），靠两个独立裁判核出，单层枚举测试覆盖不到。

## gotcha / 已知小账

- **角色从 `agents/<role>/ROLE.md` 加载**（参照 skills/）。本仓库自带 `agents/researcher/`（read-only 调研专家）。无 roster → 不注册 `task` 工具，行为同 Phase B。
- **session-grant 跨子 agent 共享 write**（见关键决策）：务实档，已接受、有契约单测。若将来要更强隔离，给子 mint 独立 gate（需 repl 改注入 `{approver,policy}` 而非 gate 实例）。
- **MAX_SUBAGENT_DEPTH = 2**（repl.ts）：主→子→孙两层委派。`remainingDepth=0` 时 spawn 拒（返 error 不崩）。
- **子 agent 不带 skill catalog**（无 systemAddendum）：专家有自己的 systemPrompt，不走 skill 渐进披露。
- **panel 并发上限默认 4**（`DEFAULT_PANEL_CONCURRENCY`）：fan-out 不撑爆。单 spawn 本就被父 loop 串行，并发信号量只在 panel。
- **demo 真连 Doubao**：`demo:c1`（能力分发）、`demo:c2`（视角面板，3 帽并行 thinking-low，较慢）。需 `ARK_API_KEY`。

## 关键文件

```
src/capabilities/subagents/
  derive.ts            # 构造时护栏纯函数（capabilities/tools/depth/budget 收窄）
  roster.ts            # AgentRole + loadRoster + rosterCatalog + findRole
  subagent-manager.ts  # spawn/spawnRole：收窄 ctx 递归跑 runAgent；depth/能力/预算逐层 clone 收窄
  delegate-tool.ts     # task 工具（read-only）：把 spawn 暴露给模型（能力分发轴）
  panel.ts             # runPanel 并行 + MAX_THREADS + SIX_HATS 预设（视角评审轴）
src/core/tools/registry.ts   # +subset(names)（复用 def 引用）
src/core/tools/types.ts      # ToolRegistry 接口 +subset 一行
src/surfaces/cli/repl.ts     # 装 manager + 注册 task + 透传 signal（MAX_SUBAGENT_DEPTH）
src/surfaces/cli/index.ts    # loadRoster('agents') + 传 roster
agents/researcher/ROLE.md    # 自带示例角色（read-only 调研专家）
scripts/c1-demo.ts · c2-demo.ts   # 真连 Doubao 的活体验证
test/capabilities/subagents/      # derive / roster / subagent-manager / delegate-tool / panel（+41 测试）
```

## 怎么运行

- 四关卡：`npm run typecheck / lint / test / build`
- 终端（含委派 + 面板能力，若 `agents/` 有角色）：`npm run dev`
- 活体 demo：`npm run demo:c1`（能力分发）、`npm run demo:c2`（视角面板）。需 `ARK_API_KEY`。

## 下一步

- **Phase D（自主）**：GoalLoop + Hooks + skill 自动沉淀（人审 gate）。独立验收（Part7 Guardian）在 D 落地——本阶段的视角面板是它的常驻化雏形。
- **自动触发**（Phase C 推后项）：harness 自动判断该不该派子 agent（model.judge + 四护栏焊死）。
- **可选增强**：异步 fire-and-forget 委派（对话型）、git worktree 物理隔离（写并行真冲突时）、多 provider 模型路由（第二 endpoint 出现时）、子 mint 独立 gate（要更强 write 隔离时）。都待真需求出现再上。
