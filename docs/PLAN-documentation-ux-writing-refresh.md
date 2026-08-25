# 文档体验优化工作单

> 状态：2026-08-25 完成。
> 类型：一次性工作单。范围为仓库内维护的 Markdown 文档；同步修正一处 CLI help 示例与对应测试。JSONL 数据、冻结评测输入和外部知识库不在本次改动范围内。

## 目标

让第一次接触 Jarvis-Agent 的读者能快速找到入口，让维护者能判断每份文档的职责与时效，并清除会误导操作或决策的过期表述。

## 范围

1. 盘点仓库内全部 Markdown 文档，按入口、使用指南、稳定合同、当前工作单、历史证据和运行时提示词分类。
2. 收缩 `README.md`，只保留定位、安装、首次运行、常用入口和文档导航。
3. 建立 `docs/README.md`，为每份文档指定唯一职责和阅读场景。
4. 校正长期文档中的过期状态、硬编码数量、重复命令说明和模糊来源指针。
5. 为仍有参考价值的历史计划与交接稿标明日期和用途，保留原始验收证据。
6. 运行链接、文案、CLI 帮助与项目门禁检查。

## 边界

- 不改产品行为、架构决策、测试阈值或历史验收结论。
- 不把历史快照改写成当前事实。
- 评测 prompt、agent role 和 bundled skill 属于运行时合同；仅在含义错误或指令不清时调整。
- 版本、测试数量、会话数量和运行状态只留在 Changelog、日期化证据或命令输出中。

## 完成标准

- `README.md` 不再重复完整命令参考、架构目录和阶段状态表。
- `docs/README.md` 覆盖仓库内全部 Markdown 文档，并清楚区分当前入口与历史材料。
- `KNOWN_ISSUES.md` 只列仍成立的限制，操作建议能落到具体命令或文档。
- 相对 Markdown 链接无断链；关键链接能落到具体文件或标题。
- `npm run jarvis -- --help` 与使用文档的命令名一致。
- 文案硬禁令检查通过；`typecheck`、`lint`、`test`、无输出 build compile 与 `git diff --check` 通过。

## 收口证据

- `docs/README.md` 已覆盖除自身外的全部 Markdown 文件。
- 相对链接与本地绝对链接检查无断链；全仓 Markdown 通过 `check-prose.py` 硬规则，禁用对比句式检索为零。
- `jarvis finalize --help` 已与真实 `--loop <id>` parser 对齐，定向测试 46/46 通过。
- `npm run typecheck`、`npm run lint`、`npm run build -- --noEmit`、`npm test` 与 `git diff --check` 通过；全量测试 150 files、1722 passed、2 skipped。
