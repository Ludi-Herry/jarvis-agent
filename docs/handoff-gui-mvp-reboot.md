# 交接：GUI MVP 重启开工（给新会话）

> 状态：APPROVED，2026-09-01。Ludi 已批准新的 GUI 产品方向、参考对象、前端选型与分阶段顺序。
>
> 当前阶段（2026-09-06）：Ludi 已明确授权 P3 真实 Runtime 接线与一个新真实任务，执行合同见 [PLAN-gui-mvp-p3-runtime.md](./PLAN-gui-mvp-p3-runtime.md)。本页 P0-P2 的历史阶段限制只约束各自阶段；本次授权覆盖旧的 P3 未授权表述，其他安全边界和旧实验冻结继续有效。
>
> 本轮结果：接线与工程门已完成，真实任务在写入审批前受大消息传输故障影响，已安全终止；P3 未验收。修复和未执行草稿已保留，不自动重跑、不进入 P4。
>
> 2026-09-02 收口：P0-P1 已完成，最终选择 `conversation-first-refined`。P2 React Spike 已按 scripts-disabled 依赖门完成并验收 GO；P2.1 按 Ludi 的明确反馈将视觉校准为纯白中性工具界面。裁决见 `docs/DECISION-gui-mvp-p1.md`，P2 合同与证据见 `docs/PLAN-gui-mvp-p2-react-spike.md` 和 `src/surfaces/gui/app/ACCEPTANCE.md`。
>
> 当前基线：决策时位于 `main`，HEAD 为 `804ca16 docs: freeze current product route`，工作区干净。新会话必须重新核对分支、HEAD 和 `git status`，不得把这里的快照当成实时状态。
>
> 权威关系：本文接管下一阶段 GUI 产品工作的入口。`docs/v03-gui-plan.md` 的 G1-G4 继续作为已完成工程证据，G5 与其未来路线停止生效。CLI-first v0.1 的 PRODUCT NO-GO 和历史失败继续保留，不会因 GUI 重启被改写为通过。

## 1. 新 MVP 要解决什么

Jarvis 下一阶段要验证一个明确问题：Ludi 能否在桌面工作区里发起一项真实编码任务，持续看懂 Agent 正在做什么，在必要时介入，并检查最终产物与证据。

新 GUI 是主要产品表面。CLI 与 TUI 继续保留，承担诊断、自动化、恢复与高级入口。Jarvis Runtime 继续掌握 Session、权限、工具、副作用、Goal 和完成授权。

最小闭环包含：

1. 创建或进入一个任务；
2. 查看消息、Reasoning 摘要、工具执行和当前状态；
3. 遇到高影响动作时审批、驳回或补充信息；
4. 查看产物、代码 Diff、测试与未验证项；
5. 暂停、继续、终止任务，并能恢复现场；
6. 只有既有可信验证链通过时，界面才显示完成。

成本不再承担产品通过或失败的门槛。界面继续显示 Token、耗时和调用成本，并保留单轮超时、可配置的执行上限与持续可达的急停。

旧 v0.1 真人任务验收、Recall A/B、G5 与 TUI 真人验收继续暂停。本阶段唯一必须由 Ludi 做出的人工判断是三份原型的方向选择；原型选择不构成 beta 验收。

## 2. MVP 范围

### 本阶段包含

- 单用户、本机、单任务主线；
- 对话与任务状态在同一工作区；
- 消息、Reasoning、工具执行、审批、完成或失败五类核心状态；
- 产物与 Diff 审阅；
- 暂停、继续、终止和恢复；
- 持久化事实与显示投影继续分开；
- Web 闭环验证通过后再进入桌面壳。

### 本阶段冻结

- 多 Agent 市场、插件市场和 Skill 市场；
- 模型议会、多模型聚合与自动路由扩张；
- 云同步、多人协作和跨设备状态；
- 自我改进、自动沉淀 Skill、Reminder 与工具目录延迟加载；
- 千节点 Workflow、通用调度平台和新的 verifier / route / scheduler 抽象；
- 陪伴人格、生活记忆和与编码任务无关的功能；
- 复刻或长期 fork 任何完整 Agent Desktop GUI。

