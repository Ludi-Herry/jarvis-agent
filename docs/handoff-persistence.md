# 交接：持久化段完成（P1–P3，2026-06-28）

给接手者。本段在 Phase B 之后做：**会话落盘 + 断点续跑**。完整设计见 `persistence-plan.md`；Phase B 见 `handoff-B.md`。

## 一句话状态

**持久化段完成**：会话以 append-only JSONL 落盘，crash/退出后 `npm run resume` 能重建对话并接着跑。`npm run typecheck / lint / test / build` 全绿（**297 测试**），断点续跑经**真·两进程**冒烟验证（进程 A 告知事实并退出 → 进程 B `--resume` 答得出）。**shadow-git 本段不做**（用户拍板，推迟到 Phase D 无人值守长跑真需要自动回滚时再上）。

## 架构一句话

注入式 `store?`（像 `context?`/`gate?`，不传 = 老的纯内存行为）。持久化逻辑集中在 SessionStore：`sync` 按 cursor 追加超出的消息、`checkpoint` 在压缩后记全量快照。落的是**真实 `messages`**（不靠 EventBus 事件重建——事件会丢 reasoning/拼装细节）。重放是**纯函数**，crash 安全靠「读时跳过解析失败的尾行」。

## 里程碑（含 commit）

| 里程碑 | commit | 内容 |
|---|---|---|
| 段方案 | c881269 | 持久化段设计 + 定调（shadow-git 推迟） |
| P1 SessionStore | 63ac5fd | 记录类型 + 纯 `parseSessionLog`/`replayMessages` + `FileSessionStore`(sync/checkpoint) + `loadSession`/`latestSessionPath` |
| P2 续跑接线 | 3431302 | runAgent `store?`（每轮 sync、压缩 checkpoint）+ REPL 续跑 + CLI `--resume` + `npm run resume` |
| P3 收口 | （本提交） | 验收 + 文档 + 独立核查 |

## §5 验收契约 → 证据（全绿）

| §5 条目 | 覆盖 |
|---|---|
| 1 round-trip | `session-store` "round-trips messages" |
| 2 compaction 重放 | `session-store` "compaction replay…" + `run-agent` "checkpoints a compaction…" |
| 3 crash 安全（真截断尾行） | `session-store` "crash safety: a truncated/garbage trailing line is skipped" |
| 4 工具循环落盘 | `run-agent` "persists every message the loop produces (user/assistant/tool)" |
| 5 断点续跑 | `repl` "resumes a session: a fresh REPL replays history…" + **真两进程冒烟**（Hanako/4724） |
| 6 不传 store = 老行为 | `run-agent` "does not persist when no store is given" + 全部既有 A/B 测试不变 |

防作弊：crash-安全测试用**真半截 JSON 尾行**触发跳过分支；续跑用**两个独立进程/store**（写一个、读另一个）验证,非同进程自证。

## 关键决策

- **范围 = JSONL 日志 + 续跑，不做 shadow-git**（用户拍板）。bash 成工具后「只快照 write 改的文件」会漏 bash 改动；要么完整独立 git 仓（重），要么推迟——选推迟，回滚先靠用户自己的 git + 日志。
- **落消息不落事件**：忠实、重放简单。
- **压缩 = 全量快照重置**：append-only 改不动早先行，快照让重放正确且简单。
- **crash 安全 = 跳坏尾行**：崩溃只截断最后一行，跳过即恢复。

## gotcha

- **`npm run dev -- --resume` 在 PowerShell 下不通**：npm 把 `--resume` 当自己的配置吞掉。用 `npm run resume`（脚本定义里带 `--resume`）；指定 id 用 `npx tsx src/surfaces/cli/index.ts --resume <id>`。
- **会话文件在 `data/sessions/*.jsonl`**（`data/*` 已 gitignore，不入库）。新会话 id = ISO 时间戳（冒号/点换成连字符，文件名安全 + 可排序）。
- **resume 用日志里的 system 消息**（不重新 seed），忠实于该会话；新会话才用当前 `SYSTEM_PROMPT`。
- **`latestSessionPath` 按 mtime 选最近**；续跑后该文件被追加 → mtime 更新 → 下次 `npm run resume` 仍指它。
- **PowerShell 管道喂中文 stdin 会变 `?`**（控制台编码 artifact，非产品 bug）——冒烟用 ASCII 或在真终端手测。
- 压缩中途模型失败**已在 Phase C6 硬化**：summarizer 失败跳过本轮压缩、不丢已完成的 turn，abort（Ctrl-C）仍传播中断。

## 关键文件

```
src/runtime/session/session-store.ts   # 记录类型 + 纯 parse/replay + FileSessionStore + loader
src/core/loop/run-agent.ts             # store? 接线：每轮 sync、压缩 checkpoint
src/surfaces/cli/repl.ts               # 续跑 seed + 用户消息即时落盘 + 传 store 给 runAgent
src/surfaces/cli/index.ts              # --resume [id]：load 最近/指定 → 继续；新会话写 header
test/runtime/session-store.test.ts     # 纯函数 + 文件 store + crash 安全 + latest 选择
data/sessions/<id>.jsonl               # 运行期会话日志（gitignore）
```

## 怎么运行 / 验

- 新会话：`npm run dev`（每轮自动落盘到 `data/sessions/`）。
- 续跑：`npm run resume`（恢复最近）；`npx tsx src/surfaces/cli/index.ts --resume <id>`（指定）。
- 四关卡：`npm run typecheck / lint / test / build`。

## 下一步

- **Phase C**（多 agent / SubagentManager，见项目记忆 `c-phase-agent-roster-two-axes`），或
- **shadow-git**（无人值守长跑的自动回滚，配合 Phase D 的 GoalLoop/Hooks 再上：完整独立 git 仓快照工作区）。
- 压缩容错硬化（A 遗留）已在 **Phase C6** 顺带做掉（run-agent 压缩调用 try-catch；见 `handoff-C.md`）。
