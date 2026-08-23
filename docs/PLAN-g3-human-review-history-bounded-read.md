# G3 人工裁决历史：有界读取与路径绑定修复提案

> 状态：2026-08-23 Ludi 批准方案 A；有界读取、顺序路径绑定与负例已落地，最终独立复核 GO（P0/P1/P2/P3=0）。

## 触发条件

同一核心质量信号连续两轮失败：`data/human-reviews/*.jsonl` 的读取预算和路径绑定仍可被并发增长或同用户路径交换绕过。仓库停止线要求先统一修复设计，禁止继续逐点补丁。

## 当前证据

- G3 功能、表单、历史降级、服务端串行化与 planned/committed 审计已实现；聚焦 5 files / 72 passed，全量 149 files / 1706 passed / 2 skipped，typecheck、lint、build `--noEmit`、diff check 全绿。
- Browser 已验证 6 个字段的唯一 `id/name`、required、1000 上限、实时计数、空白备注不提交、手机无横向溢出、console 0 warning/error。
- 第一轮复核 4 P1 已收敛；第二轮只剩两项：`FileHandle.readFile()` 可越过读取前的 size 检查，路径 `lstat/realpath/open` 缺少可证明的顺序绑定。
- 当前 Windows Node 运行时没有 `O_NOFOLLOW` / `O_DIRECTORY` 常量，标准 `fs` 无法取得 Win32 handle 的最终路径。完全抵抗恶意同用户进程的原子换链需要原生 Win32 能力或新增依赖。

## 共同 Owner 与同构绑定

共同 Owner 为 `src/capabilities/goal/human-review.ts::listHumanReviewHistory`。一次性处理以下绑定：

1. 目录枚举预算：最多检查 1000 个目录项、200 个 JSONL 文件。
2. 文件字节预算：从已打开 handle 只读 `MAX + 1` 字节，绝不读到 EOF；多出的 1 字节只用于判定超限。
3. 记录预算：使用专用行扫描器，达到 1000 条有效记录后立即停止，不先构造完整记录数组。
4. warning 预算：最多 20 种通用告警，禁止回显文件名和 goal id。
5. 路径顺序：`lstat leaf → realpath containment → open canonical path → handle.stat identity → bounded handle.read → handle.stat post-check`，所有步骤串行。
6. 决策路径：同 goal 继续由服务端队列串行；审计继续 `planned → goal → committed`；planned-only 在 GUI 显示“待核对”，`loop-finalize` 不接受其完成证据。

## 方案 A：沿用项目既有同用户竞态边界（推荐）

落地上述六项，并把剩余边界写进 handoff：稳定 symlink/junction、hard link、越界 canonical path、检查前后 identity/size 漂移全部拒绝；具备本机同用户权限、能在数个系统调用之间反复交换并恢复同一文件身份的恶意进程仍超出当前保证。这与 sessions 路径现有的 hostile same-user TOCTOU 边界一致。

影响：零依赖、零构建链、Windows 可运行；可以证明单次 GUI 请求的 CPU/内存/返回量有硬上限。极端同用户竞态仍登记为范围外安全边界。

## 方案 B：增加 Windows 原生 handle 最终路径能力

引入原生 Win32 调用（`CreateFileW(FILE_FLAG_OPEN_REPARSE_POINT)` + `GetFinalPathNameByHandleW`）或第三方 FFI 依赖，再与 POSIX `openat/O_NOFOLLOW` 做平台分支。

影响：可将路径身份原子绑定到 handle；会引入依赖、构建链、平台维护和安装审计，命中 v0.3 “引依赖前先问”边界。当前 no-build GUI 切片不建议扩到这里。

## 方案 C：Windows 暂停历史内容读取

Windows 只返回 `coverage: partial` 与“历史读取暂不可用”，POSIX 使用 `O_NOFOLLOW`；待未来原生 runtime 再开放。

影响：安全面最窄，G3 的“已裁决历史”在当前主平台无法交付。

## 负例与验收

- 文件在 size 检查后继续增长：读取量仍不超过 `MAX + 1`，结果 partial，pending queue 继续返回。
- 单文件含 1001 条紧凑有效 JSONL：只解析 1000 条并明确截断。
- stable symlink/junction、hard link、目录伪装文件、canonical 越界：全部跳过且不读取内容。
- handle 打开后替换原路径：读取仍来自原 handle；post-stat 漂移时结果 partial。
- 201 个 JSONL / 1001 个目录项 / 21 种失败：各预算都在边界处停止。
- 两个并发裁决：只产生一个新 goal round；审计为同一 decisionId 的 planned/committed。
- 只存在 planned 审计：GUI 显示“待核对”，loop-finalize 继续 park。
- 完成后重跑聚焦、四项静态门、全量测试、真实 Browser 与独立 P0/P1 门。

## 待裁决

Ludi 已选择方案 A。方案 B/C 保留为本次裁决记录，不进入当前实现。

## 闭环证据

- 固定 `MAX + 1` buffer 从已校验 handle 读取；读取后再次比较 size/mtime/ctime，增长或漂移直接 partial。
- 行扫描器在保存第 1001 条有效记录前停止；目录项、文件数、单文件字节、记录数和 warnings 都有固定上限。
- 路径顺序固定为 `lstat leaf → realpath containment → open canonical path → handle.stat identity → bounded handle.read → post-stat`。
- 负例覆盖打开后增长、路径验证后换文件、1001 条紧凑记录、超大文件、hard link、目录伪装文件与 history 降级不影响 pending GET。
- 聚焦 5 files / 75 passed；canonical 全量 149 files / 1709 passed / 2 skipped；typecheck、lint、build `--noEmit`、diff check 全绿。
