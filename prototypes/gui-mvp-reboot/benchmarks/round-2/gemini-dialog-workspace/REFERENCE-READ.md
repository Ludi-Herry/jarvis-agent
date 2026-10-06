# Round 2 参考阅读回执 · Gemini Dialog Workspace

> 参赛目录：`H:\jarvis-agent\prototypes\gui-mvp-reboot\benchmarks\round-2\gemini-dialog-workspace\`  
> 角色与变体：Gemini · Dialog Workspace (桌面对话工作区)

## 身份与访问

- Agent：`gemini`
- 时间：2026-09-01
- 参考访问：`browser-opened`
- 实际打开来源：
  1. OpenHanako: `https://raw.githubusercontent.com/liliMozi/openhanako/1d3ef308299e9f630786384e77de45444ea59196/.github/assets/screenshot-main.jpg`
  2. Tutti: `https://raw.githubusercontent.com/tutti-os/tutti/f330b71d2637c8bf0e4f11d16d7c4133099e7cb4/docs/assets/en/workspace-hero.jpg` & `control-center.png`
  3. Kun: `https://raw.githubusercontent.com/KunAgent/Kun/0802cfb9699a5077eb52fcd5f732ac7a86644cef/docs/assets/readme/code-mode-overview.webp`
  4. CodePilot: `https://raw.githubusercontent.com/op7418/CodePilot/aeb1e446fd2bc304a03f6b10baab6c669edc83d6/apps/site/public/screenshots/chat.svg`
- 无法打开的来源：`none`（全部通过 browser 成功打开并观察）

## 逐卡判断

| 参考卡 | 实际打开的来源 | 吸收 1 条 | 拒绝 1 条 | Jarvis 转译动作 |
|---|---|---|---|---|
| OpenHanako | `screenshot-main.jpg` | 对话作为主视觉中轴，Reasoning 与工具执行胶囊渐进折叠，右侧辅以轻量工作区 | 人格头像、二次元陪伴装饰、生活记忆、插件体系与自写 Skill 杂音 | 保持对话主干极简清晰，思考与工具胶囊内嵌折叠；右侧设专属 Context 面板呈现产物与状态 |
| Tutti | `workspace-hero.jpg` & `control-center.png` | 集中暴露人工注意力，将等待用户决策的审批门与任务上下文置于高可见度位置 | 多人房间、跨 Agent 编排市场与复杂云协作 OS 抽象 | 审批闸门设为专属高对比度决策卡片，提供明确的单次授权/拒绝/调整选项，不隐藏于深层日志 |
| Kun | `code-mode-overview.webp` | 桌面工作台（100vh 结构），对话流与代码变更/Diff 紧密并置，区分快照事实与 live 确认 | 终端多 Tab 嵌套、Agent 依赖图谱与庞大 IDE 全功能复刻 | 采用 100vh 紧凑桌面工作区布局，左中为对话+持久 Composer，右侧为 Diff 与验证链，零整页滚动 |
| CodePilot | `chat.svg` | 有限 canonical event 词汇，权限卡（PermissionPrompt）、产物卡与执行阶段有独立展示原语 | Provider 切换矩阵、Persona 设定、MCP 市场与调度器 | 明确区分对话消息、Reasoning 胶囊、权限审批卡与 Diff Artifact，不使用千篇一律的同形卡片 |
| Jarvis 不变量 | `PRODUCT.md` & `BRIEF.md` | 首屏同时回答目标、阶段、停下原因、人工动作、授权边界；保持单用户/本机/单任务纯粹性 | 任何非 Brief 规定的虚假 Runtime API、外部事实或未授权完成结论 | 顶部常驻任务元信息与状态条，右侧显式展示“完成授权未授予”，提供终止/恢复/暂停/继续权威按钮 |
| 两类反例 | `REFERENCE-PACKET.md` | 避免暗色控制台日志皮肤与无差别卡片堆叠；使用明确的版面分区、尺度对比与空间锚点 | 蓝紫霓虹、10px 细碎字符墙、瀑布流无限卡片、无截图自评 | 采用深炭灰（Charcoal Slate）搭配暖灰与琥珀/绿/红语义色的精修桌面工作台，字号≥12px，层级分明 |

## 本稿的独立主张

- **结构主张**：纯正的「100vh 桌面分屏对话工作区」架构。左侧/中央为「对话流 + 底部常驻 Composer」（占视口 ~62% 宽度），右侧为「任务控制中心 + 实时 Artifact/Diff 审查面板」（占视口 ~38% 宽度）。禁止整页纵向滚动，所有滚动局限在消息容器与右侧内容容器内部。
- **视觉主张**：以高端桌面应用为质感标杆，采用深暖炭灰（`#0d1117`、`#161b22`、`#21262d`）底色，结合高清晰度排版（正文 13~14px，代码 12.5px），通过精致微边框（1px `#30363d`）、状态胶囊和明确的焦点指示器建立冷静、可信、精确的设计语言。
- **交互主张**：
  1. **常驻 Composer**：固定在对话区底部，带有多行输入框、模式标识、提交与快捷操作按钮，纯内存模拟输入交互。
  2. **高可见度审批门**：置于右侧控制台顶部（首屏必见），提供「允许一次」、「拒绝」、「要求调整」一键模拟响应。
  3. **实时 Artifact/Diff 审查**：支持分文件查看 `presentation.js` 与 `gui-presentation.test.js`，带语法高亮与行号增删统计。
  4. **全生命周期控制**：暂停/继续、终止/恢复、完成/失败情景模拟切换，状态响应式联动。
- **与 Round 1 的预期差异**：Round 1 易陷入单列长页面瀑布流；本稿直接确立双栏桌面工作区格局，使对话、审批、产物与控制动作在首屏同时且持续可达。

## 首屏草图检查（1440×900 & 1280×800）

- 当前目标位置：顶部全局 Header 任务栏 + 右侧 Task Card 标题区（双重明确）
- 当前阶段位置：顶部阶段徽章（`阶段: 修正显示投影`）与状态指示器
- 停下原因位置：右侧待审批卡片醒目 Banner（`等待人工授权: workspace.write`）
- 用户动作位置：右侧审批动作区（允许一次 / 拒绝 / 要求调整）+ 顶部控制栏（暂停/继续/终止）
- 完成授权位置：右侧底部授权状态区持续显示 `完成授权未授予 (Pending Verification)`
- 对话主路径：中央主视区对话流，包含用户指令、Agent 回复、渐进折叠的思考摘要与工具执行链
- Artifact/Diff 进入路径：右侧 Artifact 检查器，直接展示 `+29 / −2` 改动及聚焦测试文件

## 事实保真

- 任务 ID：`GUI-RECOVER-17`
- 目标：`修复会话恢复后消息状态与最新 Diff 不同步`
- 用户消息：`恢复会话后，活动记录显示已完成，但 Artifact 仍停在旧 Diff。保持 API 与完成授权不变，做最小修复并补一条聚焦测试。`
- 阶段：`修正显示投影`
- 状态：`需要审批`
- 文件 1：`src/surfaces/gui/assets/presentation.js`
- 文件 2：`test/surfaces/gui/gui-presentation.test.js`
- 改动：`+29 / −2`
- 权限：`workspace.write`
- 完成：`decideVerdict · verified（模拟）`
- 约束：纯静态原型，无真实 Runtime，无网络请求，严格保真 Brief。
