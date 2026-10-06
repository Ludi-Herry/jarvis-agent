# Jarvis GUI P2 React Spike · 验收记录

> 状态：`P2.1 THEME CALIBRATED / P2 SPIKE GO / P3 NOT AUTHORIZED`
> 验收日期：2026-09-02（Asia/Shanghai）
> 本地入口：`http://127.0.0.1:4328/`
> 技术边界：模拟事件源；无真实 Runtime、API、模型或工作区写入

> 后续授权说明（2026-09-06）：以上状态及以下结果均为 P2 历史验收，保持原样。Ludi 本轮已明确授权 P3，继续采用现有 React + assistant-ui；P3 实施和真实任务结果见 [P3 合同](../../../../docs/PLAN-gui-mvp-p3-runtime.md)。P2 GO 不作为真实运行或恢复能力的证据。

## 1. 依赖门

| 检查 | 结果 |
|---|---|
| 精确版本与 strict peer | PASS |
| Lockfile | v3；139 个远端条目 |
| 来源 | 全部为 `https://registry.npmjs.org/` |
| Integrity | 远端条目 139/139 均存在 |
| scripts-disabled 安装 | PASS；实际安装 114 个包 |
| npm audit | 0 info / low / moderate / high / critical |
| 许可 | MIT 106、Apache-2.0 2、MPL-2.0 2、BSD-3-Clause 2、ISC 1、0BSD 1 |
| Lifecycle | 6 个 installed 包带 `prepare`；全部被 `--ignore-scripts` 阻断 |
| Install script flag | 仅 macOS optional `fsevents@2.3.3`；Windows 未安装且脚本被阻断 |
| Gate B | 无需激活 lifecycle script |

`assistant-cloud@0.1.42` 作为 `@assistant-ui/react` 的传递依赖落盘。源码没有声明、import 或初始化 Cloud；浏览器网络验收进一步证明运行时未连接它。

## 2. 实现边界

- 独立包：`src/surfaces/gui/app/`。
- assistant-ui 接入点只有 `src/adapter/jarvis-external-store.tsx`。
- 使用公开 `AssistantRuntimeProvider`、`useExternalStoreRuntime`、`ThreadPrimitive`、`MessagePrimitive` 和 `ComposerPrimitive`。
- Session 列表、运行状态、审批、证据、恢复与完成授权全部由 app-owned demo reducer 持有。
- 没有 `internal`、`unstable_*`、AssistantTransport、Cloud、AI SDK、tool executor 或 thread-list adapter。
- `src/surfaces/gui/gui-server.ts`、旧 assets、现有 API 与 Runtime 零改动。

## 3. 构建证据

| 命令 | 结果 |
|---|---|
| 子包 `npm run typecheck` | PASS |
| 子包 `npm run build` | PASS；Vite 8.2.2，700 modules |
| 根 `npm run typecheck` | PASS |
| 根 `npm run lint` | PASS |
| 根 `npm run build` | PASS |
| 聚焦测试 `npm test -- gui-react-spike-demo` | 1 file / 2 tests PASS |
| 串行全量 `$env:VITEST_MAX_WORKERS='1'; npm test` | 152 files / 1742 passed / 2 skipped |

生产构建体积：

- HTML：`1.36 kB`，gzip `0.80 kB`。
- CSS：`28.03 kB`，gzip `6.03 kB`。
- JavaScript：`492.80 kB`，gzip `148.29 kB`。

历史失败保留：默认并行全量首轮为 151 files passed、1 file timeout；`sessions-selection.test.ts` 的非法参数用例在 20 秒超时。该未改动文件随后单独复跑 9/9 通过，最终单 worker 全量 152/152 通过。没有修改该 CLI 测试或延长阈值。

## 4. 响应式与视觉验收

| 状态 | 视口 | 栏宽 / 结果 | 截图 |
|---|---:|---|---|
| approval compact | 1440×900 | `208 / 888 / 344`；审批、Composer、终止同屏 | [`approval-1440x900.png`](./screenshots/approval-1440x900.png) |
| approval expanded | 1440×900 | `208 / 685 / 547`；完整 Diff 可读 | [`approval-expanded-1440x900.png`](./screenshots/approval-expanded-1440x900.png) |
| approval compact | 1280×800 | `184 / 784 / 312`；页面零横向溢出 | [`approval-1280x800.png`](./screenshots/approval-1280x800.png) |
| approval expanded | 1280×800 | `184 / 610 / 486`；双行顶栏保留完整标题与控制 | [`approval-expanded-1280x800.png`](./screenshots/approval-expanded-1280x800.png) |
| failed expanded | 1440×900 | 单一 failure stage；证据与恢复入口可见 | [`failed-1440x900.png`](./screenshots/failed-1440x900.png) |
| completed expanded | 1440×900 | 单一 completed stage；完成授权已授予 | [`completed-1440x900.png`](./screenshots/completed-1440x900.png) |

