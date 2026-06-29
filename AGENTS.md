# Jarvis-Agent · 项目规范

陆凌华（UX 设计师，非程序员）自研的 TypeScript/Node 编码 agent —— **Jarvis-Agent**（CLI + agent harness），未来叠加自定义 GUI。本文件是这个仓库的规则层；跨工具个人默认见 `~/.codex/AGENTS.md`，不在此重复。

## 这是什么 / 不是什么
- **是**：一个有状态宿主 + 纯函数决策点的 agent loop，事件流 day-1 解耦前端，渐进披露 skill，确定性交脚本、判断交模型。
- **不是**：不预埋抽象层 / 插件系统 / 通用框架；没证明需要前不建。反过度工程，目录按需才建。

## 唯一设计依据（source of truth）
架构蓝图与设计决策**不在本仓库重写**，以知识库里的报告为准：
- 共识骨架：`H:\LLM本地知识库\采集\external\agent-harness-调研\agent-harness-Part2-架构蓝图.md`（含 v2/v3 修订）
- 源码级证据：同目录 Part1/4/5/6；独立验收设计：Part7。
- 改动若与蓝图冲突，先在知识库改蓝图、再改代码（规范先行）。

## 目录结构（蓝图 §11 精简版，按需才扩）
```
src/
  core/        # AgentLoop, ToolRegistry, ContextManager, ModelProvider
  runtime/     # EventBus（A 阶段先有这个；SessionStore/PermissionGate/Persistence 后续）
  capabilities/# SkillRegistry（A）+ RuleResolver（B）+ SubagentManager（C，subagents/）；Hooks 后续
  surfaces/    # cli/（future: gui/）
skills/        # 各 skill 文件夹（SKILL.md + scripts/ + references/）
docs/          # 方案/设计文档（phase-A-plan.md 等）
data/          # 运行期状态（gitignore 大件；A 阶段暂未用）
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
- 安装：`npm install`
- 构建：`npm run build`（tsc）
- 测试：`npm test`（vitest）
- 类型检查：`npm run typecheck`
- Lint：`npm run lint`（eslint）
- 跑 CLI：`npm run dev`（终端 REPL；带权限闸门 + bash + 交互审批 + 会话落盘）
- 续跑：`npm run resume`（恢复 `data/sessions/` 最近一个会话；指定 id 用 `npx tsx src/surfaces/cli/index.ts --resume <id>`。注：PowerShell 下 `npm run dev -- --resume` 会被 npm 吞掉 `--resume`，故用专用脚本）
- 活体 demo（需 `ARK_API_KEY`）：`demo:a1/a2/a3/a5`（A 各里程碑）、`demo:b1`（权限闸门：读 allow / 改源码 ask / 读 .env deny）、`demo:b3`（bash 安全闭环 + 危险/密钥拦截）
> 写代码声明完成前，先把 typecheck / lint / test / build 端到端跑通，有证据再说"完成"。

## Git
- commit message 用英文，简洁说明意图。
- 默认分支 main；push 仅在明确要求时（跨设备同步），不靠 push 部署。

## 清理
- 阶段任务完成后删临时产物（评估/备份/中间脚本），确认只剩核心交付。
