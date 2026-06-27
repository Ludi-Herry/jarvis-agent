# A2 接手 prompt（直接复制给新会话）

> 用法：开新会话，把下面分隔线内的内容整段贴给接手的 AI。它假定 A0+A1 已完成（见 `docs/handoff-A1.md`）。

---

接手自研 agent-harness 的 Phase A 里程碑 **A2「能调工具」**。我是陆凌华（UX 设计师、非程序员），技术解释落到体验/维护/风险，别堆术语。

【先读，按顺序】
1. 仓库 `H:\agent-harness`（A0+A1 已完成、branch main、工作树干净）。系统会自动加载项目记忆。
2. `H:\agent-harness\AGENTS.md`（项目规则：TS strict、ES modules、决策点写成无状态纯函数 + 单测、guardrail 必须有触发路径单测、不为跑起来注释报错/跳测试）。
3. `H:\agent-harness\docs\handoff-A1.md`（A0+A1 已有什么：ModelProvider + EventBus、纯函数决策点、已烤进的 gotcha）。
4. `H:\agent-harness\docs\phase-A-plan.md` —— 这次只做 A2。重点读 §3.3 ToolRegistry、§3.4 AgentLoop、§5 验收、§6 边界。
5. 设计参照：kimi-code（知识库 Part8）`agent-core/src/loop/`（无状态决策核 + 有状态宿主）、`kimi-schema.ts`（tool schema 归一）。

【这次只做 A2，范围焊死】
让「一轮对话里 agent 自己决定读个文件、结果回灌、无工具调用就收尾」：
- **ToolRegistry（core）** 按 §3.3：登记 **Read / Write / Grep** 三个内置工具；zod 校验入参；执行抛错归一成 `ToolResult.error`；`schemasForModel()` 把工具转成 OpenAI 兼容 tools 格式。
- **AgentLoop 骨架（core）** 按 §3.4：有状态 async generator `runAgent(ctx)`，副作用经注入的 ctx（model/tools/bus）；调 model → 流式发 EventBus 事件 → 有 tool_calls 就执行回灌、没有就收尾 → `maxTurns` 兜底。
- **决策点抽纯函数 + 单测**：`decideStop(res)`、`withinBudget(turn, budget)`（`decideCompact` 可留桩，真压缩是 A3）。
- 不做 ContextManager 压缩 / CLI / PermissionGate 完整版 / Bash（A3+/B 阶段）。

【A2 必烤进去的 gotcha（来自 Part8/kimi-code）】
- **Zod→JSON-Schema 必须归一**：`schemasForModel()` 要 **deref `$ref`/`$defs` 并补 `type`**，不是直接 `zodToJsonSchema` 丢出去——严格端点（豆包大概率同款）不吃 `$defs`。这是核心活，要单测「产物无 `$defs`/`$ref` 残留、每个 schema 有 `type`」。
- **tool_call_id 回灌截 ≤64 字符**：A1 的 `src/core/model/request.ts` 已有 `sanitizeToolCallId`，复用别重写。
- **消费 `model.call()` 的返回值用 `yield*` 或手动 `.next()`**，别用 `for await`（会丢掉聚合 ModelResult——A1 已在接口 JSDoc 警示）。
- **流式 tool_calls 按 index 拼**的通道 A1 已留好（`foldChunk`/`finalizeResult` 产出 `ModelResult.toolCalls`），A2 只管把它们交给 ToolRegistry 执行。
- 工具结果超大落盘是 A3 的事，A2 先整段回灌即可（但 Read 这类先别自循环）。

【A2 完成标准（亲自跑通、贴真实输出，别口说）】
- **工具闭环**：问一个需读文件才能答的问题 → 断言工具真跑了、结果回灌、答案用到了文件内容。
- **事件按序**：断言事件顺序 message_delta→tool_call→tool_result→…→final，且 `usage` 有发。
- **停止/预算兜底**：构造无限调工具场景 → 断言 `maxTurns` halt **真触发**（guardrail 触发路径单测，不许写成只自增不读的死代码）。
- **决策纯函数单测**：`decideStop` / `withinBudget` 各覆盖正反 + 边界。
- **schemasForModel 单测**：产物无 `$defs`/`$ref`、每个 schema 有 `type`（防豆包拒收）；非法入参被 zod 拦截、返回结构化错误；Read 读到内容、Write 落盘、Grep 命中。
- `npm run typecheck / test / build / lint` 全过，贴输出。没证据不说"完成"。

【纪律】反过度工程（只 Read/Write/Grep 三个工具、不上 Bash、不上 PermissionGate 完整版、不写 A3+ 压缩逻辑）；决策点抽纯函数 + 单测；guardrail 必须有触发路径单测；不为跑起来注释报错/跳测试/降规则；只改与 A2 相关的文件。

【收尾】A2 跑通后 commit（英文，如 `feat(A2): ToolRegistry (Read/Write/Grep) + AgentLoop skeleton`，结尾带 Co-Authored-By）。报告：ToolRegistry/AgentLoop 怎么实现、各命令 + 工具闭环 demo 真实输出、下一步 A3 等我绿灯。别擅自往 A3 写。

---
