# Jarvis-Agent CLI-first 路线与验收合同

> 类型：持续维护的产品路线与验收合同。版本定位、信任边界和发布门槛以本文为准；每个切片的测试数字与 commit 属日期化证据。
> 仍开放的人工门槛集中在 `docs/TODO-v01-evidence.md`。GPT-5.6 Sol Pro 的日期化复核见 `docs/sol-pro-cli-trust-review.md`；GUI-first 历史证据见 `docs/handoff-release.md`。
> 2026-08-31，Ludi 批准 MVP 范围收缩：先跑 3 个真实任务，TUI 视觉验收暂停，Recall A/B 降为次级实验；G5 与 post-real-use 扩展继续冻结。三个任务结束后再决定是否扩到 6–10 个样本。
> 三任务阶段已于 2026-08-31 以 NO-GO 收口。Inspect 工程收窄后，冻结模型对照显示 `deepseek-v4-pro-ga-260813` 能在约 45 秒、181,819 tokens、16 次工具内自然完成同一只读 canary。单任务模型可行性 GO；原三任务 0/3 与产品 NO-GO 保持，DeepSeek 中间思路流的采用边界待裁决。

## 1. 成功标准

Jarvis 先成为维护者可日常依赖的本地 CLI。用户需要随时看清 cwd、模型、权限、session、预算、验证等级和下一步；脚本需要靠稳定状态与退出码判断结果；任何 blocked、checks-only、timeout 或损坏状态都不能显示成功。

版本线：

| 版本 | 定位 | 发布门槛 |
|---|---|---|
| v0.1 CLI beta | 本地、私有、面向项目维护者 | R0 可信结果 + R0.5 写入/恢复可信性 + R1 CLI 产品外壳；三类真实任务零假绿、零无进展、零孤儿副作用 |
| v0.2 CLI workspace | 日常主力终端工作区 | R2 增强交互 + 全屏 TUI + checkpoint/rewind；行模式与 headless 保留 |
| v0.3 Desktop control surface | 观测、急停、human review、可视化审阅 | 原 R6 UI/UX 打磨与 Ludi 逐节验收；复用 CLI 稳定后的事件、配置和状态协议 |

## 2. R0：可信结果

- [x] routine checks 缺少可信目标证据时返回 `checksOnly`，目标保持 `blocked`。
- [x] 缺少 Git tamper baseline 时默认拒绝 goal/loop；`--allow-no-git` 只开放 serial checks-only 运行。
- [x] loop 排空后只要有 blocked goal，就记录 `blocked-goals`；`queue-empty` 只代表全部必要目标完成。
- [x] builder 每轮 120 秒硬时限、每次 `task` 委派 120 秒总硬时限、每个 goal 默认 15 分钟硬时限；builder/goal 超时写 EventBus 与 JSONL，`task` 超时向父模型返回错误或不确定状态。
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

R0 首轮先覆盖 `goal`、`loop`、`cron`、`cron:daemon` 与 `observe` 的可信结果路径；统一 `jarvis` 外壳随后收口版本来源与兼容入口。当前命令及退出码以对应子命令的 `--help` 为准。

R0 验收：所有 guardrail 有真实触发路径测试；text 与 JSONL 都不能把非完成状态着成绿色；首轮三个真实任务覆盖只读、文档修改和代码+测试，要求 0 假绿、0 无进展、0 孤儿副作用。任务类型或结果出现明显波动后再扩到 6–10 个样本。

实现检查（2026-08-12）：`npm run typecheck`、`npm run lint`、`npm run build -- --noEmit`、`npm test` 全绿；测试为 111 files / 1170 passed / 1 skipped，`git diff --check` 通过。已有 `dist/` 按工作区规则保留，未运行会覆盖它的 emit build。真实模型任务仍属于 v0.1 beta 运行验收，不能由单元测试替代；当前数量以 `docs/TODO-v01-evidence.md` 为准。

## 3. R0.5：写入与恢复可信性

