# 安全审查基线 · 独立 codex 复核怎么跑、按什么尺子

> 复用文档(不是一次性交接):每次对权限系统(PermissionGate + 命令解析器 + bash 审批)做独立 codex 对抗复核,用本文件的**聚焦清单 + 严重度基线**,避免每轮重新推导、避免用错尺子把已定性的低危当高危重报。
> 背景:命令安全根经四轮 codex(gpt-5.5 xhigh)对抗核查夯实。2026-06-29 补跑了被误杀的「确认无 HIGH」轮,并在 P1/P2 遗留清理后再跑一轮覆盖最终改动——两轮均确认命令安全根核心不变量未破,各自发现的 HIGH 都落在命令安全根「之外」(文件工具 / loop / 错误脱敏)且已修,详见下「历史」。

## 严重度基线(关键 —— B11 之后)

`f537d94 (B11)` 起,**bash(executes-code)永远每次人审**:gate 不给 executes-code 任何 session 授权,decide 的规则只能 deny bash、永不 allow;唯一静默泄漏路径(grep 工具递归)早已修。因此尺子是:

- **HIGH(P0,要报)= 有静默路径或崩溃绕闸**:① 任何工具**不经人审**就读出/泄漏密钥(如当年的 grep 递归);② 让 executes-code 调用 `allowed:true` 却**没问 approver**(gate/decide 的 bug);③ 非 bash 工具能力误判致危险副作用自动放行;④ `analyzeCommand` **抛异常(非 fail-closed)或挂死**;⑤ gatedRun 执行了被 deny 的调用,或「解析的串 ≠ 执行的串」。
- **LOW(简列,不深挖)= deny→ask 的降级**:某个冷门 exec-vector(`fc`/`PROMPT_COMMAND`/没进黑名单的内建…)被判 ask 而非 deny——**B11 后这是人可见的,不是高危**;还有 `${var@P}` 跨语句污点、scp/rsync 远端路径、文件读取器不在 FILE_PATH_PROGS 名单里的密钥读(降 ask)等。

> 务必在 prompt 里写明这条基线,否则 codex 会用宽尺子把这些 LOW 重报成 P0/P1(前四轮就是这样,已收敛、别再吵)。

## 跑法(本机 codex 0.142,gpt-5.5 xhigh)

```
codex exec -s danger-full-access --skip-git-repo-check -m gpt-5.5 \
  -c "model_reasoning_effort=xhigh" -c "notify=[]" -C H:\jarvis-agent - < <prompt>
```
- 读取 prompt 走 stdin(`-`);输出走 stdout(重定向到文件再读)。
- `~/.codex/config.toml` 默认就是 gpt-5.5 + xhigh + `service_tier=default` + `danger-full-access`,无需再加 `-c service_tier=fast`(那是旧 0.125 的坑,已不适用)。
- README/CLAUDE.md 的「调 codex 必加 fast」已过时(现 0.142)。
- 只读审查:prompt 里强调 do-not-modify;codex 有写权限但指令约束 + 仓库已提交可回滚。
- **别在前台干等**:用 `run_in_background`,完成有通知;若被外部杀掉(exit -1/255、out.md 0 字节)重跑即可。

## 要 codex 核验的不变量(贴进 prompt)

- `decide()`:`capability:'executes-code'` 永不返回 `action:'allow'`(只 hard-deny | rule-deny | ask)。
- gate:executes-code 不进 `sessionGrants` 集合、也不读它(`sessionable = capability !== 'executes-code'`);`allow-session` 对 bash 退化为 allow-once。
- grep:`collectFiles` 遍历跳过 `isSensitivePath` 命中的文件/目录(`src/core/tools/builtins.ts` + `sensitive.ts`)。
- 解析器:parse 失败 + Walk 异常都 try/catch → `danger`(fail-closed),无 throw/hang 逃逸。
- `gatedRun`(`src/core/loop/run-agent.ts`):闸门在 `tools.run` 之前裁决;被 deny 不执行;解析的 `args.command` == bash 执行的串(无 TOCTOU)。
- bash 不在无闸门的 `buildDefaultRegistry`。

