# 质量门禁说明：门禁、红线、变异测试

> 类型：指南。写给 Ludi：每道检查**管什么、什么时候跑、红了怎么办**。规则本身写在 [AGENTS.md](../AGENTS.md) 的「独立裁判（CI）与红线」。

## 一句话

AI 写代码、AI 自己说"测试都过了"，这件事本身不可信 —— 就像运动员自己记分。所以加了三道**不归 AI 管**的检查：

| 检查 | 比喻 | 什么时候跑 | 查什么 | 红了谁处理 |
|---|---|---|---|---|
| **门禁**（CI） | 独立裁判 | 每个 PR、每次推到 main，自动 | 在 GitHub 的干净机器（Linux + Windows）上从零装依赖，跑类型检查、Lint、全部测试、构建、GUI 构建 | AI 修，修到绿为止 |
| **红线检查** | 改记分牌要报备 | 每个 PR 自动；直接推到 main 也查 | 有没有改"门禁、裁判、权限、证据"这些文件；有没有偷偷跳过测试、关检查、删断言 | **Ludi 看一眼**，没问题就加标签「红线已确认」 |
| **变异测试** | 考考裁判 | 手动（加标签 `mutation`） | 故意把权限判定、完成判定的代码改坏几千次，看测试能不能发现 | AI 补测试 |

## 门禁（`.github/workflows/ci.yml`）

- **在哪看**：PR 页面底部的检查列表，名字是「门禁 (ubuntu-latest)」「门禁 (windows-latest)」。点 Details 能看每一步的输出。
- **为什么两个系统**：你在 Windows 上开发，很多问题只在 Windows 出现（路径、换行、Shell）。两个都绿才算绿。
- **花多少**：私有仓库免费额度每月 2000 分钟；Windows 按 2 倍计。一次 PR 大约 Linux 几分钟 + Windows 十分钟左右（以实际运行记录为准）。如果额度紧张，可以把 Windows 改成只在推到 main 时跑。
- **红了怎么办**：让 AI 看 Details 里的报错修。**不接受**"本地是绿的"作为理由 —— 门禁就是为了不信本地。
- **偶发超时**：CLI 子进程测试在机器忙时偶尔超时（已知问题）。门禁里用 `--maxWorkers=2` 降低并发；仍然偶发时，点 Re-run 重跑一次，连续两次红就是真问题。

## 红线检查（`.github/workflows/redline.yml`）

**红线文件**清单在 [`.github/redlines.txt`](../.github/redlines.txt)，每行写了原因。大致是：

- 门禁和规则本身：`.github/**`、`AGENTS.md`、检查脚本、变异测试配置；
- 检查工具的配置：`package.json`、`tsconfig*.json`、`vitest.config.ts`、`eslint.config.js`、GUI 的 `package.json` / `tsconfig.json`；
- 裁判（判"完成没有"）：`verdict.ts`、`checks.ts`、`verifier.ts`；
- 安全边界（判"能不能做"）：`src/runtime/permission/**`、`src/capabilities/hooks/**`、`plain-controls.ts`；
- 证据：`docs/evidence/**` 只许新增，改和删都要确认；`docs/TODO-v01-evidence.md`。

另外自动标出 `src/` 和 `test/` 里的**降规则迹象**：新增 `.skip` / `.only` / `.todo` / `skipIf`、`@ts-ignore` / `@ts-nocheck` / `@ts-expect-error`、`eslint-disable`；删除测试文件；修改过的测试文件里 `expect` 断言净减少。

**碰到红线时你会看到**：检查变红，PR 里出现一条「红线检查」评论，列出每个文件和原因。

**怎么确认**：

1. 打开 PR 的 **Files changed**，看评论里列出的文件：改动是你要的吗？有没有放松检查、跳过测试、改判定逻辑？
2. 没问题 → 右侧 **Labels** 加「红线已确认」。检查自动重跑、变绿，评论会记下是谁加的标签。
3. 有疑问 → 别加，在 PR 里留言让 AI 解释或撤回。

**之后再推新提交**：只看"新推的这批"有没有碰红线 —— 没碰，确认保留；碰了，标签自动撤掉，需要你重新看。

**直接推到 main**（没走 PR）：如果碰到红线，检查变红并自动开一个 issue 提醒你。通过已确认的 PR 合并进来的不会报警。

**安全设计**：PR 上的红线检查，脚本和清单永远取自 **main 上的版本**（GitHub 规定 `pull_request_target` 只跑默认分支上的工作流）；直接推送时取自**推送之前的版本**。PR 里的代码只被当数据读、从不执行。所以就算 PR 改了清单或脚本，也骗不过对它自己的这次检查（而且改清单本身就是红线）。

**诚实的局限**：

- 标签只是"有人确认过"的记号。任何有仓库写权限的人或工具都能加 —— 包括用你的 token 工作的 AI。AGENTS.md 明令 AI 不许加，评论和 PR 时间线都会记下是谁加的；你确认时顺手看一眼"标签由 @Ludi-Herry 添加"。
- 红线检查要等 `redline.yml` 进了 main 才开始工作：引入它的那个 PR 自己不会被检查，在此之前开着的 PR 要再推一次提交（或关掉重开）才会触发。
- 私有仓库在 GitHub 免费版上**不能**设置"检查不绿就禁止合并"（分支保护需要 Pro）。所以这些检查是**醒目的信号**，最后一道闸是你：**检查没全绿就不点合并**。如果以后升级了 Pro，可以在 Settings → Branches 把「门禁」「红线检查」设成必需。

## 变异测试（`.github/workflows/mutation.yml`）

