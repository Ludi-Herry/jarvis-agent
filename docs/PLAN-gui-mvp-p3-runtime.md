# GUI MVP P3：真实 Web 闭环合同

> 当前状态：`P3 NOT ACCEPTED / REAL TASK INTERRUPTED / TRANSPORT FIX APPLIED`
> 授权：Ludi 于 2026-09-06 明确批准 P3 合同、真实 Runtime 接线及一个新真实任务；覆盖旧文档的 P3 未授权限制。
> 主表面：conversation-first-refined，纯白中性工具主题。P4 未开始。

## 范围与归属

本轮只证明：Ludi 能在 Web GUI 发起一项本来就要完成的新任务，观察、拒绝或纠偏，并检查 Jarvis 交付的产物与可信证据。旧 CLI 自然完成 0/3、PRODUCT NO-GO、冻结的三任务与 canary 保持原样。

接手基线为 `main@c05c13507af1f079bb28e1f051b38bc13bcbbe4d`，暂存区为空。已有修改为 `.gitignore`、`AGENTS.md`、`PRODUCT.md`、重启交接、ESLint 与 TS 配置；已有未跟踪目录/文件为 P1/P2 计划、`prototypes/`、GUI app、P2 测试与无关 `.playwright-mcp/`。全部视为前序工作，不还原、不删除、不暂存或提交。本轮在这些文件上只做必要的增量修改，并保留 P2 模拟入口与原始证据。

正式前端继续采用已安装的 React + assistant-ui，保持精确版本、独立子包及单一 ExternalStore adapter。总体路线和本次 P3 授权覆盖后续采用；无需重复选库、重新安装或新增批准门。P2 记录中的 114 个安装包、约 148.29 kB gzip JS 和 experimental API 风险属于已披露维护成本，未消失。

## 一个真实任务

- **Ludi 已选**：“首次使用引导：Jarvis 完成任务页空态与三栏说明，让人知道从哪里开始、何时审批、何时算完成。”来自本轮结构化答复，不是旧 canary。
- 目标为当前 Jarvis Web 前端。交付限定在 `src/surfaces/gui/app/src/live/first-task-guide.tsx`。主线程只预留 `return null` 接入位；正式内容、布局和实现由真实 Jarvis 运行完成。
- 固定任务输入、三项人工验收、可写文件和运行限制见 [任务合同 JSON](./gui-mvp-p3-first-task.json)。2 轮、每轮最多 12 次模型调用、累计最多 24 次、总时限 15 分钟；单次模型超时保持 120 秒。暂停与恢复不能重置本轮总时限或累计调用上限。
- Ludi 在 GUI 审阅首个写入请求，提出一项真实调整意见；拒绝理由进入 Session 工具结果，Jarvis 后续写入应体现该意见。最终由 Ludi 检查真实空态及证据并逐项人审；不故意制造错误第一版。
- 不制造 inventory、索引或随机断言，不重开旧三任务。未获真实任务时，事件接线及确定性验证继续，真实任务结果保持 pending。
- 使用现有模型配置，不改默认模型、密钥、环境或协议策略。成本和耗时记录展示；成本不是通过门。保留既有超时、执行上限与急停。

## 双向接线与事实

实现前把每个 GUI 动作映射到既有入口、返回事件和持久事实。Session、消息、工具、权限与完成授权仍由 Jarvis 持有；前端只保存草稿、焦点、滚动和显示投影。

必须覆盖本次任务需要的输入、增量消息、工具、允许一次/拒绝/要求调整、Diff/产物/验证、终止与恢复。暂停、继续和恢复只展示真实能力；没有 Runtime 对应能力的动作明确不可用，不用前端状态伪装。待具体入口核对后补下表。

| GUI 动作 | 现有 Runtime 入口 | 返回事件 | 持久事实 |
|---|---|---|---|
| 启动固定任务 | `runGoal` → 原 `runAgent` | model/message/tool/goal | FileSessionStore v2 + FileGoalStore |
| 补充指令 | `runAgent.beforeModelWave`，下一请求前追加并 sync | GUI 排队/消费回执 + 下一模型波次 | Session 新 user 消息；不改 objective |
| 允许/拒绝/要求调整 | 注入 Approver → DefaultPermissionGate | approval_request/result、工具结果 | 既有审批 audit + Session tool message |
| 暂停/继续 | 既有 beforeModelWave 等待点 | pausing/paused/running | GUI 控制回执；进程内暂停，不伪装持久 Runtime 状态 |
| 终止 | AbortSignal + requestEmergencyStop | stopping/interrupted | 急停 audit + Goal blocked + Session 工具回执 |
| 恢复现场 | loadSessionLog / loadGoal | 完整投影替换 | Session 顺序、composition、pendingTools 校验；blocked 只读 |
| 完成验收 | runGoal 检查 → human route → applyHumanReviewDecision | 读取最新权威事实 | 原 Goal round/verdict、human-review audit；只有 verified 授权 |

