# v0.3 GUI 范围规划：晴天模式外壳打磨

> 类型：日期化 GUI 工作单。第 2–7 节保留开工时的盘点、方案和门禁，用于解释 G1–G4 的验收范围；逐切片结果在 `docs/handoff-next.md`，不要从本文件推断当前运行数据。
>
> 状态（2026-08-31）：G1、GA、G2.1–G2.4、G3、G4 已全部交付并通过 Ludi 视觉验收 + ZCode 独立浏览器验证。G0 走查被 G2 设计提案的逐节审批吸收，未单独成文。G5 继续冻结：先完成 v0.1 的三个真实任务；累计出现至少三次明确审批打断感后才重开设计。
> 定位继承：GUI-first 时代留下的 R6（UI/UX 打磨 + Ludi 逐节验收）由 v0.3 承接，目标口径不变——「以 Ludi 的标准把 GUI 从晴天模式外壳打磨到可日常使用」（见 `docs/handoff-release.md`）。
> G5 若被重新打开，先按 `AGENTS.md` 与蓝图更新独立设计；本文不直接授权实现。

## 1. 产品定位

- **用户**：Ludi 一人（UI/UX 设计师，产品唯一用户）。
- **场景**：晴天模式——agent 在终端跑，Ludi 大部分时间不看；看的时候要一眼知道「在干什么、信不信、要不要插手」。插手手段只有三个：审批、急停、人工裁决。
- **完成定义**：每个视图的视觉层级、文案、空态/错误态、响应式经 Ludi 逐节验收通过（R6 原标准），且窄控制面边界零变化。

## 2. 现状盘点（2026-08-22 实核）

- 服务端 `src/surfaces/gui/gui-server.ts`（286 行，Node 原生 http，无框架）：`GET /api/status`（含急停状态）、`GET /api/observation`（完整 ObservationReport）、`GET /api/human-reviews`、`GET /api/emergency-stop`、`POST /api/human-reviews/:goalId/decide`、`POST /api/emergency-stop`。
- 前端 `src/surfaces/gui/assets/`（index.html / app.js / app.css）：vanilla，无构建链，1.5s 轮询；时间线（activity.recent）+ 摘要 + 急停（Stopped/Armed）+ 裁决内联表单。
- 安全姿态：loopback Host 头校验、POST 要求 `x-jarvis-gui: 1`、非 loopback 绑定告警；测试 `test/surfaces/gui/gui-server.test.ts`（401 行，含路径穿越与伪造 Host 用例）。
- 数据面：当前工作区有 27 个 session、6 条待裁决需求，走查不缺真实数据。
- 已知缺口（2026-08-18 实测）：CLI `jarvis status` 的 text/JSON **不显示**急停状态（GUI 的 `/api/status` 另走 `readEmergencyStop` 所以能显示）；ObservationReport 无控制面字段。
- 历史走查证据：`docs/gui-readonly-pilot-notes.md`（observe/GUI 可读性问题清单，G0 的输入）。

## 3. 竞品参考与增量裁决（OpenHanako，2026-08-22）

完整裁决与证据分级见 `docs/analysis-openhanako-increments.md`（Ludi × Codex 讨论存档）。本文只收执行相关结论。

**参考使用规则**：OpenHanako 为 v0.3 GUI 指定竞品参考（Ludi 拍板）。只有公开源码+测试确认的机制可当实现参考；创作者演示口径（1 万问卷/亿 token/成本数字）与 HanaAgent 1.0 批注预告只能当产品方向，不得升级为能力结论。

**对 v0.3 GUI 直接生效的三条**：

1. **锚点批注进体验雷达**：文档/图片/网页锚点批注 → Agent 批量处理，是 G0 走查与 G2 验收的证据格式（见 G0）；批注面板本身条件触发——真实任务中反复出现「聊天式反馈定位不准、来回纠正成本高」才开切片，不预开发编辑器。
2. **显示与持久化分离**：时间线/消息渲染必须区分「持久化事实（JSONL）」与「显示投影」，UI 没显示不能推导模型没生成（上游 issue #2472 反例）。G2/G4 的时间线与渲染遵守此原则。
3. **任务卡片渲染教训**：若未来引入持续子代理，UI 按每次任务事件渲染，禁止用实例最新消息覆盖所有任务卡片（上游 issue #2467 反例）；当前 GUI 无此形态，仅登记为设计输入。

**post-real-use 候选登记（非本迭代工作，只记重开条件）**：

