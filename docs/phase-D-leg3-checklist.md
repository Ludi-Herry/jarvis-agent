# Phase D · 腿3（LLM 裁判）实现 checklist

> **来源**：2026-06-29 对调研 Part7（Guardian 验收设计）的对抗式审查 + D5 实战抓到的 oracle-tamper（HIGH）。下文 F 编号对应 2026-06-29 当时的 Part7 版本；Part7 后续若修订，需重新对位。
> **用法**：腿3 当前 deferred。动工前/中逐条对照，每条配「怎么验证满足了」。目的是让腿3 一次做对，避开 Part7 设计稿里已暴露的漏洞，省掉「做完→审出问题→返工」。

> **落地状态（2026-06-29 腿3 已实现，D6–D9；held-out 腿后续补，见 #1）**：5 条全部对照执行，落地与偏差如下。
> - **#1 held-out**：✅ **已落地**（D6–D9 之后单独补 + 经两裁判对抗复核加固）。新增真正的 held-out 腿：goal-setter 提供的**秘密**校验命令（`JARVIS_HELDOUT_CHECKS_FILE` / `deps.heldOutCommands`），builder 从不见到（不进 context/continuation/EventBus），harness 跑它采信真退出码，只在 leg1 绿后跑、失败→rejected（rationale 泛化不泄露）。缺席时 CLI 显式声明「置信偏弱、建议加权人工抽查」。`demo:d3` 活体 + 确定性双相验证（真活 verified / 伪造被抓 rejected）。**复核抓出并修的 2 个 HIGH**（两裁判收敛 + codex 独立）：① held-out 命令/输出经 cwd 内 goalStore 泄露 → 持久化前收缩为 `{passed, results:[]}`；② `JARVIS_HELDOUT_CHECKS_FILE` 留在 builder bash 环境 → 读毕即从 process.env 删除。**残留**：秘密文件须放 cwd 外（goal-setter 责任，文档已注明）；model-facing bash 仍继承 `ARK_API_KEY` 等密钥（pre-existing follow-up，给 builder bash 传脱敏 env）。
> - **#2 主客观分流**：◐ **部分**。当前所有 pinned 都交裁判逐条打分（裁判不可缩小清单——分流的「防作弊覆盖面」目的已达）；「有可执行验收命令→客观不 spawn」的省算力分流未做（下一步）。
> - **#3 熔断 couldNotVerify 归属**：✅ 延续 D3 取舍——**只留连续 3 阈值、放弃滑窗**（couldNotVerify→blocked 已交人、不入窗）；腿3 reject 真触发熔断有 integration 单测。另加 `VerifierMonitor` 管 couldNotVerify **率**监控（与熔断正交）。
> - **#4 不同模型**：✅ 降为 nice-to-have；载重独立性靠腿1/腿2（无模型）+ 上下文隔离（runVerifier 不喂 builder transcript）+ 独立 prompt；`resolveVerifierConfig` 同模型→不启用 + 告警。已实测同族(2.0 vs 2.1)与跨家族(DeepSeek-V4)均跑通。
> - **#5 oracle 篡改检测**：✅ D5 已修并延续（腿2 含 check-oracle 文件）。policy.md 本实现未引入（裁判 prompt 内联固定，无外部可改 policy 文件），故「policy.md 放宽」攻击面不存在。
> - **#6 能力边界**：✅ 裁判定死为**纯文件取证**（read/grep），prompt 与白名单一致、运行态需求恒列 couldNotVerify；健康监控降级为「告警事件 + park」（无自动换模型，删自动表述）。
> **背景**：当前 verified = 确定性两条腿（腿1 四关卡真退出码 + 腿2 测试篡改检测）。腿3 = 对主观项 spawn 独立只读 LLM 裁判。下列 5 条是腿3 设计/实现的已知坑。

## 总原则

审查价值在事前预防。这 5 条不是「将来 review 再查」，是腿3 编码时的输入约束。每条都要有**触发路径单测**——guardrail 这种「平时不触发」的代码若没有触发测试，就是「绿灯≠成功」的活样本（CodePilot doom-loop 漏写 break、CodeWhale 计数器只自增不读，都是前车之鉴）。