## prompt 骨架(按需微调)

```
对 Jarvis-Agent 权限系统做独立安全复核(commit <HEAD>)。xhigh。只读,输出到 stdout。目标 shell = POSIX/Git Bash。
[贴：上面「严重度基线」整段——HIGH 的 5 类 + 「B11 后 deny→ask 不算高危」]
[贴：上面「要核验的不变量」]
只 hunt HIGH(静默泄漏 / 崩溃挂起 / 绕闸);LOW 简列不深挖。
输出:1) ship 判定:有无 HIGH? 2) HIGH 发现(具体可复现命令 + trace + 修法)或「未发现高危」 3) LOW 残留:bullet。只报读代码核实过的。
```

## 历史

### 2026-06-30 · Phase D 收尾轮（4 裁判：codex + 3 Claude 镜头）
腿3 整套 + held-out + bash 脱敏全部落地后跑的收尾对抗轮。**4 个独立裁判**：codex(gpt-5.5 xhigh，全面) + 3 个 Claude 子代理（镜头分别：假阳性 verified / 密钥外泄 / 死 guardrail+fail-closed）。**3 个 Claude 报 no-HIGH，codex 报 1 HIGH**。
- **HIGH（codex，纠正前轮一个错误结论）**：**`scrubProviderKeyFromEnv()` 在 Linux 对 `/proc/<pid>/environ` 无效**——`/proc/pid/environ` 暴露进程**启动时**的初始环境，运行时 `delete process.env.ARK_API_KEY` 改不了它。`/proc/.../environ` 的**文件读**已被 sensitive.ts + grep 操作数扫描拦，但 **`ps eww -p $PPID`（ps `e`/环境输出）没被命令分析器拦**（probe danger:false→ask），批准后 builder 拿到父 node 初始 env 里的 `ARK_API_KEY`。**前一轮「bash 密钥脱敏」把 scrubProviderKeyFromEnv 当成「堵 /proc 的根因修」是错的**——它只对 ① Windows（无 /proc）② 运行时 re-read process.env 的代码 有效，对 Linux /proc/ps 无效。**已修（概念 PoC 闭合）**：命令分析器拦 `ps` 的 env 输出模式（BSD `e`/`eww`/`auxe` + `-o environ`/`--format environ`），plain `ps aux`/`-ef` 不误杀；+ 触发单测。
- **残留（重要，诚实记）**：ps 拦了、直接 /proc 文件读拦了（cat/strings/grep/od/redirect 都过 FILE_PATH_PROGS 或 sensitive），但**解释器跑脚本仍能读 /proc**——`node readenv.js`（脚本里 `fs.readFileSync('/proc/'+ppid+'/environ')`）分析器看不进脚本内容、判 clean → Linux 上仍泄 `ARK_API_KEY`。这是「model bash 跑任意代码」的固有面（与 #6 沙箱同根）。**彻底闭合需根因修**：Linux 下别让长驻 agent 以含 key 的初始 env 启动（启动前 re-exec 到净化 env / key 经 pipe/受限文件交 provider），defer（用户在 Windows、不复现；根因修重且平台特定）。
- **3 个 Claude 裁判收敛 no-HIGH**：假阳性 verified（每条路径 provably closed、cannotVerify 确定性 park、注入 undefined runVerifier 被边界兜、自报 verdict 剥离、脏腿不可绕）；密钥外泄（裁判只读断言、held-out goalStore 收缩、子 agent 同脱敏 bash、无遗漏 model-facing shell）；死 guardrail（VerifierMonitor 删除彻底无残留）。
- **顺带清理/硬化（裁判 1/3 的 LOW，已做）**：① **删 `breaker.recordNonReject()`**——裁判3 发现它是 VerifierMonitor 的**孪生死代码**（非 reject verdict 立即 break loop、reset 永远影响不到下一轮），fail-safe 但死，与 #6 一致删；② **parser ids⊆pinned**——裁判1 发现 `parseVerifierReport` 宽松解析（末 fenced block）+ pinned id 可预测(r1..rN) → 埋完美 report JSON 让注入裁判 echo 可假 verified，加「scored ids 必 ⊆ pinned」堵（合法 report 本就 ids==pinned）；③ 补触发单测：cannotVerify 集成、budget 耗尽、git-diff 失败（裁判3 指出的 reachable-but-untested fail-closed 分支）。524 测试。
- **印证**：① 4 裁判里只有 codex 抓到「/proc 显示初始 env」这个 OS 语义坑——**单看代码逻辑对（删了 env）不等于对（/proc 不读运行时 env）**,需要懂底层语义的裁判；前轮 3 裁判（含我）都漏了。② 「孪生死代码」(recordNonReject) 印证 #6 的教训会复发——删一个死 guardrail 时要扫同类。③ fail-closed 分支「reachable 但没触发测试」就是下一个 VerifierMonitor 候选，补测试钉死。

