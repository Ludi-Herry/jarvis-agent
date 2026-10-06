# Kimi / ZCode · ASCII 原型比稿通用 Prompt

> 使用前将 `<AGENT>` 替换为 `kimi` 或 `zcode`。两份入口已经完成替换，可直接粘贴。

```text
在 H:\jarvis-agent 参加 Jarvis-Agent 桌面对话 GUI 的 ASCII 信息架构比稿。

你的身份是 <AGENT>。唯一可写目录：
H:\jarvis-agent\prototypes\gui-mvp-reboot\ascii-benchmark\<AGENT>\

Outcome:
只使用 Markdown 与 ASCII，提出 3 个结构性不同的桌面对话 GUI 原型，从中选择一个，并补充 1280×800 适配。禁止写 HTML、CSS、JavaScript 或实现页面。

必须读取：
1. H:\jarvis-agent\AGENTS.md
2. H:\jarvis-agent\PRODUCT.md
3. H:\jarvis-agent\prototypes\gui-mvp-reboot\ascii-benchmark\ASCII-COMMON-BRIEF.md
4. H:\jarvis-agent\prototypes\gui-mvp-reboot\benchmarks\round-2\reference-pack\REFERENCE-PACKET.md

禁止读取：
- H:\jarvis-agent\prototypes\gui-mvp-reboot\ascii-benchmark\CODEX-ASCII-BASELINE.md
- conversation-first、conversation-first-refined、task-first、artifact-first、shared
- benchmarks 下所有参赛 HTML、CSS、JavaScript、截图和 DIRECTION-NOTE.md
- 另一家 ASCII 输出目录

文件边界：
- 只写自己的 ASCII 目录。
- 只允许 ASCII-OPTIONS.md 和 ASCII-DECISION.md。
- 不安装依赖，不启动 Browser，不运行测试，不修改现有文件，不执行 Git 操作。

ASCII-OPTIONS.md 要求：

1. 先写不超过 8 行的设计问题重述。
2. 输出 3 个结构性不同的 1440×900 ASCII 原型：A、B、C。
3. 每个原型使用独立 Markdown code block，建议约 120 列 × 38 行。
4. 三个原型至少在以下两项形成实质差异：
   - 会话/任务导航；
   - 对话主区位置与比例；
   - 审批进入方式；
   - Artifact/Diff 进入方式；
   - Composer 位置；
   - 任务状态与完成授权位置；
   - 固定区与滚动区划分。
5. 每个 ASCII 必须实际放入公共 Brief 的主要 UI 文案，禁止只写抽象占位词。
6. 使用标记：
   - `[F]` 固定区域；
   - `[↕]` 内部纵向滚动；
   - `[↔]` 内部横向滚动；
   - `[1 click]` 一步打开；
   - `[modal]` 模态；
   - `[state]` 状态变化。
7. 每个方向后写：
   - 主要阅读路径；
   - 为什么像 AI 对话产品；
   - 审批与完成授权如何持续可达；
   - 1280 风险；
   - 最值得保留和最可能失败的点。

三个 ASCII 都必须表达：
- 当前任务 ID、目标、阶段和完成授权；
- 至少 3 条消息；
- Reasoning 摘要；
- 4 个工具状态；
- workspace.write 审批和允许/拒绝/调整；
- Artifact/Diff、测试与未验证项；
- Composer；
- 暂停、继续、终止和恢复。

ASCII-DECISION.md 要求：

1. 用以下维度给 A/B/C 各打 0–10 分：
   - AI 对话感；
   - 目标与状态可读性；
   - 人工接管效率；
   - Artifact 审阅效率；
   - 空间扩展性；
   - 1280 适配；
   - 原创性。
2. 选择一个最终方向，说明拒绝另外两个的原因。
3. 为最终方向再画一张约 106 列 × 32 行的 1280×800 ASCII 适配。
4. 写出该方向的：
   - 区域尺寸比例；
   - 固定/滚动归属；
   - 首屏信息顺序；
   - 键盘焦点顺序；
   - 完成/失败/终止/恢复时哪些区域变化。
5. 最后列出 5 条如果进入 HTML 实现必须验证的断言。

判断原则：
- 系统承担复杂度，用户不手动拼日志。
- 对话负责表达与澄清，产物和验证负责最终检查。
- 完成授权、审批、暂停与终止始终清楚。
- 信息架构要有独立主张，避免换皮或默认三栏堆叠。
- 选择应服务 Jarvis，不追求参考产品功能总和。

行动预算：最多 12 次工具调用。

Stop when:
需要产品裁决、输入材料缺失、发现必须读取禁止路径，或遇到写代码、安装、删除、Git 操作时停止并说明。

Return:
只汇报两个文件路径、三个方向的一句话差异、最终选择和未解决问题。不要实现页面，不要扩大范围。
```
