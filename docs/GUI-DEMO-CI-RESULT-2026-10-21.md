# GUI Demo 远程门禁结果（2026-10-21）

源码提交：5f8e24053b6b5f267b4c6e7b37c7f5a20664ded6。分支 codex/gui-demo-border-sync-20261021 已成功推送，本地与 origin 一致。后续提交仅补充此验证记录，GUI 源码不变。

门禁：https://github.com/Ludi-Herry/jarvis-agent/actions/runs/39643276411 。本记录为明确的未通过结果，不作为发布或合并放行。

Linux 结果：4 个测试文件失败、168 个通过；7 项测试失败、2173 项通过。涉及 test/cli/jarvis-cli.test.ts、test/cli/sessions-cli.test.ts、test/cli/loop-finalize-cli-smoke.test.ts、test/capabilities/shadow/shadow-git.test.ts。可见错误包括预期退出码2/7但实际5、依赖桥在 git status 中显示 ?? node_modules、ShadowGit 清理临时目录时 ENOTEMPTY。

本轮相对 f0d1f4f 的 src/、test/、scripts/、.github/、根 package.json 与 package-lock.json 差异为空。失败位于未改动的 CLI/Git 测试；没有对旧提交在相同 CI 环境做干净对照，尚不能断言是既有失败。未修改无关 Runtime、测试、阈值或 CI 配置来消除红灯。

Windows 当前状态与两平台完整步骤见 evidence/gui-demo-closeout-2026-10-21/ci-run-snapshot.json；本记录捕获时 Windows 仍在测试阶段。整体远程门禁未签收。

后续若处理门禁，应先在相同环境对照基线提交与 GUI 提交，再按 CLI 退出码、依赖桥 Git 识别、ShadowGit 临时目录清理三组定位。不得跳过失败或降低断言；对 Runtime 或 CI 配置的扩展变更另按项目授权边界处理。本轮只做 GUI 交付与失败留档。

本地完整构建、类型检查、Lint、2178项测试通过（2项既有跳过），GUI 修复获得 Owner 认可；这些事实不能替代远程门禁。原始本地日志、Linux完整失败日志及最初无法下载日志的错误原文留在本机 evidence 目录，不覆盖历史材料。
