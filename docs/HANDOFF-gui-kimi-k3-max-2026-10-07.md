# Jarvis GUI 后续迭代交接给 Mirasim Kimi K3 Max

## Owner 本轮授权

2026-10-07，Ludi 原话：「同意你的方案，批准执行。但是现在你的 5 小时额度有限制，只剩 4% 了。将后续的所有迭代开发工作跟这个方案里面的注意事项，全部都派发出去给。mirasim 的 kimik3max 来执行和接替你的工作」。

你接替 Codex 承担本项目后续 GUI 调查、实现、定向修复、验证、文档同步与交付协调。已批准方案是 `docs/ANALYSIS-gui-openhanako-mirasim-gap-2026-10-07.md`，必须完整读取；不是让你只再写一份分析。任务通过 Mirasim 的 Kimi Code `kimi-code/k3`、`effort=max`、`route=platform` 派发，不改用户全局模型配置，不转回 Codex 消耗其额度。

本授权包含方案中明确列出的常规迭代；方案里的条件项仍保留条件，视觉签收和 Jarvis 真实任务窗口仍由 Owner 完成。不要为已授权、低风险常规实现重复问批准。

## 开始前的必读材料与当前权威

1. 仓库 `AGENTS.md`，以及当前宿主加载的用户规则。读取规则不等于可以修改生成的指令文件。
2. 上述批准的差距报告（全部内容，特别是第 6 节顺序和成本边界）。
3. `docs/PLAN-gui-v13-restart-2026-10-05.md`、`docs/PLAN-gui-v13-batch2-architecture.md`、`docs/PLAN-gui-v13-batch3-architecture.md`。
4. `docs/evidence/gui-v13-repair-2026-10-07/README.md`、批 2/3 证据包 README；旧 `docs/MAP-v13-to-jarvis-gui.md` 部分内容已过时，不能据此认定多工作区/模型/并发/终端尚不存在。
5. `docs/DECISION-gui-mvp-p1.md` 的 2026-09-26 修订：左侧任务、中央对话、按需证据抽屉；审批/验收固定在 Composer 上方。
6. `docs/v13-source-manifest.json` 冻结的 `H:/Ludi-design-studio/docs/prototypes/studio-annotation-branches-v13/`。唯一视觉目标为 **V13 黑白灰讨论区精准 1:1 还原**。不是整个 Ludi Studio，设计画布不移植。

项目架构权威仍是 AGENTS 指向的知识库蓝图。不得因报告竞品功能多而重写项目定位、引 SDK 或增加通用框架。

## 当前工作树：必须保留并纳入接替

交接时 HEAD 为 `8c52ce3`。先 `git status --short` 与相关 diff 核对实时状态，有并行改动时以当前事实为准，不能重置恢复到 HEAD。

Codex 上一轮已改、未提交：

- `docs/PLAN-gui-v13-restart-2026-10-05.md`
- `src/surfaces/gui/app/src/live/api.ts`
- `src/surfaces/gui/app/src/live/use-live-session.ts`
- `src/surfaces/gui/app/src/styles/workbench.css`
- `src/surfaces/gui/app/src/workbench/conversation-pane.tsx`
- `src/surfaces/gui/app/src/workbench/create-task-panel.tsx`
- `src/surfaces/gui/app/src/workbench/fixture-store.ts`
- `src/surfaces/gui/app/src/workbench/types.ts`
- `src/surfaces/gui/app/src/workbench/workbench.tsx`
- `src/surfaces/gui/app/src/workbench/workspace-rail.tsx`
- 新增 `test/surfaces/gui/gui-task-submission.test.ts`
- 新增证据目录 `docs/evidence/gui-v13-repair-2026-10-07/`
- 新增批准方案 `docs/ANALYSIS-gui-openhanako-mirasim-gap-2026-10-07.md`
- 本交接文档（含派发回执将由 Codex追加）

不要用 `git add -A`、`reset --hard` 或重新生成全部 UI 覆盖这些内容。不对已有证据、历史失败或其他会话产物做清理。提交时精确暂存并先检查 `git diff --cached --stat`，不推送。

## 已完成的修复，禁止回归