这些能力只有出现已记录的真实增长信号，并由 Ludi 重新开闸后才进入计划。

## 3. 参考对象如何分工

| 参考对象 | 学习内容 | 当前边界 |
|---|---|---|
| OpenHanako | 伙伴感、拟物化、低压交互、批注与产物协作 | 不复制陪伴、人格、插件和大规模多 Agent 能力 |
| Tutti | 共享工作空间、任务状态、产物接力和待审批 Control Center | 不扩成 Agent OS，只取工作区、任务和审批 |
| KunAgent | TS + CLI + Electron GUI、Web 到桌面的整体结构 | 新会话先刷新官方源码与许可，知识库缺少独立实体页 |
| CodePilot | 统一事件类型、未知事件兜底、能力驱动界面和 SSE | 学运行合同与失效教训，不整仓 fork |
| DeepSeek Harness | Trajectory、会话审计、耗时与成本可观察性 | 只取观察表达，不引入 Cordis 插件体系 |
| Pi Agent、Cline、opencode、Prime Agent | 小核心、多表面、持久运行与断线恢复 | 作为架构校准，首轮视觉原型不展开 |

原型阶段的组合关系：OpenHanako 提供界面气质，Tutti 提供工作区组织，KunAgent 提供 Web 到桌面结构，CodePilot 提供状态映射，DSH 提供运行轨迹表达。

参考深度统一采用“学习产品级体验”：提取产品语义、布局方法、状态组织和交互手法，再按 Jarvis 目标重新组合；不做 1:1 复刻。

知识库入口：

- `H:\LLM本地知识库\AI与工具\Agent Harness 架构范式.md`
- `H:\LLM本地知识库\AI与工具\Agent CLI 与 GUI 解耦-ACP 与事件流.md`
- `H:\LLM本地知识库\UIUX设计\AI对话前端组件库选型.md`
- `H:\LLM本地知识库\UIUX设计\AI对话界面与交互模式.md`
- `H:\LLM本地知识库\采集\external\agent-harness-调研\agent-harness-Part5-开源实现对照.md`

## 4. 已批准的前端路线

正式 GUI 采用 React + assistant-ui，并通过一层具体的 Jarvis 事件转换接入自有 Runtime。assistant-ui 使用自有后端模式，优先评估 `ExternalStoreRuntime`；只有 Jarvis 的完整状态流合同成熟后，才评估 `AssistantTransport`。

责任分层：

```text
产品壳与工作区布局
        ↓
assistant-ui 对话原语 + Jarvis 自定义工具 / 审批 / 产物组件
        ↓
Jarvis 事件转换与命令接线
        ↓
现有 EventBus、Session、PermissionGate、Goal 与工具执行
        ↓
JSONL、工作区文件、验证证据与副作用审计
```

约束：

- Jarvis 继续拥有消息事实、会话、权限、工具状态、恢复和完成授权；
- 不接 Assistant Cloud，不把历史或用户数据交给新的托管服务；
- 不引入 Vercel AI SDK 作为第二套 Agent Runtime；
- AI Elements 可用于研究源码归项目的组件结构；
- Agent Elements 可用于研究 Bash、Edit、Search、Plan 与 Subagent 卡片；首版不同时安装第二套组件系统；
- OpenHanako、DSH、KunAgent 和 CodePilot 的 GUI 只做选择性源码学习；
- 视觉与信息架构由三份原型决定，组件库默认样式没有产品决定权。

官方资料：

- assistant-ui 自有后端：<https://www.assistant-ui.com/docs/runtimes/custom/overview>
- assistant-ui 架构：<https://www.assistant-ui.com/docs/architecture>
- AI Elements：<https://elements.ai-sdk.dev/>
- Agent Elements：<https://agent-elements.21st.dev/docs>

