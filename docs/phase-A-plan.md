# Phase A 搭建方案 · 单 agent 能跑

> 依据蓝图 §12 的 A 阶段 + §10 技术栈 + §11 目录 + §2/§3/§7/§8 模块设计。
> 蓝图原文：`H:\LLM本地知识库\采集\external\agent-harness-调研\agent-harness-Part2-架构蓝图.md`。
> 状态：方案待陆凌华绿灯 → 绿灯后按「构建顺序」逐里程碑写，每个里程碑交付可验证产物再继续。

---

## 0. A 阶段目标（一句话）

让**单个 agent 在终端里跑起来**：你输入 → 它对话 / 调工具（读写文件、检索）/ 上下文超阈值自动压缩 / 全过程在终端流式可见。事件流第一天就铺好，所以将来接 GUI 是「接订阅」不是「改架构」。

**A 阶段证明的核心命题**：有状态宿主 + 纯函数决策点这套骨架，真能让单 agent 稳定跑通对话-工具-压缩闭环，且决策逻辑可单测。

---

## 1. 已定决策（动手前锁定）

| # | 决策 | 选了什么 | 为什么 |
|---|---|---|---|
| 1 | 代码位置 | 独立仓库 `H:\agent-harness`（已 git init，branch main） | 与知识库 vault 分离，harness 是产品不是笔记 |
| 2 | 首个 model provider | **只接 Anthropic 一家**，走 Messages API + 流式 | 你用 Claude；多 provider 抽象保持薄但 A 阶段不实装（YAGNI） |
| 3 | 首个工具集 | **Read + Write + Grep** | 够演示对话+副作用+检索；**Bash 推迟到 B 阶段**——A 阶段没上 PermissionGate，放 Bash = 裸奔 |
| 4 | 首个 skill | **git-commit**（写符合规范的 commit message） | 最小、贴你工作流、零额外依赖，正好演示三级渐进披露 |
| 5 | A 阶段验收方式 | **客观确定性测试**（脚本化清单 + 单测） | Part7 那套独立 LLM 裁判是 D 阶段 GoalLoop 才上，A 阶段杀鸡用牛刀 |

---

## 2. 技术栈（蓝图 §10，A 阶段实际用到的）

| 关注点 | 选型 | A 阶段是否用 |
|---|---|---|
| 语言/运行时 | TypeScript（strict）+ Node ≥20，ES modules | ✅ |
| 模型 SDK | 自封 `ModelProvider`，内部包 `@anthropic-ai/sdk` | ✅（仅 Anthropic）|
| 异步流 | async generator + EventEmitter | ✅ |
| Schema 校验 | `zod`（工具入参 + 配置） | ✅ |
| CLI/TUI | `commander`（命令） + `ink`（React for CLI，渲染流式） | ✅ |
| 测试 | `vitest` | ✅ |
| 持久化 | better-sqlite3 + FTS | ❌ B 阶段 |
| 版本/快照 | simple-git / shell git | ❌ B/C 阶段（git-commit skill 用 shell git 读 diff 除外）|
| 沙箱 | 子进程 + 受限 cwd | ❌ B 阶段（随 Bash + PermissionGate）|

---

## 3. 模块设计（7 个，每个：职责 / 最小形态 / 接口草案 / 验证）

### 3.1 ModelProvider（core）— 跟模型说话的统一插座
- **职责**：把"调一次模型、拿流式回复+工具调用+用量"封在统一接口后，provider 可换。
- **最小形态**：只实现 `AnthropicProvider`，支持 streaming，返回 token 用量（用 API 真实 `usage`，为 §3.3 压缩判定服务）。
- **接口草案**：
  ```ts
  export interface ModelResult {
    text: string;
    toolCalls: ToolCall[];
    usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
    stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  }
  export interface ModelProvider {
    // 流式：yield 增量事件；最终 resolve 出聚合结果
    call(messages: Message[], tools: ToolSchema[], signal?: AbortSignal):
      AsyncGenerator<ModelDelta, ModelResult>;
  }
  ```
- **验证**：喂一句话拿到流式增量 + 聚合 `ModelResult` + 非零 usage；断网/坏 key 报可读错误。

### 3.2 EventBus（runtime）— 内部广播站（GUI 解耦的根，day-1）
- **职责**：所有"发生了什么"以 client-agnostic 事件发出，前端只订阅，不直连 core。
- **最小形态**：内存 EventEmitter + 蓝图 §8 的 canonical 事件枚举子集；带 `unknown` 兜底（未知事件不崩）。
- **接口草案**：
  ```ts
  export type Event =
    | { type: 'message_delta'; text: string }
    | { type: 'tool_call'; call: ToolCall }
    | { type: 'tool_result'; out: ToolResult }
    | { type: 'state'; phase: string }            // e.g. 'compacting'
    | { type: 'usage'; inputTokens: number; outputTokens: number }
    | { type: 'final'; text: string }
    | { type: 'halt'; reason: 'maxTurns' | 'budget' | 'error' };
  export interface EventBus {
    emit(e: Event): void;
    subscribe(fn: (e: Event) => void): () => void;  // 返回取消订阅
  }
  ```
