# gui-plain-v1 对照稿源码

2026-10-15 · 方案与签收要点见 `docs/PLAN-gui-plain-v1.md`。这是**静态演示稿**：数据全部来自 `src/scenario.ts` 的剧本，不连 Jarvis Runtime，不是正式 GUI 代码。

- 技术：Vite + React 19，`vite-plugin-singlefile` 打成一个自包含 HTML（`npm install && npm run build` → `dist/index.html`）。
- 结构：`src/App.tsx` 三栏骨架与走查台；`src/ui/` 侧栏、对话、输入框、右栏（更改 / 预览 / 终端）、走查台；`src/store.ts` 状态机与自动演示；`src/theme.css` 色彩与字体 token；`src/arc/` 只保留用到的 Arc 控件。
- 来源：PastaUI 布局与输入框形态；Arc（uiarc.dev registry，未见独立许可证声明，进正式 GUI 前需确认）；`thinking-orbs`、`border-beam`（均 MIT）。

## 未随提交的二进制文件

推送工具只支持文本，下列文件没有入库，构建前需放回原路径（或直接用对话附件里的单文件 HTML，已内嵌）：

- `src/assets/fonts/manrope-latin.woff2`：Manrope 可变字体拉丁子集（SIL OFL），取自 PastaUI showcase 资源；可用 `@fontsource-variable/manrope` 的 latin woff2 替代。
- `src/assets/old/{empty,running,approval,complete,failed,recoverable}.webp`：现行 GUI 对应试件的截图（`?fixture=` 各状态，1440×900），用于「旧版 / 新稿」滑动对照。
