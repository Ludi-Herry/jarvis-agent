# Jarvis 与 OpenHanako、Mirasim：GUI 与使用流程差距

日期：2026-10-07。性质：只读分析与建议，不构成新增功能或改变 V13 设计基线的实施授权。

## 判断

Jarvis 当前最大的差距是：**任务开始前需要懂太多内部规则，执行中缺少直观控制，交付后缺少方便查看和继续处理成果的工作空间。** 裁切、间距和对齐属于第一层问题；上一轮修复了这些问题，但完整的使用流程还没补齐。

相较 OpenHanako，差距集中在富内容、附件、产物预览、上下文管理和首次配置；相较 Mirasim，差距集中在文件/Git 工作空间、可管理的提示队列、多会话并排查看，以及浏览器与终端的深度整合。Jarvis 已有审批、暂停、恢复、补充指令、任务分支和完成证据链，不能把这些说成不存在。

**V13 讨论区的精准还原应继续作为视觉验收依据。** 竞品用于找出流程与能力缺口；是否改变页面结构，仍须另行裁决。像素还原、能力接通、真实任务成功，是三个分别验收的结果。

## 证据与比较范围

| 项目 | 本次依据 | 能证明什么 |
| --- | --- | --- |
| Jarvis | `main@8c52ce3` 加当前未提交的 10 月 7 日修复；实际前端源码、API 合同、批 2/3 回执、当天渲染截图 | 当前界面和接线方式；既有确定性运行检查。没有新增真实模型任务 |
| OpenHanako / HanaAgent | 官方仓库提交 [`85f59fd075f808d172f9c420070d40072527b2af`](https://github.com/liliMozi/openhanako/commit/85f59fd075f808d172f9c420070d40072527b2af)、官方截图、README | 源码中存在的界面和调用；不能替代安装版实机验收 |
| Mirasim | 当天读取的官方工作台、布局、队列、分支、模型、工具文档 | 官方描述的交互与能力；没有源码审计、安装版运行或质量对跑 |

Mirasim 官方工作台交互示意标注 `v0.0.142`，不视为最新安装版截图。其 Files/Git 页面直接抓取超时，细粒度编辑器行为不用于确定性结论。[官方工作台](https://mirasim.ai/docs/workbench)

本次没有三者在同一模型、同一任务、同一机器上的成功率或性能对跑，因此不评价谁的 Agent 一定更聪明、更快或更可靠。历史 OpenHanako 评估仅用于找到线索；当前判断以本次源码和文档为准。

## 1. 三者服务的工作不同

| 项目 | 主流程 | 对 Jarvis 的意义 |
| --- | --- | --- |
| Jarvis | 个人项目维护：确认任务边界 → 执行与审批 → 检查 → 人工验收与完成裁决 | 应先把这条单任务流程做得容易理解、容易接手 |
| HanaAgent | 个人助手：围绕会话、书桌文件和个人上下文工作 | 学习内容呈现与成果协作；人格、角色卡等不是编码维护的必需品 |
| Mirasim | 编码 Agent 工作台：围绕项目组织多个 CLI 会话及代码工作空间 | 学习文件与任务的关联、运行控制和隔离；包装多种 CLI 是另一条产品路线 |

HanaAgent 的个人助手定位、记忆及首次设置来自官方 README；Mirasim 的多 Agent 工作台定位来自官方说明。这是定位差异，不是质量排名。[HanaAgent README](https://github.com/liliMozi/openhanako/blob/85f59fd075f808d172f9c420070d40072527b2af/README_EN.md) · [Mirasim 工作台](https://mirasim.ai/docs/workbench)

## 2. 页面布局：我们缺的是工作对象和空间分配

### Jarvis 当前界面

![Jarvis 10 月 7 日实际空态](H:/jarvis-agent/docs/evidence/gui-v13-repair-2026-10-07/live-empty-1440x900.png)

左侧工作区/任务，中央对话，右侧按需打开证据。这个结构适合连续讨论，也符合已经选定的 V13 基线。当天修复后的左栏 244px、页头 54px、空态输入框 785px；这些锚点已接近原稿，不能据此宣布整页或所有状态 1:1 完成。[修复测量与限制](H:/jarvis-agent/docs/evidence/gui-v13-repair-2026-10-07/README.md)

### 对照结果

| 布局问题 | Jarvis 的实际情况 | 竞品提供的参考 | 对体验的影响与建议 |
| --- | --- | --- | --- |
| 中央区域承载什么 | 主要是消息与折叠工具记录 | Hana 把文本、文件、截图作为不同消息块；Mirasim 可把文件、终端与会话放在相邻 pane | Jarvis 用户能读过程，但查看成果要跳出当前流程。先补消息内成果入口，布局仍沿 V13 |
| 右栏的职责 | Diff、验证、上下文、子智能体、预览、终端六个页签共用 306/420px 抽屉 | Hana 有书桌与预览；Mirasim 也有单一右侧 dock，但文件和终端还可以进入舞台或独立窗口 | 六项不是越少越好，问题是宽度与对象不匹配。日志能看，网页和多文件 Diff 很难审阅；需要明确的展开阅读方式 |
| 任务与文件导航 | 工作区下有任务列表，没有工作区文件树 | Hana 的书桌提供文件工作区；Mirasim 提供文件与 Git 入口 | 用户知道“哪条任务”，却不容易找到“这条任务改的文件”。优先建立任务 → 改动文件 → 预览/定位的关联 |
| 同时看多项工作 | 后台能有两项运行，前台只显示一个对话 | Mirasim 文档支持分屏、布局 group，切换视图不停止会话 | Jarvis 的运行并发和视觉并发不是一回事。先明确其他任务是否等待处理，再考虑分屏 |

Hana 布局依据：[App.tsx](https://github.com/liliMozi/openhanako/blob/85f59fd075f808d172f9c420070d40072527b2af/desktop/src/react/App.tsx#L81) 与[官方截图](https://github.com/liliMozi/openhanako/blob/85f59fd075f808d172f9c420070d40072527b2af/.github/assets/screenshot-main.jpg)。Mirasim 的布局依据：[Panes, groups and windows](https://mirasim.ai/docs/layout)。Jarvis 的六页签依据：[detail-pane.tsx](H:/jarvis-agent/src/surfaces/gui/app/src/workbench/detail-pane.tsx:11)。

**建议保留左栏任务、中央对话、按需证据抽屉。** 先补内容和对象之间的联系。若要把抽屉改成全宽成果阅读、双 pane 或独立窗口，应先提供可审阅样稿并确认与 V13 的关系，不在复刻修复中顺手改结构。

## 3. 交互设计：哪里让用户付出不必要的理解成本

### 开始任务

Jarvis 空态的箭头长得像发送按钮，实际只执行 `setContractOpen(true)`。用户还要展开范围，理解写入路径、检查命令、轮数、每轮步数和时间预算，再选择校验/创建/启动。界面简洁了，操作成本仍集中在表单里。[create-task-panel.tsx](H:/jarvis-agent/src/surfaces/gui/app/src/workbench/create-task-panel.tsx:221)

Hana 的官方首次设置把模型连接放进向导；Mirasim 的首次会话围绕工作区、Agent、模型和提示组织。这些入口比填写内部运行参数更符合日常使用，但也分别增加多模型设置、账户和 CLI 安装成本。[Hana 首次设置](https://github.com/liliMozi/openhanako/blob/85f59fd075f808d172f9c420070d40072527b2af/README_EN.md#L61) · [Mirasim Quickstart](https://mirasim.ai/docs/quickstart)

建议把首次准备与每次提任务分开：工作区保存经用户确认的常用范围、检查和预算，任务创建时显示摘要与修改入口。可从项目只读发现候选命令，但不能让模型自己扩写入权限或改验收合同。箭头的可见含义与实际行为也要一致；这是流程修复，不是放松权限。

### 执行过程中纠偏

Jarvis 能接收补充，并告知在下一处理边界送达；也有暂停、继续、急停和恢复。缺口是待发送内容只显示数量，用户缺少明确的查看、撤回、修改和排序操作。任务级模型固定，也不能把一次中途选模型当成已支持。[conversation-pane.tsx](H:/jarvis-agent/src/surfaces/gui/app/src/workbench/conversation-pane.tsx) · [adapter](H:/jarvis-agent/src/surfaces/gui/app/src/adapter/jarvis-external-store.tsx)

Hana 的按钮按状态切换发送、插话、停止。Mirasim 则明确区分排队、途中纠偏、停止后运行新提示、撤回，并说明排队时保存模型配置。可学习的是**用户能理解一条补充何时生效，以及还能否收回**。[Hana SendButton](https://github.com/liliMozi/openhanako/blob/85f59fd075f808d172f9c420070d40072527b2af/desktop/src/react/components/input/SendButton.tsx#L13) · [Mirasim Queues and steering](https://mirasim.ai/docs/queue)

### 审批与结果验收

Jarvis 把审批固定在输入区上方，这是已有优点：不需要滚回历史寻找。当前“查看改动与证据”进入任务已有 Diff，待授权请求主要通过工具名、说明和折叠的原始参数表达。**它缺少独立、格式化的待授权变更视图**：哪些文件、改哪几段、运行什么命令、这一次批准具体覆盖什么。[ApprovalCard](H:/jarvis-agent/src/surfaces/gui/app/src/workbench/active-stage.tsx)

![Jarvis 待审批状态：确定性试件，非真实任务](H:/jarvis-agent/docs/evidence/gui-v13-repair-2026-10-07/approval-aligned-1280x800.png)

上图中任务已有 Diff 为空，审批的具体内容要展开参数查看。它说明已有产物视图与待授权操作视图的区别，不能单凭“有 Diff 页签”认为审批已经容易判断。

Hana 源码有会话内确认卡，支持不同授权范围；Mirasim 文档有 Needs you 与待决问题。Jarvis 已有的“允许一次”与绑定证据的人工验收应保留；重点是让用户先看到足以判断的内容。[Hana confirmation](https://github.com/liliMozi/openhanako/blob/85f59fd075f808d172f9c420070d40072527b2af/desktop/src/react/components/input/SessionConfirmationPrompt.tsx) · [Mirasim session 状态](https://mirasim.ai/docs/sessions)

### 阅读回复与交付成果

Jarvis 当前文本直接渲染为 `<p>{part.text}</p>`，没有 Markdown renderer；代码围栏、表格、标题、链接不会成为对应的可操作内容。产物清单主要显示路径和 outcome，没有文件预览入口。对一个需要阅读方案、代码、文档的 GUI，这比阴影或圆角差异影响更大。[message-item.tsx](H:/jarvis-agent/src/surfaces/gui/app/src/workbench/message-item.tsx:115) · [evidence.tsx](H:/jarvis-agent/src/surfaces/gui/app/src/workbench/evidence.tsx)

Hana 的消息块与预览器在当前源码中已经分别处理 Markdown、文件、截图，以及 HTML、代码、CSV、PDF 等成果。应先借鉴最小有用子集：Markdown、代码块复制、可打开的改动文件与截图；不用一次复制完整办公文档编辑器。[AssistantMessage](https://github.com/liliMozi/openhanako/blob/85f59fd075f808d172f9c420070d40072527b2af/desktop/src/react/components/chat/AssistantMessage.tsx#L242) · [PreviewRenderer](https://github.com/liliMozi/openhanako/blob/85f59fd075f808d172f9c420070d40072527b2af/desktop/src/react/components/preview/PreviewRenderer.tsx#L667)

### 运行状态与错误恢复

Jarvis 有真实状态标签、工具执行状态、错误 notice 和恢复能力判断，但用户仍需要翻工具和“上下文”才能理解过程。`rounds/turns`、`409`、完成授权、私有 Git index 等内部术语仍出现在普通流程中。建议常驻表达四件事：现在在做什么、是否等我处理、还剩什么预算、失败后哪个动作可用。技术回执留在详情，不删除证据。

当前还有两项具体问题值得登记：Git 查询 reject 后重设 `null`，界面继续显示“读取中”；批 3 回执明确终端超时与取消同显“已取消”。前者是源码定位、未做本次故障注入，后者是已有已知限制。它们会把失败原因藏成另一个状态。[GitRows](H:/jarvis-agent/src/surfaces/gui/app/src/workbench/evidence.tsx:14) · [批 3 已知边界](H:/jarvis-agent/docs/evidence/gui-v13-batch3/README.md)

## 4. 功能实现：哪些已有，哪些只是名字相似

| 能力 | Jarvis 当前状态 | 对照与差距 | 判断 |
| --- | --- | --- | --- |
| 工作区与会话 | 已接多工作区注册、搜索、重命名、置顶、归档 | 搜索过滤标题/目标/最近消息/ID，未形成完整历史全文检索与文件导航 | 有基础；优先补成果关联 |
| 模型与思考档 | 创建任务时从真实 provider 能力选择，配置少时只显示一个 | Hana 有输入栏控制与首次向导；Mirasim 把 Agent、model、reasoning 分开选择 | 任务级选择已有；GUI 配置与多 CLI 管理是另两项能力 |
| 富文本与附件 | 当前 live 消息为文本+工具，粘贴附件关闭 | Hana 有内容块/附件入口；Mirasim 文档支持拖入/粘贴文件 | 明显体验缺口，尤其是截图反馈 UI 问题 |
| 产物与文件 | 有产物路径、统一 Diff、验证输出 | Hana 有书桌/预览；Mirasim 有文件/Git 工作空间 | 看得到记录，不足以方便审阅和继续编辑 |
| 浏览器 | 用户输入地址的 iframe 预览，有地址策略和历史 | Mirasim 文档描述受控浏览器与 GUI 委派；Hana README 描述网页工具 | 预览不等于 Agent 浏览器；自动截图、检查页面与操作能力不能计为已完成 |
| 终端 | 用户桌边命令，输出留痕；Agent 另用已有工具通道 | Mirasim 文档支持真实 CLI TUI 和独立 shell pane；Hana README 描述持久终端 | 不是 PTY/TUI，不能把命令输出列表当完整交互终端 |
| 多任务并发 | 不同工作区最多 2；同工作区 1；运行中可切换 | Mirasim 文档有并排会话和 Git worktree 隔离 | 已有后台并发；同仓库隔离并发与多窗展示仍缺 |
| 子智能体 | 真实 task 工具接线，GUI 从记录派生角色、摘要、状态、结果；深度 1 | Hana 声明独立 Agent 与协作；Mirasim 是多个 CLI 会话的工作台 | 已有委派；缺子任务进入/后续沟通等管理流程，不等于缺完整团队平台 |
| 讨论分支 | 从回复建立新任务、来源链与必要前情，不继承审批/验收 | Mirasim 文档区分对话 fork、rerun 与 worktree | 对话分支已有；它不是代码分支、文件回滚或 worktree |
| Token 与成本 | 展示累计输入/输出、估算成本、耗时和执行上限 | Hana ContextRing 显示当前上下文占比并提供压缩动作 | 累计消费不等于当前上下文占用；不能用累计数伪造“窗口百分比” |
| Skills / 记忆 / 恢复 | CLI/core 已有 SkillRegistry、Recall、ContextManager、checkpoint/rewind；GUI 未提供统一管理 | Hana README 描述个人记忆与 Skills；Mirasim 文档有工具管理入口 | 属于核心能力的 GUI 暴露不足；不是全部从零实现，也不重开 propose_skill |
| 设置与交付分发 | GUI 设置明确未接入，配置仍在 CLI；当前是本地网页入口 | 两者都提供桌面安装与配置流程；Hana Windows 标 Beta | 首次准备与启动维护成本落后；不因此立刻引入桌面壳 |
| 完成判定 | 确定性检查、人工验收、证据版本绑定与可信裁决链已有 | 本次没有审计两者等价的完成合同 | 是 Jarvis 值得保留的工程资产；不能据此宣称实际任务成功率更高 |

Hana 输入与上下文的源码依据：[InputControlBar](https://github.com/liliMozi/openhanako/blob/85f59fd075f808d172f9c420070d40072527b2af/desktop/src/react/components/input/InputControlBar.tsx) · [ContextRing](https://github.com/liliMozi/openhanako/blob/85f59fd075f808d172f9c420070d40072527b2af/desktop/src/react/components/input/ContextRing.tsx)。Mirasim 模型、代码隔离与工具依据：[Models](https://mirasim.ai/docs/models) · [Branches and worktrees](https://mirasim.ai/docs/branches) · [Skills, MCP and tools](https://mirasim.ai/docs/skills-tools)。

Jarvis 接线依据：[live API](H:/jarvis-agent/src/surfaces/gui/app/src/live/api.ts)、[live-types](H:/jarvis-agent/src/surfaces/gui/live-types.ts)、[预览](H:/jarvis-agent/src/surfaces/gui/app/src/workbench/preview-pane.tsx)、[终端](H:/jarvis-agent/src/surfaces/gui/app/src/workbench/terminal-pane.tsx)、[批 3 架构与边界](H:/jarvis-agent/docs/PLAN-gui-v13-batch3-architecture.md)。核心能力路径：[Recall](H:/jarvis-agent/src/runtime/session/recall.ts)、[SkillRegistry](H:/jarvis-agent/src/capabilities/skills/skill-registry.ts)、[checkpoint/rewind](H:/jarvis-agent/src/runtime/checkpoint/rewind.ts)。

## 5. 产品成熟度：目前最需要补的证据

最新修复回执的 1,805 项测试和浏览器截图证明工程检查与特定状态渲染通过。批 3 的终端、并发等有真实工具的确定性检查，也不是纯静态假页面。但这些不能代替一个真人从提需求到接收成果的成功使用记录。

当前读取到的 P3 真实任务结果仍为 `NOT ACCEPTED`，没有完成授权；新总计划把真人监督验收窗口留给 Owner 安排。旧任务失败现场保留，不能改写成当前修复后仍会发生同样故障，也不能用试件成功冲掉原 verdict。[真实任务原始结果](H:/jarvis-agent/docs/evidence/gui-mvp-p3/real-task-result.json) · [当前总计划](H:/jarvis-agent/docs/PLAN-gui-v13-restart-2026-10-05.md)

所以，下一阶段需要验证的不是“入口又多了几个”，而是你能否在 GUI 内独立完成：选择项目、提出要求、理解授权、途中纠偏、看到文件/页面、验收成果、停止或恢复。使用真实任务安排仍遵守已定窗口与预算。

文档也有漂移：旧 `MAP-v13-to-jarvis-gui.md` 仍写多工作区、模型选择、终端等未接入，总计划的“缓做”段也保留了已在批 3 完成的项目。本次判断按最新代码和批次回执；这些文档需后续同步，避免下一会话重复建设。

## 6. 建议顺序与验收结果

以下是建议顺序，不是已批准待办；不会改变既有真人验收顺序、模型预算或冻结参考。

| 顺序 | 建议 | 用户应该能看到的结果 | 成本与边界 |
| --- | --- | --- | --- |
| 先做：基础阅读与判断 | Markdown/代码块、可打开的成果、待授权变更摘要 | 能读懂方案，能看到即将批准与最终交付的内容 | 前端为主；文件读取和预览仍需路径/内容安全边界 |
| 先做：单任务流程 | 校准发送含义，任务范围摘要与经确认的预设，具体错误恢复 | 新任务可顺利开始；每次停顿知道下一步 | 部分涉及合同来源；不允许自动扩大权限和改验收规则 |
| 验收：一次完整使用 | 按既定安排，由 Owner 完成真实任务窗口 | 提需求 → 审批 → 改动 → 检查 → 预览/审阅 → 验收有真实记录 | 有限模型预算和真人窗口；不在本次分析中启动 |
| 随后：已有能力更可控 | 待补充内容可见/撤回、其他任务待处理提示、成本预算摘要 | 中途改要求不会靠猜，切任务不会漏审批 | 明确送达边界；不能伪装强实时打断 |
| 随后：项目工作空间 | 文件树/文件定位、易读的多文件 Diff、成果大视图 | 审阅代码与页面不必反复找外部路径 | 先只读；涉及新空间布局先样稿签收，Git 写操作单独立项 |
| 以后按实际需求 | worktree、多 pane、GUI 模型配置、Skill/MCP 管理、受控浏览器 | 解决已出现的并行、配置或网页验收瓶颈 | 维护面与权限明显增加，不一批全部实现 |

最值得借 Hana 的是**内容与成果易读、易打开**；最值得借 Mirasim 的是**提示何时生效清楚、文件与运行过程互相可达**。保持自研核心与现有权限/验收合同，先把这些原则用在已批准的 V13 讨论区中。

多种 CLI、完整插件生态、人格、远程桥接和大型团队协作目前不能仅凭竞品具有就变成 Jarvis 的缺陷清单。Mirasim 文档也说明多窗增加 Diff 审阅负担，其独立浏览器 profile 不等于 sandbox；Hana 多面板与个人助手功能同样增加信息密度和维护面。这些取舍要随真实需求决定。[Mirasim 并行工作](https://mirasim.ai/docs/sessions) · [浏览器工具边界](https://mirasim.ai/docs/skills-tools)

## 本轮收尾

只新增本报告，作为比较证据保留。没有修改产品代码、历史 verdict、知识库或配置；没有安装依赖、启动真实模型、提交或推送；没有新建一次性脚本或备份，因此无一次性文件待清理。本轮两个只读子代理完成，未声称关闭；没有重复运行与本次文档分析无关的测试。