- Reminder（低权威环境变化的 additive 提醒通道）：重开条件 = 活跃会话中环境变化成为高频真实痛点。责任边界已定：权威语义变化仍走 composition drift fail-closed；reminder 无权限无完成授权；复用 per-request addendum + Session v2 receipt。
- 工具目录延迟加载：重开条件 = 工具数/schema 开销持续增长、模型频繁选错工具、connector 出现稳定重复需求。届时抄「真实目标权限绑定 + catalog fingerprint + 变化广播」，不抄插件面。
- 持续子代理线程（threadId/taskId 生命周期）：重开条件 = 真实任务反复需要续派同一专家；须保留子权限≤父、open/close 生命周期、fork 身份隔离、无完成授权、按任务事件渲染。

## 4. 分工与决策权

| 角色 | 职责 |
|---|---|
| Ludi | G0 走查与 UX 问题清单、IA/视觉/文案决策、每节验收、G5 开闸与否 |
| Codex | 切片实现、测试、静态门禁、独立对抗复核、文档收口 |
| ZCode（GLM） | 规划维护、跨模型复核（verifier 角色）、边界仲裁记录 |

## 5. 切片清单（按价值顺序，各自独立交付）

### G0 · 走查与 UX 问题清单（Ludi 主导，Codex 只记录）

- Ludi 起 `npm run gui` 用真实数据走查，产出 `docs/gui-redesign-walkthrough.md`；IA 草图（视图划分、每视图信息优先级）一并产出，喂给 G2。
- 竞品参考定为 OpenHanako（§3 使用规则），可用 ref-hunt/ref-study 深拆，非必需。
- **走查问题记录格式 = 产物级锚点批注**（OpenHanako 裁决的验收证据升级）：每条问题写 `artifact_ref`（页面/区域/截图）、`anchor`（元素/行/选区）、`annotation`（问题描述）、`severity`（阻断日常使用 / 改了更好 / 锦上添花）、`reviewer` + 时间。这套字段就是未来批注面板的雏形。

### G1 · 状态可见性补齐（Codex 首个切片，无设计依赖）

- 把急停状态并入 ObservationReport（additive 字段，如 `control.emergencyStop`，读取既有 `data/control/emergency-stop.json`，读取失败可见降级、不抛），CLI `jarvis status` text/JSON 显示急停是否生效——补上「CLI 查不到急停状态」的缺口。
- GUI 的 `/api/status` 迁移到同一契约源（行为不变）。
- 验收：stop 生效/清除两态下 CLI 与 GUI 显示一致；契约变更 additive、schemaVersion 不降；聚焦测试 + 全量门禁全绿。

### GA · 验收补强：两项故障注入（纯测试，与 G1 并行，非 GUI）

来源为 OpenHanako 上游失效案例的反向补强（§3 / 分析文档），零产品改动：

- **GA-1 Session 单调持久性**：长 session 连续追加 → 重启 → resume → fork → archive → rewind，断言源文件长度、seq、历史内容无倒退无消失（上游 #2473 九天会话被截到最后三条的反例）。
- **GA-2 异常流零重复**：构造 missing/unknown `finish_reason` 与流中断，断言单一失败终态、零重复回复、零 orphan side effect（上游 #2468 四次重试留四份回复的反例）。

边界：纯测试新增；若测试暴露真实产品缺陷，停下记录证据并汇报 Ludi，不就地改产品代码。

### G2 · 信息架构与视觉改版（Ludi 设计 → Codex 分节实现）

- 按 G0 的 IA 草图重组视图（候选：总览 / 时间线 / 裁决 / 审批历史 / 会话只读；以 Ludi 定稿为准）。
- 技术约束：保持 vanilla 无构建栈；若设计需要组件化，Codex 先提方案给 Ludi 拍板，未经批准不引依赖。
- 交付节奏：每视图一节，截图 + 本地 URL 交 Ludi 验收，过了才作为下一节基准。

### G3 · 裁决体验对齐 CLI

- GUI 裁决入口补齐 `review show` 等价能力：requirement 级明细、note 必填与长度反馈、已裁决历史（读 `data/human-reviews/`）。
- 边界不变：裁决只写审计与 goal round，完成授权仍只来自 `decideVerdict`。

### G4 · 观测增强

- 审批历史视图（`data/approvals/*.jsonl`，只读）；时间线按 goal/loop 过滤；goal_round 事件的轮次/token/预算进度展示。
- 全部只读，无新控制能力。

### G5 · GUI 审批中继（默认不做，等 Ludi 开闸）

- 把 attended run/goal 的终端审批搬到 GUI（注入式 Approver 已预留，架构可行）。
- 涉及运行进程与 GUI 的桥接，风险与复杂度显著高于前四片；G2 走查后由 Ludi 单独拍板是否开切片，本文不预支范围。