### 2026-06-30 · checklist #6 收口（裁判能力边界 + 死 guardrail 清除）
不是对抗轮，是 leg-3 checklist #6 收口时的死代码发现，记此因为正中「绿灯≠成功」主题。D8 的 `VerifierMonitor`（couldNotVerify 率告警）**经 2026-06-29 leg-3 轮两裁判核查时判「通过」**——但那只核了「类在 report!==undefined 时正确 record」，**没核「接线后能不能真触发」**。#6 收口写「健康监控接线触发单测」时发现：单 goal 内 couldNotVerify 是终态（→blocked、loop break），`monitor` 又是 per-goal 实例，所以**至多记录 1 次 couldNotVerify**、永远凑不够阈值（≥4 且率>0.6）→ **不可达死 guardrail**。已删（接线 + 类 + 测试），文档化「couldNotVerify 率是跨 goal 信号，待 Loop 调度落地再加」。同时确认 #6 另一半：裁判 prompt 与 read/grep 白名单一致（无误导执行措辞），「跑命令/驱动 app」需 OS 沙箱、维持纯文件取证。
- **印证**：组件级 review（「这个类逻辑对吗」）挡不住系统级不可达（「这条线在真实状态机里能走到吗」）——和熔断滑窗、CodeWhale「只自增不读」同类。**guardrail 的触发单测必须走真实接线路径**（integration），只测类本身会漏掉「类没问题、但永远调不到阈值」。教训补强了 baseline 既有铁律：写触发测试时若发现「构造不出触发输入」，那不是测试难写，是 guardrail 死了。

