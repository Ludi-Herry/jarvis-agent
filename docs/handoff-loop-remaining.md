# Loop 剩余重项交接：finalize cleanup / cron daemon

> 状态：2026-07-02 收尾交接。当前 main 已完成 mid-goal resume、per-goal verifier、per-goal hook runner、parallel worktree first slice、parallel resume 最小 slice、loop finalize 只读报告、loop finalize `--merge` 交互 apply、cron single-scan first slice。本文只交接剩余两项：finalize cleanup、完整 cron daemon。

## 先读

1. `README.md`：全景、命令、当前脚本。
2. `docs/handoff-codex.md`：硬不变量、同族自审盲区、红线。
3. `docs/handoff-next.md`：Phase E 全景和 GUI 就绪盘点。
4. `docs/superpowers/plans/2026-07-02-cron-daemon-plan.md`：cron daemon 计划和失败模式测试清单。
5. 相关源码：
   - `src/surfaces/cli/loop-cli.ts`
   - `src/surfaces/cli/loop-args.ts`
   - `src/capabilities/goal/loop.ts`
   - `src/capabilities/goal/parallel-loop.ts`
   - `src/capabilities/goal/loop-store.ts`
   - `src/capabilities/goal/loop-worktree.ts`
   - `src/surfaces/cli/loop-resume.ts`
   - `src/capabilities/goal/loop-cron.ts`
   - `src/capabilities/goal/loop-cron-config.ts`
   - `src/surfaces/cli/cron-cli.ts`
   - `src/surfaces/cli/cron-args.ts`

## 当前基线

- `npm run loop -- <objectives>`：串行 loop，支持 `--resume`。
- `npm run resume:loop -- --verifier-map <trusted-json> --hook-map <trusted-json>`：恢复最近 loop；恢复时仍必须显式传 cwd 外可信 verifier/hook map。无 per-goal verifier/hooks 时也用可信空 map `{"goals":[]}`。
- `npm run loop -- <objectives> --parallel 2..4 --worktree-root <cwd外dir>`：fresh queue 可并行跑。`--resume --parallel 2..4` 也可用，但必须由当前命令显式传 `--worktree-root <cwd外dir>`；in-flight goal 只恢复到既有 worktree，缺失 worktree / goal log / session header / cwd mismatch 均 fail-closed。
- `npm run loop:finalize -- --loop <id>`：只读 finalize report，汇总 logged verdict / worktree status / diff，并生成 merge proposal；不 cleanup。
- `npm run loop:finalize -- --loop <id> --merge`：交互式 apply，必须输入完整 `merge <loopId>`；执行前重新扫描，只合入 verified + tracked diff proposal；untracked / conflict / missing verdict / rejected / blocked 全部 park 或停下；不 cleanup。
- parallel worktree first slice：每个 goal 跑在 cwd 外 detached worktree；目标日志仍集中在 cwd `data/`；worktrees 保留给人工检查；不 merge、不删除、不 push。
- parallel 与 hooks 互斥：hook cwd 语义还没定义到 per-goal worktree，当前 `assertParallelHooksCompatible` fail-closed。
- `npm run cron -- --cron-map <trusted-json>`：单次扫描，到期任务触发普通 loop；task 必须 `unattended:true`；带同工作区 scan lock、stale recovery、task 前 heartbeat；不常驻。

## 不变量

- loop 永远没有完成授权。完成只来自 `runGoal` / `decideVerdict`。
- cwd 内 JSONL 可提供 queue / contract / goalId / replay seed，不能提供权限、trusted config、completion。
- resume 不能静默降级 verifier/hook 模式。恢复必须显式传 cwd 外可信 map。
- terminal complete 恢复必须重跑验收；active goal 恢复必须保留 turns/tokens/breaker/round budget。
- 不给 unattended bash 新增自动 allow。
- 不从 cwd 自动发现 hook/verifier/cron enforcement 配置。
- 不自动 push、不自动 rebase、不改 `.env`、不删用户工作产物。
- 所有架构级改动先写 plan，列红线和验证，再实现。

## 任务 1：并行 resume（最小 slice 已落地）

### 现状

`parallel-loop.ts` 已经接收 `inFlight` 并会把 `attempt.resumed` 传给 `runOne`。当前 CLI 已允许显式 `--resume --parallel N --worktree-root <cwd外dir>`，并在调度器写新 loop 记录前预检既有 worktree 与 goal/session log。缺失 worktree、session cwd mismatch、缺少 header 均 fail-closed。

### 目标

允许并行 loop 在 crash 后恢复，保持 first slice 的隔离语义：

- 每个 in-flight goal 回到对应 worktree 内继续或复核。
- 已完成 goal 不重跑。
- terminal complete 仍重跑验收。
- active goal 恢复原 goal/session log，继续剩余 budget。
- 不能通过篡改 cwd loop log 改 parallel/worktree/trusted config 语义。

