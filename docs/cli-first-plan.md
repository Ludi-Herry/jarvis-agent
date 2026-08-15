# Jarvis-Agent CLI-first 路线与验收计划

> 状态：2026-08-14 已更新。本文覆盖产品版本线、可信结果修复和 CLI/TUI 后续范围。GPT-5.6 Sol Pro 复核、落地结果与修正见 `docs/sol-pro-cli-trust-review.md`；历史 GUI-first 证据继续保留在 `docs/handoff-release.md`。

## 1. 成功标准

Jarvis 先成为维护者可日常依赖的本地 CLI。用户需要随时看清 cwd、模型、权限、session、预算、验证等级和下一步；脚本需要靠稳定状态与退出码判断结果；任何 blocked、checks-only、timeout 或损坏状态都不能显示成功。

版本线：

| 版本 | 定位 | 发布门槛 |
|---|---|---|
| v0.1 CLI beta | 本地、私有、面向项目维护者 | R0 可信结果 + R0.5 写入/恢复可信性 + R1 CLI 产品外壳；真实任务零假绿、零无限等待 |
| v0.2 CLI workspace | 日常主力终端工作区 | R2 增强交互 + 全屏 TUI + checkpoint/rewind；行模式与 headless 保留 |
| v0.3 Desktop control surface | 观测、急停、human review、可视化审阅 | 原 R6 UI/UX 打磨与 Luis 逐节验收；复用 CLI 稳定后的事件、配置和状态协议 |

## 2. R0：可信结果

- [x] routine checks 缺少可信目标证据时返回 `checksOnly`，目标保持 `blocked`。
- [x] 缺少 Git tamper baseline 时默认拒绝 goal/loop；`--allow-no-git` 只开放 serial checks-only 运行。
- [x] loop 排空后只要有 blocked goal，就记录 `blocked-goals`；`queue-empty` 只代表全部必要目标完成。
- [x] builder 每轮 120 秒硬时限、每个 goal 默认 15 分钟硬时限；超时写 EventBus 与 JSONL。
- [x] `refused`、未知或缺失 `finish_reason` 全部 halt；只有明确完成状态可以产生 final。
- [x] JSONL 坏行和不可读文件进入 `integrity: partial`，列出数量、路径、行号；observe 退出 7；resume、human review、finalize、cron/daemon 状态恢复遇到中段损坏时 fail-closed。
- [x] cron 将 child loop 非零结果汇总为失败，不能记录假绿。

稳定退出码：

| code | 含义 |
|---:|---|
| 0 | 普通 run 正常结束，或 goal/loop 已 verified complete |
| 2 | 参数、配置或启动前信任条件错误 |
| 3 | blocked、halted，需人工处理 |
| 4 | checks-only / could-not-verify |
| 5 | provider、runtime 或 timeout |
| 6 | permission / sandbox 拒绝（R1 将 run/goal/loop 的明确拒绝统一映射到此码） |
| 7 | 状态文件损坏或观测不完整 |
| 130 | 用户中断 / emergency stop |

本轮退出码已覆盖 `goal`、`loop`、`cron`、`cron:daemon` 与 `observe` 的可信结果路径。`dev`、`loop:finalize`、`shadow` 的旧通用 exit 1，以及当前 `0.0.0` CLI 版本漂移，随 R1 统一命令外壳一起收口。

R0 验收：所有 guardrail 有真实触发路径测试；text 与 JSONL 都不能把非完成状态着成绿色；10–20 个真实任务中要求 0 假绿、0 无限等待，每个 blocked 都给原因、下一步和日志路径。

实现检查（2026-08-12）：`npm run typecheck`、`npm run lint`、`npm run build -- --noEmit`、`npm test` 全绿；测试为 111 files / 1170 passed / 1 skipped，`git diff --check` 通过。已有 `dist/` 按工作区规则保留，未运行会覆盖它的 emit build。10–20 个真实模型任务仍属于 v0.1 beta 运行验收，不能由单元测试替代。

