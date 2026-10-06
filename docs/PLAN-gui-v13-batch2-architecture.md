# 批 2 架构合同：自由任务 / 工作区 / 讨论分支 / Git 只读 / 模型选择（2026-10-06）

> 上游：`PLAN-gui-v13-restart-2026-10-05.md`（批 2 域与完成口径）、`PLAN-V13-discussion-true-parity-2026-09-26.md` §4 B 桶。
> 本文件是批 2 实施的唯一设计依据；Owner 已批准批 2 范围与缓做清单。

## 设计裁决（主线程定，实施不得偏离）

### A. TaskRegistry 与并发上限
1. `GuiSessionHost.tasks`（Map）就是注册表本体，不新增 Registry 类。拆掉的只是「构造时固定单合同」假设。
2. **同一时刻只允许一个运行中任务**（多任务并发 B2 属缓做；start/resume 维持互斥 409，错误信息如实写「已有运行中的任务」）。创建、查看、切换、归档任意多任务不受限。
3. `GuiTaskDefinition` additive 扩展可选字段：`model?: string`、`thinking?: string`、`workspaceId?: string`、`sourceRef?: { parentId: string; turnId: string; summary: string }`。`validateGuiTask` 对新字段做存在才校验；旧 journal 无字段行为不变。

### B. 会话元数据与重命名/置顶/归档（B4/B15）
4. 重命名（自定义标题）、置顶、归档 = 任务级 `gui_meta` 事件**追加进该任务自己的 journal**（`{type:'gui_meta', title?, pinned?, archived?, at}`），重放时按序折叠出当前 meta；不产生第二份真相文件。归档 ≠ 删除：本批不提供删除任何 journal/baseline 的入口。
5. `GuiLiveOverview.sessions` 项扩展为 `{id, title, objective, status, workspaceId, pinned, archived, updatedAt, lastMessage}`：updatedAt = 最后一条 gui_event 的 at；lastMessage = 最近一条 gui_message 的 120 字摘要（无则空串）；title = meta.title ?? objective 截断。全部从重放状态可复算。
6. 左栏列表按 workspace 分组 → pinned → updatedAt 倒序；archived 默认折叠「已归档」组（可展开）；搜索走索引字段（title/objective/lastMessage）的大小写不敏感包含。

### C. 工作区注册表（B3）
7. 工作区文件：`dataDir/gui/workspaces.json`（schema v1：`{version:1, workspaces:[{id,name,cwd,createdAt,archived,sort}]}`），写用 tmp+rename 原子替换 + 同 safeJournalPath 的 symlink/逃逸检查。审计靠任务合同里的 workspaceId，不另做工作区 journal。
8. 首个默认工作区 = 宿主 options.cwd，首次访问 overview 时若注册表无记录则自动登记（name = 目录名）。新建工作区端点校验：绝对路径、存在、是目录、非 symlink、可运行 `git rev-parse`（真实任务需要基线）；失败如实 409 列字段错误。任务创建 binding 后不可改。

### D. 自由任务（B1/B18/B19）
9. `POST /api/live/task/validate`（dry-run）：逐字段返回结构化错误，并外加三查：工作区存在且 Git 可用、writePaths 相对路径语义（沿用 validateGuiTask 规则）、checkCommands 首个 token 可解析为可执行（which/常见解释器）。不消耗模型、不捕获基线、不落盘。
10. `POST /api/live/task`：body = 完整合同（含 objective/workspaceId/model?/thinking?/requirements/writePaths/checkCommands/shellCommands?/maxRounds/maxTurns/wallClockMs）。requirements 缺省由 objective 派生一条「完成本轮对话中你确认的目标」。创建后任务处于「待启动」：写 journal created 记录，**不消耗模型**。GUI 合同确认卡（字段可编辑、默认值来自 validate）之后是「创建」或「创建并启动」。
11. `POST /api/live/:id/start`（替换旧 `/api/live/start` 语义：`{id}` 在路径里）：启动该合同 —— 捕获基线、composition、runGoal。成文的旧 `host.start(text)` 固定目标语义删除（P3 旧合同任务 gui-6a82e434 在现场journal中仍是 created-已启动记录，重放不受影响）。
12. 取消 = stop（运行中）；终态/待启动只能归档。任何路径都不删 journal/baseline。

