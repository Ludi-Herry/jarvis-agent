# REFERENCE-READ · kimi · Round 3

## 身份与访问

- Agent：`kimi`
- 时间：2026-09-01
- 参考访问：`mixed`（3 家 Browser 直接打开截图，1 家 Browser 打开后仅见占位图）
- 来源实况：
  - OpenHanako `screenshot-main.jpg`：Browser 打开成功，完整可见（暖米色三列：左会话列表 / 中央对话+人格问候+底部 Composer / 右「书桌」面板+「笺」）。
  - Tutti `control-center.png`：Browser 打开成功，完整可见（右侧面板按 Needs attention → Running → Completed 分组；授权卡内含 mono 命令块与三行动作，动作带快捷键）。
  - Kun `code-mode-overview.webp`：Browser 页面加载成功但截图三次超时；改用本地下载后查看（亮色空态：左导航、右细工具条、中央大 Composer 卡 + 上下文 chip + 模型/Reasoning 选择器）。已在视觉回读后删除临时文件。
  - CodePilot 固定 commit 的 `chat.svg`：Browser 打开成功，但 SVG 本身只渲染 "PLACEHOLDER" 灰块，无界面内容；该卡的判断依据改为参考包文字（窄事件词汇、Permission Prompt 独立原语、未知事件显式降级）。

## 逐卡判断

| 参考卡 | 实际打开的来源 | 吸收 | 拒绝 | Jarvis 转译 |
|---|---|---|---|---|
| OpenHanako | 主界面截图（Browser） | 暖色低压迫纸面感；过程在对话流内渐进披露 | 人格头像、问候页、陪伴装饰 | 对话流内嵌可折叠「思路摘要」与工具台账，失败/待批语义直写 |
| Tutti | control-center.png（Browser） | 按「需要人处理」分组排队，动作带键盘路径 | 桌面 OS 隐喻、多 Agent 消息总线 | 审批钉在右栏顶部常驻，三动作平铺：允许一次 / 要求调整 / 拒绝 |
| Kun | code-mode-overview.webp（下载查看） | Composer 下方直接写清键盘契约（Enter 发送） | 空态大问候、Persona/模型选择器 | Composer  hint 行写契约；不放任何模型/Persona 控件 |
| CodePilot | chat.svg（Browser，仅占位图） | 状态词汇有限、未知项显式降级（据参考包文字） | Provider 矩阵、MCP/市场 | 全页状态词收敛为：完成/待审批/排队/已暂停/已终止/失败/未授予/verified |
| Jarvis 不变量 | PRODUCT.md / BRIEF.md | 首屏五问、证据诚实、单任务范围冻结 | 任何平台化扩张 | 顶带回答目标+阶段+谁能完成；静态原型标识常驻 |
| 两类反例 | 参考包文字 | 用尺度/对齐/固定操作区建层级 | 深色控制台、同形卡片墙 | 暖纸+墨+朱砂印章；审批、证据、对话用不同容器语言 |

## 本稿锚点

- **结构主锚点（Tutti）**：把「需要人处理」钉在最高层级 —— 审批卡常驻右栏顶部，不随证据区滚动。
- **交互辅锚点（OpenHanako）**：对话流内渐进披露 —— Reasoning 折叠块、工具台账行内嵌在消息流，证据从消息一句话跳到右栏页签。
- **明确拒绝**：① 人格头像/陪伴装饰/空态大问候（OpenHanako、Kun）；② 桌面 OS / 多 Agent 总线隐喻（Tutti）；③ 深色霓虹控制台与同形卡片墙（反例 A/B）。

## 选择如何服务 Jarvis

Ludi 的核心动作是「看懂 → 审批/纠偏 → 验收产物」。注意力队列保证审批永不失踪；流内披露保证对话可读；证据页签（Diff/上下文/验证）保证产物检查一步到位。
