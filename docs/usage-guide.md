# Jarvis 使用与验收指南（给 Ludi）

> 用途：在 PowerShell 中按顺序验证 Jarvis 的主要用户路径。第一、二层无需模型 key，其中 stop 和 Session 操作会改变本地状态；第三层需要模型 key，开始对话后会产生费用。
> 每个命令块都包含工作目录，可以从任意 PowerShell 窗口整段复制。命令参数有变化时，以对应子命令的 `--help` 为准。

---

## 0. 一次性准备

```powershell
cd H:\jarvis-agent
npm install
```

- 第一、二层的所有命令**不需要模型 key**。
- 第三层（真对话 / goal / loop / A0）需要火山方舟 key：复制 `.env.example` 为 `.env`，填入 `ARK_API_KEY`。`.env` 已被 git 忽略，key 不会进仓库；所有只读命令都不会回显 key 的值。
- 退出码怎么查：PowerShell 里命令跑完紧接着输 `$LASTEXITCODE`。

---

## 1. 第一层：零成本验收（无 key）

### 1.1 帮助与版本

```powershell
cd H:\jarvis-agent
npm run jarvis -- --help
npm run jarvis -- --version
```

**期望看到**：命令清单里包含 `stop`、`review`、`completion`、`a0`、`sessions`、`checkpoints`、`rewind`；版本值与 `package.json` 一致。

### 1.2 doctor 就绪诊断

```powershell
cd H:\jarvis-agent
npm run jarvis -- doctor
npm run jarvis -- doctor --json
```

**期望看到**：Node 版本、当前目录、凭据来源（只说「来自 .env / 环境变量」，不显示值）、数据目录状态。`--json` 输出带 `schemaVersion: 1`。

### 1.3 status 工作区观测

```powershell
cd H:\jarvis-agent
npm run jarvis -- status
```

**期望看到**：`completion authority: none`（只读）、`emergency stop: clear|requested|unreadable`、sessions / goals / loops / cron 计数、audit 汇总。

`--json` 的 additive 字段为 `control.emergencyStop`，`meta.schemaVersion` 仍为 `1`。控制文件损坏或不可读时，status 会显示 `unreadable` 与错误摘要，不会隐藏状态读取失败。

### 1.4 sessions 只读三件套

```powershell
cd H:\jarvis-agent
npm run jarvis -- sessions list
npm run jarvis -- sessions search "测试"
npm run jarvis -- sessions show <从 list 里复制的会话 id>
```

**期望看到**：`Sessions (read-only): <数量>` 清单；数量来自当前 `data/sessions/`。search 只搜用户/助手文本与元数据，不碰工具输出；show 展示完整性和恢复证据。

**验收点**：带损坏日志的会话会被点名列出（fail-closed 可见），报告里能看到哪个会话坏了、为什么。

### 1.5 stop 工作区急停（本切片重点）

```powershell
cd H:\jarvis-agent
npm run jarvis -- stop
npm run jarvis -- stop --clear
npm run jarvis -- stop --clear
```

**期望看到**（依次）：

1. `Emergency stop requested (workspace-wide)`，带 `reason: CLI emergency stop`、requestedAt 时间、审计文件路径；
2. `Emergency stop cleared (workspace-wide)`；
3. 第二次 clear 显示 `No emergency stop in effect`（重复清除不报错）。

**再试两条用法错误**（都应退出码 2、stderr 有解释）：

```powershell
cd H:\jarvis-agent
npm run jarvis -- stop some-id
$LASTEXITCODE   # 应为 2；报错文案解释 stop 是工作区全局的，不接 id
npm run jarvis -- stop --reason "x" --clear
$LASTEXITCODE   # 应为 2；--reason 与 --clear 互斥
```

**语义上三个容易误解的点**：

- **全局生效**：停的是这个工作区里所有比它早启动的 goal / loop / cron 运行，没有按 id 定向停。
- **时间门控**：只停「stop 请求之前」启动的运行；stop 之后新启动的运行不受影响。这样一份遗留的 stop 文件不会永久锁死工作区。
- **状态查询**：运行 `npm run jarvis -- status`；`clear` 表示当前没有 stop 请求，`requested` 会带请求时间、来源和原因，`unreadable` 表示控制文件读取失败。审计历史在 `data\control\emergency-stop.jsonl`，只追加、清除不写审计。

