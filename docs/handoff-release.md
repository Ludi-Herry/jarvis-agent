# 历史交接：GUI-first v1 路线与 R1-R9 验收证据

> 读者：接手本阶段的新 agent。日期：2026-07-03。
> 2026-08-12 路线已改为 CLI-first，当前计划见 `docs/cli-first-plan.md`。本文保留 2026-07-03 的 GUI-first 决策、R1-R9 证据与安全边界，供审计和回溯。
> 当前系统状态以 `docs/handoff-next.md` 为准（本文不重复它）；安全审查方法与历史见 `docs/security-review-baseline.md`。

## 0. 拍板背景（2026-07-03，为什么是这个顺序）

- 验收侧已全线就绪：确定性三腿 + trusted requirements（sandbox-command/llm/human）+ held-out + `decideVerdict` 零信任链；2026-07-03 最终本地四关卡全绿，`npm test` = 102 files / 1060 passed / 1 skipped。
- 切片 2 前，行动侧的 write 结构性封死：`--unattended` 无 approver，gate 对一切 `ask` fail-closed deny；goal/loop CLI 不加载 RuleResolver（`loop-cli.ts` 用裸 `defaultPolicy()`），所以无人值守下 builder 写不了任何文件。2026-07-03 已补一条收窄例外：`--unattended --parallel` 的 per-goal gate 只自动放行落在该 goal worktree 内的 built-in `write`。
- GUI human-review 能力层/API 已按真实 parked sample 的需求落地；2026-07-03 已把内置 Browser 失败的 `window.prompt` 裁决入口改成页面内联表单，并完成真实 audit / verdict 验收。
- 结论：只读巡检、worktree 隔离写、GUI 裁决流和 R7 安全 HIGH 修复均已收口；发布前剩 GUI UI/UX 打磨与 Luis 验收。

## 1. 发布定义（Definition of Done，全局终线）

v1 可发布 = 以下每条都有**可验证证据**（跑过的命令 / 截图 / 审计记录），缺一不可：

| # | 条件 | 验证方式 |
|---|---|---|
| R1 | 四关卡全绿：`npm test` / `npm run typecheck` / `npm run lint` / `npm run build` 0 失败 | CI 或本机输出 |
| R2 | 无人值守只读巡检在真实任务上连续 ≥5 次 cron 运行：0 false-verified、0 失控（每次要么正常完成要么 park/halt 且原因可解释） | `data/` JSONL + `npm run observe` 报告逐次核对 |
| R3 | 急停演练 ≥1 次：GUI 按钮按下后，运行中的 loop 在一个轮询周期内中断且审计留痕 | `data/control/emergency-stop.jsonl` + loop halt 记录 |
| R4 | 无人值守写码切片（worktree 隔离 write）落地并通过 codex 对抗审查（无未缓解 HIGH） | 审查记录追加进 `security-review-baseline.md` |
| R5 | GUI human-review 裁决流可用：human route 的 parked requirement 能被人工裁决、回写 verifier report、留 audit trail | 端到端真实 goal 演示一次。2026-07-03 内置 Browser 已复验：`data/human-reviews/g-human-gui-smoke.jsonl` 写入 audit，goal `complete / verified` |
| R6 | GUI UI/UX 打磨完成且 Luis 逐节验收通过（视觉层级、文案、空态/错误态、响应式） | 每节验收记录（见切片 4） |
| R7 | GUI server 安全修复落地（Host 校验等，见切片 0），且对 GUI 控制面做过一轮安全审查 | 同 R4。2026-07-03 已修 human-review provenance spoof 与 `loop:finalize` false-positive merge 系列 HIGH（goal/session/human audit/diff hash/patch hash/latest attempt），最终 codex 复审 `HIGH? no`，见 `docs/security-review-baseline.md` |
| R8 | 文档一致：README、`docs/handoff-next.md`、本文状态段与实际行为无出入 | neat-freak 式核对 |
| R9 | 发布检查单走完（版本号、changelog、已知问题清单） | `package.json` / `package-lock.json` version `0.1.0`，`CHANGELOG.md`、`RELEASE_NOTES.md`、`KNOWN_ISSUES.md` |