R0.5 处理两个新的信任问题：文件在“读完到写入”之间可能变化；工具已经产生副作用时，进程可能在结果落盘前崩溃。它不重开 R0 的 verdict、deadline 或退出语义。

- [x] `read` 返回基于原始字节的 opaque `fv1` version；大文件可用 `startLine` + `maxLines` 有界读取并获得下一段提示，默认完整输出保持兼容。`write` 必须二选一：更新已有文件传 `expectedVersion`，创建新文件传 `createOnly:true`。成功写入返回 `postVersion`。
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

v0.1 当前只开放三个真实维护任务。TUI 的真实 TTY 体验验收暂停，Recall 开关同形对照移到三任务之后；A0 v2、Windows 关键合同、Recall 基础、typed config、headless JSONL、TUI renderer、stop、review、completion 和 Session mutation 已进入代码基线。执行顺序、记录表和止损线只在 `docs/TODO-v01-evidence.md` 维护。

- 单一 `jarvis` executable 与命令树：`run`、`goal`、`loop`、`resume`、`status`、`doctor`、`config` 为根帮助高频项；help/version/global flags 与旧入口退出码统一，版本读取 `package.json`。
- 会话：v0.1 已交付只读 `sessions list|show` 与 `sessions search`（metadata + append-only user/assistant 文本的线性扫描，不建索引），list/search 的筛选、排序与分页已交付（list 三件套全量，search 为 session 筛选 + matches 分页）；写状态首切片 `sessions fork|rename|archive|unarchive` 已交付（fork 全量复制含 receipt + `forkedFrom` 血缘；rename = fork + 归档原会话，零删除零原地改写；archive 移动到 `data/sessions/archived/` 可逆）；实际 exact-session resume 会显示 cwd、模型、composition diff、pending effect 和停止原因。
- 配置：typed TOML，顺序为内置默认 < 用户 < 项目共享安全字段 < 项目本地 < preset < CLI flags < session 临时值；项目层只能收紧权限。
- 首版 preset：`inspect`、`safe`。`maintain`、`worktree` 等 A0 证明用户目标差异后再加入；preset 只组合现有参数和四套可信 map。
- Headless：保留现有人类 text 输出，先冻结一条 versioned JSONL agent-event contract；静态 JSON 由消费者聚合。事件流无 ANSI。
- Recall：`history_search` / `history_turn` 只读当前 Session 的 append-only 历史；普通工具输出默认排除，取回内容标记 historical，不能证明当前文件状态，也没有完成授权。
- `doctor`、completion、Windows UTF-8/空格路径/PowerShell 验收；所有帮助和诊断无需模型 key。

已实现命令树由 `jarvis --help` 与各子命令的 `--help` 生成。路线文档不复制尚未实现的参数，避免候选设计被误当成可运行接口。

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
3. [x] 固定 versioned headless JSONL agent-event contract、六案 label-blind A0 corpus、真实 runner 与纯 report；现有人类 text 继续保留。
4. [x] 在 REPL 当前 Session 增加 `history_search` / `history_turn`，默认开启并提供 `--no-recall`；goal/loop 暂不接入。
5. [ ] 三任务通过后，按真实历史检索需求决定是否跑 Recall 开关同形对照。
6. [x] 实现 typed config、有效来源展示与 `inspect` / `safe`；`maintain` / `worktree` 等 A0 后再决定。
7. [ ] 跑只读、文档修改、代码+测试三个真实任务；出现样本差异或需要发布置信度时再扩到 6–10 个。
8. [x] `sessions search` 只读线性搜索（2026-08-17，实现检查见下）。
9. [x] sessions list/search 的筛选、排序与分页（2026-08-17，实现检查见下）。
10. [x] `sessions fork|rename|archive|unarchive` 写状态首切片（2026-08-18，实现检查见下）。
11. [x] `review list|show|approve|reject` 终端人工裁决（2026-08-18，实现检查见下）。
12. [x] `completion powershell|bash|zsh` shell 补全（2026-08-18，实现检查见下）。
13. [x] `stop` workspace 急停 CLI（2026-08-18，实现检查见下）。