---

## 1. 别用「重跑 canonical check」冒充 held-out（堵自写弱测试通道）

- **风险**：Part7 把三件套里的 held-out 测试悄悄换成了「腿1 重跑既有 check」。两者不是一回事——重跑只证「既有套件过」，held-out（builder 没见过的隐藏断言）才防「builder 自己写弱测试骗过套件」。拼起来是完整捷径：写功能 + 自写 trivial 测试 → 腿1 全绿 → 腿2 没删测试干净 → 若该需求判为「客观项」则腿3 不 spawn → 直接 verified。
- **腿3 要做**：要么真加一条 harness 侧 held-out / hidden-assertion 腿（哪怕「可行处才加」也要进主流程，别只在风险登记提一句）；要么显式声明 held-out 缺位、标成已知风险，并据此加权依赖人工抽查。别再叫「三件套」却只做两件。
- **怎么验证**：构造「功能假实现 + 自写弱测试」的 fixture，确认它**不会**被判 verified。
- **来源**：Part7 审查 F1。

## 2. 主观/客观分流必须是 harness 钉死的确定性规则（堵全标客观绕开裁判）

- **风险**：Part7 说「仅主观项才 spawn 裁判」，但谁、按什么规则把需求判成主观/客观，全篇没定义。若由 builder 或非确定性流程分类，builder 把需求全标「客观」就彻底绕开腿3。这个分流同时是省钱杠杆（裁判烧不烧 token）和防作弊覆盖面（有没有 LLM 兜底）的命门。
- **腿3 要做**：分流做成 harness 钉死的确定性规则（如：有可执行验收命令 → 客观；涉及视觉/语义/外部状态 → 主观），写进 PinnedRequirement，goal 创建时固定、builder 不可改。
- **怎么验证**：分流是纯函数 + 单测；尝试让 builder 改分流标志，确认改不动。
- **来源**：Part7 审查 F3。

## 3. 熔断器：couldNotVerify 的归属要和文字一致，并配触发单测

- **风险**：Part7 §6.1 文字说「couldNotVerify 计入熔断窗口」，但 §3.3 接线代码两条计数都不调它——couldNotVerify 既不进 reject 也不进 nonReject，于是「8-of-20 滑窗靠 reject/couldNotVerify 交替可达」不成立，滑窗很可能又是死/不可达 guardrail（正是 Part7 自称修掉的那类反模式）。
- **腿3 要做**：二选一——让 couldNotVerify 真的入窗（与文字对齐），或干脆删滑窗只留连续阈值（Part7 自己也给了这个备选）。无论哪种，补一条「让熔断真触发」的 integration 单测。
- **怎么验证**：构造连续 reject、以及 reject 与 couldNotVerify 交替两种序列，确认熔断都能按设计触发 → halt → blocked。
- **来源**：Part7 审查 F5（呼应 D3 circuit breaker 已「只留连续阈值、放弃滑窗」的取舍——确认这个取舍延续到腿3）。

## 4. 「不同模型裁判」别押注，独立性靠腿1/腿2 + 上下文隔离

- **风险**：Part7 用 `verifierModel !== builderModel` 作独立性硬断言之一（与"不喂 builder transcript + isolation"并列），但：① 单一 Doubao 下两个 Doubao 变体同源、独立性弱，字符串不等给的是假信心；② `role.model` 这条 seam 在 Phase D 接不通（项目记忆已记），是实现腿3 时的已知坑（腿3 deferred 本身是分批范围决策，与此 seam 无因果）。
- **腿3 要做**：把「不同模型」从独立性主保证降为 nice-to-have；明说载重独立性来自 **腿1/腿2（完全无模型、不可注入）+ 上下文隔离（isolation、不喂 builder transcript）+ 独立 system prompt**。assert 升级为「同 provider 同族 → 标 `independence: weak`，据此加权依赖确定性腿」。若真要强独立的第二模型，得显式配第二 provider（多一组 key + 成本），把这个权衡写进设计、别默认 `model: cfg.verifierModel` 就能换。
- **怎么验证**：腿3 在「裁判 = 另一个 Doubao 变体」配置下能跑通且不假装强独立；断言 verifier provider 实例 ≠ builder。
- **来源**：Part7 审查 F2 + 项目记忆「腿3 用另一 Doubao 不能靠 role.model 的 provider seam」。

