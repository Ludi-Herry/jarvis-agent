# 交接：Phase D 完成（GoalLoop + 三条腿独立验收，2026-06-29）

> 类型：历史阶段快照。本文保留 GoalLoop 与三腿验收的落地证据；当前完成授权边界以 `AGENTS.md` 和 `src/capabilities/goal/verdict.ts` 的 `decideVerdict` 为准。

给接手者（人或 AI）。读完这页你应知道：Phase D 两批做了什么、关键决策与 gotcha、验收怎么映射到测试、安全边界、怎么运行、下一步。完整设计见 `phase-D-plan.md`（第一批）+ Plan agent spec（第二批，已落地）；C 阶段见 `handoff-C.md`；项目规则见根 `AGENTS.md`。

## 一句话状态

**Phase D 全部完成**：agent 能**自主跑 goal 到达标自停**——`update_goal(complete)` 不直接终态化，走**确定性三腿 + 独立 LLM 裁判**验收：① 腿1 harness 重跑 canonical check 采信真退出码（builder 知道的检查）、② 腿2 git diff 测试/oracle 篡改检测、③ **held-out 腿**（goal-setter 的**秘密**隐藏断言，builder 从不见到——堵「自写弱测试骗过套件」）、④ **腿3 独立只读 LLM 裁判**（第二个不同模型，对 pinned 清单逐条取证打分）。完成判定**由 `decideVerdict` 纯函数据证据算、不靠 builder 自评、不靠 LLM 自报 verdict**。`npm run typecheck / lint / test / build` 全绿（**527 测试**，较 batch-1 的 446 再 +81）。`demo:d1` 确定性路径；`demo:d2` 双 Doubao 模型腿3 → verified；`demo:d3` held-out（真活 verified / 伪造被秘密闸抓 rejected）。

> **两批边界**：腿3 = **可选**（配 `ARK_VERIFIER_MODEL` 为不同模型才启用）。没配 → 退回第一批两腿（`decideVerdict(report===undefined)` 路径逐字不动）。所以第一批的「确定性两腿」仍是默认运行模式、未被替换。

## 架构一句话

**GoalLoop = runAgent 之上的目标驱动外循环，runAgent 完全不需知道 goal 存在**。`runGoal` 持有一个 messages 数组 + 一个 bus + 一个 claim 闭包槽：每轮跑 `runAgent`（builder + `update_goal` 工具，复用同一 messages）→ builder claim complete 写进闭包、约定调完即停 → runAgent 干净返回 → `runDeterministicChecks`（腿1+腿2）+ `decideVerdict` → `advanceGoalState`：rejected 把腿1 实测 observed 包成 `<verification_feedback>` user 消息续跑 / verified 完成 / couldNotVerify/blocked 交人。

## 各里程碑（含 commit）

