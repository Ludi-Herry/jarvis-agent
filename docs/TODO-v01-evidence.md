# v0.1 收口待办手册（Ludi 执行版）

> 状态（2026-08-24）：Recall A/B 与真实任务已获 Ludi 放行。本手册是唯一执行入口：按 Part B（便宜）→ Part A 试点 2 个 → 全量的顺序推进，边做边在文末证据表打勾。
> 所有命令都从 `H:\jarvis-agent` 跑；每段可整段复制进 PowerShell。
> 前置确认：火山方舟账户有余额（`npm run jarvis -- doctor` 会显示凭据来源）。

---

## Part A · 真实任务证据（goal 模式，10–14 个）

**跑法**：每个任务一条命令，跑完把 goal 结果（verified / parked / rejected）记进文末证据表。终端里改文件的请求会弹审批（y/n）——**这就是 G5 的体感采样，顺便记下审批打断的感受**。跑歪了随时另开终端 `npm run jarvis -- stop`，或点 GUI 急停。

**成绩单口径**（v0.1 门槛，全量跑完必须三条全零）：

- 零 false-verified：标了 complete/verified 的任务，产出实际是对的（你抽查）；
- 零无限等待：每个任务都正常收尾或明确停下，没有挂死；
- 零孤儿副作用：跑完 `git status`，改动只属于该任务，没有多余文件。

任务清单（已按真实维护需求拟好，前 2 个是试点）：

```powershell
cd H:\jarvis-agent
# A1（试点）只读统计：goal 会读 data/goals/ 并报告状态分布
npm run jarvis -- goal "统计 data/goals/ 下所有 goal 记录的最终状态分布（complete/blocked/parked 等各多少个），只在回复里给出数字清单，不写任何文件"

# A2（试点）小写入：goal 会请求写一个新文档（弹审批）
npm run jarvis -- goal "统计 test/ 目录每个子目录的测试文件数，把结果写成 markdown 表保存到 docs/test-inventory.md，表外不要加多余内容"

# A3 只读审计
npm run jarvis -- goal "审查 KNOWN_ISSUES.md 的每一条，对照当前仓库状态判断仍然成立还是已过期，回复里输出两栏清单，不改文件"

# A4 只读审计
npm run jarvis -- goal "对照 AGENTS.md 的命令清单与 package.json 的 scripts，找出两者口径不一致的地方，回复里列清单，不改文件"

# A5 文档补全（写 + 审批）
npm run jarvis -- goal "给 docs/usage-guide.md 的 doctor 小节补一段 config show / config validate 的零成本检查，说明前者看生效值、后者查配置错误；同步更新文末验收清单"

# A6 只读
npm run jarvis -- goal "找出 docs/ 中所有引用 data/a0/run/（v1 旧产物）的段落，回复里列文件与行号清单，不改文件"

# A7 小写入
npm run jarvis -- goal "如果 A2 已生成 docs/test-inventory.md，把它作为日期化生成快照加入 docs/README.md 的正确分类；只改 docs/README.md"

# A8 只读
npm run jarvis -- goal "扫描 src/ 中超过 300 行的 .ts 文件，按行数从大到小列出文件与行数，不改文件"

# A9 文档更新（写 + 审批）
npm run jarvis -- goal "如果 A2 与 A7 都完成，在 CHANGELOG.md 的 Unreleased 中补一条 test inventory 与文档地图入口；只改 CHANGELOG.md"

# A10 只读交叉核对
npm run jarvis -- goal "列出 package.json scripts 中从未被 docs/ 任何文档提及的脚本，回复里给清单，不改文件"

# A11 只读审计
npm run jarvis -- goal "检查 docs/handoff-*.md 每篇的顶部状态行，找出声称未完成但实际已完成的切片，回复里列清单，不改文件"

# A12 小代码改动（改源码，审批会更严）
npm run jarvis -- goal "给 test/cli/stop-cli.test.ts 补一条断言：stop --json 输出包含 auditPath 字段，先跑该测试文件确认通过"

# A13/A14（可选，从上面换个类型再加）
npm run jarvis -- goal "把 docs/usage-guide.md 第 8 节验收清单按需要模型 key 与不需要分成两组，在表里加一列标注"
```

**每个任务跑完记四样**：goal 状态、token 数（goal 输出或 `npm run jarvis -- status` 里看）、审批次数、你的体感一句话。

---

## Part B · Recall A/B 对照（run 模式，4 对 8 个小会话，便宜，先跑这个）

