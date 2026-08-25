# 交接：A0 + A1（2026-06-27）

> 类型：历史阶段快照。本文保留 A0/A1 当时的实现、验证与下一步；当前入口见 `docs/README.md`，完整 Phase A 收口见 `docs/handoff-A.md`。

完整设计见 `phase-A-plan.md`，项目规则见根 `AGENTS.md`。

## 一句话状态

A0 脚手架 ✅、A1「能说话」✅（ModelProvider + EventBus）已完成并验收。`npm run typecheck / test / build / lint` 全绿（44 测试），`npm run demo:a1` 实跑通真实 Doubao 调用。下一步 A2「能调工具」。

## A0 脚手架（commit 9b608a9）

package.json / tsconfig(strict, NodeNext, ESM) / vitest / eslint + 目录骨架（core / runtime / capabilities / surfaces）+ .gitignore（含 `.env` / `dist` / `data`）。

## A1 能说话（commit c416eba 实现 + d58b612 审查硬化）

### ModelProvider（`src/core/model/`）

按 kimi-code `kosong` 的 ChatProvider 形状：

- **DoubaoProvider**：用 `openai` SDK 改 baseURL 指向火山方舟 ARK（OpenAI 兼容）。
- **immutable + 浅拷贝克隆**：`withThinking(effort)` / `withMaxCompletionTokens(n)` 返回新实例、共享同一 HTTP transport（OpenAI client），只换 kwargs；原实例不变。
- **`createProvider(config)` 工厂**：判别联合配置分发，Doubao 现做，Kimi/Anthropic 日后 drop-in。
- **归一枚举 + 逃生舱**：`FinishReason` / `ThinkingEffort` / `ModelCapability` + 保留 `rawFinishReason` 原值。
- **决策逻辑全抽成纯函数 + 单测**（对非程序员维护最关键，出问题单点定位）：`normalizeFinishReason`、`extractReasoning`（reasoning 三字段识别 + 可配 key）、`clampMaxTokens`、`buildChatParams`（请求体构造）、`foldChunk`/`finalizeResult`（流式拼接）。

烤进去的 OpenAI 兼容 gotcha（来自 kimi-code/kosong + 实测）：
1. 流式 usage 要 `stream_options:{include_usage:true}`；usage 兜底也读 `choices[0].usage`，并正确处理终端空 `choices:[]` 块。
2. 豆包默认开思考；`withThinking('off')` 发 `thinking:{type:'disabled'}`（实测省隐藏 reasoning token）。
3. reasoning 字段三选一（`reasoning_content`/`reasoning_details`/`reasoning`）+ 可配 `reasoningKey` 覆盖；reasoning 能 round-trip（`Message.reasoning` → `reasoning_content`）。
4. `max_tokens` 第三方硬上限 → provider 内置 `clampMaxTokens`，默认不发 cap。
5. 流式 `tool_calls` 按 `index` 缓冲拼 arguments（A1 留好通道，工具执行是 A2）。
6. `tool_call_id` 截到 ≤64 字符。

### EventBus（`src/runtime/event-bus.ts`）

内存广播站，公共类型为 canonical `Event` 联合（订阅者能窄化拿到检查过的字段），运行时容忍未知 type 不抛（bus 不 switch type）。`emit` / `subscribe`（返回取消订阅）。订阅者抛错被隔离、同一函数订阅两次是两次独立注册。

### 审查硬化（d58b612，max-effort 多角度审查后）

修了几处真实隐患：EventBus 公共类型从开放 `AnyEvent` 收回 `Event`（恢复 plan 原定的类型窄化）；config 留空环境变量用 `||` 兜底默认（`??` 会被空串覆盖）；demo 实际加载 `.env`（tsx 不自动读）；abort 不再被误包成 failure；补 call() 注入假 client 的离线集成测试 + 终端 chunk 测试；删死分支/死三元、收紧 barrel 公共面。

## 关键决策

- **首发模型 Doubao-Seed-2.1-pro**（非 Anthropic、非订阅）：三家国产对比后选它（工具调用最宽容、可关思考、无 reasoning_content 必回传硬坑）。DeepSeek（省钱长跑）/ Kimi K2.7（agent 上限）将来按需切。详见项目记忆 `model-provider-doubao-first`。
- **配置**：baseURL `https://ark.cn-beijing.volces.com/api/v3`、model `doubao-seed-2-1-pro-260628`、key 读 `process.env.ARK_API_KEY`（永不入库/打印）。
- **A1 范围焊死**：只做 ModelProvider + EventBus，不碰 ToolRegistry/AgentLoop/ContextManager/CLI（A2+），但接口形状为它们留好。

## 验证证据

- `npm run typecheck` ✅ · `npm test` ✅ 44 passed（11 文件）· `npm run build` ✅（dist 干净、无测试泄漏）· `npm run lint` ✅。
- `npm run demo:a1` 真实调用：流式增量经 EventBus 输出、聚合 ModelResult（text 有、usage 非零如 input=51/output=30、finishReason `completed`、`hasReasoning:false` 即思考已关）。
- 坏 key 真网络验证：`Doubao request failed ... (HTTP 401) — check ARK_API_KEY ...`，不泄露 key。

## 已知小账（留给 A2+，当前不影响验收）

- **空 apiKey 走构造路径**会抛 OpenAI SDK 的 `OPENAI_API_KEY` 报错（指向错变量），仅当绕过 `loadDoubaoConfig` 手动传空 key 时触发；文档入口（demo）已被 `loadDoubaoConfig` 的 `ARK_API_KEY` 守卫挡住。要彻底堵可在 `createProvider` 加一行守卫。
- **reasoning 结构化（数组）形态**当前被丢（只取字符串）；豆包返回 string、不影响 A1，接 Kimi/OpenAI-compat 等会用数组形态的端点时在 A2+ 补（`reasoning.test.ts` 有显式记录该 gap 的测试）。
- **安全**：ARK key 曾在早期对话明文出现，建议去火山控制台轮换一次。

## 关键文件

```
src/core/types.ts                 # 共享域类型（Message/ToolCall/ToolResult/ToolSchema）
src/core/model/types.ts           # 归一枚举 + ModelProvider 接口 + DoubaoConfig
src/core/model/doubao-provider.ts # DoubaoProvider（immutable + clone + call 生成器）
src/core/model/{request,stream,reasoning,clamp,finish-reason,errors}.ts  # 纯函数决策点
src/core/model/{config,create-provider,index}.ts                        # 工厂 + env 读取 + barrel
src/runtime/event-bus.ts          # EventBus
scripts/a1-demo.ts                # A1 调用演示
test/model/*, test/runtime/*      # 44 单测
```

## 下一步

A2「能调工具」= ToolRegistry（Read/Write/Grep + zod 校验 + Zod→JSON-Schema 的 `$defs` 归一 + tool_call_id 截断）+ AgentLoop 骨架（决策点纯函数 `decideStop`/`decideCompact`/`withinBudget` + `maxTurns` 兜底触发路径单测）。直接喂 `docs/next-session-A2-prompt.md` 给新会话。