1280 DOM 实测：

- compact：`184 / 784 / 312`，`document.scrollWidth - innerWidth = 0`。
- expanded：`184 / 610 / 486`，`document.scrollWidth - innerWidth = 0`。
- 1280 expanded 首轮任务标题截断；修正为双行顶栏后复验通过，标题完整高度为 45px。

### P2.1 纯白主题复验

- Ludi 明确移除暖纸底、纸张纹理、朱砂印章、旋转贴纸及和风或中国风材质。
- 视觉层改为 shadcn / Codex / DeepSeek Harness 一类的纯白中性工具界面；三栏结构、模拟事实与交互合同保持不变。
- 六张验收截图已在主题替换后全部重拍；1440×900 与 1280×800 compact / expanded 均通过。
- Impeccable detector 运行一次，因可选 HTML parser 模块未安装而退化为正则检查，命中项为 0；该结果只证明已覆盖规则无命中。
- Finish Reviewer 依据最终六张截图与源码复眼，结论为 `ship`。当前宿主缺少可关闭的 Reviewer 子代理能力，因此按 skill 的 degraded contract 在主线程执行。
- 应用级视觉系统已固化到 [`DESIGN.md`](./DESIGN.md) 与 [`.impeccable/design.json`](./.impeccable/design.json)。

## 5. 交互合同

| 路径 | 结果 |
|---|---|
| 初始人工 gate | “允许一次”获得初始焦点；活动 stage 数量为 1 |
| 要求调整 | runState → paused；焦点进入 `#conversation-input` |
| Composer / External Store | 提交后消息 3 → 5，输入清空，审批重新打开 |
| 工具证据联动 | `apply_patch → Diff`；展开右栏并保持 486px 目标宽度 |
| 允许一次 | runState → validating；stage → verification；AUTH 仍未授予 |
| 验证失败 | stage → failure；原始 Diff、失败输出、工作区恢复证据保留 |
| verified | stage → completed；只有该路径把 AUTH 改为已授权 |
| 暂停 → 终止 → 恢复 → 继续 | 准确回到 approval；草稿与滚动位置保持 |
| 未知事件 | 显式显示 `future.gui.event`；runState 与 AUTH 不变 |

连续性实测值：

- Composer 草稿：`请保留现有 API，并继续沿用 mutation barrier。`
- 中央滚动：终止前后与恢复后均为 `220`。
- 右栏滚动：终止前后与恢复后均为 `36`。
- 确认终止后焦点落到“恢复”。

## 6. Motion 与可访问性

- card resize、accordion、modal 使用 `transitions-dev` 语义 token。
- Reasoning 折叠后 `aria-expanded=false`、panel height `0`。
- CSSOM 检出 `prefers-reduced-motion: reduce`，关闭宽度、缩放、模糊和折叠过渡。
- 原生 dialog 支持 Escape 取消与焦点回收；确认终止后焦点转交恢复按钮。
- 状态使用文字、形状和颜色共同表达；toast 与 run status 使用 live region。

## 7. Network 与 console

Playwright HAR 共 19 个请求：

- Origin 只有 `http://127.0.0.1:4328` 和 Vite HMR 的 `ws://127.0.0.1:4328`。
- 非 localhost 请求：0。
- HTTP / network 失败：0。
- Cloud、analytics、模型、远端字体或图片请求：0。

内置 Browser console：error 0、warning 0。只有 Vite debug 与 React DevTools 开发提示。

## 8. 剩余风险与下一关

- `ExternalStoreRuntime` 仍是 experimental；精确版本与单适配文件降低迁移范围，但无法消除上游 API 漂移。
- `@assistant-ui/react` 带来 114 个实际安装包与 148.29 kB gzip JS；P3 前需要接受这份长期维护成本。
- 本轮只使用 Chrome channel；Playwright 自带 Chromium 未下载，未做 Firefox/WebKit 验收。
- 本轮恢复只验证页面内模拟连续性；真实 JSONL、断线和事件顺序属于 P3。

P2 结论为 GO。P3 仍需 Ludi 单独授权，且必须复用现有 EventBus、Session、权限与完成授权路径。
