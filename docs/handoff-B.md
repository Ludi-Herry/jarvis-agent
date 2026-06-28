# 交接：Phase B 完成（B1–B6，2026-06-28）

给接手者（人或 AI）。读完这页你应知道：Phase B 做了什么、关键决策与 gotcha、§5 验收怎么映射到测试、安全残留边界、怎么运行、下一步从哪开始。完整设计见 `phase-B-plan.md`；A 阶段见 `handoff-A.md`；项目规则见根 `AGENTS.md`。

## 一句话状态

**Phase B 全部完成**：agent 能**安全地执行命令**——危险/敏感操作被运行时**确定性**拦截，改动级操作走**人在环审批**，权限由 gate 强制、绝不让模型自报。`npm run typecheck / lint / test / build` 全绿（**285 测试**），每个里程碑有真连 Doubao / 真跑 bash 的实跑 demo。命令解析器（安全根）经**四轮独立对抗核查**加固。下一步：持久化段（断点续跑），或 Phase C（多 agent）。

## 架构一句话

A 阶段「裸做无权限护栏」，B 阶段补上那道闸门：**工具执行前先过 PermissionGate**（在 A2 刻意留的 `runAgent` 缝里）。决策是**纯函数** `decide(req, policy)`，从工具的能力标签 + 解析后的入参确定性推导，**绝不读模型自述的副作用**（堵 deepcode 漏洞）。`ask` 交注入式 approver（测试注入假的、REPL 注入真交互、非交互 fail-closed deny）。

## 各里程碑（含 commit）

| 里程碑 | commit | 内容 |
|---|---|---|
| B1 闸门骨架 | 1c613d3 | PermissionGate（`decide` 纯函数 + deny→ask→allow + 注入式 approver + 会话 allowlist）；ToolCapability 扩成 4 值正交枚举；接进 `runAgent` |
| B2 命令解析器 | a92c408 | 确定性命令树解析（POSIX/Git Bash）：危险命令 + BANNED 解释器 + 嵌套穿透 + .env/密钥黑名单；**四轮对抗核查、12 类绕过/DoS 全修** |
| B3 Bash 工具 | d1d0e88 | 第一个 ExecutesCode 工具，必过闸+解析器；受限 cwd + 超时树杀（独立兜底 resolve）+ abort 接线 + 输出上限 |
| B4 交互审批 | 21f6e6f | REPL 真 approver（allow once/session/deny，展示命令+风险+reason，Ctrl-C=deny），单行队列防双消费，非交互 fail-closed |
| B5 RuleResolver | a334f50 | 三层规则就近合并喂 gate；md 软引导、规则不能翻转硬 deny；`@import` 单源防环；token 预算 |
| B6 验收收口 | （本提交） | §5 清单核对 + handoff-B + AGENTS.md 刷新 + 独立验收核查 |

## §5 验收契约 → 测试映射（全绿）

| §5 条目 | 覆盖测试 / 证据 |
|---|---|
| 1 敏感文件 deny（连读，不只写） | `decide` "denies READING .env" · `command` "cat .env sensitive" · `run-agent` "denies a sensitive read（密钥不泄漏）" · `demo:b1` Run A |
| 2 危险命令确定性拦截（嵌套、不靠模型自报） | `command` 穿透组（`sh -c "git push --force"` 等）+ "model cannot self-report safety" · 四轮红队回归组（N1–N9、P1-A/B/C） |
| 3 Bash 闭环 | `bash` 执行组 · `run-agent` "runs a SAFE bash command end-to-end" · `demo:b3` Run A（真跑 node --version） |
| 4 审批分档 | `permission-gate`（allow-once/session/deny、deny 不可翻转、fail-closed）· `repl` allow→写/deny→拦/EOF→fail-closed · B4 活体冒烟 |
| 5 决策纯函数（正反+边界） | `decide` · `command` · `permission-gate` · `rule-resolver` |
| 6 谎报不绕闸 | `command` "model cannot self-report" · `decide` 规则不能翻转硬 deny 组 |

作弊路径已堵：guardrail（每个拦截/fail-closed 分支）均有「真触发」单测；无删/skip 测试、无降规则；四关卡端到端真过、有输出为证。

## 关键决策

- **权限的根 = 确定性解析命令树，绝不让模型自报**（plan §1 决策 3）。deepcode 让模型自报 `sideEffects=[]` 就绕闸是真实漏洞；B2 照 codex/openhanako 解析命令树。
- **沙箱 = 务实档**（plan §1 决策 2）：确定性解析 + 受限 cwd + .env/密钥黑名单 + 审批闸，**不上内核级沙箱**。cwd 是锚点不是牢笼——真正的防护是解析器 + 人审。
- **ToolCapability = 单值 4 元枚举**（read-only/writes-files/executes-code/network），不是数组——B 阶段工具都单一副作用；真要组合副作用再加宽（1 行类型改动）。
- **目标 shell = Git Bash / POSIX sh**（用户拍板）：参照实现都是 POSIX 语义；解析与执行同一种 shell，不语义错位。cmd/PowerShell 待扩。
- **裁判≠运动员**：B2/B3 安全关键里程碑用独立子代理做对抗性核查；B6 用独立子代理做最终验收，不自评。

