# Loop primitive 选择指南

> 背景：2026-07-01 读 Anthropic「Getting started with loops」后补的使用层文档。结论：Jarvis 的 loop 核心能力已覆盖 turn-based / goal-based / time-based / proactive 四类；当前最需要补的是选择入口、usage 观测 backlog、保守的 skill 沉淀规则。

## 先选哪个

| 任务形态 | 交出去的东西 | Jarvis primitive | 适合场景 | 主要护栏 |
|---|---|---|---|---|
| 临时探索 / 单次修复 | check | `npm run dev` / `npm run resume` | 还在摸清上下文、需要人持续判断的任务 | 人在环审批；SessionStore JSONL 恢复 |
| 有清晰达标条件 | stop condition | `npm run goal -- "<objective>"` | 单个目标，完成标准能被测试、held-out 或裁判验证 | `GoalBudget`、确定性三腿、`decideVerdict`、`cannotVerify→park` |
| 多个可拆目标 | queue | `npm run loop -- <objectives-file>` | 一组 goal 顺序排空或用 cwd 外 worktree 并行推进 | loop 无完成授权；resume 必须显式可信 verifier/hook map；parallel 必须显式 cwd 外 worktree root |
| 外部节奏触发 | trigger | `npm run cron -- --cron-map <trusted-json>` | 到期扫描一次，触发普通 loop | cron map realpath 后拒 cwd 内；scan lock；task 必须 `unattended:true` |
| 前台常驻调度 | trigger + routine | `npm run cron:daemon -- --cron-map <trusted-json>` | 本机打开时持续轮询计划任务 | daemon lock + scan lock；JSONL；SIGINT/SIGTERM 释放锁；不后台 fork |
| loop 后人工收口 | review / apply / cleanup | `npm run loop:finalize -- --loop <id>`，按需 `--merge` / `--cleanup` | 并行 worktree 跑完后审阅、合入、清理 | 交互确认完整短语；blocked/parked/rejected/missing verdict/conflict/dirty 停下 |

## 判断顺序

1. **还需要人实时判断吗？** 用 `npm run dev`。它适合探索、定位、少量编辑，以及需要随时改方向的任务。
2. **done 可以写成一句可验证条件吗？** 用 `npm run goal -- "<objective>"`。同时给出预算，例如最多几轮、必须跑哪些检查、哪些结果算失败。
3. **目标能拆成多条互相独立的 objective 吗？** 用 `npm run loop -- <objectives-file>`。需要并行时显式给 cwd 外 `--worktree-root`；有 hooks/verifier 时一律用 cwd 外可信 map。
4. **任务来自时间或外部系统吗？** 单次扫描用 `npm run cron`；需要本机前台持续调度用 `npm run cron:daemon`。
5. **已经产生多个 worktree 结果了吗？** 先用 `loop:finalize` 只读看 report；确认后再走 `--merge`；合入审计存在且 worktree clean 后再走 `--cleanup`。

## 什么时候别上 loop

- 目标还没法验收，先回到 `dev` 或手写更清楚的 objective。
- 任务涉及 push、rebase、强删、密钥、CI/CD、数据库迁移或生产发布，先单独计划并让人确认。
- 运行态验收需要执行未知代码，当前裁判会 `cannotVerify→park`。这属于 OS sandbox 能力天花板，先交人。
- 想让无人值守 bash 自治时先停下。当前 unattended bash 仍 fail-closed，不能用 allow-list 或 cwd 配置绕开。

## usage / budget 观测 backlog

Jarvis 已经记录 session / goal / loop / cron JSONL，也通过 bus 订阅累计 usage。后续 GUI 或 CLI 可以补一个轻量观测层：

- GUI：补 `approval_request` / `approval_result` 事件，用于审批历史可观测和审计。
- GUI：补 `round` / `budget` 事件，或提供查询接口，让界面显示第几轮、剩余 token、停止原因。
- CLI：后续可加只读 `status` / `usage` 摘要，读取 session / goal / loop / cron JSONL，按 primitive 汇总 turns、tokens、halt reason、verdict。
- 约束：usage 视图只读，不给完成授权；loop 完成仍只看 `runGoal` / `decideVerdict`。

## skill 沉淀规则

文章建议把人工验证步骤写进 `SKILL.md`。Jarvis 保持更保守的策略：

- 只有重复出现、步骤稳定、能显著减少人工判断成本的流程才写 skill。
- 优先沉淀项目内具体检查：frontend visual verification、loop rollout checklist、安全 review checklist。
- 确定性步骤优先写脚本，判断性步骤再写 skill 提示。
- `propose_skill` 继续不做；需要新 skill 时由人确认场景，再按普通文件改动创建。

## 和现有文档的关系

- `README.md`：命令入口和快速选择表。
- `docs/handoff-D.md`：GoalLoop、三腿验收、`decideVerdict` 不变量。
- `docs/handoff-loop-remaining.md`：parallel resume、finalize、cron daemon 的边界和失败模式。
- `docs/handoff-next.md`：GUI 就绪、usage/budget/approval 事件 backlog、skill 自动沉淀决策。
