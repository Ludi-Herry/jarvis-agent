# PLAN：GUI MVP P2 React Spike 依赖审查与合同

> 状态：`IMPLEMENTED / P2.1 THEME CALIBRATED / P2 SPIKE GO`
> 审查日期：2026-09-02（Asia/Shanghai）
> 输入方向：[P1 最终裁决](./DECISION-gui-mvp-p1.md)
> 当前行动边界：P3 于 2026-09-06 已获明确授权，继续采用现有 React + assistant-ui；见 [P3 合同](./PLAN-gui-mvp-p3-runtime.md)。以下非目标与安装批准范围是 P2 历史合同。

## 1. 结论

Ludi 已批准 Gate A，受控 React Spike 已完成并通过验收。实现采用独立前端包、精确版本、`ExternalStoreRuntime` 单点适配和 app-owned 模拟状态。

`@assistant-ui/react` 只承担对话 primitive 与 runtime adapter。它没有接管 Jarvis 的 Session、权限、工具执行、持久化、恢复或完成授权。完整执行证据见 [`src/surfaces/gui/app/ACCEPTANCE.md`](../src/surfaces/gui/app/ACCEPTANCE.md)。已披露的长期依赖成本随总体路线和本次 P3 授权接受，不新增确认门。

## 2. 要验证的问题

1. assistant-ui 的稳定 primitives 能否承载选定的 Conversation First 壳层，同时保留 Jarvis 自有视觉语言。
2. `ExternalStoreRuntime` 能否只做显示适配，让 Jarvis 风格的 store 继续拥有消息、线程与运行状态。
3. 自定义 Reasoning、工具、审批和 Artifact 组件能否接入，又不会形成第二套执行或授权路径。
4. 1280×800 下，永久三栏是否仍满足中央阅读宽度与单一活动阶段要求。
5. 依赖体量、API 稳定性和构建隔离成本是否值得进入 P3。

## 3. 明确非目标

- 不调用真实模型，不创建 provider adapter。
- 不连接现有 `/api/*`、EventBus、Session、PermissionGate、Goal 或 `decideVerdict`。
- 不使用 Assistant Cloud、Vercel AI SDK、AssistantTransport、DataStream 或新事件协议。
- 不运行 assistant-ui CLI、Vite scaffold、shadcn CLI 或组件 registry 自动写入。
- 不加入 Tailwind、`@assistant-ui/react-ui`、`@assistant-ui/vite`、Markdown、附件、语音、分支、重试、模型路由或插件。
- 不替换、删除或改写 `src/surfaces/gui/assets/` 与现有 GUI API。
- 不从 `prototypes/` 直接 import HTML、CSS 或 JavaScript；结构与 token 由人工迁移。

## 4. 本地基线

| 项目 | 已核实状态 | P2 影响 |
|---|---|---|
| Git | `main@c05c135`；启动审查时无 tracked 修改 | P2 不覆盖其他会话文件 |
| Node | 仓库声明 `>=20`；本机 `v24.14.1` | Vite 8 的下限更窄，必须由隔离包声明 |
| npm | `11.11.0` | 支持 `--ignore-scripts` 与严格 peer 检查 |
| TypeScript | 根项目 `6.0.3`；Node-only `lib/types` | React 包使用独立 DOM tsconfig |
| React | 根项目未安装 | 不改变现有 CLI Runtime 依赖树 |
| GUI | vanilla HTML/CSS/JS + 本地 Node server | P2 与旧 GUI 并存，P3 前不接线 |

## 5. 精确依赖候选

以下版本来自 2026-09-02 的 npm Registry 只读查询。实现阶段禁止使用 `latest`、`^` 或 `~`。

### Runtime dependencies

