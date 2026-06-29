# Phase C 方案 · SubagentManager / 多 agent

> 完整设计文档（长期留存）。落地依据：知识库蓝图 §4 Cluster3 + 项目 memory `c-phase-agent-roster-two-axes`。A/B 见 `phase-A-plan.md` / `phase-B-plan.md`。

## 一句话目标

让单 agent **会显式委派子 agent**——按能力分发（专家路由，省主上下文/省钱/分工）+ 按视角评审面板（独立验证常驻化）。子 agent 在**能力交集护栏**下构造时即不可越权、**复用父 gate** 因而不绕命令安全根、受 depth/预算/并发上限约束不无限递归烧钱。**对现有 370 测试零破坏**。

## §1 关键决策

### 三个方向（用户拍板）
1. **触发方式 = 显式委派工具**：主 agent 显式调 `task` 工具派子 agent，harness 不自动判断；自动触发推后（Phase C 后段或 D 的薄层）。
2. **隔离档 = 能力交集 + 读并行/写串行**：子 agent 能力 = 父∩请求（构造时不可越权，配 `never_escalates` 单测）；只读子 agent 并行、写盘子 agent 串行。不上 git worktree 物理隔离（避开 Windows 坑）。
3. **两轴深度 = 底座通用 + 两轴都做实**：roster 接口同时声明专家（能力路由）和评审面板（视角并行）；两轴都给可跑实现 + demo；六顶帽只作可选预设数据、不进 harness 硬编码。

### 5 个工程决策（Plan agent 已读代码核实）
1. **子事件浮现**：子 agent 用 manager 现 new 的独立 `InMemoryEventBus`（仅 manager 订阅取摘要），子内部事件不进父 bus。`task` 是注册进父 registry 的普通工具，父 loop 已对它 emit `tool_call`/`tool_result`，父 UI 天然显示 `⏺ task(...)` + `↳ 摘要`。**零改 `render.ts` / `Event` 联合**。
2. **`task` 工具能力 = `read-only`**：→ 默认 allow，委派不弹审批；成本控制靠预算/深度/并发护栏。不绕 write 审批：子内 write/bash 仍以各自能力命中 `gate.check`→ask。
3. **复用父 gate**：同一 `DefaultPermissionGate` 实例传子 ctx。`sessionGrants` 按工具名共享——父对 `write` 选过 `allow-session` 后子 write 会静默放行（对 bash 无此问题，executes-code 永不进 grant）。**走 (A) 复用实例 + 钉死单测**把该语义从"意外"变"契约"（边界可控：子能力⊆父、safeResolve 锁 cwd、敏感路径先于 grant 硬 deny）。若 C5 独立评审认为 write 泄漏不可接受，再上 (B) 给子 mint 独立 gate。
4. **depth 不碰 AgentContext**：由 manager 链自己跟踪（每层 `new SubagentManager` 一个 registry/budget 收窄、`remainingDepth` 递减的子 manager）。AgentContext 被全仓多处手搓构造，加字段属概念越界且有破测风险。
5. **收窄子 registry**：给 `InMemoryToolRegistry` 加 `subset(names)`（复用同一 `ToolDefinition` 引用），`ToolRegistry` 接口加一行 `subset`（全仓唯一实现，零破坏）。

### 务实取舍
- **模型路由降级 YAGNI**：当前只有一个 provider（Doubao），`role.model` 作元数据 + 回退父 provider；待第二 endpoint 再上 model→provider 解析层。
- **最小权限默认**：角色不声明 `capability` 时，子能力默认 `['read-only']`（fail-safe）——要写/执行必须显式声明。
- **角色 YAGNI**：roster 按需扩，别先堆丰富角色（Hermes 两 role 撑生产）。六顶帽作预设、不硬编码。

## §2 架构（核心洞察）

**子 agent = 在「父 context 的收窄变体」上递归跑 `runAgent`**——不写新 loop。`runAgent(ctx: AgentContext)` 已注入式可递归；SubagentManager 负责：
- 构造收窄 ctx：收窄 `tools`（subset）/ `budget`（deriveBudget）+ 角色 `systemPrompt` + **独立 bus** + **复用父 gate** + **透传父 signal** + **不带 store**。
- 管生命周期：depth cap（manager 链）+ 并发治理（仅 panel fan-out 需要）。
- 把子 agent 的 `finalText` 当浓缩摘要回灌主对话（delegate 工具的返回）。

## §3 模块设计（`src/capabilities/subagents/`）