`data/gui-p3/` 保存本轮 Session、Goal、审批及 GUI 事件投影，旧 `data/` 实验不被重读或重跑。事件日志是同一 EventBus 的显示用落盘订阅，不是第二执行总线；浏览器重连取得完整投影，以任务 ID + 单调序号去重。进程恢复补读 Session 事实，未决工具或待确认输入阻止自动续跑。

当前源码含未提交 P2：宿主使用私有 Git index + tree 捕获启动前源文件基线，不写用户 index、不创建 commit；原篡改检查只增加可选私有 index 输入。产物 Diff 使用同一基线，避免将前序 P2 或主线程接线算成 Jarvis 交付。索引和证据保留，不自动清理。

流式投影有稳定 ID 与单调序号，重复事件不重复显示；未知事件显式降级。断线后重取持久事实，不以缓存、模型 final、HTTP 成功或工具测试通过代替完成授权。

## 验收顺序

1. 确定性主路径：提交 → 真实 AgentLoop 事件/工具 → Session 落盘 → 重连/恢复后事实一致；仅可信链可以授予完成。
2. 关键失败路径：写入被拒绝且理由进入后续执行；急停使在途执行中断、后续副作用被阻止；错误/超时/不完整流不能显示成功。对新增 guardrail 必须触发验证。
3. 源码门：根 `typecheck`、`lint`、`test`、`build`；前端子包 `typecheck`、`build`。沿用既有测试工具，不降阈值。
4. 真实浏览器：输入/消息流、审批与拒绝/调整、证据联动、终止、刷新/断线恢复；1440×900 与 1280×800 保持可读和控制可达。
5. 一个真实任务：Ludi 仅凭 GUI 能辨认目标、状态、阻塞、下一步及证据；至少一次 GUI 介入改变后续执行。用户的视觉与理解验收单列，自动检查不能代替。
6. 关键控制按本次范围安排独立 Reviewer：权限、急停、恢复和完成授权。已发现 P0/P1 处理并通过受影响定向门后停止；P2 登记。

## 完成归属、停止与收口

GUI 内 Ludi 审批、补充与纠偏可计入监督式完成。外部主线程或子代理代写目标任务代码、代答、补救的部分单列，不能计为 Jarvis 成功。用于建设 P3 的工程修改与由 Jarvis 执行的真实任务分开记账。

最终记录真实交付物/Diff、Session/Goal/验证/完成授权来源、介入次数与内容、外部代做、模型用量/成本/耗时、失败和未验证项。安全停止与任务成功分别判定；未获可信完成授权不得写 verified。

介入后仍反复搜索无交付时停止 UI 扩建，保留证据，只定位一次可归因的执行瓶颈。同类核心失败连续两次停止逐点补丁，不追加预算、清洗输出、放宽阈值或制造 final。禁止新增 verifier/route/scheduler 抽象，不启动旧冻结路线、Recall、TUI、模型议会、市场、云协作或桌面壳选型。

完成本次 Web 真实任务后停下。P4 仅在后续判断与授权后进入。本轮临时产物、验证回执和遗留问题在收口时追加；不自动清理。

## 真实任务前的工程回执

- 根四门已通过：全量 153 files / 1746 passed / 2 skipped；402.41 秒。日志在 [evidence/gui-mvp-p3](./evidence/gui-mvp-p3/)。
- 首轮独立审查 NO-GO，3 个 P1（并发恢复、旧证据人审、恢复时限重置）已修复。fresh Reviewer 定向复核 GO，P0/P1 为 0；亲跑 8 个定向测试通过。验证证明用户 `.git/index` 未变，不声称私有 index 自身字节永久不变。
- 修复后根 typecheck/lint/build、子包 typecheck/build 通过；最后的任务标题折叠只改显示摘要，完整任务仍可展开并保留在消息与 Session。
- 真实 Browser 主路径及急停路径已通过；1280 expanded 三栏 `184/610/486`、横向溢出 0；取消急停、终止、刷新后草稿仍在。自动化浏览器中的“人审”只算确定性测试，不是 Ludi 的产品验收。
- 当前只允许单个 GUI host 操作同一 dataDir。验证及人工验收期间只允许 Jarvis 写入约定组件；不支持另一个外部写者在指纹检查与裁决落盘之间竞争修改。任务页对这次验证的证据 token 做版本绑定，变化返回 409。
- 真实入口已准备为 `http://127.0.0.1:4330/app/`，使用既有 `doubao-seed-2-1-pro-260628`。价格显示按官方产品页的输入 6 元/百万、输出 30 元/百万估算，不含无法单列的缓存折扣；不是费用通过门。
- 原始失败、两份 Browser fixture 和单元测试临时仓库均保留；未安装、删除、提交或推送。真实任务尚未启动，首次使用引导组件仍为 `return null`。