### 1.6 completion shell 补全

```powershell
cd H:\jarvis-agent
npm run jarvis -- completion powershell
```

**期望看到**：一段 PowerShell 补全脚本（Register-ArgumentCompleter）。

**真正装上试试**（可选，把脚本存进你的 PowerShell 配置）：

```powershell
cd H:\jarvis-agent
npm run jarvis -- completion powershell | Out-File "$env:TEMP\jarvis-completion.ps1" -Encoding utf8
Add-Content $PROFILE '. "$env:TEMP\jarvis-completion.ps1"'
. $PROFILE
jarvis <按 Tab>        # 顶层命令补全
jarvis sessions <Tab>  # 子命令补全
```

**验收点**：Tab 能补出 `stop`、`sessions`、`completion` 等命令；`sessions ` 后能补出 `list` / `show` / `search` 等子命令。不想要了就从 `$PROFILE` 删掉那行。

### 1.7 review 待裁决清单

```powershell
cd H:\jarvis-agent
npm run jarvis -- review list
```

**期望看到**：有待裁决项时显示 `Pending human reviews: <数量>` 与明细；没有时显示 `No pending human reviews`。这个命令只查看，裁决动作见 3.5。

---

## 2. 第二层：会话文件操作（仍不需要 key）

### 2.1 恢复前预检

```powershell
cd H:\jarvis-agent
npm run jarvis -- sessions show <会话 id>
```

**期望看到**：会话完整性、composition、pending effect 和 `ready-for-resume-check` 等恢复建议。这个结果只做预检；实际 `resume` 还会比较本次调用的配置与 addendum。

### 2.2 会话管理（fork / rename / archive）

```powershell
cd H:\jarvis-agent
npm run jarvis -- sessions fork <会话 id>
npm run jarvis -- sessions rename <会话 id>
npm run jarvis -- sessions archive <会话 id>
npm run jarvis -- sessions list --archived
npm run jarvis -- sessions unarchive <归档会话 id>
```

**语义**：fork 全量复制出新会话（血缘可见）；rename 是「fork 新 id + 原会话归档」，零删除；archive 只是把文件移进 `data/sessions/archived/`，内容一个字节不动。每次操作先写计划再写结果到 `data/session-mutations.jsonl`。

**验收点**：fork 后原会话完好；archive 后 `sessions list` 不再显示、`sessions list --archived` 显示且标 `archived: true`；归档的会话不能直接 resume（报 not-found，这是有意的）。

### 2.3 检查点与回退

```powershell
cd H:\jarvis-agent
npm run jarvis -- checkpoints list <会话 id>
npm run jarvis -- checkpoints show <会话 id> <检查点 id>
npm run jarvis -- rewind <会话 id> <检查点 id>
```

**语义**：rewind 会话会创建**新**会话，源日志原样保留。带 `--files` 的文件恢复有预览和一次性确认，才会动磁盘文件——这一步要谨慎，看清预览再确认。

---

## 3. 第三层：真模型功能（需要 ARK_API_KEY，烧 token）

> 先配好 `.env`（见第 0 节）。这层每个命令都真实调模型计费，验收节奏自己控制。

### 3.1 run 交互会话

```powershell
cd H:\jarvis-agent
npm run jarvis -- run "看看这个仓库最近的改动"
npm run jarvis -- resume                 # 恢复当前 cwd 最近的会话
npm run jarvis -- resume <会话 id>        # 恢复指定会话
```

**期望看到**：`run` 执行首条请求后保留交互提示符；`resume` 先显示恢复来源与兼容性，再进入同一交互表面。带未决工具副作用、损坏记录或 composition 漂移的 Session 会停下并给出处理方向。`/exit` 退出；想固定走行模式加 `--no-tui`。

**权限闸门**：模型读文件直接放行；改源码会先征求审批；碰 `.env` 这类敏感文件直接拒绝。审批提示按 y/n 交互。

### 3.2 goal 单目标

```powershell
cd H:\jarvis-agent
npm run jarvis -- goal "给 README 的快速开始部分挑 3 处表述问题并列出来"
```

