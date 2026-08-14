# ZCode / GLM-5.3 交接：Jarvis CLI sessions 只读切片

> 状态：2026-08-14。本文面向接手实现的模型，范围已刻意收窄。开始前必须核对 Git 基线与工作树；发现 HEAD 或状态不一致时停止并汇报。

## 1. 当前基线

- 仓库：`H:\jarvis-agent`
- 分支：`main`
- 代码基线：`9df2b94`（`feat: harden CLI execution and session recovery`）；本文所在的后续文档 commit 只更新计划和交接。
- 当前验证：`typecheck`、`lint`、`npm run build -- --noEmit`、`npm test` 全绿；112 test files / 1210 passed / 2 skipped。
- 产品路线：v0.1 CLI beta → v0.2 全屏 TUI + checkpoint/rewind → v0.3 Desktop control surface。
- 若工作树仍显示未跟踪 `implementation-notes.md`，它是本轮保留的临时收口笔记；根目录 `f` 是 init commit 留下的历史文件。两者都不属于 sessions 任务，未经用户删除授权不得处理或暂存。

先读：

1. `AGENTS.md`
2. `docs/cli-first-plan.md`
3. `docs/handoff-next.md`
4. `docs/sol-pro-cli-trust-review.md`
5. `src/runtime/session/session-store.ts`
6. `src/surfaces/cli/jarvis.ts`
7. `src/surfaces/cli/exit-codes.ts`
8. `test/runtime/session-store.test.ts`

## 2. 不能改变的不变量

- `decideVerdict` 独占 goal 完成授权；sessions 命令只读、无完成授权。
- Session v2 的 `seq`、composition、request/tool receipts、pending detection 和 integrity 语义保持原样。
- v1 日志继续可读，但必须显示 legacy/partial receipt coverage。
- 中段损坏、invalid record、缺 header、v2 seq/composition/receipt 语义错误全部 fail-closed。
- 不新增数据库、事件总线、插件 runtime、provider、map、verifier、route 或 scheduler。
- 不读取或显示密钥；help、list、show 不加载 provider，也不要求模型 key。
- 不自动修复、迁移、重写、归档或删除任何 Session 文件。
- 不触碰 PermissionGate、runAgent、GoalLoop、loop finalize 和恢复授权链。

## 3. 首个可交接任务

### Outcome

实现只读命令：

```text
jarvis sessions list [--json]
jarvis sessions show <session-id> [--json]
```

用户无需打开 `data/sessions/*.jsonl`，即可知道有哪些会话、会话是否可恢复、恢复风险来自哪里。

### 用户可见字段

`list` 每项至少提供：

- session id
- 最后修改时间
- cwd 与 model
- format `v1|v2`
- composition coverage/status
- pending tool effect 数量
- integrity `complete|partial`
- 可恢复性摘要与停止原因（能从现有可信记录推导时）

`show` 至少提供：

- header 与上述身份字段
- message / compaction / request / tool receipt 的数量
- 当前 composition identity 与 coverage
- pending tool effects 的安全摘要
- integrity issues 的路径、行号和类型
- 推荐下一步，例如 exact resume、人工核对或拒绝恢复

默认不打印完整 message、tool arguments、tool output、system addendum 或文件内容。后续若要内容浏览，先单独设计脱敏和输出上限。

### 实现边界

- 复用 `loadSession`、现有 validator 与 operational integrity 断言；禁止用 permissive parser 绕过诊断。
- session id 必须经过既有安全路径/标识校验；`..`、绝对路径、Windows namespaced path 和分隔符逃逸必须拒绝。
- 缺少目录时 `list` 返回空集合与 exit 0；指定 id 不存在或参数错误返回 exit 2；状态损坏返回 exit 7。
- text 输出面向人；`--json` 是 versioned read-only report，至少带 `schemaVersion: 1`、`authority: observation-only` 与 source cwd/dataDir。
- JSON 无 ANSI；字段只做 additive 演进。
- 根 `jarvis --help` 和 `jarvis sessions --help` 能发现命令；help 无 key。

### 必测场景

