# 批 3 架构合同：并发 / 子智能体 / 内置浏览器 / 终端（2026-10-06）

> 上游：`PLAN-gui-v13-restart-2026-10-05.md` 缓做清单、Owner 2026-10-06 立项「开始继续做完团队/子智能体/浏览器/终端/并发」。
> 上一批事实：`PLAN-gui-v13-batch2-architecture.md` 已入库，服务端 17 条 + 全量 1777 绿。

## 设计裁决（主线程定）

### A. 多任务并发（B2）
1. **并发上限 = 2**（常数 `MAX_CONCURRENT_RUNS = 2`）；**同一工作区同一时刻只允许 1 个运行中任务**（写冲突与基线干扰的真实边界），不同工作区可并发到上限。start/resume 的 409 错误如实区分两种冲突（「该工作区已有运行中的任务」/「并发上限已满」）。运行数在 overview.sessions 里可复算，不另存计数器。
2. 每任务现已是独立 provider（start 时按合同克隆）、独立策略链、预算、baseline（`gui-baselines/<id>.index` 已是 per-task）、事件序号与恢复状态——本批**不重构这些**，只放开工互斥的判断位。
3. UI 解除「运行中锁切换」：任意时刻都可查看/切换任意任务（只读观察无误操作空间）；控制按钮按**所选任务**的 capability 渲染（现状即如此）。紧急风险提示：急停作用于所选任务本身，不误伤其他任务——服务端 control 已按 id 分派，保持。
4. GuiLiveOverview.activeId 保留（最近活跃）并 additive 增加 `activeIds: string[]`（所有 run 中的任务 id）。左栏运行中任务行显示运行点标（现状 data-status 已有）。

### B. 子智能体（B10）
5. GUI 宿主按 CLI repl 同法接线：`SubagentManager`（provider=任务 provider、gate=任务 gate、roster=CLI policy roster、cwd=任务 cwd、context 同任务、remainingDepth=MAX_SUBAGENT_DEPTH）→ `tools.register(createDelegateTool(manager))`。roster 为空（policy 未配置）则不注册 `task`，UI 如实显示「当前配置未启用子智能体 roster」。compose 的工具清单进 composition（现有 createSessionComposition 已含全部注册工具 schema，无需改）。
6. 生命周期呈现**不新增事件类型**：子智能体调用就是 `task` 工具调用（tool_call/tool_result 已入流与 journal）。UI 从 `snapshot.tools.filter(name==='task')` 派生列表：角色（arguments.role）、任务说明（arguments.task 截 120 字）、状态（proposed/running/committed/failed/denied）、结果/失败（output 截 400 字）。
7. UI 位置：证据抽屉新增「子智能体」页签（derive 自第 6 条）；无调用时诚实空态「本次运行还没有委派」。
8. 与子智能体相关的预算/深度/并发约束全部沿用 SubagentManager 既有纪律（read-only 委派、同 gate、深度上限、deadline），GUI 不重述、不放宽。

### C. 内置浏览器（true-parity §3「内置浏览器纳入」）
9. Web GUI 不能嵌入真浏览器。合同形态为**预览面板**：证据抽屉新增「预览」页签 = 地址输入 + 导航（前进/后退/刷新）+ iframe + 状态行。
10. 源策略：默认可开 `http(s)://127.0.0.1|localhost|::1` 任意端口（本地预览事实需求）；外部 http(s) 地址打开前给用户一行确认（「对方站点可能拒绝被嵌入，将如实显示失败」）。非 http(s)/file/任意协议拒绝。
11. 失败诚实化：iframe `error` 事件 + 10s 未 `load` 显示「页面未在限定时间加载或拒绝被嵌入（对方可能设置 X-Frame-Options/CSP）」；不假装成功、不截屏伪造。地址失败保留输入供修改。
12. Agent 自动浏览不属于本面板（走工具授权链，browser_smoke 已在）；本面板仅供用户开给用户自己看。
13. 面板状态（地址、历史栈）随任务范围存 localStorage（与现有 draft/scroll 同纪律），不进 journal——这是纯视图偏好，不是运行事实。

### D. 终端（B12）
14. 证据抽屉新增「终端」页签：输入命令 → `POST /api/live/:id/terminal` → 服务端 spawn（`task.cwd` 限定）流式输出 → 追加为 `gui_terminal` journal 事件（`{type:'gui_terminal', phase:'start'|'out'|'exit'|'cancel', command, chunk?, code?, at}`，chunk 入 journal 前 redactSecrets）→ projection 折叠出 `snapshot.terminal = { running: {command, startedAt} | null, history: [{command, code, output(≤4000字，首尾截断), canceled, at}] }`。重启宿主后从 journal 重放可见历史；运行中进程在宿主退出时被杀并如实标 canceled/interrupted。
15. 授权模型：**这是用户在 attended 会话里自己开的桌边终端**——沿用控制台终端的保守 denylist（`rm -rf /`、`format`、`del /s /q`、`shutdown`、`dd if=`、`mkfs`、`reg delete`、`diskpart`、含 `> /dev/sd` 的写入、Windows 盘符根整体删除模式等），拒绝时如实回执原因。不做任意路径写入拦截（用户本人操作），但输出与历史全程留痕。Agent 不使用此通道（工具链另管）。
16. 取消：`POST /api/live/:id/terminal/cancel` → SIGTERM 子进程（Windows 下 taskkill /PID /T /F 兜底），journal 记 cancel；无运行中进程 409。
17. 输出上限：单命令累计 64 KiB 截断（journal 同截断）、history 保留最近 20 条。命令最长 2000 字。每任务同时只跑 1 条桌边命令，第二条 409。
18. 绝不用 checkCommands 的执行记录冒充交互终端（写入路径隔离：terminal 输出只进 gui_terminal 事件，不进 evidence/checks/diff 权威链）。

### E. 缓存/恢复/并发不变式
19. start/resume 的 resume 校验（created.model、composition、pinned JSON）原样；并发只改「是否允许启动」的判定，不改启动后语义。
20. workspaceId↔cwd 一致性、gui_meta、分支、钉钉合同 dedupe 全不动。

## 验收门
1. 全量 `--maxWorkers=4` 绿 + lint + 双 typecheck + app build。
2. 新测试（触发路径）：
   - 并发：同工作区第二任务 409、异工作区两任务并存、第三并发 409 上限、start 后 activeIds 形状、运行中切换查看不动控制目标（纯函数层）。
   - 子智能体：roster 配置时 tools 含 task 且 composition 变化可重放；roster 空时无 task；derive 纯函数（role/状态/输出截断）。
   - 终端：start/out/exit 事件链投影、denylist 拒绝、并发第二命令 409、输出截断、重启后历史重放、cancel。
   - 预览：源策略纯函数（loopback 放行、外部需确认、非 http(s) 拒绝、file 拒绝）。
3. 确定性 playback：异工作区 A/B 并行运行（deterministic provider）、委派试件展示子智能体页签、终端跑真实 `node -e` 命令流式输出与 cancel、预览面板打开 127.0.0.1 vite 页面成功 + 打开 example.com 显示诚实失败。截图 1440/1280 入 `docs/evidence/gui-v13-batch3/`。
4. PLAN-gui-v13-restart 进度更新；commit。

## 禁止事项
不为并发引入任务调度器/队列抽象；不给 Agent 开放桌边终端；不给预览面板加截屏/代理转发等伪装能力；不重写 SubagentManager/PermissionGate/EventBus；真实模型零调用（确定性 provider 与试件）。
