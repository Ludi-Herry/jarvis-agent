# 映射：V13 讨论区 → Jarvis GUI 工作台

> **2026-10-09 同步**：本文原写于 2026-09-26（批 1 时代），其中「多工作区/模型/并发/终端/子智能体/任务 meta 不存在」类判断已被批 2–8 推翻。本次按 `main@0ff149a`（批 8 入库）整体重写 §1–§4/§6/§8；§5、§7 的既定时代表达与有意偏差原样保留并修正过期项。能力现状以本页与总计划 `PLAN-gui-v13-restart-2026-10-05.md` 进度行为准。
>
> 用途：把 `H:\Ludi-design-studio\docs\prototypes\studio-annotation-branches-v13\` 的「讨论区」布局与交互，落到 Jarvis 现有 React + assistant-ui 前端上。本页只做映射与边界判定，不重写架构蓝图。
>
> 结论先行：V13 提供的是**布局与交互语言**，不是能力。Jarvis 提供的是**事实与命令**。凡是 V13 只有演示数据、而 Jarvis 没有真实事实或命令的地方，界面显示「未接入」、禁用或隐藏，绝不用前端状态伪装正在运行的能力。
>
> 主题：沿用 Jarvis `src/surfaces/gui/app/src/styles/tokens.css` 与 `DESIGN.md`（纯白工作面、近黑文字、1px 中性边界），吸收 V13 `v23-neutral-theme.css` 的灰侧栏 + zinc 黑灰白控件；不复制 V13 的大段 DOM/JS，不重新引入绿色主题。

## 1. 可复用（结构与交互，Jarvis 有真实事实支撑）

| V13 讨论区元素 | Jarvis 承载 | 真实事实来源 |
|---|---|---|
| 左栏：新建任务 | 空态创建面板（校验→创建→启动的同步锁） | `POST /api/live/task/validate · task · :id/start` |
| 左栏：搜索 | 对已有会话做本地过滤（title/objective/lastMessage/id） | `overview.sessions` |
| 左栏：工作区分组 | 工作区注册表分组（名称/排序/归档持久化） | `dataDir/gui/workspaces.json`（批 2 §C7） |
| 左栏：任务切换 | 选择会话即重取完整投影；多条运行中任务可自由查看 | `GET /api/live/:id` + SSE；并发上限另见 §4 注 |
| 左栏：任务重命名/置顶/归档 | gui_meta 追加进任务自己的 journal，重放折叠 | `POST /api/live/:id/meta`（批 2 §B4） |
| 中栏页头：文件夹图标 + 工作区 + 当前任务标题 | 同位置显示真实 cwd 与 objective/自定义标题 | `snapshot.cwd/objective/title` |
| 中栏：运行状态条（wb-vitals） | 在做什么/在等什么/下一步/预算四格，仅运行态显示 | `snapshot.phase/nextAction/elapsedMs/limits/usage`（批 5） |
| 中栏：连续消息流 | assistant-ui ExternalStore 渲染投影消息 | `snapshot.messages`（Session JSONL 投影） |
| 中栏：Markdown 消息 | 受限 Markdown（标题/列表/表格/代码块+复制/安全链接/引用） | `workbench/markdown-blocks.ts` 纯解析（批 4） |
| 中栏：工具执行摘要（可折叠执行记录） | 每条 assistant 消息下归组其 toolIds | `snapshot.tools`（status/args/output/path） |
| 中栏：最新回复操作行（复制/分支/时间） | 复制=纯前端；分支=真实 fork 入口；时间悬停显示 | `POST /api/live/task {forkFrom}`（批 2 §E13） |
| 中栏：顶部提问摘要（sticky prompt） | 整条提问完全滚出历史区顶部才出现，最多两行，点击回到原提问 | 消息几何 + `snapshot.messages` |
| 中栏：对话定位刻度 | 仅当窗口 ≥1200px、左侧留白足够、历史可滚动且已发生滚动 | 同上（纯显示） |
| 中栏：回到最新 | 浮在历史区内、输入框外，底部渐变 | 纯显示 |
| 中栏：空任务引导 | 真实任务合同、可启动性、工作区预设摘要与修改入口 | `overview.task` + `workspaces[].presets`（批 2/5） |
| 中栏：待补充内容 | 全文列表 + 逐条撤回/修改，已送达 409 如实拒绝 | `POST /api/live/:id/input-withdraw`（批 6） |
| 中栏：其他任务待处理提示 | overview 派生 approval 会话的切换条 | `overview.sessions[].status`（批 6） |
| Composer：权限 / 模型 / 运行位置信息行 | 模型只读显示；任务创建时从真实目录选择模型/思考档 | `GET /api/live/models`（批 2 §G18） |
| Composer：草稿与滚动位置恢复 | 沿用既有 localStorage 键 | 无（显示偏好） |
| 右栏：单一活动阶段（审批 → 验收 → 状态） | 原位切换，旧阶段压缩为回执 | `snapshot.approval` / `snapshot.review` / `status` |
| 右栏：待授权变更视图 | 审批卡内结构化「即将批准的变更」（含 write/edit/命令分块） | `approval.arguments` 纯解析（批 4） |
| 右栏：文件 / Diff / 产物 | 按文件分块的 Diff（计数/折叠/二进制标注）+ 产物清单 | `snapshot.diff/artifacts` + `splitDiffByFile`（批 7） |
| 右栏：成果打开 | 内联预览 + 大视图入口，图像/data-URI/截断诚实化 | `GET /api/live/:id/file`、`POST /api/live/:id/open-external`（批 4） |
| 右栏：「文件」页签 | 任务工作区只读懒加载树（敏感/git 元数据不列出） | `GET /api/live/:id/tree`（批 7） |
| 全宽阅读层（批 8，Owner 签收 V1） | 文件正文 + 关联 Diff 分块 380px 列，层内只读 | 同上投影；无任何审批动作 |
| 右栏：测试 / 验证 | 确定性检查命令与退出码 | `snapshot.checks` |
| 右栏：错误恢复 | 阻塞原因、警告、恢复入口 | `snapshot.warnings`、`capabilities.resume` |
| 右栏：上下文（Token / 成本 / 耗时 / 上限 / 来源） | 真实记录 + 成本/预算摘要卡 | `snapshot.usage/limits/sources`（批 6 摘要卡） |
| 右栏：审批历史 | 既有审计回执 | `snapshot.approvalHistory` |
| 右栏：Git 只读行 | 分支/未提交/领先落后/工作树模式；失败诚实显示 | `GET /api/live/:id/git`（批 2 §F16；批 4 修复 reject 卡「读取中」） |
| 右栏：子智能体页签 | 真实 task 工具委派（角色/任务/状态/结果），无则诚实空态 | `snapshot.tools` 派生（批 3 §B5–B7） |
| 右栏：预览页签 | 用户自开 iframe（loopback 直开、外站一行确认、失败诚实） | 本地视图状态（批 3 §C9–C13） |
| 右栏：终端页签 | 桌边命令：流式输出/历史/cancel/timeout 区分，denylist 拦截，`≤ 64 KiB` 截断 | `POST /api/live/:id/terminal（·/cancel）`；`GuiTerminalEntry.cause`（批 3/5） |
| 未接入空态表达方式 | 统一 `NotWired` 组件：中性文案 + 禁用样式 | — |

## 2. 仅演示（V13 有演示数据，Jarvis 无真实事实或命令）

| V13 元素 | 当前处理 | 理由 |
|---|---|---|
| 团队成员 / 协作设置 / Agent Team | 隐藏 | GUI 仍没有多 Agent 协作命令；子智能体委派已接（§1），不等于团队面板 |
| 模型上下文窗口用量占比 | 不显示占比；成本/预算摘要卡如实注明「累计 Token ≠ 上下文窗口占用」 | 投影未提供窗口占用事实；不伪造百分比（批 6） |
| Worktree / 分支选择 | 隐藏 | 无对应 Runtime 命令（条件项，按实际需求立项） |
| 设置齿轮（七类设置目录） | 保留入口，面板内说明未接入 | 配置由 CLI config / `.env` 管理，GUI 无写入命令 |
| 需求卡 / 方案分支 / 画布 / 注释工具 | 不移植 | 设计专用概念，不塞进编码任务 |
| 侧边聊天、后台进程、Skill 与 MCP 管理 | 隐藏 | 无真实事实；内核已有 SkillRegistry/Recall（批 4 评估），GUI 管理入口未立项 |
| 任务导出 | 隐藏 | 无对应命令 |
| 钩子记录面板 | 隐藏 | Runtime 有 hook 事件但无 GUI 面板立项 |
| 中途/队列级模型切换 | 不做 | 模型与思考档在任务创建时固定；变更需要明确真实合同（条件项） |

## 3. 缺口（当前不做，记录原因）

- **跨进程共同控制、终态复活**：P3 已明确单宿主单写者边界，不改。
- **真实 Reasoning 摘要**：Runtime 尚未提供，投影里保留既有警告文案，不生成模拟摘要。
- **首次使用引导组件 `live/first-task-guide.tsx`**：仍是 P3 真实任务未交付的空组件，保留原样与其接入位；空态引导属 GUI 基建，不计为 Jarvis 真实任务交付。
- **多 pane / 独立窗口 / worktree 同仓隔离并发 / GUI 设置写入 / 受控浏览器**：条件项，按实际需求另行立项（HANDOFF-gui-kimi-k3-max-2026-10-07 §「后续条件项」）。

## 4. GUI 动作 → Runtime 入口 → 返回事件 → 持久事实

沿用 [P3 合同](./PLAN-gui-mvp-p3-runtime.md) 的接线原则，批 2 后创建/启动走合同路径（替代旧固定 `/api/live/start`）。

| GUI 动作 | Runtime 入口 | 返回事件 | 持久事实 | 能力开关 |
|---|---|---|---|---|
| 校验任务合同 | `POST /api/live/task/validate` | 逐字段错误 + 三查（git/writePaths/命令 token） | 无（不落盘不耗模型） | 连接正常 |
| 创建任务（待启动） | `POST /api/live/task` | journal created | 任务合同冻结 | 同上 |
| 启动任务 | `POST /api/live/:id/start` → 基线 + composition + runGoal | `gui_task_started`、`gui_status(starting)` | 私有 git index 基线 + journal | 并发：异工作区 ≤2、同工作区 1，否则 409 |
| 保存工作区预设 | `POST /api/live/workspaces/:id/presets` | workspaces 回读 | `workspaces.json` additive presets | 仅用户显式点击（批 5） |
| 读取候选检查命令 | `GET /api/live/workspaces/:id/probe` | candidates + 来源 note | 无（只读） | — |
| 新建/重命名/置顶/归档任务 | `POST /api/live/workspaces`、`POST /api/live/:id/meta` | gui_meta | 任务 journal meta 事件 | meta 1–120 字 title |
| 讨论分支 | `POST /api/live/task {forkFrom}` | created + 启动时注入前情 | 新 journal，零审批/验收继承 | 父任务与轮次存在 |
| 补充指令 | `POST /api/live/:id/input` → `beforeModelWave` 追加并 sync | `gui_input_queued` → `gui_inputs_consumed`（含 texts） | Session 新 user 消息 | `capabilities.submit` |
| 撤回补充 | `POST /api/live/:id/input-withdraw {index}` | `gui_input_withdrawn` | journal 撤回事件 | 同上；已送达 409（批 6） |
| 允许一次 | `POST /api/live/:id/decision` → DefaultPermissionGate | `approval_result` + 工具结果 | 审批 audit + Session tool message | `capabilities`/`approval` 存在且连接正常 |
| 拒绝 / 要求调整 | 同上（decision=deny + reason） | `approval_result(deny)`；理由进入工具结果 | 同上 | 理由必填（双端校验） |
| 暂停 / 继续 / 急停 / 恢复 | `POST /api/live/:id/pause · continue · stop · resume` | `gui_status` 序列 + 急停 audit + Goal 状态 | journal + 权威 stores | 各 `capabilities.*`，终态/断线关闭 |
| 提交人工验收 | `POST /api/live/:id/review` → `applyHumanReviewDecision` | `gui_review_recorded` → 重读权威 | human-review audit + Goal verdict | evidenceToken 版本绑定，过期 409 |
| 查看文件/树 | `GET /api/live/:id/file`、`GET /api/live/:id/tree` | 文本/图片/截断/拒绝 | 无（不落盘） | safeResolve 边界合同（批 4/7） |
| 外部打开文件 | `POST /api/live/:id/open-external` | `{ok:true}` | 无；无 shell、detached | 同上（批 4） |
| 桌边终端 | `POST /api/live/:id/terminal（·/cancel）` | gui_terminal start/out/exit/cancel | journal per-task | denylist + 单命令 + 120s 超时（批 3/5） |
| 切换会话 | `GET /api/live/:id` + SSE | 完整投影替换 | 以任务 ID + 单调序号去重 | 任意时刻可查看；控制按所选任务分派 |

断线时：`connection !== 'connected'` → `resolveGate` 关闭全部危险控制（暂停、继续、急停、恢复、审批、发送、撤回），保留阅读、草稿与滚动位置；重连必须先经 `GET /api/live/:id` 取回持久事实成功才恢复控制。模型 final、HTTP 200 与前端状态都不授予完成。

## 5. 状态 → 界面表达

| GuiRunStatus | 中栏页头 | 右栏活动阶段 | 完成授权 |
|---|---|---|---|
| idle / starting | 正在启动 | 状态阶段 | 未授予 |
| running / checking | 运行中 / 正在验证 | 状态阶段（下一步动作） | 未授予 |
| approval | 需要审批 | 审批阶段（含待授权变更视图） | 未授予 |
| pausing / paused | 正在暂停 / 已暂停 | 状态阶段 + 继续入口 | 未授予 |
| stopping / interrupted | 正在终止 / 已终止 | 状态阶段（只读） | 未授予 |
| blocked（待验收） | 已阻塞 | 人工验收阶段 | 未授予 |
| blocked（检查失败 / 时限） | 已阻塞 | 状态阶段 + 失败原因 | 未授予 |
| recoverable | 可恢复 | 状态阶段 + 恢复入口 | 未授予 |
| complete（未授权） | 完成待授权 | 状态阶段 | 未授予 |
| complete（verified） | 已完成 | 状态阶段 | 已授予 |
| unavailable | 现场不可用 | 状态阶段 + 读取失败警告 | 未授予 |

## 6. 确定性试件

`?fixture=<id>` 使用 `workbench/fixtures.ts` 的投影试件与 `workbench/fixture-store.ts` 的本地命令模拟，当前试件：empty / running / markdown / long / approval / adjusted / edit / verification / failed / blocked / stopped / recoverable / disconnected / complete / unavailable / multi / concurrent / branch（18 个；2026-10-09 实测试件 chunk gz 11.1 kB）。试件全程标注「非真实运行」，不联网、不落盘、不消耗模型预算；其完成态只是 UI 表达，不构成任何验收结论。真实链路由 `scripts/gui-p3-browser-fixture.ts`（确定性 provider + 真实工具与持久化）与既有测试覆盖。试件代码独立 chunk，不进入 live 主包。

## 7. 与 V13 的有意偏差（决定与理由，2026-10-09 复核后摘编）

1. **回复操作行**：V13 三分支中「分支」已接真实 fork（批 2）；「钩子」无对应命令，隐藏而非禁用，避免死按钮。
2. **任务监控不浮动**：V13 用 fixed 悬浮卡（≥1500px 自动出现）。Jarvis 把它做成右栏内的折叠分组，避免遮挡审批与证据（P1 冻结合同要求审批入口持续可达）。
3. **右栏可收起，但有待处理审批或验收时强制保持打开**，且收起按钮给出理由；这是 P1「审批、Composer 和终止入口持续可达」的硬约束。
4. **圆角与阴影沿用 Jarvis DESIGN.md**（Composer 10px、卡片 8–9px），不搬 V13 的 15px/18px；灰白主题吸收的是 zinc 色阶、灰侧栏与黑灰白控件三态，不是全部几何。
5. **Diff 增删保留语义色**：V13 灰白主题把增删行中性化，是 `build-neutral-theme.mjs` 语义豁免正则未覆盖 `.add/.remove` 的副作用，不是设计决定；Jarvis DESIGN.md 要求颜色只表达状态，Diff 增删属于状态。
6. **定位刻度留白阈值取 36px**：V13 只说「足够留白」未给数值；按 Jarvis 1440（留白 46px）与 1280 expanded（留白 38px）实测取 36，1280 以下隐藏。
7. **滚动位置恢复**：重载后延时恢复一次，避开 assistant-ui Viewport 的挂载自动滚底；挂载 800ms 窗口内的程序滚动不写存档，否则会把「底部」覆盖成用户位置。

## 8. 验证证据（按批次索引，不再单页陈列数字）

- 结构与视觉：`docs/evidence/gui-workbench-v13/`（批 1 时代 12 试件×1440 与多视口）、`docs/evidence/gui-v13-repair-2026-10-07/`（修复回执与锚点测量）。
- 功能批：`docs/evidence/gui-v13-batch2/`（自由任务/工作区/分支/Git/模型）、`docs/evidence/gui-v13-batch3/`（并发/子智能体/预览/终端）。
- 阅读与流程批：`docs/evidence/gui-v13-batch4/`（Markdown/成果打开/待授权变更）、`docs/evidence/gui-v13-batch5/`（启动与错误恢复）、`docs/evidence/gui-v13-batch6/`（可控化）、`docs/evidence/gui-v13-batch7/`（只读工作空间）、`docs/evidence/gui-v13-batch8/`（全宽阅读层，Owner 签收 V1）。
- 样稿：`prototypes/gui-v13-artifact-wide/`（全宽成果大视图三方向，Owner 已选定 V1）。
- 真实任务验收：P3 旧任务 `gui-6a82e434…` 仍 NOT ACCEPTED，真人窗口由 Owner 安排（总计划进度行为准）。