**语义**：跑到达标自停；默认要求 Git baseline（防篡改），无 Git 时只能 `--allow-no-git` 且结果上限为 checks-only（不会被标成 verified）。

### 3.3 loop 多目标 + finalize

```powershell
cd H:\jarvis-agent
npm run jarvis -- loop <objectives 文件路径>
npm run jarvis -- finalize --loop <loop id>          # 只读报告
npm run jarvis -- finalize --loop <loop id> --merge  # 交互合并，要输入 merge <loopId>
```

**语义**：finalize 默认只读；`--merge` 只合入 verified 且 diff 干净的提案；`--cleanup` 只清理有合并审计且当前干净的 worktree，不强删、不删日志。不想动就停在只读报告。

### 3.4 cron 定时

```powershell
cd H:\jarvis-agent
npm run jarvis -- cron daemon --cron-map <计划文件绝对路径>
```

**注意**：cron 计划文件必须放在**工作区外**（放在仓库内会被安全检查拒绝：repo-controlled cron config）。

### 3.5 review 裁决（配合 1.7 的清单）

```powershell
cd H:\jarvis-agent
npm run jarvis -- review show <goal-id>
npm run jarvis -- review approve <goal-id> --requirement r1 --note "我人工确认过"
npm run jarvis -- review reject <goal-id> --requirement r1 --note "理由写清楚"
```

**语义**：一次裁决一条需求，`--note` 必填（留审计痕迹）。CLI 自身没有完成授权：全部需求通过后，goal 的完成状态由系统里的裁决逻辑计算并记录，终端只是操作入口。

### 3.6 A0 冻结评测（可选，明确烧钱）

```powershell
cd H:\jarvis-agent
npm run jarvis -- a0 report --observations data/a0/run-v2/observations.jsonl
```

仓库内已有可重放的 v2 observations。`report` 只读且不调用模型；`a0 run` 会重跑 6 案 × 3 次真实模型调用，需要单独评估费用。

---

## 4. 可选深潜：双终端急停实验（照抄即走）

> 目的：亲眼看到一次真实急停——一个正在轮询的 daemon 被 `stop` 终止。以下 PowerShell 已在 2026-08-18 实测通过。

**准备**（任意一个终端）：

```powershell
$probe = "$env:TEMP\jarvis-stop-acceptance"
New-Item -ItemType Directory -Force -Path $probe | Out-Null
Set-Content "$probe\objectives.txt" "inspect the workspace"
@{ tasks = @(@{ id = "future"; objectivesFile = "$probe\objectives.txt"; intervalMinutes = 30; nextRunAt = "2030-01-01T00:00:00.000Z"; unattended = $true }) } | ConvertTo-Json -Depth 5 | Set-Content "$probe\cron.json"
```

**终端 1**（起 daemon，任务定在 2030 年所以它只会睡眠轮询）：

```powershell
cd H:\jarvis-agent
npm run jarvis -- cron daemon --cron-map "$env:TEMP\jarvis-stop-acceptance\cron.json"
```

等到出现 `cron daemon - 1 tasks` 和 `sleeping until ...`。

**终端 2**（发急停）：

```powershell
cd H:\jarvis-agent
npm run jarvis -- stop --reason "acceptance test"
```

**期望看到**：终端 1 的 daemon 打出 `[emergency-stop] acceptance test` 并退出；终端 2 报告 stop 已写入。

**清理**：

```powershell
cd H:\jarvis-agent
npm run jarvis -- stop --clear
Remove-Item "$env:TEMP\jarvis-stop-acceptance" -Recurse -Force
```

---

## 5. GUI 观测面板

```powershell
cd H:\jarvis-agent
npm run gui
```

打开命令输出的本地 URL。默认从 `http://127.0.0.1:4317` 开始，端口被占时会在有限范围内顺延。GUI 提供只读时间线、急停按钮、human-review 裁决、审批历史和 goal/loop 过滤，只监听本机回环地址。

---

## 6. 退出码速查