## 安全残留边界（已知、已接受 —— 务实沙箱的取舍，非缺陷）

命令解析器是**静态分析**，无运行时插桩；以下属 fail-closed 设计下的固有盲区，已评估为可接受（多数仍会落到 `ask` 由人把关）：

- **运行时变量展开**：`cat $SECRET`（密钥名来自环境变量）静态不可见。已**部分封堵**：同命令/跨 `;` 的赋值值会被查（`X=.env cat $X`、`f=.env; cat $f` 已拦），但环境预置的 `$SECRET` 不可封。
- **glob 运行时展开**：`cat .e*` / `cat .??v` 展开成 `.env`，静态看到的是字面 glob。（`.env*`、裸 `.*` 已拦。）
- **后台进程留存**：`foo & disown` / `nohup foo &` 父 shell 立即退出，子进程活过本次调用——树杀只在超时/abort 路径跑。根治需 Windows Job Object / POSIX 进程组。
- **深层 wrapper 叠加误报**：4 层以上非 sudo wrapper（`nice nice nice nice nice cmd`）触发 depth 守卫判 danger（fail-closed，罕见）。
- **shell 路径信任**：`JARVIS_BASH` 指向哪由操作员负责（模型注入改不了父进程 env）；别指向 `.bat/.cmd`（Node Windows 参数转义坑），保持 `.exe`。

要根治这些需上内核级隔离（plan §1 决策 2 明确不做）；真出现强隔离需求再上。

## gotcha / 已知小账

- **命令解析器只锁 POSIX/Git Bash**：cmd/PowerShell 语法未覆盖（plan §7）。Bash 工具在 Windows 经 `C:\Program Files\Git\bin\bash.exe` 执行（解析 `defaultShellPath`，可用 `JARVIS_BASH` 覆盖；PATH 的 `bash` 常是 WindowsApps 的 WSL 桩，已避开）。
- **CLI 现在有闸门 + bash**：`npm run dev` 写文件会弹审批，跑命令过解析器。非交互（管道无应答 / EOF）一律 fail-closed deny。
- **RuleResolver 默认 no-op**：只读项目级 `AGENTS.md` + `.rules/`，**不自动拉全局 ~/AGENTS.md**（私有跨工具配置进 enforcement 须显式）。本仓库 AGENTS.md 无 allow/deny frontmatter → rules 为空 → gate 行为不变。要用规则：加 frontmatter `allow: [bash:npm test, ...]` / `deny: [...]`。
- **交互审批/Ctrl-C** 只有人工跑 `npm run dev` 亲手按能最终确认（管道不发 SIGINT）；自动化测试用注入式 approver + EOF 覆盖。
- **持久化未做**（plan §1 决策 5）：会话状态仍只在内存，无断点续跑——B 之后的「持久化段」（倾向 JSONL + shadow-git）。

## 关键文件

```
src/runtime/permission/decide.ts          # 纯决策点 decide() + defaultPolicy + 规则应用（B1/B2/B5）
src/runtime/permission/command.ts         # 确定性命令树解析器（安全根，B2，四轮加固）
src/runtime/permission/permission-gate.ts # 有状态闸门：注入式 approver + 会话 allowlist + fail-closed（B1）
src/core/tools/bash.ts                     # Bash 工具：spawn Git Bash + 超时树杀 + abort（B3）
src/core/tools/types.ts                    # ToolCapability（4 值）+ capabilityOf + ToolRunCtx.signal
src/core/loop/run-agent.ts                 # gatedRun：执行前过闸、deny 回灌（接线点）
src/surfaces/cli/approval.ts               # 审批渲染 + 选择解析（纯，B4）
src/surfaces/cli/repl.ts                   # REPL：单行队列 + 交互 approver + Ctrl-C 语义（B4）
src/capabilities/rules/rule-resolver.ts    # 三层规则加载/合并 + @import 防环（B5）
scripts/b1-demo.ts · b3-demo.ts            # 真连 Doubao / 真跑 bash 的活体验证
test/                                       # 285 单测（28 文件）
```

## 怎么运行

- 四关卡：`npm run typecheck / lint / test / build`
- 终端（已带闸门+bash+审批）：`npm run dev`
- 活体 demo：`npm run demo:b1`（读 allow / 改源码 ask / 读 .env deny）、`npm run demo:b3`（bash 闭环 + 危险/密钥拦截）。需 `ARK_API_KEY`。

## 下一步

- **持久化段**（plan §1 决策 5 / §6）：append-only JSONL + shadow-git，断点续跑、SessionStore。压缩容错（A 遗留）也在这一段硬化。
- 或 **Phase C**（多 agent / SubagentManager，见项目记忆 `c-phase-agent-roster-two-axes`）。
- 文档清理候选（删文件属红线，留待确认）：`docs/next-session-A2-prompt.md`、`docs/next-session-B-prompt.md` 已被各自阶段消费，可删。