**发布动作本身（npm publish / git push / 对外公开）是人工红线，永远等 Luis 明示，agent 不得代做。**

## 2. 全局边界（先读，贯穿所有切片）

继承 `docs/handoff-next.md`「别破的不变量」全文，另加本路线图自己的红线：

- **完成授权唯一来源不变**：`observe` 只能观测；GUI human-review 只能写入人工裁决证据并交回 `decideVerdict`。任何 GUI/API 新代码都不能绕过 deterministic checks、trusted requirement routes、人工确认和 `decideVerdict` 生成 verified/complete。
- **四套 map 是抽象上限**：不新增第 5 套 map、不新增 verifier/route/scheduler 抽象。本路线图所有切片都必须在现有抽象内实现。
- **不做清单继续有效**：propose_skill 不做；enterprise 化（connector 矩阵、组织平台、自动长期记忆）不做；cron daemon 不自动 resume/merge/cleanup。
- **unattended bash / vision 保持 fail-closed**，本路线图任何切片不得放开。切片 2 只放开 worktree 内 write，边界见该节。
- **对抗式审查一律用 codex CLI**（跨模型对抗，实现者是 Claude 所以换族才有价值）；禁用 Claude 子代理互审替代。方法与严重度尺子按 `security-review-baseline.md`。
- **写 guardrail 必配走真实接线的触发单测**（component 级测试挡不住「接线后不可达」，VerifierMonitor 教训）。
- 改动只允许修 bug、收窄边界、补文档、按本文切片推进；不顺手重构、不动无关文件。

## 3. 切片计划

依赖关系：切片 0 独立立即做；切片 1 与切片 2 可并行（1 只读不碰权限层，2 动权限层）；切片 3 依赖 1 产出的真实 parked goals（最好也等 2，样本更丰富）；切片 4 依赖 3（界面全量后才打磨）；切片 5 收尾。

### 切片 0：GUI server 安全修复（小，已完成 2026-07-03）

**目标**：堵掉 2026-07-03 分析发现的两个 GUI server 安全面。

**已完成**：
1. `gui-server.ts` 校验 `Host` 头：仅接受 `127.0.0.1[:port]` / `localhost[:port]` / `[::1][:port]`，不匹配一律 403——堵 DNS rebinding 读取 `/api/observation`（内含审批命令预览、sandbox evidence stdout/stderr）。
2. GUI 控制 POST 加最小 CSRF 防线：`POST /api/emergency-stop` 与 `POST /api/human-reviews/:goalId/decide` 都要求自定义请求头 `x-jarvis-gui: 1`，前端 `app.js` 已同步携带。简单表单 POST 无法携带自定义头，可挡住跨站触发。
3. `--host` 绑定非 loopback 地址时启动打印醒目警告（无认证、observation 数据和急停控制面都暴露），README / handoff 已同步说明。

**边界**：不做登录/鉴权体系、不上 HTTPS、不改端口探测逻辑。

**验收**：`test/surfaces/gui/gui-server.test.ts` 覆盖伪造 Host 的请求 403、缺自定义头的 POST 被拒、正常 GUI 流量不受影响。四关卡仍需在本切片收尾时跑全量。

**对抗审查**：改动小，并入切片 2 或 3 的 codex 审查一起过即可，不单独开轮。

### 切片 1：无人值守只读巡检试点（真实负载淬火）

**目标**：把已就绪的机制（trusted requirements、cron:daemon、observe、GUI、急停）放到真实任务上连续运行，产出运行证据和真实 parked goals 样本。这是 R2/R3 的来源。

**回路合同（五件套，开跑前逐条落实）**：
- 触发条件：`npm run cron:daemon -- --cron-map <cwd外 JSON>`，任务 `unattended: true`，间隔建议 ≥ 每日一次。
- 作用范围：只读目标（示例：仓库审计——docs 与代码一致性巡检、`--fail-on-worktree-change` 的 no-edit 验证类目标、依赖漂移报告）。builder 可用工具 = read/grep/sandboxed_check/browser_smoke/update_goal；write/bash/vision 保持 deny。
- 行动预算：沿用 loop 六条数值硬停止；每 goal maxRounds/token 上限在 objectives 文件里显式写。
- 停止条件：正常排空 / 数值硬停 / 裁判健康断路 / 急停。任何一种都必须在 JSONL 里有可解释记录。
- 汇报路径：`npm run observe -- --json` + GUI 时间线；每次运行后人工（或下一个 attended 会话）核对一次「observe 报告 vs 实际」。