## 5. 现有 GUI 的复用边界

### 保留

- `src/surfaces/gui/gui-server.ts` 的 loopback Host 校验、防伪请求头和现有 API 行为；
- 现有状态、观测、人工裁决、审批历史和急停能力；
- `presentation.js` 中与产品语义一致的纯投影、刷新顺序和竞态处理，正式迁移时改成 TypeScript；
- GUI 服务端、安全、审批、急停、时间线和投影测试；
- G1-G4 的历史截图、机器可读验收和失败教训。

### 重新实现

- `assets/index.html` 的 Dashboard 信息架构；
- `assets/app.css` 的当前视觉层；
- `assets/app.js` 的大部分手写 DOM 渲染；
- 1.5 秒轮询驱动的主要交互模型。

旧前端继续作为行为证据和回归参照。新 Web 界面覆盖状态、裁决和急停前，旧 GUI 不退出。

## 6. 分阶段执行计划

### P0：参考刷新与输入包

目标：用当前官方源码和产品界面刷新 KunAgent、Tutti、CodePilot 与 OpenHanako 的有效参考，输出一页有界参考表。

要求：

- 每个对象只记录与本 MVP 直接相关的布局、任务状态、产物、审批和事件合同；
- 区分已实现事实、产品演示和推断；
- 记录版本、许可和快照日期；
- 找到足够支撑三种结构方向的证据后停止；
- 不把多 Agent、插件、路由或云协作带进原型范围。

### P1：三份静态 HTML 原型

新会话先交付三份结构明显不同的真实初稿：

1. **对话主导工作台**：中央对话，任务与产物放在侧栏；主要参考 OpenHanako + Tutti。
2. **任务主导工作台**：中央计划、进度和当前动作，对话作为持续输入区；主要参考 KunAgent + CodePilot。
3. **产物主导工作台**：中央 Artifact / Diff，侧边对话、运行轨迹与审批；主要参考 OpenHanako 批注 + CodePilot。

三稿使用相同的模拟任务和状态，差异必须来自版式结构、信息优先级和交互组织。换色、换字体或移动少量卡片不算独立方向。

原型要求：

- 放在新会话先定义清楚的临时原型目录；目录说明用途、命名和后续归档规则；
- 原生 HTML/CSS/JavaScript，可直接本地打开或由一个现有服务预览；
- 不安装依赖，不连接真实模型，不修改 Runtime；
- 每稿覆盖消息、Reasoning、工具执行、需要审批、完成或失败；
- 包含产物或 Diff、暂停、继续、终止和恢复入口；
- 在 1440×900 与 1280×800 下可用，窄窗口至少不丢失急停和审批；
- 使用统一 motion token，支持 `prefers-reduced-motion`；
- 按根 `AGENTS.md` 使用 `transitions-dev` 约束合适的状态过渡，避免为了展示而堆动效；
- 每稿提供截图、可访问的本地入口和 5 行以内的取舍说明；
- 三稿全部交付后停止，等待 Ludi 选择，禁止自行合并方向。

### P2：选定方向后的 React Spike

只有 Ludi 选定一稿后进入：

- 先按依赖两阶段流程审查 assistant-ui、React、构建工具与安装脚本；
- 单独取得安装阶段批准后再引入依赖；
- 只接五类核心状态和一个模拟事件源；
- 验证主题可重构、键盘与可访问性、状态映射和工具卡片扩展；
- 若 assistant-ui 要求 Jarvis 让出 Session、权限或持久化所有权，停止并汇报；
- Spike 通过后才接真实 Runtime。

### P3：真实 Web 闭环

2026-09-06 已授权，当前执行、真实任务及验收事实只维护在 [P3 短合同](./PLAN-gui-mvp-p3-runtime.md)。继续采用现有 React + assistant-ui 及精确依赖，不重复安装或选库。

