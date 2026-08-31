# Inspect 收敛系统修复提案

> 状态：已实施并停止。工程门禁通过；唯一一次 canary 仍未产生 final，产品 verdict 保持 NO-GO。按第 6 节停止线不继续追加同类修复。

## 1. 真正要解决的问题

`run + inspect` 应在有限成本内完成仓库只读核查，并在证据不足时给出诚实分类。当前权限层能阻止副作用，模型仍能看到被禁工具、发起阻塞委派和产生宽泛检索；安全保持住了，产品任务没有收敛。

复验材料：来源为 Session `2026-08-31T09-30-46-404Z`，时间为 2026-08-31，对象为当前 `KNOWN_ISSUES.md` 的 14 条保证边界。五分钟停止线时没有最终答案；13 个模型回合已完成，第 14 个请求已开始，父模型可见用量至少 840,351 tokens，researcher 用量未计。工具调用 47 次：read 18、grep 27、task 1、bash 1。

## 2. 双向钢人

### 保持现状的最强理由

- 权限闸门已经正确拒绝 Bash 和所有写入，安全合同没有失效。
- 14 条跨源码、测试、文档的逐项核查本身偏大；把任务拆小能减少单次上下文，零代码改动也没有 Session composition 迁移。
- 当前基础模型能力可能是主要瓶颈；工具表和提示词收缩无法保证模型一定及时综合。

### 修复 inspect 合同的最强理由

- `inspect` 明确禁用 executes-code，模型仍收到 Bash schema，系统提示还告诉它“查看 git 等用 bash”；本次真实产生一次必然失败的 `bash ls`。
- `task` 是阻塞式整包返回；researcher 在 120 秒后没有产出，父模型只能从头重做，子代理用量还不在父级统计内。
- `grep` 只限制 200 条匹配，没有限制单行或总字符。本次两次宽搜生成 1,944,835 与 1,172,661 字节的 runtime tool-result 文件。
- 用户可见目标是“只读核查”，让用户先人工拆成多题会把 harness 已知的复杂度交还给用户。

关键变量只有三个：inspect 是否承诺仓库级核查；旧 inspect Session 是否必须原样续跑；可接受的单任务时间/token 上限。当前路线把仓库级只读核查列为 MVP 真实任务，旧 Session 可按既有 composition drift 规则开新会话，因此证据更支持修复。

## 3. 共同 Owner 与同构绑定

共同 Owner 是“模型可见的 inspect 执行合同”，由 `src/surfaces/cli/index.ts` 组装工具、提示和预算，`src/core/tools/builtins.ts` 保证单次检索输出成本。

| 同构绑定 | 当前表现 | 影响 |
|---|---|---|
| 权限与工具可见性分离 | write/edit/bash/task 仍进入 inspect schema，PermissionGate 事后拒绝 | 模型规划无效动作，浪费回合 |
| 通用提示与 inspect 冲突 | 固定提示鼓励 Bash，配置尾注声明 executes-code=deny | 同一请求同时收到相反指令 |
| 阻塞委派只有最终摘要 | task 超时只返回错误，没有可复用的部分证据 | 父模型重复搜仓库；子成本不可见 |
| grep 只有 match 数上限 | 超长 JSONL 行可让 200 条匹配达到 MB 级 | 磁盘噪音、上下文预览和遍历成本膨胀 |
| run 只有 24 回合上限 | 没有 inspect 默认预算与“证据不足就收口”边界 | 模型持续取证，没有及时综合 |
| ContextManager 事后卸载 | 超过 50,000 字符才写 `data/tool-results` | 保护窗口，但没有阻止宽搜和大文件产生 |

## 4. 推荐的一次性解耦

只做三项现有接缝内的收窄，不新增 route、manager、map 或产品表面：

1. `--preset inspect` 的模型工具表固定为 `read + grep`。不注册 write/edit/bash/vision，不加载 roster，不暴露 task；PermissionGate 保留为执行层兜底。系统提示继续从实际 schema 生成，并追加一句“证据不足直接归入缺少当前证据”。
2. `grep` 同时增加单行预览上限和总输出字符上限；达到任一上限时返回明确 continuation/truncated 标记。现有 200 matches、2MB 单文件、敏感路径与中断规则保持不变。
3. inspect 在用户没有显式传 `--max-turns` 时采用 8 回合默认值；显式值继续生效。默认/`safe`、goal、loop、TUI、Recall 与 GUI 均不改。

这三项共同让无效工具在模型规划前消失、宽搜在源头有界、取证回合有明确上限。task 的通用 partial-result、全局 token budget 和更换模型全部留在范围外。

## 5. 迁移边界

- inspect 的 toolset/system-prompt hash 会变化；旧 v2 inspect Session 按现有规则拒绝 exact resume，开新 Session。不要加兼容 shim。
- 默认 run/safe 的工具和 24 回合默认值保持原样；goal/loop 的 builder、verifier、map 与 verdict 路径不动。
- 已生成的 Session 与 `data/tool-results` 保留为失败证据，本提案不清理历史文件。
- 不调整 `agents/researcher/ROLE.md`，避免用 prompt 补丁掩盖 inspect 不该暴露 task 的边界。

## 6. 负例与验收

最小测试：

- inspect 即使存在 roster、vision 配置和 Bash，也只向模型暴露 read/grep；默认/safe 工具表保持当前行为。
- inspect 默认 8 回合，显式 `--max-turns` 覆盖有效；达到上限仍 fail-closed，不伪造 final。
- grep 遇到单条超长 JSONL 与多条普通匹配都受字符上限约束，返回截断标记；敏感文件、路径 confinement、200 matches 和 abort 回归通过。
- 旧 inspect Session 出现预期 composition drift，默认 Session 仍可按原合同恢复。

实现后只重跑同一 canary 一次。通过线：四分钟内自然 final、父级总 tokens 不超过 250,000、工具调用不超过 20、零 denied tool、零 tool-result offload、零项目写入，分类经主线程抽查无明显事实错误。任一核心线失败即保持产品 NO-GO，停止继续修同类问题。

## 7. 实施与最终结果

- `4db4d3f`：inspect 模型工具表固定为 read/grep，移除 roster/task、Bash、写入、Vision 与 Recall；提示改为证据不足直接分类；未显式传参时默认 8 回合。safe/default 与 goal/loop 保持原行为。
- `5c78930`：grep 每条匹配最多预览 1000 字符，最终结果最多 32,000 字符；保留 200 matches、2MB 单文件、敏感路径、confinement 与 abort 合同。
- 最终门禁：151 个测试文件，1740 passed / 2 skipped；typecheck、lint、build、diff check 全绿。

唯一 canary Session 为 `2026-08-31T13-10-36-797Z`。76.542 秒内完成 8 回合，父模型可见用量 241,341 input + 2,029 output = 243,370 tokens；工具 30 次（read 15、grep 15），零 denied tool、零审批、零 offload、零项目写入，Session integrity 完整且 pending tool effects 为 0。

时间、token、拒绝、offload 与副作用门槛通过；模型在最后一回合继续取证，最终以 `maxTurns` blocked，没有输出三类清单，工具数也超过 20。相较前次 canary，tokens 下降约 71%，工具调用下降约 36%，3.1MB offload 清零；核心产品结果仍失败，因此本提案关闭为 **ENGINEERING GO / PRODUCT NO-GO**。
