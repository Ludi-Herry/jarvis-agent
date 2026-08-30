# v0.1 MVP dogfood 手册（Ludi 执行版）

> 状态（2026-08-31）：Ludi 已批准范围收缩。当前只跑 3 个原本就需要完成的真实任务；TUI 视觉验收暂停，Recall A/B 降为次级实验，G5 与所有 post-real-use 扩展继续冻结。项目状态统一写作「工程完成，产品验证中」。
> 所有命令都从 `H:\jarvis-agent` 跑；每段可整段复制进 PowerShell。
> 前置确认：火山方舟账户有余额（`npm run jarvis -- doctor` 会显示凭据来源）。

---

## Part A · 三个真实任务

任务必须满足一个条件：即使没有这次验收，项目今天也需要完成它。禁止为了跑 agent 制造 inventory、索引、Changelog 占位或随机断言。

| # | 类型 | 当前真实任务 | 状态 |
|---|---|---|---|
| D1 | 代码 + 测试 | 补齐 finalize cleanup 的 `node_modules` dependency bridge fixture；失败时只修真实暴露的根因 | PARTIAL，见文末证据 |
| D2 | 文档修改 | 给 `docs/usage-guide.md` 的 doctor 小节补 `config show / validate` 零成本检查，并同步验收表 | 待跑 |
| D3 | 只读审计 | 对照当前源码复核 `KNOWN_ISSUES.md`，只报告仍成立、已过期和缺证据三类 | 待跑 |

剩余两个任务继续使用真实 `goal`：

```powershell
cd H:\jarvis-agent
# D2 文档修改
npm run jarvis -- goal "给 docs/usage-guide.md 的 doctor 小节补一段 config show / config validate 的零成本检查，说明前者看生效值、后者查配置错误；同步更新文末验收清单"

# D3 只读审计
npm run jarvis -- goal "逐条复核 KNOWN_ISSUES.md：对照当前源码与测试，只在回复中分成仍成立、已过期、缺少当前证据三类；给出文件和行号，不修改任何文件"
```

每个任务只记六项：实际产出、Jarvis 终态、turn/token、允许/拒绝审批数、`git diff` 范围、摩擦一句话。`verified` 仍需人工抽查；`blocked` 也要判断任务是否实际完成，保留系统状态与产品结果两套字段。

---

## Part B · Recall A/B（次级实验，三任务后再决定）

**原理**：Recall 给 agent 搜索过往会话的能力（默认开；`--no-recall` 关掉）。A/B = 同一个提问，A 组能翻历史、B 组只能靠读仓库文档，比较答案质量与成本。

三任务未证明 `run / goal` 的基础价值前，本节不阻塞 v0.1 MVP 判断。只有真实任务反复需要翻历史，或三任务通过后需要评估 Recall 的额外成本，再执行原同形对照。

若重开，先选一个真实需要历史上下文的问题跑一对 `run` / `run --no-recall`。只有答案质量或成本出现值得追踪的差异，再扩到第二对。

---

## Part C · 人工边界

**C1 · CLI 零成本检查：按需。** 当前 typecheck、lint、build 与全量测试有独立门禁证据；三任务期间不再把 `usage-guide` 的 1–13 项整套重跑当成仪式。发生 help、doctor、status、Session 或 stop 相关改动时，只复跑受影响项。

**C2 · TUI renderer 的 TTY 视觉验收：暂停。** 日常继续可用 `--no-tui` 行模式；三任务期间不为布局、键位或视觉细节阻塞开发。

需要恢复验收时，再检查全屏层级、折叠、键位提示、状态流转、Esc 与双 Ctrl-C。恢复前保持「实现完成，体验未验收」。

---

## Part D · G5 决策门（三任务后填）

G5 = GUI 审批中继（把终端审批搬到 GUI 弹窗），全计划最重的一片。**默认不开**，用 Part A 的体感数据决策：

- 开的信号：三个真实任务中累计 ≥3 次出现明确的终端审批打断感，或你开始因为怕打断而回避 attended 任务。
- 不开的信号：审批频率低（每个任务 1–2 次）、你在 GUI 时间线上看到运行状态已经足够安心。

你的决策：☐ 开　☐ 不开　依据一句话：＿＿＿＿

若选「开」，把这段发给 Codex 会话：

```text
Ludi 拍板开启 G5（GUI 审批中继）。这碰运行进程与 GUI 的桥接，属于重架构切片：先出设计文档（docs/PLAN-g5-*.md，含桥接方式、权限边界、超时与回退、安全审查点），经 Ludi 批准后再动代码。硬边界不变（规划附录 prompt 全部适用），完成后仍按节交 Ludi 验收。
```

---

## Part E · 证据表与停止线

| # | 任务/提问 | 模式 | 状态/答案 | tokens | 审批次数 | 体感一句话 |
|---|---|---|---|---|---|---|
| D1-1 | cleanup fixture 首次尝试 | goal | blocked/truncated；任务未改盘 | 160,975 | 6 允许 / 0 拒绝 | 10 turns 后撞输出截断；促成 bounded `edit` 工具 |
| D1-2 | 同一任务重放 | goal | 人工中断；新增 fixture 抓到生产缺陷 | 407,876 | 8 允许 / 5 拒绝 | `edit` 可用；审批噪音高，拒绝后仍继续申请命令 |
| D1-3 | 审批期间 Ctrl-C 回归 | goal | blocked；`LASTEXITCODE=130` | 2,114 | 0 允许 / 1 拒绝 | 一次中断；1 request / 1 result；零第二次工具申请 |
| D1-4 | 连续拒绝熔断 | goal | blocked/couldNotVerify；`permissionDenied` | 6,660 | 0 允许 / 3 拒绝 | 第三次拒绝后停止；零第四次模型请求 |
| D1-5 | 只读工具路由 | goal | 正确用 `read` 回答；后被无关全量测试 flake 拒绝并中断 | 11,842 | 0 允许 / 1 拒绝 | 初始读取零审批；暴露只读目标验收路由过重 |
| D2 | usage guide 实际更新 | goal | | | | |
| D3 | Known Issues 只读复核 | goal | | | | |

D1 促成四个已验证修复：`268c4ed` 增加 bounded `edit`；`7663cb9` 在 worktree cleanup 前安全解绑已验证的 dependency bridge，并拒绝异常 link 目标；`d85e694` 让进程/readline SIGINT 关闭审批、写入 deny、持久化 blocked 并退出 130；`f8979a6` 让只读定位优先使用免审批工具，并在连续三次拒绝后 fail-closed。D1 的产品结论仍是 PARTIAL，代码修好不代表 goal 自己已经收敛。

**三条门槛自检**：☐ 零 false-verified　☐ 零自然等待/无进展　☐ 零孤儿副作用（每个任务后 `git status`）

三任务跑完后只做一次判断：通过则确认本地 v0.1 可用；出现可修的核心缺口则修复并重放同一任务；仍无法收敛则保持「产品验证中」。只有观察到任务类型差异、结果波动，或需要更高发布置信度时，才扩到 6–10 个任务。

**止损线**：单个 goal token 超过预期上限 3 倍、同类审批连续重复、或出现第二个核心失败信号时立即停止；保留 goal/session/approval 原始记录，修复或裁决后再进入下一个任务。
