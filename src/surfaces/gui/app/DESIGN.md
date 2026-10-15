---
name: Jarvis Conversation Workspace
description: 本地编码 Agent 的纯白中性对话工作台
colors:
  background: "oklch(1 0 0)"
  foreground: "oklch(0.145 0 0)"
  primary: "oklch(0.205 0 0)"
  primary-foreground: "oklch(0.985 0 0)"
  muted-surface: "oklch(0.97 0 0)"
  muted-foreground: "oklch(0.556 0 0)"
  border: "oklch(0.922 0 0)"
  focus-ring: "oklch(0.708 0 0)"
  destructive: "oklch(0.577 0.245 27.325)"
  success: "oklch(0.49 0.12 150)"
  warning: "oklch(0.555 0.135 72)"
  info: "oklch(0.488 0.16 255)"
  code-surface: "oklch(0.18 0 0)"
  code-text: "oklch(0.93 0 0)"
typography:
  headline:
    fontFamily: '"Segoe UI Variable Display", "Microsoft YaHei UI", sans-serif'
    fontSize: "clamp(17px, 1.45vw, 21px)"
    fontWeight: 600
    lineHeight: 1.22
  title:
    fontFamily: '"Segoe UI Variable Display", "Microsoft YaHei UI", sans-serif'
    fontSize: "15px"
    fontWeight: 680
    lineHeight: 1.35
  body:
    fontFamily: '"Microsoft YaHei UI", "Segoe UI Variable Text", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: '"Microsoft YaHei UI", "Segoe UI Variable Text", sans-serif'
    fontSize: "11px"
    fontWeight: 650
    lineHeight: 1.45
  mono:
    fontFamily: "Consolas, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  sm: "6px"
  control: "7px"
  md: "8px"
  lg: "10px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  button-secondary:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  composer:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "16px"
    padding: "8px"
  review-card:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "12px"
    padding: "13px"
---

# Design System: Jarvis Conversation Workspace

## Overview

**Creative North Star: "Neutral Operations Workspace"**

Jarvis 使用纯白、低装饰、信息密度可控的桌面工作区。它让持续对话占据主要阅读空间，同时把会话连续性、人工权力和执行证据固定在可预期的位置。视觉层服务于判断速度，界面不制造纸张、贴纸、印章或文化材质联想。

整体气质接近 shadcn、Codex 与 DeepSeek Harness：文字近黑，边界浅灰，主要动作近黑，状态色只在运行事实需要区分时出现。三栏在空间上稳定，右栏只展示一个活动阶段，完成授权始终保持独立可见。

**Key Characteristics:**

- 纯白主表面与浅灰辅助表面。
- 1px 中性边界，圆角紧凑，阴影极轻。
- 对话优先的三栏桌面结构。
- 状态色稀少且语义固定。
- Motion 只说明状态变化，并完整支持 reduced motion。

## Colors

色彩策略由一组中性表面和四个低占比状态色组成。

### Primary

- **Near-black Action:** 用于唯一主动作、已授予的完成授权和高确定性选中态。

### Neutral

- **White Ground:** 页面、卡片和 Composer 的主表面。
- **Soft Neutral:** 侧栏、悬停、选项组和弱分区表面。
- **Near-black Text:** 标题、正文和主要操作文字。
- **Quiet Border:** 面板、卡片、输入框和分隔线。
- **Muted Text:** 时间、元数据、说明和未激活状态。

### Status

- **Destructive Red:** 失败、终止和未通过验证。
- **Verified Green:** 测试通过、会话完成和已授予完成授权。
- **Pending Amber:** 待审批、运行中和待处理步骤。
- **Evidence Blue:** 信息型状态和未知事件说明。

### Named Rules

**The White Ground Rule.** 主视图保持纯白；辅助层级只用轻微明度差和 1px 边界表达。

**The Semantic Color Rule.** 彩色只承载运行、审批、失败、验证或完成事实；导航和装饰继续使用中性色。

## Typography

