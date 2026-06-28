# 持久化段方案 · append-only JSONL + 断点续跑

> Phase B 之后的「持久化段」（phase-B-plan §1 决策 5 / §6 推迟项，到此段拍定）。
> 状态（2026-06-28）：Phase B 全完成（B1–B6 ✅）。本段已绿灯，**一项定调决策**：shadow-git 本段不做，推迟到 Phase D 无人值守长跑真需要自动回滚时再上；本段只做 **append-only JSONL 会话日志 + 断点续跑**（用户拍板）。

## 0. 目标（一句话）

让会话状态**落盘且可续跑**：crash / 退出后 `npm run dev -- --resume` 能重建对话并接着跑。日志 append-only、crash 安全、人类可读、无 schema 锁定（单人维护友好）。

A 阶段对话只在内存（退出即丢）；本段补上那道持久化，为后续无人值守长跑（Phase D）打底。

## 1. 关键决策

| # | 维度 | 决策 | 理由 |
|---|---|---|---|
| 1 | 范围 | append-only JSONL 会话日志 + 断点续跑；**不做 shadow-git** | 核心价值是续跑，只需日志；shadow-git（每步工作区快照/回滚）是另一块，bash 成工具后半套方案会漏 bash 改动、要做就得完整独立 git 仓，操作重，推迟到 Phase D 真需要自动回滚时再上 |
| 2 | 存什么 | 落 `messages`（真实对话），不靠 EventBus 事件重建 | 事件 ≠ 消息（assistant 由 delta+tool_calls 拼、reasoning 等会丢）；直接落消息最忠实 |
| 3 | 压缩怎么处理 | 压缩时记一条 `compaction` 全量快照，重放时重置到它 | append-only 改不动早先行；全量快照让重放简单正确（压缩后数组本就被压小，快照不贵） |
| 4 | crash 安全 | 每条记录一次 append；读时跳过解析失败的（尾）行 | 崩溃只会截断最后一行；跳过它即恢复到最后完整记录 |
| 5 | 不做 | shadow-git / SessionStore 之外的 SQLite / schema 迁移 / 多会话并发 | 反过度工程；JSONL 自解释易备份，单人够用 |

## 2. 架构落点（怎么嵌进 A/B）

```
runtime/  SessionStore ………… 新增：append-only JSONL 写/读 + 重放（纯函数）
core/loop run-agent …………… 注入式 store?：每轮 sync 追加新消息、压缩后 checkpoint
surfaces/ cli ………………………… --resume：重放历史 → 继续 REPL；默认新会话
```

- 注入式 `store?`（像 A 的 `context?` / B 的 `gate?`）：不传 = 老行为（纯内存），现有测试不动。
- 持久化逻辑集中在 store：`sync(messages)` 按 cursor 追加超出部分；`checkpoint(messages)` 记压缩全量快照 + 重置 cursor。run-agent 只在对的位置调它。
- `data/sessions/<id>.jsonl`（`data/*` 已 gitignore）。

## 3. 模块设计

### 3.1 SessionStore（runtime/session）
- **记录类型**（每行一个 JSON）：`{t:'session', id, model, cwd, startedAt}`（头）/ `{t:'message', message}` / `{t:'compaction', messages}`。
- **纯函数**：`parseSessionLog(text)`（按行 parse、跳坏行）；`replayMessages(records)`（折叠回 `{messages, header}`：message→push、compaction→替换全量）；`serializeRecord`。
- **FileSessionStore**：`sync` / `checkpoint`（appendFile + cursor）；`writeHeader`。
- **loader**：`loadSession(path)`（读+重放）；`latestSessionPath(dir)`（按 mtime 取最近，供 `--resume` 无 id）。
- 验证：round-trip（写→读→消息一致）；compaction 重放（压缩后续跑状态正确）；crash 安全（尾行截断→跳过、恢复到上一条）。

### 3.2 run-agent 接线
- `AgentContext.store?: SessionStore`。
- 每轮：no-tool 终止前 `sync`；有 tool 那轮 tool 结果入栈后——压缩了→`checkpoint`，否则→`sync`。
- store 缺省 = 不持久化（A/B 老行为）。
- 验证：跑一轮带 store → 日志含 user/assistant/tool 记录；压缩 → 日志含 compaction。

### 3.3 CLI --resume（surfaces/cli）
- `npm run dev` = 新会话（新 id + 文件 + 头）。
- `npm run dev -- --resume` = 重放 `data/sessions/` 最近一个；`--resume <id>` = 指定。
- 重放后 banner 提示「resumed <id>（N 条消息）」，用重放的 `messages` 接着跑（不再重新 seed system）。
- 验证：跑一会话→“崩”（进程退出）→ `--resume` → 历史在、能继续。

## 4. 里程碑

| 里程碑 | 内容 | 走到这能验证 |
|---|---|---|
| **P1 SessionStore** | 记录类型 + 纯函数（parse/replay）+ FileSessionStore + loader，单测（round-trip / compaction / crash 安全） | 日志写得出、读得回、消息一致；坏尾行被跳过 |
| **P2 续跑接线** | run-agent `store?` 接线 + CLI `--resume`（最近/指定）+ 集成测试 + 真 resume 冒烟 | 工具循环落盘；`--resume` 真能续上一会话 |
| **P3 收口** | 验收清单 + 文档（handoff/AGENTS）+ 清理 + 独立验收核查 | 验收全绿、续跑可观测可复现 |

节奏沿用 A/B：纯函数 → 实现 → 接线 → 四关卡（typecheck/lint/build/test）→ demo/冒烟 → commit。本段非安全关键，不必对抗核查；收口做一次独立验收（裁判≠运动员）。

## 5. 验收契约

1. **round-trip**：写入一串消息 → 读回重放 → `messages` 逐条一致。
2. **compaction 重放**：压缩后续写 → 重放得到压缩后的正确状态（不含被压掉的早先行）。
3. **crash 安全**：日志尾行被截断（半截 JSON）→ 重放跳过它、恢复到上一条完整记录，不抛。
4. **工具循环落盘**：带 store 跑一轮含工具的对话 → 日志含 user/assistant/tool_result 记录。
5. **断点续跑**：会话 A 跑几轮 → 进程结束 → `--resume` → 历史消息在、模型看到完整上下文、能继续。
6. **不传 store = 老行为**：现有 A/B 测试不变（注入式可选）。

防作弊：crash-安全测试要用**真截断的尾行**触发跳过分支（非空测）；resume 冒烟要**真起两个进程**（写一个、读另一个），不在同进程内自证。

## 6. 不做（边界）

- ❌ shadow-git（工作区快照/回滚）→ 推迟到 Phase D。
- ❌ SQLite / 二进制格式 / schema 版本迁移 → JSONL 自解释够用。
- ❌ 多会话并发 / 会话分支 / 远程同步 → 按需才建。
- ❌ 把 tool-results 落盘改造（A3 已有 `data/tool-results/`，沿用）。