- **`derive.ts`**（C1✅，纯函数 + 单测，护栏核心）：`deriveCapabilities`（父∩请求，缺省 read-only）/ `deriveTools`（名字交集 ∩ **能力交集**，R1）/ `deriveDepth`（min(请求,父-1)）/ `deriveBudget`（严格更小 maxTurns）。`ToolMeta = {name, capability}`。
- **`roster.ts`**（C1✅）：`AgentRole` 类型（name/description/systemPrompt/model?/reasoningEffort?/capability?/tools?/isolation?/maxTurns?/maxDepth?）+ `loadRoster`（扫 `<dir>/<role>/ROLE.md`，参照 `loadSkills`）+ `rosterCatalog` + `findRole`。非法枚举值过滤、数字强制。
- **`subagent-manager.ts`**（C2）：持父资源快照（provider / 父 registry / 父 gate / budget / roster / `remainingDepth` / 并发计数）；`spawn(roleName, task)` 构造收窄 ctx → `await runAgent` → 取摘要。
- **`delegate-tool.ts`**（C3）：把 spawn 暴露成 `task` 工具（capability=`read-only`），注册进父 registry。
- **`panel.ts`**（C4）：视角面板并行 spawn N 个 read-only 评审 agent 读同一产物 + 汇总 + MAX_THREADS 信号量；六顶帽预设数据。

## §4 里程碑（A/B 节奏：纯函数 → 实现 → 接线 → 四关卡 → commit）
- **C1**✅ `derive.ts` + `roster.ts` + 单测（含 `never_escalates` 覆盖能力维度）+ 本文档。
- **C2** `registry.subset` + `SubagentManager`；四条硬不变量各配触发单测（不带 store / 必带 gate / 独立 bus / 透传 signal）+ depth cap。
- **C3** `delegate-tool.ts` + CLI 组装接线 + 模型路由（YAGNI 回退）+ `demo:c1`。
- **C4** `panel.ts` + 六顶帽预设 + MAX_THREADS + `demo:c2`。
- **C5** 收口：验收映射 + `handoff-C.md` + AGENTS.md/README 刷新 + 独立 codex 核查。

## §5 验收契约
1. 能力分发：主 agent 调 `task` 派一个专家子 agent，子在收窄能力下完成、只回浓缩摘要进主对话。
2. 视角面板：召集 N 个 read-only 评审 agent 并行读同一产物、各写评审。
3. 构造时不可越权：`never_escalates`（能力 + 工具维度）。
4. 不绕命令安全根：子内 write/bash 仍过父 gate（write→ask、bash→每次人审）。
5. 不污染会话：子 ctx 不带 store，一次委派后 resume 重放父对话正确。
6. 不无限递归/烧钱：depth cap 触发、子 budget < 父、panel 并发 ≤ 上限。

## §6 护栏与绕闸风险（每条配触发单测）
| 风险 | 修法 | 触发单测 |
|---|---|---|
| **R1 能力升格** | deriveTools 叠能力交集 | 父含 bash + 请求 read-only+bash → 子集不含 bash（C1✅） |
| **R2 子裸跑无 gate=全面绕闸** | manager 无条件给子带 gate；子集含 write/exec 却无 gate → spawn fail-closed 拒 | 故意不给 gate 的 write-spawn → 被拒不执行（C2） |
| **R3 共享 store 污染会话** | 子 ctx 不带 store | 委派后 `loadSession` 重放父对话条数/顺序正确（C2） |
| **R4 无限递归/自递归环** | deriveDepth + depth=0 拒 spawn | depth 耗尽 spawn 被拒（返 error 不崩）（C2） |
| **R5 烧钱** | deriveBudget 严格更小 + panel MAX_THREADS | 子 maxTurns<父（C1✅）；panel 并发 ≤ 上限（C4） |
| **R6 session-grant 泄漏** | (A) 复用实例 + 钉死契约 | 父 session 授权 write 后子 write 不再询问（C2） |
| **R7 并发审批错配** | 写串行保护单队列；read-only 并行不 ask | 全 read-only 面板并行 → approver 零调用（C4） |
| **R8 abort 不穿透** | 子 ctx 透传 signal | abort 父 → 子内 bash 被 kill（C2） |

## §7 安全（要不要重核安全根）
`task` 工具 + 子 agent **是新工具面**。三条结构保证"安全根不被绕过"：① 子复用父 gate（executes-code 每次人审、sensitive-path 硬 deny）② capability 交集（构造时不可越权）③ depth/并发上限。C5 按 `security-review-baseline.md` 跑一轮 codex，重点核"子 agent 有没有绕 gate/越权"，非重核命令解析器。

## §8 残留边界 / 不做（YAGNI）
- 自动触发（model.judge 该不该派）；git worktree 物理隔离；异步 fire-and-forget（第一版编码型用阻塞 wait）；多 provider 模型路由；append/close/reuse 生命周期（第一版只 spawn+wait）。都待真需求出现再上。
