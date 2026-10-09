# Jarvis-Agent 文档地图

这页回答两个问题：遇到一个任务先读哪份文档，以及每份文档负责保存哪类事实。命令能力先查 CLI help，运行状态先查 `doctor`、`config show` 和 `status`。

## 先按任务选入口

| 任务 | 入口 | 这份文档负责什么 |
|---|---|---|
| 第一次认识项目 | [README](../README.md) | 定位、安装、首次运行和主入口 |
| 了解产品体验边界 | [PRODUCT](../PRODUCT.md) | 用户、目的、设计原则和范围 |
| 复制命令完成使用验收 | [使用与验收指南](usage-guide.md) | 从零成本检查到真实模型任务的操作步骤 |
| 选择 run / goal / loop / cron | [Loop primitive 选择指南](loop-primitives-guide.md) | 按交付物和停止条件选择入口 |
| 判断版本路线与发布门槛 | [CLI-first 路线](cli-first-plan.md) | 版本定位、信任合同和验收门槛 |
| 回查冻结的 v0.1 证据 | [v0.1 MVP dogfood 手册](TODO-v01-evidence.md) | 三个真实任务、停止线、NO-GO 与历史 G5 决策 |
| 开始下一阶段 GUI 工作 | [GUI 重启总计划](PLAN-gui-v13-restart-2026-10-05.md) 与 [能力映射](MAP-v13-to-jarvis-gui.md) | 当前批次进度与 V13 基线；能力现状（2026-10-09 已同步） |
| 查看已实现变更 | [Changelog](../CHANGELOG.md) | Unreleased 与已发布版本的变化 |
| 查看仍成立的风险 | [Known Issues](../KNOWN_ISSUES.md) | 当前限制、影响和处理方向 |
| 修改仓库 | [AGENTS](../AGENTS.md) | 工程规范、架构来源和硬边界 |

## 文档类型

- **入口**：帮助读者找到下一份文档，不承载完整合同。
- **指南**：回答如何完成一个任务，命令与期望结果放在一起。
- **合同**：保存稳定字段、权限、不变量和验收语义。
- **工作单**：有日期、有停止条件，服务于一轮明确执行。
- **历史证据**：保留当时结论、测试数字和 commit，不代表当前状态。
- **运行时合同**：会被 agent、评测器或脚本直接读取，修改可能改变行为。

## 当前指南与合同

- [usage-guide.md](usage-guide.md)：Ludi 的 PowerShell 使用与验收路径。命令参数仍以对应 `--help` 为准。
- [loop-primitives-guide.md](loop-primitives-guide.md)：`run`、`goal`、`loop`、`cron` 与 `finalize` 的选择规则。
- [cli-first-plan.md](cli-first-plan.md)：CLI-first 版本线、信任合同和最终验收门槛。
- [checkpoint-tui-contract.md](checkpoint-tui-contract.md)：checkpoint、rewind、TUI reducer、renderer 与文件恢复边界。
- [headless-a0-contract.md](headless-a0-contract.md)：headless agent-event、A0 corpus、runner、manifest 与 report 合同。
- [os-sandbox-research.md](os-sandbox-research.md)：OS sandbox 的研究结论、已实现范围和仍未覆盖的边界。
- [security-review-baseline.md](security-review-baseline.md)：权限与命令安全审查的严重度尺子和复核方法。

## 当前工作单与产品雷达

- [PLAN-gui-v13-restart-2026-10-05.md](PLAN-gui-v13-restart-2026-10-05.md)：GUI 当前总计划与批次进度（批 0–8 已入库，下一节点为 P3 真实任务真人验收窗口）。
- [MAP-v13-to-jarvis-gui.md](MAP-v13-to-jarvis-gui.md)：V13 讨论区 → 工作台能力映射现状（2026-10-09 按批 8 同步）。
- [HANDOFF-gui-kimi-k3-max-2026-10-07.md](HANDOFF-gui-kimi-k3-max-2026-10-07.md)：GUI 迭代由 Codex 转 Mirasim Kimi K3 Max 的授权与边界。
- [handoff-gui-mvp-reboot.md](handoff-gui-mvp-reboot.md)：历史：GUI MVP 重启方向、前端选型（现出现于重启总计划并被取代）。
- [TODO-v01-evidence.md](TODO-v01-evidence.md)：冻结的 v0.1 三任务 dogfood 合同与 NO-GO 证据；当前不继续执行。
- [v03-gui-plan.md](v03-gui-plan.md)：已完成 G1-G4 的日期化历史工作单；G5 与未来路线已被 GUI MVP 重启交接取代。
- [ai-execution-routing-readiness.md](ai-execution-routing-readiness.md)：执行路由的现有边界和重开条件。
- [ai-coworker-readiness.md](ai-coworker-readiness.md)：AI coworker 相关能力的候选、排除项与触发条件。
- [analysis-openhanako-increments.md](analysis-openhanako-increments.md)：OpenHanako/HanaAgent 外部材料的证据分级和增量裁决。
- [langchain-ecosystem-reference.md](langchain-ecosystem-reference.md)：LangChain 生态的日期化参考与 A0 输入。
- [PLAN-documentation-ux-writing-refresh.md](PLAN-documentation-ux-writing-refresh.md)：本轮文档体验优化的范围和验收标准。

## 日期化评审与收口记录

- [sol-pro-cli-trust-review.md](sol-pro-cli-trust-review.md)：GPT-5.6 Sol Pro 外部复核、采纳项和当时的落地修正。
- [gui-readonly-pilot-notes.md](gui-readonly-pilot-notes.md)：GUI 只读试点的运行证据与可读性问题。
- [PLAN-completion-shell-probe-portability.md](PLAN-completion-shell-probe-portability.md)：completion shell 探针的跨平台修复记录。
- [PLAN-g2-review-refresh-linearization.md](PLAN-g2-review-refresh-linearization.md)：G2.3 同类失败升级后的统一修复提案。
- [PLAN-g3-human-review-history-bounded-read.md](PLAN-g3-human-review-history-bounded-read.md)：G3 有界读取与路径绑定修复提案。

