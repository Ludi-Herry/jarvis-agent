# 交接：Phase A 完成（A0–A6，2026-06-28）

> 类型：历史阶段快照。测试数量、下一步和“当前”表述只代表 2026-06-28；当前入口见 `docs/README.md`。

给接手者（人或 AI）。读完这页你应知道：Phase A 整体做了什么、关键决策与 gotcha、§5 验收怎么映射到测试、怎么运行、下一步从哪开始。A0/A1 的早期细节见 `handoff-A1.md`；完整设计见 `phase-A-plan.md`；项目规则见根 `AGENTS.md`。

## 一句话状态

**Phase A 全部完成**：单 agent 能在终端跑起来——说话、自己调工具、上下文满了自动压缩、按需用 skill。`npm run typecheck / test / build / lint` 全绿（**117 测试**），每个里程碑有真连 Doubao 的实跑 demo。下一步 **Phase B**（权限闸门 + Bash 工具等，未开工）。

## 架构一句话

**有状态宿主 + 纯函数决策点**：`runAgent` 是有状态的回路（调模型→发事件→执行工具回灌→压缩→兜底），所有「判断」都抽成纯函数（`decideStop`/`withinBudget`/`decideCompact`/`canSplitAfter` 等）单点可测。所有产出经 **EventBus** 广播，前端（CLI）只订阅——「加界面 = 加订阅者」，不改核心。

## 各里程碑（含 commit）

| 里程碑 | commit | 内容 |
|---|---|---|
| A0 脚手架 | 9b608a9 | package.json / tsconfig(strict,ESM) / vitest / eslint + 目录骨架 |
| A1 能说话 | c416eba · d58b612 | DoubaoProvider（流式 ModelProvider）+ EventBus |
| A2 能调工具 | e0fb3dc | ToolRegistry(read/write/grep) + AgentLoop(runAgent + 决策纯函数) |
| A3 能压缩 | 7be255a | ContextManager：压缩 + 安全切点 + 工具输出落盘 |
| A4 能在终端跑 | ec47c4e | CLI REPL（render 纯函数 + repl 壳 + commander 入口） |
| A5 能用 skill | 8860960 | SkillRegistry（三级渐进披露）+ git-commit skill |
| A6 验收收口 | （本提交） | §5 清单核对 + 文档刷新 + 清理 |

### A2 能调工具（`src/core/tools/`, `src/core/loop/`）
- **ToolRegistry** 是模型↔副作用之间的安全漏斗：模型给的脏调用（名字不存在 / JSON 烂 / zod 校验失败 / 工具 run 抛错）四种**全归一成带 `error` 的 ToolResult，绝不抛**，循环把失败回灌给模型继续。
- **三工具**：read、write（自动建父目录）、grep（递归、`path:line:text`、200 条上限）。裸做无权限护栏（A 阶段刻意，权限闸门是 B 阶段）。
- **json-schema 归一**：zod→JSON-Schema 后 deref `$defs`/`$ref`、删 `$schema`、补 root `type`——严格端点（ARK）拒收带 `$defs` 的 schema。纯函数单测独立覆盖。
- **AgentLoop**：`runAgent` 有状态回路 + 决策纯函数 `decideStop`/`withinBudget`/`decideCompact`；`maxTurns` 保险丝防无限调工具，并配有真正触发的单测。
- **round-trip 关键**：assistant 的 `tool_call.id` 与 tool 消息的 `tool_call_id` 一致性靠 wire 层 `sanitizeToolCallId`（幂等截断到 64），循环不用管。

### A3 能压缩（`src/core/context/`）
- **触发**：prompt 接近**有效输入预算**（窗口 − 预留输出）时压缩，复用 `decideCompact`（0.83 阈值）。
- **安全切点**（`split.ts` 纯函数）：绝不在 user 消息后切、绝不把 tool_call 和它的 result 切散、tail 不以「无头 tool 结果」开头。`findSplitPoint` 目标保最近 N 条（默认 20），不安全就往早走（保更多）。
- **压缩**：调（便宜）模型按结构化模板出摘要（目标/已完成/阻塞/决策/待办/相关文件），首个 system 消息当不可变前缀保住，原地 splice 替换。
- **工具输出落盘**：单个结果 >50K 字符截断、全文存 `data/tool-results/`（已 gitignore）、上下文只留指针+预览。
- **接线**：`runAgent` 的 `ctx.context` 可选；不传 = A2 老行为。

### A4 能在终端跑（`src/surfaces/cli/`）
- **极简版 readline + stdout**（用户拍板，没用 ink）：追加式流式输出、滚动天然、易验证。
- **三层**：`render.ts`（纯：事件→文字 + midLine 状态，全单测）· `repl.ts`（壳：读行→跑 agent→渲染→再提示，输入/输出流可注入，免 TTY 可测）· `index.ts`（commander 组装根）。
- **Ctrl-C** 经 AbortSignal 打断在途 run（provider 第 92 行透传 signal），空闲时 / `/exit` 退出。
- 跑：`npm run dev`。