本切片检查（2026-08-15）：聚焦测试 12 files / 183 passed；`npm run typecheck`、`npm run lint`、`npm run build -- --noEmit`、`npm test` 全绿；全量测试为 119 files / 1334 passed / 2 skipped。独立提交门终审为 GO（P0=0、P1=0、P2=0、P3=1）；P3 是已记录的 hostile same-user check-to-read 并发替换窗口，不阻断当前威胁模型下的提交。代码提交为 `a814889`。已有 `dist/` 保持不动。

Headless/A0 实现检查（2026-08-15）：authenticated child-to-root framing 只把 v1 agent-event JSONL 写到 stdout，人类文本以 inert diagnostics 进入 stderr；64 KiB frame 上限、stdout backpressure、partial/forged frame、bounded child termination 和 loop ask-deny 顺序均有真实触发测试。run/goal/loop 在 headless 下 fail-closed，只有实际 `decideVerdict` 的 goal `complete/verified` 可声明完成。A0 corpus 经 fresh Reviewer 独立定标 GO（P0/P1/P2=0），严格 parser、evidence SHA-256、11 个 selector、label-blind、tampered park miss 与 Windows evidence path 边界均有测试。聚焦测试为 10 files / 195 passed；`typecheck`、`lint`、`npm run build -- --noEmit` 与全量 `npm test` 已通过，当前全量为 122 files / 1385 passed / 2 skipped；提交门红队终审及 P2 窄复核均为 GO（P0=0、P1=0、P2=0、P3=1），代码提交为 `b5588ff`。真实 A0 attempts 和 10–20 个同形任务未由 fixtures 替代。本轮 transport 子任务误跑 emit build，已在 2026-08-15 17:46 覆盖被忽略的 `dist/`；旧字节无法从 Git 恢复，后续保持现状，未经授权不再清理或重建。

Recall 实现检查（2026-08-15）：首版限定 `jarvis run/resume` 的当前 Session，host closure 固定 cwd/id，模型输入不能选 Session 或路径；每次调用重新走既有路径、header identity 与 integrity 校验。投影只读取 append-only message records，忽略 compaction/system/reasoning/tool arguments，排除当前 turn，普通 tool output 默认省略。返回值带 historical-low/no-authority 标记，并限制 matches、turn messages、tool names 与总文本；已知 secret 模式、历史 file receipt/`fv1`、C0/C1/ANSI/bidi 控制符会被清理，日志读取或语义校验失败也只返回固定、有界的 historical-low 不可用信封。`--no-recall` 同时移除两项工具与 prompt boundary，保留 pre-Recall composition 的 exact resume。真实 root E2E 已验证 Recall 无 approval、无 completion authority；聚焦测试 6 files / 133 passed，全量为 123 files / 1404 passed / 2 skipped，`typecheck`、`lint`、`npm run build -- --noEmit`、diff check 全绿。独立提交门为 GO（P0=0、P1=0、P2=0、P3=1），代码提交为 `81f96e0`。Recall A/B 真实任务尚未运行。

Recall 保持 Jarvis 原生实现，读取现有 Session JSONL，不引入 DSH/Cordis runtime、第二个事件总线或会话数据库。首版只进入 REPL `run/resume`；goal/loop 需要单独合同与旧 composition 迁移判断。A0 对照至少比较 verified rate、false-verified、峰值输入、总成本、p95、Recall 精度、额外工具轮次和恢复成功率；只有显式 Recall 仍解决不了长会话问题时，才评估 bounded slice 原型。

