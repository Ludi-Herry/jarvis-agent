# Phase B 搭建方案 · 安全地干活

> 类型：历史实现计划。本文保留 Phase B 的原始方案和威胁模型；落地结果见 `docs/handoff-B.md`，当前安全边界见 `AGENTS.md` 与现行测试。

> 依据蓝图 §1/§7/§10/§12（`H:\LLM本地知识库\采集\external\agent-harness-调研\agent-harness-Part2-架构蓝图.md`）+ Part5/Part6 的实现对照深挖。
> **首要代码参照**：codex `execpolicy`（BANNED_PREFIX 黑名单 + 命令降级纯函数）+ openhanako 命令树解析（穿透嵌套 shell 拦 `git push --force`）+ CodeWhale `ToolCapability`（正交能力枚举派生权限）+ Claude Code permission（`decisionReason` + input 相关谓词）。反面教材：deepcode（让模型自报 `sideEffects` 可绕闸）。
> 状态（2026-06-28）：Phase A 全部完成（A0–A6 ✅，见 `handoff-A.md`）。Phase B 已绿灯，**两项定调决策**：① 范围 = 安全执行核心（PermissionGate + 命令解析 + Bash + 审批 + RuleResolver），持久化/断点续跑推迟到下一段；② 沙箱 = 务实方案（确定性解析 + 受限 cwd + 审批闸，不上内核级沙箱）。

---

## 0. B 阶段目标（一句话）

让 agent 能**安全地执行命令**（build / test / git / 装依赖），而不只是读写搜文件。核心是「安全」：危险操作被**确定性**拦截、敏感文件（`.env`/密钥）永不读、改动级操作走**人在环审批**——权限由**运行时强制**，不靠模型自觉、绝不让模型自报。

A 阶段刻意「裸做无权限护栏」（工具想写哪写哪）。B 阶段把那道被推迟的闸门补上，并以它为前提第一次放进 Bash。

---

## 1. 关键决策（定调，后面都服从它）

| # | 维度 | 决策 | 理由 |
|---|---|---|---|
| 1 | 范围 | 安全执行核心：PermissionGate + 命令解析 + Bash + 交互审批 + RuleResolver（B1–B6） | 安全执行是最大能力跃迁、自成闭环；持久化是独立基建，分开做每步更小更稳 |
| 2 | 沙箱深度 | 务实：确定性命令解析 + 受限 cwd + .env/密钥黑名单 + 审批闸 | Codex 式 Windows restricted-token 沙箱极复杂、单人非程序员维护不现实；其它项目在 Windows 多数也靠「解析 + 人审」兜底 |
| 3 | 权限的根 | 确定性解析命令树，**绝不让模型自报** | deepcode 让模型自报 `sideEffects=[]` 就绕闸，是真实可利用漏洞；openhanako tokenizer 解析是正解 |
| 4 | 能力模型 | 工具标 3–4 个正交能力枚举，**派生** approval/sandbox | CodeWhale；没有一个实现用「11 个扁平布尔」，那是过度设计 |
| 5 | 持久化（下一段） | 倾向 append-only JSONL + shadow-git，到那一段再定 | 单人维护：自解释、易备份、无 schema 锁定、Windows 原生；不预先实装 |
| 6 | 不做 | 内核沙箱 / Persistence / worktree 隔离 / LLM-judge 审批 | 见 §6 边界；务实档够用，真需求出现再上 |

---

## 2. 整体架构落点（B 怎么嵌进 A）

四层架构（蓝图 §1）里 B 的模块落点：

```
Surfaces   cli/ ……………………… B3 给 REPL 加「交互审批」渲染（allow/ask/deny）
Runtime    PermissionGate ……… B1 新增：运行时强制 deny→ask→allow（在工具执行前裁决）
Capability RuleResolver ……… B5 新增：三层规则就近合并，喂闸门的 allow/deny
Core       tools/ …………………… B2 命令解析器（纯）+ B4 Bash 工具；ToolCapability 扩展
```

