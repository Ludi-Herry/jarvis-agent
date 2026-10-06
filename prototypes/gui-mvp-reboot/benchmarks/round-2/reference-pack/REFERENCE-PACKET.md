# Jarvis 对话主导 GUI · 精选参考包

> 版本：2026-09-01  
> 用途：所有 Round 2 参赛者共享的产品级参考。参考用于学习信息组织、状态表达和交互手法，禁止复制完整布局、品牌外观或范围外能力。

## 使用方法

1. 先读完六张参考卡，再填写 `READ-RECEIPT-TEMPLATE.md`。
2. 有 Browser 能力时打开每张卡的固定 commit 截图或源码；缺少 Browser 时在回执中标记 `packet-only`。
3. 每张卡必须写一条吸收点、一条拒绝点和一个 Jarvis 转译动作。
4. 编码前确定一个清晰的视觉主张。暗色、亮色、单栏、分栏都可用；选择必须服务当前任务和人工介入。
5. 所有外部能力均受 `PRODUCT.md` 与公共 Brief 约束。

## Card 1 · OpenHanako：低压对话与渐进披露

**看什么**

- 对话是稳定主轴；Thinking 与工具过程可折叠，完成后降低密度。
- 失败工具保留明确失败语义，资源与工作区从对话自然进入审阅。
- 右侧工作区组合文件、Todo、Activity 与 Session Status，同时不抢走对话焦点。

**固定证据**