Typed config 实现检查（2026-08-15）：schema v1 使用 `smol-toml` 解析用户、项目与 project-local 三层 TOML；project-local 文件默认由 Git 忽略，precedence 固定为 built-in → user → nonblank compatibility env → CLI。项目层只能增加 capability deny，不能选择 model/preset；credential-like key、原型继承键、非 `ENOENT` 读取错误、畸形/超限文件、控制字符或超长 endpoint、非法 schema/value 均 fail-closed 且错误不带原值。unknown key 默认有界 warning，`--strict-config` 改为拒绝，`--ignore-user-config` 不读取用户文件并保留 ignored receipt。`jarvis config path|show|validate|preset` 保持 observation-only；`run`、`goal`、`loop` 共用同一 `inspect/safe` policy，项目 deny 不能被 preset、CLI 或 allow rule 放宽。`safe` 会关闭 unattended parallel-worktree write shortcut，headless write 仍产生 approval pair 后拒绝。默认 prompt 字节不变；显式 user/CLI model、user/environment/CLI baseURL 和 policy 通过有界 digest/配置行进入现有 systemPromptHash，actual resume 另核对 header model/cwd，不改 Session v1/v2 schema。聚焦测试 12 files / 190 passed；全量 126 files / 1456 passed / 2 skipped，`typecheck`、`lint`、`npm run build -- --noEmit` 与 diff check 全绿。修复首轮 P1/P2 后，独立提交门为 GO（P0=0、P1=0、P2=0、P3=1），代码提交为 `9d53d1a`；P3 是已披露的 ignored `dist/` 历史误覆盖。

Sessions search 实现检查（2026-08-17）：`jarvis sessions search <query> [--json]` 为跨 session 只读线性扫描（不建数据库/索引），匹配 metadata（id/cwd/model）与 append-only user/assistant 文本，复用 Recall 的 `projectSessionHistory` 投影与 `redactHistoricalText` 脱敏；system/reasoning/tool 参数/tool 输出不进入搜索，fail-closed 损坏 session 只列入 `skipped[]` 不搜内容并 exit 7，malformed-tail 可搜标 partial。query 1–200 字符、每 session ≤20 条、全局 ≤100 条、excerpt 为 320 字符窗口（外加省略号标记），截断经 `truncated`/`truncatedSessions` 声明；JSON 无 ANSI、schemaVersion 1、observation-only，不加载 provider、无完成授权。独立提交门两轮 GO（P0=0、P1=0、P2=0、P3=3 已披露）；首轮唯一 P2（Unicode case-fold 扩码单元导致 excerpt 窗口偏离命中词）经 recall 共用 `matchExcerpt` 修复并有 `İ`×300 触发测试，此时 excerpt 取自折叠后字符串、文案为小写，属有意取舍；P3 为 secret 形态 query 以脱敏后形式参与匹配、`matchedSessions` 只计有展示 match 的 session、excerpt 实际长度为窗口加省略号标记。聚焦 sessions-search 11/11、sessions+recall+jarvis-cli 回归 79/79、recall+search 组合 28/28；全量 140 files / 1607 passed / 2 skipped，唯一间歇失败是既有 `loop-finalize-cli-smoke` 5 秒默认超时在本机全量负载下的 flake（聚焦 20/20 通过，与本切片无关）；`typecheck`、`lint`、`npm run build -- --noEmit`、`git diff --check` 全绿。代码提交 `8818d9b`（切片）、`7f9030d`（P2 修复）、`f10ec65`（复核卫生项）。

Sessions 筛选/排序/分页实现检查（2026-08-17）：决策层为纯函数 `src/surfaces/cli/sessions-query.ts`（旗标校验不合法即 exit 2；filter → sort → paginate），`sessions list` 获得 `--format/--integrity/--resume` 筛选、`--sort modified|started|id` + `--order` 排序、`--page/--page-size` 分页（页码 1 起、页大小 1–200，`--page` 单独给时默认 50）；`sessions search` 获得 `--format/--integrity` session 级筛选（被滤掉的 session 仍做损坏校验但不搜内容、不计入 scannedSessions）与 matches 分页，扫描保持文件名升序不设 sort 旗标，保证全局 100 上限的收集集合可预测。损坏可见性不可筛选：list 的 exit 7 与 search 的 `skipped[]` 永远基于未筛选全集。不带旗标时 text/JSON 与父提交逐字节一致（Reviewer 临时 worktree 对比验证），JSON 仅 additive 演进（`selection` 回显），schemaVersion 不变。独立提交门 GO（P0=0、P1=0、P2=0、P3=3 已披露：search 分页时标题行 match 数为当页、session 数为总数（selection 行消歧）；前导零数字被接受；天文数字页码的 `(page-1)*pageSize` 乘积不精确但 slice 收敛为空集）。聚焦 selection 9/9、sessions 组合 85/85；全量 141 files / 1617 passed / 2 skipped 零 flake；`typecheck`、`lint`、`npm run build -- --noEmit`、`git diff --check` 全绿。代码提交 `07a2951`。