**接线点（B 复用 A 留好的缝）**：
- A2 的 `runAgent` 工具循环里 `ctx.tools.run(call, ctx.toolCtx)` 之前**插入 gate 裁决**——这正是 A2 刻意没做、留给 B 的位置。
- A2 `tools/types.ts` 已有 `ToolCapability = 'read-only' | 'writes-files'`，B 扩成正交枚举并加 `executes-code` / `network`。
- Bash 的大输出复用 A3 的 `budgetToolResult`（超 50K 截断落盘 `data/tool-results/`）。
- RuleResolver 的 frontmatter/分层加载可借 A5 `SkillRegistry` 的零依赖 frontmatter 解析。
- gate 的「ask」走**注入式审批器**（像 A 注入 EventBus/ContextManager 那样）：测试/非交互注入自动决策，B3 注入真实 REPL 交互。

---

## 3. 模块设计

### 3.1 ToolCapability + 能力派生（core/tools）
- **正交能力枚举**（扩 A2）：`ReadOnly / WritesFiles / ExecutesCode / Network`（先 4 个，`Sandboxable` 按需）。由能力**派生**默认审批档与是否需沙箱，不手填布尔。
- **input 相关谓词**（Claude Code）：副作用按入参判，不靠静态布尔——`isReadOnly(input)` / `isDestructive(input)`。如 `write` 写 `.env` 是 destructive、写普通文件是 writes-files。
- **派生表**（纯函数 `deriveApproval(capability, input, ctx)`）：ReadOnly→allow；WritesFiles→ask（本会话可记住）；ExecutesCode→交命令解析器；命中 .env/密钥→deny。
- 验证：能力→默认档的派生纯函数单测；谓词对 .env/普通文件分流单测。

### 3.2 PermissionGate（runtime）— 运行时强制 deny→ask→allow
- **职责**：工具执行前裁决 `allow / ask / deny`（可加 `review` 档，B 阶段先不做）。决策带**可解释 `reason`**（rule / capability / blacklist / user）。
- **风险矩阵默认**（蓝图 §7）：读文件 allow；改源码 ask（本会话可记住）；装依赖/联网 ask；**读 `.env`/密钥 deny**；删除/发布/`git push` ask 或 deny。
- **纯函数决策点**：`decide(call, capability, rules, ctx): { action, reason }`——无状态、可单测含正反边界。
- **注入式审批器**：`approver: (req) => Promise<'allow-once'|'allow-session'|'deny'>`。gate 把 `ask` 交给注入的 approver；非交互默认 deny（fail-closed）。`allow-session` 记进会话级 allowlist（同类操作本会话不再问）。
- **fail-closed**：审批超时 / 异常 / 解析失败一律 deny（蓝图 + Hermes/Codex 共识）。
- 验证：decide 纯函数各档单测；session 记住后同类不再 ask；超时/异常→deny 的触发路径单测。

### 3.3 确定性命令解析器（core/tools，纯）— 安全的根
- **职责**：把一条 shell 命令**确定性**解析成命令树，判定危险/敏感，**绝不信模型自报**。
- **拦截清单**：① 危险命令 `rm -rf` / `git push --force` / `git reset --hard` / 发布类；② **BANNED_PREFIX**（codex，~40 个解释器前缀 `bash -c` / `python -c` / `sh -c` / `sudo` / `node -e` 等，反「黑名单过宽被绕」）；③ 管道符/嵌套二阶执行（`echo x | bash`）；④ 穿透 sh/bash/zsh/cmd/PowerShell **嵌套 depth≤3**（openhanako）。
- **敏感路径**：`.env` / `.env.*` / `*.key` / `*.pem` / `*.token` / `auth.json` / `~/.ssh/` 等——**读写都拦**（deepcode 漏洞：只拦写不拦读）。
- **纯函数 + 重测**：`parseCommand(cmd): { tree, danger, sensitive, reason }`；guardrail 必须有**「真拦到」触发路径单测**（不许只声明不触发）。
- 验证：嵌套在 `sh -c "... git push --force"` 里仍被拦；BANNED_PREFIX 命中；`cat .env` 被拦；安全命令（`node -v` / `npm test`）放行。