| 里程碑 | commit | 内容 |
|---|---|---|
| D1 类型 + 纯函数 + 持久化 | ba5424e | `goal.ts`（Goal 不可变 objective+hash / 状态机 / GoalBudget / DeterministicChecks / VerifierReport[腿3 deferred]）+ `state.ts`（advanceGoalState assertNever）+ `verdict.ts`（decideVerdict 两腿+显式 verified 分支+fail-closed 兜底）+ `goal-store.ts`（GoalRecord/parse/replay/FileGoalStore/hashObjective）+ EventBus 扩展 |
| D2 确定性两条腿 + runCommand | b0bbf4f | `run-command.ts`（从 bash.ts 抽 execute→runCommand，bash 零回归）+ `checks.ts`（腿1 重跑 check 采信真退出码 + 纯 classifyTestDiff 腿2） |
| D3 update_goal + GoalLoop + 熔断 | 2a6b84d | `update-goal-tool.ts`（read-only/enum/闭包 claim/takeClaim/防 reward-hacking 描述）+ `goal-loop.ts`（runGoal + VerifierCircuitBreaker 真接线）+ assertObjectiveUnchanged |
| D4 CLI goal 模式 + demo | 7ee36d0 | `goal-cli.ts`（独立入口 `npm run goal`，交互 approver + git baseline）+ render 新事件 + `demo:d1` 真连 Doubao PASSED |
| D5 收口 | ef2ac03 | 验收映射 + 本交接 + README/AGENTS 刷新 + 独立核查（两裁判核出并修 oracle 中性化 HIGH）+ memory |
| **— 第二批 · 腿3 独立 LLM 裁判 —** | | |
| D6 类型 + 纯函数 | （本批） | `Goal/GoalSpec/GoalCreatedRecord/replayGoal` 加 `pinned`（`?? []` 兜底，第一批不受影响）+ `decideVerdict(checks, report?, pinned?)` 完整三态（§3.2 八步，`report===undefined` 整支逐字不动）+ verdict 全分支触发测试 + 属性测试 |
| D7 runVerifier + pinned 推导 | （本批） | `verifier.ts`（runVerifier 复用 runAgent：只读 registry+断言、第二 provider、独立 bus、无 store/无 gate、信号透传、VERIFIER_PROMPT；`parseVerifierReport` 三段+fail-closed；**永远返回 report，绝不 undefined**）+ `requirements.ts`（derivePinnedRequirements，builder model 推导，失败 `[]`） |
| D8 接线 + CLI + demo | （本批） | runGoal 接腿3（短路 spawn + 最高优先级不变量 + verdict 事件 redact）+ `resolveVerifierConfig`（config 层独立性断言）+ goal-cli（ARK_VERIFIER_MODEL + derive + 空 pinned 启动期 fail-closed）+ `demo:d2`（双模型，PASSED ×2 含跨家族）。〔D8 曾加 `VerifierMonitor`（CNV 率），#6 收口时证实其 per-goal 不可达、已删，见下文〕 |
| D9 收口 | ef2ac03→f2e6e15 | 验收映射 + 本交接刷新 + 设计 vs 现实差异记进 leg3-checklist（KB Part7 是只读证据层、不改）+ 独立核查（两裁判，修超时/credential/边界 3 处）+ memory |
| **— held-out 腿（checklist #1）—** | | |
| held-out 隐藏断言腿 | （本提交） | 真正的 held-out 腿：`HeldOutResult`/`checks.heldOut` + checks.ts 跑秘密命令（leg1 绿才跑、采信真退出码）+ verdict.ts held-out 闸（泛化 rationale 不泄露）+ goal-loop 接线（legsClean 含 held-out、短路 leg3、保密 continuation）+ goal-cli `JARVIS_HELDOUT_CHECKS_FILE` + 缺席显式声明 + `demo:d3`（活体+确定性双相）+14 测试 |

## §5 验收契约 → 测试映射（全绿）

| 验收条目 | 覆盖测试 / 证据 |
|---|---|
| 1 自主续跑到达标自停 | `goal-loop` "completes only when…clean checks" · `demo:d1`（真连 Doubao，objective→build→verify→complete） |
| 2 不信自评（claim 必过两条腿） | `goal-loop` "does NOT complete when leg 1 fails" · "does NOT complete when tests tampered" |
| 3 防删测试凑绿 | `checks` `classifyTestDiff`（deleted / skip-only / count-drop）· `verdict` "rejected when tests tampered" |
| 4 objective 不可变 | `goal-loop` "assertObjectiveUnchanged…throws for a changed one" |
| 5 熔断非死代码 | `goal-loop` **integration** "halts to blocked after 3 consecutive rejects before maxRounds"（calls==3 + guardrail event）· 类级 trips/latch/reset |
| 6 fail-closed | `verdict` "verified ONLY when both legs clean AND no report" · 属性测试 "verified ⇒ 两腿clean" · "a present report is fail-closed" |

防作弊：每道护栏（腿1/腿2/熔断/objective/fail-closed 兜底）都有「真触发」单测；无删/skip 测试。

### 第二批 · 腿3 防作弊契约 → 触发单测（全绿）