Session mutation 实现检查（2026-08-18）：写状态首切片，语义经 Ludi 事先拍板。`sessions fork` 为全量复制含 receipt（receipt 结构不含 session id，复制后哈希保持有效；v2 header 重写新 id 并记 additive `forkedFrom` 血缘；pending tool effect、partial composition、fail-closed 损坏全部拒绝）；`sessions rename` = fork 新 id + 归档原会话（零删除、零原地 header 改写；fork 成功而归档失败时返回 honest `partial`）；`sessions archive|unarchive` 在 `data/sessions/archived/` 间移动（内容不动、移动后指纹校验、checkpoint audit 随同移动、pending 仅告警）。每次 mutation 先 `planned` 后 `created/failed/blocked` 落 append-only `data/session-mutations.jsonl`（confinement 与 checkpoint audit 同款；损坏/截尾日志拒绝追加）。`resolveSessionFilePath` 增加可选 `scope: 'archived'`，默认 active 行为不变（Reviewer 逐行对比验证）；`list --archived`、`show` 归档回退 + `forkedFrom` 展示为 additive；resume 解析链不学归档查找。漂移（preview→write 间篡改）与活体 writer（移动后源路径复现）均有触发路径单测。独立提交门 GO（P0=0、P1=0、P2=0、P3=5 已披露：fork 副本不含 crash-truncated tail 字节（源保留）且报告未披露该排除；check-to-rename TOCTOU 在 Windows 响亮失败；pre-write 拒绝不进 audit；fork 的 created 追加失败记 failed(exit 5) 而 move/rename 为成功+warning 的不对称；跨进程并发 append 可致 seq 重复后所有 mutation fail-closed——均响亮非静默）。单元 13/13、e2e 7/7、回归 117/117；全量 143 files / 1637 passed / 2 skipped（Reviewer 复跑一致）；`typecheck`、`lint`、`npm run build -- --noEmit`、`git diff --check` 全绿。代码提交 `e398f86`。

终端 human review 实现检查（2026-08-18）：`review list|show|approve|reject` 落地（`src/surfaces/cli/review.ts`），能力层 `capabilities/goal/human-review.ts` 零改动——parked 探测（goal blocked + 末轮 couldNotVerify + human-route 需求）、decision 归一化、`decideVerdict` 重算、goal/loop 日志追加与 `data/human-reviews/` 审计全部复用。list/show 为 observation-only；approve/reject 一次裁决一条需求（`--requirement` + 必填 `--note` + 可选 `--reviewer`），authority 标 `human-review`，完成授权只来自结果里记录的 decideVerdict 输出。首轮独立 Reviewer NO-GO 抓到 P1（裁决落盘后全目录重算剩余数在兄弟日志损坏时把已记录误报 exit 7），修复为重扫失败只降级 `remainingParked`→`remainingUnknown: true`，目标自身损坏仍 exit 7 一字节不动；二轮复核 GO（39 项对抗探针全过，含 llm-route 伪造 human 前缀不进 pending、注入/超长截断、重复裁决 exit 2）。披露：loop 日志损坏时 goal 完成但 loop finish 缺失需人工修复（能力层既有窗口，本切片不碰）；exit 7 映射基于错误消息子串（构造上脆弱，当前无误判路径）；`remainingParked` 与 `remainingUnknown` 二选一。e2e 9/9、回归 69/69；全量 144 files / 1645 passed / 2 skipped（唯一失败为既有 sessions-cli 设备名用例的 10 秒子进程超时 flake，聚焦 22/22 通过）；`typecheck`、`lint`、`npm run build -- --noEmit`、`git diff --check` 全绿。代码提交 `0a3aed1`（切片）、`a0699d9`（P1 修复）。

