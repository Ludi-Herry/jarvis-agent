# OpenHanako 增量裁决（2026-08-22，Ludi × Codex 讨论）

> 本文为讨论结论的原样存档（ZCode 代录，正文未改写），作为 `docs/v03-gui-plan.md` 竞品参考与验收补强的依据。
> 来源材料：[视频字幕](H:/LLM本地知识库/采集/clippings/bilibili/2026-08-20-如果这几天玩dsh累了，就来试试 HanaAgent 吧！.md) 与 [公开仓库](https://github.com/liliMozi/openhanako)（当前公开版本 `0.447.4`，release 准备提交停在 8 月 14 日）。

结论：不改变上一轮已经同意的基线。OpenHanako 带来两个真实的未来技术增量——「缓存稳定前缀下的动态提醒」和「工具目录按需加载」；另有两个 UX/验收增量——「带稳定身份的持续子代理」和「对产物直接批注」。它们暂时都不构成当前开发任务，当前仍应进入零成本验收、Recall A/B 和真实任务实证。

## 先拆清证据等级

视频发布于 8 月 19 日，公开仓库当前版本为 `0.447.4`，release 准备提交停在 8 月 14 日。因此资料需要分三层：

- 已由公开源码和测试确认：Reminder、工具目录延迟加载、Workflow、持续子代理、外置视觉。
- 创作者展示、公开源码缺少对应复现产物：1 万份问卷、约 1 亿 token、几十元成本等规模与成本结论。
- HanaAgent 1.0 预告：Markdown/图片/网页批注后由 Agent 批量修改。目前可当产品方向，成熟实现尚未得到公开仓库证明。

视频字幕与公开仓库可以互补使用，不能把演示口径直接升级为稳定能力。

## 真正的增量映射

| OpenHanako 信号 | Jarvis 当前状态 | 增量判断 | 当前裁决 |
|---|---|---|---|
| Reminder：冻结系统提示词和工具快照，同时追加环境变化、记忆事实、工具不可用提醒 | Jarvis 有 per-turn Skill addendum、composition hash 与漂移拒绝；活跃会话中的低权威环境变化没有专门通道 | **真实技术增量，中等价值** | 保留为 post-real-use 方向；当前不实现 |
| 工具目录延迟加载：先给名称/摘要，模型搜索、查看 schema 后再调用 | Jarvis 默认常见 REPL 约 6 个工具；MCP、插件市场继续 defer | **真实技术增量，当前收益很低** | 工具数量或 schema 成本明显增长后再开 |
| 持续子代理：稳定 `threadId`，每次任务另有 `taskId`，支持 reply/close/fork clone | Jarvis 子代理是一次性委派，能力和预算逐层收窄 | **未来编排增量** | 真实任务反复需要续派同一专家时再做 |
| Workflow 最多派出 1000 个节点、并发最高 64，带超时、预算、journal 与恢复 | Jarvis loop 面向可验收编码目标，worktree 并行限制 2–4 | **产品场景不同** | 不扩 scheduler；大批数据分析交脚本或外部工作流 |
| 外置视觉 + 坐标锚点 | 已进入 Jarvis `vision` 工具并完成真实模型验证 | **零新增** | 保持现状 |
| 嵌套 shell 命令树解析 | 已成为 Jarvis PermissionGate 的早期参考实现 | **零新增** | 保持现状 |
| 文档、图片、网页直接批注，Agent 批量处理 | Jarvis human review 当前以 requirement + note 为主 | **UX 增量，中等价值** | 加入 v0.3 体验雷达；先在真实任务中验证需求 |
| 人格、陪伴、生活记忆、广泛插件、自主安装/编写技能 | Jarvis 定位是可信编码 harness | **范围错位** | 不吸收 |

### 1. Reminder 是最值得保留的新模式

Hana 的实现将模型看不到的环境变化记录到 `EnvChangeLedger`，再通过隐藏于用户界面的 `[hana_reminder]` 块追加给模型。大段工具目录只交付一次；工具增加、移除、临时不可用时，仅广播短消息。代码还给 reminder receipt、消费游标和截断处理配了测试（`core/session-reminders.ts`）。

Jarvis 可以学它的责任边界：

- 工具 schema、权限、trusted requirements 等权威语义发生变化，继续执行会有安全风险，仍走 composition drift 和 fail-closed。
- 时间、当前工具不可用、刚写入的低权威记忆等观察事实，可以进入 additive reminder。
- Reminder 没有权限或完成授权，不能改变 `decideVerdict`。
- 若以后采用，可复用现有 per-request addendum 与 Session v2 receipt，无需再造事件总线。

当前 Jarvis 的工具和环境在一次进程内基本静态，Reminder 暂时解决不了高频真实痛点，因此只记录重开条件。

### 2. 工具目录延迟加载的安全细节值得抄作业

OpenHanako 在可延迟工具超过 10 个时，移除完整 schema，只保留三个桥接工具：搜索、查看说明、调用。目录按上下文窗口给预算，完整列表最多占 5%，上限 2 万 token；权限最终绑定真实目标工具，给通用 `mcp_call` 授权也无法绕过（`core/tool-catalog.ts`、`tests/engine-tool-defer.test.ts`）。

Jarvis 当前默认工具主要是 `read/write/grep/bash/history_search/history_turn`，再按条件加入 vision 或 delegate。完整 schema 数量还没形成成本和注意力问题；项目又明确 hold MCP 与插件市场。现在实现会增加搜索失败、schema 漂移、resume 兼容和权限审计成本。

重开条件应来自真实数据：

- model-visible 工具数持续增长；
- schema 开销在输入中占比明显；
- 模型开始频繁选错工具或忽略相关工具；
- 本地知识库、GitHub 等 connector 获得稳定重复需求。

届时优先复制 Hana 的「真实目标权限绑定」和「catalog fingerprint + 变化广播」，不要复制它的庞大插件面。

### 3. 持续子代理提供了一个更成熟的身份模型

Hana 将持续协作实例标为 `threadId`，每次追加任务生成新的 `taskId`；`subagent_reply` 串行化同一实例的任务，`subagent_close` 显式关闭，fork 后克隆独立线程（`lib/tools/subagent-tool.ts`）。

如果 Jarvis 将来出现「同一个 Reviewer/研究员需要跨多轮续派」的真实场景，这个模型比用展示名称猜复用对象更可靠。必须同时保留：

- 子权限不能超过父权限；
- 明确的 open/close 生命周期；
- fork 后身份隔离；
- 子代理结果仍没有完成授权；
- UI 必须按每次任务事件渲染，不能拿实例的最新消息覆盖所有任务卡片。

最后一条已经在 Hana 的开放 issue 中出现真实反例：多个任务卡片错误复用同一条最新消息预览（Issue #2467）。

### 4. 协作批注值得进入 v0.3 UX 雷达

视频里「在同一文档上批注，Agent 一次读完后批量修改」直接补强了上一轮已经确认的设计任务验收方式。以后 `visual_verdict + evidence` 可以进一步写成：

- `artifact_ref`：具体文件、页面或截图；
- `anchor`：行号、元素、坐标或选区；
- `annotation`：明确修改意见；
- `resolution`：accepted / rejected / superseded；
- `reviewer` 与时间。

当前可以在真实任务验收表中手工记录。只有反复出现「聊天式反馈定位不准、来回纠正成本高」，再考虑 v0.3 的批注面板；无需提前开发 Markdown 编辑器。

## OpenHanako 的问题给 Jarvis 带来的反向补强

这些都是开放 issue 中的用户报告，尚不能当成上游确认根因，但非常适合转成 Jarvis 的失效测试：

- Issue #2473：报告 1058 条消息的九天会话被截断到最后三条。它强化了 Jarvis R0.5 的 append-only、seq、receipt 和零原地重写路线。
- Issue #2468：缺失 `finish_reason` 触发四次重试并留下四份回复。Jarvis 当前 unknown/missing finish reason 会 halt；值得补一条「已经收到正文但终止状态异常，也不能自动复制回复」的故障注入验收。
- Issue #2466：Windows exec 偶发超时、没有部分输出，重跑又正常。它验证了 deadline、进程树回收、进度落盘和 resume 需要成套存在。
- Issue #2472：长 thinking 后正文未显示。v0.3 GUI 应分别核对持久化事实与显示投影，不能用「界面没显示」推导「模型没生成」。

建议在既定零成本验收中追加两项，不改产品功能：

1. 长 Session 连续追加、重启、resume、fork、archive、rewind 后，检查源文件长度、seq 和历史内容没有倒退或消失。
2. 构造 missing/unknown `finish_reason` 与流中断，检查只留下一个失败终态、零重复回复、零 orphan side effect。

## 最终裁决

- **P0/P1：没有新增开发项。**
- **P2 验收补强**：追加 Session 单调持久性和异常流零重复两项故障注入；设计任务证据升级为产物级锚点批注。
- **post-real-use 候选**：Reminder、工具目录延迟加载、持续子代理线程。
- **继续排除**：千节点 Workflow、通用插件系统、自动学 Skill、个人陪伴记忆、基于「关系」的安全哲学。

三者的分工现在更清楚：DSH 提供可替换运行时与编排实验，Hana 提供上下文/工具扩张和个人工作面的产品实验，Jarvis 继续守住可信完成、权限和可恢复性。当前计划无需转向；这轮资料让真实验收矩阵更完整，也给未来扩张留下了更精确的触发条件。

本次只读核查未修改文件。公开仓库有 732 个测试文件，但当前提交没有公开 combined status 或关联 workflow run；没有安装依赖或本机运行 Hana，因此运行稳定性结论仍以源码、测试代码和开放 issue 为边界。