| 风险 | 防线 | 触发测试 |
|---|---|---|
| 裁判被注入 override 判 verified | decideVerdict 先判腿1/腿2（确定性不可绕）；schema 无 `verdict` 字段、parse 剥离自报 | `verdict` "injected report cannot bypass the deterministic legs" · `verifier` "ignores a self-reported verdict field" |
| **腿3 启用时 runVerifier 失败假阳性 verified**（最高优先级不变量） | runVerifier 返回类型非可选、失败合成 couldNotVerify report；runGoal 短路保证「两腿干净+启用 ⇒ report 必有值」 | `goal-loop` "NEVER falls through to verified when the verifier fails" · `verifier` "halted/throwing judge → couldNotVerify, never undefined" |
| 裁判自我缩小需求 | pinned 创建期钉死；decideVerdict 第3步 + parse 双重覆盖校验 | `verdict` "couldNotVerify when a pinned requirement is unscored" · `verdict` "decideVerdict is the sole source of verdict" |
| 空 pinned → verified 可达 | decideVerdict 第7步 `pinned.length>0` 守门；goal-cli 启动期空清单 fail-closed | `verdict` "empty pinned list … is couldNotVerify" |
| 裁判越权/读密钥 exfil | registry 只读+断言；secret 路径工具层拦（ungated 也拦）；verdict 事件 rationale redact、full report 只进 goalStore | `verifier` "buildVerifierRegistry read-only" / "no write, no bash" |
| 分流（省算力 + 不给注入面） | 腿1/腿2 挂不 spawn 裁判 | `goal-loop` "short-circuits without spawning the judge when leg 1 fails" · "spawns the verifier after the deterministic legs pass" |
| 同模型独立性表演 | resolveVerifierConfig：verifier===builder → 不启用 + 响亮告警 | `config` "disabled when the verifier model equals the builder model" |
| ~~CNV 率监控失真~~（#6 收口删除） | ~~monitor 只在腿3 真跑轮次 record~~ → **删**：per-goal monitor 不可达（couldNotVerify 终态、单 goal 凑不够样本），是 #6 要消灭的死 guardrail；跨 goal 监控待 Loop 调度落地再加 | — |
| 熔断（腿3 reject 路径） | recordReject 真读返回、连续 3 → halt → blocked | `goal-loop` "a leg-3 reject … breaker really halts after 3" |

## 关键决策

- **裁判≠运动员，走确定性两条腿**（用户拍板）：完成判定不信 builder 自报 status——腿1 harness 真重跑四关卡采信真退出码，腿2 检测测试篡改。最防作弊、不需第二模型、最便宜。
- **GoalLoop 不改 runAgent**：runGoal 是外循环，runAgent 仍是注入式单消息内循环、不知道 goal。复用同一 messages（builder 看到上轮 + 反馈），continuation 注入成可持久、可压缩的 user 消息；systemAddendum 不承载这类反馈。
- **腿1 命令只从 config，绝不沾 claim**：`checkCommands` 来自 deps（缺省四关卡常量），builder 的 `verification` 只当提示——堵「报个 trivial 命令蒙混」。腿1 不过 gate（harness 自发起的固定命令，builder 不可控）。
- **decideVerdict 兜底永不默认 verified**：verified 仅「两腿 clean && report===undefined」显式分支；任何未识别组合 → couldNotVerify。
- **熔断真接进 runGoal**（修 Part7 P0-2 死代码）：两条 reject 路径都经 `recordReject` 读返回，连续 3 reject → halt → blocked。
- **目录**：goal 全在 `src/capabilities/goal/`（含 goal-store，不放 runtime/goal/）——避免 runtime→capabilities 反向循环。

## verified 的诚实边界（重要，两种模式分清）

完成判定有**两种运行模式**，verified 的含义不同：