### A5 能用 skill（`src/capabilities/skills/`, `skills/`）
- **三级渐进披露省 token**：L1 名录（name+description）每轮都注入（便宜）；L2 完整 SKILL.md body 只在用户消息命中 `triggers` 时注入（贵）；L3 脚本（A 阶段不需要）。
- **零依赖 frontmatter 解析**（只支持 scalar + 内联数组，不上 yaml 库）。匹配是确定性关键词包含（可测、无需模型 round-trip）。
- **接线**：`runAgent` 的 `systemAddendum` 可选，**发送时**折进 system 消息（新数组，不污染 `messages`、不被压缩、每轮刷新）；REPL 每轮按用户消息算 addendum。
- **git-commit skill**：英文 message、`type(scope): intent`、固定 Co-Authored-By 行；A 阶段无 git 工具→引导贴 diff / read 指定文件，不编造。

## §5 验收契约 → 测试映射（全绿）

| §5 条目 | 覆盖测试 |
|---|---|
| 1 工具闭环 | `run-agent` "runs a model-requested tool, feeds the result back…" + `npm run demo:a2`（答案含只在文件里的 4724） |
| 2 压缩触发 | `run-agent` "compacts in-loop…keeps system + tail" · `context-manager` compact 组 · `split` canSplitAfter/findSplitPoint · demo:a3 |
| 3 事件按序 | `run-agent` "emits events in message_delta → tool_call → tool_result → final order, plus usage" |
| 4 停止/兜底 | `run-agent` "trips the maxTurns halt when the model never stops calling tools"（真触发，否则测试会挂） |
| 5 决策纯函数 | `decisions`（decideStop / withinBudget / decideCompact，各含正反+边界） |
| 6 skill 披露 | `skill-registry` "discloses the body only for a relevant message — the §5.6 token difference" |

作弊路径已堵：无删/skip 测试、guardrail 真触发非死代码、四项关卡端到端真过。

## 关键决策

- **首发模型 Doubao-Seed-2.1-pro**（火山方舟 ARK，OpenAI 兼容）；ModelProvider 留好切换，Kimi/DeepSeek 日后 drop-in。详见项目记忆 `model-provider-doubao-first`。
- **A4 渲染选极简 readline+stdout 而非 ink**（用户作为 UX 拍板）：A 阶段最小骨架追求简单+可验证，ink 留作以后专门 UI 打磨。
- **裸做无权限护栏**（用户定）：A 阶段工具不加沙箱/路径约束，权限整体留到 Phase B。

## gotcha / 已知小账（留给 B+，当前不影响验收）

- **上一轮工具组「假完成」**：A2 接手时发现上一会话报告「工具组完成、20 测试绿」但 `registry.ts`/`builtins.ts`/`json-schema.test.ts` 从未落盘（Write 工具 "... wait" 污染）。已重建并验证。教训：别信叙述，跑真实测试核磁盘。
- **压缩用同一个豆包模型**做摘要；当前没有单独配置更便宜的压缩模型，以后可按需注入。
- **压缩中途模型调用失败会中断整轮**——未加容错（避免堆没验证需求的错误处理），留作 B 硬化。
- **交互式 Ctrl-C** 只能人工跑 `npm run dev` 亲手按确认（管道不发 SIGINT）；abort 接线 + provider signal 透传已单测。
- **reasoning 结构化（数组）形态**当前丢弃只取字符串（A1 遗留，`reasoning.test.ts` 有记录），接数组形态端点时补。
- **安全**：ARK key 早期对话明文出现过，建议火山控制台轮换一次。

## 关键文件

```
src/core/types.ts                  # 共享域类型
src/core/model/                    # ModelProvider（Doubao 流式）+ 纯函数决策点（A1）
src/core/tools/{registry,builtins,json-schema,types}.ts   # ToolRegistry + 三工具（A2）
src/core/loop/{run-agent,decisions}.ts                    # AgentLoop + 决策纯函数（A2）
src/core/context/{context-manager,split}.ts               # ContextManager + 安全切点（A3）
src/runtime/event-bus.ts           # EventBus（A1）
src/capabilities/skills/{skill-registry,frontmatter}.ts   # SkillRegistry（A5）
src/surfaces/cli/{render,repl,index}.ts                   # 终端 REPL（A4）
skills/git-commit/SKILL.md         # git-commit 技能内容（A5）
scripts/a{1,2,3,5}-demo.ts         # 各里程碑真连 Doubao 实跑
test/                              # 117 单测
```

## 下一步：Phase B（未开工）

Phase A 的「不做边界」里压后到 B 的：**PermissionGate（权限闸门）+ Bash 工具**（裸放 Bash 等于裸奔，必须先有闸门）、沙箱/路径约束、reasoning 数组形态、压缩容错。具体 B 阶段设计尚未展开——开工前按蓝图先出 Phase B plan，再照 A 的节奏（每里程碑：纯函数→实现→接线→四关卡→真 demo→commit）走。
