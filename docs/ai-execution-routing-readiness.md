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

## Post-v1 Source Signal: Model Council / Fusion

> 标注：post-v1 研究项。它只能影响未来只读 review、verifier 增强和 route observability；当前 R6 GUI 收口、R1-R9 发布检查和四套 trusted map 边界均不受影响。

本地剪藏 `H:\LLM本地知识库\采集\clippings\Fable 5 订阅权限又续了 5 天！与其被吊着，我找了个账单只有 13 的替代方案.md`、[OpenSquilla](https://github.com/opensquilla/opensquilla) 的 Agentic Routing 方向、Hermes MoA-style 组合，以及 [OpenRouter Fusion](https://openrouter.ai/docs/guides/routing/routers/fusion-router) 指向同一个模式：多个 proposer 并行给出候选，再由 judge / aggregator 归纳共识、分歧、缺口和独有洞察。

第一性原理判断：

- 多模型融合解决的是能力方差、偏见方差和成本方差。复杂问题里，单模型的盲点容易变成不可见失败；多模型能把失败变成可观察分歧。
- 它的代价是延迟、成本、数据外发面和审计复杂度。OpenRouter Fusion 文档也把成本和延迟标成显式 trade-off；OpenSquilla 的报告显示质量 / 成本可以更优，但 p50 / p95 延迟明显上升。
- 它适合 read-only research、架构评审、安全审查、主观质量复核和 verifier 分歧处理；不适合默认写码 executor、无人值守完成授权、急停链路或低延迟交互。

两个决定成败的第一性判据（2026-07-08 补，重开本节时先核对这两条，再看下方形态）：

- **任务形状判据**：任务能拆成独立方案再汇总的（研究、评审、验收复核），融合有收益；必须顺序依赖上一步结果的长程执行（goal/loop 写码主场景），融合只添延迟。证据：DRACO 上多模型队伍 60.82 分 vs Fable 5 59.80 分（可并行汇总的研究任务，质量打平、账单 1/3）；同一队伍在 PinchBench 上不提分、只降本 18%；延迟中位数 535s vs 188s（约 3 倍）。融合顶替的是「研究员」身份，顶替不了「操盘手」身份——Jarvis 恰是操盘手 harness，主场景在融合的弱区。
- **经济结构判据**：OpenRouter Fusion 与 OpenSquilla 表面同构（proposer + judge），成本结构相反。Fusion 用同档模型组 panel，默认 3 模型成本约为单模型 4-5 倍，花钱买质量；OpenSquilla 用低一个量级单价的模型组 panel，6 倍 token 换 1/3 账单（58 万 token/题 vs 9.4 万，$0.38/题 vs $1.21/题），用组织换成本。Jarvis 该学后者（首发已选便宜档 Doubao），但前提是存在量级级单价差可组织——当前单 provider（Doubao），该前提不成立。共同判据与下方 BYO 小节同源：让什么档位的智力干什么档位的活 = 单价差 × 任务可分性。

证据强度标注：以上数字来自单次描述性 benchmark 对比，OpenSquilla 报告自己声明并非统计显著性研究。「比 Hermes MoA 更便宜」成立；「比 MoA 更好」（60.82 vs 59.55，差 1.27 分）在描述性研究里属于噪声，不足以支撑方案选型。引用本节做决策时按快照对待，别当定论。

OpenSquilla 最值得 Jarvis 借的是 harness-native evidence flywheel：每次选择记录 operation、route state、model set、execution trace、outcome、tokens / cost、latency 和 fallback。整套自动 router 暂不适合当前 Jarvis。Jarvis 已经有 JSONL、observe、verifier report、trusted requirement routes 和 GUI timeline，天然适合先把这些信号展示清楚，再谈 selector。

### Provider adapter 与路由判断的职责边界

[Pi Agent](https://github.com/earendil-works/pi) 的分包方式提供了一个可借鉴边界：provider adapter 统一不同模型协议、流式事件和工具调用形状；任务路由继续由 harness 的产品规则决定。对 Jarvis 来说：

- provider 层只负责连接、能力声明、错误归一化和流式输出，不决定某项任务交给哪个模型；
- Jarvis 路由规则根据任务形状、所需能力、成本 / 延迟、风险和验收要求选模型，并保留可解释的 route evidence；
- 当前只有 Ark 的 OpenAI-compatible provider 接线，没有第二种异构协议需求，抽取或引入 `pi-ai` 只会增加依赖与类型转换；
- 等第二个官方 provider 或异构协议真实出现后，先做 adapter 层有界 spike，再用既有 JSONL 对成功率、park 率、成本与延迟做对照，验证通过才考虑长期采用。

Jarvis 的可融入形态按保守顺序排列：

1. **Model council as read-only review**：人工触发的多模型 / 多子代理 review panel，只产出分歧清单、盲点、风险和建议，不给 `verified`。落点已存在（2026-07-08 源码确认）：Phase C 视角评审面板（`npm run demo:c2`）就是 council 的壳；`roster.ts` 每个角色已有 `model` 字段，`subagent-manager.ts` 的 `providerFor()` 注释明写按「等第二个 endpoint 出现再路由」预留。届时是接线活（`providerFor` 按 `role.model` 路由到第二 provider），无需新建面板、不新增抽象。
2. **Verifier aggregation**：多个只读 verifier 针对同一 pinned requirements 产出 report，再合成一个保守 `VerifierReport`。任一模型指出 broken / incomplete 时不能通过；分歧、超时、覆盖不全和 `cannotVerify` 都 park；最终仍交给 `decideVerdict`。落地 gate：若需要一个 goal 配多个 verifier 而扩 `--verifier-map` schema，按 `AGENTS.md` 硬约束必须先由 Luis 明确推翻「不新增 verifier / route / scheduler 抽象」条款并先改规范，再动代码——拿着本文不构成动手授权。
3. **Route telemetry**：`observe` / GUI 展示 model、provider、verifier key、requirement route、tokens、cost、latency、park reason 和 disagreement summary。这一步先做观测，不做自动选择。
4. **Selector later, router unchanged**：等 JSONL 历史足够后，才考虑在已确定 route 内选择执行资源。selector 只能在 safety / verification route 之后运行，不能新增第 5 套 map。

试点评测方法（2026-07-08 补）：个人项目的 JSONL 量撑不起统计结论，离线评估用回归思路——挑若干已知 verdict 的历史案例（尤其对抗审查抓到过的 false-positive / 漏判），看多裁判能否抓到单裁判漏掉的问题。样本少也有效，目的是「能不能抓到已知的漏」；分歧矩阵 / park 率 / cost / latency 作为辅助观测记录，不当统计证据。

明确禁区：

- 不把 Fusion / MoA / OpenSquilla ensemble 放进 goal completion authority。
- 不让 builder 或 unattended loop 自行决定是否升级到融合模型。
- 不把 web search / fetch 型 Fusion 结果当 trusted local verification。
- 不做 self-learning router、nightly retraining 或自动权重更新。
- 不新增 `--model-route-map`、`--routing-map`、新 verifier 抽象、新 route 抽象或新 scheduler 抽象。

## Post-v1 Source Signal: 异构 builder / BYO 订阅 CLI（Tutti）

> 标注：post-v1 研究项，与 Model Council 同级。只影响未来 execution resource 档位设计；当前 R6 GUI 收口、R1-R9 发布检查和四套 trusted map 边界均不受影响。

[Tutti](https://github.com/tutti-os/tutti) 的 BYO Subscriptions 机制（本地剪藏《可算找到一个能统一管理所有Agent还不用额外订阅的开源项目了！》）指向一个执行资源方向：把用户已付费的外部 agent CLI（Claude Code / Codex）当作可复用的执行档位，边际模型成本为零。

第一性原理判断：

- **Jarvis 的验收链天然支持异构 builder**。完成授权从不来自 builder 自评（确定性三腿 + 独立 verifier + `decideVerdict`），builder 是 Doubao、Claude Code 还是 Codex，验收语义不变。这是把外部 CLI 放进 builder 位在架构上成立的根本原因。
- **真正的边界在权限层**。外部 CLI 不经过 Jarvis 的 PermissionGate 与审批闸门，其内部工具调用对 Jarvis 不可见。因此外部 CLI builder 只能跑在隔离 worktree 内、启用该 CLI 自身的沙箱/审批模式，交付仍走 `loop:finalize` 的人工 merge；不进 attended dev 的同权限位，不碰宿主 cwd。
- 适合承接 spec 明确、验收可被确定性检查覆盖的批量 goal；订阅额度省下的是纯收益。
- 与上方 Model Council / Fusion 小节共享同一判据：让什么档位的智力干什么档位的活（单价差 × 任务可分性）。Fusion 用在可并行汇总的评审 / 验收侧，BYO 用在 spec 明确的顺序执行侧——同一个组织红利的两面，别当两条独立路线重复建设。

可融入形态（保守顺序）：先只作为 execution resource 维度的一个未来档位记录；等 route telemetry 可用后，用历史 JSONL 对比外部 CLI 与当前 builder 的成功率 / park 率 / rework，再决定是否真接。

明确禁区：

- 不给外部 CLI 完成授权；其输出不进 verifier report 的 trusted 部分。
- 不在无 worktree 隔离的 unattended 场景启用。
- 不为接入外部 CLI 新增第 5 套 map 或新 route / scheduler 抽象。

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
- execution resource：current cloud builder、independent verifier、sandbox check, future local model, future async provider, future worktree-isolated external subscription CLI（Claude Code / Codex，见上方 BYO 小节）.

## Current Sprint Boundary

当前只做文档补强：

- 把 execution routing 作为未来 runtime / GUI 设计约束。
- 不新增 classifier、router、selector 代码。
- 不接本地模型。
- 不接异步推理供应商。
- 不接 Fusion / MoA / model council runtime。
- 不接外部订阅 CLI builder（Claude Code / Codex）。
- 不做 nightly feedback / 自动调权。
- 不让路由系统改写当前安全、验收和权限边界。

## Reopen Triggers

满足任一条件时，再把本文升级成具体计划：

- `status / usage / audit` 只读视图已经可用。
- token 成本或等待时间成为明确痛点。
- 某类 operation 重复出现，且成功标准稳定。
- 已有足够 JSONL 历史，能衡量 route 成功率、park 率、人工介入率。
- 本地模型或异步推理供应商已经可用，且接入成本低于当前手动选择模型。
- 出现多档单价的 provider / endpoint（单价差达到量级级或至少数倍），且目标任务可并行可汇总——多模型组织的经济前提成立（见 Fusion 小节经济结构判据）。
- GUI 需要展示队列优先级、延迟档位或 route 决策原因。

## Non-Goals

- 不把 Jarvis 变成通用企业 agent scheduler。
- 不为了成本优化削弱 `cannotVerify -> park`。
- 不把 cwd 内文件当作 routing authority。
- 不让模型自评“我适合便宜模型执行”。
- 不自动蒸馏 skill 或 nightly 修改 skill，除非 Luis 单独确认 skill 沉淀机制。
- 不引入隐藏的后台执行队列。后台/常驻行为继续走显式 `cron:daemon` 边界。
- 不把多模型 aggregator 的结论当完成授权；它最多生成可审计 evidence，再由现有 verifier / verdict 链路处理。