| 码 | 含义 | 什么时候见到 |
|---|---|---|
| 0 | 成功 | 正常完成 |
| 2 | 用法错误 | 参数写错（如 `stop some-id`） |
| 3 | 需要人工 | 运行停在等人处理 |
| 4 | 未验证 | goal 没拿到 verified 就结束 |
| 5 | 运行时失败 | I/O、模型调用失败等 |
| 6 | 拒绝 | 权限闸门拒绝操作 |
| 7 | 状态损坏 | 会话/日志完整性检查失败（fail-closed，不静默） |
| 130 | 中断 / 急停 | loop 系运行被 emergency-stop 收尾 |

---

## 7. 注意事项与已知边界

**安全与费用**

- key 只放 `.env`（已 gitignore）；任何命令都不会回显 key 值。
- `run` / `goal` / `loop` / `a0 run` 真实调用模型计费；A0 一轮是 6 案 × 3 次。
- 权限默认偏保守：读放行、改要审批、敏感文件直接拒。

**stop 的三条边界**（重复但重要）：全局无定向；时间门控（新启动的运行不受旧 stop 影响）；`--clear` 只删控制文件这一个东西，审计只追加。

**已知缺口 / 披露**（验收时可留意，均为当前已知项，非 bug）：

- zsh 补全脚本生成但未在本机实机验证（本机无 zsh）。
- `stop --reason ""` 空字符串在文本报告里显示 `-`；reason 没有长度上限（Windows 命令行长度是事实上界）。
- PowerShell 下 `npm run dev -- --resume` 会被 npm 吞掉 `--resume`，统一用 `npm run jarvis -- resume` 这个形态。
- 测试套件里少量 Windows 平台专属 skip 属正常现象。

**文件去哪了**：会话 `data\sessions\`、急停 `data\control\emergency-stop.json(l)`、裁决审计 `data\human-reviews\`、会话操作日志 `data\session-mutations.jsonl`、cron `data\cron\`。都是纯文本，可以直接打开看。

---

## 8. 验收清单

| # | 验收项 | 命令（在 `H:\jarvis-agent` 下） | 通过标准 | 结果 |
|---|---|---|---|---|
| 1 | 帮助发现 | `npm run jarvis -- --help` | 命令清单含 stop / review / completion | ☐ |
| 2 | 就绪诊断 | `npm run jarvis -- doctor` | 输出就绪项、不回显 key | ☐ |
| 3 | 工作区观测 | `npm run jarvis -- status` | 只读汇总、authority: none | ☐ |
| 4 | 会话清单 | `npm run jarvis -- sessions list` | 列出会话与完整性 | ☐ |
| 5 | 会话搜索 | `npm run jarvis -- sessions search "任意词"` | 命中摘要、损坏会话点名 | ☐ |
| 6 | 急停写入 | `npm run jarvis -- stop` | Emergency stop requested + reason | ☐ |
| 7 | 急停清除 | `npm run jarvis -- stop --clear`（×2） | cleared → No stop in effect | ☐ |
| 8 | 急停用法错误 | `npm run jarvis -- stop some-id` | exit 2 + 全局语义解释 | ☐ |
| 9 | 待裁决清单 | `npm run jarvis -- review list` | 列出 parked 需求 | ☐ |
| 10 | 补全生成 | `npm run jarvis -- completion powershell` | 输出脚本；装上后 Tab 生效 | ☐ |
| 11 | 会话 fork/archive | `npm run jarvis -- sessions fork / archive <id>` | 原会话完好、归档可查 | ☐ |
| 12 | 检查点只读 | `npm run jarvis -- checkpoints list <id>` | 列出 checkpoint 审计 | ☐ |
| 13 | 急停端到端 | 见第 4 节双终端实验 | daemon 打出 [emergency-stop] 并退出 | ☐ |
| 14 | 真实对话 | `npm run jarvis -- run "..."` | 权限闸门按预期审批 | ☐ |
| 15 | 单目标 | `npm run jarvis -- goal "..."` | 跑到达标自停或如实报告未达标 | ☐ |
| 16 | 人工裁决 | `npm run jarvis -- review approve <id> --requirement r1 --note "..."` | 裁决落盘、清单减一 | ☐ |
| 17 | GUI | `npm run gui` | 时间线 + 急停键可用 | ☐ |

> 1–13 都不调用模型；第 6–8、11–13 项会改变本地控制或 Session 状态，其余为只读检查。14–17 按费用和验收需要执行。