## 3. R0.5：写入与恢复可信性

R0.5 处理两个新的信任问题：文件在“读完到写入”之间可能变化；工具已经产生副作用时，进程可能在结果落盘前崩溃。它不重开 R0 的 verdict、deadline 或退出语义。

- [x] `read` 返回基于原始字节的 opaque `fv1` version；`write` 必须二选一：更新已有文件传 `expectedVersion`，创建新文件传 `createOnly:true`。成功写入返回 `postVersion`。
- [x] managed write 按目标路径做进程内串行化；创建使用 exclusive create；替换前再次检查路径与版本，并在同目录写临时文件后 rename。版本冲突保留原文件并给出重新读取提示。
- [x] Session JSONL v2 增加 `schemaVersion=2`、连续 `seq`、composition、请求哈希收据和工具 `planned / committed / unknown` 收据；原有 v1 日志继续只读兼容。
- [x] assistant tool call 在 gate 或工具执行前持久化；runner 返回可确认的终态后立即写 committed 收据，再生成模型可见 tool message。工具体抛错、子 agent 传回不确定执行结果、file receipt 标记 `unknown` 或取消时写 unknown，并立即 halt；收据落盘失败仍由未完成的 assistant intent / planned 记录触发阻断。
- [x] REPL、goal 与 loop 的 v2 header 记录当前 base system prompt 和实际工具 schema；resume 比较 cwd、model 与 composition。v2 partial composition、混版、序号断裂、重复逻辑执行、伪造投影和未决工具副作用全部 fail-closed。未决副作用不自动重放，交给人工核对。
- [x] `observe` 显示 Session 格式与 pending tool 数量；v2 header/混版/序号问题进入 `integrity: partial` 并沿用 exit 7。
- [x] `loop:finalize` 对 legacy v1 receipt coverage 和 v2 pending tool effect 直接 park，不生成 merge proposal。

安全边界：version token 是 managed file tool 的 stale-baseline 检查点，同内容重写视为同一逻辑版本。进程内锁和 exclusive create 可处理同一 Jarvis 进程的竞态；symbolic-link leaf 与已有多 hard-link 文件会拒绝替换。外部编辑器、另一个 Jarvis 进程、已批准 bash，以及最终检查到 rename 之间的 path/link/metadata 修改仍没有通用 compare-and-swap 保证。出现无法确认的 post-state 时结果为 `unknown`，不得给 verified/complete。

Session v2 的 `committed` 表示 tool runner 已返回一个可确认的终态 `ToolResult`，其中可以包含 permission deny 或执行前的工具错误。工具体开始运行后抛错、子 agent 报告不确定执行结果或 file receipt 标记 `unknown` 时只写 unknown 并 halt，不能产生 final 或完成授权。请求收据保存消息、system addendum 与工具 schema 的哈希和数量，避免重复落盘动态提示内容。当前 resume 会用 header 中的动态来源 ID、来源清单哈希和每个 `runId` 的首次用户消息重算 addendum，逐条核对 request receipt；完整 model-visible trajectory 与 redaction receipt 留给 headless/trajectory 切片。

R0.5 验收：stale update、create race、同 token 并发写、序号断裂、v1/v2 混版、receiptless identity、重复逻辑执行、compaction 伪造投影、assistant intent orphan、planned orphan、unknown 和 committed-without-message 都有触发测试；任何未决副作用都不能自动 resume、重放、finalize merge 或授权完成。

R0.5 独立终审时的实现检查（2026-08-14）：`npm run typecheck`、`npm run lint`、`npm run build -- --noEmit`、`npm test` 全绿；当时测试为 112 files / 1210 passed / 2 skipped，tracked 与 untracked whitespace 检查通过。新增的第二个 skip 是 Windows 文件 symlink 需要额外权限；hard-link、junction 与路径逃逸仍在 Windows 实跑。已有 `dist/` 保持不动。独立终审第三轮结论为 GO（P0=0、P1=0、P2=0）；前两轮发现的 unknown execution、composition、finalize receipt coverage、identity/projection 与 compaction orphan 漏口均已通过触发测试关闭。sessions 与动态恢复合入后的当前证据见本计划第 5 节。

