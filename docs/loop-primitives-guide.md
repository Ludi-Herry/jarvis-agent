# Loop primitive 选择指南

> 类型：持续维护的入口选择指南。按任务交付物、停止条件和人工介入方式选择 primitive；具体参数以对应子命令的 `--help` 为准。

## 先选哪个

| 任务形态 | 交出去的东西 | Jarvis primitive | 适合场景 | 主要护栏 |
|---|---|---|---|---|
| 临时探索 / 单次修复 | check | `npm run jarvis -- run [prompt]` / `resume [id]` | 还在摸清上下文、需要人持续判断的任务 | 人在环审批；SessionStore JSONL 恢复 |
| 有清晰达标条件 | stop condition | `npm run jarvis -- goal "<objective>"` | 单个目标，完成标准能被测试、held-out 或裁判验证 | `GoalBudget`、确定性三腿、`decideVerdict`、`cannotVerify→park` |
| 多个可拆目标 | queue | `npm run jarvis -- loop <objectives-file>` | 一组 goal 顺序排空或用 cwd 外 worktree 并行推进 | loop 无完成授权；resume 必须显式可信 verifier/hook map；parallel 必须显式 cwd 外 worktree root |
| 外部节奏触发 | trigger | `npm run jarvis -- cron run --cron-map <trusted-json>` | 到期扫描一次，触发普通 loop | cron map realpath 后拒 cwd 内；scan lock；task 必须 `unattended:true` |
| 前台常驻调度 | trigger + routine | `npm run jarvis -- cron daemon --cron-map <trusted-json>` | 本机打开时持续轮询计划任务 | daemon lock + scan lock；JSONL；SIGINT/SIGTERM 释放锁；不后台 fork |
| loop 后人工收口 | review / apply / cleanup | `npm run jarvis -- finalize --loop <id>`，按需 `--merge` / `--cleanup` | 并行 worktree 跑完后审阅、合入、清理 | 交互确认完整短语；blocked/parked/rejected/missing verdict/conflict/dirty 停下 |
| 运行态观察 | status / usage / audit | `npm run jarvis -- status`，按需 `--json` | 汇总 session / goal / loop / cron JSONL 和 sandbox audit evidence | 只读；不能给 goal/loop 完成授权 |

## 判断顺序

1. **还需要人实时判断吗？** 用 `npm run jarvis -- run`。它适合探索、定位、少量编辑，以及需要随时改方向的任务。
2. **done 可以写成一句可验证条件吗？** 用 `npm run jarvis -- goal "<objective>"`。同时给出预算，例如最多几轮、必须跑哪些检查、哪些结果算失败。
3. **目标能拆成多条互相独立的 objective 吗？** 用 `npm run jarvis -- loop <objectives-file>`。需要并行时显式给 cwd 外 `--worktree-root`；有 hooks/verifier 时一律用 cwd 外可信 map。
4. **任务来自时间或外部系统吗？** 单次扫描用 `jarvis cron run`；需要本机前台持续调度用 `jarvis cron daemon`。
5. **已经产生多个 worktree 结果了吗？** 先用 `jarvis finalize --loop <id>` 只读看 report；确认后再走 `--merge`；合入审计存在且 worktree clean 后再走 `--cleanup`。

**objective 拆多细的量化依据（2026-08-17）**：单步成功率沿链路连乘衰减——单步 90% 的五步链路整体只剩约 59%（0.9⁵ ≈ 0.59）。所以 objective 拆小、每条独立可验收，长链任务靠 loop 逐条验收串联，别塞进单条 goal 硬扛。

## 什么时候别上 loop

- 目标还没法验收，先回到 `dev` 或手写更清楚的 objective。
- 任务涉及 push、rebase、强删、密钥、CI/CD、数据库迁移或生产发布，先单独计划并让人确认。
- 运行态验收需要执行未知代码，当前裁判会 `cannotVerify→park`。这属于 OS sandbox 能力天花板，先交人。
- 想让无人值守 bash 自治时先停下。当前 unattended bash 仍 fail-closed，不能用 allow-list 或 cwd 配置绕开。

## usage / budget 观测

