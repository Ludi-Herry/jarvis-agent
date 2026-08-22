# v0.3 GUI 范围规划：晴天模式外壳打磨

> 状态（2026-08-22）：规划已获 Luis 拍板（GUI 与 CLI 收尾证据并行开工）。执行方为 Codex；Luis 持设计权与逐节验收权。
> 定位继承：GUI-first 时代留下的 R6（UI/UX 打磨 + Luis 逐节验收）由 v0.3 承接，目标口径不变——「以 Luis 的标准把 GUI 从晴天模式外壳打磨到可日常使用」（见 `docs/handoff-release.md`）。
> 本文是执行依据；与 `AGENTS.md` 或蓝图冲突时以那边为准并停下来问。

## 1. 产品定位

- **用户**：Luis 一人（UI/UX 设计师，产品唯一用户）。
- **场景**：晴天模式——agent 在终端跑，Luis 大部分时间不看；看的时候要一眼知道「在干什么、信不信、要不要插手」。插手手段只有三个：审批、急停、人工裁决。
- **完成定义**：每个视图的视觉层级、文案、空态/错误态、响应式经 Luis 逐节验收通过（R6 原标准），且窄控制面边界零变化。

## 2. 现状盘点（2026-08-22 实核）

- 服务端 `src/surfaces/gui/gui-server.ts`（286 行，Node 原生 http，无框架）：`GET /api/status`（含急停状态）、`GET /api/observation`（完整 ObservationReport）、`GET /api/human-reviews`、`GET /api/emergency-stop`、`POST /api/human-reviews/:goalId/decide`、`POST /api/emergency-stop`。
- 前端 `src/surfaces/gui/assets/`（index.html / app.js / app.css）：vanilla，无构建链，1.5s 轮询；时间线（activity.recent）+ 摘要 + 急停（Stopped/Armed）+ 裁决内联表单。
- 安全姿态：loopback Host 头校验、POST 要求 `x-jarvis-gui: 1`、非 loopback 绑定告警；测试 `test/surfaces/gui/gui-server.test.ts`（401 行，含路径穿越与伪造 Host 用例）。
- 数据面：当前工作区有 27 个 session、6 条待裁决需求，走查不缺真实数据。
- 已知缺口（2026-08-18 实测）：CLI `jarvis status` 的 text/JSON **不显示**急停状态（GUI 的 `/api/status` 另走 `readEmergencyStop` 所以能显示）；ObservationReport 无控制面字段。
- 历史走查证据：`docs/gui-readonly-pilot-notes.md`（observe/GUI 可读性问题清单，G0 的输入）。

## 3. 分工与决策权

| 角色 | 职责 |
|---|---|
| Luis | G0 走查与 UX 问题清单、IA/视觉/文案决策、每节验收、G5 开闸与否 |
| Codex | 切片实现、测试、静态门禁、独立对抗复核、文档收口 |
| ZCode（GLM） | 规划维护、跨模型复核（verifier 角色）、边界仲裁记录 |

## 4. 切片清单（按价值顺序，各自独立交付）

### G0 · 走查与 UX 问题清单（Luis 主导，Codex 只记录）

- Luis 起 `npm run gui` 用真实数据走查，把体验问题按「阻断日常使用 / 改了更好 / 锦上添花」三档记入 `docs/gui-redesign-walkthrough.md`；顺手产出 IA 草图（视图划分、每视图信息优先级）。
- 输出喂给 G2；不阻塞 G1。

### G1 · 状态可见性补齐（Codex 首个切片，无设计依赖）

- 把急停状态并入 ObservationReport（additive 字段，如 `control.emergencyStop`，读取既有 `data/control/emergency-stop.json`，读取失败可见降级、不抛），CLI `jarvis status` text/JSON 显示急停是否生效——补上「CLI 查不到急停状态」的缺口。
- GUI 的 `/api/status` 迁移到同一契约源（行为不变）。
- 验收：stop 生效/清除两态下 CLI 与 GUI 显示一致；契约变更 additive、schemaVersion 不降；聚焦测试 + 全量门禁全绿。

### G2 · 信息架构与视觉改版（Luis 设计 → Codex 分节实现）

- 按 G0 的 IA 草图重组视图（候选：总览 / 时间线 / 裁决 / 审批历史 / 会话只读；以 Luis 定稿为准）。
- 技术约束：保持 vanilla 无构建栈；若设计需要组件化，Codex 先提方案给 Luis 拍板，未经批准不引依赖。
- 交付节奏：每视图一节，截图 + 本地 URL 交 Luis 验收，过了才作为下一节基准。