### 2026-06-30 · model-facing bash 密钥脱敏轮
给 model-facing bash 加 env 脱敏（防 agent `echo $ARK_API_KEY` exfil）后跑的一轮。**两个独立裁判**——codex(gpt-5.5 xhigh)报 3 HIGH、独立 Claude 子代理报 1 HIGH——**收敛在「脱敏只删子 shell 的 env 拷贝、父 node 进程仍持有 key」**：`shellEnv` 做 `{...process.env}` 后只从拷贝删 secret，`loadDoubaoConfig` 读 key 后从不 delete，provider 捕获后 `process.env.ARK_API_KEY` 纯属残留。Linux 上 model-facing bash 经 `cat/strings /proc/$PPID/environ`、`ps eww $PPID` 读回**未脱敏**的 key——三条都过命令分析器（clean→ask）。`echo $ARK_API_KEY`/`printenv` 读的是已脱敏的子 shell 拷贝、确实拿不到，**脱敏只挡住了最 naive 那条**。win32 无 /proc 不复现，但 harness provider 无关、可部署 Linux，判 HIGH。codex 另独立抓到两条：① `grep -a . .env` 漏拦（`grep` 不在 `FILE_PATH_PROGS`，分析器放行 → bash grep 读 .env）；② denylist 漏常见名（`GITHUB_PAT`/`DATABASE_URL`/`MONGODB_URI`/`SENTRY_DSN`…）。
**已修 + 触发单测 + post-fix 四关卡（519 测试）**：① ~~根因——`scrubProviderKeyFromEnv()` 删 ARK_API_KEY，/proc 与 echo 双向断~~ **⚠️ 这条「根因修」对 Linux /proc 无效，下一轮（Phase D 收尾轮）codex 纠正**：`/proc/<pid>/environ` 显示**启动初始 env**、运行时 delete 改不了它，所以删 process.env 只挡 Windows + 运行时 re-read，挡不住 Linux /proc/ps。`scrubProviderKeyFromEnv` 保留作纵深（删运行时 env），但别当 /proc 的修。② 防御纵深——`/proc/<pid>/environ` 纳入 `SENSITIVE_PATHS`（这条对，挡文件读）；③ `grep/egrep/fgrep/rg` path-aware 操作数扫描；④ `isSecretEnvName` denylist 扩 PAT/DSN/连接串。子 shell 脱敏保留作纵深。**`ps eww` 这条当轮漏了，收尾轮补拦。**
- **印证（已被下一轮修正）**：原写「根治是从源头 process.env 删 key」——**这个结论在 Linux 上是错的**（/proc 是初始 env）。正确根治是「别让进程以含 key 的初始 env 启动」（re-exec 净化 env / key 经文件），见收尾轮。残留 LOW（仍成立）：用户自带密钥经 Linux /proc/ps/解释器读取需进程沙箱；denylist 枚举不全；`grep -f .env` 非泄露未处理。

### 2026-06-30 · held-out 隐藏断言腿轮(checklist #1)
held-out 腿(goal-setter 秘密隐藏断言、builder 看不到)落地后跑的一轮。**两个独立裁判**——codex(gpt-5.5 xhigh)报 2 HIGH、独立 Claude 子代理报 1 HIGH——**收敛在同一个保密泄露**:held-out 的命令原文 + 失败输出经 `recordRound({checks})` 写进 `data/goals/<id>.jsonl`,而该文件在 **cwd 内**,builder 下一轮 read/grep/bash cat 就能读到、逐条规避隐藏断言。continuation 与 verdict 事件两条「显式回传」通道都做对了(只发泛化文案),漏在**审计 sink 的物理位置**——「本地 goalStore 当安全 sink」的前提是它不在 builder 可读范围,但它在 cwd 内就破了,且即使 goal-setter 把 held-out 文件放 cwd 外也无从规避(harness 自己复制进 cwd)。codex 另独立抓到第二个:`JARVIS_HELDOUT_CHECKS_FILE` 留在 builder bash 环境(`shellEnv` 复制整个 process.env),批准一次 bash 就能 echo 路径 + cat 文件。两处已修 + 触发单测 + post-fix 四关卡(510 测试):① 持久化前把 `heldOut` 收缩为 `{passed, results:[]}` 丢命令/输出(replayGoal 不回读、审计留 pass/fail);② `loadHeldOutCommands` 读毕即 `delete process.env.JARVIS_HELDOUT_CHECKS_FILE`。其余不变量(continuation/事件保密、held-out 闸在 report 前、report===undefined 被 gate、短路不 spawn 腿3、命令源不沾 claim、CLI 一次性读文件、真退出码 fail-closed)两裁判逐条核未破。
- **印证**:保密契约的泄露不在「我有没有主动告诉它」(显式通道都对),而在「它能不能从我写的**任何地方**读到」——审计日志、缓存、临时文件凡落在 agent 可读范围(尤其 cwd 内)都是泄露面。结论:goal 验收的秘密(held-out 命令/输出)绝不写进 cwd 内可读 sink;「本地磁盘=安全」对一个 cwd 被 agent 读写的 harness 不成立。
- **follow-up（model-facing bash 继承 `ARK_API_KEY`）**：先做了子 shell env 脱敏（`runCommand.scrubSecretEnv`），但**那版不完整**——见下一条「bash 密钥脱敏轮」，独立核查发现子 shell 脱敏可被 `/proc` 绕过，已补全。