## 4. R1：CLI 产品外壳

第一切片（2026-08-12）已完成：

- [x] 新增统一 `jarvis` 根命令与可打包的 `bin/jarvis.js` 源码启动器；源码工作区通过 `npm run jarvis -- <command>` 使用，安装包通过 `jarvis` 使用。
- [x] `--help`、子命令 help 和 `--version` 不加载 provider；版本统一读取 `package.json`。
- [x] 全局 `--cwd` 在子命令启动前生效，目标 workspace 的 `.env`、工具和 `data/` 从同一 cwd 解析；覆盖 Windows 空格路径。
- [x] 现有 run/resume/goal/loop/status/finalize/cron/shadow 通过薄转发继续使用原验收逻辑和退出码。
- [x] `doctor [--json]` 只读检查 Node、cwd、凭据来源、Git baseline、sandbox 命令与 data path，不显示凭据值，也不发 provider 请求。

Sessions 与动态恢复切片（2026-08-15）已完成：

- [x] `jarvis sessions list|show [--json]` 只读显示 Session v1/v2 身份、integrity、composition、pending effect 与恢复建议；不读取 provider、不输出消息/工具参数正文、没有完成授权。
- [x] REPL v2 header 记录 `skill-registry-v1` 与完整解析后 Skill manifest 的哈希；goal/loop 记录显式 `none-v1`。原始 Skill 正文不复制进第二份 payload。
- [x] 实际 exact-session resume 在 Provider/工具执行前比较 base composition、动态来源与 manifest，并按首次 request 前的 durable user message 重算每个 run 的 addendum。相同来源继续；旧 v2 缺来源或来源漂移退出 3；来源一致但 receipt 矛盾、缺激活消息或半份 provenance 退出 7。
- [x] `sessions list|show` 显示动态来源与 manifest 哈希；旧 v2 缺动态 provenance 标记 `review-composition`，legacy v1 保持原有证据不足提示。
- [x] `sessions show` 与实际 resume 共用窄 Session ID/路径边界：拒绝路径分隔符、遍历、绝对路径、Windows namespaced path、设备名及扩展名变体、尾随点/空格、symbolic link/junction/reparse escape；文件名 ID 与 header ID 不一致时拒绝恢复。
- [x] `sessions show` 缺少当前 invocation composition，只给 `ready-for-resume-check`；`compatibility: exact` 只由实际 resume 完成 composition/addendum 对比后输出。
- [x] 所有人类可读 sessions/resume 字段及 REPL/loop 错误经过单行终端净化；JSON 保持标准转义且不注入 ANSI。只有明确 `ENOENT` 返回 not found/exit 2，其余 stat/read 错误与无错误码的 operational semantic failure 保留为 unreadable/partial/exit 7。
- [x] 根 `jarvis --cwd`、latest discovery 与 resolver 后二次读取共用同一错误分类；EACCES、EPERM、EIO 均有命令层或确定性触发测试。latest 目录枚举/条目消失、actual resume 二次读取、junction/canonical escape 与 loop 参数/map/resume/fatal 控制字符都有生产接线覆盖。
- [x] 本切片的路径保证覆盖静态 symlink/junction/reparse 与 canonical escape。恶意同用户进程在校验和读取之间主动替换路径仍超出保证；Session 当前也没有跨进程 writer lock 或密码学真实性。hostile concurrent local writer 进入支持的威胁模型后，再评估 file-handle binding。

仍待 v0.1 关键切片：A0 只读 runner 与真实运行、Recall 开关同形任务对照、typed config 与 `inspect/safe`、完整 Windows 契约和 10–20 个真实任务。当前 Session 两级 Recall、versioned headless JSONL agent-event v1、严格 A0 类型、六案冻结 corpus 与纯 report 已完成。当前 package bin 由锁定的 runtime `tsx@4.22.4` 启动源码；packed artifact 已在 Windows 空格路径下用 `--omit=dev` 安装，`jarvis --help`、`--version`、`status --json` 全部 exit 0。纯编译 bin、stop/review/completion、其余 sessions mutation 与更多 preset 属后续产品化；被忽略的 `dist/` 已在本轮误覆盖，现保持原样，未经授权不再清理或重建。

