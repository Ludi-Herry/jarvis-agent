# Phase A 搭建方案 · 单 agent 能跑

> 依据蓝图 §12 的 A 阶段 + §10 技术栈 + §11 目录 + §2/§3/§7/§8 模块设计。
> 蓝图原文：`H:\LLM本地知识库\采集\external\agent-harness-调研\agent-harness-Part2-架构蓝图.md`。
> **首要代码参照：kimi-code**（Moonshot 官方 TS/Node coding agent，与本骨架最同构；深挖见知识库 Part8）——`kosong/src/provider.ts`（ModelProvider 形状）、`agent-core/src/loop/`（无状态 loop + host 持状态）、`agent-core/src/agent/compaction/strategy.ts`（canSplitAfter + 工具输出落盘）。次要参照 Claude Code 还原源码 / codex。
> 状态：方案待陆凌华绿灯 → 绿灯后按「构建顺序」逐里程碑写，每个里程碑交付可验证产物再继续。kimi-code 精修已并入 §3.1/§3.3/§3.5（2026-06-27）。

---

## 0. A 阶段目标（一句话）

让**单个 agent 在终端里跑起来**：你输入 → 它对话 / 调工具（读写文件、检索）/ 上下文超阈值自动压缩 / 全过程在终端流式可见。事件流第一天就铺好，所以将来接 GUI 是「接订阅」不是「改架构」。

**A 阶段证明的核心命题**：有状态宿主 + 纯函数决策点这套骨架，真能让单 agent 稳定跑通对话-工具-压缩闭环，且决策逻辑可单测。

---

## 1. 已定决策（动手前锁定）

| # | 决策 | 选了什么 | 为什么 |
|---|---|---|---|
| 1 | 代码位置 | 独立仓库 `H:\agent-harness`（已 git init，branch main） | 与知识库 vault 分离，harness 是产品不是笔记 |
| 2 | 首个 model provider | **首发 Doubao-Seed-2.1-pro**（火山方舟 OpenAI 兼容端点 + 流式）；ModelProvider 抽象留好切换，A 阶段只实装这一家 | 三家国产对比后选它：工具调用最省心（可关思考、消息拼接最简单、无 reasoning_content 回传硬坑）、正式版，A 阶段第一目标是稳跑通工具循环而非省钱。DeepSeek（最便宜 + 1M 上下文，但 preview 期工具调用不稳）/ Kimi K2.7 Code（agent 原生、GA，但强制思考 + 输出仅 32K）将来按需切。原定「只接 Anthropic」因改用国产模型作废 |
| 3 | 首个工具集 | **Read + Write + Grep** | 够演示对话+副作用+检索；**Bash 推迟到 B 阶段**——A 阶段没上 PermissionGate，放 Bash = 裸奔 |
| 4 | 首个 skill | **git-commit**（写符合规范的 commit message） | 最小、贴你工作流、零额外依赖，正好演示三级渐进披露 |
| 5 | A 阶段验收方式 | **客观确定性测试**（脚本化清单 + 单测） | Part7 那套独立 LLM 裁判是 D 阶段 GoalLoop 才上，A 阶段杀鸡用牛刀 |

**模型接入配置（已落 `.env.example`；key 是密钥永不入库，代码从 `process.env` 读）**
- baseURL（OpenAI 兼容）：`https://ark.cn-beijing.volces.com/api/v3`（env `ARK_BASE_URL`）
- 模型 id：`doubao-seed-2-1-pro-260628`（env `ARK_MODEL`）
- 鉴权：`process.env.ARK_API_KEY`，已配成环境变量、实测调通；**不硬编码、不进 commit/日志**。
- ⚠️ **豆包默认开思考模式**（实测「回一个词」却花 37 token = 隐藏 reasoning）——A1 封 ModelProvider 时 `withThinking('off')` 要发 `thinking:{type:'disabled'}`，工具调用才最干净、不付隐藏 token。**这正是选 Doubao（能关思考）而非 Kimi K2.7-code（强制思考）的核心理由。**

---

## 2. 技术栈（蓝图 §10，A 阶段实际用到的）