## 一个真实任务的结果（2026-09-06）

**未完成，不能计为 Jarvis 成功。**任务 `gui-6a82e434-1b8a-43dc-9406-f9be7b43178e` 于 17:07 左右启动，最终由外部主线程通过 GUI 急停，在首次写入审批前停止。安全停止与任务成功分别记录。

| 项目 | 实际结果 |
|---|---|
| 交付物 | 只有未执行的模型草稿；目标组件仍为 `return null`，无已应用 Diff |
| 工具 | 7 次 read/grep 完成；1 个 write 请求等待审批时终止；目标写入 0 |
| Ludi GUI 介入 | 0；未取得有效纠偏与仅凭 GUI 理解现场的人工验收证据 |
| 外部代做 | 没有代写引导组件；主线程启动、修复传输及刷新页面、最后急停，均不冒充 Ludi 介入 |
| 用量 | 输入 82,643 + 输出 2,059 = 84,702 tokens |
| 费用 | 估算 CNY 0.557628，未单列缓存折扣；模型保持原配置 |
| 耗时 | 654,773 ms（10 分 55 秒，包含审批等待与传输诊断） |
| 可信链 | Goal blocked / GUI interrupted；verdict none、completion.granted=false；未运行本次交付的完成检查 |
| 安全结果 | 待批写入未发生、停止后无目标文件副作用；Session 留有未执行工具意图，自动恢复继续被拒绝 |

证据：

- [机器可读结果](./evidence/gui-mvp-p3/real-task-result.json)
- [未执行的原始模型草稿](./evidence/gui-mvp-p3/first-task-guide.unapplied.tsx.txt)
- Session：`data/gui-p3/sessions/gui-6a82e434-1b8a-43dc-9406-f9be7b43178e.jsonl`
- Goal、审批与事件分别在同一 `data/gui-p3/` 的 `goals/`、`approvals/`、`gui/` 目录，文件 ID 相同。
- 此次 read 另产生 `data/tool-results/call_p1hc0ftxredzuzyd238mmr5w.txt`（50,242 字符 offload），它是本轮新产物；旧实验内容未重跑。

### 唯一定位并修复的执行瓶颈

真实输出超过小样本后，SSE 把 `ServerResponse.write() === false`（数据已接受，等待写缓冲 drain）误判为断线并主动结束连接。全量快照持续重连，前端因连接中断禁用了审批。该故障属于本轮 GUI 接线，不归咎于用户或模型检索。

修复为等待 drain 并合并待发送快照；重连期间先从同一会话 HTTP 接口取回最新事实，成功后才能恢复控制，接口也失败则继续禁用。没有绕过审批 ID、权限或完成授权。新增大于 64 KB 的真实 SSE 测试，9 项定向测试通过；最新 typecheck/lint/build 与前端 build 通过。终止后重启服务，原真实大快照保持连接，失败现场与成本完整恢复。

该修复不挽救原结果：首版仍未审批，且剩余约 5 分钟不足以容纳上一轮近 7 分钟的全量检查及后续实施/验收，因此按合同停止，没有追加预算或新建第二次模型尝试。未执行草稿还引用了不存在且不在允许写入范围内的 CSS 模块，不能当成可运行交付物。

### 遗留与停点

- 真实任务交付、Ludi 的有效 GUI 介入与视觉/理解验收均未通过；首次使用引导未完成。
- 单宿主、单写者边界继续有效；没有实现跨进程共同控制或终态复活。
- assistant-ui 实验接口风险与约 159.54 kB gzip JS 保留；Vite 大 chunk 提示未通过调高阈值隐藏。
- 保留全部失败、草稿、私有索引、offload 和临时仓库；只关闭本轮确定性测试服务进程。真实服务仍可在 `http://127.0.0.1:4330/app/` 查看失败现场。
- 旧 NO-GO、0/3、P2 证据不变。当前停在 P3，不能进入 P4；后续尝试需先明确新的运行窗口及监督方式，不自动扩样或重跑。
