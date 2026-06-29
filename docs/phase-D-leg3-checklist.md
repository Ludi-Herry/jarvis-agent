# Phase D · 腿3（LLM 裁判）实现 checklist

> **来源**：2026-06-29 对调研 Part7（Guardian 验收设计）的对抗式审查 + D5 实战抓到的 oracle-tamper（HIGH）。下文 F 编号对应 2026-06-29 当时的 Part7 版本；Part7 后续若修订，需重新对位。
> **用法**：腿3 当前 deferred。动工前/中逐条对照，每条配「怎么验证满足了」。目的是让腿3 一次做对，避开 Part7 设计稿里已暴露的漏洞，省掉「做完→审出问题→返工」。
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

## 腿3 落定后的收尾（别忘）

- 把腿3 的实际落地结论**回填调研 Part7**（标注实际选择 vs 设计稿差异）——这是之前规划里的「批3」。
- 做 **①**：对验收/goal 子系统 + 已稳定模块的安全面做一轮（对抗式）重审。