**待办**：
1. 挑 1-2 个真实巡检目标，写 objectives 文件 + cwd 外 trusted requirements（能用 `sandbox-command`/`heldOutCommands` 验收的优先；预期会 park 的 `human` route 条目**刻意保留**，它们就是切片 3 的需求样本）。
2. 跑通首次端到端，然后交给 cron:daemon 连续跑。
3. 做一次急停演练（R3）。
4. 每次运行的偏差（observe 与实际不符、事件缺失、时间线可读性问题）记进一个 `docs/` 下的试点问题清单，喂给切片 3/4。

**2026-07-03 试点记录**：见 `docs/gui-readonly-pilot-notes.md`。首次试点产出 1 条 trusted loop parked sample、1 条 cron due scan sample、1 次 GUI 急停触发证据，并暴露 cron 不能传 `--goal-setter-requirements-map`、急停后 loop JSONL 缺 terminal record、GUI cron 卡片重复等问题。随后已修 cron requirements map 传递与急停 terminal record，并完成 R2/R3 实证：`r2-readonly-20260703-124756` 真实间隔 cron daemon 成功 6 次，false verified `0`；R3 loop `2026-07-03T20-01-28-688Z` 通过内置 Browser 急停后写入 `loop-halted emergency-stop`。

**边界**：不为试点新增任何 harness 功能；发现 bug 记录后单独修，不在试点分支顺手改。

**验收（防作弊显式条款）**：R2 的 5 次运行必须是**真实间隔的 cron 触发**，不许用一次性脚本连跑 5 遍冒充；0 false-verified 的判定以人工抽查 verifier report 与实际仓库状态对照为准，不以 loop 自身记录为准。

### 切片 2：无人值守写码解锁（worktree 隔离 write，实现完成 2026-07-03）

**目标**：让 `--unattended` loop 能写代码，同时保持「宿主真实工作树在人工 merge 前零改动」。这是通往可用产品的关键一步，动 permission 层，安全要求最高。

**方案骨架（积木已齐）**：`--parallel` worktree 切片已有隔离执行环境；finalize `--merge` 已是人工交互收口；shadow-git、worktree baseline audit 已可观测。缺的只是一条受限 allow：**unattended 模式下，write 类工具的目标路径 realpath 后落在该 goal 的 worktree 根内 → allow；否则维持 ask→deny**。sensitive-path deny 永远前置。