| 关注点 | 选型 | A 阶段是否用 |
|---|---|---|
| 语言/运行时 | TypeScript（strict）+ Node ≥20，ES modules | ✅ |
| 模型 SDK | 自封 `ModelProvider`，内部包 `openai`（指向火山方舟 OpenAI 兼容端点） | ✅（首发 Doubao）|
| 异步流 | async generator + EventEmitter | ✅ |
| Schema 校验 | `zod`（工具入参 + 配置） | ✅ |
| CLI/TUI | `commander`（命令） + `ink`（React for CLI，渲染流式） | ✅ |
| 测试 | `vitest` | ✅ |
| 持久化 | better-sqlite3 + FTS | ❌ B 阶段 |
| 版本/快照 | simple-git / shell git | ❌ B/C 阶段（git-commit skill 用 shell git 读 diff 除外）|
| 沙箱 | 子进程 + 受限 cwd | ❌ B 阶段（随 Bash + PermissionGate）|

---

## 3. 模块设计（7 个，每个：职责 / 最小形态 / 接口草案 / 验证）

### 3.1 ModelProvider（core）— 跟模型说话的统一插座〔按 kimi-code `kosong` 形升级〕
- **职责**：把"调一次模型、拿流式回复+工具调用+用量"封在统一接口后，provider 可换（改配置不改代码）。
- **最小形态**：实现 `DoubaoProvider`（火山方舟 OpenAI 兼容端点，`openai` 包改 baseURL），支持 streaming，返回 API 真实 `usage`（流式下传 `stream_options.include_usage`；**usage 兜底也读 `choices[0].usage`**——某些兼容端点放私有位）。**抽象形状照 kimi-code `kosong` 的 `ChatProvider`**：provider **immutable**，`withThinking(effort)` / `withMaxCompletionTokens(n)` 返回**浅拷贝克隆**（共享 HTTP transport、只换 kwargs）；`createProvider(判别联合 config)` 工厂分发，Doubao 现做、Kimi/Anthropic 日后 drop-in。
- **接口草案**：
  ```ts
  // 归一枚举 + 逃生舱（借 kosong）
  export type FinishReason = 'completed' | 'tool_calls' | 'truncated' | 'filtered' | 'paused' | 'other';
  export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high';  // 各 provider 自钳位
  export interface ModelResult {
    text: string;
    toolCalls: ToolCall[];
    usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
    finishReason: FinishReason;
    rawFinishReason: string;        // 逃生舱：保留 provider 原值，别被归一吃掉信息
    reasoning?: string;             // 思考模型回传（Doubao reasoning_content 等，需能 round-trip）
  }
  export interface ModelProvider {
    call(messages: Message[], tools: ToolSchema[], signal?: AbortSignal):
      AsyncGenerator<ModelDelta, ModelResult>;
    withThinking(effort: ThinkingEffort): ModelProvider;          // 返回克隆
    withMaxCompletionTokens(n: number): ModelProvider;            // 返回克隆
    readonly capability: ModelCapability;  // {max_context, max_output, thinking, tool_use, image_in, video_in}
  }
  ```