| 包 | 固定版本 | 许可 | 裁决 |
|---|---:|---|---|
| [`react`](https://www.npmjs.com/package/react/v/19.2.8) | `19.2.8` | MIT | 接受 |
| [`react-dom`](https://www.npmjs.com/package/react-dom/v/19.2.8) | `19.2.8` | MIT | 接受，与 React 精确对齐 |
| [`@assistant-ui/react`](https://www.npmjs.com/package/@assistant-ui/react/v/0.15.17) | `0.15.17` | MIT | P2 验证通过；2026-09-06 继续用于 P3 |

### Dev dependencies

| 包 | 固定版本 | 许可 | 裁决 |
|---|---:|---|---|
| [`vite`](https://www.npmjs.com/package/vite/v/8.2.2) | `8.2.2` | MIT | 接受，隔离安装 |
| [`@vitejs/plugin-react`](https://www.npmjs.com/package/@vitejs/plugin-react/v/6.1.1) | `6.1.1` | MIT | 接受；可选 compiler peers 不安装 |
| [`typescript`](https://www.npmjs.com/package/typescript/v/6.0.3) | `6.0.3` | Apache-2.0 | 接受，与根项目一致 |
| [`@types/react`](https://www.npmjs.com/package/@types/react/v/19.2.18) | `19.2.18` | MIT | 接受 |
| [`@types/react-dom`](https://www.npmjs.com/package/@types/react-dom/v/19.2.5) | `19.2.5` | MIT | 接受 |

### 明确排除

- `@assistant-ui/react-ui@0.2.1`：会引入预制视觉、Radix 组件和图标依赖；当前设计需要 app-owned 壳层与 CSS。
- `@assistant-ui/vite`：P2 使用 `MessagePrimitive.Parts` 的 render function 渲染工具卡，无需 `"use generative"` 编译器。
- `assistant-ui` CLI：官方说明 `init/add` 会安装依赖、写组件并调整 TypeScript 配置，超出受控安装边界。
- `assistant-cloud`：不得直接声明、import 或初始化。它会随 `@assistant-ui/react` 传递存在，P2 必须以浏览器网络证据证明运行时未连接 Cloud。
- React Compiler 相关 optional peers：保持未安装。

## 6. 依赖风险与取证

### 已验证事实

- `@assistant-ui/react@0.15.17` 的 peer 范围接受 React 18/19；发布包约 `2,171,241` 字节、`1,144` 个文件。
- 它传递依赖 `assistant-cloud@0.1.42`、`assistant-stream@0.3.40`、完整 `radix-ui@1.6.7`、Zustand 与多个 assistant-ui core 包。
- 在仓库根目录执行 `npm install --dry-run --ignore-scripts --strict-peer-deps ...` 成功解析，但结果会新增 96 个包并改变 9 个现有解析项。该 dry-run 没有修改 `package.json`、`package-lock.json` 或 `node_modules`。
- Vite 8 要求 Node `^20.19.0 || >=22.12.0`；仓库当前宽泛的 `>=20` 无法覆盖这一真实下限。
- 直依赖候选的发布 manifest 未发现 `preinstall`、`install` 或 `postinstall`。`@vitejs/plugin-react` 带 `prepublishOnly`；传递包 `lightningcss@1.33.0` 带 `prepare`，许可为 MPL-2.0。
- `ExternalStoreRuntime` 官方页面仍标记 experimental；assistant-ui 稳定性政策说明 `unstable_` API 可在 patch 版本变化。

### 推断与处理

- 根目录安装会把 Spike 风险扩散到现有 CLI 工具链。独立包能让失败回滚保持有界，因此是当前最低风险方案。
- `assistant-cloud` 的依赖存在不能证明会产生网络请求。P2 用静态源码检查与浏览器 Network 两项证据裁决，任何非 localhost 请求直接失败。
- 当前只完成 direct 与关键 transitive manifest 审查。完整许可、漏洞、integrity 和 lifecycle 清单要在生成独立 lockfile 后复核。

## 7. 目录与所有权

获得安装授权后，P2 使用：

```text
src/surfaces/gui/app/
  package.json              # 独立、精确版本、private
  package-lock.json         # 独立锁文件
  tsconfig.json             # DOM + React JSX；不继承 Node-only lib
  vite.config.ts
  index.html
  src/
    main.tsx
    app.tsx                 # 三栏产品壳
    adapter/
      jarvis-external-store.tsx
    demo/
      gui-recover-17.ts     # 私有模拟事实，不形成新 Runtime API
      demo-reducer.ts       # 纯前端状态转换
    components/
      conversation/
      review/
      sessions/
    styles/
      tokens.css
      app.css
```

规则：

- 该目录是正式 GUI 的候选前端位置；P2 失败时保留为 Spike 证据，P3 不会自动采用。
- 根 Node tsconfig 需要排除该子包，由子包自己的 `typecheck` 负责；根项目既有四关继续独立运行。
- 现有 `gui-server.ts`、API、assets 与测试在 P2 零改动。
- adapter 只允许一个文件接触 `useExternalStoreRuntime`，上游 API 变化只能在这里消化。
- 禁止 import `@assistant-ui/*/internal`、`unstable_*`、`AssistantTransport` 或 Cloud API。

## 8. 状态与权限合同

| 事实 | 唯一 Owner | assistant-ui 作用 |
|---|---|---|
| Session 列表与当前 Session | demo store；P3 才映射 Jarvis | P2 不使用 experimental thread-list adapter |
| 消息与 Reasoning | demo store | External Store 只转换并渲染 |
| 工具状态与证据链接 | demo store | `MessagePrimitive.Parts` 调用 app-owned renderer |
| 审批决定 | demo reducer | 不使用 library tool executor |
| 暂停、继续、终止、恢复 | demo reducer | library 不拥有运行状态 |
| Artifact / Diff / 验证 | demo store | 右栏 app-owned 组件 |
| 完成授权 | demo verdict fact | library 无写入口 |

P2 只提供 `onNew` 模拟提交。编辑、regenerate、branch、删除线程和客户端工具执行均不提供 callback；assistant-ui 的 capability-based UI 必须因此保持关闭。

## 9. 模拟事件与阶段

- 继续使用 `GUI-RECOVER-17`，禁止另造更容易展示的新任务。
- 模拟源为页面内确定性事件序列，不使用定时随机数、fetch、SSE、WebSocket、localStorage 或真实 JSONL。
- 内容覆盖消息、Reasoning、工具、审批、Artifact / Diff、验证和终局。
- 运行控制覆盖 running、approval、paused、validating、failed、interrupted、restored、completed 的页面投影。
- 右栏主要内容遵循 `approval → validating → failed|completed` 原位转换；旧阶段压缩成只读回执。
- 未识别的 demo event 显示有界降级卡，不静默丢弃，也不触发权限或完成状态。

## 10. Spike 验收合同

### 结构与阅读

- 1440×900 compact/expanded 与 1280×800 compact/expanded 四种组合均截图验证。
- 1280 compact 对话区目标 `784px`；expanded 最低 `610px`，页面无整体横向滚动。
- 左栏、消息区和右栏各自滚动；Composer、审批主动作和终止持续可达。
- 最小可见文字保持 `11px`，主要消息正文不得依赖该下限。

### 状态与人工接管

- `允许一次`：进入 validating；完成授权继续未授予。
- `拒绝`：进入 failed，原始 Diff 与请求证据仍可读。
- `要求调整`：进入 paused，焦点落到 Composer，草稿可编辑。
- 暂停 → 继续、终止确认 → 恢复后，三栏滚动位置、活动页签、焦点和草稿不丢失。
- 只有 completed fixture 携带 verified verdict 时显示完成授权。

### assistant-ui 适配

- 使用 `ThreadPrimitive`、`MessagePrimitive`、`ComposerPrimitive` 与 `MessagePrimitive.Parts` 的当前公开 API。
- 自定义视觉没有 assistant-ui 默认主题、shadcn 或 Tailwind 泄漏。
- 工具联动保持一步可达；approval 与 Artifact 不通过 assistant-ui 执行工具。
- adapter 无 `internal` / `unstable_*` import，且不复制 Jarvis Runtime 逻辑。

### 可访问性与 motion

- Tab 顺序从当前阻塞动作开始，所有焦点可见；终止使用有焦点回收的 dialog。
- 状态同时使用文字和形状表达；运行反馈进入 `aria-live`。
- motion 复用语义 token；`prefers-reduced-motion` 关闭位移、宽度动画、平滑滚动和循环效果。

### 网络、构建与回归

- Browser Network 只允许当前 localhost 资源；Cloud、analytics、模型与远端字体请求数量为 0。
- 子包 `typecheck` 与 `build` 通过；记录产物 JS/CSS 原始及 gzip 体积。
- 根项目 `typecheck`、`lint`、`test`、`build` 保持通过。
- 新增测试最多一个主路径和一个关键失败路径，锁定完成授权与失败证据不变量；不引入新测试框架。

## 11. 停止条件

命中任一项立即停止 P2：

- peer 解析需要 `--force` 或 `--legacy-peer-deps`。
- assistant-ui 要求 Cloud、AI SDK、AssistantTransport、internal 或 unstable API 才能完成核心路径。
- UI 需要让 library 持有 Session、审批、持久化、恢复或完成授权。
- 1280 expanded 无法保住 `610px` 中央对话宽度。
- 右栏必须同时展开审批、验证和失败才能解释状态。
- 浏览器出现任何非 localhost 请求。
- stage-one lock 审查发现未解决的 high/critical 漏洞、许可冲突、Git 依赖、缺失 integrity 或未经批准的 lifecycle script。
- 实现开始要求修改现有 Runtime、API 或旧 GUI 行为。

## 12. 两阶段依赖门

### Gate A：已获授权并完成

授权范围只包含 `src/surfaces/gui/app/`：

1. 手工创建最小 manifest，使用本页精确版本。
2. 先执行 `npm install --package-lock-only --ignore-scripts --strict-peer-deps --no-audit --no-fund`。
3. 审查 lockfile 的来源、integrity、许可、漏洞和全部 lifecycle scripts。
4. 审查通过后，再执行 `npm install --ignore-scripts --strict-peer-deps --no-audit --no-fund`。
5. 如果 scripts-disabled 安装可以 typecheck/build，lifecycle 激活集合保持为空。

执行结果：lockfile 139 个远端条目全部来自 npm Registry 且具有 integrity；实际安装 114 个包；audit 为 0；所有 lifecycle 保持禁用；子包 typecheck/build 通过。

### Gate B：未触发

任何 lifecycle script 需要运行时，先单独列出包名、脚本内容、作用目录、联网行为和回滚方式，再取得明确批准。当前没有 Gate B 请求。

回滚边界：manifest 与 lockfile 可由 Git 精确还原；`node_modules` 保持 ignored。清除 `node_modules` 属于另一次精确路径删除，需要按删除规则单独处理。

## 13. P2 完成后的裁决

- `GO`：所有硬验收通过，assistant-ui 依赖税与适配风险有真实构建和浏览器证据；再讨论 P3 事件映射。
- `NO-GO`：保留 Spike 与失败证据，回到 app-owned React primitives 或 vanilla 路线；不得通过引入 Cloud、第二 Runtime 或范围扩张挽救。
- P2 的 GO 不会自动归档旧 GUI，也不会授权真实 Runtime 接线。

## 14. 一手资料

- [assistant-ui Architecture](https://www.assistant-ui.com/docs/architecture)
- [Custom Runtime paths](https://www.assistant-ui.com/docs/runtimes/custom/overview)
- [ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)
- [assistant-ui Stability](https://www.assistant-ui.com/docs/runtimes/concepts/stability)
- [Primitives API](https://www.assistant-ui.com/docs/api-reference/primitives)
- [Message parts](https://www.assistant-ui.com/docs/primitives/message)
- [assistant-ui CLI side effects](https://www.assistant-ui.com/docs/cli)
- [Vite Getting Started and Node requirement](https://vite.dev/guide/)
- [React `createRoot`](https://react.dev/reference/react-dom/client/createRoot)
- [npm install `package-lock-only` / `ignore-scripts`](https://docs.npmjs.com/cli/v11/commands/npm-install/)
- [npm lifecycle scripts](https://docs.npmjs.com/cli/v11/using-npm/scripts/)

## 15. P2.1 主题校准回执

2026-09-02，Ludi 将视觉方向固定为 shadcn / Codex / DeepSeek Harness 一类的纯白中性工具界面。React Spike 只替换视觉 token、表面、边界、状态 badge 与相关文案；三栏信息架构、模拟数据、状态转换和所有 Owner 边界保持不变。

六张目标视口截图已重拍，子包 build、根 lint 与根 typecheck 通过。没有安装 shadcn、Tailwind 或新增包。完整证据见 [`src/surfaces/gui/app/ACCEPTANCE.md`](../src/surfaces/gui/app/ACCEPTANCE.md)，视觉规则见 [`src/surfaces/gui/app/DESIGN.md`](../src/surfaces/gui/app/DESIGN.md)。