- 空态只有一个主输入框，范围/检查/预算按需展开；异步校验→创建→启动的同步锁贯穿全链，只提交同一份已校验草稿。启动明确绑定新任务 ID。
- 左栏 244px，700px 以下 58px；页头 54px。1440×900 空态输入框 x=449.5、宽785，标题 x=738.5、宽207；这些只是已测锚点，不代表整页已获 1:1 签收。
- 消息、审批、Composer 同列；用户到 assistant 间距22，回合间46；工具行不出现第五列错行。
- 证据抽屉306/420px，六页签三列两行。1280×800 展开时中栏616px；1000×760 抽屉覆盖，中栏756；700×760中栏642。没有整页横向溢出。
- 新建工作区面板位于列表顶部并聚焦；任务重命名同步页头。
- 真实页面、试件、截图均有明确来源，试件不得宣称真实任务成功。

最后检查：typecheck/lint/root build/GUI build 通过；1,805 passed、2 原有 skipped；独立定向复核 GO。主 JS 约583kB有既有非阻塞体积提示，不因此引入无关优化。没有新增真实模型运行或改写历史 verdict。

## 按批准方案接续实施

### 第一批：基础阅读与授权判断

先做现有 React/assistant-ui 内最小实现：Markdown、代码块及复制、成果文件/截图的可打开入口，待授权操作的结构化摘要/变更视图。当前 live 文本是 `message-item.tsx` 中的 `<p>{part.text}</p>`；artifact 清单只显示路径与 outcome。审批跳已有 snapshot.diff，不能把它等同即将批准的变化。

区分待授权与已执行变化；读文件/预览必须受任务工作区和路径边界约束。优先复用已有能力与依赖，确需新依赖按 AGENTS 的来源、版本、ignore-scripts与 lifecycle 授权规则操作。不要把办公文档全套编辑器塞进这一批。

### 第二批：单任务启动与错误恢复

空态箭头现在只展开合同，校准可见含义与实际动作。创建任务需要理解相对写路径、检查命令、轮数/步数/时间；提供经用户确认的工作区预设、摘要与修改入口，使常规任务更轻。只读发现项目候选命令可以做，自动授予写权限、扩大路径或让模型改检查合同不可以。

状态用用户能理解的“在做什么/等什么/下一步/剩余预算”表达，不伪造进度百分比。已知问题：`GitRows` 的 reject 设置 null 后一直显示读取中（源码定位，尚未注入故障）；终端超时与取消同显“已取消”（批3已知限制）。按实际来源解决，不通过隐藏错误或删检查声称完成。

### 第三批：把已有能力变得可控制

待补充内容展示、撤回/修改等操作，其他任务待处理提示，真实成本/预算摘要。补充目前在下一个处理边界送达，不声称即时打断。当前 task model/thinking 创建时固定，改为队列级或中途变更必须有明确真实合同；累计 Token 不等于上下文窗口占用，不能伪造占比。

### 第四批：项目工作空间

先只读文件定位/导航、易读的多文件 Diff 和成果阅读。保持 V13 结构，若全宽成果、多 pane、独立窗口等会改变冻结布局，先做好可审阅样稿给 Owner 视觉签收后推进该变化；不要边“复刻”边偷偷改结构。

### 后续条件项与真实验收

方案中 worktree、多 pane、GUI 模型配置、Skill/MCP 管理、受控浏览器属于按实际需求的后续项。你负责接续协调这些工作，不遗漏；先记录触发需求和可审阅实现方案，遵守原报告“按实际需求、另行立项”的条件，不默认一口气全建。

真实 Jarvis 模型任务仍按总计划安排，由 Owner 给真人窗口和预算；Kimi 接替的开发授权不自动授予 Jarvis 付费模型测试、外站操作或历史 verdict 修改权。可先把脚本、验收清单和确定性验证准备具体再问关键窗口。旧 P3 `docs/evidence/gui-mvp-p3/real-task-result.json` 仍 NOT ACCEPTED，无完成授权；不能用 UI试件或绿灯覆盖这一事实。

## 必须区分的现有能力

