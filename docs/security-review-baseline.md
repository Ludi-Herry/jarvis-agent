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