Jarvis 的只读入口是 `npm run jarvis -- status`，兼容脚本为 `npm run observe`。它读取 session / goal / loop / cron JSONL，并从 verifier report evidence 里提取 sandbox audit 摘要；默认输出文本，`--json` 输出给 GUI 或脚本使用。

- 事件：attended `goal` / `loop` 已 emit `approval_request` / `approval_result`，并写入 `data/approvals/*.jsonl`，用于审批历史可观测和审计。
- 事件：`runGoal` 已 emit `goal_round_start` / `goal_round_end`，包含轮次、turn/token 累计、可选总预算、claim/verdict/state，供 GUI 展示进度。
- CLI：`npm run jarvis -- status --data-dir <path>` 可看非默认 data 目录；`npm run jarvis -- status --json` 用于机器读取。
- GUI：`npm run gui` 已接 `ObservationReport.activity.recent`、聚合状态、急停、审批历史和 human-review 裁决。
- 约束：observe 视图只读，不给完成授权；goal/loop 完成仍只看 `runGoal` / `decideVerdict`。

## Goal 完成后的毕业判断

只验证过一次的目标，只能算一条带时间戳的假设。未来若真实维护反复需要重验同一不变量，可以再评估 `standing goal`；这属于 post-v1 持续健康能力，当前没有实现任务。

毕业条件写死：

- 必须有一条可重跑 predicate，最好是 shell 命令，`exit 0` 表示不变量仍成立。
- predicate 必须只读、可解释、低 flaky；容易受网络、时间、随机数据影响的检查先隔离，别登记成常驻目标。
- 违约时只报警、park 或列出嫌疑清单，例如 last-pass 以来合入了什么；sentinel 不自动修复。
- builder 不能自己改 predicate 后自证通过；完成授权仍来自现有 trusted requirements、deterministic checks、human review 与 `decideVerdict`。
- 形容词目标不算 goal，例如“更稳定”“体验更好”。先把它们定义成可检查条件，再考虑登记。

未来实现时复用现有机制：`cron:daemon` 负责调度，trusted `goal-setter-requirements` 仍放 cwd 外，`sandbox-command` 执行只读 predicate，`observe` 汇总 JSONL 结果。repo 内 `goals/<name>.md` 只能作为候选说明或人读文档，不能当完成授权来源；不新增 verifier / route / scheduler 抽象。

## skill 沉淀规则

文章建议把人工验证步骤写进 `SKILL.md`。Jarvis 保持更保守的策略：`propose_skill` 继续不做；需要新 skill 时由人确认场景，再按普通文件改动创建。

边界先分清：

- **Skill**：教 agent “怎么做”，适合流程、检查清单、领域判断、gotchas。
- **Tool**：给 agent 一个明确可执行动作，带输入 schema、权限分类和 side effect。
- **MCP**：让 agent 够到外部数据源或应用，例如 issue、数据库、浏览器、设计工具。
- **Subagent**：独立上下文、独立指令、受限工具面的专用 agent，适合 fresh-context review 或分工探索。

手动 skill 毕业条件：

- 只有重复出现、步骤稳定、能显著减少人工判断成本的流程才写 skill。
- 优先沉淀项目内具体检查：frontend visual verification、loop rollout checklist、安全 review checklist。
- 确定性步骤优先写脚本，skill 只负责何时用、怎么判断、如何验收。
- 保留流程约束、验收标准、禁区和 gotchas；删除替模型做微观决策的旧模型式碎步骤。
- 不写“展示思考过程 / 解释推理”这类要求；需要过程证据时改收集结构化产物、命令输出或审查报告。
- 未来若重开自动沉淀，必须先证明有重复信号、held-out 验证、安全审查和人审 gate；不能让 agent 自评自改后自动注册。

## 和现有文档的关系

- `README.md`：安装、首次运行和常用入口。
- `docs/handoff-D.md`：GoalLoop、三腿验收、`decideVerdict` 不变量。
- `docs/handoff-loop-remaining.md`：parallel resume、finalize、cron daemon 的边界和失败模式。
- `docs/handoff-next.md`：GUI 就绪、observe 入口、usage/budget/approval 事件 backlog、post-v1 standing goals 和保守 skill 沉淀准则。
