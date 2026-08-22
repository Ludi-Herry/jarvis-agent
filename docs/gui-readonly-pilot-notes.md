# GUI Read-Only Pilot Notes

日期：2026-07-03

范围：切片 1 只读巡检试点。本文只记录真实运行证据、observe/GUI 可读性问题和后续输入；不在本切片新增 harness 功能。

## 运行证据

### 1. Trusted loop parked sample

- 命令：`npm run loop -- <cwd外 objectives> --goal-setter-requirements-map <cwd外 map> --unattended --fail-on-worktree-change`
- 配置目录：`C:\Users\Administrator.DESKTOP-33TL0HO\.jarvis\pilots\slice1-readonly-20260703-090701`
- loop：`2026-07-03T16-07-19-236Z`
- goal：`2026-07-03T16-07-19-236Z-g0-2026-07-03T16-07-19-241Z`
- 结果：`blocked / couldNotVerify`
- 关键原因：requirements map 中 `r3` 使用 `human` route，verifier report 写出 `human verification required for r3`。
- 只读证据：sandbox evidence 记录 `wsl2-unshare`、host mount `read-only`、network `none`，命令为 `stat README.md` 与 `stat package.json`。
- no-edit 证据：worktree status policy `forbid`，`changed=false`。

### 2. Cron due scan sample

- 命令：`npm run cron -- --cron-map C:\Users\Administrator.DESKTOP-33TL0HO\.jarvis\pilots\slice1-readonly-20260703-090701\cron-map.json`
- cron record：`data/cron/loop-cron.jsonl`
- task：`slice1-readonly-pilot`
- scheduledFor：`2026-07-03T00:00:00.000Z`
- startedAt / finishedAt：`2026-07-03T16:09:25.280Z` / `2026-07-03T16:10:07.371Z`
- loop：`2026-07-03T16-09-26-360Z`
- 结果：`exitCode=0`，loop `complete / verified`，nextRunAt `2026-07-04T16:10:07.371Z`
- 注意：这只是单次 due scan 证据；R2 的 5 次仍需真实间隔 cron/daemon 触发累计。

### 3. GUI emergency-stop drill

- GUI 点击时间：`2026-07-03T16:13:31.614Z`
- 审计：`data/control/emergency-stop.jsonl` 追加 `source=gui`、`reason=GUI emergency stop`、`pid=32508`。
- stop-drill loop：`2026-07-03T16-13-05-281Z`
- stdout/stderr 证据：
  - `[emergency-stop] GUI emergency stop`
  - `[loop] emergency stop requested; no new goals will launch and JSONL logs were left in place.`
  - `halted: emergency-stop`
- 结果：按钮触发有效，审计有效，运行进程收到 stop。

### 4. R2 real-interval cron daemon run

- 命令：`npm run cron:daemon -- --cron-map C:\Users\Administrator.DESKTOP-33TL0HO\AppData\Local\Temp\jarvis-r2-cron-20260703-124756\cron-map.json --poll-ms 10000`
- task：`r2-readonly-20260703-124756`
- requirements map：`C:\Users\Administrator.DESKTOP-33TL0HO\AppData\Local\Temp\jarvis-r2-cron-20260703-124756\requirements-map.json`
- 真实间隔成功运行：`6` 次，均由 cron daemon 根据 `intervalMinutes=1` 触发，均 `exitCode=0`。
- loop 证据：
  - `2026-07-03T19-48-06-439Z`
  - `2026-07-03T19-50-16-714Z`
  - `2026-07-03T19-52-20-703Z`
  - `2026-07-03T19-54-47-468Z`
  - `2026-07-03T19-56-56-411Z`
  - `2026-07-03T19-59-11-433Z`
- 结果核对：6/6 最终 `blocked / couldNotVerify`，`falseVerified=0`。原因均来自 `human` route：`r_human_readability` 需要人工判断 observe/GUI 可读性。
- 只读证据：每轮 goal 的 worktree status audit 均 `changed=false`；sandbox evidence 记录 `stat docs/handoff-release.md` 与 `stat docs/gui-readonly-pilot-notes.md` 在 WSL2 read-only mount、`networkMode=none` 下执行。
- observe 交叉验证：`npm run observe -- --json` 于 `2026-07-03T20:02:33.826Z` 看到 `cron.lastAttempt.taskId=r2-readonly-20260703-124756`、`exitCode=0`、`loopId=2026-07-03T19-59-11-433Z`，并在 trustedContracts / sandboxEvidence / worktreeStatus 中列出上述运行证据。

