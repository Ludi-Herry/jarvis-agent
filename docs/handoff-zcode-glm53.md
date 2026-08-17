# ZCode / GLM-5.3 交接：Jarvis 低权威 CLI 与 A0 机械切片

> 状态（2026-08-18）：sessions 首切片及安全收口、headless event v1、A0 冻结 corpus、当前 Session Recall、typed config、checkpoint/rewind、TUI reducer/fallback、纯 TUI renderer、A0 只读 runner（v2 真实跑分 GO）、只读 `sessions search`、筛选/排序/分页、session mutation（fork/rename/archive/unarchive，写状态首切片，语义经 Luis 拍板）与终端 human review（`review list|show|approve|reject`）、shell completion（`completion powershell|bash|zsh`）均已提交并通过独立门禁。ZCode 机械切片清单（本文件 §4）、写状态首切片、review 表面与补全全部收口；剩余工作为 Recall A/B、真实任务验收（烧钱，需 Luis 放行）、TUI renderer TTY 验收与 stop/maintain-worktree preset 等后续产品化。提交级状态以 `docs/handoff-next.md` 为准。

> 状态：2026-08-14。本文面向接手实现的模型，范围已刻意收窄。开始前必须核对 Git 基线与工作树；发现 HEAD 或状态不一致时停止并汇报。

## 1. 当前基线

- 仓库：`H:\jarvis-agent`
- 分支：`main`
- sessions/resume 收口代码提交：`a814889`（`feat: harden session resume and inspection`）。
- headless/A0 收口代码提交：`b5588ff`（`feat: add authenticated headless events and a0 corpus`）；本文与其余正式说明进入独立文档提交。
- 合并 dynamic composition resume 与 sessions/resume hardening 后的当前验证：聚焦测试 12 files / 183 passed；`typecheck`、`lint`、`npm run build -- --noEmit`、`npm test` 全绿；119 test files / 1334 passed / 2 skipped。独立提交门终审为 GO（P0=0、P1=0、P2=0、P3=1）；唯一 P3 是已披露的 hostile same-user check-to-read 并发替换窗口。
- headless/A0 当前验证：聚焦测试 10 files / 195 passed；`typecheck`、`lint`、`npm run build -- --noEmit`、`npm test` 全绿；122 test files / 1385 passed / 2 skipped。提交门及 P2 窄复核均为 GO（P0=0、P1=0、P2=0、P3=1）；P3 是已披露的 ignored `dist/` 误覆盖流程偏离，不影响当前源码入口。
- typed config 当前验证：聚焦测试 12 files / 190 passed；`typecheck`、`lint`、`npm run build -- --noEmit`、`npm test` 与 diff check 全绿；126 test files / 1456 passed / 2 skipped。环境 endpoint 已绑定 composition identity，原型继承键 fail-closed，`safe` 不再继承 unattended worktree 自动写入；修复首轮 P1/P2 后，独立提交门为 GO（P0=0、P1=0、P2=0、P3=1），代码提交为 `9d53d1a`。
- checkpoint/TUI 本地门禁：首轮独立 Reviewer 唯一 P1（project-ignored 文件从 inventory、`add -A` 与 drift/restore 中静默消失，rewind 可误报成功）已于 2026-08-16 修复：普通 project-ignored 文件经两次 `--ignored` 清单差集 + 显式分批 `add -f` 强制捕获，shadow 自身 structural/secret 排除保持唯一边界，negation 暴露 fail-closed，rewind 对磁盘仍存在的 project-ignored 删除项要求 target 带捕获标记。修复后聚焦 ShadowGit + checkpoint CLI 40 passed、组合 10 files / 105 passed；全量 134 files / 1538 passed / 2 skipped，静态门禁与 whitespace 检查全绿；修复后独立 Reviewer 复核 GO（P0=0、P1=0、P2=0、P3=4，P3 清单见 `docs/handoff-next.md`），原 P1 确认关闭。conversation fork 使用 receipt-free projection，tool-bound checkpoint 拒绝 rewind；文件恢复保留 preflight 并拒绝 hook/external diff、protected/link/hard-link path 与 drift。代码 SHA 记录见 `docs/handoff-next.md`。
- 产品路线：v0.1 CLI beta → v0.2 checkpoint/rewind 基础 + TUI reducer + 纯 renderer → v0.3 Desktop control surface。
- `implementation-notes.md` 是本轮临时偏差记录，不进入阶段提交；有效内容以正式文档为准，提交门后按授权精确删除。根目录历史占位文件 `f` 的早期清理记录保持不变。

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

用户无需打开 `data/sessions/*.jsonl`，即可知道有哪些会话、恢复前证据是否齐全、风险来自哪里。

### 用户可见字段

`list` 每项至少提供：