### 3.4 Bash 工具（core/tools）— 第一个 ExecutesCode 工具
- **职责**：执行 shell 命令，能力标 `ExecutesCode`，**必过** gate（3.2）+ 命令解析器（3.3）。
- **执行层安全**：受限 cwd（`ctx.toolCtx.cwd`）；超时（默认如 120s，可配）；输出截断 + 超限落盘（复用 A3 `budgetToolResult`）；stderr/stdout 合并回灌；非零退出码作为结果回灌（不抛）。
- **平台**：Windows 上确认默认 shell（cmd / PowerShell / Git Bash 共存）——解析器要覆盖实际用的那个；先支持一种、测通再扩。
- 验证：跑安全命令闭环（过闸→执行→结果回灌→模型据此答）；危险命令被拦、结果是「被拒 + reason」；超时命令被杀。

### 3.5 交互审批 UX（surfaces/cli）— 你的 UX 主场
- **职责**：B3 给 REPL 实现真实 approver——`ask` 时暂停，向用户展示**命令 + 风险 + reason**，读取 `allow once / allow session / deny`（再加可选 `e` 编辑/查看详情）。
- **Ctrl-C 兼容**：审批等待期 Ctrl-C = deny + 中断（复用 A4 AbortSignal）。
- **非交互兜底**：管道/headless 模式 approver 默认 deny（或显式配置 `--auto-allow-safe` 只放行 ReadOnly）。
- 验证：改源码触发审批、allow-once vs allow-session 行为正确（session 后同类不再问）；deny 后操作不执行、结果回灌让模型换路。

### 3.6 RuleResolver（capability）— 三层规则喂闸门
- **职责**：加载并合并三层规则（**全局 `~/AGENTS.md` → 项目 `AGENTS.md` → 路径级 `.rules/`**），就近优先；产出 gate 用的 allow/deny 清单 + 能力约束。
- **md 无强制力**：规则文件只做软引导上下文；**硬约束（禁止读 .env、拦 git push）走 gate/解析器**，不只写 md（蓝图 §0 原则 3 / §6）。
- **就近合并**：path > project > global，last-wins 或字段深合并；`@import` 单源线性继承（防环）；每层 token 预算（防规则撑爆上下文）。
- **纯函数**：`mergeRules(layers): ResolvedRules`——可单测就近覆盖与冲突解决。
- 验证：路径级覆盖项目级单测；`@import` 环检测；硬约束（.env deny）即使 md 没写也由 gate 兜住。

---

## 4. 构建顺序（里程碑，每步可验证再继续）

| 里程碑 | 内容 | 走到这能验证什么 |
|---|---|---|
| **B1 闸门骨架** | PermissionGate（decide 纯函数 + deny→ask→allow + 注入式 approver）+ ToolCapability 扩展 + 接进 `runAgent` 工具循环（现有 read/write/grep 标能力先验证通路） | 工具执行前先过闸；deny 的工具不执行、结果回灌；决策纯函数单测 |
| **B2 命令解析器** | 确定性命令树解析（危险命令 + BANNED_PREFIX + 嵌套穿透 + .env/密钥黑名单），纯函数重测 | 危险/敏感命令被确定性拦截（含嵌套），安全命令放行——**真拦到**的触发路径单测 |
| **B3 Bash 工具** | Bash（ExecutesCode，必过闸+解析器，受限 cwd + 超时 + 输出落盘） | 安全命令闭环执行、结果回灌；危险命令被拒；超时被杀 |
| **B4 交互审批** | REPL 真实 approver（allow once/session/deny，展示命令+风险+reason，Ctrl-C=deny），非交互兜底 | 终端里看到审批提示、选择生效、session 记住；管道默认 deny |
| **B5 RuleResolver** | 三层规则就近合并 + token 预算，喂闸门 allow/deny；`@import` 单源 | 路径级覆盖项目级；硬约束由 gate 兜住而非只写 md |
| **B6 验收收口** | 跑完整验收清单（§5）+ 补齐触发路径单测 + 清理 + 文档 | 验收清单全绿、单测覆盖决策点与拦截触发分支 |

每里程碑节奏沿用 A：纯函数 → 实现 → 接线 → 四关卡（typecheck/lint/build/test）→ 可跑 demo → commit。

