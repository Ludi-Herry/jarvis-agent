# v0.1 MVP dogfood 手册（Ludi 执行版）

> 阶段结论（2026-08-31）：三个真实任务已全部执行，阶段 verdict 为 **NO-GO**。交付物均由主线程收口，Jarvis 0/3 自然完成；零 false-verified、零孤儿副作用成立，无进展/长等待门槛失败。TUI、Recall、G5 与所有 post-real-use 扩展继续冻结，项目状态保持「工程完成，产品验证中」。
> 所有命令都从 `H:\jarvis-agent` 跑；每段可整段复制进 PowerShell。
> 前置确认：火山方舟账户有余额（`npm run jarvis -- doctor` 会显示凭据来源）。

---

## Part A · 三个真实任务

任务必须满足一个条件：即使没有这次验收，项目今天也需要完成它。禁止为了跑 agent 制造 inventory、索引、Changelog 占位或随机断言。

| # | 类型 | 当前真实任务 | 状态 |
|---|---|---|---|
| D1 | 代码 + 测试 | 补齐 finalize cleanup 的 `node_modules` dependency bridge fixture；失败时只修真实暴露的根因 | PARTIAL，见文末证据 |
| D2 | 文档修改 | 给 `docs/usage-guide.md` 的 doctor 小节补 `config show / validate` 零成本检查，并同步验收表 | PARTIAL，goal blocked；主线程完成 |
| D3 | 只读审计 | 对照当前源码复核 `KNOWN_ISSUES.md`，只报告仍成立、已过期和缺证据三类 | PARTIAL，run 中断；主线程完成 |

剩余任务按交付物选 primitive：D2 有明确文件改动与检查条件，使用 `goal`；D3 只交付一份当前事实清单，使用 `run + inspect`，人工读完后 `/exit`。