- **验证**：emit 一个事件、订阅端按序收到；发未登记 type 不抛。

### 3.3 ToolRegistry（core）— 工具登记处 + 入参校验
- **职责**：登记工具（name/description/zod schema/run），校验入参，执行，返回结果。
- **最小形态**：登记 **Read / Write / Grep** 三个内置工具；zod 校验入参；执行抛错归一成 `ToolResult.error`。
- **接口草案**：
  ```ts
  export interface ToolDefinition<I = unknown> {
    name: string;
    description: string;
    inputSchema: ZodType<I>;
    capability: ToolCapability;     // ReadOnly | WritesFiles | ...（A 阶段只用前两类标注，不派生权限）
    run(input: I, ctx: ToolRunCtx): Promise<ToolResult>;
  }
  export interface ToolRegistry {
    register(t: ToolDefinition): void;
    schemasForModel(): ToolSchema[];          // 转 Anthropic tools 格式
    run(call: ToolCall): Promise<ToolResult>; // 内部先 zod 校验
  }
  ```
- **验证**：合法调用执行成功；非法入参被 zod 拦截、返回结构化错误；Read 读到文件内容、Write 落盘、Grep 命中。

### 3.4 AgentLoop（core）— 心脏：有状态生成器 + 纯函数决策点
- **职责**：调模型 → 流式发事件 → 有工具调用就执行回灌、没有就收尾 → 超阈值压缩 → 预算兜底。蓝图 §2 的 `runAgent()`。
- **最小形态**：有状态 async generator，副作用经注入的 `ctx`（model/tools/context/bus）；**决策点抽纯函数**：
  ```ts
  // 纯函数决策点（无状态、可单测）
  export function decideStop(res: ModelResult): { done: boolean; reason?: 'final' };
  export function decideCompact(usage: Usage, window: number): boolean;  // 80-85% 阈值
  export function withinBudget(turn: number, budget: Budget): boolean;

  // 有状态宿主
  export async function* runAgent(ctx: AgentContext): AsyncGenerator<Event> {
    let turn = 0;
    while (withinBudget(turn, ctx.budget)) {
      const res = yield* ctx.model.call(ctx.messages, ctx.tools.schemasForModel());
      if (decideStop(res).done) { yield { type:'final', text: res.text }; return; }
      for (const call of res.toolCalls) {
        const out = await ctx.tools.run(call);
        ctx.messages.push(wrapResult(out));
        yield { type:'tool_result', out };
      }
      if (decideCompact(res.usage, ctx.window)) await ctx.context.compact(ctx.messages);
      turn++;
    }
    yield { type:'halt', reason:'maxTurns' };
  }
  ```
- **验证**：一轮里能自己决定调工具、无工具调用时收尾；`maxTurns` 兜底触发 halt（**触发路径单测**）；决策三函数各有单测含触发分支。

### 3.5 ContextManager（core）— 上下文管家：满了就压缩
- **职责**：按 API 真实 token 数判断、80-85% 触发结构化摘要、尾部保护、边界对齐。
- **最小形态**：基于"有效输入预算 = 窗口 − max_output"，超 ~83% 触发；调便宜模型按结构化模板摘要（目标/已完成/阻塞/决策/待办/相关文件）；保护末 ~20 条；边界对齐到 assistant 父消息保 tool_call/result 组完整。
- **接口草案**：
  ```ts
  export interface ContextManager {
    shouldCompact(usage: Usage): boolean;        // = decideCompact 包一层
    compact(messages: Message[]): Promise<void>; // 原地替换为 摘要 + 尾部保护
  }
  ```
- **验证**：灌长对话 → 压缩真触发（断言 `state: 'compacting'` 事件）；摘要进了上下文、尾部保护生效、tool 组没被截断；压缩后还能继续对话。

### 3.6 CLI（surfaces/cli）— 终端界面：订阅 EventBus 渲染
- **职责**：REPL，读用户输入 → 跑 `runAgent` → 订阅 EventBus 流式渲染到终端。
- **最小形态**：commander 起 `dev` 命令；ink 渲染流式文字 + 工具调用 + 用量/状态行；Ctrl-C 中断（AbortSignal）。
- **验证**：终端里打字、看到流式回复 + 工具调用展开 + 用量行；中断能停。

### 3.7 SkillRegistry + git-commit skill（capabilities + skills/）— 技能按需装载
- **职责**：三级渐进披露——L1 启动注入 name+description 目录；L2 触发时读 SKILL.md；L3 脚本/引用按需（A 阶段 git-commit 不需要 L3 脚本）。
- **最小形态**：扫 `skills/*/SKILL.md` 的 frontmatter 取 L1；catalog 每 turn 注入但不进 immutable 前缀；description 匹配时把 SKILL.md 正文加载进上下文。
- **git-commit skill 内容**：description = "用户要写 commit message / 提交代码时"；SKILL.md = commit 规范（英文、简洁说明意图、结尾 Co-Authored-By 规则等），引导 agent 用 Grep/Read 看暂存 diff（A 阶段 shell git 读 diff 走一个受限只读命令或先手动喂 diff）。
- **验证**：说"帮我写个 commit message"→ L1 命中、SKILL.md 被加载、产出符合规范的 message；不相关话题时 SKILL.md 不加载（省 token）。

