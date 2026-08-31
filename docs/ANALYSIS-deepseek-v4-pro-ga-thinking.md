# DeepSeek V4 Pro GA 思考流协议诊断

> 日期：2026-09-01。范围：协议诊断与一次批准的 run+inspect 策略实验；失败代码已 revert，未修改配置或默认模型。

## 结论

`deepseek-v4-pro-ga-260813` 经火山方舟 Chat Completions 使用工具时，`thinking=disabled` 会把取证思路和残留 `</think>` 放进普通 `content`；显式 `thinking=enabled` 则按预期把思考放进 `reasoning_content`。Jarvis 的 stream 分离、EventBus 与终端渲染没有串线。根因位于该 ARK GA 模型的 non-thinking + tools 响应模式兼容边界。

## 证据链

1. `src/surfaces/cli/index.ts` 创建 provider 后调用 `withThinking('off')`。
2. `src/core/model/request.ts` 将其编码为顶层 JSON `thinking: { type: 'disabled' }`。
3. localhost 假端点捕获到 OpenAI JS SDK 实际发送的 body，模型、stream 与 `thinking.disabled` 均存在；SDK 没有吞掉未知字段。
4. `src/core/model/stream.ts` 只把 `delta.content` 变成 text，把 `reasoning_content` / `reasoning_details` / `reasoning` 变成独立 reasoning。`run-agent.ts` 只向 UI emit text；`render.ts` 原样显示 message delta。
5. 冻结 canary Session `2026-08-31T19-36-02-590Z` 的六个取证回合全部记录为 `message.content`，`message.reasoning` 为空；五个回合含残留 `</think>`。这只能由上游 `delta.content` 进入。
6. 单次受控 `thinking=enabled` 工具调用只记录字段元数据：31 个 reasoning delta、127 reasoning chars、0 text chars、1 个 read tool call、无 think 标签；usage 为 366 input / 75 output。

官方 DeepSeek V4 文档说明：`thinking.type=disabled` 应选择非思考模式；思考模式的 CoT 应位于独立 `reasoning_content`。工具调用同样支持该合同。参考 [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)、[Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/) 与 [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)。火山方舟也把 `thinking: { type: 'disabled' }` 作为关闭深度思考的官方请求形状，见 [方舟 Responses 示例](https://www.volcengine.com/docs/82379/1795150)。公开文档未找到 `deepseek-v4-pro-ga-260813` 的专属兼容说明，因此无法进一步区分 GA 模型实现与 ARK Chat Completions 适配层。

## 排除项

- `reasoningKey` 配置无法处理：异常文本已经进入 content，响应里没有可改名提取的 reasoning 字段。
- 只删除 `<think>` 标签无法处理：首个取证回合没有标签，后续只有闭合标签；规划文本仍会显示。
- 隐藏所有带 tool call 的 assistant content 风险过高：合法进度说明也会消失，且会改变 Doubao/default 行为。
- 当前 OpenAI JS SDK 已排除：本地传输探针证明完整 body 已发送。

## 建议

若要采用 DeepSeek，候选方向曾是模型族 thinking 策略：DeepSeek V4 使用 `enabled/high`，Doubao 继续 `off`。不要添加内容正则清洗、兼容 shim 或新 provider 抽象。

## 批准实验与回退

Ludi 批准后，`46a95a9` 只在 DeepSeek V4 + run + inspect 启用 thinking；safe/default 与 goal/loop 继续 off。151 个测试文件、1740 passed / 2 skipped，typecheck、lint、build 全绿。

冻结 canary Session `2026-08-31T20-13-36-607Z` 验证了协议侧：8 个 assistant 回合都有独立 reasoning，共 4466 字符；普通 content 为 0，think 标签为 0，说明 UI 分离与多轮 reasoning replay 生效。任务侧失败：约 56.5 秒后 `maxTurns` blocked，没有最终分类；可见用量 253,504 input + 3,260 output = 256,764 tokens；工具 30 次（grep 18 / read 12），超过 token 与工具门槛。零审批、零 offload、零项目写入，Session 完整且 pending effect 为 0。

该策略改善显示却丢失已通过的任务可行性，提交已由 `88b9c29` revert。最终代码与 `46a95a9^` 在两个受影响文件上字节一致，typecheck 通过。

## 最终判断

| 模式 | 任务结果 | UI/协议 | 判定 |
|---|---|---|---|
| disabled | 约 45 秒自然 final，14/0/0 | 规划文字与 `</think>` 进入 content | 任务 GO，采用 HOLD |
| enabled | 8 回合无 final，256,764 tokens / 30 tools | reasoning 完全独立，零 think 标签 | 协议 GO，任务 NO-GO |

两个模式都未同时满足任务完成、成本与 CLI 体验。默认模型采用继续 hold，不再重放同一 canary 或尝试内容清洗。后续若继续，只考虑更换能够遵守合同的 endpoint/model，或由 Ludi 重定义产品验收线。