### 2026-06-29 · Phase D 腿3 轮(独立 LLM 裁判 / 第二批)
腿3(独立只读 LLM 裁判)落地后跑的一轮(D6–D9)。**两个独立裁判**——codex(gpt-5.5 xhigh)报 2 HIGH、独立 Claude 子代理报 no-HIGH(确认 12 条不变量未破)——**收敛在同一个超时缺口**:`runVerifier` 无墙钟超时,verifier 模型流卡在 `stream.next()` 时 `maxTurns` 只在轮间生效 → goal 挂死、不能 fail-closed 合成 couldNotVerify。codex 判 HIGH(「挂死非 fail-closed」,腿3 尺子里「挂死」明列 HIGH-3,且 Part7 §6.2 本设计了分级超时),Claude 判 LOW(liveness 非假阳性)。另 codex 独立抓到 `credential` 单数漏拦(`sensitive.ts` 只匹配复数 `credentials`,漏 `credential.json` → ungated 裁判可读送远端模型);Claude 独立抓到 decideVerdict 的 `report===undefined` 边界靠 runVerifier 契约而非边界强制(LOW,不可达 shipped 入口)。三处全部已修 + 触发单测 + post-fix 四关卡(495 测试):① runVerifier `Promise.race` + 复合 abort(父 signal ∪ 120s)超时 → couldNotVerify;② 正则 `credentials?` 覆盖单/复数 + read 拒读单测;③ goal-loop 加 report===undefined 边界防御合成 couldNotVerify。其余不变量(decideVerdict 腿1/2 先判、注入不可绕、自报 verdict 被剥离、空 pinned verified 不可达、registry 只读、redact、独立性 config 断言、熔断真接线、最高优先级不变量 runVerifier 永返回 report)两裁判均确认未破。
- **印证**:腿3 的 fail-closed 不只「判定方向对」(永不假阳性 verified),还得保证「有限时间内一定给出判定」——**挂死也是一种没 fail-closed**。这轮收敛点(liveness)与第一批收敛点(可信根可被改写)互补:验收 backstop 既要判得对、也要判得完。腿3 把证据送第二(可能跨家族)模型,使「裁判读密钥」面比 builder 单模型更尖锐 → 密钥禁读名单要更严(credential 单数)。

### 2026-06-29 · Phase D goal 验收轮(GoalLoop 第一批)
Phase D 第一批(GoalLoop + 确定性两条腿验收)后跑的一轮(commit D1–D5)。**两个独立裁判**(codex gpt-5.5 xhigh + 独立 Claude 子代理)**各自独立**抓到同一个 HIGH:**检查命令的 oracle 可被 builder 中性化** —— 腿1 跑 `npm test/build` 等,但命令定义在 `package.json` scripts / tsconfig / eslint/vitest config,这些文件不在腿2 的 `test/` 监控范围;builder 改 `package.json` 的 `"test":"exit 0"` 即让四关卡全绿、腿2 看不到 → 假 verified(命中「凑绿不被腿2 抓」,走配置而非 test/ 文件)。已修:腿2 把 check-oracle 文件(package.json/lockfile/tsconfig/eslint/vitest/jest config)纳入篡改检测 + 改全工作区 diff + git 失败 fail-closed + 空 checkCommands fail-closed + SKIP 正则扩 focus 标记;+4 触发单测钉死 + post-fix 复核。其余不变量(claim 不终态化、checkCommands 只从 config、熔断真接线、verified 仅显式分支兜底 fail-closed、objective 不可变、assertNever)两裁判均确认未破。
- **印证**:两裁判独立同点收敛在「确定性 backstop 的**可信根**本身可被运动员改写」——这类「验收 oracle 完整性」漏洞比单个判定函数 bug 更隐蔽(判定逻辑没错,错在信任了 builder 可写的 oracle)。结论:goal 验收的可信根(check 命令定义文件)必须和测试一起纳入篡改检测。