## 5. 确定性腿的可信根本身要纳入篡改检测（堵 oracle-tamper）

- **风险**：D5 实战抓到的 HIGH——builder 改 `package.json` 的 `"test"` 脚本（如 `exit 0`）就能让腿1 四关卡全绿，且原腿2 看不到。「裁判的可信根可被运动员中性化」。已在 D5 修（腿2 纳入 check-oracle 文件篡改检测），但 Part7 设计稿没吸收这个教训。
- **腿3 要做**：确定性腿的可信根——`package.json` 的 test/build 脚本、`tsconfig`、`vitest`/`eslint` config、腿1 的 check 命令定义、Part7 的 `policy.md`——全部纳入腿2 的篡改检测；check 命令与 policy.md 在 goal 创建时钉死或哈希校验，与 objective 同等待遇（Part7 把 objective 设为不可变，却让「跑什么 check」实时从 builder 可写的仓库读，是漏洞 F4）。
- **怎么验证**：构造「改 test 脚本为 exit 0」「放宽 policy.md anti-cheat 行」两个 fixture，确认都被腿2 拦成 rejected。
- **来源**：D5 oracle-tamper（已修）+ Part7 审查 F4。

## 6. 先定清裁判的能力边界 + 健康监控接线（堵"定义了没接线"的死代码）

- **风险**：① Part7 §3.4 给裁判的工具白名单是 `[Read, Grep, Glob]`（只能读文件），但 §5.1 prompt 又说"prefer read-only checks"、§9 说"驱动真实 app read-only"——白名单里没有执行类工具，裁判其实跑不了命令、驱动不了 app，prompt 会误导模型以为能执行（F7）。② §6.3 verifier 健康监控只 `emit` 一个 degraded 事件，正文宣称的"换模型/重试"没有消费端接线，又是一处"定义了不调用"的潜在死代码（F6）。
- **腿3 要做**：实现前先定死**裁判是纯文件取证、还是能跑只读命令/浏览**——若纯取证，prompt 删掉"checks/execute"措辞、把"跑命令/驱动 app"明确列为恒进 couldNotVerify；若要跑只读命令，显式加一个沙箱化只读 exec / BrowseReadOnly 工具并按 network-capable 收紧。健康监控的补救动作（换模型/重试/park）要么真接线 + 触发单测，要么降级为"告警 + park 给人"并删掉自动表述。
- **怎么验证**：裁判工具白名单与 prompt 措辞一致（说能跑就真给得了工具）；健康 degraded 事件有消费端或明确人工兜底，配触发单测。
- **来源**：Part7 审查 F7 + F6。

---

## 腿3 落定后的收尾

- ✅ **实际落地 vs Part7 设计差异**：已记在本文件顶部「落地状态」段（逐 F-item）+ `docs/handoff-D.md` 的 D9 独立核查结论。**没有回填知识库 Part7 原文**——它在 `H:\LLM本地知识库\采集\` 里，按知识库自身 AGENTS.md 是**只读证据层**（AI 不改）。要把腿3 落地消化成知识库 Wiki 页是一次 ingest 操作，需用户显式发起（「存进知识库」）。设计 vs 现实的权威记录在本仓库（本文件 + handoff）。
- ✅ **做 ①**：D9 已对验收/goal 子系统做对抗式重审（codex gpt-5.5 xhigh + 独立 Claude 子代理两裁判），收敛在 runVerifier 超时缺口 + credential 单数漏拦，均已修，见 `docs/security-review-baseline.md` 的「Phase D 腿3 轮」。
