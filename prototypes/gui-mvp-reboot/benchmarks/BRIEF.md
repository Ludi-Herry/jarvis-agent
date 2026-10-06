# Jarvis 对话主导 GUI 独立比稿 Brief

## 目标

为 Jarvis-Agent 设计一份可直接本地运行的桌面静态 HTML 原型。对话是主要工作表面；任务进度、Reasoning 摘要、工具、审批和产物围绕对话组织。页面应让唯一用户 Ludi 在几秒内看懂：当前目标、执行阶段、停下原因、需要处理的动作和最终证据。

这是一次独立比稿。请从产品目标推导界面，不读取或模仿其他参赛页面。

## 产品性格

- 冷静、可信、精确，允许适量人文温度。
- 当前任务优先，风险、失败和未验证项直接表达。
- 系统负责整理复杂过程，用户负责审批、纠偏与产物验收。
- 对话负责表达和澄清；Artifact、Diff、测试与未验证项承担最终检查。

## 统一模拟任务

- ID：`GUI-RECOVER-17`
- 目标：`修复会话恢复后消息状态与最新 Diff 不同步`
- 用户消息：`恢复会话后，活动记录显示已完成，但 Artifact 仍停在旧 Diff。保持 API 与完成授权不变，做最小修复并补一条聚焦测试。`
- 当前阶段：`修正显示投影`
- 当前状态：`需要审批`
- 审批：一次性 `workspace.write`，写入 `presentation.js` 与 `gui-presentation.test.js`，影响 `+29 / −2`，可通过 Git 还原。
- 工具：`read_file` 已完成、`rg` 已完成、`apply_patch` 待审批、`vitest` 排队。
- Reasoning 摘要：核对 Session sequence；确认持久化事实完整；沿用 mutation barrier；审批后写入并运行聚焦测试。
- Artifact：两个修改文件与一段可读 Diff。
- 完成边界：只有聚焦测试和既有验证链通过，界面才显示 `decideVerdict · verified（模拟）`。

## 必须可见

1. 至少三条消息，区分用户与 Jarvis。
2. 可折叠或渐进披露的 Reasoning 摘要。
3. 工具执行状态，覆盖完成、待审批和排队。
4. 待审批区域，提供允许一次、拒绝、要求调整。
5. Artifact/Diff、测试状态和未验证项。
6. 暂停、继续、终止和恢复入口。
7. 完成与失败演示；未完成状态持续显示“完成授权未授予”。
8. 明确的“静态原型 / 无 Runtime / 无真实写入”标识。

## 交互要求

- 页面内按钮只更新内存中的模拟状态。
- 验证暂停→继续、终止确认→恢复、审批三种决定、完成与失败切换。
- 键盘焦点可见；审批和终止在 1440×900 与 1280×800 持续可达。
- 使用统一 CSS motion token，并提供 `prefers-reduced-motion: reduce`。

## 视觉自由度

- 可以自由选择色彩、字体、密度、侧栏数量、消息形态和 Artifact 展示方式。
- 结构必须保持“对话主导”，换色或移动少量卡片无法满足比稿要求。
- 避免通用 SaaS 管理台、指标墙、无限卡片、人格头像、巨大阴影和装饰性动效。

## 技术与文件边界

- 原生 HTML/CSS/JavaScript；无 React、无构建、无依赖安装、无 CDN、无远端资源。
- 不调用 `fetch`、`EventSource`、`WebSocket` 或任何 Jarvis API。
- 不改 Runtime、Session、权限、Goal、完成授权、现有 GUI 或仓库其他文件。
- 只写分配给你的参赛目录。最多 4 个文件，总体优先保持简洁。
- 页面根元素添加 `data-author="kimi"` 或 `data-author="zcode"`，使用与你身份对应的值。

## 禁止读取的输入

- `prototypes/gui-mvp-reboot/conversation-first/`
- `prototypes/gui-mvp-reboot/task-first/`
- `prototypes/gui-mvp-reboot/artifact-first/`
- `prototypes/gui-mvp-reboot/shared/`
- `prototypes/gui-mvp-reboot/screenshots/`
- `prototypes/gui-mvp-reboot/benchmarks/screenshots/`
- 另一家参赛目录

## 交付与停止条件

- 输出 `index.html` 和 `DESIGN-NOTE.md`；需要时再增加 `style.css`、`app.js`。
- `DESIGN-NOTE.md` 用不超过 20 行说明核心结构、独特取舍、已做检查和已知限制。
- 行动预算：最多 20 次工具调用；不跑仓库全量测试或 CI。
- 同类失败达到 3 次、需要产品决策或遇到破坏性操作时停止，写明卡点。
- 完成后只返回文件清单与实际检查结果。不要扩大范围，不要跑不必要的审查和 CI，只处理已知问题，超出范围停下来报单。