---

## 5. B 阶段验收契约（可验收、堵作弊）

**确定性脚本化清单：**
1. **敏感文件 deny**：让 agent 读 `.env`/密钥 → 断言被 gate **deny**（连读路径，不只写）。
2. **危险命令拦截**：`git push --force` / `rm -rf` 嵌套在 `sh -c "..."` 里 → 断言**确定性解析**拦住（不靠模型自报）——触发路径单测。
3. **Bash 闭环**：安全命令（如 `node -v`）→ 过闸 → 执行 → 结果回灌 → 答案用到结果。
4. **审批分档**：改源码触发 ask；allow-once 只这次、allow-session 本会话同类不再问、deny 不执行。
5. **决策纯函数**：gate decide / 命令解析 / 能力派生 / 规则合并 各正反 + 边界。
6. **谎报不绕闸**：即使工具调用声称 read-only，命令解析器仍独立拦危险命令——**堵 deepcode 漏洞**（断言模型自述不影响裁决）。

**作弊路径预先堵死**：拦截器/guardrail 必须有「真触发」单测，不许只声明不触发、不许只自增不读；**绝不让模型自报权限/副作用**；`npm test`+`typecheck`+`build` 端到端真过、有输出为证。

**谁来验**：B 阶段权限/安全客观可测（断言拦截真触发），主跑测试即可；安全关键处（命令解析覆盖、绕闸尝试）可加独立子代理或 `/review` 做对抗性核查（裁判≠运动员）。

---

## 6. B 阶段明确不做（反过度工程，划清边界）

- ❌ **内核级沙箱**（Codex restricted-token / seccomp / landlock）→ 务实档（解析 + 受限 cwd + 审批）够；真出现强隔离需求再上。
- ❌ **Persistence + SessionStore + 断点续跑**（SQLite/JSONL + shadow-git + 进度文件）→ B 的下一段（倾向 JSONL+shadow-git，到时再定）。
- ❌ **git worktree 隔离** → C 多 agent 并行写同批文件时才需要。
- ❌ **LLM-judge / Guardian 审批层**（双轴 risk×authorization 裁决）→ 务实档先用确定性 + 人审；LLM-judge 是后续可选增强。
- ❌ **网络出站 MITM 代理 / host allowlist** → 出现真实联网需求再建；B 先把「装依赖/联网」默认 ask。
- ❌ **MCP / 多 provider 实装 / 虚拟文件系统底座** → 按需才建。
- ❌ SubagentManager（C）/ GoalLoop·Hooks（D）/ GUI（E）。

---

## 7. 风险 / 待核实

| 项 | 处置 |
|---|---|
| Windows shell 多样性（cmd / PowerShell / Git Bash 共存） | B2 先锁定一种实际默认 shell、解析器覆盖它、测通再扩；命令树解析按目标 shell 语法 |
| 「ask」在非交互（管道/headless/CI）模式怎么办 | 默认 fail-closed deny；可选 `--auto-allow-safe` 只放行 ReadOnly；写进 §3.5 |
| 命令解析器覆盖完整性（漏网命令） | 黑名单 fail-closed（不确定就当危险走 ask）+ 持续补；对抗性子代理找绕过 |
| 持久化机制（JSONL vs SQLite） | 推迟到下一段；已倾向 JSONL+shadow-git（单人友好），届时按真实检索需求定 |
| Bash 超时杀进程在 Windows 的可靠性 | B3 先验证 child_process 超时 + 树杀（taskkill /T）；先测后报 |
| 非程序员独自维护 | 决策点纯函数 + 单测 + 小模块；安全规则沉到可读的解析器 + 规则文件，复杂度不堆在 md |

---

## 8. 下一步

绿灯后从 **B1 闸门骨架**开始，每个里程碑交付可运行/可测产物给你验，过了再下一个；不一次性写完六个里程碑闷头交付。安全关键里程碑（B2 命令解析、B3 Bash）额外做对抗性核查（独立子代理试绕过）。

> 范围与沙箱深度已定（§1 决策 1/2）；持久化机制（§1 决策 5）留到 B 之后的「持久化段」按真实需求再拍。