### G3 · 裁决体验对齐 CLI

- GUI 裁决入口补齐 `review show` 等价能力：requirement 级明细、note 必填与长度反馈、已裁决历史（读 `data/human-reviews/`）。
- 边界不变：裁决只写审计与 goal round，完成授权仍只来自 `decideVerdict`。

### G4 · 观测增强

- 审批历史视图（`data/approvals/*.jsonl`，只读）；时间线按 goal/loop 过滤；goal_round 事件的轮次/token/预算进度展示。
- 全部只读，无新控制能力。

### G5 · GUI 审批中继（默认不做，等 Luis 开闸）

- 把 attended run/goal 的终端审批搬到 GUI（注入式 Approver 已预留，架构可行）。
- 涉及运行进程与 GUI 的桥接，风险与复杂度显著高于前四片；G2 走查后由 Luis 单独拍板是否开切片，本文不预支范围。

## 5. 明确范围外（整个 v0.3 期间不做）

- 从 GUI 启动 goal/loop、merge 代码、编辑任何 map、任何完成授权（授权链不进 GUI）。
- Electron/桌面打包、多用户、远程访问（保持 loopback 单用户）。
- 动态 Artifact / OpenUI（维持 2026-07-30 决策：需求反复出现后才从只读 spike 起步）。
- 新增框架、构建链、依赖（两阶段审批红线）；第 5 套 map / verifier / route / scheduler 抽象（AGENTS.md 硬约束）。

## 6. 门禁与交付纪律（每切片）

1. 聚焦测试覆盖新行为（含失败路径），guardrail 必配真实触发单测。
2. `npm run typecheck` / `npm run lint` / `npm run build -- --noEmit` / `npm test`（`--maxWorkers=4`）/ `git diff --check` 全绿。
3. 独立对抗复核（跨模型或换上下文），P0/P1 修完复核 GO 才提交；commit message 英文。
4. `docs/handoff-next.md` 增加对应切片条目（验证证据、Reviewer 结论、提交 SHA）。
5. 同一失败连续 3 次未解即停，落盘证据与选项，交回 Luis 裁决。

## 附录 · Codex 执行 prompt（复制即用）

```text
你是 Jarvis-Agent 仓库（H:\jarvis-agent，main 分支）的实现者，接手 v0.3 GUI 切片。执行依据是 docs/v03-gui-plan.md；与 AGENTS.md 冲突时以 AGENTS.md 为准并停下来问。

开工前按顺序读：
1. AGENTS.md
2. docs/v03-gui-plan.md（范围、切片、边界、门禁）
3. docs/handoff-codex.md（接手宪法：硬不变量与同族自审盲区）
4. docs/handoff-next.md 的「GUI 就绪盘点」与「GUI 第一版（2026-07-03）」两节
5. docs/gui-readonly-pilot-notes.md（历史走查证据）
6. src/surfaces/gui/（gui-server.ts / timeline.ts / assets/）与 test/surfaces/gui/gui-server.test.ts

任务：从切片 G1（状态可见性补齐）开始，按规划顺序实现；G0 走查由 Luis 主导，你不用做。

硬边界（命中即停并汇报，不自行扩权）：
- GUI 保持窄控制面：只读观测 + 急停 + 人工裁决；不启动 goal/loop、不 merge、不编辑 map、无完成授权、不碰 decideVerdict 与权限闸门。
- 前端保持 no-build vanilla 栈；引入任何依赖或构建链前必须先问 Luis。
- observe/JSON 契约只 additive 演进，schemaVersion 不降；安全姿态不降（loopback Host 校验、POST 的 x-jarvis-gui: 1、非 loopback 绑定警告）。
- 不 git push、不 npm publish、不动 dist/、不删文件。
- 每切片完成标准：聚焦测试覆盖新行为（含失败路径）+ npm run typecheck / lint / build -- --noEmit / npm test（--maxWorkers=4）全绿 + git diff --check 干净 + 独立对抗复核 P0/P1 清零 → 英文 commit → 更新 docs/handoff-next.md 对应条目。
- UI 切片分节交付：每节给截图 + 本地 URL，Luis 验收通过才作为下一节基准。
- 同一失败连续 3 次未解即停，写清证据与选项后交回 Luis。

第一步：读完上述文件后，输出一份不超过 15 行的 G1 实施确认（改动文件清单、契约字段设计、测试清单），等 Luis 回「开工」再动代码。
```
