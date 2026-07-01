# Cron Daemon Plan

> 状态：计划文档 + 失败模式测试清单。本文不实现代码。当前已落地的是 `npm run cron -- --cron-map <trusted-json>` 单次扫描；daemon 仍是后续独立任务。

## 目标

把现有 cron 单次扫描升级为一个可被 OS/GUI 前台托管的长跑进程，用于周期性触发 loop 队列。成功标准：

- daemon 只负责任务调度、锁、可观测性、退出语义；goal 完成权仍只在 `runGoal` / `decideVerdict`。
- 所有配置仍来自 cwd 外可信文件，经 realpath 后拒 cwd 内路径。
- 任何并发、崩溃、配置错误、子进程失败都 fail-closed 或记录后停下，不静默扩大权限。
- 无自动 merge、自动 cleanup、push、后台 fork、系统常驻安装。

## 当前基线

已存在 first slice：

- `src/surfaces/cli/cron-cli.ts`：单次扫描入口。
- `src/capabilities/goal/loop-cron-config.ts`：可信 cwd 外 `--cron-map`，严格 schema，task 必须 `unattended:true`。
- `src/capabilities/goal/loop-cron.ts`：JSONL 状态、due 判定、scan lock、stale recovery、task 前 heartbeat。
- `data/cron/loop-cron.jsonl`：记录 `cron-attempt`，用于计算下一次运行时间。
- `data/cron/loop-cron.lock`：防同工作区重复扫描。

现有语义是单次扫描，可交给 Windows Task Scheduler / cron / GUI 定时唤起。daemon 的价值只在需要一个 Jarvis 自己持有生命周期的前台进程时成立。

## 建议接口

新增脚本和 CLI：

```bash
npm run cron:daemon -- --cron-map <trusted-json>
```

可选参数先保持极少：

- `--cron-map <trusted-json>`：必填，沿用单次扫描信任边界。
- `--poll-ms <n>`：可选，默认 60000，范围 `10000..3600000`。只影响醒来检查频率，不覆盖 task 自己的 `nextRunAt`。
- `--once` 不加，单次扫描已有 `npm run cron`，daemon 不复用该开关。

不支持：

- 不支持后台 fork。
- 不支持 daemon 内自动恢复 crashed loop。
- 不支持 daemon 内自动 merge / cleanup / push。
- 不支持从 cwd 自动发现计划文件。

## 配置扩展

现有 task：

```json
{
  "id": "nightly",
  "objectivesFile": "H:\\trusted\\nightly-objectives.txt",
  "intervalMinutes": 1440,
  "nextRunAt": "2026-07-02T02:00:00.000Z",
  "unattended": true,
  "verifierMapPath": "H:\\trusted\\verifier-map.json"
}
```

daemon 实现前先决定是否补 `hookMapPath`：

```json
{
  "hookMapPath": "H:\\trusted\\hook-map.json"
}
```

如果补，规则必须与 per-goal hook runner 一致：

- `hookMapPath` 本身 realpath 后拒 cwd 内。
- hook-map 内每个 `hookPath` 也 realpath 后拒 cwd 内。
- malformed 任务配置导致整个 daemon 启动失败，不跳过该 task 后继续跑。
- 无 per-goal hooks 时用可信空 map `{"goals":[]}`，避免 resume/调度语义被 cwd 日志降级。

## 生命周期

daemon 是前台进程：

1. 启动时加载 `.env` 前后保持现有 key 边界，不从启动 env 接收 `ARK_API_KEY`。
2. 加载 cwd 外 `--cron-map`，预检所有 task 的可信路径。
3. 获取 daemon 级锁 `data/cron/loop-cron-daemon.lock`。
4. 进入循环：计算下一次 scan 时间，睡眠，醒来后获取现有 scan lock `data/cron/loop-cron.lock`，调用与单次扫描同一套 due 判定。
5. 每个 due task 前写 heartbeat。
6. 收到 SIGINT/SIGTERM 时停止接新 task；若当前 task 已启动，等待当前 `npm run loop` 子进程自然结束或按明确 timeout 终止，然后释放锁并退出。

为何保留 daemon lock + scan lock 两层：

- daemon lock 防重复 daemon。
- scan lock 继续保护手动 `npm run cron`、OS scheduler、未来 GUI 触发之间的互斥。
- 两者都可 stale recovery，避免崩溃后永久卡死。

## 状态与审计

建议新增 `data/cron/loop-cron-daemon.jsonl`，与现有 `loop-cron.jsonl` 分开：

- `daemon-started`：pid、cronMapPath、startedAt。
- `daemon-heartbeat`：at、nextWakeAt。
- `daemon-stopped`：reason、at。
- `scan-started` / `scan-finished`：scan 级统计。
- `task-started` / `task-finished`：task 级生命周期，含 command 摘要、exitCode、loopId。
- `task-parked`：不确定状态，需要人看。

现有 `cron-attempt` 只在 task 结束后记录，崩溃窗口里会丢失“已经启动过”的事实。daemon 版本应先写 `task-started`，再运行 task，最后写 `task-finished`。replay 时看到 started-without-finished：

- 默认 park，不自动重跑。
- 后续如要自动 resume，必须单独设计 trusted verifier-map / hook-map / worktree 状态恢复，不能顺手塞进 daemon。

## 调度语义

