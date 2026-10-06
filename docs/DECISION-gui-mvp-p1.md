# DECISION：GUI MVP P1 方向裁决收口

> 状态：`P1 CLOSED / DIRECTION SELECTED`
> 裁决日期：2026-09-02（Asia/Shanghai）
> 最终方向：`conversation-first-refined`
> 下一关：P2 React Spike 已 GO；P3 于 2026-09-06 获明确授权，见 [P3 合同](./PLAN-gui-mvp-p3-runtime.md)

## 1. 最终决定

Jarvis GUI MVP 采用 **Conversation First Refined** 作为唯一结构基线：左侧常驻 Session / History，中央保持最大的持续对话区，右侧常驻任务、审批与证据。

入口与证据：

- [选定原型](../prototypes/gui-mvp-reboot/conversation-first-refined/index.html)
- [设计说明](../prototypes/gui-mvp-reboot/conversation-first-refined/DESIGN-NOTE.md)
- [P1 浏览器验收](../prototypes/gui-mvp-reboot/ACCEPTANCE.md)
- [1440×900 compact](../prototypes/gui-mvp-reboot/conversation-first-refined/screenshots/final-1440x900.png)
- [1440×900 expanded](../prototypes/gui-mvp-reboot/conversation-first-refined/screenshots/final-1440x900-expanded.png)
- [1280×800 compact](../prototypes/gui-mvp-reboot/conversation-first-refined/screenshots/final-1280x800.png)

## 2. 裁决链

1. P0-P1 以同一模拟任务完成对话主导、任务主导、产物主导三稿及双视口验证。
2. Ludi 于 2026-09-01 选择对话主导，并在 Round 3 后继续偏好 Codex refined：完整、连贯，更符合成熟 AI 对话工作空间的心智模型。
3. ASCII 盲评把三家终选稿匿名为 A/B/C。网页版 ChatGPT gpt-5.6-sol Pro 的首轮架构评分为：A/ZCode `8.98`，B/Codex `8.72`，C/Kimi `8.50`。
4. 第二阶段加入唯一目标用户的真实选择证据。Pro 返回 `UPDATED VERDICT: Candidate B`，确认 Ludi 对会话历史、空间稳定性与完整产品壳的偏好会改变原盲评假设。
5. Ludi 接受更新后的 Candidate B 裁决，P1 方向选择关闭。

盲评材料与固定身份映射保留在：

- [盲评 Prompt](../prototypes/gui-mvp-reboot/ascii-benchmark/PRO-REVIEW-PROMPT.md)
- [盲评材料](../prototypes/gui-mvp-reboot/ascii-benchmark/PRO-REVIEW-PACKET-BLIND.md)
- [身份映射](../prototypes/gui-mvp-reboot/ascii-benchmark/PRO-REVIEW-IDENTITY-KEY.md)
- [Owner 信号复核 Prompt](../prototypes/gui-mvp-reboot/ascii-benchmark/PRO-OWNER-SIGNAL-FOLLOWUP.md)

说明：两次 Pro 回复由 Ludi 在当前任务中原样提供；仓库保存输入、映射与最终裁决摘要，未伪造可复跑的网页版执行记录。

## 3. 冻结的结构合同

> **2026-09-26 修订（Ludi 明确推翻「右栏常驻」）**：右栏不再是常驻信息栏，改为**按需打开的证据抽屉**（默认收起，点击工具、文件或 Diff 才打开）。审批与人工验收改为**对话区内的醒目决策卡**（固定在 Composer 上方，任何滚动位置都可见、可操作），不再放在右栏；「同一时刻只有一个活动阶段」约束改作用于对话区决策卡。左栏任务列表 + 中央对话为默认视图。顶部压成单行：工作区 + 任务标题 + 合并后的状态/完成授权 chip + 仅当前可用的运行按钮。工具流水默认折叠。以下其余条款继续有效。

- 左栏常驻：当前任务、最近会话、状态演示与 workspace / branch 信息。
- 中栏常驻且最大：消息、Reasoning 摘要、工具执行与 Composer。
- 右栏常驻：任务计划、人工审批、Diff、验证、上下文和未验证项。
- 右栏同一时刻只展开一个活动阶段：审批 → 验证 → 失败或完成；前一阶段压缩为可回看的回执。
- `要求调整` 后焦点直接进入 Composer，现场与草稿保留。
- 暂停、终止与恢复分别保存三栏滚动位置、活动页签、焦点和 Composer 草稿。
- `允许一次` 只推进一次写入模拟；完成授权继续显示未授予。
- 只有既有 `decideVerdict · verified（模拟）` 事实允许界面展示完成授权。

## 4. 允许移植的三项能力

1. ZCode / Candidate A：右栏在审批、验证、失败之间原位切换，减少阶段堆叠。
2. ZCode / Candidate A：`要求调整` 直接聚焦 Composer。
3. Kimi / Candidate C：暂停、终止和恢复时分别保存三栏滚动位置与焦点。

这些能力只补强选定壳层。全宽对话基态、动态决定翼和另一套永久侧栏不会进入核心结构。

## 5. P2 硬验收

- 1280×800 expanded 状态下，中央对话可读宽度不得低于当前原型的 `610px`。
- 右栏只允许一个活动阶段占据主要空间，审批、验证和失败不得同时展开争夺注意力。
- 页面无整体横向滚动；审批、Composer 和终止入口持续可达。
- 状态转换不会重建消息列表，也不会丢失三栏位置、焦点与草稿。
- 工具到证据保持一步联动：`apply_patch → Diff`、`vitest → 验证`、`read_file/rg → 上下文`。
- UI 无权授予权限或完成状态，未知状态显式降级。

## 6. 阶段边界

P1 的完成只证明方向已经选定。它没有完成 beta 验收，也没有批准 React 依赖、assistant-ui 生产采用、真实 Runtime 接线或桌面打包。

P2 的依赖判断、隔离方式、验收合同和停止条件见 [PLAN-gui-mvp-p2-react-spike.md](./PLAN-gui-mvp-p2-react-spike.md)；执行结果见 [`src/surfaces/gui/app/ACCEPTANCE.md`](../src/surfaces/gui/app/ACCEPTANCE.md)。

## 7. 取证时工作区

- 分支与提交：`main@c05c135`。
- 启动 P2 审查时只有 `prototypes/` 与 `.playwright-mcp/` 为未跟踪目录。
- `.playwright-mcp/` 与本轮交付无关，未读取、未修改、未暂存。
- 原型继续留在原目录；归档或移动需要 Ludi 另行授权。
