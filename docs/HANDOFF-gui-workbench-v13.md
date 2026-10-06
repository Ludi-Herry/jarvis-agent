# 交接：V13 讨论区工作台改造（GUI MVP 重启第二轮）

> **2026-10-05 更新：本文所述全部工作已随保护基线 `1375374` 入库（此前「不提交」纪律已由 Owner 推翻）；§5.1 的验收页新鲜度竞争修复已在 `--maxWorkers=4` 全量门下闭环（1760 通过 / 0 失败）。当前工作以 `PLAN-gui-v13-restart-2026-10-05.md` 为入口。以下保留 9-26 当时记录。**

> 状态：`WORKBENCH REBUILT / LIVE WIRING REGRESSED / REAL TASK STILL UNACCEPTED`
> 日期：2026-09-26（Asia/Shanghai）
> 授权范围：本轮只用确定性输入完成 GUI 改造与回归；不重跑旧真实任务、不消耗新模型预算、不提交、不推送、不清理现场。
> 上游：[重启交接](./handoff-gui-mvp-reboot.md)、[P3 合同](./PLAN-gui-mvp-p3-runtime.md)、[映射](./MAP-v13-to-jarvis-gui.md)。

## 1. 做了什么

把 Jarvis GUI 从 P2/P3 的三栏原型壳重做成 V13「讨论区」式 Agent Harness 对话工作台：界面层与数据源分离，`src/surfaces/gui/app/src/workbench/` 是通用 Harness 表达（只吃 `GuiLiveSnapshot/GuiLiveOverview` 投影与一组命令），live 与 fixture 两个数据源共用同一组组件；Jarvis 仍是唯一 Runtime。

- 左栏：新建任务、搜索、工作区分组、任务切换、设置入口（未接入说明）、收起态与窄屏图标条；有运行中任务时切换被锁定并给理由。
- 中栏：文件夹图标 + 工作区 + 当前任务标题页头、运行状态、完成授权、暂停/继续/恢复/急停；连续消息流、工具执行摘要（一步定位证据）、最新回复常显操作与历史回复悬停显示、整条提问完全滚出后才出现的顶部摘要、宽度足够时才显示的定位刻度、回到最新、空任务引导；Composer 带审批/模型/运行位置/未接入信息行（空态在输入框上方，发送后移到下方）。
- 右栏：任务监控折叠分组（工作区、运行位置、分支未接入、任务资料、文档与产出、本次工具、环境信息、成员/后台进程/侧边聊天未接入）、单一活动阶段（审批 → 人工验收 → 状态）、Diff/产物、验证、上下文、审批历史、错误恢复与只读说明。
- 能力开关全部收敛为纯函数（`workbench/controls.ts`）：Runtime capability 优先、传输状态其次，UI 从不放宽宿主未授予的能力；每个不可用控件带真实理由。
- 主题：沿用 `tokens.css`/`DESIGN.md`，在 `.wb-root` 作用域内吸收 V13 的 zinc 灰白中性色阶（灰侧栏 #f3f3f5、白工作面、近黑主行动、四档文字灰）；语义色保留 Jarvis 自有定义。

## 2. 文件级改动

新增：`src/surfaces/gui/app/src/workbench/`（types、controls、format、scroll-rules、diff、prefs、fixtures、fixture-store、fixture-app、icons、not-wired、active-stage、evidence、detail-pane、workspace-rail、message-item、conversation-pane、empty-state、use-history-geometry、workbench）、`src/surfaces/gui/app/src/styles/workbench.css`、`test/surfaces/gui/gui-workbench-controls.test.ts`、`docs/MAP-v13-to-jarvis-gui.md`、`docs/evidence/gui-workbench-v13/`。

修改：`main.tsx`（`?fixture=` 路由、试件独立 chunk、workbench.css）、`live/live-app.tsx`（改为薄接线层）、`live/use-live-session.ts`（连接状态类型改由 live-types 提供）、`src/surfaces/gui/live-types.ts`（新增 `GuiConnectionState`）、`styles/live.css`（剪枝失效布局规则、状态色重定向到 `wb-*`）、`scripts/gui-p3-browser-fixture.ts`（可选第三参数复用工作区，供断线重连验证）、`PRODUCT.md`。

未改：`live-api.ts`、`live-projection.ts`、`live-session.ts`（净零）、`approval-history.ts`、`gui-server.ts`、`adapter/jarvis-external-store.tsx`、`demo/*`、`live/first-task-guide.tsx`（仍为空组件）、`tokens.css`、`DESIGN.md`、`app.css`、`review.css`、`overlays.css`、`responsive.css`。