### 5. R3 running-loop GUI emergency-stop drill

- GUI：复用既有 dev/smoke server `http://127.0.0.1:4328/`，未另起端口；使用内置 Browser 点击唯一 `急停` 按钮。
- stop-drill loop：`2026-07-03T20-01-28-688Z`
- goal：`2026-07-03T20-01-28-688Z-g0-2026-07-03T20-01-28-698Z`
- GUI 点击审计：`data/control/emergency-stop.jsonl` 追加 `requestedAt=2026-07-03T20:01:55.048Z`、`source=gui`、`reason=GUI emergency stop`、`pid=21644`。
- loop JSONL：`data/loops/2026-07-03T20-01-28-688Z.jsonl` 追加 `{"t":"loop-halted","reason":"emergency-stop","at":"2026-07-03T20:01:55.345Z"}`。
- stdout 证据：R3 loop 正在读取多份源码/文档时收到停机，输出 `loop 停止: emergency-stop` 与 `[emergency-stop] GUI emergency stop`。
- observe 交叉验证：`npm run observe -- --json` 的 `latestLoop.halted` 为 `emergency-stop`，`activity.recent[0]` 为 `Loop halted / emergency-stop`。

## 发现的问题

1. **cron 无法携带 trusted requirements map**
   - 现状：cron map schema 只支持 `verifierMapPath`，`buildLoopCronCommand()` 只拼 `--verifier-map`。
   - 影响：cron 触发的 loop 无法复用 slice 1 所需的 `--goal-setter-requirements-map`，因此 cron sample 没有 human route parked goal。
   - 后续：切片 1 继续跑真实 cron/daemon 时，要么接受“cron 只跑普通 unattended loop”的证据边界，要么单独开 bug/设计切片处理参数传递。

2. **急停后的 loop JSONL 缺 terminal record**
   - 现象：stop-drill 进程已退出，stdout/stderr 有 `emergency-stop`，但 `data/loops/2026-07-03T16-13-05-281Z.jsonl` 只包含 `loop-created` 和 `goal-started`。
   - 影响：`npm run observe -- --json` 仍显示 latestLoop `inFlight=1`，latestGoal `state=active`，GUI 也显示这个 loop 仍在运行。
   - 后续：R3 的审计链目前只能证明“按钮触发 + 进程收到 stop”，还不能证明 “observe/GUI 从 JSONL 正确解释终态”。这是切片 3/4 前的高优先级可观测性修复输入。

3. **GUI 时间线重复展示 cron**
   - 现象：内置浏览器首屏中 `Cron slice1-readonly-pilot` 连续出现两张卡，一张带 `next ...`，一张不带。
   - 影响：容易误读成两次 cron 运行。
   - 后续：区分 status summary 卡与 activity 卡，或合并同一 `taskId + finishedAt` 的重复展示。

4. **GUI 可读性仍偏日志化**
   - 现象：parked goal 能看到 `blocked / couldNotVerify`，但人需要继续读很多 ID 才知道原因来自 `human route`。
   - 影响：对 Ludi 这种产品/UX 视角使用者，最关键的“为什么停、下一步该谁做”还不够直观。
   - 后续：切片 3 human-review flow 需要把 parked reason 提到卡片主层级，并给出明确行动入口。

## 当前计数

- R2 真实间隔 cron 触发：`6/5` 完成，false verified `0`。
- parked goals 样本：`7` 条，其中 1 条来自 trusted loop `2026-07-03T16-07-19-236Z`，6 条来自 `r2-readonly-20260703-124756`。
- R3 急停演练：完整通过。GUI 点击、`data/control/emergency-stop.jsonl`、running loop `loop-halted emergency-stop`、observe latestLoop/activity 均有证据。