- [主界面截图](https://raw.githubusercontent.com/liliMozi/openhanako/1d3ef308299e9f630786384e77de45444ea59196/.github/assets/screenshot-main.jpg)
- [ThinkingBlock](https://github.com/liliMozi/openhanako/blob/1d3ef308299e9f630786384e77de45444ea59196/desktop/src/react/components/chat/ThinkingBlock.tsx)
- [ToolGroupBlock](https://github.com/liliMozi/openhanako/blob/1d3ef308299e9f630786384e77de45444ea59196/desktop/src/react/components/chat/ToolGroupBlock.tsx)
- [RightWorkspacePanel](https://github.com/liliMozi/openhanako/blob/1d3ef308299e9f630786384e77de45444ea59196/desktop/src/react/components/right-workspace/RightWorkspacePanel.tsx)

**吸收**：轻压阅读、Reasoning/工具渐进披露、资源从消息进入审阅。  
**拒绝**：人格头像、陪伴装饰、生活记忆、插件、多 Agent 与自写 Skill。  
**Jarvis 转译**：用语气和层级建立温度；审批、失败与完成授权保持直接。

## Card 2 · Tutti：集中暴露人工注意力

**看什么**

- 同一工作区连接 context、files、running tasks 与 outputs。
- Control Center 把运行中的任务和等待用户处理的动作集中到一处。
- 用户决定拥有独立 gate；Agent 能 propose/revise，不能代替用户通过。

**固定证据**

- [共享工作区截图](https://raw.githubusercontent.com/tutti-os/tutti/f330b71d2637c8bf0e4f11d16d7c4133099e7cb4/docs/assets/en/workspace-hero.jpg)
- [Control Center 截图](https://raw.githubusercontent.com/tutti-os/tutti/f330b71d2637c8bf0e4f11d16d7c4133099e7cb4/docs/assets/en/control-center.png)
- [官方 README](https://github.com/tutti-os/tutti/blob/f330b71d2637c8bf0e4f11d16d7c4133099e7cb4/README.md)
- [Workspace workflow ownership](https://github.com/tutti-os/tutti/blob/f330b71d2637c8bf0e4f11d16d7c4133099e7cb4/docs/architecture/workspace-workflows.md)

**吸收**：需要用户处理的动作持续可见；任务、文件和产物共享上下文。  
**拒绝**：Agent OS、App Center、多人 Room、云协作和跨 Agent 编排。  
**Jarvis 转译**：只呈现一个本机任务的审批与证据，不扩展平台范围。

## Card 3 · Kun：共享 Runtime 上的桌面工作台

**看什么**

- GUI 与 TUI 连接同一 Runtime；renderer 负责展示与交互，不运行 agent loop。
- 对话、文件、终端、浏览器、Changes、计划和审批留在同一任务工作区。
- 线程事件带 sequence，可在断线后 replay；界面区分持久快照与 live 确认。

**固定证据**

- [Code 工作区截图](https://raw.githubusercontent.com/KunAgent/Kun/0802cfb9699a5077eb52fcd5f732ac7a86644cef/docs/assets/readme/code-mode-overview.webp)
- [官方 README](https://github.com/KunAgent/Kun/blob/0802cfb9699a5077eb52fcd5f732ac7a86644cef/README.en.md)
- [仓库边界](https://github.com/KunAgent/Kun/blob/0802cfb9699a5077eb52fcd5f732ac7a86644cef/AGENTS.md)
- [Runtime events](https://github.com/KunAgent/Kun/blob/0802cfb9699a5077eb52fcd5f732ac7a86644cef/kun/src/contracts/events.ts)

**吸收**：多类任务证据围绕一个工作区组织；恢复状态明确区分事实与投影。  
**拒绝**：Agent Graph、扩展平台、模型路由、多工作模式和完整桌面复刻。  
**Jarvis 转译**：对话占据主位，文件/Diff/计划作为紧密相邻的审阅面。

## Card 4 · CodePilot：窄事件词汇与失效可见

**看什么**

- 多 Runtime 事件适配为有限 canonical event，未知类型进入 `unknown_item`。
- Artifact、Reasoning、Permission Prompt 与 Run Checkpoint 使用独立展示原语。
- 允许、拒绝、超时和 human-only tool 有清楚区别；未知事件禁止静默丢弃。

**固定证据**

- [Chat 界面参考](https://raw.githubusercontent.com/op7418/CodePilot/aeb1e446fd2bc304a03f6b10baab6c669edc83d6/apps/site/public/screenshots/chat.svg)
- [Runtime contract](https://github.com/op7418/CodePilot/blob/aeb1e446fd2bc304a03f6b10baab6c669edc83d6/src/lib/runtime/contract.ts)
- [Event adapter](https://github.com/op7418/CodePilot/blob/aeb1e446fd2bc304a03f6b10baab6c669edc83d6/src/lib/runtime/event-adapter.ts)
- [Permission Prompt](https://github.com/op7418/CodePilot/blob/aeb1e446fd2bc304a03f6b10baab6c669edc83d6/src/components/chat/PermissionPrompt.tsx)

**吸收**：状态词汇有限、未知项显式降级、审批后果可读。  
**拒绝**：Provider 矩阵、MCP/Skill 市场、Persona、Bridge、Media Studio 和 Scheduler。  
**Jarvis 转译**：同一页面明确区分消息、Reasoning、工具、审批、检查和终局。

## Card 5 · Jarvis：不可让渡的产品不变量

**权威输入**

- [`PRODUCT.md`](../../../../../PRODUCT.md)
- [`BRIEF.md`](../../BRIEF.md)
- [`REFERENCE-REFRESH.md`](../../../REFERENCE-REFRESH.md)

**首屏必须回答**

1. 当前目标是什么；
2. 做到哪个阶段；
3. 为什么停下；
4. 用户现在能做什么；
5. 完成由谁授权。

**持续可达**：审批、暂停、继续、终止、恢复。  
**证据诚实**：持久化事实、显示投影、测试和未验证项各自有身份。  
**范围冻结**：单用户、本机、单任务；无云协作、插件市场、多 Agent、模型议会和自我改进。

## Card 6 · 两类反例

### 反例 A：通用深色开发者控制台

症状：近黑背景、紫/蓝霓虹、10px 单字宽标签、每项都装进同形卡片；换产品名仍成立。  
风险：界面像日志皮肤，Jarvis 的可信完成和人工接管缺少辨识度。  
修正：先定一个具体材料与排版主张；暗色可以保留，颜色、字体、层级和留白需要服务任务。

### 反例 B：无限卡片与自评验收

症状：消息、Reasoning、工具、审批、Diff、测试都使用相同圆角容器；`DESIGN-NOTE` 写“已验证”，没有真实截图或复现条件。  
风险：阅读优先级消失，自评替代了视觉证据。  
修正：用尺度、对齐、分隔和固定操作区建立层级；保存 v0 与 final 双视口截图，并记录从截图修正了什么。

## 自由项

- 配色、字体、明暗模式、侧栏数量、消息形态与 Diff 位置均可重新设计。
- 可以挑战常规聊天气泡，但对话必须保持主要阅读路径。
- 可以使用克制动效；动效只传达层级、状态、因果或反馈。
- 不需要汇总四家外部产品的所有特征。选择少数高价值手法，明确拒绝其余部分。