### 必须先决定

- parallel resume 已要求用户再次显式传 `--parallel N --worktree-root <cwd外dir>`。
- 是否把 parallel/worktree 元数据写入 `loop-created`。即使写入，也要把 cwd 日志当审计线索，不能当可信授权。
- resume 时缺失 worktree 时的语义：推荐 fail-closed park，提示人工检查；不要自动重建并假装是同一工作树。
- hooks 仍保持与 parallel 互斥，除非先做 per-worktree hook cwd 设计。
- shadow-git 在 parallel 下当前是 per-goal shadow path，恢复要继续复用相同 path 或明确 park。

### 已落地切片

1. plan：`docs/superpowers/plans/2026-07-02-parallel-resume-plan.md`。
2. parser：允许显式 `--resume --parallel N --worktree-root <path>`，拒绝缺 root。
3. worktree：新增只读既有 worktree 解析 helper；root realpath 后拒 cwd 内，缺失 worktree fail-closed。
4. replay：CLI preflight 对 in-flight parallel goal 找回对应 worktree cwd，并调用 `loadLoopGoalResume` 校验 goal/session log。
5. CLI smoke：子进程验证 malformed parallel resume 在写新记录前 fail-closed。

### 关键测试

- `parseLoopArgs` 允许明确的 `--resume --parallel N --worktree-root <path>`，拒绝缺 root。
- `assertWorktreeRootOutsideCwd` 继续覆盖真实 symlink / Windows `\\?\`。
- in-flight parallel attempt 缺 goal/session header：fail-closed。
- in-flight parallel attempt worktree 不存在：park 或 fail-closed，不能落回主 cwd。
- verifier/hook map 恢复规则不变。
- `--parallel` + any hooks 仍失败。
- budget、consecutive blocked、verifier health 在 resume 后不重置。

## 任务 2：finalize cleanup

### 现状

parallel first slice 保留 worktrees；当前 finalize 已落地两步：

- `npm run loop:finalize -- --loop <id>` 只汇总状态和 proposal。
- `npm run loop:finalize -- --loop <id> --merge` 只在人工输入 `merge <loopId>` 后 apply tracked diff。
- `--cleanup` 明确拒绝，防误触发。

parallel worktrees 仍然：

- 不删除 worktree。
- 不 push。
- loop 结束后打印 worktree root 供人工检查。

cleanup 仍保持保守。它可能造成数据丢失或掩盖失败，需要独立命令和人工确认。

### 目标

下一步再考虑 cleanup 执行：

- cleanup 只处理已明确完成且已合并/确认保留快照的 worktree。
- 对 blocked / parked / rejected / couldNotVerify goal 保留 worktree，不清理。
- conflict、dirty、缺失 verdict、未通过验收都 park。

### 建议接口

已落地只读报告：

```bash
npm run loop:finalize -- --loop <id>
```

已落地交互 merge：

```bash
npm run loop:finalize -- --loop <id> --merge
```

后续 cleanup 必须显式 opt-in：

```bash
npm run loop:finalize -- --loop <id> --cleanup
```

执行模式必须走交互确认；无人值守模式不执行 merge/cleanup。不要把 merge/cleanup 放进普通 `npm run loop` 的默认结尾。

### 红线

- 不 push。
- 不 rebase。
- 不强删 worktree。
- 不在有 conflict / dirty / unverified / missing log 时继续。
- 不为了 merge 成功改验收结论。
- 不让 builder 通过 goal 指令触发 merge/cleanup。

### 建议切片

1. plan + 只读汇总已落地：`docs/superpowers/plans/2026-07-02-loop-finalize-report-plan.md`，读取 loop log + worktree status，输出 report，零副作用。
2. merge apply 已落地：`docs/superpowers/plans/2026-07-02-loop-finalize-apply-cleanup-design.md`，`--merge` 需要完整确认短语，成功后写 `data/loops/<id>.finalize.jsonl`。
3. cleanup：只清理已合并且 clean 的 worktree，先 dry-run，再 confirm。

### 关键测试

- verified + tracked diff worktree 出现在 proposal。
- blocked / parked / rejected / missing verdict 不进 proposal。
- conflict 时 proposal 标记 conflict 并不 merge。
- dirty untracked 文件阻止 cleanup。
- cleanup dry-run 不删文件。
- apply 模式需要交互确认；EOF / 空输入 / 非明确允许均取消。
- apply 成功后写 finalize audit，且不删除 worktree。
- Windows worktree path 含空格、`\\?\`、junction 时不误判 cwd 边界。

## 任务 3：完整 cron daemon

### 现状

已完成 `npm run cron -- --cron-map <trusted-json>` 单次扫描。完整 daemon 仅有计划文档和失败模式清单：`docs/superpowers/plans/2026-07-02-cron-daemon-plan.md`。

### 目标

新增前台 daemon：

```bash
npm run cron:daemon -- --cron-map <trusted-json>
```

daemon 只负责调度、锁、可观测性、信号退出。它不自动 resume crashed loop，不自动 merge/cleanup，不后台 fork，不安装系统服务。

### 第一实现范围

- `cron-daemon-cli.ts`：前台循环，支持 `--cron-map`、`--poll-ms`。
- daemon lock：`data/cron/loop-cron-daemon.lock`。
- daemon JSONL：`data/cron/loop-cron-daemon.jsonl`。
- 复用现有 scan lock 和 `runLoopCronOnce`。
- SIGINT/SIGTERM：睡眠期释放锁退出；task 运行期停止接新 task，等待当前 loop 结束。
- started-without-finished：replay 后 park，不自动重跑。

### 不要塞进 daemon 的内容

- 自动 resume crashed loop。
- 自动 merge / cleanup。
- 多工作区统一 daemon。
- GUI 托盘、Windows service、开机自启。
- OS scheduler 安装脚本。
- per-goal hook map 支持，除非 Luis 明确要求 cron task 触发 hooks；如加，按 `--hook-map` 信任边界完整实现。

### 关键测试

直接使用 `docs/superpowers/plans/2026-07-02-cron-daemon-plan.md` 的失败模式清单。最低落地集：

- daemon lock fresh / stale / recovery guard。
- `--cron-map` realpath 拒 cwd 内，含 symlink / Windows `\\?\`。
- 子 loop 非零记录 failure，daemon 继续处理后续 due task。
- task started 后崩溃，重启 park。
- SIGINT 睡眠期释放 daemon lock。
- child output cap。
- 日志尾行截断 replay 到最后完整记录。

## 建议顺序

1. loop finalize cleanup：交互执行设计见 `docs/superpowers/plans/2026-07-02-loop-finalize-apply-cleanup-design.md`；merge apply slice 已落地，后续只做 cleanup confirm。
2. cron daemon：按已有 plan 实现第一范围。daemon 不依赖 merge/cleanup，若新会话只做 cron，也可以直接从计划文档开。

每项独立 plan、独立 commit、独立四关卡。不要一次性实现三项。

## 验证要求

每个代码切片完成后跑：

```bash
npm run test
npm run typecheck
npm run build
npm run lint
```

Windows 子进程测试偶发 timeout / EBUSY，失败先重跑确认。不要削弱断言来凑绿。

安全或信任边界改动还要做只读对抗审查，重点问：

- 哪条 guardrail 没走真实接线？
- 哪个 cwd 日志字段被当成可信配置？
- 哪个路径 realpath 后仍可能落 cwd 内？
- 哪个 crash gap 会重复执行或丢失状态？
- 哪个 cleanup 会删掉用户还没检查的产物？

## 新会话交接 prompt

```text
接手 H:\jarvis-agent，先读 README.md → docs/handoff-codex.md → docs/handoff-next.md → docs/handoff-loop-remaining.md → docs/superpowers/plans/2026-07-02-cron-daemon-plan.md。