1. sessions 目录不存在、空目录。
2. 合法 v1、合法 v2。
3. v2 pending intent/planned/unknown。
4. malformed tail 可诊断读取；middle corruption、invalid shape、seq gap、composition/receipt 矛盾返回 exit 7。
5. 不存在 id、路径逃逸、Windows 空格与 UTF-8 cwd/session metadata。
6. text 与 JSON golden/contract；JSON 无 ANSI、带 schemaVersion。
7. `--help`、`--version`、list/show 全程不创建 provider，不读取 key 值。
8. 现有全套测试保持通过。

### 停止条件

遇到以下任一情况，停止编码并写明证据：

- 需要修改 Session v2 schema、pending/receipt 语义或 resume 判定。
- 需要写入、迁移、修复或删除 Session 文件。
- 需要更改 runAgent、PermissionGate、decideVerdict、goal/loop/finalize。
- 需要新增数据库、缓存索引、后台服务、插件或第五套 map。
- 同一失败连续出现 3 次，或需求存在会改变输出隐私边界的产品分歧。

### Return

交付时返回：

1. 改动文件与每个文件的职责。
2. 命令示例和 exit code。
3. 运行过的 checks 与原始结果摘要。
4. 已知边界和未解决风险。
5. `git diff --stat`；不要 push，不要改 tag，不要清理并发文件。

## 4. 接受首切片后可继续交接的工作

这些任务都应单独开切片、独立验收：

1. `sessions search` 的只读 metadata/message 索引，先用线性扫描；不建数据库。
2. sessions text/JSON 输出的筛选、排序与分页。
3. shell completion、帮助示例和 Windows UTF-8/空格路径契约测试。
4. `status --watch` 与只读过滤器，继续消费 ObservationReport。
5. A0 fixture 整理与只读 runner 的机械部分；expected label 与完成裁决仍由独立审查掌握。

rename、fork、archive 属写状态能力，必须等只读切片稳定后另做设计和审批。

## 5. 继续留在当前 Codex 热上下文的工作

以下工作和本轮 R0.5 的故障窗口、权限与完成语义高度耦合，暂不交给冷启动模型：

- exact-session resume 的 dynamic skill/system addendum provenance、composition diff 与 fail-closed UX。
- headless agent-event JSONL 的权威字段、终态映射、退出码和 A0 冻结。
- `history_search/history_turn` 的历史低权威、Prompt Injection、陈旧文件重读和 verdict/permission 隔离。
- typed config 的 precedence、项目层只收紧、凭据隔离与 `inspect/safe` 权限语义。
- checkpoint、`fork-context`、受控文件 restore 与不可逆副作用说明。
- 全屏 TUI 的 interrupt/redirect/approval 状态机和 line/headless 回退。
- DeepSeek V4 Provider 的 finish reason、abort、tool schema、secret redaction 与 A/B 评测。

## 6. 可直接复制给 ZCode 的任务说明

```text
Outcome
在 H:\jarvis-agent 实现只读 `jarvis sessions list|show`，让维护者看清 Session v1/v2 身份、integrity、composition coverage、pending effects 和恢复建议。

Benefit
这是 v0.1 CLI 的首个剩余产品切片，能提高可发现性，同时不改变恢复、权限或完成授权。

Sources
先完整阅读 AGENTS.md、docs/cli-first-plan.md、docs/handoff-next.md、docs/sol-pro-cli-trust-review.md、src/runtime/session/session-store.ts、src/surfaces/cli/jarvis.ts、src/surfaces/cli/exit-codes.ts、test/runtime/session-store.test.ts。

Scope
只实现 `jarvis sessions list [--json]` 与 `jarvis sessions show <id> [--json]`、root help 接线和对应测试。复用 loadSession/现有 integrity validator。默认不输出完整消息、工具参数、工具结果或系统提示正文。

Checks
npm run typecheck
npm run lint
npm run build -- --noEmit
npm test
git diff --check
补测空目录、v1、v2、pending、损坏、路径逃逸、Windows 空格/UTF-8、help 无 key、JSON 无 ANSI/schemaVersion。

Stop when
需要改变 Session schema/pending/resume 语义，触碰 runAgent/PermissionGate/decideVerdict/goal/loop/finalize，引入写状态/数据库/插件/新 map，或同一失败连续 3 次时立即停止并报告。

Return
返回文件职责、命令/exit code、checks 原始摘要、风险、git diff --stat。不要 push、不要打 tag、不要删除或整理并发文件。
```