- **OpenAI 兼容 gotchas（写进 A1 验收，来自 kimi-code 趟坑）**：① reasoning 字段三选一识别（`reasoning_content`/`reasoning_details`/`reasoning`）+ 可配 `reasoningKey` 覆盖非标名；② **`max_tokens` 第三方常有硬上限**、超了被拒——provider 内置 clamp（默认不发 cap，要发就钳到上限）；③ 思考模型的 reasoning 内容多轮要能 round-trip（A 阶段单 provider 先留好字段，别丢）；④ **豆包默认开思考**，`withThinking('off')` 发 `thinking:{type:'disabled'}`（实测回一个词花 37 token，关掉工具调用最干净、省隐藏 reasoning token）。
- **验证**：喂一句话拿到流式增量 + 聚合 `ModelResult` + 非零 usage + 正确 `finishReason`；断网/坏 key 报可读错误；`withThinking('off')` 返回的是新实例、原实例不变（克隆语义单测）。

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
- **⚠️ Zod→JSON-Schema 必须归一（kimi-code gotcha）**：把 zod 转成发给模型的 tool schema 时，**deref `$ref`/`$defs` 并补 `type`**——严格端点（含 Moonshot，火山方舟大概率同款）不吃 `$defs`；这是 `schemasForModel()` 的核心活，不是直接 `zodToJsonSchema` 丢出去。另：回灌工具结果时 **tool_call_id 截到 ≤64 字符**（兼容端点约束）。
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
    schemasForModel(): ToolSchema[];          // 转 OpenAI 兼容 tools 格式 + deref $defs + 补 type
    run(call: ToolCall): Promise<ToolResult>; // 内部先 zod 校验
  }
  ```
- **验证**：合法调用执行成功；非法入参被 zod 拦截、返回结构化错误；Read 读到文件内容、Write 落盘、Grep 命中；**`schemasForModel()` 产物无 `$defs`/`$ref` 残留、每个 schema 有 `type`（单测，防 Doubao 拒收）**。
- 〔后续，非 A〕kimi-code 的 `ToolAccesses` 资源冲突模型（声明 read/write/路径，不冲突即并发、冲突在 provider-order 边界串行）值得抄进 ToolRegistry——但那是 C 阶段多工具并发才需要，A 阶段单线程执行先不做。

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
- **最小形态**：基于"有效输入预算 = 窗口 − max_output"，超 ~83% 触发（kimi-code 用 0.85 触发 + 预留 50K + 保留最近 4 条，与蓝图 80-85% 对齐）；调便宜模型按结构化模板摘要（目标/已完成/阻塞/决策/待办/相关文件）；保护末 ~20 条；**边界对齐照抄 kimi-code 的 `canSplitAfter()` 安全切点**——不在 user 消息后、不在带 tool_call 的 assistant 后切，绝不把 tool_call 和它的 result 切散。
- **🆕 工具输出落盘预算（kimi-code `budgetToolResultForModel`）**：单个工具结果超 ~50K 字符就**截断 + 落盘到 `data/tool-results/` 留路径指针**，而非整段塞进上下文（比纯占位符可回读，且压不爆窗口）。
- **接口草案**：
  ```ts
  export interface ContextManager {
    shouldCompact(usage: Usage): boolean;        // = decideCompact 包一层
    compact(messages: Message[]): Promise<void>; // 原地替换为 摘要 + 尾部保护
    budgetToolResult(out: ToolResult): ToolResult; // 超 50K 截断落盘留指针
  }
  // 纯函数：安全切点（可单测，借 kimi-code）
  export function canSplitAfter(messages: Message[], i: number): boolean;
  ```
- **验证**：灌长对话 → 压缩真触发（断言 `state: 'compacting'` 事件）；摘要进了上下文、尾部保护生效、**tool_call/result 组没被切散（`canSplitAfter` 单测覆盖：在 tool_call 后返回 false）**；大工具输出被截断落盘、上下文里只剩指针 + 预览；压缩后还能继续对话。

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
| **A1 能说话** | ModelProvider(Doubao 流式) + EventBus | 脚本调一句话，事件流里看到流式增量 + usage |
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
| ~~A0 装错 SDK：deps 里是 `@anthropic-ai/sdk`、不是 Doubao 要的 `openai`~~ | ✅ A1 已完成（c416eba）：`npm rm @anthropic-ai/sdk && npm i openai`，deps 现为 `openai`。 |
| `dev` 脚本指向不存在的 `src/surfaces/cli/index.ts` | A4 建 CLI 时补；A1 可先放空占位让 `npm run dev` 不报错 |
| Doubao/OpenAI 兼容的流式 + 工具调用事件形态需对着火山方舟官方文档落（流式 tool_calls 按 index 拼 arguments、usage 要 `stream_options.include_usage`） | A1 先打通最小流式 demo 再封 ModelProvider |
| ink 在 Windows 终端的渲染/重绘表现 | A4 先做最小渲染验证，不行退回纯 stdout 流式 |
| 压缩用的"便宜模型"选型 + 结构化摘要质量 | A3 先用同家小模型（如 Doubao-Seed-2.1-turbo）跑通，摘要模板对齐蓝图 §3 |
| git-commit skill 读 diff 在 A 阶段无 Bash 的取舍 | 先支持"手动喂 diff"或加一个受限只读 `git diff` 命令；完整 shell 到 B |
| 非程序员独自维护 | 决策点纯函数 + 单测 + 小而清晰模块；复杂度沉到可读的 skill |

---

## 8. 下一步
绿灯后从 **A0 脚手架**开始，每个里程碑交付可运行/可测产物给你看，过了再下一个。不一次性写完七个模块闷头交付。
