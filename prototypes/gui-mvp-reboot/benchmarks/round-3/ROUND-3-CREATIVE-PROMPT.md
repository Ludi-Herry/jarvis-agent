# Round 3 · Kimi/ZCode 创意开放 Prompt

> 使用前将 `<AGENT>` 替换为 `kimi` 或 `zcode`。身份入口文件已经完成替换，可直接粘贴。

```text
在 H:\jarvis-agent 参加 Jarvis-Agent「桌面对话工作区」最好页面探索。

你的身份是 <AGENT>。你的唯一可写目录是：
H:\jarvis-agent\prototypes\gui-mvp-reboot\benchmarks\round-3\<AGENT>\

Outcome:
独立设计一份有明确审美主张、可持续交互、可本地运行的 Jarvis 桌面对话工作区。产品硬门固定，空间结构与视觉语言由你判断。

Benefit:
Ludi 当前目标是拿到最好的页面。结果用于选择设计，不用于公平评测模型。请发挥你的信息架构、交互和审美能力，主动发现 Brief 没写出的高价值表达方式。

必须完整读取：
1. H:\jarvis-agent\AGENTS.md
2. H:\jarvis-agent\PRODUCT.md
3. H:\jarvis-agent\prototypes\gui-mvp-reboot\benchmarks\BRIEF.md
4. H:\jarvis-agent\prototypes\gui-mvp-reboot\benchmarks\round-2\reference-pack\REFERENCE-PACKET.md
5. H:\jarvis-agent\prototypes\gui-mvp-reboot\benchmarks\round-2\reference-pack\READ-RECEIPT-TEMPLATE.md
6. H:\jarvis-agent\prototypes\gui-mvp-reboot\benchmarks\round-3\README.md

独立性边界：
- 禁止读取 Codex、conversation-first、task-first、artifact-first、shared 和所有既有参赛截图。
- 禁止读取 benchmarks 下 Round 1、Round 2 的任何参赛页面和 Gemini 纠偏中间稿。
- 禁止读取 Round 3 其他参赛目录。
- 不读取其他 Agent 的 HTML、CSS、JavaScript、设计说明或截图。
- 最终只交一份页面成稿。

Stage 1 · 参考选择：
- 使用 Browser 实际打开 OpenHanako、Tutti、Kun、CodePilot 四家界面参考。
- 编码前创建 REFERENCE-READ.md。
- 从四家中自主选择：
  - 一个结构主锚点；
  - 一个交互辅锚点；
  - 至少两个明确拒绝的模式。
- 不需要融合所有参考。请说明选择如何服务 Jarvis。
- `packet-only` 不合格；来源无法打开时如实记录。

Stage 2 · 内部方向探索：
- 编码前创建 DIRECTION-NOTE.md。
- 用简短文字或 ASCII 草图提出 3 个结构性不同的桌面对话工作区构想。
- 三个构想至少在空间组织、Artifact 进入方式或人工介入方式中的一项形成实质差异。
- 依据产品目的选择其中一个实现，写清放弃另外两个的原因。
- 不需要实现三份页面。

Stage 3 · 共同产品硬门：
- 页面根元素添加 data-author="<AGENT>" 和 data-round="3"。
- 产品壳固定为 100vh。
- body 和 document 无页面级横向、纵向滚动；各区域可以内部滚动。
- 页面支持持续对话，含至少两条消息和持续可见的可输入 Composer。
- 当前目标、执行阶段、终止入口和完成授权持续可见。
- 待审批动作立即可达；Artifact/Diff 最多一步打开。
- 提供允许一次、拒绝、要求调整，以及暂停、继续、终止、恢复。
- 未完成状态显示“完成授权未授予”；完成状态显示“decideVerdict · verified（模拟）”。
- 1440×900、1280×800 无页面级溢出，Composer、审批和终止不丢失。
- 所有按钮只更新页面内存中的模拟状态。

Stage 4 · 结构与审美自由：
- 允许分屏、浮层、可变 pane、上下文抽屉、空间画布、聚焦模式、弹出审阅、分段工作区或你提出的其他结构。
- 对话必须承担持续交互，中央固定、侧边固定、可重排或空间化均可。
- Artifact 可以常驻、按需展开、与消息联动或进入独立审阅状态。
- 配色、明暗、字体、材质、消息形态、侧栏方向、动效与密度由你决定。
- 暗色、卡片和单栏局部结构均可使用；需要形成清晰主张，避免统计默认值和无意义堆叠。
- 可以挑战常规聊天气泡和三栏 IDE，但不能退化为页面级任务报告或只读事件日志。
- 状态不能只依赖颜色；键盘焦点可见；支持 prefers-reduced-motion。

Stage 5 · 统一模拟事实：
- ID：GUI-RECOVER-17
- 目标：修复会话恢复后消息状态与最新 Diff 不同步
- 权限：workspace.write
- 改动：+29 / −2
- 文件：
  src/surfaces/gui/assets/presentation.js
  test/surfaces/gui/gui-presentation.test.js
- 工具：read_file 已完成、rg 已完成、apply_patch 待审批、vitest 排队
- 完成：decideVerdict · verified（模拟）

禁止增加真实 Runtime API、测试数字、Session 事实、成本数据或 Brief 中没有的成功结论。所有状态与证据标明模拟。

Stage 6 · 文件与技术边界：
允许交付：
- REFERENCE-READ.md
- DIRECTION-NOTE.md
- index.html
- DESIGN-NOTE.md
- 确有必要时增加 style.css、app.js
- screenshots/v0-1440x900.png
- screenshots/v0-1280x800.png
- screenshots/final-1440x900.png
- screenshots/final-1280x800.png

技术约束：
- 原生 HTML/CSS/JavaScript。
- 不安装依赖，不使用 React、CDN、远端字体或远端页面资源。
- 不调用 fetch、EventSource、WebSocket 或 Jarvis API。
- 不修改 Runtime、Session、权限、Goal、完成授权、旧 GUI 和仓库其他文件。
- 不删除、覆盖或移动旧稿，不执行 git commit/push/rebase。

Stage 7 · 视觉回路：
1. 实现所选方向的可运行 v0。
2. 生成 1440×900、1280×800 的 v0 截图。
3. 根据截图检查产品形态、视觉层级、信息容量、交互可达和原创性。
4. 至少指出 3 个具体问题。
5. 至少修正一项信息架构、空间分配或交互组织问题。
6. 生成 final 双视口截图并复验页面滚动、Composer、审批和终止。
7. DESIGN-NOTE.md 写清“方向选择 → v0 问题 → 修改 → final 证据 → 未解决限制”。

浏览器断言：
document.documentElement.scrollHeight <= window.innerHeight + 1
document.documentElement.scrollWidth <= window.innerWidth + 1

Browser 不可用时可以完成 v0 并记录卡点，禁止声称完成 final 或视觉验收。

Checks:
- 检查 HTML/JS 语法、无远端资源和网络调用。
- 检查 reduced-motion、焦点、关键交互、两档 viewport 和 console error。
- 不跑仓库全量测试或 CI。

Stop when:
同类失败达到 3 次、需要产品裁决、视觉参考无法完成、Browser 无法执行 final 验收，或遇到删除、安装、Git 历史等越界操作时停止并写明卡点。

Return:
完成后只汇报：
- 文件清单；
- 三个内部方向与最终选择；
- 参考主锚点、辅锚点和拒绝项；
- v0 到 final 的三项主要变化；
- 两档 viewport 的页面滚动断言；
- 实际交互检查与未验证项。

不要扩大范围，不要运行额外审查或 CI。
```
