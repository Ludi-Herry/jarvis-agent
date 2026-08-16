# GPT-5.6 Sol Pro CLI 可信性复核：采纳、修正与落地结果

> 状态：2026-08-15 收口。外部复核基于打包材料完成，无法直接读取仓库或运行测试；本文用当前源码与本地验证结果校准其建议。原始回答保存在本机 Codex attachment，未全文复制进仓库。

## 1. 最终裁决

| 问题 | 当前裁决 | 依据 |
|---|---|---|
| DeepSeek Harness、Cordis、Pi、dsh-slice 的采用边界 | 有条件 GO | 只吸收轨迹、Recall、Preset 心智和评测方法；不接入外部 runtime |
| R0 / R0.5 可信性实现 | GO | R0.5 独立终审第三轮 P0=0、P1=0、P2=0；sessions 与动态恢复独立提交门终审 P0=0、P1=0、P2=0、P3=1；全量检查为 119 files / 1334 passed / 2 skipped |
| 直接发布 v0.1 CLI beta | NO-GO | 机器事件协议、A0 冻结 corpus、当前 Session Recall 与 typed config 已闭环；A0 runner/真实运行、Recall A/B、完整 Windows 契约与真实任务证据仍未闭环 |
| 全屏 TUI、checkpoint/rewind | v0.2 基础切片已落地 | checkpoint/rewind、纯 reducer、action audit 与可靠 fallback 已通过本地门禁；全屏 renderer 仍待独立切片 |

Sol Pro 原始回答最重要的价值，是把“文件写入成功”和“崩溃后能安全恢复”提升到发布前信任门槛。这个判断已经落实到 R0.5；此前完成的 verdict、deadline、退出码和 JSONL integrity 无需重开。

## 2. 原始建议的高价值部分

1. `expectedVersion/createOnly` 提升为 P0，并让执行层记录副作用收据。
2. Session 能力拆成最小可信恢复合同与后续产品能力；rename、archive、跨会话搜索后移。
3. Recall 进入 v0.1，范围固定为当前 Session、只读、显式调用、历史低权威；旧文件事实必须重新 `read`。
4. A0 增加请求可重建率、孤儿副作用、无收据 attempt、陈旧 Recall 行动等指标。
5. Headless 先冻结一条机器事件协议；静态汇总可从事件派生。
6. DSH/Cordis/Pi 整套 runtime、dsh-slice loop、bounded slice 默认路径继续排除。
7. DeepSeek V4 Provider 只做 opt-in spike，正式保留依赖同一 corpus 的成本、时延和可信完成对照。

## 3. 已经落地的 R0.5

| 信任问题 | 当前实现 |
|---|---|
| stale overwrite | `read` 返回 `fv1` token；更新要求 `expectedVersion`，创建要求 `createOnly:true`，成功返回 `postVersion` |
| 同进程与创建竞态 | 目标路径串行化、exclusive create、同目录临时文件与 rename 前复核 |
| 不安全文件形态 | symbolic-link leaf 与已有多 hard-link 文件拒绝替换 |
| 副作用前崩溃 | assistant tool intent 与 `planned` 收据先持久化 |
| 副作用后崩溃 | runner 终态立即写 `committed`；不确定结果写 `unknown` 并 halt |
| 恢复误重放 | pending、unknown、receipt/identity/projection 矛盾、mixed v1/v2、seq gap、composition drift 全部 fail-closed |
| compaction 抹除孤儿 intent | append-only 历史 intent 与 request identity 独立对账，checkpoint 无法隐藏未决执行 |
| merge 误授权 | `loop:finalize` 对 legacy v1 coverage 或 pending tool effect 直接 park |
| 动态来源漂移 | v2 header 记录 resolver ID 与 manifest hash；REPL 使用 `skill-registry-v1`，goal/loop 使用 `none-v1` |
| 历史 addendum 矛盾 | resume 按每个 `runId` 的首次 durable user message 重算 addendum 并核对 request receipt；歧义或不一致 fail-closed |
| Session 选择越界 | show 与实际 resume 复用窄 ID/路径边界；设备名、separator/traversal、absolute/namespaced path、symlink/junction/reparse escape 与 filename/header mismatch 全部拒绝 |
| 终端输出伪造 | 人类 text 对所有不可信 Session/resume 字段及 REPL/loop 错误做单行净化；JSON 只使用标准 JSON 转义 |
| 观察面过度承诺 | `sessions show` 只报告 `ready-for-resume-check`；实际 resume 完成当前 composition/addendum 比较后才报告 exact compatibility |
| 读取错误误分类 | 只有明确 `ENOENT` 进入 not found/exit 2；其他不可读状态进入 partial/exit 7 并保留错误类型 |
| 路径并发替换 | 静态 symlink/junction/reparse 与 canonical escape 全部拒绝；同用户恶意进程在 check-to-read 窗口主动替换路径属于已记录 P3，待 threat model 纳入 hostile local writer 后再做 file-handle binding |

边界保持明确：version token 提供 managed file tool 的检查点一致性。外部编辑器、另一个 Jarvis 进程、已批准 bash，以及最终检查到 rename 的极窄窗口仍缺少通用跨进程 CAS。无法确认 post-state 时进入 `unknown`，不能生成 final 或完成授权。