```powershell
cd H:\jarvis-agent
# D2 文档修改
npm run jarvis -- goal "给 docs/usage-guide.md 的 doctor 小节补一段 config show / config validate 的零成本检查，说明前者看生效值、后者查配置错误；同步更新文末验收清单"

# D3 只读审计
npm run jarvis -- --preset inspect --no-tui run --no-recall "逐条复核 KNOWN_ISSUES.md：对照当前源码与测试，只在回复中分成仍成立、已过期、缺少当前证据三类；给出文件和行号，不修改任何文件"
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
| D1-5 | 错误 primitive 重放 | goal | 正确用 `read` 回答；后被无关全量测试 flake 拒绝并中断 | 11,842 | 0 允许 / 1 拒绝 | 只读清单误用 goal；应改走 `run + inspect` |
| D2 | usage guide 实际更新 | goal | blocked/couldNotVerify；主线程按实跑输出完成 | 25,015 | 0 允许 / 3 拒绝 | 错误草稿原样重提，取证命令含无效 Windows Bash 路径与 `npx` fallback |
| D3 | Known Issues 只读复核 | run + inspect | 5 分钟无结果后中断；主线程完成 14 条复核 | ≥4,837，researcher 未计量 | 0 | read 后自动委派 researcher，长等待无输出 |

D1 促成四个已验证修复：`268c4ed` 增加 bounded `edit`；`7663cb9` 在 worktree cleanup 前安全解绑已验证的 dependency bridge，并拒绝异常 link 目标；`d85e694` 让进程/readline SIGINT 关闭审批、写入 deny、持久化 blocked 并退出 130；`f8979a6` 让只读定位优先使用免审批工具，并在连续三次拒绝后 fail-closed。D1 的产品结论仍是 PARTIAL，代码修好不代表 goal 自己已经收敛。

D3 由主线程逐条复核后的分类为：仍成立 14、已过期 0、缺少当前证据 0。证据覆盖 cron lock、human-review 本地 JSONL、Bash session grant、usage coverage、managed write、Session composition/path、goal/loop/cron loader 与 completion 测试；具体实现入口继续由 `KNOWN_ISSUES.md` 每条末尾的路径负责。

**三条门槛自检**：☑ 零 false-verified　☒ 零自然等待/无进展　☑ 零孤儿副作用（每个任务后 `git status`）

### 阶段 verdict：NO-GO

- 产品结果：三个真实交付物都已完成，完成者为主线程；Jarvis 没有自然完成任一任务。
- 安全结果：没有 false-verified，没有无关文件或未决副作用。
- 体验结果：D1 高 token 与多审批，D2 无法从无理由拒绝中纠正文案，D3 只读 researcher 长时间无输出。
- 下一阶段只处理收敛与成本：优先解决只读委派长等待、拒绝反馈信息不足和大文件读取成本。未关闭前不扩样、不启 TUI/Recall/G5、不新增产品能力。

**止损线**：下一阶段若同一核心质量信号再次失败，停止逐点补丁，先写共同 Owner 与一次性修复提案。

---

## Part F · 收敛与成本阶段

### 目标

关闭三个已经由真实任务暴露的摩擦：委派长等待、无理由拒绝无法纠偏、大文件整读成本高。完成后继续维持当前 MVP 范围，不扩大任务样本。

### 非目标

- 不新增路由、调度、缓存、索引或其他抽象层。
- 不启用 TUI、Recall、G5、Reminder、工具目录、Council、OpenUI 或新产品表面。
- 不修改既有三次真实任务的历史 verdict。

### 验收标准

| # | 切片 | 完成条件 |
|---|---|---|
| F1 | 委派有界返回 | `task` 委派到达墙钟期限后返回明确错误；父级中断仍立即生效；无孤儿子运行。 |
| F2 | 拒绝理由回传 | 行模式支持 `d <reason>`；理由经过长度和单行边界处理后进入模型工具结果与审批审计；单独输入 `d` 继续兼容。 |
| F3 | 文件分段读取 | `read` 支持按起始行和最大行数读取；默认整读行为保持兼容；结果包含可继续读取的位置提示。 |

每个切片最多新增一条主路径测试和一条关键失败路径测试。全部定向测试、typecheck、lint、全量测试与 build 通过，工作区只保留本阶段交付文件，阶段才算完成。

### 当前证据与停止线

- F1 来自 D3：researcher 五分钟无输出，父任务只能人工中断。
- F2 来自 D2：拒绝错误草稿后，模型没有收到原因并原样重提。
- F3 来自 D1/D3：模型为定位少量信息多次整读大文件，增加上下文和 token 成本。
- 同一切片的核心质量信号再次明确失败时，停止追加局部补丁，先记录共同 Owner 和一次性修复边界。

### 实现与验证证据

| # | 实现结果 | 验证结果 |
|---|---|---|
| F1 | `SubagentManager` 给一次委派增加 120 秒总墙钟期限；超时会中断组合信号。只读角色向父模型返回明确错误；带副作用角色保留 `executionUnknown` 并停止父任务。 | 红测先在 252ms 后返回；修复后 20ms 配置在 150ms 门槛内返回，子信号已中断。subagent 定向 17/17 通过。 |
| F2 | 旧审批字符串继续兼容；行模式新增 `d 理由`。理由净化成单行并限制 240 个 Unicode 字符，随后进入 PermissionGate 错误、审批事件和 JSONL 审计。 | 审批定向 44/44、关联回归 45/45 通过。真实 Session `2026-08-31T09-13-39-546Z` 中，拒绝理由进入 tool receipt、tool message 和下一轮模型回复；目标文件未生成。 |
| F3 | `read` 同时接收 `startLine` / `maxLines` 时返回最多 1000 行的范围、完整文件 version 和下一段提示；省略范围时保留原始完整输出。 | builtins/registry 定向 40 passed / 1 skipped，CRLF 保留和越界提示均有覆盖；build 后 registry 实跑返回 `KNOWN_ISSUES.md` 第 1–2 行并提示从第 3 行继续。 |

完整门禁：151 个测试文件，1737 passed / 2 skipped；`typecheck`、`lint`、`build`、`git diff --check` 全部通过。F1 的默认 120 秒不做真实等待实验，确定性短时钟覆盖同一生产路径，避免为验收消耗两分钟模型时间。

### 阶段 verdict：ENGINEERING GO，产品复验待后续真实任务

- 三个已知摩擦都有最小实现、失败前置红测和当前门禁证据，阶段合同已完成。
- Part E 的三任务 NO-GO 保持原样；本阶段没有重放三任务，也不把工程绿灯改写成产品达标。
- TUI 视觉验收与真人验收继续暂停；Recall、G5 和 post-real-use 扩展继续冻结。
- 下一次真实维护任务优先观察三项行为是否自然生效。出现同类核心失败时按本节停止线处理，不立即扩到 6–10 个样本。

---

## Part G · 单任务产品复验

### 范围与任务

只跑一项当前确有价值的只读维护任务：`KNOWN_ISSUES.md` 已因 Part F 更新，需要重新核对每条保证边界与当前源码是否一致。使用 `run + inspect + no-recall`，不新增功能，不制造验收文件，不修改仓库。

```powershell
npm run jarvis -- --headless --preset inspect run --no-recall "逐条复核 KNOWN_ISSUES.md：对照当前源码与测试，只在回复中分成仍成立、已过期、缺少当前证据三类；给出文件和行号，不修改任何文件"
```

### 成功与停止条件

- 一次运行在五分钟内自然返回；不靠 Ctrl-C，不发生无输出长等待。
- 零审批、零写入、零工作区漂移；最终分类可由主线程抽查。
- 记录 turns、tokens、工具序列、终态与一条摩擦，不扩到第二项。
- 若再次出现同类长等待或无进展，停止重放和局部补丁，写共同 Owner、同构绑定与一次性解耦提案后交回裁决。

### 复验结果：NO-GO，停止线已触发

- Session：`2026-08-31T09-30-46-404Z`。五分钟停止线时仍无最终分类；中断在第 14 个请求开始后，Session v2 integrity 完整且 pending tool effects 为 0。
- researcher 按新合同在 120 秒自动超时，父模型无需人工解除委派；随后父模型继续取证。F1 的有界返回有效，整体任务仍未收敛。
- 父模型完成 13 个回合，可见用量至少 837,438 input + 2,913 output = 840,351 tokens；researcher 未计量。
- 工具调用 47 次：read 18、grep 27、task 1、bash 1。Bash 被 inspect preset 拒绝；没有人工审批，没有项目文件写入，Git 工作区无漂移。
- 分段 read 被自然使用，F3 有效；两次宽泛 grep 仍生成合计 3,117,496 字节的 `data/tool-results` 运行期证据。
- 同类“无最终结果 + 高成本取证”再次出现，按停止线不重放、不加局部补丁。系统性方案见 [Inspect 收敛修复提案](PLAN-inspect-convergence.md)，等待 Ludi 裁决。

---

## Part H · Inspect 最小系统修复

Ludi 批准后只实施提案约定的三项：inspect 只暴露 read/grep；证据不足直接分类且默认 8 回合；grep 增加 1000 字符单行预览与 32,000 字符总输出上限。代码提交为 `4db4d3f`、`5c78930`，没有新增 route/map/manager 或产品表面。

最终工程门禁为 151 files / 1740 passed / 2 skipped，typecheck、lint、build 与 diff check 全绿。唯一重放 Session `2026-08-31T13-10-36-797Z` 的结果：76.542 秒、243,370 tokens、30 次工具（read 15 / grep 15）、零 denied、零审批、零 offload、零项目写入；Session 无 pending effect，Git 工作区无漂移。

### 阶段 verdict：ENGINEERING GO / PRODUCT NO-GO

相较前次 canary，tokens 下降约 71%，工具调用下降约 36%，多 MB offload 清零。模型仍在第 8 回合选择继续取证，最终 `maxTurns` blocked，没有返回分类答案，同时超过 20 次工具门槛。按预先合同停止同类修复和再次重放；原 v0.1 产品 NO-GO 保持有效。

---

## Part I · 冻结模型对照 Spike

Ludi 于 2026-09-01 指定 `deepseek-v4-pro-ga-260813`。实验冻结 commit `63e53cb`、同一 prompt、inspect 的 read/grep 工具表、8 回合和 Part H 阈值；只通过 CLI `--model` 覆盖，继续使用现有 ARK baseURL 与凭据路径，没有修改配置文件或代码。

Session `2026-08-31T19-36-02-590Z` 在约 45 秒、7 回合后自然完成：179,705 input + 2,114 output = 181,819 tokens；16 次工具（grep 11 / read 5）；零 denied、零审批、零 offload、零项目写入。Session v2 integrity 完整，pending tool effects 为 0，Git 工作区无漂移。

最终回复为 2463 字符，逐条给出 14 条“仍成立”、0 条“已过期”、0 条“缺少当前证据”，与前期主线程复核一致。Cron lock、usage partial、managed write、Session append、resume precheck、non-Session JSONL、review 入口与 completion 等抽查引用均能在当前源码/测试定位。

### 阶段 verdict：MODEL TASK FEASIBILITY GO / PRODUCT NO-GO / ADOPTION HOLD

冻结阈值全部通过，说明同一 harness 下模型能力是前两次收敛失败的重要变量。单个只读任务仍不足以改写原三任务 0/3 和 v0.1 产品 NO-GO。协议诊断确认：ARK GA 在 `thinking=disabled + tools` 时把取证思路及 `</think>` 放进 content；单次 `thinking=enabled` 探针则返回独立 reasoning、零正文与正常 tool call。详见 [DeepSeek 思考流协议诊断](ANALYSIS-deepseek-v4-pro-ga-thinking.md)。在 thinking 模式策略通过完整 canary 前，不改默认模型，也不继续写任务复验。
