# Round 2 参考阅读回执模板

> 复制为参赛目录下的 `REFERENCE-READ.md`。完成此文件前禁止开始写页面。

## 身份与访问

- Agent：`<kimi | zcode | gemini>`
- 时间：`<date>`
- 参考访问：`browser-opened | packet-only | mixed`
- 无法打开的来源：`<none 或逐项列出>`

## 逐卡判断

| 参考卡 | 实际打开的来源 | 吸收 1 条 | 拒绝 1 条 | Jarvis 转译动作 |
|---|---|---|---|---|
| OpenHanako |  |  |  |  |
| Tutti |  |  |  |  |
| Kun |  |  |  |  |
| CodePilot |  |  |  |  |
| Jarvis 不变量 |  |  |  |  |
| 两类反例 |  |  |  |  |

## 本稿的独立主张

- 结构主张：
- 视觉主张：
- 交互主张：
- 与 Round 1 的预期差异：只写抽象维度，禁止读取 Round 1 页面后填写。

## 首屏草图检查

- 当前目标位置：
- 当前阶段位置：
- 停下原因位置：
- 用户动作位置：
- 完成授权位置：
- 对话主路径：
- Artifact/Diff 进入路径：

## 事实保真

- 文件 1：`src/surfaces/gui/assets/presentation.js`
- 文件 2：`test/surfaces/gui/gui-presentation.test.js`
- 改动：`+29 / −2`
- 权限：`workspace.write`
- 完成：`decideVerdict · verified（模拟）`
- 禁止自行增加真实 Runtime API、测试数字或未在 Brief 中出现的成功事实。
