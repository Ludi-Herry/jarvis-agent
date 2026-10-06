# Round 3 严格形态纠偏 Prompt

> 本合同只用于 Gemini。Kimi、ZCode 使用 `ROUND-3-CREATIVE-PROMPT.md`。

```text
在 H:\jarvis-agent 参加 Jarvis-Agent「桌面对话工作区」Round 3 最终公平比稿。

你的身份是 <AGENT>。你的唯一可写目录是：
H:\jarvis-agent\prototypes\gui-mvp-reboot\benchmarks\round-3\<AGENT>\

Outcome:
独立制作一份可本地运行的桌面对话工作区静态原型。中央对话区负责持续交流；任务、审批和 Artifact 作为持续可见的上下文。页面固定在 viewport 内，禁止页面级单列瀑布流。

Benefit:
Ludi 将在相同输入和验收条件下比较 Kimi、ZCode、Gemini 的最终页面。你的价值来自独立的空间组织、视觉主张和交互判断。

必须按顺序完整读取：
1. H:\jarvis-agent\AGENTS.md
2. H:\jarvis-agent\PRODUCT.md
3. H:\jarvis-agent\prototypes\gui-mvp-reboot\benchmarks\BRIEF.md
4. H:\jarvis-agent\prototypes\gui-mvp-reboot\benchmarks\round-2\reference-pack\REFERENCE-PACKET.md
5. H:\jarvis-agent\prototypes\gui-mvp-reboot\benchmarks\round-2\reference-pack\READ-RECEIPT-TEMPLATE.md
6. H:\jarvis-agent\prototypes\gui-mvp-reboot\benchmarks\round-3\README.md

独立性边界：
- 禁止读取 conversation-first、task-first、artifact-first、shared 和所有既有参赛截图。
- 禁止读取 benchmarks 下 Round 1 的 kimi、zcode、gemini 页面。
- 禁止读取 Round 2 的任何参赛页面，包括 gemini-dialog-workspace。
- 禁止读取 Round 3 其他参赛目录。
- 不参考 Codex 页面，不读取其他 Agent 的 HTML、CSS、JavaScript、设计说明或截图。
- 只出一份完成稿，不生成多个视觉方向。

Stage 1 · 强制视觉参考：
- 使用 Browser 实际打开 REFERENCE-PACKET.md 中的 OpenHanako、Tutti、Kun、CodePilot 界面参考。
- `packet-only` 不合格。
- 编码前先在你的目录创建 REFERENCE-READ.md。
- 逐卡记录实际打开的页面/截图、观察到的空间关系、吸收点、拒绝点和 Jarvis 转译动作。
- 来源无法打开时如实记录；四家视觉参考未完成前禁止编码。

Stage 2 · 产品形态合同：
- 页面根元素添加 data-author="<AGENT>" 和 data-round="3"。
- 产品壳固定为 100vh。
- body 和 document 禁止页面级横向、纵向滚动。
- 消息、任务、Artifact 等可滚动内容放在各自 pane 内部。
- 至少存在两个持续可见的空间区域：
  1. 中央对话区，是最大区域，桌面宽度下占主要空间；
  2. 任务、审批或 Artifact 上下文区。
- 1280×800 时仍保留对话区和至少一个上下文区，禁止退化成单列 feed。
- 中央对话区底部必须有持续可见 Composer。
- Composer 包含可输入控件和明确的发送/补充指令动作；行为只更新内存模拟状态。
- 至少两条消息持续可见，区分用户和 Jarvis。
- Reasoning 与工具摘要可嵌入消息或邻近对话；完整 Diff 通过次级 pane、分屏、Tab 或局部面板展开。
- 禁止把消息、Reasoning、工具、审批、Diff、测试依次堆成页面级瀑布流。

Stage 3 · 首屏合同：
在 1440×900 和 1280×800 的初始状态中，必须同时看见：
1. 当前任务目标与阶段；
2. 至少两条消息；
3. 待审批摘要及可执行动作；
4. Artifact/Diff 摘要；
5. 持续可见 Composer；
6. 终止入口；
7. “完成授权未授予”。

浏览器确定性断言：
document.documentElement.scrollHeight <= window.innerHeight + 1
document.documentElement.scrollWidth <= window.innerWidth + 1

两档 viewport 都必须通过。各 pane 内部滚动不受此限制。

Stage 4 · 统一模拟任务：
- ID：GUI-RECOVER-17
- 目标：修复会话恢复后消息状态与最新 Diff 不同步
- 权限：workspace.write
- 改动：+29 / −2
- 文件：
  src/surfaces/gui/assets/presentation.js
  test/surfaces/gui/gui-presentation.test.js
- 工具：read_file 已完成、rg 已完成、apply_patch 待审批、vitest 排队
- 完成：decideVerdict · verified（模拟）

禁止自行增加真实 Runtime API、测试数字、Session 事实、成本数据或 Brief 中没有的成功结论。所有状态与证据明确标为模拟。

Stage 5 · 交互覆盖：
- 消息、Reasoning 摘要、工具执行、审批、Artifact/Diff、测试、未验证项、完成与失败。
- 审批提供允许一次、拒绝、要求调整。
- 运行控制提供暂停、继续、终止、恢复。
- 未完成状态持续显示“完成授权未授予”。
- 完成状态明确显示“decideVerdict · verified（模拟）”。
- 状态不能只依赖颜色；键盘焦点清楚。
- 使用统一 motion token，支持 prefers-reduced-motion。

Stage 6 · 视觉自由与反例：
- 配色、明暗模式、字体、侧栏方向、消息形态、动效风格和 Artifact 呈现由你决定。
- 打开页面时应立即让人感到这是一个可持续交互的桌面对话产品。
- 避免通用深色开发者控制台、紫蓝霓虹、10px 信息墙和所有内容同形卡片。
- 暗色可以使用，但必须通过材料、排版和空间关系形成独立辨识度；仅写理由无法替代视觉差异。
- 正文与主要交互文字建议不低于 12px。
- 禁止人格头像、陪伴装饰、插件、多 Agent、模型路由、云协作和自我改进。

Stage 7 · 文件与技术边界：
必须交付：
- REFERENCE-READ.md
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
- 所有按钮只更新页面内存中的模拟状态。
- 不修改 Runtime、Session、权限、Goal、完成授权、旧 GUI 和仓库其他文件。
- 不删除、覆盖或移动任何旧稿。
- 不执行 git commit、push、rebase 或历史改写。

Stage 8 · 强制视觉回路：
1. 完成可运行 v0。
2. 在 1440×900、1280×800 生成 v0 截图。
3. 根据截图检查：
   - 产品形态：是否为持续交互的桌面对话工作区；
   - 首屏合同：七类关键信息是否同时可见；
   - 空间层级：对话、审批、Artifact 是否有清晰主次；
   - 交互可达：Composer、审批、终止、恢复是否持续可达；
   - 原创性：移除 Jarvis 名称后是否仍有独立设计主张。
4. 至少指出三个具体问题。
5. 至少一个问题必须属于信息架构、空间分配或交互组织。
6. 完成一轮因果修正；只改配色、圆角、间距或文案无法完成本轮。
7. 生成 final 双视口截图并重新执行页面滚动断言。
8. DESIGN-NOTE.md 写清“v0 问题 → 修改 → final 证据 → 未解决限制”。

Browser 不可用时可以完成 v0 代码并记录卡点，但禁止声称完成 final 或视觉验收。

Checks:
- 检查 HTML/JS 语法。
- 检查无远端资源和网络调用。
- 检查 reduced-motion、可见焦点、两档 viewport、关键交互和 console error。
- 不跑仓库全量测试或 CI。

行动预算：最多 30 次工具调用。

Stop when:
同类失败达到 3 次、需要产品裁决、四家视觉参考无法完成、Browser 无法执行 final 验收，或遇到删除、安装、Git 历史等越界操作时停止并写明卡点。

Return:
完成后只汇报：
- 文件清单；
- 四个视觉参考的吸收/拒绝摘要；
- v0 到 final 的三项主要变化；
- 两档 viewport 的页面滚动断言；
- 实际执行的交互检查；
- 未验证项。

不要扩大范围，不要运行额外审查或 CI。
```