目标：只推进 loop 剩余重项的下一步，不要一次做完三项。优先做 plan，然后按 Luis 确认的范围实现一个最小 slice、独立 commit。

当前已完成：mid-goal resume、per-goal verifier、per-goal hook runner、parallel worktree first slice、cron single-scan first slice、真实 --hook-map CLI smoke、Windows \\?\ / symlink / junction hook-map smoke。

剩余两项：
1. finalize cleanup：当前已能只读生成 report，也能通过 `--merge` 在人工输入 `merge <loopId>` 后 apply verified + tracked diff proposal。下一步按 `docs/superpowers/plans/2026-07-02-loop-finalize-apply-cleanup-design.md` 做 cleanup confirm slice。不能 push、rebase、强删；blocked/parked/rejected/missing verdict/conflict/dirty 都必须停下。
2. 完整 cron daemon：已有计划文档 docs/superpowers/plans/2026-07-02-cron-daemon-plan.md。daemon 只负责前台调度、锁、JSONL、信号退出；不自动 resume crashed loop，不自动 merge/cleanup，不后台 fork。

红线：
- 不改 decideVerdict / 三腿验收 / PermissionGate 硬 deny。
- 不新增 unattended bash auto-allow。
- 不从 cwd 读取 hook/verifier/cron enforcement 配置；所有可信配置 realpath 后拒 cwd 内。
- 不改 .env / 密钥 / CI，不 push。
- 不删除 worktree、shadow、loop log、goal log，除非做了单独 cleanup plan 且有人明确确认。
- 每项完成跑 npm run test / typecheck / build / lint；Windows timeout/EBUSY 先重跑确认。

先输出一个具体 plan：范围、文件、信任边界、失败模式测试、验收命令。等确认后再写代码。
```