- 单一 `jarvis` executable 与命令树：`run`、`goal`、`loop`、`resume`、`status`、`doctor`、`config` 为根帮助高频项；help/version/global flags 与旧入口退出码统一，版本读取 `package.json`。
- 会话：v0.1 已交付只读 `sessions list|show`，实际 exact-session resume 会显示 cwd、模型、composition diff、pending effect 和停止原因；search/rename/fork/archive 分切片后移。
- 配置：typed TOML，顺序为内置默认 < 用户 < 项目共享安全字段 < 项目本地 < preset < CLI flags < session 临时值；项目层只能收紧权限。
- 首版 preset：`inspect`、`safe`。`maintain`、`worktree` 等 A0 证明用户目标差异后再加入；preset 只组合现有参数和四套可信 map。
- Headless：保留现有人类 text 输出，先冻结一条 versioned JSONL agent-event contract；静态 JSON 由消费者聚合。事件流无 ANSI。
- Recall：`history_search` / `history_turn` 只读当前 Session 的 append-only 历史；普通工具输出默认排除，取回内容标记 historical，不能证明当前文件状态，也没有完成授权。
- `doctor`、completion、Windows UTF-8/空格路径/PowerShell 验收；所有帮助和诊断无需模型 key。

长期命令树（以下并非全部属于 v0.1 blocker）：

```text
jarvis
jarvis run "<prompt>"
jarvis goal "<objective>"
jarvis loop <objectives-file>

jarvis resume [id|--last]
jarvis sessions list|show|search|rename|fork|archive

jarvis status [--watch] [--json] [--goal ID|--loop ID]
jarvis stop <id>
jarvis review list|show|approve|reject
jarvis finalize <loop-id> [--merge] [--cleanup]

jarvis cron run|daemon|status
jarvis config path|show|get|set|unset|validate
jarvis config preset list|show
jarvis doctor [--json] [--connect]

jarvis inspect skills|agents|hooks
jarvis shadow log|restore
jarvis completion powershell|bash|zsh
```

现有 `npm run dev|goal|loop|cron|observe|...` 保留一个版本周期作为兼容入口。`config` 是唯一设置命令，界面文案可写“设置”。v0.1 不建独立 profile 根目录；cwd + session + preset 足够覆盖当前维护场景，多身份、多凭据或 provider 隔离出现真实需求后再评估。

配置位置：用户 `%USERPROFILE%\.jarvis\config.toml`；项目共享 `.jarvis/config.toml`；项目本地 `.jarvis/config.local.toml` 且默认忽略版本控制。`--cwd` 必须在 `.env` 与项目配置解析前生效。提供 `config show --effective --sources`、`config validate`、`--strict-config`、`--ignore-user-config`、`--safe`。凭据只进系统凭据源或 `.env`，不能写普通 TOML，也不能在 doctor/status 中回显。deny 永远优先，项目设置只能收紧权限；四套可信 map 记录规范化路径和 hash。

preset 合同：

| preset | 用途 | 约束 |
|---|---|---|
| `inspect` | 阅读、审计 | 禁止 write、bash 和网络副作用 |
| `safe` | 默认交互维护 | read 允许；write/bash 逐次询问 |
| `maintain`（A0 后） | 单个可验证目标 | 要求 Git 与 trusted checks；checks-only 进入人工处理 |
| `worktree`（A0 后） | loop/cron 批处理 | 只写自己的 worktree；bash/vision fail-closed；缺可信 maps 拒绝启动 |