**Display Font:** Segoe UI Variable Display，中文回退 Microsoft YaHei UI。

**Body Font:** Microsoft YaHei UI，拉丁文回退 Segoe UI Variable Text。

**Label/Mono Font:** UI 标签沿用正文栈；任务 ID、序号、命令和 Diff 使用 Consolas。

**Character:** 字体保持紧凑、清楚、工具化。层级主要依靠字号、字重、位置和留白，避免装饰性字形。

### Hierarchy

- **Headline**（600，17–21px，1.22）：当前任务目标，最多两行。
- **Title**（680，15px，1.35）：任务现场、活动阶段和证据区标题。
- **Body**（400，14px，1.65）：对话正文，主要阅读宽度上限 770px。
- **Label**（650，11px，1.45）：按钮、状态、工具项与元数据。
- **Mono**（400，11px，1.45）：任务 ID、序号、路径、命令和代码证据。

### Named Rules

**The Reading Width Rule.** 长消息、决策卡与 Composer 共享 770px 上限；空态输入区上限 785px。右栏打开时，大屏保持参考图中的阅读轴，窄屏将偏移限制在中栏边界内。右栏摘要保持短行，完整代码由扩展审阅承载。

## Layout

桌面壳层为会话栏 + 对话区两列默认视图，证据栏是按需打开的第三列抽屉（2026-09-26 修订：右栏不再常驻）。会话栏为 222px，证据抽屉 compact 为 306px、expanded 为 420px；1180px 以下右栏覆盖在对话上，700px 以下左栏收为 58px。页头高 36px，主阅读列显式使用 `minmax(0, 1fr)`，输入框与审批卡不能越过中栏边界。

2026-10-14 最新截图修订：右栏从顶部直接显示环境、上下文、连接器、输出内容、更改和服务器六组可折叠信息卡，支持进入与返回详情。compact 卡宽 280px、圆角 12px、padding 12px、间距 8px，首卡距顶部 53px；环境行高 26px。详情标题固定，七项导航为单行 32×32px 图标按钮，正文独立滚动、padding 16px。上下文容量从 models 响应取得，当前窗口占用未提供时保持未知；输入/输出图条只表示本次累计消耗。连接器清单、远程控制和开发服务状态缺失时诚实标注，已调用工具单独说明来源。

输入框空行高 46px，文件浏览与发送按钮在同一行，长输入最多 164px；模型与思考档移到下方。会话消息使用阅读式排版，作者与时间保留为可访问名称，未完整落盘提示仍可见。

中央对话独立滚动，Composer 固定在底部；需要人工判断的审批与验收以决策卡形式固定在 Composer 上方，任何滚动位置都可见可操作。点击工具、文件或 Diff 才打开证据抽屉并定位到对应页签。1280×800 expanded 必须保留 610px 中央宽度，并保持页面无整体横向滚动。

**The One Decision Rule.** 同一时刻对话区只呈现一个需要用户判断的决策卡（审批、验收或终态说明）；旧阶段转为消息流中的只读回执或证据。

**The Preserved Context Rule.** 暂停、终止和恢复保留三栏滚动位置、证据页签、焦点和 Composer 草稿。

## Elevation & Depth

界面以平面分层为主。常驻面板和活动阶段依靠明度、边界与间距建立层级；轻阴影只用于 Composer、选中页签和浮层。Dialog 使用较深的环境阴影，避免与主工作区混淆。

### Shadow Vocabulary

- **Soft Selection**（`0 1px 2px rgba(0, 0, 0, 0.04)`）：选中页签。
- **Raised Control**（`0 1px 3px rgba(0, 0, 0, 0.06)`）：Composer 等少量可输入表面。
- **Dialog Lift**（`0 18px 48px rgba(0, 0, 0, 0.16)`）：终止确认和 Toast。

### Named Rules

**The Flat-by-default Rule.** 常驻信息不使用投影；阴影只说明输入焦点、浮层或临时覆盖关系。

## Shapes

