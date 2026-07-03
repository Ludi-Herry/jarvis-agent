# AI execution routing readiness

> 状态：路线项，只记录原则、边界和重开条件。本文不新增当前实现任务，不引入本地模型、异步推理服务或自动路由器。

## 结论

Execution routing 值得进入 Jarvis 的后续路线图。

当前阶段只补架构原则：**route before model selection**。先判断任务类型、风险、验收方式、延迟要求、上下文规模，再决定 executor / model。模型选择是路由后的执行资源选择，不能藏进 prompt 或临时环境变量里。

Jarvis 现在已经有安全路由和验收路由。下一步真正缺的是只读 `status / usage / audit` 观测层。没有历史成功率、失败原因、token、耗时、人工介入点这些数据，成本路由会变成拍脑袋分类器。

## Source Signal

Tomasz Tunguz 的 `Most AI Work Can Wait` 提出三层拆分：

- `skill classifier`：把原始请求归类成具体 operation。
- `router`：根据 operation、复杂度、上下文规模、历史成功率等信号，决定交给哪一档执行资源。
- `model selector`：在该资源档内选择满足置信门槛的最低成本模型。

文章里最有用的提醒是：classifier 是语言问题，router 是调度问题。两者混在 prompt 里，会让系统失去复盘、A/B 和成本控制能力。

## Jarvis Current Baseline

Jarvis 已经具备几类显式路由，但它们主要服务安全、验收和工作形态。

- **Primitive routing**：`dev / goal / loop / cron / cron:daemon / loop:finalize`，见 `docs/loop-primitives-guide.md`。
- **Verification routing**：goal-setter requirements 已支持 `sandbox-command / llm / human`。
- **Trusted map routing**：`--verifier-map`、`--hook-map`、`--sandbox-check-map`、`--goal-setter-requirements-map` 都要求 cwd 外可信配置。
- **Queueing**：`loop` 和 `cron:daemon` 已经能把多目标、计划触发和长流程放进队列。
- **Safety route**：危险命令、未知运行态验收、沙箱不可用等走 `ask`、`deny`、`cannotVerify -> park`，不会降级成 raw bash。

当前还没有成本 / 延迟 / 本地模型路由：

- provider 只有 Doubao。
- builder 模型主要来自 `ARK_MODEL`。
- verifier 可通过 `ARK_VERIFIER_MODEL` 或 map 异构，但这是独立性和验收质量路由。
- vision 是 opt-in 的异构工具，不是通用模型档位。
- JSONL 已记录状态，usage 事件已存在，但还没有稳定的 route-quality dashboard。

## Principle For Future Iterations

1. **Route before model**
   - 先决定执行形态，再选模型。
   - operation、risk、latency、verification route 是一等输入。

2. **Separate classifier / router / selector**
   - classifier 可以由模型辅助识别意图。
   - router 应尽量是可测试的纯函数或显式配置。
   - selector 只在 route 确定后选择最低成本可用模型。

3. **Safety route wins before cost route**
   - `deny`、`ask`、`human`、`cannotVerify` 的优先级高于省钱、省时和吞吐。
   - 成本优化不能改变 PermissionGate、sandbox、verdict 的安全语义。

4. **No prompt-hidden routing**
   - 不能只在 system prompt 里写“简单任务用小模型”。
   - 需要进入 typed config、event、JSONL audit 或纯函数测试，才能成为 runtime 行为。

5. **Observability first**
   - 在自动路由前，先能查看每个 run 的 route、模型、token、耗时、失败原因、人工介入点和最终 verdict。
   - `status / usage / audit` 视图只能观察，不能授权完成。

## Future Route Dimensions

后续真正设计 router 时，优先考虑这些输入：

- operation：read-only research、code edit、review、visual check、runtime verification、cleanup。
- latency class：interactive、near-real-time、queued、overnight。
- risk class：read-only、writes code、runs code、touches secrets、external network、destructive.
- verification route：sandbox-command、llm、human、held-out、cannotVerify.
- context size：small file set、repo-wide、multi-repo、external knowledge.
- historical outcome：success rate、park rate、human override rate、rework count.
- cost signal：input / output tokens、verifier tokens、vision calls、wall time.
- execution resource：current cloud builder、independent verifier、sandbox check, future local model, future async provider.

## Current Sprint Boundary

当前只做文档补强：

- 把 execution routing 作为未来 runtime / GUI 设计约束。
- 不新增 classifier、router、selector 代码。
- 不接本地模型。
- 不接异步推理供应商。
- 不做 nightly feedback / 自动调权。
- 不让路由系统改写当前安全、验收和权限边界。

## Reopen Triggers

满足任一条件时，再把本文升级成具体计划：

- `status / usage / audit` 只读视图已经可用。
- token 成本或等待时间成为明确痛点。
- 某类 operation 重复出现，且成功标准稳定。
- 已有足够 JSONL 历史，能衡量 route 成功率、park 率、人工介入率。
- 本地模型或异步推理供应商已经可用，且接入成本低于当前手动选择模型。
- GUI 需要展示队列优先级、延迟档位或 route 决策原因。

## Non-Goals

- 不把 Jarvis 变成通用企业 agent scheduler。
- 不为了成本优化削弱 `cannotVerify -> park`。
- 不把 cwd 内文件当作 routing authority。
- 不让模型自评“我适合便宜模型执行”。
- 不自动蒸馏 skill 或 nightly 修改 skill，除非 Luis 单独确认 skill 沉淀机制。
- 不引入隐藏的后台执行队列。后台/常驻行为继续走显式 `cron:daemon` 边界。