**原理**：Recall 给 agent 搜索过往会话的能力（默认开；`--no-recall` 关掉）。A/B = 同一个提问，A 组能翻历史、B 组只能靠读仓库文档，比较答案质量与成本。

**跑法**：每条都是一个独立短会话，问完 `/exit` 退出。先跑全部 A 组，再跑全部 B 组（或交替）。判断答案对不对，你对着 `docs/handoff-next.md` 相应条目看即可。

```powershell
cd H:\jarvis-agent
# A 组（Recall 默认开）
npm run jarvis -- run "GA 两项故障注入测试分别防的是上游哪两个事故？一句话各说清"
npm run jarvis -- run "stop 切片的 P2（默认 reason 与 help 不一致）最终是怎么修的？"
npm run jarvis -- run "G3 验证时发现的 textarea 问题是什么、怎么修的？"
npm run jarvis -- run "本仓库 stop 切片一共几个 commit，各自做了什么？"

# B 组（关 Recall）
npm run jarvis -- run --no-recall "GA 两项故障注入测试分别防的是上游哪两个事故？一句话各说清"
npm run jarvis -- run --no-recall "stop 切片的 P2（默认 reason 与 help 不一致）最终是怎么修的？"
npm run jarvis -- run --no-recall "G3 验证时发现的 textarea 问题是什么、怎么修的？"
npm run jarvis -- run --no-recall "本仓库 stop 切片一共几个 commit，各自做了什么？"
```

**每组记三样**：答案正确性（对/半对/错）、耗时体感、token（`npm run jarvis -- status` 的 usage 区）。跑完把表发给你的主会话（ZCode），我来出对照结论。

---

## Part C · 你的两项验收（零成本）

**C1 · CLI 零成本验收**：照 `docs/usage-guide.md` 第 8 节清单跑 1–13 项，每项对上「通过标准」就打勾。约半小时，不需要模型 key。

**C2 · TUI renderer 的 TTY 视觉验收**（需要 key，配合任一 Part B 会话一起看）：

```powershell
cd H:\jarvis-agent
npm run jarvis -- run
```

进 TUI 后检查五点：① 全屏布局与信息层级；② 折叠/展开行为；③ 键位提示是否可见可懂；④ 发一条消息看 model-running/tool-running 状态流转；⑤ Esc 与双 Ctrl-C 的停止路径。你的观感（布局、字号密度、键位手感）直接记成一句话清单，交回主会话。

---

## Part D · G5 决策门（跑完 Part A 后填）

G5 = GUI 审批中继（把终端审批搬到 GUI 弹窗），全计划最重的一片。**默认不开**，用 Part A 的体感数据决策：

- 开的信号：Part A 里你 ≥3 次觉得「跑去终端按 y 打断了我在做的事」，或你开始因为怕审批打断而回避跑 attended 任务。
- 不开的信号：审批频率低（每个任务 1–2 次）、你在 GUI 时间线上看到运行状态已经足够安心。

你的决策：☐ 开　☐ 不开　依据一句话：＿＿＿＿

若选「开」，把这段发给 Codex 会话：

```text
Ludi 拍板开启 G5（GUI 审批中继）。这碰运行进程与 GUI 的桥接，属于重架构切片：先出设计文档（docs/PLAN-g5-*.md，含桥接方式、权限边界、超时与回退、安全审查点），经 Ludi 批准后再动代码。硬边界不变（规划附录 prompt 全部适用），完成后仍按节交 Ludi 验收。
```

---

## Part E · 证据表（边跑边填，跑完交回主会话）

| # | 任务/提问 | 模式 | 状态/答案 | tokens | 审批次数 | 体感一句话 |
|---|---|---|---|---|---|---|
| A1 | goal 状态分布 | goal | | | | |
| A2 | test-inventory | goal | | | | |
| … | | | | | | |
| B1-A | GA 注入测试 | run | | | | |
| B1-B | 同上 no-recall | run | | | | |

**三条门槛自检**：☐ 零 false-verified　☐ 零无限等待　☐ 零孤儿副作用（每个任务后 `git status`）

**跑完之后**：把本文件交回 ZCode 主会话——我出 Recall A/B 对照分析 + 真实任务成绩单（park 率、人工接管率、token/任务），连同 v0.1 门槛判定一起收口进 handoff 文档；发现问题就转修复切片交 Codex。

**止损线**：单个 goal 任务 token 超过你预期上限的 3 倍仍没收敛 → `stop`，记入证据表，先交回分析再继续。
