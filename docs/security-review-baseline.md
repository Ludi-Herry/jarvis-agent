# 安全审查基线 · 独立 codex 复核怎么跑、按什么尺子

> 复用文档(不是一次性交接):每次对权限系统(PermissionGate + 命令解析器 + bash 审批)做独立 codex 对抗复核,用本文件的**聚焦清单 + 严重度基线**,避免每轮重新推导、避免用错尺子把已定性的低危当高危重报。
> 背景:命令安全根经四轮 codex(gpt-5.5 xhigh)对抗核查夯实;最后一轮「确认无 HIGH」被别的会话误杀、未跑完(非真失败),可按下方重跑确认,非阻塞。

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

四轮 codex 在「黑名单枚举 exec-vector」上不收敛(每轮找出更冷门的:trap/alias/env -S/mapfile -C/bind -x/ssh/`${x:$(...)}`…),这是黑名单的固有性质,不是解析器缺陷。结论(见 memory `restore-bash-session-allow`):**让人审做墙**(B11)+ 黑名单做纵深;无人值守自治(Phase D)再上白名单。所以后续复核重点是「有没有静默/崩溃/绕闸」,而非「黑名单是否枚举全」。