- **腿3 启用（配了不同的 `ARK_VERIFIER_MODEL`）**：verified = 四关卡全绿 + 测试/oracle 未篡改 + **独立裁判逐条证明每条 pinned 需求 proves+matched、feature works、无 couldNotVerify**。这才是「真验收」——拦得住「写了通过 check 但没真做到 objective」。但仍有**已知边界**：① 裁判是**纯文件取证**（只有 read/grep），跑不了命令、驱不动 app——凡需执行/运行态的需求裁判用 **`cannotVerify`** strength + 列 `couldNotVerify`，`decideVerdict` **确定性** park（→ blocked 交人），不会假装验过、也**不会当硬反证 reject 把 builder 白循环**（checklist #2 修的 bug：`cannotVerify`→couldNotVerify；`contradicts`=实证坏才优先 reject；`incomplete/missing`=实证残缺才 reject）；② 单 Doubao 账号下「不同模型」多是同族变体，**独立性弱**（载重独立性靠腿1/腿2 完全无模型 + 上下文隔离 + 独立 prompt，「不同模型」是 nice-to-have，见 checklist #4）；跨家族（DeepSeek-V4-pro）独立性更强、已验证可跑通。
- **腿3 未启用（默认）**：verified = **确定性腿**（腿1 + 腿2 + held-out，若配）。`decideVerdict(checks, report?, pinned?)` 的 `report===undefined` 整支**逐字保留**第一批语义（只是多被 held-out 闸 gate）——默认、未被替换。无 held-out 时拦不住「通过 check 但没真做到 objective」，要确定性兜那层就配 held-out，要语义兜就配 `ARK_VERIFIER_MODEL`。

- **held-out 腿（确定性、堵自写弱测试）**：goal-setter 的**秘密**隐藏断言，builder 从不见到（不进 context/continuation/EventBus），harness 跑它采信真退出码、只在 leg1 绿后跑、失败→rejected。它是 checklist #1 想要的「真 held-out」——leg1 重跑只证「既有套件过」，held-out 才防「builder 自写 trivial 测试骗过套件」。**缺席 = 显式弱置信**（CLI 声明、建议加权人工抽查），不当通过。**保密责任**：秘密文件 + 它引用的测试须放 cwd **外**（builder read/grep confined to cwd），否则 builder 能读到就能游戏——harness 只保证不把命令/输出放进 builder 上下文。

**最高优先级不变量（务必保住）**：腿3 启用且确定性腿干净时，`runVerifier` **永远返回一个 report**（spawn/parse/timeout/halted 全合成 couldNotVerify，返回类型非可选），所以 `decideVerdict` 永远拿到 report、永不回落到 `report===undefined → verified` 假阳性。改 goal-loop 接线时别破这条（回归测试 `NEVER falls through to verified when the verifier fails` 钉死）。

## 安全（goal 验收不被绕）

完成判定的防作弊靠结构保证，各有触发单测：① claim 不终态化、必跑确定性腿；② checkCommands / heldOutCommands 只从 config、采信真退出码；③ **held-out 秘密断言 builder 看不到**（堵自写弱测试，泛化 continuation 不泄露）；④ 熔断真接线 + objective 不可变 assert + fail-closed 兜底 + 腿3 永返回 report。

**独立核查**：D5 跑两个独立裁判（codex gpt-5.5 xhigh + 独立 Claude 子代理），聚焦「goal 验收有没有被绕 / 熔断是否死代码 / verified 是否悄悄可达 / builder 能否换 trivial check」。结论见下。

> **独立核查结论（2026-06-29，两个独立裁判）**：codex（gpt-5.5 xhigh）+ 独立 Claude 子代理**各自独立**抓到同一个 HIGH——**检查命令的 oracle 可被 builder 中性化**：腿1 跑的 `npm test/build` 等，其定义在 `package.json` scripts / tsconfig / eslint/vitest config，这些文件原不在腿2 的 `test/` 监控范围；builder 改 `package.json` 的 `"test":"exit 0"` 就能让四关卡全绿且腿2 看不到 → 假 verified（走配置而非 test/ 文件）。**已修**：腿2 把 check-oracle 文件（package.json/lockfile/tsconfig/eslint/vitest/jest config）纳入篡改检测、改用全工作区 diff、git 失败 fail-closed、空 checkCommands fail-closed、SKIP 正则扩 focus 标记；+4 触发单测钉死 + post-fix 复核。其余不变量（claim 不终态化、checkCommands 只从 config、熔断真接线、verified 仅显式分支兜底 fail-closed、objective 不可变）两裁判均确认未破。**这正是「裁判≠运动员」的回报**：确定性 backstop 的「可信根」（验收脚本/配置）本身可被运动员改写——判定逻辑没错，错在信任了 builder 可写的 oracle，两个独立裁判同点收敛抓出。
>
> **残留 LOW（已接受 / 记缺口）**：① check scripts 间接引用的子脚本（package.json scripts 调的 .js）本批未纳入 oracle 检测——scripts 定义本身已捕获，深层脚本待腿3/后续；② classifyTestDiff 的净增减是跨文件全局计数（A 删真用例、B 加 trivial 可互抵）、注释整段 it 仍匹配 CASE——语义弱化留腿3；③ `assertObjectiveUnchanged` 本批进程内近似 no-op（objective 同源创建期、运行中无改写路径），价值在 resume/replay 路径，作为 defense-in-depth 放对位置。

