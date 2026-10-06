# 批 3 证据包：并发 / 子智能体 / 内置浏览器（预览）/ 终端（2026-10-06）

设计合同：`docs/PLAN-gui-v13-batch3-architecture.md`。服务端测试：`gui-batch3-concurrency.test.ts`（8）、`gui-batch3-terminal.test.ts`（12）、GUI 侧纯函数 `gui-batch3-app.test.ts`（6）。

## 截图（4 张，Playwright，fixture 试件）

| 文件 | 内容 |
| --- | --- |
| concurrent-rail-1440x900.png | 两个工作区各一个运行点（并发上限 2 的并存态）；运行中自由切换查看 |
| subagents-tab-1440x900.png | 证据抽屉「子智能体」页签：researcher 委派、已执行、任务摘要与结果预览 |
| terminal-tab-1440x900.png | 「终端」页签：fake `node -e` 两段输出合并、退出码 0 |
| preview-loopback-1440x900.png | 「预览」页签：127.0.0.1 地址直开成功（iframe 真实渲染嵌套页面） |

试件外补充实证（服务端测试承担真实性）：
- 并发：同工作区第二任务 409（workspaceId 与 cwd 混合绑定都测）、异工作区两任务并存、第三并发 409、activeIds 形状、resume 共用同一门。
- 终端：真实 `node -e` 事件链、denylist 命中不 spawn、第二命令 409、cancel 长命令（Windows taskkill 杀树）、64KiB 截断、重启重放历史、dispose 杀 running 进程。
- 预览策略：loopback 放行、external 需确认、file:// 等拒绝。
- 子智能体接线：`agents/*/ROLE.md` 存在时 tools 含 `task` 且 composition 落 journal 可重放；缺目录/损坏如实降级。

## 门禁

全量 `vitest run --maxWorkers=4` **1803 通过 / 2 skipped / 0 失败**；根 lint / 双 typecheck 绿；app build 绿。

## 本批裁量与已知边界（交 Owner）

1. `MAX_CONCURRENT_RUNS = 2`（过紧可调；同工作区恒为 1）。
2. 子智能体嵌套深度 GUI 取 1（CLI 为 2；要一致需把常量提升到 capabilities 共享层，另开会）。
3. 终端是 **attended 用户的桌边通道**：保守 denylist（`sudo` 任意位置即拒、`format` 裸命令拒——保守误拦如 `npm run format` 属预期）；Agent 不用此通道。
4.「超时」与「已取消」在 UI 状态字上目前同显「已取消」（服务端 reason 未落投影字段）；要区分需在 GuiTerminalEntry 加字段。
5. 预览面板只对**用户自己打开的地址**负责；外站多数被 X-Frame-Options 拒绝时如实显示，不做代理转发伪装。
