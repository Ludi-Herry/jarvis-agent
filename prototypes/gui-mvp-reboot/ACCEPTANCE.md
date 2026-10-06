# P1 浏览器验收记录

> 状态：`P1 CLOSED / DIRECTION SELECTED`
> 验收日期：2026-09-01（Asia/Shanghai）
> 环境：Codex 内置 Browser；本机唯一预览服务 `py -3 -m http.server 4327 --bind 127.0.0.1`

## 入口与截图

| 方向 | 本地入口 | 1440×900 | 1280×800 |
|---|---|---|---|
| 对话主导 | `http://127.0.0.1:4327/conversation-first/` | `screenshots/conversation-first-1440x900.png` | `screenshots/conversation-first-1280x800.png` |
| 任务主导 | `http://127.0.0.1:4327/task-first/` | `screenshots/task-first-1440x900.png` | `screenshots/task-first-1280x800.png` |
| 产物主导 | `http://127.0.0.1:4327/artifact-first/` | `screenshots/artifact-first-1440x900.png` | `screenshots/artifact-first-1280x800.png` |

## 自动与视觉检查

| 检查 | 对话主导 | 任务主导 | 产物主导 |
|---|---:|---:|---:|
| 页面完成初始化，模拟状态为 `approval` | PASS | PASS | PASS |
| 1440×900 无页面级横向溢出 | PASS | PASS | PASS |
| 1280×800 无页面级横向溢出 | PASS | PASS | PASS |
| 审批卡完整出现在目标 viewport | PASS | PASS | PASS |
| 暂停、继续、恢复、终止持续可达 | PASS | PASS | PASS |
| 消息、Reasoning、工具与 Artifact/Diff 可见 | PASS | PASS | PASS |
| 完成与失败演示保留完成授权文案 | PASS | PASS | PASS |
| 浏览器 console error | 0 | 0 | 0 |

## 交互路径

- 三稿均验证：暂停 → 继续；终止确认 → interrupted → 恢复；允许一次；拒绝；要求调整；切换模拟完成与失败。
- 完成态显示 `decideVerdict · verified（模拟）`；其余状态持续显示“完成授权未授予”。
- 对话稿验证 Reasoning/工具渐进披露和对话内持续输入。
- 任务稿验证任务阶段骨架、Reasoning 折叠、工具队列与待审批 checkpoint。
- 产物稿验证 Diff/任务/验证标签切换，以及第 123 行批注锚点把焦点送到批注输入区。

## Motion 与资源边界

- 页面只加载 `127.0.0.1:4327` 下的 HTML、CSS 与 JavaScript，无 CDN、字体、图片或远端脚本请求。
- 浏览器 CSSOM 确认加载了 `prefers-reduced-motion: reduce`。该路径关闭循环 shimmer、位移、模糊、平滑滚动与长过渡，内容和控制保持原顺序。
- 所有按钮只更新页面内存；源码中没有 `fetch`、`EventSource`、`WebSocket` 或现有 Jarvis API 调用。

## 仓库既有门禁

- `npm run typecheck`：PASS。
- `npm run lint`：PASS。
- `npm run build`：PASS。
- 首次全量 `npm test` 与另外三个门并行时，149/151 个文件通过，1738 个测试通过、2 个跳过；两个未改动的 CLI 用例分别超时或返回 code 5。
- 将这两个 CLI 文件单独串行复跑后，2/2 个文件、56/56 个测试通过。未修改 CLI、测试或任何现有源码。

## 验收中修正

- 产物稿首张 1440×900 截图的中央 Diff 上下文过短，出现大面积空白代码区。
- 修正后，公共模拟 Diff 从 12 行扩为 30 行，三稿仍使用同一份事实；六张截图全部重新生成。

## 最终方向裁决

- 2026-09-01：Ludi 选择对话主导方向，随后确认 `conversation-first-refined` 在完整性、连贯性和 AI 对话产品感上优于外部参赛稿。
- 2026-09-02：ASCII 盲评与 Owner 信号复核完成，最终 verdict 更新为 Candidate B，即 Codex `conversation-first-refined`。
- 选定方向额外通过 1440 compact/expanded 与 1280 compact 验收；对应截图位于 `conversation-first-refined/screenshots/`。
- 完整裁决与 P2 硬验收见 `docs/DECISION-gui-mvp-p1.md`。

三稿只证明方向可比较与静态交互闭环。它们没有连接真实 Runtime，也不构成 beta 验收、依赖安装批准或桌面开发开始。