JSONL 首批事件：`session.started`、`model.started`、`model.finished`、`tool.started`、`tool.finished`、`approval.required`、`approval.resolved`、`check.finished`、`run.finished`。每条带 `schemaVersion`、`sessionId`、`cwd`、`timestamp`；JSONL 不带 ANSI。

R1 交付顺序：

1. [x] 只读 `sessions list|show`；实现边界见 `docs/handoff-zcode-glm53.md`。
2. [x] 收口 exact-session resume 的 dynamic composition/addendum 比较、来源展示和 fail-closed 提示。
3. [x] 固定 versioned headless JSONL agent-event contract、六案 label-blind A0 corpus 与纯 report；现有人类 text 继续保留，A0 真实运行仍单列验收。
4. [x] 在 REPL 当前 Session 增加 `history_search` / `history_turn`，默认开启并提供 `--no-recall`；goal/loop 暂不接入。
5. [ ] 用 Recall 开关跑同形 A0/真实任务对照。
6. [ ] 实现 typed config、有效来源展示与 `inspect` / `safe`；`maintain` / `worktree` 等 A0 后再决定。
7. [ ] 跑 10–20 个真实同形任务，要求零 false-verified、零无限等待、零 orphan side effect。

本切片检查（2026-08-15）：聚焦测试 12 files / 183 passed；`npm run typecheck`、`npm run lint`、`npm run build -- --noEmit`、`npm test` 全绿；全量测试为 119 files / 1334 passed / 2 skipped。独立提交门终审为 GO（P0=0、P1=0、P2=0、P3=1）；P3 是已记录的 hostile same-user check-to-read 并发替换窗口，不阻断当前威胁模型下的提交。代码提交为 `a814889`。已有 `dist/` 保持不动。

Headless/A0 实现检查（2026-08-15）：authenticated child-to-root framing 只把 v1 agent-event JSONL 写到 stdout，人类文本以 inert diagnostics 进入 stderr；64 KiB frame 上限、stdout backpressure、partial/forged frame、bounded child termination 和 loop ask-deny 顺序均有真实触发测试。run/goal/loop 在 headless 下 fail-closed，只有实际 `decideVerdict` 的 goal `complete/verified` 可声明完成。A0 corpus 经 fresh Reviewer 独立定标 GO（P0/P1/P2=0），严格 parser、evidence SHA-256、11 个 selector、label-blind、tampered park miss 与 Windows evidence path 边界均有测试。聚焦测试为 10 files / 195 passed；`typecheck`、`lint`、`npm run build -- --noEmit` 与全量 `npm test` 已通过，当前全量为 122 files / 1385 passed / 2 skipped；提交门红队终审及 P2 窄复核均为 GO（P0=0、P1=0、P2=0、P3=1），代码提交为 `b5588ff`。真实 A0 attempts 和 10–20 个同形任务未由 fixtures 替代。本轮 transport 子任务误跑 emit build，已在 2026-08-15 17:46 覆盖被忽略的 `dist/`；旧字节无法从 Git 恢复，后续保持现状，未经授权不再清理或重建。

Recall 实现检查（2026-08-15）：首版限定 `jarvis run/resume` 的当前 Session，host closure 固定 cwd/id，模型输入不能选 Session 或路径；每次调用重新走既有路径、header identity 与 integrity 校验。投影只读取 append-only message records，忽略 compaction/system/reasoning/tool arguments，排除当前 turn，普通 tool output 默认省略。返回值带 historical-low/no-authority 标记，并限制 matches、turn messages、tool names 与总文本；已知 secret 模式、历史 file receipt/`fv1`、C0/C1/ANSI/bidi 控制符会被清理，日志读取或语义校验失败也只返回固定、有界的 historical-low 不可用信封。`--no-recall` 同时移除两项工具与 prompt boundary，保留 pre-Recall composition 的 exact resume。真实 root E2E 已验证 Recall 无 approval、无 completion authority；聚焦测试 6 files / 133 passed，全量为 123 files / 1404 passed / 2 skipped，`typecheck`、`lint`、`npm run build -- --noEmit`、diff check 全绿。独立提交门为 GO（P0=0、P1=0、P2=0、P3=1），代码提交为 `81f96e0`。Recall A/B 真实任务尚未运行。