## 4. 对 Sol Pro 方案的修正

### 4.1 通用 MutationExecutor 暂缓

当前可自动写文件的受管入口只有 built-in `write`。严格前置条件、收据和路径复核直接落在现有 `src/core/tools`，能关闭实际旁路，也能继续复用 PermissionGate。引入新的 mutation framework 会扩大接口、测试矩阵和维护面；真实出现第二类受管 mutation 后再评估。

### 4.2 精确 canonical request blob 暂缓

R0.5 保存 base composition、消息与工具 schema 的哈希/数量、request identity 和工具执行收据。后续 dynamic composition 切片又增加版本化 addendum 来源、manifest hash 与 resume-time request 核对。完整请求正文进入独立 blob store 会扩大秘密保留时间、脱敏、加密、导出、垃圾回收和损坏恢复范围。当前 fail-closed 合同已经能处理 Skill manifest 漂移、旧 v2 provenance 缺失、激活消息歧义与 receipt 不一致。

重开精确 blob 的证据门槛：出现一次真实事故，证明现有 Session v2 与请求收据无法还原关键模型输入，并且该事故无法通过版本化 addendum provenance 解决。

### 4.3 本轮不打内部 tag

tag 容易被理解为发布准备完成。v0.1 仍有明确 blocker，本轮只建立本地 commit 基线与验证证据。达到 beta 发布门槛后再创建版本 tag。

### 4.4 提交采用两段式

R0、R0.5 与统一 CLI 改动共享 SessionStore、runAgent、CLI composition root 和测试。事后强拆三段会产生难以独立编译或验收的中间提交。本轮采用：

1. 一个完整代码/测试提交，覆盖可信执行、Session v2 与统一 CLI shell；已落为 `a814889`（`feat: harden session resume and inspection`）。
2. 一个文档/交接提交，覆盖裁决、计划、ZCode 任务包和当前状态。

每次只暂存精确路径，提交前检查 staged stat；不创建 tag，不 push。

### 4.5 v0.1 产品面继续收窄

- 保留现有人类 text 输出，先冻结一条 versioned JSONL agent-event contract；静态 JSON 由消费者聚合。
- preset 首批只实现 `inspect` 与 `safe`；`maintain` / `worktree` 等 A0 证明用户目标差异后再加入。
- `stop`、`review`、completion、session rename/fork/archive 属后续产品化，不进入最小可信 beta 关键路径。
- Recall 进入 v0.1，但要先冻结机器事件和 A0 基线，确保注入、陈旧事实和成本变化可以量化。
- checkpoint/rewind、TUI reducer 与 fallback 已进入 v0.2 基础切片；全屏 renderer 保留为后续独立适配器。

## 5. 当前采用顺序

1. 固化本轮代码与文档基线。
2. [x] 交付只读 `sessions list|show`。
3. [x] 收口动态 composition/addendum 的 resume 比较、来源展示与可行动提示。
4. [x] 冻结 versioned headless JSONL、A0 strict types、六案 corpus 与纯 report；代码提交 `b5588ff`，提交门及 P2 窄复核 GO（P0=0、P1=0、P2=0、P3=1）。
5. [ ] 实现 A0 只读 runner，并生成不可变 model/prompt policy manifest 与 observations artifact。
6. [x] 增加 REPL 当前 Session 的 `history_search/history_turn`；host-bound、append-only、bounded、historical-low，`--no-recall` 保留旧 composition exact resume。代码提交 `81f96e0`，独立提交门 GO（P0=0、P1=0、P2=0、P3=1）。
7. [ ] 用 Recall 开关跑同形对照；当前 fixture/E2E 只证明合同与隔离，尚未证明任务收益。
8. [x] 增加 typed config、有效来源展示与 `inspect/safe`；三层 TOML、项目只收紧、凭据拒绝、环境 endpoint identity、原型继承键拒绝、真实 gate 与 resume composition 已覆盖。代码提交 `9d53d1a`，修复首轮 P1/P2 后独立提交门 GO（P0=0、P1=0、P2=0、P3=1）。
9. 运行 10–20 个真实同形任务，要求零 false-verified、零无限等待、零 orphan side effect。
10. [x] 完成 v0.2 的用户 checkpoint、conversation fork、受控文件 restore、TUI reducer/action audit 与 line/headless fallback；纯全屏 renderer 仍待后续切片。
11. A0 稳定后再做 DeepSeek V4 Provider opt-in spike。

权威计划见 `docs/cli-first-plan.md`；ZCode/GLM-5.3 的有界任务包见 `docs/handoff-zcode-glm53.md`。

## 6. 保持不变的硬边界

- `decideVerdict` 继续是 goal 完成授权入口；Session、Recall、EventBus、observe、TUI 和 GUI 都没有完成授权。
- 现有四套可信 map 是上限，不增加 verifier、route 或 scheduler 抽象。
- PermissionGate、OS sandbox 和人工审批继续拥有副作用边界；Recall 和历史记录不授予权限。
- 未决副作用不自动重放；损坏或语义不完整的状态按 exit 7 / needs-human 收口。
- DSH、Cordis、Pi 与 dsh-slice 只提供设计证据和离线实验假设，不成为 Jarvis runtime 依赖。