**设计必须回答的问题（进 codex 审查的 checklist）**：
1. worktree 内 `.git` 文件（gitdir 指针）及一切 git metadata 必须在 allow 范围外——写它等于改宿主仓。
2. symlink / `..` / Windows `\\?\` 前缀逃逸：realpath 规范化在判定前做（hooks 切片已有先例，复用其手法）。
3. builder 改写 `package.json`/`Makefile` 会改变 `sandboxed_check` 的语义（TOCTOU 的写码变体）：确认 check-oracle 篡改检测（腿 2）在 worktree 模式下覆盖这些文件，不覆盖则补。
4. merge 闸不动摇：唯一回到宿主工作树的路径是 `loop:finalize --merge` 人工交互（verified + tracked diff）；unattended 任何路径不得触碰宿主树。
5. bash / vision 在 unattended 下继续 fail-closed，本切片零放开；审查时显式验证没有顺带解锁。

**已完成**：
1. 设计文档：`docs/superpowers/plans/2026-07-03-unattended-worktree-write.md`。
2. 权限实现：`DefaultPermissionGate` 新增 `goalWorktreeWriteRoot`；只在 policy 得到 `ask` 后检查 built-in `write`，literal path 与 effective realpath 都必须留在 goal worktree 内；`.git`、nested `.git`、sensitive path、`..`、绝对路径、Windows namespaced path、symlink/junction escape 全拒绝。
3. loop 接线：`loop-cli` 只在 `parallelMode && unattended` 的 per-goal gate 注入 `goalCwd`；shared gate、goal-cli、REPL 都不拿这个 root。bash / vision / network / unknown write-like tools 保持 fail-closed。
4. 执行层兜底：`safeResolve` 也拒绝 git metadata；`writeTool` 额外拒绝 `.git` 写入。
5. worktree 运行可用性：goal worktree 创建 / resume 时，如果宿主有 `node_modules`，会在 worktree 内创建 `node_modules` junction/symlink 指向宿主依赖，供 deterministic checks 使用；read/write/grep 通过 realpath 仍不能跟随该链接读写宿主依赖。
6. 测试：新增 worktree gate、runAgent 真实接线、loop-cli 布线、safe-path、builtins、loop-worktree 触发测试。切片 2 当时四关卡：`npm run typecheck`、`npm run lint`、`npm test`（101 files, 1034 passed, 1 skipped）、`npm run build` 全绿。
7. codex 对抗审查：两轮 gpt-5.5 xhigh，只读。第一轮覆盖 worktree write auto-allow，no HIGH；第二轮覆盖 `node_modules` dependency bridge，no HIGH。第二轮 LOW 的 write/grep bridge-specific 测试已补；finalize + `node_modules` link patch fixture 仍为 LOW 待补。
8. 真实模型 smoke：`npm run loop -- <temp-objectives> --unattended --parallel 2 --worktree-root <temp>` 已跑多轮。证据：built-in `write` 在 goal worktree 内成功；bash 请求被无 approver 拒绝；宿主 `git status --short` 前后一致。第一轮暴露新 worktree 缺 `node_modules`，已补 dependency bridge；第二轮 1/2 goal verified complete，另 1/2 被模型排查绕行后 blocked；第三轮未限制 Vitest worker，两个 worktree 同时跑全量 `npm test` 触发 CLI smoke 5s 超时，单独在失败 worktree 重跑 `npm test` 通过。稳定全绿轮：`2026-07-03T17-06-40-512Z` 使用同一 loop 形态并设 `VITEST_MAX_WORKERS=1`，2/2 goals `verified` + `complete`，每个 worktree 的 `typecheck/lint/test/build` 均 code 0，宿主零漂移。

**边界**：不做通用规则引擎、不接 RuleResolver 进 loop-cli（那是另一个信任面）、不放开 worktree 外任何路径、不自动 merge。

**验收状态**：R4 已达标。权限实现、codex 审查、宿主零漂移、无人值守 worktree write all-goal green smoke 均已有真实证据；后续只剩 LOW 级 finalize + `node_modules` link patch fixture 可补。

### 切片 3：GUI human-review 裁决流（MVP 已实现 2026-07-03）

**目标**：把 `human` route 的 park 变成闭环——人工在 GUI 裁决 parked requirement，结果回写 verifier report，留完整 audit trail。这是 handoff-next.md 明确的产品流缺口，R5 的来源。

**设计输入**：切片 1/2 产出的真实 parked goals（不许凭空虚构场景设计界面）；`ai-presence-intervention-levels` memory 的分级介入只作交互参考，**安全闸不适用「置信度高就少问」**。

**硬边界（安全不变量）**：
- 人工裁决是**新证据来源**，汇入 verifier report 后仍由 `decideVerdict` 纯函数出 verdict；GUI 自己永远不产生 verified/complete。
- 裁决动作必须有身份/时间/理由三要素落 JSONL 审计；裁决展示给人的字段必须剥控制字符、换行和 bidi 控制符，审批工具详情继续沿用 `safeInline` + tool-aware `detailOf` 三件套。
- 裁决接口在 GUI server 上属于控制面：切片 0 的 Host/CSRF 防线必须先落地；裁决 POST 同样要求自定义头。
- resume/重跑语义想清楚：已裁决的 requirement 在 goal 重跑后是否复用？（建议：不复用，重跑重裁，宁可多问不静默继承。）

**已完成**：
1. 能力层：新增 `src/capabilities/goal/human-review.ts`，扫描 parked `human` requirements，校验 goalId 安全文件名，裁决展示字段剥控制/bidi，裁决备注做 secret redaction，并追加 `data/human-reviews/<goalId>.jsonl` 审计。
2. Verifier report 闭环：人工 approve/reject 会写入新的 verifier evidence，更新对应 requirement score，追加新的 `goal-round` + `goal-state`，最终 verdict 只由 `decideVerdict` 产生。
3. Loop finalize 可见：若 parked goal 属于 loop，会补写新的 `goal-finished` 记录，`loop:finalize` 可看到 reviewed 后的 latest finish state/outcome。
4. GUI API：`GET /api/human-reviews` 列表；`POST /api/human-reviews/:goalId/decide` 复用切片 0 的 loopback Host 校验，并要求 `x-jarvis-gui: 1`。
5. GUI UI：首版人工裁决队列展示 goal / requirement / reason，支持单条通过或驳回并填写备注；备注输入当前依赖 `window.prompt`。
6. 测试：`test/capabilities/goal/human-review.test.ts` 覆盖列表、approve、reject、audit、loop finish；`test/surfaces/gui/gui-server.test.ts` 覆盖 API、CSRF 和编码路径穿越拒绝。

**仍待补**：切片 4 中继续打磨裁决表单体验、键盘可达性、错误态和证据详情密度；发布前让 Luis 做逐节 UI/UX 验收。

**边界**：单用户本地场景；不做多人协作、不做 agent identity、不做通知系统。

**验收状态**：R5/R7 已过当前非 UX 阻塞线。单元/API 层证明 parked requirement 可裁决、report 可回写、audit trail 可回放、伪造 CSRF 与编码路径穿越被拒；内置 Browser 已复验页面内联备注表单，备注跨 auto-refresh 保留，提交后 `data/human-reviews/g-human-gui-smoke.jsonl` 写入 audit，goal 变为 `complete / verified`。R7 已修：human-review 只接受 trusted `route: "human"` 的 pinned requirement；`loop:finalize` 在 proposal 前交叉验证 latest attempt、goal/session、最终 state/outcome、human-review audit 与 tracked diff hash，merge apply 前重算 patch hash。

### 切片 4：GUI UI/UX 打磨

**目标**：以 Luis（UI/UX 设计师，产品唯一用户）的标准把 GUI 从「晴天模式外壳」打磨到可日常使用。R6 的来源。

**设计输入（2026-07-08，Tutti 对照分析）**：信息架构从「按时间」转成「按注意力优先级」——总控台先回答「需要我干什么」，再回答「发生了什么」。页面分区自上而下：① 等你决定（待审批、parked human reviews、halted/blocked goal，数量徽标化）；② 正在跑（round/budget 进度）；③ 刚完成待过目（verdict + diff 摘要 + 产物路径，产物导向）；④ 完整时间线收进底部或详情抽屉。observe contract（schemaVersion 1）现有字段已覆盖全部四区，纯前端重排，不新增事件或 API。验收标准：打开 GUI 三秒内知道要批什么。

**范围清单（以现状缺口为准，实施时按走查结果增删）**：
- 信息层级：时间线混排 loop/goal/审批/沙箱/cron 多种事件，需要视觉分组或过滤；关键状态（halted/blocked/park）要一眼可辨。
- 空态与错误态：`data/` 无记录时的引导文案；server 断连时的明确反馈（当前 `app.js` 只把错误塞进「更新时间」一角）。
- 急停体验：按下后的状态转换要即时可见（Armed→Stopped 的视觉权重）、解释「新运行不受旧停机影响」的机制，避免误解为坏掉。
- 裁决流（切片 3 产物）的表单体验、键盘可达性。
- 响应式与主题：至少桌面窗口尺寸自适应；暗色模式按需。
- 中英文混排、时间格式、数字对齐等排版细节。

**方法**：每完成一节交 Luis 验收（全局工作法），过了再作为后续基准；截图验证前先停旧实例、确认实际端口。可用视觉走查工具（`H:\走查插件`）辅助测距与标注。

**边界**：不加新功能性板块（新数据视图需求回切片 3 或记 backlog）；不引入前端框架重写（现有 vanilla JS 体量不值得，除非 Luis 明确要求）。

**验收**：Luis 逐节签收记录齐全；无 console 报错；GUI 在 `data/` 空、单 goal、长队列三种数据形态下渲染正常。

### 切片 5：发布收口

**目标**：R1-R9 全量复核，出可发布版本。

**待办**：
1. 全量回归：四关卡 + 真实 goal/loop/cron/GUI 各一次端到端。
2. 安全基线复查：`security-review-baseline.md` 汇总本路线图所有审查轮；确认无未缓解 HIGH；deferred 项（TOCTOU 同串不同义、off-bus token 计费、监控惰性）逐条确认缓解说明仍成立。
3. 文档一致性（R8）：README「上手」路径按新人视角实走一遍；handoff 链更新（本文状态段 + `handoff-next.md`）；memory 索引同步。
4. 版本号、changelog、已知问题清单。
5. 停在发布线前：向 Luis 提交发布检查单，publish/push 等待人工明示。

**验收**：R1-R9 逐条打勾且每条有证据链接（命令输出 / JSONL 路径 / 审查记录 / 验收记录）。

**历史状态（2026-07-03 第二轮发布检查）**：非 UX 阻塞项已收口，当时的 GUI-first 发布停在 R6。R1 四关卡全绿：`npm run typecheck`、`npm run lint`、`npm run build`、`npm test`（102 files / 1060 passed / 1 skipped）。R2 真实间隔 cron daemon 6/5 且 false verified `0`；R3 内置 Browser 急停写入 `loop-halted emergency-stop`；R4 worktree 写隔离通过；R5 内置 Browser 裁决通过；R7 human-review spoof 与 `loop:finalize` false-positive merge 系列 HIGH 已修，最终 codex 复审 `HIGH? no`；R8 本文 / `handoff-next.md` / 试点笔记已同步；R9 已补 `0.1.0` 版本、`CHANGELOG.md`、`RELEASE_NOTES.md`、`KNOWN_ISSUES.md`。R6 UI/UX 打磨与 Luis 逐节验收当时仍未做。

## 4. 对抗式审查制度（本路线图执行标准）

- **必须开轮的切片**：切片 2（permission 核心）、切片 3（GUI 控制面 + 注入面）。切片 0 并入就近轮次；切片 1/4 不动安全面，不强制。
- **执行方式**：codex CLI 独立代理，多 lens（绕过、注入、TOCTOU、fail-open、可达性）；实现者不得自评通过。审查发现按 `security-review-baseline.md` 的严重度尺子分级，HIGH 必须修或书面缓解 + Luis 知情。
- **审查记录**：每轮追加进 `security-review-baseline.md`（沿用现有格式），修复 commit 与发现一一对应。
- **元教训继续生效**：组件级 review 挡不住系统级不可达 → 每条新 guardrail 配真实接线触发测试；死 guardrail 成对出现 → 删除时找它的孪生兄弟。

## 5. 已知 defer 项（发布不阻塞，但要在 R9 已知问题清单里如实列出）

- bash 命令级 session-allow 的 TOCTOU（同命令串不同义）：attended-only + 非 bash 零 session 缓解，根治需「命令串+行为文件指纹」绑定，defer。
- off-bus token 计费漏腿 3/pinned 派生：已文档化。
- 跨 goal 裁判健康监控仅腿 3 开启的目标才活：设计使然。
- 通用 app/browser/network verifier：能力天花板，超窄 inspection scope 的运行态需求继续 `cannotVerify→park`。
- 两份 readiness 文档（ai-coworker / ai-execution-routing）保持方向备忘状态，重开条件见各自文档。

## 6. 新 agent 上手顺序

1. 读 `docs/handoff-next.md`（系统现状 + 不变量）——先于本文。
2. 读本文，确认当前推进到哪个切片（查 git log 与 `docs/` 下切片设计文档）。
3. 读 `docs/security-review-baseline.md`（审查方法 + 历史 + 元教训）。
4. memory 索引：`phase-d-goalloop-deterministic-legs`（验收不变量）、`restore-bash-session-allow`（为什么 bash 不能白名单）、`codex-for-adversarial-review`（审查用 codex）、`next-direction-after-hooks`。
5. 动手前跑一次四关卡确认基线；改验收/权限代码前重读「别破的不变量」。
