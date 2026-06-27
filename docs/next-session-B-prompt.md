# 接手 Prompt：Jarvis-Agent Phase B（从 B1 开始）

> 可直接整段喂给新会话。

## 你是谁、为谁做

接手自研编码 agent **Jarvis-Agent** 的 **Phase B**，从里程碑 **B1（PermissionGate 闸门骨架）** 开始。用户陆凌华（Luis，UX 设计师、非程序员）：技术解释落到体验 / 维护 / 风险，别堆术语；默认简体中文对话，代码 / 命令 / commit 用英文；别谄媚、给真实判断、方案有问题直接说。

## 动手前先读这些

1. 仓库 `H:\jarvis-agent`（Phase A 全完成 A0–A6、branch `main`、工作树干净；项目原名 agent-harness，2026-06-28 改名 Jarvis-Agent）。系统会自动加载项目记忆（含 `product-name-jarvis-agent`、`model-provider-doubao-first`）。
2. `H:\jarvis-agent\AGENTS.md` — 项目规则（TS strict、ES modules、决策点写成无状态纯函数 + 单测、guardrail 必须有触发路径单测、不为「跑起来」注释报错 / 跳测试 / 降规则）。
3. `H:\jarvis-agent\docs\handoff-A.md` — Phase A 已建什么（ModelProvider / EventBus / ToolRegistry / AgentLoop / ContextManager / CLI / SkillRegistry）、关键决策、gotcha、§5→测试映射。
4. `H:\jarvis-agent\docs\phase-B-plan.md` — **这次的设计**。重点读 §1 定调决策、§3 模块设计、§4 里程碑、§5 验收契约、§6 边界。

## Phase B 一句话 + 已拍板

让 agent 能**安全地执行命令**（build / test / git / 装依赖），不只是读写搜文件。两项决策已定（§1）：
- **范围** = 安全执行核心（PermissionGate + 命令解析 + Bash + 交互审批 + RuleResolver，B1–B6）；持久化 / 断点续跑推迟到 B 之后的「持久化段」。
- **沙箱** = 务实档（确定性命令解析 + 受限 cwd + .env/密钥黑名单 + 审批闸，**不上内核级沙箱**）。

**安全的根（最重要的一条）**：权限由运行时**确定性解析命令树**判定，**绝不让模型自报副作用**——deepcode 让模型自报 `sideEffects=[]` 就绕闸，是真实可利用漏洞；正解照 openhanako 解析命令树穿透嵌套 shell。

## 这次只做 B1（闸门骨架）

- `decide(call, capability, rules, ctx): { action: 'allow'|'ask'|'deny', reason }` —— deny→ask→allow + 风险矩阵（读文件 allow、改源码 ask、读 .env/密钥 deny…），无状态纯函数，单测含正反 + 边界 + 可解释 reason。
- **ToolCapability 扩成正交枚举**（`ReadOnly / WritesFiles / ExecutesCode / Network`，扩 A2 现有 `read-only/writes-files`）；现有 read/write/grep 标上能力。
- **注入式 approver**（像 A 注入 EventBus/ContextManager 那样）：`ask` 交注入回调；非交互 **fail-closed deny**；`allow-session` 记会话级 allowlist（同类本会话不再问）。真实交互 UX 是 B4，不在 B1。
- **接进 `runAgent` 工具循环**：在 A2 刻意留的缝——`ctx.tools.run(call, ctx.toolCtx)` 之前插入 gate 裁决；deny 的工具不执行，把「被拒 + reason」回灌给模型换路。
- B1 用现有 read/write/grep 验证闸门通路（读 allow、改源码 ask、读 .env deny），**Bash 是 B3**。

## 工作节奏（沿用 A）

纯函数 → 实现 → 接线 → 四关卡（`npm run typecheck / lint / build / test` 全绿，有输出为证）→ 可跑 demo / 验证 → `git commit` 到 main（English message，结尾固定：
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`）。
**每里程碑过了等用户绿灯再下一个，不擅自往后写。**

## 环境 & gotcha

- demo 需环境变量 `ARK_API_KEY`（Doubao / 火山方舟 ARK，已设）。`npm run dev` 起终端 REPL。
- **别信叙述、核磁盘**：A2 曾被上一轮「报告完成但文件没落盘」坑过——跑真实测试拿地面真相，每个文件写完核实落盘。
- 交互式审批 / Ctrl-C 只有用户亲手跑能最终确认（管道不发 SIGINT）；自动化测试里用注入式 approver 覆盖。
- **Windows shell 多样**（cmd / PowerShell / Git Bash 共存）：命令解析先锁定一种实际默认 shell，测通再扩；解析按目标 shell 语法。
- commit 只在四关卡真过后；`git push` 仅用户明确要求（本仓库无远程）。安全关键里程碑（B2 命令解析、B3 Bash）额外做对抗性核查（独立子代理试绕过）。

## B1 之后（别一次写完）

B2 命令解析器 → B3 Bash 工具 → B4 交互审批 UX → B5 RuleResolver → B6 验收收口。详见 `phase-B-plan.md` §4。