## 6. 明确范围外（整个 v0.3 期间不做）

- 从 GUI 启动 goal/loop、merge 代码、编辑任何 map、任何完成授权（授权链不进 GUI）。
- Electron/桌面打包、多用户、远程访问（保持 loopback 单用户）。
- 动态 Artifact / OpenUI（维持 2026-07-30 决策：需求反复出现后才从只读 spike 起步）。
- 新增框架、构建链、依赖（两阶段审批红线）；第 5 套 map / verifier / route / scheduler 抽象（AGENTS.md 硬约束）。
- OpenHanako 裁决追加的排除项（§3）：千节点 Workflow（不扩 scheduler）、通用插件系统/插件市场、自动学 Skill、人格/陪伴/生活记忆。

## 7. 门禁与交付纪律（每切片）

1. 聚焦测试覆盖新行为（含失败路径），guardrail 必配真实触发单测。
2. `npm run typecheck` / `npm run lint` / `npm run build -- --noEmit` / `npm test`（`--maxWorkers=4`）/ `git diff --check` 全绿。
3. 独立对抗复核（跨模型或换上下文），P0/P1 修完复核 GO 才提交；commit message 英文。
4. `docs/handoff-next.md` 增加对应切片条目（验证证据、Reviewer 结论、提交 SHA）。
5. 同一失败连续 3 次未解即停，落盘证据与选项，交回 Ludi 裁决。

## 附录 · Codex 执行 prompt（复制即用）

```text
你是 Jarvis-Agent 仓库（H:\jarvis-agent，main 分支）的实现者，接手 v0.3 GUI 切片与配套验收补强。执行依据是 docs/v03-gui-plan.md；与 AGENTS.md 冲突时以 AGENTS.md 为准并停下来问。

开工前按顺序读：
1. AGENTS.md
2. docs/v03-gui-plan.md（范围、切片、边界、门禁；§3 竞品参考与 GA 切片定义）
3. docs/analysis-openhanako-increments.md（OpenHanako 增量裁决：证据分级、GA 反向补强来源、post-real-use 候选与范围外追加）
4. docs/handoff-codex.md（接手宪法：硬不变量与同族自审盲区）
5. docs/handoff-next.md 的「GUI 就绪盘点」与「GUI 第一版（2026-07-03）」两节
6. docs/gui-readonly-pilot-notes.md（历史走查证据）
7. src/surfaces/gui/（gui-server.ts / timeline.ts / assets/）与 test/surfaces/gui/gui-server.test.ts

任务：先做 G1（状态可见性补齐），随后 GA（两项故障注入测试，纯测试新增），再按规划进入 G2+。G0 走查由 Ludi 主导，你不用做。

硬边界（命中即停并汇报，不自行扩权）：
- GUI 保持窄控制面：只读观测 + 急停 + 人工裁决；不启动 goal/loop、不 merge、不编辑 map、无完成授权、不碰 decideVerdict 与权限闸门。
- 前端保持 no-build vanilla 栈；引入任何依赖或构建链前必须先问 Ludi。
- observe/JSON 契约只 additive 演进，schemaVersion 不降；安全姿态不降（loopback Host 校验、POST 的 x-jarvis-gui: 1、非 loopback 绑定警告）。
- GA 只写测试，零产品改动；测试暴露真实产品缺陷时停手记录证据并汇报 Ludi，不就地修。
- GUI 渲染遵守「显示与持久化分离」：时间线/消息渲染区分 JSONL 持久化事实与显示投影，不用「界面没显示」推导「模型没生成」。
- OpenHanako 只当参考与失效案例来源（见分析文档证据分级）；post-real-use 候选（Reminder、工具目录延迟加载、持续子代理）与排除项（千节点 Workflow、通用插件、自动学 Skill、陪伴记忆）都不在本迭代范围。
- 不 git push、不 npm publish、不动 dist/、不删文件。
- 每切片完成标准：聚焦测试覆盖新行为（含失败路径）+ npm run typecheck / lint / build -- --noEmit / npm test（--maxWorkers=4）全绿 + git diff --check 干净 + 独立对抗复核 P0/P1 清零 → 英文 commit → 更新 docs/handoff-next.md 对应条目。
- UI 切片分节交付：每节给截图 + 本地 URL，Ludi 验收通过才作为下一节基准。
- 同一失败连续 3 次未解即停，写清证据与选项后交回 Ludi。

第一步：读完上述文件后，输出一份不超过 15 行的 G1 实施确认（改动文件清单、契约字段设计、测试清单），等 Ludi 回「开工」再动代码。
```