> **独立核查结论（2026-06-29，D9，腿3 落地后两个独立裁判）**：codex（gpt-5.5 xhigh）报 2 个 HIGH、独立 Claude 子代理报 no-HIGH（确认 12 条不变量未破），**两裁判收敛在同一个超时缺口**。三处全部已修 + 触发单测 + post-fix 四关卡复核（495 测试）：
> - **HIGH（收敛）· runVerifier 无墙钟超时**：verifier 模型流卡在 `stream.next()` 时 `maxTurns` 只在轮间生效 → 整个 goal 挂死、不能 fail-closed 合成 couldNotVerify（codex 判 HIGH=「挂死非 fail-closed」，Claude 判 LOW=liveness；按腿3 尺子「挂死」属 HIGH，Part7 §6.2 本设计了分级超时）。**已修**：`runVerifier` 内 `Promise.race` + 复合 abort signal（父 signal ∪ 120s deadline），超时统一返回 couldNotVerify report；触发单测「never-resolving run → couldNotVerify」。
> - **HIGH（codex）· `credential` 单数漏拦**：`sensitive.ts` 只匹配 `credentials` 复数，漏 `credential.json` 单数 → ungated 裁判 read 能读到送进远端模型（spec 原文写的就是「credential glob」单数）。**已修**：正则改 `credentials?`（覆盖单/复数），+ read 拒读 `credential.json` 触发单测。注：此缺口本就影响 builder（read 默认放行），非腿3 新引入，但腿3 把内容送第二（可能跨家族）模型使其更尖锐。
> - **LOW→收口（Claude）· `report===undefined` 边界防御**：decideVerdict 靠「verifierProvider 配了 ⟺ report 必有值」的 runVerifier 契约（非可选返回类型），未在边界强制。**已修**：goal-loop 加防御——腿3 启用但 report 为 undefined（契约违反）→ 合成 couldNotVerify、不落假阳性 verified；触发单测「mis-typed verifier 返回 undefined → 非 verified」。
> - **残留 LOW（接受/记缺口）**：同族「不同模型」独立性弱（降为 nice-to-have，已实测同族 2.0/2.1 + 跨家族 DeepSeek-V4 均跑通）；语义弱化判不了（裁判纯文件取证）；redactSecrets 盖不住裸高熵串（裁判读不到密钥文件、full report 只进本地 goalStore）。
> - **印证**：两裁判独立同点收敛在「fail-closed 的 liveness 维度」——之前几轮收敛在「可信根可被改写」，这轮收敛在「挂死也是一种没 fail-closed」。结论：goal 验收的 fail-closed 不只是「判定方向对」，还得保证「在有限时间内一定给出判定」（超时也是 couldNotVerify）。`demo:d2` 真连双模型实测 verified 与 couldNotVerify→blocked 两种终态，后者印证裁判拒绝橡皮图章、harness 交人。