## 历史交接

这些文件保存特定日期的状态、证据与接手信息。做当前判断时先读上面的当前入口，再按需回查。

- [handoff-next.md](handoff-next.md)：截至 2026-08-24 的 CLI-first 与 GUI 收口快照。
- [handoff-release.md](handoff-release.md)：2026-07-03 GUI-first v1 路线与 R1–R9 证据。
- [handoff-zcode-glm53.md](handoff-zcode-glm53.md)：ZCode/GLM-5.3 机械切片的任务包与完成记录。
- [handoff-codex.md](handoff-codex.md)：Codex 接手时使用的信任边界与审查补偿。
- [handoff-loop-remaining.md](handoff-loop-remaining.md)：parallel resume、finalize 与 cron daemon 的收口记录。
- [handoff-hooks.md](handoff-hooks.md)：tool-call、lifecycle 和 per-goal hook 的收口记录。
- [handoff-D.md](handoff-D.md)：Phase D GoalLoop 与三腿验收的阶段交接。
- [handoff-C.md](handoff-C.md)：Phase C SubagentManager 的阶段交接。
- [handoff-B.md](handoff-B.md)：Phase B PermissionGate、Bash 与规则解析的阶段交接。
- [handoff-persistence.md](handoff-persistence.md)：JSONL 持久化与早期 resume 的阶段交接。
- [handoff-A.md](handoff-A.md)：Phase A A0–A6 的阶段交接。
- [handoff-A1.md](handoff-A1.md)：A0+A1 的早期交接，内容已由 `handoff-A.md` 覆盖。

## 历史方案与实现计划

这些计划保留任务拆分、失败模式和设计推理。实现状态从 Changelog、源码和测试读取。

- [phase-A-plan.md](phase-A-plan.md)
- [phase-B-plan.md](phase-B-plan.md)
- [persistence-plan.md](persistence-plan.md)
- [phase-C-plan.md](phase-C-plan.md)
- [phase-D-plan.md](phase-D-plan.md)
- [phase-D-leg3-checklist.md](phase-D-leg3-checklist.md)
- [superpowers/plans/2026-07-01-loop-per-goal-verifier.md](superpowers/plans/2026-07-01-loop-per-goal-verifier.md)
- [superpowers/plans/2026-07-01-loop-mid-goal-resume.md](superpowers/plans/2026-07-01-loop-mid-goal-resume.md)
- [superpowers/plans/2026-07-02-parallel-resume-plan.md](superpowers/plans/2026-07-02-parallel-resume-plan.md)
- [superpowers/plans/2026-07-02-loop-finalize-report-plan.md](superpowers/plans/2026-07-02-loop-finalize-report-plan.md)
- [superpowers/plans/2026-07-02-loop-finalize-apply-cleanup-design.md](superpowers/plans/2026-07-02-loop-finalize-apply-cleanup-design.md)
- [superpowers/plans/2026-07-02-cron-daemon-plan.md](superpowers/plans/2026-07-02-cron-daemon-plan.md)
- [superpowers/plans/2026-07-02-os-sandbox-phase3-design.md](superpowers/plans/2026-07-02-os-sandbox-phase3-design.md)
- [superpowers/plans/2026-07-03-fixed-browser-smoke-feedback-design.md](superpowers/plans/2026-07-03-fixed-browser-smoke-feedback-design.md)
- [superpowers/plans/2026-07-03-unattended-worktree-write.md](superpowers/plans/2026-07-03-unattended-worktree-write.md)

## 根目录发布与治理文档

- [CHANGELOG.md](../CHANGELOG.md)：实现变更与版本历史。
- [KNOWN_ISSUES.md](../KNOWN_ISSUES.md)：当前已知限制。
- [RELEASE_NOTES.md](../RELEASE_NOTES.md)：2026-07-03 GUI-first `0.1.0` 候选的历史发布证据。
- [PRODUCT.md](../PRODUCT.md)：稳定产品定义。
- [AGENTS.md](../AGENTS.md)：agent 与工程治理合同。

## 运行时合同

以下 Markdown 会进入 agent 或评测流程。修改前需要按代码变更的标准核对调用方和测试。

- [../skills/git-commit/SKILL.md](../skills/git-commit/SKILL.md)：git commit skill 指令。
- [../agents/researcher/ROLE.md](../agents/researcher/ROLE.md)：只读 researcher 角色合同。
- [../eval/a0/README.md](../eval/a0/README.md)：A0 corpus 的读取和防泄漏边界。
- [../eval/a0/prompts/a0-leg3-v1.md](../eval/a0/prompts/a0-leg3-v1.md)：A0 leg-3 v1 历史 prompt。
- [../eval/a0/prompts/a0-leg3-v2.md](../eval/a0/prompts/a0-leg3-v2.md)：A0 leg-3 v2 当前冻结 prompt。

## 事实归属

- 命令与参数：`jarvis --help` 和子命令 `--help`。
- 生效配置：`jarvis config show`；配置来源与错误：`jarvis config validate`。
- 当前工作区状态：`jarvis status`；本地就绪状态：`jarvis doctor`。
- 产品范围：`PRODUCT.md`；工程与架构边界：`AGENTS.md`。
- 未发布实现变化：`CHANGELOG.md` 的 `Unreleased`。
- 当前限制：`KNOWN_ISSUES.md`。
- 一轮验证的测试数字、截图和 commit：对应日期化 handoff、work order 或 Git 历史。