Shell completion 实现检查（2026-08-18）：`jarvis completion powershell|bash|zsh` 落地（`src/surfaces/cli/completion.ts`），单一静态命令表驱动三个 shell 生成器；v1 补全顶层命令、组子命令与全局旗标，命令级旗标留在 --help。防漂移双向交叉核对（命令表 ↔ 根/组 --help，含 Options 段全局旗标），开工即抓到表漏 `rewind`；bash COMP_WORDS 编程式调用与 PowerShell TabExpansion2 真实调用实证子命令与前缀过滤（两级定位 bug 由此抓到修复）；zsh 本机无运行时未实跑。独立提交门两轮 GO（P0=0、P1=0；P2-1 旗标核对自指已修；P2-2 为既有 sessions-cli 全量负载超时 flake 提醒，与本切片无关）。P3 披露：假想含引号表项无转义、`chat` 别名不进补全、PowerShell 第三词位回退文件名补全、`shadow` 排除项静默漂移窗口、zsh 未实机验证。e2e 5/5、回归 jarvis-cli 43/43；全量 145 files / 1651 passed / 2 skipped；`typecheck`、`lint`、`npm run build -- --noEmit`、`git diff --check` 全绿。代码提交 `05f4ae1`（切片）、`ced7a90`（旗标核对加固，纯测试）。

Stop 实现检查（2026-08-18）：`jarvis stop [--reason <text>]` / `jarvis stop --clear` 落地（`src/surfaces/cli/stop.ts` + jarvis 接线），给既有 workspace emergency-stop 控制通道补 CLI 生产端。`runtime/control/emergency-stop.ts` 通道本体与 goal/loop/cron/cron-daemon 四个消费者的时间门控轮询零改动；stop 复用原子写 + append-only 审计并写后回读校验，clear 只删控制文件、不写审计。workspace 全局语义经 Ludi 拍板：不接 per-id（位置参数 id exit 2 并说明；按 id 定向停需改通道形状，真实需求出现另开切片）；authority 标 `control`、无完成授权；默认 reason `CLI emergency stop` 由 CLI 层显式传入（Reviewer P2：help 宣称与通道默认值不一致，修复并补断言）。P3 披露：reason 无长度上限（通道既有，argv 为事实上界）、空 reason text 报告显示 `-`。e2e 8/8，含真实 cron-daemon 急停端到端与 stop 后新运行不受影响的时间门控验证（cron map 置工作区外规避 repo-controlled config 拒绝路径）；全量 146 files / 1659 passed / 2 skipped 零失败；`typecheck`、`lint`、`npm run build -- --noEmit`、`git diff --check` 全绿。代码提交 `277362f`（切片）、`c3cc198`（P2 默认 reason 修复）。

## 5. R2：增强行模式与全屏 TUI

行模式和 TUI 共用 AgentLoop、EventBus、PermissionGate、SessionStore 与状态定义。TTY 默认可选择 TUI；`--no-tui` 和非 TTY 永远走行模式/headless，确保故障时有可靠回退。

代码基线已包含纯 reducer、EventBus action adapter、bounded TUI action audit、surface selector 与全屏 renderer。状态覆盖 `idle/model-running/tool-running/approval-pending/stopping/needs-human/closed`；queue、redirect、approval deny、Esc、双 Ctrl-C、EOF 与 pending-effect 停止均有触发测试。`--headless` 固定 machine surface，非 TTY、`--no-tui` 或 renderer 不可用时回退 line REPL。Ludi 的真实 TTY 视觉与键位体验验收暂缓；renderer 无权改变 reducer、Session、PermissionGate、checkpoint、AgentEvent 或完成授权。

