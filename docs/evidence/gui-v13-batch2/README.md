# 批 2 证据包：自由任务 / 工作区 / 讨论分支 / Git 只读 / 模型选择（2026-10-06）

设计合同：`docs/PLAN-gui-v13-batch2-architecture.md`。服务端测试：`test/surfaces/gui/gui-batch2-registry.test.ts`（17 条，含 meta 重放、workspaces、validate/create/start/409、HTTP 全链路、分支注入与零继承、截断边界、git/models 降级）。

## 截图与交互实证（4 张 + 交互回执）

| 文件 | 内容 |
| --- | --- |
| create-panel-1440x900.png | 自由任务创建面板：目标/工作区/预算/写入路径/检查命令/单模型与思考档只读行；钉合同卡并存 |
| multi-rail-1440x900.png | 左栏多工作区分组：置顶(●)、运行中、已归档 · 1 折叠、第二工作区 idle 任务、新建工作区入口 |
| branch-idle-1440x900.png | 讨论分支：来源条 + 启动卡 + [前情] 消息链 + 左栏「分支 ·」行 |
| git-context-1280x800.png | 证据栏「上下文」页签 Git 只读行（分支 main · 未提交 2 · 领先 1）+ Composer 模型/思考 pill |

交互实证（Playwright，fixture 内存链，非验收结论）：
- 填写创建表单 → 校验合同 → 创建并启动 → 状态 chip「运行中」，页头标题 = 新目标。
- 回复操作条「分支」钮 → 确认弹窗 → 创建分支 → 跳转新任务（idle 卡 + 来源条 + 左栏前缀行）。
- 任务行 ⋯ 菜单：重命名 inline、置顶/取消置顶、归档/恢复（fixture updateMeta 打通）。
- console 0 错误（chrome-devtools 列表验证）。

## 服务端确定性门

- `vitest run --maxWorkers=4` 全量 **1777 通过 / 2 skipped / 0 失败**；根 lint / 双 typecheck 绿；app build 绿。
- 覆盖清单（17 条新增）：gui_meta 折叠与重启读回、非法 meta 400、workspaces 登记/持久/校验失败（相对路径/不存在/symlink）、validate 逐字段 + dry-run 零落盘零模型、create 后 idle 无消耗、start 互斥 409、运行中创建第三任务、分支来源链 + 前情注入 + 父 goal/审批零继承、forkFrom 错误、excerpt 截断三边界、git porcelain 解析/unavailable/缓存、models 双档形状、contract.model 落 journal。

## 本批缓做（登记，非缺口）

多任务并发运行（B2）、团队/子智能体、内置浏览器、终端、Skill/MCP、附件、设置七类全量、侧边对话驱动 Agent、上下文用量、钩子记录、工作区文件浏览、取消运行的删除清理（只有归档，无删除入口，符合纪律）。P3 旧真实任务真人验收继续等 Owner 运行窗口。

## 已知小问题（交 Owner）

- fixture 试件的「创建并启动」直接换到 running 标本现场（fixture 简化语义：不模拟真实 round 过程）。
- 运行中任务锁定左栏切换（沿用 9-26 行为；B2 并发批再定义查看-运行分离）。
- 分支钮在所有（非 fixture）回复上显示；真实环境无真实 provider 多档时思考 pill 恒为单档只读。