- session id
- 最后修改时间
- cwd 与 model
- format `v1|v2`
- composition coverage/status
- pending tool effect 数量
- integrity `complete|partial`
- 恢复前检查摘要与停止原因（能从现有可信记录推导时）

`show` 至少提供：

- header 与上述身份字段
- message / compaction / request / tool receipt 的数量
- 当前 composition identity 与 coverage
- pending tool effects 的安全摘要
- integrity issues 的路径、行号和类型
- 推荐下一步，例如运行实际 resume check、人工核对或拒绝恢复

默认不打印完整 message、tool arguments、tool output、system addendum 或文件内容。后续若要内容浏览，先单独设计脱敏和输出上限。

### 实现边界

- 复用 `loadSession`、现有 validator 与 operational integrity 断言；禁止用 permissive parser 绕过诊断。
- session id 必须经过共享安全路径/标识校验；`..`、绝对路径、Windows namespaced path、分隔符、设备名变体、尾随点/空格、symbolic link/junction/reparse escape 必须拒绝。请求文件名 ID 与 header ID 不一致时 fail-closed。
- 缺少目录时 `list` 返回空集合与 exit 0；明确 `ENOENT` 或参数错误返回 exit 2；EACCES、EPERM、I/O、非普通文件及其他不可读状态返回 partial/exit 7。
- 静态 symlink/junction/reparse 与 canonical escape 属当前拒绝范围。同用户恶意进程在校验后、读取前主动替换路径超出本切片保证；Session 日志尚无 cross-process writer lock 或 cryptographic authenticity。只有威胁模型明确纳入 hostile concurrent local writer 时才重开 file-handle binding。
- text 输出面向人；`--json` 是 versioned read-only report，至少带 `schemaVersion: 1`、`authority: observation-only` 与 source cwd/dataDir。
- JSON 无 ANSI；字段只做 additive 演进。
- 根 `jarvis --help` 和 `jarvis sessions --help` 能发现命令；help 无 key。

### 必测场景

1. sessions 目录不存在、空目录。
2. 合法 v1、合法 v2。
3. v2 pending intent/planned/unknown。
4. malformed tail 可诊断读取；middle corruption、invalid shape、seq gap、composition/receipt 矛盾返回 exit 7。
5. 不存在 id、Windows 设备名及扩展名变体、路径/junction 逃逸、filename/header mismatch、Windows 空格与 UTF-8 cwd/session metadata。
6. text 与 JSON golden/contract；ESC、CR/LF、清屏/颜色序列不能伪造终端输出；JSON 无 ANSI、带 schemaVersion 并保持标准转义。
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

1. [x] `sessions search` 的只读 metadata/message 索引，先用线性扫描；不建数据库。（2026-08-17 已交付并通过独立提交门，见 `docs/handoff-next.md`。）
2. [x] sessions text/JSON 输出的筛选、排序与分页。（2026-08-17 已交付并通过独立提交门，见 `docs/handoff-next.md`。）
3. shell completion、帮助示例和 Windows UTF-8/空格路径契约测试。
4. `status --watch` 与只读过滤器，继续消费 ObservationReport。
5. A0 observations 文件加载、只读 runner、report 输出与 immutable run manifest；冻结 corpus、expected label、阈值和完成裁决不改。
6. checkpoint/TUI 固定代码 SHA 通过独立 Reviewer 后，只实现纯 renderer、布局、折叠和键位展示；不得修改 reducer transition、action audit、AgentEvent、PermissionGate、Session、checkpoint 或完成授权。

rename、fork、archive 属写状态能力，必须等只读切片稳定后另做设计和审批。

## 5. 继续留在当前 Codex 热上下文的工作

以下工作和本轮 R0.5 的故障窗口、权限与完成语义高度耦合，暂不交给冷启动模型：

- [x] 实际 exact-session resume 的 dynamic skill/system addendum provenance、composition diff 与 fail-closed UX。
- [x] headless agent-event JSONL 的权威字段、终态映射、退出码和 A0 冻结。
- [x] `history_search/history_turn` 的历史低权威、Prompt Injection、陈旧文件重读和 verdict/permission 隔离；首版限定 REPL `run/resume`，goal/loop 保持原 composition。代码提交 `81f96e0`，独立提交门 GO（P0=0、P1=0、P2=0、P3=1）。
- [x] typed config 的 precedence、项目层只收紧、凭据隔离与 `inspect/safe` 权限语义；`run/goal/loop` 真实 gate、环境 endpoint identity 与 exact-resume composition 已覆盖，代码提交 `9d53d1a`，独立提交门 GO（P0=0、P1=0、P2=0、P3=1）。
- [x] checkpoint audit、conversation fork、受控文件 restore 与不可逆副作用说明；Session schema/receipts 不变，tool-bound checkpoint fail-closed。
- [x] TUI interrupt/redirect/approval 纯状态机、action audit 与 line/headless 回退；全屏 renderer 保留给独立机械切片。
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