Recall 保持 Jarvis 原生实现，读取现有 Session JSONL，不引入 DSH/Cordis runtime、第二个事件总线或会话数据库。首版只进入 REPL `run/resume`；goal/loop 需要单独合同与旧 composition 迁移判断。A0 对照至少比较 verified rate、false-verified、峰值输入、总成本、p95、Recall 精度、额外工具轮次和恢复成功率；只有显式 Recall 仍解决不了长会话问题时，才评估 bounded slice 原型。

## 5. R2：增强行模式与全屏 TUI

行模式和 TUI 共用 AgentLoop、EventBus、PermissionGate、SessionStore 与状态定义。TTY 默认可选择 TUI；`--no-tui` 和非 TTY 永远走行模式/headless，确保故障时有可靠回退。

全屏 TUI 首版区域：顶部运行身份与验证等级；中央对话/事件流；右侧 context、diff、预算和待审批；底部输入与快捷键。长工具输出折叠并保留耗时、退出码和日志路径。Esc 停止当前模型/工具，Ctrl-C 第一次停止、第二次退出；mid-turn 输入可排队或 redirect，动作须进入审计。

首批 slash commands：`/help`、`/status`、`/context`、`/diff`、`/permissions`、`/model`、`/compact`、`/clear`、`/fork`、`/checkpoint`、`/rewind`、`/exit`。`@` 文件补全与受 PermissionGate 保护的 `!shell` 同期实现。

## 6. Checkpoint / rewind 合同

现有 SessionStore 的 compaction checkpoint 继续保持原语义。用户可回退的 checkpoint 使用独立记录类型，避免把上下文压缩快照误当文件恢复点。

- 每个用户 prompt 前、每次模型写入波次前创建 checkpoint；记录 checkpointId、sessionId、时间、消息 cursor、cwd、ShadowGit snapshot 引用和不可逆副作用摘要。
- 默认 rewind 只回退对话与上下文。`--files` 需要先展示 diff、目标 checkpoint 和不可逆副作用，再经显式确认恢复文件。
- 文件恢复复用 ShadowGit 的审计历史与受控 apply，不使用 `git reset --hard`，不覆盖未纳入 checkpoint 的并发改动。
- 网络请求、数据库写入、push、发消息、凭据变更等外部副作用不能回退；TUI 必须明确列出。
- rewind 只改变会话/工作树状态，不产生 verified/complete；每次操作追加 audit record，可继续从回退点 fork 新会话。

验收：checkpoint 可在崩溃后枚举；conversation-only rewind 不碰文件；files rewind 在 dirty/concurrent drift 时 fail-closed；PowerShell 与空格路径通过；TUI、行模式、未来 GUI 展示同一条审计事实。

## 7. 继续保持的边界

- 不新增第 5 套 map、scheduler 或 verifier 抽象。
- 不开放 unattended bash / vision，不提供 yolo preset。
- `propose_skill`、MCP、插件市场、自动 merge/push/self-update 继续 defer。
- GUI observation、TUI 展示和 rewind 都没有完成授权；`decideVerdict` 继续是唯一 verdict 决策点。

## 8. 最终验收门槛

- 新用户不读 README，也能从 `jarvis --help` 和首次检查完成第一次对话。
- 任意时刻可见 cwd、模型、权限、session、预算和验证等级。
- resume/fork 一条命令完成，恢复来源明确。
- 失败、blocked、checks-only、cannot-verify 和 timeout 都返回约定非零码，并给出下一步与日志路径。
- text/json/jsonl 有 golden tests，schema 有版本，机器输出无 ANSI。
- 每个配置字段都能显示最终值与来源，项目设置不能放宽安全策略。
- PowerShell 下 help、completion、多行输入、Ctrl-C、UTF-8、空格路径通过。
- CLI、TUI 与 GUI 消费同一 EventBus 和状态定义。