### E. 讨论分支（B5）
13. 分支创建 = `POST /api/live/task` + `sourceRef` + `forkFrom: {parentId, turnId}` 字段（独立入参而非合同字段，便于服务端独立校验）：服务端从父任务 snapshot 截取「到 turnId 为止」的 user/assistant 消息（每条截 4000 字、总长 ≤24000 字、redactSecrets），生成新任务：合同默认克隆父合同（writePaths/checkCommands/budgets），目标 = `承接「{父目标截断80字}」第 N 轮的讨论分支`，requirements 同 D10 缺省。
14. 分支上下文写入：新 Session 在 `start` 时由宿主先写入 user 消息链（`[前情 · 来自任务 X 第 N 轮]` + 各条消息），再照常 runGoal；**新 goal、新基线（捕获当前工作树）、零审批继承**。分支任务 overview 卡显示 `来源`（parentId + 轮次）。
15. GUI：回复操作条加「分支」图标钮（样稿三钮之一）→ 确认卡（说明复制规则与不复用授权）→ 创建并切到新任务，**待启动**。

### F. Git 只读状态（B6）
16. `GET /api/live/:id/git`：`git -c core.fsmonitor=false status --porcelain=v2 --branch`（只读、15s、scrubGitEnv）解析出 `{branch, ahead, behind, uncommitted, worktree, at}`；每任务 5s 内存缓存；git 不可用/非仓库如实 `{unavailable: reason}`。
17. UI：监控/详情只读展示（branch、●未提交数、ahead/behind、worktree 模式），不提供任何 git 写操作入口。

### G. 模型与思考档位（B7）
18. `GET /api/live/models`：从真实配置生成——当前 CLI policy 的 model 为默认；provider.capability 暴露的 thinking 支持集为档位（当前 DoubaoProvider 若无变体，则如实输出单档 `off`）。**禁止虚构模型列表**：单模型时 UI 显示「模型由当前配置固定」且 popover 只读。
19. 合同 `model`/`thinking` 字段在 start 时生效：`loadDoubaoConfig({model: contract.model ?? policy.model})` + `withThinking(contract.thinking ?? 'off')`；created.model 落 journal；resume 校验一致性（沿用）。
20. Composer 工具行（批 1 defer 项，本批兑现为有真实数据的骨架）：显示模型 pill（当前任务模型名）+ thinking 档；多档可选时弹出 selection；单档只读。权限档不展示选择（策略由 Runtime 掌握）。

### H. SSE 与投影
21. SSE 按任务订阅（现状不变），overview 变更（meta/列表/新任务）经新增轻量轮询端点 `GET /api/live` 由 UI 在任务切换/操作后重取；不为 overview 建第二条流。
22. `live-projection.ts` 增加 `gui_meta` 事件折叠（snapshot.title/pinned/archived 入 snapshot 顶层可选字段）。

## 禁止事项（本批）
- 不重写 Agent 核心；EventBus/SessionStore/PermissionGate/runGoal/runAgent 现样复用。
- 不新增 verifier/route/scheduler 抽象、不做多任务并发运行、不做工作区内目录浏览枚举（选择器是用户输入绝对路径）。
- 不删除任何 journal/baseline；不提供 git 写操作；模型列表不虚构；权限档不做 UI 选择。
- 真实模型调用：本批全程确定性 provider（测试与 fixture），不申请预算。

## 验收门
1. 全量 `vitest run --maxWorkers=4` 绿 + lint + 双 typecheck + app build。
2. 新增测试：meta journal 重放（rename/pin/archive 折叠与重启后读回）、workspaces.json 持久与校验失败、task validate/dry-run 字段错误、start 互斥 409、分支创建的上下文截断与来源链、git/models endpoint 降级。live 级测试沿用 `test/surfaces/gui/gui-live-session.test.ts` 形态扩展。
3. 确定性 playback（`scripts/gui-p3-browser-fixture.ts` 同源手段）：创建任务 A（workspace 默认）→ 启动 → 消息 → 创建分支任务 B（来源链成立、上下文注入、独立基线）→ A 继续运行中 B 待启动；rename/pin A → 重启宿主 → 左栏索引与 meta 读回一致；git/models endpoint 返回真实/诚实降级。
4. 试件扩充：`fixtures.ts` 增加多任务/分支来源/单模型只读/git 行展示状态；截图 1440×900 与 1280×800 入 `docs/evidence/gui-v13-batch2/`。
5. PLAN-gui-v13-restart 进度更新；commit。