## 3. 运行证据

- 工程门：根 `typecheck`、`lint` 通过；子包 `typecheck`、`build` 通过（gzip 159.54 → 169.65 kB，试件独立 chunk 6.49 kB）；新增单测 9 条通过；全量 `npm test` 在负载下 1759 通过 / 1 失败（见 §5）。
- 真实链路回归（`scripts/gui-p3-browser-fixture.ts`，确定性 provider + 真实 EventBus/Session/PermissionGate/Goal/审批审计/完成授权）：
  - 启动 → 流式消息 → 写入审批 → 「要求调整」聚焦 Composer → 理由提交后进入 Session 并改变下一轮模型输出 → 第二次审批「允许一次」→ 产物与 Diff 出现 → 模型边界暂停（未决审批先处理后才落暂停，符合既有语义）→ 继续 → 检查通过 → 人工验收逐项提交 → 完成授权已授予、验证页签显示 `node --check` 通过。
  - 急停：对话框确认 → 已终止、控制全禁用、审批失效、现场只读说明。
  - 断线：杀宿主进程 → 连接中断提示、危险控制全禁用、草稿保留；同工作区重启宿主 → SSE 自动重连、从 journal 重建现场、控制按真实 capability 恢复。
  - 草稿与滚动位置：草稿跨重载保留；滚动位置在重载后恢复（挂载 800ms 窗口内的程序滚动不写存档，避免自动滚底覆盖用户位置）。
- 视口：1440×900 = 244/852/344；1280×800 expanded = 184/610/486（P1 冻结值）；1280 compact = 184/784/312；1000×760 堆叠布局；均无整页横向溢出。键盘 Tab 焦点可见（2px 近黑轮廓）；`hover:none` 下悬停专属 affordance 常显。
- 截图：`docs/evidence/gui-workbench-v13/`（12 试件 ×1440、1280 expanded、1000 窄窗，共 17 张，Edge headless 采集）。

## 4. 历史结论保留声明

- P3 真实任务 `gui-6a82e434…` 仍未通过验收：未执行草稿、0 次 Ludi GUI 介入、完成授权未授予；`first-task-guide.tsx` 仍为 `return null`。本轮空态引导（`workbench/empty-state.tsx`）是 GUI 基建、外部代做，不替代也不计入该真实任务交付。
- 旧 CLI PRODUCT NO-GO、0/3、冻结三任务与 canary 记录未改写。
- 未新增 verifier/route/scheduler 抽象、第二事件总线、云服务或插件市场；未安装依赖、未提交、未推送。

## 5. 未验证项与已知问题

1. 全量 `npm test` 两轮各出现 1 条失败：`gui-live-session.test.ts > rejects approval of evidence changed after checks…`，报「验收页面已过期」而非「证据已变化」。根因是测试在 `until(...)` 捕获页面后、提交验收前，宿主 settle 事件（gui_elapsed/gui_diff）推进了 sequence，触发页面新鲜度 409，与「证据已变化」守卫竞争；单跑恒绿、全量并行负载下复现。已做保持意图的最小修复：提交验收前重新 `host.snapshot()` 取页面（指纹守卫不变，仍校验文件在检查后被改），见 `test/surfaces/gui/gui-live-session.test.ts`。修复后需复跑全量确认。
2. `prefers-reduced-motion` 只做 CSS 层核对（本机浏览器工具无该 emulate 通道），未做真机验证。
3. 触屏只验证 `hover:none` 常显规则，未做真机手势与缩放。
4. 1280×800 的「可读宽度」按 P1/P3 口径取中栏列宽 610；正文排版宽为列宽减内边距（约 518），与 P3 记录口径一致。
5. 中断现场的未决工具在界面上显示为「未知」而非「未执行」，属既有投影表达，未在本轮修改。
6. `app.css` 中 `.history-rail/.rail-*/.conversation-topbar/.prototype-note/.state-*` 等选择器在新 DOM 下已无宿主（demo 亦未使用），属可清理项；本轮未动该文件以保护 P2 证据面，登记待清理。

## 6. 下一次真实任务验收还需要

1. Ludi 明确新的运行窗口与监督方式（P3 停点要求），并决定复用或新写任务合同 JSON。
2. 真人在 GUI 完成至少一次有效介入（拒绝/要求调整）与逐项视觉、理解验收；自动检查与试件都不能替代。
3. 安静环境复跑全量门并闭环第 5.1 条；独立 Reviewer（权限/急停/恢复/完成授权）结论闭环。
4. 若真实任务仍选「首次使用引导」：`first-task-guide.tsx` 的空接入位保留，交付才会填充；本轮空态引导不占用该文件。

