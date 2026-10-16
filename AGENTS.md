# Jarvis-Agent · 项目规范

陆凌华（UX 设计师，非程序员）自研的 TypeScript/Node 编码 agent —— **Jarvis-Agent**（agent harness + 本地 GUI + CLI）。**GUI 是主界面**，CLI 保留给脚本、自动化和排障。本文件是这个仓库的规则层；个人全局默认由当前宿主加载，本文件定义项目专属规则。

## 产品定位与范围
- **是**：一个有状态宿主 + 纯函数决策点的 agent loop，事件流 day-1 解耦前端，渐进披露 skill，确定性交脚本、判断交模型。
- **范围**：不预埋抽象层 / 插件系统 / 通用框架；没证明需要前不建。反过度工程，目录按需才建。

## 硬约束
- **不再新增 verifier / route / scheduler 抽象**：现有 `--verifier-map`、`--hook-map`、`--sandbox-check-map`、`--goal-setter-requirements-map` 四套 map 就是当前边界。后续只做 bug 修复、边界收窄和必要文档同步；要重开这类抽象，必须先由 Ludi 明确推翻本条并先改本规范。
- **`propose_skill` 继续不做**：skill 自动沉淀属于已拍板 defer，不把它当待办自动实现。

## 唯一设计依据（source of truth）
架构蓝图与设计决策**不在本仓库重写**，以知识库里的报告为准：
- 共识骨架：`H:\LLM本地知识库\采集\external\agent-harness-调研\agent-harness-Part2-架构蓝图.md`（含 v2/v3 修订）
- 源码级证据：同目录 Part1/4/5/6；独立验收设计：Part7。
- 改动若与蓝图冲突，先在知识库改蓝图、再改代码（规范先行）。
- **云端 / 远程 agent 读不到 `H:\` 知识库**：以仓库内摘要为准（`docs/handoff-D.md`、`docs/phase-*-plan.md`、`docs/security-review-baseline.md`）；摘要不够时**向 Ludi 要原文片段，不要猜**。

## 目录结构（按需才扩）
```
src/
  core/          # AgentLoop, ToolRegistry, ContextManager, ModelProvider
  runtime/       # EventBus、session/（会话落盘与恢复）、permission/（权限闸门、命令分析、审批）
  capabilities/  # skills、rules、subagents/、goal/（目标循环与完成判定）、hooks/
  surfaces/      # gui/（主界面；app/ 是独立的 React 子包，自带 package.json）+ cli/
skills/          # 各 skill 文件夹（SKILL.md + scripts/ + references/）
agents/          # 子 agent 定义（如 researcher/）
eval/            # 评测（a0/ 无头验收，见 docs/headless-a0-contract.md）
scripts/         # demo、smoke、红线检查（redline-check.ts）、变异测试（mutation/）
prototypes/      # 一次性原型与对照稿（不进运行时）
docs/            # 方案、决策、交接、证据（docs/evidence/ 只增不改）
data/            # 运行期状态（会话、审计、日志；gitignore）
```

## 命名 / 风格
- 语言 TypeScript（strict）；模块 ES modules。
- 文件名 kebab-case；类型/接口 PascalCase；函数/变量 camelCase。
- 决策点写成无状态纯函数 + 单测（停止/续跑/压缩/权限判定）。
- 副作用通过注入接口，不在纯函数里读盘/发网。

## 工程纪律
- 改动前先定完成标准；选最直接、最小、最易验证的方案。
- guardrail（平时不触发的熔断/兜底）**必须有触发路径单测**，否则算未完成（绿灯≠成功）。
- 只改与当前目标相关的文件；自己产生的死代码要清理，原有死代码只报告。
- 不为「跑起来」注释报错 / 跳过测试 / 降规则。

## 命令
- 安装：`npm install`；GUI 子包另装 `npm install --prefix src/surfaces/gui/app`
- 跑 GUI（主界面）：`npm run gui`
- 构建：`npm run build`（tsc）；GUI 构建：`npm --prefix src/surfaces/gui/app run build`
- 测试：`npm test`（vitest）；机器忙或只想看结果时用 `npx vitest run --maxWorkers=4`（CLI 子进程测试在高负载下容易超时）
- 类型检查：`npm run typecheck`；Lint：`npm run lint`（eslint）
- 统一 CLI：`npm run jarvis -- --help`；终端 REPL：`npm run dev`；续跑：`npm run resume`（恢复 `data/sessions/` 最近一个会话；指定 id 用 `npx tsx src/surfaces/cli/index.ts --resume <id>`。PowerShell 下 `npm run dev -- --resume` 会被 npm 吞掉 `--resume`，故用专用脚本）
- 活体 demo（需 `ARK_API_KEY`）：`demo:a1/a2/a3/a5`、`demo:b1`（权限闸门）、`demo:b3`（bash 安全闭环）
> 源码或运行行为变更声明完成前，运行 typecheck / lint / test / build；**改了 GUI 再加 GUI 构建**。纯文档改动检查差异、引用路径与命令名称，不启动业务全量测试。

## 独立裁判（CI）与红线
- **自己跑的绿 ≠ 裁判的绿**。GitHub Actions「门禁」（`.github/workflows/ci.yml`）在干净的 Linux + Windows 上从零跑全部检查；声明完成以它的结果为准，本地结果只作参考。门禁红了先修，不许绕。
- **红线**：`.github/redlines.txt` 列出的文件（门禁、裁判、权限、证据、检查配置）和"降规则"迹象（新增 skip/only、@ts-ignore、eslint-disable，删测试、删断言）会被「红线检查」拦下，必须由 Ludi 加标签「红线已确认」。
- **AI 永远不能自己加「红线已确认」标签**，也不能为了让检查变绿去改红线清单、检查脚本或工作流；需要改时在 PR 里写清理由，等 Ludi 确认。
- 改权限判定、完成判定（`src/runtime/permission/**`、`src/capabilities/goal/verdict.ts` 等）时，在 PR 上加标签 `mutation` 跑变异测试；**"放行方向"的存活变异（deny/ask→allow、rejected→verified）必须补测试杀掉**，其余存活的要分类说明。说明见 `docs/quality-gates.md`。

## 安全评审
- 动到信任边界（权限、沙箱、审批、命令执行、写入范围、完成授权）的改动：至少 **2 个独立的只读 reviewer**，各从不同攻击角度看；再加 1 个**完整性 critic** 查漏项。
- reviewer 用当前宿主提供的独立只读子 agent（不复用写代码那一方的上下文，不写死模型或 CLI 版本），一轮结束即关闭。
- reviewer 的结论要**实证验证**（真跑 `analyzeCommand` / `decide`、复现或写反例测试），不凭描述采信；**最终由 Ludi 拍板**。
- 评审清单与严重度标准见 `docs/security-review-baseline.md`。

## Git
- commit message 用英文，简洁说明意图。
- 默认分支 main；push 仅在明确要求时（跨设备同步），不靠 push 部署。改动走分支 + PR，由 Ludi 合并。

## 清理
- 阶段任务结束时列出本轮临时产物；删除须按用户授权执行。保留失败证据、备份和其他会话文件，不自动清理。
