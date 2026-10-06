# 映射：V13 讨论区 → Jarvis GUI 工作台

> 用途：把 `H:\Ludi-design-studio\docs\prototypes\studio-annotation-branches-v13\` 的「讨论区」布局与交互，落到 Jarvis 现有 React + assistant-ui 前端上。本页只做映射与边界判定，不重写架构蓝图。
>
> 结论先行：V13 提供的是**布局与交互语言**，不是能力。Jarvis 提供的是**事实与命令**。凡是 V13 只有演示数据、而 Jarvis 没有真实事实或命令的地方，界面显示「未接入」、禁用或隐藏，绝不用前端状态伪装正在运行的能力。
>
> 主题：沿用 Jarvis `src/surfaces/gui/app/src/styles/tokens.css` 与 `DESIGN.md`（纯白工作面、近黑文字、1px 中性边界），吸收 V13 `v23-neutral-theme.css` 的灰侧栏 + zinc 黑灰白控件；不复制 V13 的大段 DOM/JS，不重新引入绿色主题。

## 1. 可复用（结构与交互，Jarvis 有真实事实支撑）

| V13 讨论区元素 | Jarvis 承载 | 真实事实来源 |
|---|---|---|
| 左栏：新建任务 | 任务空态 + 启动固定任务合同 | `overview.task`、`overview.sessions`、`overview.activeId` |
| 左栏：搜索 | 对已有会话做本地过滤（objective + id） | `overview.sessions` |
| 左栏：工作区分组 | 单一工作区分组，组名为真实 cwd 末段 | `overview.cwd`、`snapshot.cwd` |
| 左栏：任务切换 | 选择会话即重取完整投影 | `GET /api/live/:id` + SSE |
| 左栏：收起 / 窄屏 | 纯显示状态，持久化在 localStorage | 无（显示偏好，不是 Runtime 事实） |
| 中栏页头：文件夹图标 + 工作区 + 当前任务标题 | 同位置显示真实 cwd 与 objective | `snapshot.cwd`、`snapshot.objective` |
| 中栏：连续消息流 | assistant-ui ExternalStore 渲染投影消息 | `snapshot.messages`（Session JSONL 投影） |
| 中栏：工具执行摘要（可折叠执行记录） | 每条 assistant 消息下归组其 toolIds | `snapshot.tools`（status/args/output/path） |
| 中栏：最新回复操作行（复制 + 时间） | 复制=纯前端；时间悬停/聚焦显示 | `message.at` |
| 中栏：顶部提问摘要（sticky prompt） | 整条提问完全滚出历史区顶部才出现，最多两行，点击回到原提问 | 消息几何 + `snapshot.messages` |
| 中栏：对话定位刻度 | 仅当窗口 ≥1200px、左侧留白足够、历史可滚动且已发生滚动 | 同上（纯显示） |
| 中栏：回到最新 | 浮在历史区内、输入框外，底部渐变 | 纯显示 |
| 中栏：空任务引导 | 显示真实任务合同、可启动性与下一步 | `overview.task.requirements` + `resolveCanStart` |
| Composer：权限 / 模型 / 运行位置信息行 | 模型只读显示；运行位置显示真实 cwd | `snapshot.model`、`snapshot.cwd` |
| Composer：草稿与滚动位置恢复 | 沿用既有 localStorage 键 | 无（显示偏好） |
| 右栏：单一活动阶段（审批 → 验收 → 状态） | 原位切换，旧阶段压缩为回执 | `snapshot.approval` / `snapshot.review` / `status` |
| 右栏：文件 / Diff / 产物 | Diff 原文 + 产物清单 | `snapshot.diff`、`snapshot.artifacts` |
| 右栏：测试 / 验证 | 确定性检查命令与退出码 | `snapshot.checks` |
| 右栏：错误恢复 | 阻塞原因、警告、恢复入口 | `snapshot.warnings`、`capabilities.resume` |
| 右栏：上下文（Token / 成本 / 耗时 / 上限 / 来源） | 全部为真实记录 | `snapshot.usage`、`limits`、`sources` |
| 右栏：审批历史 | 既有审计回执 | `snapshot.approvalHistory` |
| 未接入空态表达方式 | 统一 `NotWired` 组件：中性文案 + 禁用样式 | — |

## 2. 仅演示（V13 有演示数据，Jarvis 无真实事实或命令）

| V13 元素 | 本轮处理 | 理由 |
|---|---|---|
| 团队成员 / 协作设置 / Agent Team | 隐藏 | GUI P3 没有多 Agent 能力；P1 已冻结多 Agent 市场 |
| 子智能体条目（任务监控） | 右栏保留一行「未接入」 | 投影中没有 subagent 事实；不伪造正在运行的子 Agent |
| Git 环境四行（未提交 / 本地位置 / 分支 / 提交或推送） | 只显示「本地位置」=真实 cwd，其余标「未接入」 | 投影未提供分支与工作树状态；Diff 是真实事实但不等于分支状态 |
| 终端面板 | 隐藏 | GUI 没有交互式 shell 能力；真实命令执行只在 `snapshot.checks` 中体现 |
| 模型选择菜单 + 思考强度滑杆 | 只显示当前模型名，不可切换 | 模型由 CLI config 与任务合同固定；GUI 无切换命令 |
| 模型上下文窗口用量 | 标「未接入」 | 投影未提供上下文占用事实 |
| Worktree / 分支选择 | 隐藏 | 无对应 Runtime 命令 |
| 设置齿轮（七类设置目录） | 保留入口，面板内说明未接入 | 配置由 CLI config / `.env` 管理，GUI 无写入命令 |
| 需求卡 / 方案分支 / 画布 / 注释工具 | 不移植 | 设计专用概念，不塞进编码任务 |
| 侧边聊天、后台进程、Skill 与 MCP、内置浏览器 | 右栏「未接入」行或隐藏 | 无真实事实；不制造能力假象 |
| 任务重命名 / 置顶 / 归档 / 导出 | 隐藏 | 会话事实由 Session JSONL 持有，GUI 无这些命令 |
| 回复操作行的分支 / 钩子 | 隐藏（只保留复制与时间） | 会话分叉与钩子面板没有 Runtime 命令；时间悬停或聚焦显示 |

## 3. 缺口（本轮不做，记录原因）

- 工作区多分组：GUI host 一次只绑定一个 dataDir 与一个任务合同，多工作区需要宿主层能力，属于新抽象，不做。
- 跨进程共同控制、终态复活：P3 已明确单宿主单写者边界，本轮不改。
- 真实 Reasoning 摘要：Runtime 尚未提供，投影里保留既有警告文案，不生成模拟摘要。
- 首次使用引导组件 `live/first-task-guide.tsx`：仍是 P3 真实任务未交付的空组件，保留原样与其接入位；本轮的空态引导属于 GUI 基建（外部代做），不计为 Jarvis 真实任务交付。

## 4. GUI 动作 → Runtime 入口 → 返回事件 → 持久事实

沿用 [P3 合同](./PLAN-gui-mvp-p3-runtime.md) 的接线表，本轮只补新增控件，不新增抽象。

| GUI 动作 | 现有 Runtime 入口 | 返回事件 | 持久事实 | 能力开关 |
|---|---|---|---|---|
| 启动固定任务 | `POST /api/live/start` → `GuiSessionHost.start` → `runGoal` | `gui_status(starting)`、model/message/tool/goal | FileSessionStore v2 + FileGoalStore + gui journal | `resolveCanStart`：需 `overview.enabled` 且无既有会话 |
| 补充指令 | `POST /api/live/:id/input` → `beforeModelWave` 追加并 sync | `gui_input_queued` → `gui_inputs_consumed` | Session 新 user 消息 | `capabilities.submit` |
| 允许一次 | `POST /api/live/:id/decision` → 注入 Approver → DefaultPermissionGate | `approval_result` + 工具结果 | 审批 audit + Session tool message | `capabilities`/`approval` 存在且连接正常 |
| 拒绝 / 要求调整 | 同上（decision=deny + reason） | `approval_result(deny)`；理由进入工具结果 | 审批 audit + Session tool message | 理由必填（前端与后端双重校验） |
| 暂停 | `POST /api/live/:id/pause` → `beforeModelWave` 等待点 | `gui_status(pausing→paused)` | GUI journal 控制回执（进程内暂停，不伪装持久 Runtime 状态） | `capabilities.pause` 且 status=running |
| 继续 | `POST /api/live/:id/continue` | `gui_status(running)` | 同上 | `capabilities.continue` 且 paused/pausing |
| 急停 | `POST /api/live/:id/stop` → AbortSignal + `requestEmergencyStop` | `gui_status(stopping→interrupted)` | 急停 audit + Goal blocked + Session 工具回执 | `capabilities.stop`；终态不可用 |
| 恢复现场 | `POST /api/live/:id/resume` → `loadSessionLog` / `loadGoal` | 完整投影替换 | Session 顺序、composition、pendingTools 校验 | `capabilities.resume`（仅 host 判定 recoverable） |
| 提交人工验收 | `POST /api/live/:id/review` → `applyHumanReviewDecision` | `gui_review_recorded` → 重读权威事实 | human-review audit + Goal round/verdict | `evidenceToken` 版本绑定，过期返回 409 |
| 切换会话 | `GET /api/live/:id` + SSE | 完整投影替换 | 以任务 ID + 单调序号去重 | 有运行中任务时锁定 |
| 复制回复 / 搜索 / 收起 / 刻度定位 | 无（纯前端） | 无 | 无 | 始终可用；不触碰 Runtime |

断线时：`connection !== 'connected'` → `resolveGate` 关闭全部危险控制（暂停、继续、急停、恢复、审批、发送），保留阅读、草稿与滚动位置；重连必须先经 `GET /api/live/:id` 取回持久事实成功才恢复控制。模型 final、HTTP 200 与前端状态都不授予完成。

## 5. 状态 → 界面表达

| GuiRunStatus | 中栏页头 | 右栏活动阶段 | 完成授权 |
|---|---|---|---|
| idle / starting | 正在启动 | 状态阶段 | 未授予 |
| running / checking | 运行中 / 正在验证 | 状态阶段（下一步动作） | 未授予 |
| approval | 需要审批 | 审批阶段（唯一活动阶段） | 未授予 |
| pausing / paused | 正在暂停 / 已暂停 | 状态阶段 + 继续入口 | 未授予 |
| stopping / interrupted | 正在终止 / 已终止 | 状态阶段（只读） | 未授予 |
| blocked（待验收） | 已阻塞 | 人工验收阶段 | 未授予 |
| blocked（检查失败 / 时限） | 已阻塞 | 状态阶段 + 失败原因 | 未授予 |
| recoverable | 可恢复 | 状态阶段 + 恢复入口 | 未授予 |
| complete（未授权） | 完成待授权 | 状态阶段 | 未授予 |
| complete（verified） | 已完成 | 状态阶段 | 已授予 |
| unavailable | 现场不可用 | 状态阶段 + 读取失败警告 | 未授予 |

## 6. 确定性试件

`?fixture=<id>` 使用 `workbench/fixtures.ts` 的投影试件与 `workbench/fixture-store.ts` 的本地命令模拟，覆盖空态、运行、长对话、待审批、要求调整后、验证与人工验收、检查失败、阻塞、急停后、可恢复、连接中断、可信完成、现场不可用。试件全程标注「非真实运行」，不联网、不落盘、不消耗模型预算；其完成态只是 UI 表达，不构成任何验收结论。真实链路由 `scripts/gui-p3-browser-fixture.ts`（确定性 provider + 真实工具与持久化）与既有测试覆盖。试件代码独立 chunk（gzip 6.49 kB），不进入 live 主包。

## 7. 与 V13 的有意偏差（决定与理由）

1. **回复操作行只保留复制与时间**：V13 的分支、钩子在 Jarvis 没有对应命令，隐藏而非禁用，避免一排死按钮；记录在本页 §2。
2. **任务监控不浮动**：V13 用 fixed 悬浮卡（≥1500px 自动出现）。Jarvis 把它做成右栏内的折叠分组，避免遮挡审批与证据（P1 冻结合同要求审批入口持续可达）。
3. **右栏可收起，但有待处理审批或验收时强制保持打开**，且收起按钮给出理由；这是 P1「审批、Composer 和终止入口持续可达」的硬约束。
4. **圆角与阴影沿用 Jarvis DESIGN.md**（Composer 10px、卡片 8–9px），不搬 V13 的 15px/18px；灰白主题吸收的是 zinc 色阶、灰侧栏与黑灰白控件三态，不是全部几何。
5. **Diff 增删保留语义色**：V13 灰白主题把增删行中性化，是 `build-neutral-theme.mjs` 语义豁免正则未覆盖 `.add/.remove` 的副作用，不是设计决定；Jarvis DESIGN.md 要求颜色只表达状态，Diff 增删属于状态。
6. **定位刻度留白阈值取 36px**：V13 只说「足够留白」未给数值；按 Jarvis 1440（留白 46px）与 1280 expanded（留白 38px）实测取 36，1280 以下隐藏。
7. **滚动位置恢复**：重载后延时恢复一次，避开 assistant-ui Viewport 的挂载自动滚底；挂载 800ms 窗口内的程序滚动不写存档，否则会把「底部」覆盖成用户位置。

## 8. 本轮验证证据

- 截图：`docs/evidence/gui-workbench-v13/`（12 个试件 × 1440×900，另含 1280×800 expanded、1000×760 窄窗）。
- 列宽实测：1440×900 = 244 / 852 / 344；1280×800 expanded = 184 / 610 / 486（与 P1 冻结值一致）；1280 compact = 184 / 784 / 312；均无整页横向溢出。
- 真实链路回归（4331/4333 确定性 provider，真实 EventBus/Session/PermissionGate/Goal）：启动 → 流式消息 → 写入审批 → 拒绝带理由且理由进入下一轮模型输出 → 允许一次 → 产物与 Diff → 模型边界暂停 → 继续 → 检查 → 人工验收 → 完成授权已授予；急停 → 终态只读；杀进程 → 控制全禁用并提示 → 同 dataDir 重启 → 自动重连并从持久事实重建现场。
- 单测：`test/surfaces/gui/gui-workbench-controls.test.ts` 9 条，覆盖断线禁用、不放宽 Runtime 能力、终态只读、审批失效、启动合同、会话锁定、sticky/刻度几何。
- 包体：live 主包 gzip 159.54 → 169.65 kB（+10.1，新增工作台组件与图标）；试件独立 chunk 6.49 kB。