- 基础语义：at-least-once with parked crash gaps。正常完成后按 `finishedAt + intervalMinutes` 计算下次运行。
- task 失败也记录 attempt，并推进 `nextRunAt`，避免失败热循环。
- daemon 自身配置错误、锁错误、状态 replay 读失败、可信路径校验失败：启动失败或停机。
- 单个 task 的 `npm run loop` 非零：记录 task failure，继续处理后续 due task。
- scan lock 获取失败：记录 skipped scan，等待下一次 poll。

## 红线

- 不改 `runGoal` / `decideVerdict` / 三腿验收。
- 不给 unattended bash 新增自动 allow。
- 不从 cwd 读取 cron/hook/verifier enforcement 配置。
- 不把 cwd 内 loop log 当作权限或恢复配置来源。
- 不自动删除 worktree、shadow、loop log、goal log。
- 不 push、不部署、不改 `.env`。
- 不在 daemon 内起隐藏后台进程；进程管理交给 OS supervisor 或 GUI。

## 失败模式测试清单

### Config trust

- `--cron-map` 缺失、空值、未知 flag 均失败。
- cron config realpath 落 cwd 内失败。
- cron config symlink / Windows `\\?\` 扩展路径最终落 cwd 内失败。
- task `verifierMapPath` realpath 落 cwd 内失败。
- 如新增 `hookMapPath`：hook map 路径与内部 `hookPath` 任一落 cwd 内失败。
- unknown top-level key / unknown task key 失败，避免“以为装了其实没装”。
- `unattended !== true` 失败。
- `objectivesFile` 以 `--` 开头失败，防配置把 loop CLI flag 当路径注入。

### Daemon lock and scan lock

- 第二个 daemon 启动时拿不到 daemon lock，退出非零。
- daemon 崩溃后 stale daemon lock 可恢复。
- fresh `.recovering` guard 存在时不抢锁。
- recovery guard 过期后可恢复。
- scan lock 被另一个进程持有时，本轮 scan 记录 skipped，不运行 due task。
- scan lock 续租失败时停止本轮，不继续跑 task。
- release 前 owner 变化时不误删别人的锁。

### Crash and replay

- task 已写 `task-started`、子 loop 未结束时 daemon 崩溃；重启后该 task 进入 parked，不自动重跑。
- task 已完成但 `task-finished` 未写时崩溃；重启后仍 parked，避免重复执行不明副作用。
- `loop-cron-daemon.jsonl` 尾行截断时跳过尾行，前面完整记录可 replay。
- 现有 `loop-cron.jsonl` 尾行截断时沿用现有跳过尾行行为。
- replay 只从 daemon/cron 状态恢复调度，不信 cwd 内 loop result 来决定 goal 完成。

### Child loop execution

- daemon 构造的命令必须包含 `npm run loop -- <objectivesFile> --unattended`。
- task 配了 verifier map 时命令包含 cwd 外 `--verifier-map`。
- 如新增 hook map，命令包含 cwd 外 `--hook-map`。
- 子进程 timeout 记录 `exitCode:null` 或明确 timeout 状态，并推进下一次运行，避免热循环。
- 子进程 stdout/stderr 有 output cap，不撑爆 daemon 日志。
- 子进程非零不杀 daemon，记录 task failure 后继续处理后续 due task。

### Signals and shutdown

- SIGINT/SIGTERM 到达睡眠期：释放 daemon lock 后退出。
- SIGINT/SIGTERM 到达 scan 期：停止接新 task，当前 task 结束后释放锁。
- SIGINT/SIGTERM 到达 task 运行期：策略需明确。推荐 first daemon 等待当前 loop 完成；如加 hard timeout，必须测试 tree-kill。
- shutdown 期间 release 失败：记录错误，进程退出非零。

### Scheduling

- 未到期 task 不运行。
- 到期 task 每次 scan 只运行一次。
- 失败 task 也推进 `nextRunAt`。
- 多 task 到期按 config 顺序串行运行。
- 单个 task 长运行期间不会并发启动同一 task。
- 系统时钟倒退时不热循环；系统时钟大幅跳未来时只触发一次 due scan。

### Observability

- daemon 启动打印 cronMapPath、task 数、poll 间隔。
- 每次 scan 记录 started/finished/triggered/skipped。
- task parked 明确打印“需要人工检查”。
- 所有用户可控文本经 `safeInline` 渲染，避免终端控制字符污染。

## 实施切片

1. **纯函数与状态模型**：新增 daemon record 类型、parse/replay、parked 规则测试。
2. **daemon lock**：复用/抽象 `FileLoopCronLock`，加 daemon lock 测试。
3. **CLI shell**：`cron-daemon-cli.ts` 只跑 sleep + scan loop，支持 SIGINT/SIGTERM。
4. **task lifecycle**：task-started/task-finished/parked 记录和 replay。
5. **可选 hookMapPath**：如果 Luis 明确需要 cron 触发 per-goal hooks，再补 schema 与 command 拼接。
6. **对抗审查**：重点审信任边界、crash replay、重复执行、锁恢复、无人值守 bash。

## 暂不做

- 自动 resume crashed loop。
- 自动 merge / cleanup。
- 多工作区统一 daemon。
- GUI 托盘、Windows service、开机自启。
- OS scheduler 安装脚本。