### 2026-06-29 · Phase C 多 agent 轮(SubagentManager / 子 agent 工具面)
Phase C 新增 subagent 工具面后跑的一轮(commit C1–C5)。**两个独立裁判**——codex(gpt-5.5 xhigh)+ 一个独立 Claude 子代理——**各自独立**抓到同一个 HIGH:**嵌套委派的 depth/能力/预算收窄链断裂**(`buildChildRegistry` 里子的 `task` 绑的 nested manager 复用了 root registry/budget,且 `childDepth===0` 的 fallback 没剔除继承的 root-bound `task` → 叶子拿到「绑根 manager」的 task、depth 复位 → 无界递归 + read-only 子能让后代从 root 派生出 write/bash)。命中 Phase C 核查清单的②③类(能力升格 / 护栏失效),**不命中①**(写/执行仍过 gate、无静默副作用——纵深防御被击穿但 gate 这道墙没破)。已修:`buildChildRegistry` 现总剔除继承 task + 仅 `childDepth>0` 才重绑一个用「子收窄 registry + 子收窄 budget」构造的 nested manager(每层从直接父派生);spawnRole 包 try-catch fail-closed。加 2 个触发单测钉死(read-only 子委派不出 write、budget 12→6 链式、depth-0 子无 task)+ post-fix 复核。其余不变量(gate 复用、store 不污染、signal 透传、R2 fail-closed、subset 只收窄)两裁判均确认未破。
- **印证**:codex / 独立裁判的价值在抓「结构性绕闸 / 护栏失效」——尤其核出运动员在**新工具面**引入的**跨层链式 bug**(单层正确、depth≥2 失效),这类靠单层枚举测试难覆盖。结论:命令安全根之上叠多 agent 时,**新增的 subagent 工具面值得独立核一轮**;命令解析器本身不必重核。

### 2026-06-29 · 两轮复核(P1/P2 遗留收尾)
补跑被误杀的「确认无 HIGH」轮(commit 7cdbd3e)后,在清理文件工具 / loop 的 P1/P2 遗留过程中又跑一轮覆盖最终改动(commit 9e6d27a)。两轮命令安全根核心不变量(decide 对 executes-code 永不 allow、grep 跳密钥、解析器 fail-closed、gatedRun 先裁决、bash 不在无闸注册表)均未破。共发现 4 个 HIGH,**全部在命令安全根之外**且已修:
- safeResolve 多跳悬空 symlink 写穿透(文件工具 cwd 约束)— effectiveRealPath 递归 + 40 跳 fail-closed。
- bash 继承 BASH_ENV/ENV 致非交互启动脚本执行(解析串≠执行串的隐藏 vector)— spawn 净化 env。
- gatedRun 共享 mutable ToolCall 致 TOCTOU(解析串==执行串仅靠约定,当前无恶意 subscriber 不可利用)— Object.freeze 快照。
- redactSecrets 单引号绕过(错误信息回显密钥)— 正则支持单/双引号。
印证结论:codex 的价值在抓「静默 / 崩溃 / 绕闸」类结构问题(尤其裁判核出运动员自己引入的 bug),而非黑名单枚举完整性。

四轮 codex 在「黑名单枚举 exec-vector」上不收敛(每轮找出更冷门的:trap/alias/env -S/mapfile -C/bind -x/ssh/`${x:$(...)}`…),这是黑名单的固有性质,不是解析器缺陷。结论(见 memory `restore-bash-session-allow`):**让人审做墙**(B11)+ 黑名单做纵深;无人值守自治(Phase D)再上白名单。所以后续复核重点是「有没有静默/崩溃/绕闸」,而非「黑名单是否枚举全」。