- 复用现有 EventBus，不新建第二套事件总线；
- 建立窄事件流，至少覆盖消息增量、Reasoning、工具开始或更新或结束、审批请求或结果、运行状态、Artifact / Diff、错误与终局；
- 事件带稳定 ID、顺序号和未知类型兜底；
- GUI 命令继续经过现有权限和完成授权路径；
- 状态、裁决和急停与旧 GUI 达到行为等价后，再讨论旧前端归档；
- 以真实浏览器验证流式到达、断线、恢复和错误态。

### P4：桌面应用

Web 闭环经过真实任务验证后，再选择桌面壳。桌面层只负责窗口、文件选择、系统集成和更新；Agent Runtime 继续由 Jarvis 持有。Electron、Tauri 或其他方案在该阶段另行比较。

## 7. 当前阶段验收标准

本轮新会话的完成条件只覆盖 P0-P1：

- 参考刷新表完成，证据范围清楚；
- 三份结构不同的 HTML 原型均可运行；
- 三稿使用同一任务与状态，可直接比较；
- 每稿在两个目标视口完成截图验证；
- 五类核心状态、Artifact / Diff、审批和急停均可看到；
- 没有安装新依赖，没有修改 Runtime、权限、Goal、Session 或完成授权；
- 没有扩入冻结能力；
- 已向 Ludi 展示三稿并停在选择点。

这组条件成立后，状态写为 `PROTOTYPES READY / DIRECTION PENDING`。在 Ludi 选择前，不写“GUI MVP 已完成”或“桌面开发已开始”。

## 8. 停止条件

遇到以下任一情况立即停止并汇报：

- 候选项目许可、源码与知识库结论冲突；
- 参考学习开始要求引入其 Runtime、插件系统或多 Agent 平台；
- 三份原型收敛成同一骨架；
- 需要安装依赖、修改 `.env`、连接真实模型或改变安全边界；
- 需要删除旧 GUI、历史证据或失败记录；
- 方案要求新增 verifier、route 或 scheduler 抽象；
- 任何实现路径会让 GUI 自己决定权限或完成状态。

## 9. 新会话开工顺序

1. 读根 `AGENTS.md`、本页、`PRODUCT.md`、`docs/analysis-openhanako-increments.md`；
2. 核对 `git status`、当前分支和 HEAD，保留无关改动；
3. 只读检查 `package.json`、`src/surfaces/gui/` 与 `test/surfaces/gui/`；
4. 完成 P0 有界参考刷新；
5. 定义临时原型目录规则；
6. 实现并验证 P1 三稿；
7. 在 Codex 中展示三稿和对比结论；
8. 停止，等待 Ludi 选择方向。

## 10. 可直接复制给新会话的任务

```text
在 H:\jarvis-agent 开始 GUI MVP 重启的 P0-P1。先读 AGENTS.md、docs/handoff-gui-mvp-reboot.md、PRODUCT.md 和 docs/analysis-openhanako-increments.md，再核对 git 状态与当前源码。

目标：刷新 KunAgent、Tutti、CodePilot、OpenHanako 的当前一手参考，并制作三份结构明显不同的静态 HTML 原型：对话主导、任务主导、产物主导。三稿使用同一模拟任务，覆盖消息、Reasoning、工具执行、需要审批、完成或失败，以及 Artifact/Diff、暂停、继续、终止和恢复。

边界：不安装依赖，不连接真实模型，不改 Runtime、Session、权限、Goal、完成授权和现有 API；不 fork 完整 Agent GUI；不扩多 Agent、插件、模型路由、云协作或自我改进。先为临时原型目录写清结构、命名和归档规则。使用合适的 CSS motion token，并支持 reduced motion。

验收：三稿均可本地运行，在 1440×900 与 1280×800 截图验证；结构、信息优先级和交互组织形成实质差异。交付三个入口、截图与简短取舍说明后停下，等待 Ludi 选择。不要自行合并方向，不进入 React、assistant-ui、Runtime 接线或桌面打包。
```