---

## 4. 构建顺序（里程碑，每步可验证再继续）

| 里程碑 | 内容 | 走到这能验证什么 |
|---|---|---|
| **A0 脚手架** | package.json / tsconfig(strict) / vitest / eslint + 目录骨架 + .gitignore；首个 commit | `npm run typecheck` / `npm test`（空跑）通过 |
| **A1 能说话** | ModelProvider(Anthropic 流式) + EventBus | 脚本调一句话，事件流里看到流式增量 + usage |
| **A2 能调工具** | ToolRegistry(Read/Write/Grep) + AgentLoop 骨架（决策点纯函数 + 单测） | 一轮对话里 agent 自己决定读个文件、结果回灌、无工具调用收尾 |
| **A3 能压缩** | ContextManager（83% 触发 + 结构化摘要 + 尾部保护） | 灌长上下文，压缩事件触发、对话能续 |
| **A4 能在终端跑** | CLI（commander + ink，订阅 EventBus 渲染） | 终端 REPL 打字、流式看输出 + 工具 + 用量、Ctrl-C 中断 |
| **A5 能用 skill** | SkillRegistry 三级披露 + git-commit skill | 说写 commit → skill 触发、产出规范 message |
| **A6 验收收口** | 跑完整验收清单（§5）+ 补齐触发路径单测 + 清理 | 验收清单全绿、单测覆盖决策点与 guardrail 触发分支 |

---

## 5. A 阶段验收契约（可验收、堵作弊）

**确定性脚本化清单（不靠"我觉得好了"）：**
1. **工具闭环**：问一个需读文件才能答的问题 → 断言工具真跑了、结果回灌、答案用到了文件内容。
2. **压缩触发**：灌超阈值长上下文 → 断言 `state:'compacting'` 事件触发、摘要进上下文、尾部 ~20 条保护、tool_call/result 组未被截断。
3. **事件按序**：断言事件顺序 message_delta→tool_call→tool_result→…→final，且 `usage` 有发。
4. **停止/预算兜底**：构造无限调工具场景 → 断言 `maxTurns` halt 真触发（**guardrail 触发路径单测**，不许写成只自增不读的死代码）。
5. **决策点纯函数单测**：decideStop / decideCompact / withinBudget 各覆盖正反 + 边界。
6. **skill 渐进披露**：相关话题 SKILL.md 加载、不相关不加载（断言上下文 token 差异）。

**作弊路径预先堵死**：不许删/skip 测试凑绿；不许把 guardrail 注释掉或让它只自增不读；`npm test`+`typecheck`+`build` 必须端到端真过、有输出为证。

**谁来验**：A 阶段客观可测，主跑测试即可。若要第三方核查，用 `/review` 或独立子代理核对验收清单逐条（裁判≠运动员，但 A 阶段不强制——客观测试已足够独立）。

---

## 6. A 阶段明确不做（反过度工程，划清边界）

- ❌ PermissionGate 完整版（A 用最简 allow + 标注；deny→ask→allow 与 Bash 同到 B 阶段）
- ❌ Persistence（SQLite/FTS/进度文件）、SessionStore、断点续跑 → B 阶段
- ❌ SubagentManager / 多 agent / 四护栏 / capability 交集 → C 阶段
- ❌ GoalLoop / Hooks / skill 自动沉淀 / **Part7 独立验收裁判** → D 阶段
- ❌ GUI → E 阶段（A 已铺好 EventBus，E 是接订阅）
- ❌ 多 provider 实装、缓存对齐高级策略、虚拟文件系统底座 → 出现真实需求才建
- ❌ `policies/ evals/ observability/ mcp/` 等目录 → 按需才建

---

## 7. 风险 / 待核实

| 项 | 处置 |
|---|---|
| Anthropic SDK 流式 + 工具调用的具体事件形态需对着当时官方文档落 | A1 先打通最小流式 demo 再封 ModelProvider |
| ink 在 Windows 终端的渲染/重绘表现 | A4 先做最小渲染验证，不行退回纯 stdout 流式 |
| 压缩用的"便宜模型"选型 + 结构化摘要质量 | A3 先用同家小模型（如 Haiku）跑通，摘要模板对齐蓝图 §3 |
| git-commit skill 读 diff 在 A 阶段无 Bash 的取舍 | 先支持"手动喂 diff"或加一个受限只读 `git diff` 命令；完整 shell 到 B |
| 非程序员独自维护 | 决策点纯函数 + 单测 + 小而清晰模块；复杂度沉到可读的 skill |

---

## 8. 下一步
绿灯后从 **A0 脚手架**开始，每个里程碑交付可运行/可测产物给你看，过了再下一个。不一次性写完七个模块闷头交付。