全屏 TUI 首版区域：顶部运行身份与验证等级；中央对话/事件流；右侧 context、diff、预算和待审批；底部输入与快捷键。长工具输出折叠并保留耗时、退出码和日志路径。Esc 停止当前模型/工具，Ctrl-C 第一次停止、第二次退出；mid-turn 输入可排队或 redirect，动作须进入审计。

当前 TUI 接受 `/exit`、`/quit`、`/checkpoint` 与 `/redirect <text>`；其余候选交互只有出现真实需求并补齐合同后才进入帮助。

## 6. Checkpoint / rewind 合同

现有 SessionStore 的 compaction checkpoint 继续保持原语义。用户可回退的 checkpoint 使用独立记录类型，避免把上下文压缩快照误当文件恢复点。

- 每个用户 prompt 前、每次模型写入波次前创建 checkpoint；记录 checkpointId、sessionId、时间、消息 cursor、cwd、ShadowGit snapshot 引用和不可逆副作用摘要。
- 默认 rewind 只回退对话与上下文。`--files` 需要先展示 diff、目标 checkpoint 和不可逆副作用，再经显式确认恢复文件。
- 文件恢复复用 ShadowGit 的审计历史与受控 apply，不使用 `git reset --hard`，不覆盖未纳入 checkpoint 的并发改动。
- 网络请求、数据库写入、push、发消息、凭据变更等外部副作用不能回退；TUI 必须明确列出。
- rewind 只改变会话/工作树状态，不产生 verified/complete；每次操作追加 audit record，可继续从回退点 fork 新会话。

验收：checkpoint 可在崩溃后枚举；conversation-only rewind 不碰文件；files rewind 在 dirty/concurrent drift 时 fail-closed；PowerShell 与空格路径通过；TUI、行模式、未来 GUI 展示同一条审计事实。

当前基础切片已按 `docs/checkpoint-tui-contract.md` 落地。`jarvis run/resume` 在用户消息追加前与 provider wave 前写独立 append-only checkpoint，`/checkpoint` 提供手动点；audit 写失败会在 provider/tool I/O 前终止。`jarvis checkpoints list|show` 保持 observation-only；`jarvis rewind` 双重校验来源字节并创建新 v2 Session，来源日志保持原样。纯文本 assistant 的历史 `requestId` 不进入 fork；含 tool message 或 tool-bearing assistant 的 receipt-bound checkpoint 直接标记不可 rewind，避免复制或伪造 request/tool receipt。

`--files` 使用 harness-owned ShadowGit preflight、完整 40 字符 ref、bounded exact path set 与确认后 drift 复核。受保护/凭据路径、link-like tree entry、hard-link、junction/reparse、仓库本地 hook、external diff helper 和不一致 post-state 全部 fail-closed；命令从不调用 `git reset --hard`，恢复失败保留 preflight。普通的 project-ignored 文件通过两次 `--ignored` 清单差集 + 显式分批 `add -f` 强制捕获并参与 drift/restore，shadow 自身的 structural/secret 排除保持唯一边界，inventory 中被 project `.gitignore` negation 暴露的受保护路径直接 fail-closed；rewind 对「磁盘仍存在的 project-ignored 删除项」要求 target 带捕获标记，无标记的旧式 ref 无法证明缺失语义时拒绝删除，手动移除后放行。网络、数据库、push、消息与其他外部副作用只做保守摘要，不能被宣称已回退。

实现门禁（2026-08-16 修复 Reviewer P1 后）：project-ignored 捕获/drift/防误删/negation/真实 CLI 路径共 6 个新触发测试，修复前 RED 为 5 failed / 35 passed；聚焦 ShadowGit + checkpoint CLI 40 passed，组合 10 files / 105 passed；全量 134 files / 1538 passed / 2 skipped。`npm run typecheck`、`npm run lint`、`npm run build -- --noEmit`、全量 `npm test` 与 tracked/untracked whitespace 检查已通过；修复后独立 Reviewer 复核 GO（P0=0、P1=0、P2=0、P3=4，P3 清单见 `docs/handoff-next.md`），提交 SHA 见 `docs/handoff-next.md` 的最新收口记录。

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