> **独立核查结论（2026-06-30，held-out 腿落地后两个独立裁判）**：codex（gpt-5.5 xhigh）报 2 HIGH、独立 Claude 子代理报 1 HIGH，**两裁判收敛在同一个保密泄露**。两处全部已修 + 触发单测 + post-fix 四关卡复核（510 测试）：
> - **HIGH（收敛）· held-out 秘密经 cwd 内 goalStore 泄露**：continuation / verdict 事件两条通道都干净（只发泛化文案），但 `recordRound({ checks })` 把完整 `checks.heldOut.results`（秘密命令原文 + 失败输出）写进 `data/goals/<id>.jsonl`，**该文件在 cwd 内**，builder 下一轮 `read`/`grep`/`bash cat` 就能读到、逐条规避——即使 goal-setter 把 held-out 文件正确放 cwd 外，harness 仍自己把秘密复制进 cwd（与代码注释「NEVER fed back to the builder」直接矛盾）。**已修**：持久化前把 `heldOut` 收缩为 `{ passed, results: [] }`、丢命令/输出（replayGoal 不回读 results，审计仍留 pass/fail）；触发单测「held-out 失败后落盘 JSONL 不含命令/输出」（用真实 FileGoalStore）。
> - **HIGH（codex）· `JARVIS_HELDOUT_CHECKS_FILE` 留在 builder bash 环境**：`shellEnv()` 每次 exec 复制整个 `process.env`，builder 批准一次 bash 就能 `echo $JARVIS_HELDOUT_CHECKS_FILE` 拿路径 → `cat` 拿命令（`cat $var` 未解析变量分析器不判 sensitive）。**已修**：`loadHeldOutCommands` 读毕即 `delete process.env.JARVIS_HELDOUT_CHECKS_FILE`（在 runGoal 前、builder bash 跑之前），变量对 builder 不可见。
> - **残留 LOW / follow-up**：① **model-facing bash 密钥脱敏**（2026-06-30 两轮，见 security-review-baseline「bash 密钥脱敏轮」+「Phase D 收尾轮」）：子 shell env 脱敏（`runCommand.scrubSecretEnv`）+ `/proc/*/environ` 纳入 sensitive paths + `grep` path-aware 扫描 + `ps` env 输出（`e`/`-o environ`）拦截 + denylist 扩。**Linux /proc 已彻底闭合（2026-06-30 根因修）**：`assertKeyNotInLaunchEnv`(config.ts)——**Linux 下 `ARK_API_KEY` 在启动 env 里就拒绝启动、要求放 `.env`**。原理:`/proc/environ` 是 execve 快照,`.env` 经 `loadEnvFile` 在 execve **之后**注入、永不进 /proc;re-exec 修不了(Node 无 execve、祖先 npm/shell 仍持 key),唯一完整闭合是「key 不进任何启动 env」=强制 .env。捕获在 loadEnvFile 之前;Windows/macOS no-op(用户不变)。`scrubProviderKeyFromEnv` 留作纵深。`ps` env 输出 + /proc 文件读已被命令分析器拦。**净化边界**:用 .env(不要 `ARK_API_KEY=x npm run`)→ 链上无任何 /proc/environ 含 key → 彻底闭合。② held-out 源文件/被引用测试须放 cwd 外；③ `loadHeldOutCommands` 不区分「未配置」与「路径坏了」。
> - **印证**：保密契约的泄露不在「显式回传通道」（continuation/事件都做对了），而在**审计 sink 的物理位置**——「本地 goalStore」当安全 sink 的前提是它不在 builder 可读范围，但它在 cwd 内就破了。两裁判独立同点收敛印证：保密不能只看「我没主动告诉它」，还要看「它能不能从我写的任何地方读到」。

## gotcha / 已知小账

