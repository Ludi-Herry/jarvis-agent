# GUI 重启总计划：V13 黑白灰精准还原与功能补齐（2026-10-05）

> **进度**：批 0 ✅ 收口（`1375374`/`7e18aa0`）；批 1 ✅（`cde7a15`，证据 `docs/evidence/gui-v13-batch1/`）；批 2 ✅（`c367f27`/`2502804`/`0f9dc8a`，证据 `docs/evidence/gui-v13-batch2/`）；批 3 ✅ 并发/子智能体/预览/终端（合同 `PLAN-gui-v13-batch3-architecture.md`，证据 `docs/evidence/gui-v13-batch3/`，全量 1803 绿）。均**待 Owner 视觉签收**。后续：P3 真实任务真人验收窗口（Owner 安排）；批 1/2/3 开放裁点见各证据包 README。

> Owner 立项（2026-10-05）：重启 Jarvis GUI 设计与开发，最终目标**精准还原 H:\Ludi-design-studio 内 V13 样稿（黑白灰色系，不要绿色系）**，并补齐样稿有设计、Jarvis 没有的功能。
>
> Owner 当轮拍板：① 按 批 0 → 批 1 → 批 2 顺序执行；② 9 月未提交工作树**提交为保护基线**（推翻此前 HANDOFF 的「不提交」纪律）；③ 首批功能子集：**自由任务、工作区、讨论分支、Git 状态、模型选择**；团队/子智能体、内置浏览器、终端、Skill/MCP 缓做；④ P3 真实任务真人监督窗口**最后安排**。
>
> 上游合同：`PLAN-V13-discussion-true-parity-2026-09-26.md`（真 1:1 总规划，52–98 人周；本总计划是它的**分批实施序列**，不改其边界）、`HANDOFF-gui-workbench-v13.md`、`MAP-v13-to-jarvis-gui.md`、`DECISION-gui-mvp-p1.md` §3 修订。
> 对比调研：`H:\Ludi-design-studio\docs\ANALYSIS-三项目架构测试与AgentSDK对比-2026-10-05.md`（结论：保持自研 loop，不引 Agent SDK；借事件 union/SSE 纪律、typed event 投影、harness 边界静态检查、回执留证形态）。

## 批 0：收口与保护基线（本批）

| 工作 | 验收 |
| --- | --- |
| B0-1 全量门复跑 | 安静环境 `typecheck + lint + npm test` 全绿；HANDOFF-gui-workbench-v13 §5.1 的验收页新鲜度竞争修复闭环（不出现该失败）。不跑 build emit（`dist/` 误覆盖裁决保持有效）。 |
| B0-2 保护基线提交 | 工作树现状原样入库（`.playwright-mcp/` 工具产物除外）；commit message 注明是 9 月 GUI 工作的保护基线。 |
| B0-3 冻结 V13 样稿源 | `docs/v13-source-manifest.json`：样稿目录 45 文件逐文件 SHA-256 + 字节数。后续任何视觉对照以该清单为准；样稿变更须先更新清单并记录差异原因。 |
| B0-4 本计划落盘 | 本文件；`README.md` / `docs/handoff-next.md` 的「当前下一步」改指向本文件。 |

退出条件：全量门绿、基线入库、清单落盘。批 0 不写产品代码。

## 批 1：黑白灰视觉精准贴合

| 工作 | 验收 |
| --- | --- |
| B1-1 控件与状态清点 | 按冻结清单逐控件建对照表：V13 讨论区可见控件 → Jarvis workbench 对应实现 → 差异（缺失/尺寸/状态）。来源是样稿实际计算样式与 `v23-neutral-theme.css`（唯一色源），不手算颜色映射。 |
| B1-2 色板与几何对齐 | workbench/tokens 全量对齐 v23 authoritative `:root`（zinc 阶梯；语义色保留 Jarvis 自有定义，对齐 V13 保留值族）；几何对齐 HANDOFF 第一批的组件规格（消息列 730/760、输入框 52/168、页脚 25×25、顶部摘要、刻度等已验证值不回归）。 |
| B1-3 冻结状态样例 | 空态、运行中、待审批、待验收、完成、断线、长历史、窄屏、证据抽屉展开：1440×900 / 1280×800 / 1000×760 三视口截图对照，1280×800 证据展开时中栏 ≥610px、无整页横向溢出；键盘焦点、reduced-motion 标注。 |
| B1-4 验收留证 | 回执式证据包（`docs/evidence/gui-v13-batch1/`，截图 + 对照表 + 未决差异清单）交 Owner 视觉签收。 |

不做：新功能、真实数据接入（属批 2）、设计画布（永不混入）。

## 批 2：功能补齐（首批五域，均接真实事实）

按 `PLAN-V13-discussion-true-parity` §4 B 桶取子集，前沿用其合同口径：

| 域 | 对应 B 桶 | 本批完成口径 |
| --- | --- | --- |
| 自由任务 | B1、B18 | GUI 内新建任务：用户输入 → 可审计任务合同（写入路径/检查命令/预算逐级确认）→ `POST /api/live/task`；启动前 dry-run 校验（路径存在、命令可执行、基线可捕获，不消耗模型）；取消与保留/清理分离（B19）。 |
| 工作区 | B3、B4、B15 | 持久工作区注册表（名称/排序/归档）；任务绑定工作区；会话元数据索引（重命名、置顶、归档、updatedAt/lastMessage 可复算）；左栏列表与搜索从索引出。 |
| 讨论分支 | B5 | 从指定回复创建新任务身份 + 来源链；复制必要上下文，不复用旧审批/Goal/完成授权/baseline；父子可单独恢复。 |
| Git 状态 | B6（只读部分） | 未提交/分支/ahead/behind/工作区模式来自独立只读查询，监控行可进详情；提交/推送/Worktree 操作**不做**（样稿标「未接入」，操作化另立项）。 |
| 模型选择 | B7 | 可用模型与 thinking 档位由真实 provider 能力生成；选择入任务合同、恢复时校验；任务级选择与默认值分开。重构 `withThinking('off')` 与宿主级 provider 缓存。 |

约束：不新增 verifier/route/scheduler 抽象；能力开关继续由 `workbench/controls.ts` 纯函数收敛；无真实来源的入口显式禁用且不计为完成；GUI 宿主拆单任务假设（TaskRegistry + 每任务运行上下文）时复用 runGoal/runAgent/EventBus/SessionStore/PermissionGate，不重写 Agent 核心。

## 缓做（需 Owner 另行立项）

团队/子智能体（B10）、内置浏览器、终端/后台进程（B12）、Skill/MCP（B11）、附件（B14）、设置七类全量（B16）、侧边对话驱动 Agent（B17 二等舱）、多任务并发（B2）、上下文用量（B8）、钩子记录（B9）、工作区文件浏览（B13）。P3 旧真实任务 `gui-6a82e434…` 的真人监督验收与本批次新真实任务验收均排在功能批之后，由 Owner 给运行窗口。

## 工程纪律

门禁沿用 typecheck/lint/test（全量）+ GUI 子包 build；每批结束后更新本文件进度、`HANDOFF-gui-workbench-v13.md` 顶部状态；真实模型调用逐批单独申请预算；提交前核对 `git diff --cached --stat` 只含本批文件。