## 7. 临时产物与进程（收口时处理，删除需授权）

- 后台进程：vite preview 4328、fixture 宿主 4331 与 4333（4329 旧实例已杀但其工作区保留）。
- 日志：`/tmp/jarvis-fixture-4331.log`、`/tmp/jarvis-fixture-4333.log`、`/tmp/jarvis-fixture-4333b.log`。
- 保留的失败/过程证据：4329 旧实例 tmp 工作区（第一轮真实链路）、4331（暂停/继续/验收）、4333（急停/断线重连）各自的 `data/` 与 Session/Goal/审批 journal。

## 8. 第二轮修订（2026-09-26 晚）：对话优先

Ludi 看过第一轮后明确要求停止向首屏堆监控字段与 V13 占位，改为对话优先的通用 Agent 界面。已落实：

- 默认视图 = 左栏任务列表 + 中央对话；右栏改为**证据抽屉**，默认收起，点击工具行、产物或「查看改动与证据」才打开并定位页签。
- 审批与人工验收移到**对话区决策卡**（固定于 Composer 上方，滚动不隐藏），醒目可操作；右栏不再承载审批按钮，避免双入口。
- 顶部压成单行：工作区 + 单行任务标题 + 合并的状态/完成授权 chip + **仅当前可用**的运行按钮（不可用动作不再以灰按钮占位）。
- 工具流水默认折叠为「工具执行 · N 步 · 聚合状态」一行，展开后逐步可点。
- 删除任务监控卡、全部「未接入」占位、输入框下的权限/模型/分支调试标签与历史页脚；设置入口保留但面板只说明配置归属。
- 空态收敛为：一句分工说明 + 三条一行式规则（审批/完成/急停）+ 真实任务合同卡。
- 文档同步：`DECISION-gui-mvp-p1.md` §3 记录右栏常驻被推翻；`PRODUCT.md` 与 app `DESIGN.md` 改为对话优先 + 按需证据抽屉 + One Decision Rule；完成授权并入顶部状态 chip。

验收截图（Edge headless，`--run-all-compositor-stages-before-draw`）：`docs/evidence/gui-workbench-v13/accept-{empty,running,approval,complete}-{1440x900,1280x800}.png` 共 8 张。

独立 Reviewer（只读）结论：P0=0、P1=0、P2=3。已闭环 P2-2（resume 白名单收紧为仅 `recoverable`，补单测）与 P2-3（StopDialog pending 改用独立状态，不再匹配中文标签）；P2-1（SSE onopen 先置 connected 的短暂窗口）为 P3 既有行为，服务端每次变更仍重新校验 capabilities，无越权路径，登记不修。

### 「自由创建多任务」所缺的真实接口（下一阶段，本轮不实现）

1. **任务合同作者权**：合同目前只能经 `npm run gui -- --task-file` 在宿主启动时固定。缺 `POST /api/live/task`（创建/校验/落盘合同，含 writePaths、checkCommands、预算与 pricing）及 GUI 的结构化校验错误表达；写入需审计落盘。
2. **多会话并发策略**：`GuiSessionHost.start` 对第二个运行中任务返回 409。缺并发上限、排队语义、同 cwd 写冲突策略与每会话独立 baseline index 的定义；`overview.activeId` 需扩展为多 active。
3. **工作区枚举与绑定**：overview 只有单一 cwd。缺工作区列表接口（枚举本机目录要先定授权边界）与每会话 cwd 绑定/切换校验（resume 已校验一致性，可复用）。
4. **会话元数据索引**：重命名/归档/置顶/删除均无 Runtime 命令；重启后列表只能靠 journal 重建。缺 id→objective/created/status/archived 的持久索引与对应命令。
5. **可编辑权限策略**：允许写入集合与固定命令集合现在硬写在合同里。缺可编辑、持久化并在 GUI 展示生效中策略的对象（现有 config 边界只读）。
6. **per-task 模型与预算**：pricing 已进合同，model 仍由 CLI config 固定；缺合同级 model 字段与切换校验（resume 已校验 model 一致）。
7. **启动前 dry-run 校验**：自由创建需要在不消耗模型的前提下校验路径存在、检查命令可执行、基线可捕获；现有 `validateGuiTask` 只做结构校验。
8. **取消与清理命令**：启动失败或取消后残留 journal 与 baseline index 目前只读不删；缺显式清理命令与 GUI 入口。