- **腿3 不靠 `role.model` seam**：没复用 SubagentManager（`providerFor` 永远回退父 provider、registry 是父∩交集非全新只读、child 继承父 ctx/gate 三处冲突）。`runVerifier` 是**独立函数**复用 runAgent：自建 messages + `buildDefaultRegistry().subset(['read','grep'])`（+ 只读断言）+ 注入第二 provider + 独立 bus + 无 store + 无 gate + 信号透传。第二模型靠 `resolveVerifierConfig` 读 `ARK_VERIFIER_MODEL` → `createProvider({...config, model})`；**verifier≠builder 断言只能在 config 字符串层**（`ModelProvider` 无 model id getter，两硬事实之一）。
- **腿3 纯文件取证**：裁判只有 read/grep，**跑不了命令/驱不动 app**。prompt 与工具白名单已对齐（明说只能读、凡需执行/运行态恒列 couldNotVerify、→ blocked 交人）。**checklist #6 已收口**：维持纯文件取证（只读 exec/驱动 app 需 OS 沙箱、暂不做）；D8 的 couldNotVerify-率 monitor 证实 per-goal 不可达、已删（跨 goal 监控待 Loop）。
- **pinned 推导用 builder model**：`derivePinnedRequirements` 一次 LLM 调用拆 objective、落盘不可变。空清单 → goal-cli **启动期 fail-closed**（拒绝启动、不烧预算，因 decideVerdict 第7步 `pinned.length>0` 守门使空清单 verified 不可达）。
- **最高优先级不变量**：腿3 启用 + 两腿干净 ⇒ runVerifier 永返回 report（失败合成 couldNotVerify、返回类型非可选）⇒ decideVerdict 永不回落 `report===undefined → verified`。改接线别破（回归测试 `NEVER falls through to verified when the verifier fails`）。
- **腿2 检测范围**：全工作区 diff vs baseline，查 ① 测试文件（删/skip/focus 标记/数量骤降）② **check-oracle 文件**（package.json/lockfile/tsconfig/eslint/vitest/jest config 被改 → tamper，堵「把 `npm test` 改成 `exit 0`」中性化验收 oracle，H-1）。git diff 失败 → fail-closed。**判不了**：语义弱化（`toBe`→`toBeDefined`）——当前裁判纯文件取证对「跑出来才知道」的弱化也判不了，已知缺口。无 baseline（非 git 仓）→ 腿2 inert。
- **held-out 腿保密**：`heldOutCommands` 来自 config（CLI 经 `JARVIS_HELDOUT_CHECKS_FILE`），**绝不沾 claim、绝不进 builder 上下文**。leg1 绿才跑（红已拒、省一次跑）；失败的 continuation 只给**泛化**提示（不含命令/输出），否则 builder 能逐一规避。秘密文件 + 引用的测试须放 cwd 外（builder read/grep confined cwd）——harness 只保证不泄露，文件位置是 goal-setter 责任。缺席 = 显式弱置信（CLI 声明）。
- **腿3 残留 LOW**（接受/记缺口）：① 同族「不同模型」独立性弱（已降为 nice-to-have，载重靠腿1/腿2 无模型 + 上下文隔离 + 独立 prompt，checklist #4）；② 裸高熵明文密钥 redactSecrets 盖不住（只覆盖 sk-/Bearer/key=val），但裁判读不到密钥文件（工具层拦）且 full report 只进本地 goalStore。
- **腿1 不过 gate**：harness 自跑配置固定命令（非模型注入），过 gate 反而会在验收中弹审批/被拒。安全前提是 checkCommands 不可被 builder 影响（代码硬保证）。
- **goal 模式的 builder write/bash 仍过 gate**：`npm run goal` 用交互 approver；自主性受 approval 约束（无人值守白名单是 Phase D 后续 + memory `restore-bash-session-allow`）。`demo:d1` 用自动 approver 演示。
- **熔断本批只连续阈值**（无滑窗）：Part7 §6.1 的滑窗在本状态机可达性存疑，故只留连续 3 阈值。

## 关键文件