常规圆角集中在 6–10px。按钮与页签使用 6–8px；精修后的决策卡为 12px、Composer 为 16px。状态点与小型标签可以使用圆形或胶囊形；大面积容器保持紧凑矩形。所有结构边界使用 1px 描边。

## Components

### Buttons

- **Shape:** 紧凑矩形，控制圆角为 7px，高度 32px。
- **Primary:** 近黑底配近白文字，只用于当前阶段唯一主动作。
- **Secondary:** 白底、浅灰边界、近黑文字。
- **Danger:** 白底保留，文字与相关边界使用 destructive red。
- **Hover / Focus:** 150ms 颜色过渡；focus-visible 使用 2px 可见轮廓；按下位移 1px。

### Icons and feedback

正式 live/fixture 工作台统一使用 `lucide-react@1.57.0` 的具名图标。常规图标 16px、strokeWidth 1.8；空态标识 29px，置顶与链接标识 12px。图标按钮保留中文可访问名称，不以字符替代图标。

抽屉打开 220ms、关闭 150ms，采用 `cubic-bezier(0.22, 1, 0.36, 1)`，只移动和淡入淡出，不动画主阅读列的宽度。关闭中重开取消卸载；关闭时暂存内容设置 inert。菜单按压反馈 120–150ms，系统减弱动效偏好去掉位移与缩放。打开右栏会将焦点送入，Escape 尊重菜单与模态层级并归还触发器。

### Cards / Containers

- **Corner Style:** 活动阶段与 Composer 使用 8px 圆角。
- **Background:** 主卡片为白色，辅助区为 soft neutral。
- **Shadow Strategy:** 常驻卡片无阴影。
- **Border:** 1px quiet border；错误卡允许低饱和红色边界。
- **Internal Padding:** 活动阶段通常为 13px，低高度视口收紧为 11px。

### Inputs / Fields

- **Style:** 白色表面、1px 边界、8px 圆角；正文输入保持 13px。
- **Focus:** 边界切到 focus ring，并加 2px 低透明度环。
- **Disabled:** 透明度降至 0.38，保留标签可读性。

### Navigation

会话行默认透明；悬停和当前项使用白色表面与 1px 边界。会话状态由 6px 状态点和文字共同表达。证据页签使用浅灰底槽，选中项回到白色并加 soft selection 阴影。

### Active Decision Card

审批、验收与终态说明共用对话区 Composer 上方的同一位置与 10px 卡片轮廓，左侧 3px 语义色条区分类型。卡片标题、状态说明、主要动作和完成授权形成一条稳定判断链；状态转换保持内容位置连续，避免多个决策同时争夺注意力。

### Completion Authority

完成授权不再单独占位，合并进顶部单行状态 chip 的后半段（例如「运行中 · 完成未授权」「已完成 · 完成已授予」）。未授予时为中性描边；verified 后 chip 的状态点切到验证绿，文案切到已授予。它保持水平、无旋转、无印章造型。

## Do's and Don'ts

### Do:

- **Do** 让白色、中性灰和近黑承担绝大多数视觉面积。
- **Do** 把彩色留给审批、运行、失败、验证和完成事实。
- **Do** 在 1280×800 下验证中央阅读宽度、主动作与急停可达性。
- **Do** 使用 80–350ms 的状态过渡，并为 reduced motion 关闭位移、缩放、模糊和宽度动画。
- **Do** 在视觉简化后继续保留任务、证据、审批、恢复与完成授权信息。

### Don't:

- **Don't** 使用暖纸底、纸张纹理、朱砂印章、旋转贴纸、和风或中国风材质。
- **Don't** 用渐变、重阴影、玻璃模糊或装饰性图案制造层级。
- **Don't** 让多个活动阶段同时展开，或把审批入口复制到多个位置。
- **Don't** 用颜色作为状态的唯一线索。
- **Don't** 让 assistant-ui、shadcn 或任何组件库默认主题覆盖 Jarvis 的产品层级。