**它在考什么**：测试是裁判，可裁判自己靠不靠谱？变异测试故意把代码改坏（比如把 `deny` 改成 `allow`、把 `every` 改成 `some`、删掉一个判断），每改一处就跑一遍测试。测试变红 = 抓住了；还是绿 = 这个"坏"溜过去了（叫"存活"）。**变异分** = 抓住的比例。

**测哪些文件**：最不能出错的判定逻辑 —— `verdict.ts`（完成没有）、`decide.ts` / `permission-gate.ts` / `command.ts`（能不能做），以及 plain-v1 分支上的 `plain-controls.ts`（权限模式与撤销边界）。

**怎么跑**：在 PR 上加标签 `mutation`（跑完自动撤掉标签，结果贴在 PR 评论里）；或者 Actions → 变异测试 → Run workflow。大约 10–20 分钟。完整报告在运行页面的 Artifacts → `mutation-report`，下载后打开 `index.html`。

**怎么看结果**：分数高低不是重点，重点是**存活的"放行方向"变异** —— 也就是"改坏之后，本该拒绝的变成放行、本该判失败的判成完成"。规则：

- 放行方向（deny / ask → allow、命令分析器漏报危险或密钥、rejected → verified、审批人看不到要批什么）：**必须补测试杀掉**；
- 其他存活的分类说明：严格方向（改坏后反而多拦）、只影响说明文字、等价变异（改了但行为完全一样）、崩溃（会抛错，由上层兜住）。

**本机跑**（可选，约 10 分钟）：

```powershell
npm i --no-save --ignore-scripts @stryker-mutator/core@10.0.0 @stryker-mutator/vitest-runner@10.0.0
npx stryker run scripts/mutation/stryker.config.mjs
```

报告在 `reports/mutation/index.html`（已加进 `.gitignore`）。

### 变异测试记录（2026-10-16，main @ `56df2ea`）

环境：Stryker 10.0.0 + vitest 4，2 核，`concurrency: 2`，全量约 8 分钟。

| 文件 | 变异数 | 基线分 | 补强后 | 补强方式 |
|---|---|---|---|---|
| `verdict.ts` | 201 | 79.6% | **99.5%** | `verdict-mutation.test.ts` 13 条 |
| `decide.ts` | 159 | 69.8% | **89.9%** | `decide-mutation.test.ts` 18 条 |
| `permission-gate.ts` | 151 | 77.5% | **94.7%** | `permission-gate-mutation.test.ts` 16 条 |
| `command.ts` | 1502 → 1505 | 57.0% | **79.5%** | `command-mutation.test.ts` 216 条 + 修 2 个漏报 |
| **合计** | 2013 → 2016 | **61.8%** | **83.4%** | |
| `plain-controls.ts`（plain-v1 分支） | 182 | 73.6% | **88.5%** | `gui-plain-controls-mutation.test.ts` 18 条 |

`command.ts` 的补强方法：自建 3508 条命令的语料（现有测试里的命令 + 每条规则的变形），把每个存活变异单独套上去，和原代码逐条比判定。凡是"原来标危险/碰密钥、改坏后变干净"的就是放行方向，从里面挑出最少的 139 条命令写进测试，再挑 61 条日常安全命令守住"不误拦"。

**剩下的存活变异，逐类说明**（放行方向：**0**）：

| 文件 | 剩余 | 分类 |
|---|---|---|
| `verdict.ts` | 1 | 等价：`pinned` 默认值从空数组改成含一个假条目，两种情况都走"无法验证"。 |
| `decide.ts` | 16 | 只影响说明文字 9；等价 6（`executes-code` 默认值在命令分支里根本不读、`rules` 默认数组里塞进字符串匹配不到任何工具、非字符串命令按空命令处理等）；严格方向 1（路径参数名正则去掉 `$`，多扫几个参数）。 |
| `permission-gate.ts` | 8 | 等价 7（字符串回答没有 `.reason`、空参数 `''` 和 `'{}'` 解析结果相同等）；严格方向 1（非字符串命令的会话授权按工具名记，只会多问）。 |
| `command.ts` | 309 | 用同一语料复查：**放行方向 0**，严格方向 7，语料上看不出区别 302（其中 28 条只改说明文字；其余多在报错信息格式化、解析失败的兜底和多层重复防护里）。"看不出区别"不等于严格证明等价，但已没有能找到的放行反例。 |
| `plain-controls.ts` | 21 | 只影响报错文字 13；等价 8（git 输出本来就规整时去掉正则锚点 / `trim()`、空字符串混进集合等）。 |

**这一轮顺带找到的真实问题**

1. **已修**：`trap "$X" EXIT` 和 `git -c "core.pager=$X" log` 这类"值是变量"的写法，分析器当成空字符串放过了（代码本意是"不是字面量就判危险"，但先判了"空 = 忽略"）。是一个"改坏后反而更严"的存活变异暴露的。现在两类都判危险；`trap '' EXIT`、`git -c core.pager=cat log` 等正常写法不受影响。
2. **未修，记入 Known Issues**：`sed` 的 `e` 命令 / `s///e` 标志、`awk` 的非字面量程序或 `-f` 脚本不会被标危险；配置的拒绝规则里 `*` 不跨换行。三者都只是"该直接拒绝的变成弹审批"——Bash 本来就逐条要人批准（[安全评审基线](security-review-baseline.md)：deny→ask 不算高危）。要修需要按 AGENTS.md 走安全评审，单开 PR。

**以后怎么维护**：改了上面这些文件，就加 `mutation` 标签跑一次。摘要里出现新的放行方向存活变异 → 补测试杀掉；其他类型在 PR 里说明分类即可。分数不设硬门槛。