```
src/capabilities/goal/
  goal.ts            # Goal(+pinned)/状态机/budget/checks/VerifierReport(腿3) 类型
  state.ts           # advanceGoalState 纯函数（assertNever）
  verdict.ts         # decideVerdict 纯函数（腿1/2/held-out 确定性闸 + report===undefined 回退逐字不动 + §3.2 八步三态 + fail-closed 兜底）
  checks.ts          # runDeterministicChecks(腿1 真退出码 + held-out 秘密命令) + 纯 classifyTestDiff(腿2)
  verifier.ts        # 腿3：runVerifier(复用 runAgent/只读/第二 provider/永返回 report) + parseVerifierReport + VERIFIER_PROMPT
  requirements.ts    # derivePinnedRequirements(builder model 拆 objective → pinned，失败 [])
  update-goal-tool.ts# update_goal(read-only/闭包 claim/防 reward-hacking) + takeClaim
  goal-loop.ts       # runGoal 外循环 + 腿3 接线(短路/不变量/redact) + VerifierCircuitBreaker(真接线)
  goal-store.ts      # GoalRecord(+pinned)/parse/replay/FileGoalStore/hashObjective/assertObjectiveUnchanged
src/core/model/config.ts        # loadDoubaoConfig + resolveVerifierConfig(config 层独立性断言)
src/core/tools/run-command.ts   # 从 bash.ts 抽的 spawn/超时树杀/结构化退出码 runner
src/runtime/event-bus.ts        # +guardrail halt reason、+verdict/goal_state 事件
src/surfaces/cli/goal-cli.ts    # npm run goal（交互 approver + baseline + ARK_VERIFIER_MODEL + derive + 空 pinned fail-closed + JARVIS_HELDOUT_CHECKS_FILE）
src/surfaces/cli/render.ts      # +verdict/goal_state 渲染
scripts/d1-demo.ts              # 真连 Doubao 的确定性两腿活体验证
scripts/d2-demo.ts              # 真连双 Doubao 模型的腿3 活体验证（需 ARK_VERIFIER_MODEL）
scripts/d3-demo.ts              # held-out 腿活体（Phase A 真活 verified）+ 确定性抓假（Phase B faked → rejected）
test/capabilities/goal/         # state/verdict/goal-store/checks/goal-loop/verifier/requirements
```

## 怎么运行

- 四关卡：`npm run typecheck / lint / test / build`（527 测试）
- goal 模式（确定性两腿）：`npm run goal -- "<objective>"`（交互审批 + 自主验收，需 `ARK_API_KEY`）
- goal 模式（+ held-out）：另设 `JARVIS_HELDOUT_CHECKS_FILE=<文件，一行一条秘密校验命令；放 cwd 外>`
- goal 模式（+ 腿3 裁判）：另设 `ARK_VERIFIER_MODEL=<不同的 Doubao/DeepSeek 模型 id>`
- 活体 demo：`npm run demo:d1`（两腿）；`npm run demo:d2`（双模型腿3，需 `ARK_VERIFIER_MODEL`）；`npm run demo:d3`（held-out）

## 下一步（Phase D 后续 / 腿3 加固）

> **新会话交接见 `docs/handoff-next.md`**——把下面两类（需沙箱的 #2/#6 + Phase D 后续批）的上手上下文、设计草图、别破的不变量都consolidated在那一页。

- **腿3 能力扩展**（checklist #6，**已收口为「暂不做」**）：裁判跑只读命令/驱动 app 需 OS 级沙箱（无沙箱下「只读 exec」=跑任意代码有副作用、且削弱裁判注入安全属性），决定**维持纯文件取证**、运行态需求恒 couldNotVerify。**待沙箱基建**再开。同时 D8 的 couldNotVerify-率 `VerifierMonitor` 证实 per-goal 不可达（死 guardrail）**已删**，**跨 goal 健康监控待 Loop 调度**（多 goal 会话）落地再加。
- **主观/客观分流**（checklist #2，**已收口**）：防作弊覆盖面**已结构性满足**（所有 pinned 都交裁判、无「标客观」旋钮可绕）；确定性客观路由（有命令→客观、跑命令验）需可信 per-需求命令、与 #6「裁判跑命令需沙箱」同根 → **defer**。顺带修了 `cannotVerify` bug（见下「verified 诚实边界」）。**待沙箱/goal-setter-authored-requirements** 再做客观路由。
- **Hooks**（把自动化挂到时刻）、**skill 自动沉淀**（人审 gate）、**Loop 调度**（cron 长跑）、**多模态**、**shadow-git**、**bash 白名单**（无人值守自主，配 memory `restore-bash-session-allow`）。