- 并发：异工作区最多2，同工作区1；不能只调上限造成同仓库并发写。
- 子智能体：已接真实 task 工具与 ROLE roster；GUI深度1、CLI2。GUI目前派生角色/摘要/状态/结果，不是完整 Agent 管理器。
- 预览：用户地址 iframe，loopback直开、外站按既有策略；不是 Agent浏览器，不靠代理外站绕嵌入限制。
- 终端：用户桌边命令与留痕，非PTY、非Agent通道，输出不授予验证与完成权。
- 讨论分支：新任务与来源链；不继承审批/验收/baseline，不等于Git分支/worktree或代码回滚。
- CLI/core已有SkillRegistry、Recall、ContextManager和checkpoint/rewind；GUI没入口不等于没有底层能力。
- GUI设置未接入；Git只有只读状态。GUI配置写入、Git写操作仍遵守相应权限和立项边界。

## 验证、执行止损与留证

每批先在既有 implementation notes 中写目标、文件范围、验收及未决项，再实施。你是同一工作树唯一后续写入者；如需内部委派，先按宿主规则评估并隔离写入。不要扩大范围，不要跑不必要的审查和 CI，只处理已知问题，超出范围停下来报单。

源代码/运行变化宣布完成前必跑：根 `npm run typecheck`、`npm run lint`、`npm test`、`npm run build`，GUI `npm --prefix src/surfaces/gui/app run build`。通过后不反复全量刷；新增测试只补当前改动行为（通常主路径+必要失败路径），guardrail必须有触发测试。复用已知服务，实际渲染/交互/响应式验证后保留截图与测量；缺环境时明确限制，不只凭编译宣称UI完成。

已知真实 GUI URL为 `http://127.0.0.1:4317/app/`，Codex留下只读模式服务（无 task-file，不能启动模型）；先验证仍有效，禁止扫描端口。参考/Vite临时服务已停止。原稿与截图证据在现有目录，不重复下载或替换冻结参考。

同根因第二轮失败重新查根因，第三轮按规则转独立分析；不得连续叠补丁、删测试、降低阈值。一个重大新结构方案仍由 Owner裁决，既有批准的常规工作继续自主做。

证据存项目既有 `docs/evidence/`，失败现场保持原样；一次性脚本放系统Temp并按规则回收，本轮/既有证据不自动删除。文档同步当前权威，旧MAP与总计划“缓做”条目有漂移，不把已完成能力再造一遍。

## 权限硬边界（也约束所有子代理）

遵守AGENTS：无授权不永久删除/删Git历史，不修改.env/密钥/token/CI/CD，不数据库schema/迁移，不push/rebase/reset--hard/强推，不装全局依赖、不改系统配置、不公开部署。普通垃圾按已核验字面路径走回收站，保护路径与既有证据不得清理。

严禁本机网络身份/代理/VPN/DNS/IP/路由/网卡/连接关系调查；不读相关配置、日志或借截图旁路取信息，不扫描调试/代理端口。允许普通公开网页与已知localhost开发端口。不要因Mirasim显示认证诊断去读用户配置、提取Key、改代理或路由全局设置。

Windows命令含括号路径整体引号或LiteralPath；写文件显式UTF-8；不混壳拼删除命令。秘密不进日志、prompt、commit和示例。

## 接手后的第一条回执

在 Mirasim 会话中用简体中文向 Ludi 确认：已读方案、继承哪些未提交改动、K3/max、本批范围和下一验收点；然后直接推进第一批，不停在“已了解/可以做”。按批报告完成、证据、失败与剩余条件项；不自动向Codex原会话发消息，不创建Codex自动化或消耗其额度。

## 派发回执

2026-10-07 已派发并回读确认：

- Mirasim sessionKey：`kimi:5db29e1c-c008-4e6c-b588-004cde6de23e`
- 当前标题：`GUI差距报告分批开发接手`
- 工作区：`H:\jarvis-agent`，分支 `main`
- 实际会话模型：`kimi-code/k3`；派发参数 `--effort max --route platform`；会话回读 route=`cloud`
- 接收状态：`running`。这是接替已开始，不是后续开发完成。
- 派发命令已提交一次，没有重复建任务；执行进程仍在等待 Kimi 回合结束（Codex exec session `89426`）。Codex 不继续消耗额度监控开发进程，也不停止该任务。
- 最小回执保存于 `docs/evidence/gui-handoff-2026-10-07/dispatch.json`。

本文是持久交接材料，不是任务完成报告。后续进展、验收与需 Owner 裁决的事项在上述 Mirasim 会话继续。
