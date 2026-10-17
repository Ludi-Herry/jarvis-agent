/**
 * 红线检查（redline check）。
 *
 * 作用：找出一次改动里碰到"红线文件"（门禁、裁判、权限、证据……）或疑似"降规则"
 * （跳过测试、关类型检查、删断言……）的地方，交给 Ludi 人工确认。
 *
 * 只用 node: 内置模块，CI 里直接 `node scripts/redline-check.ts ...`（Node 24 原生去类型）。
 * 工作流永远从"可信版本"（PR 的 base / push 前的提交）取本脚本和规则，绝不执行 PR 里的代码。
 *
 * 用法：
 *   node scripts/redline-check.ts --rules .github/redlines.txt --base <sha> --head <sha>
 *     [--repo <dir>] [--event pr|push] [--action synchronize] [--has-label true|false]
 *     [--since <上一次PR头sha>] [--confirmed-by <login>] [--out-json result.json] [--out-md report.md] [--quiet]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CONFIRM_LABEL = '红线已确认';
export const COMMENT_MARKER = '<!-- redline-check -->';

export interface Rule {
  pattern: string;
  note: string;
  /** true = 只在改/删/改名时触发（新增不算），对应规则前缀 `改删:` */
  modifyOnly: boolean;
  regex: RegExp;
}

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X';

export interface Change {
  status: ChangeStatus;
  path: string;
  /** 改名/复制时的原路径 */
  oldPath?: string;
}

export type FindingKind = 'redline-file' | 'weakening';

export interface Finding {
  kind: FindingKind;
  path: string;
  /** 给人看的中文原因 */
  reason: string;
  /** 触发的规则或可疑片段 */
  detail: string;
}

/** 把 glob 转成正则：`**` 跨目录，`*` 不跨目录，`?` 单个非 `/` 字符。 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` 可匹配零层或多层目录；结尾 `**` 匹配剩余全部
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += '\\' + ch;
    } else {
      out += ch;
    }
  }
  return new RegExp('^' + out + '$');
}

/** 解析 `.github/redlines.txt`：每行 `规则 | 说明`，`#` 开头为注释。 */
export function parseRules(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const bar = line.indexOf('|');
    let pattern = (bar === -1 ? line : line.slice(0, bar)).trim();
    const note = bar === -1 ? '' : line.slice(bar + 1).trim();
    let modifyOnly = false;
    if (pattern.startsWith('改删:')) {
      modifyOnly = true;
      pattern = pattern.slice('改删:'.length).trim();
    }
    if (pattern === '') continue;
    rules.push({ pattern, note, modifyOnly, regex: globToRegExp(pattern) });
  }
  return rules;
}

/** 解析 `git diff --name-status -z -M` 的输出。 */
export function parseNameStatusZ(output: string): Change[] {
  const parts = output.split('\0').filter((p) => p !== '');
  const changes: Change[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i]!;
    const status = code[0] as ChangeStatus;
    if (status === 'R' || status === 'C') {
      const oldPath = parts[i + 1];
      const path = parts[i + 2];
      if (oldPath === undefined || path === undefined) break;
      changes.push({ status, path, oldPath });
      i += 3;
    } else {
      const path = parts[i + 1];
      if (path === undefined) break;
      changes.push({ status, path });
      i += 2;
    }
  }
  return changes;
}

function describeStatus(status: ChangeStatus): string {
  switch (status) {
    case 'A':
      return '新增';
    case 'D':
      return '删除';
    case 'R':
      return '改名';
    case 'C':
      return '复制';
    default:
      return '修改';
  }
}

/** 文件级红线：哪些改动碰到了规则。 */
export function matchRedlineFiles(changes: Change[], rules: Rule[]): Finding[] {
  const findings: Finding[] = [];
  for (const change of changes) {
    // 改名时，旧路径按"删/改"算，新路径按"新增"算
    const candidates: Array<{ path: string; isAddition: boolean }> = [];
    if (change.status === 'R') {
      candidates.push({ path: change.oldPath!, isAddition: false });
      candidates.push({ path: change.path, isAddition: true });
    } else {
      candidates.push({ path: change.path, isAddition: change.status === 'A' || change.status === 'C' });
    }
    for (const rule of rules) {
      const hit = candidates.find((c) => rule.regex.test(c.path) && !(rule.modifyOnly && c.isAddition));
      if (hit === undefined) continue;
      findings.push({
        kind: 'redline-file',
        path: change.status === 'R' ? `${change.oldPath} → ${change.path}` : change.path,
        reason: `${describeStatus(change.status)}了红线文件${rule.note ? `（${rule.note}）` : ''}`,
        detail: (rule.modifyOnly ? '改删:' : '') + rule.pattern,
      });
      break; // 一个文件报一次就够
    }
  }
  return findings;
}

const CODE_FILE = /^(src|test)\/.*\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const TEST_FILE = /^test\/|\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

const WEAKENING_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\.(skip|only|todo)\s*\(/, reason: '新增了跳过/独跑测试（.skip/.only/.todo）' },
  { re: /\b(skipIf|runIf)\s*\(/, reason: '新增了条件跳过测试（skipIf/runIf）' },
  { re: /@ts-(ignore|nocheck|expect-error)\b/, reason: '新增了关闭类型检查的注释' },
  { re: /eslint-disable/, reason: '新增了关闭 lint 规则的注释' },
];

const EXPECT_CALL = /\bexpect(?:\.soft)?\s*\(/g;

export function isCodeFile(path: string): boolean {
  return CODE_FILE.test(path);
}

export function isTestFile(path: string): boolean {
  return CODE_FILE.test(path) && TEST_FILE.test(path);
}

interface FileHunks {
  added: string[];
  removed: string[];
}

/** 把 `git diff -U0` 的统一格式切成"每个文件的增/删行"。 */
export function parseUnifiedDiff(diff: string): Map<string, FileHunks> {
  const files = new Map<string, FileHunks>();
  let current: FileHunks | undefined;
  let oldPath: string | undefined;
  let inHeader = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = undefined;
      oldPath = undefined;
      inHeader = true;
      continue;
    }
    if (inHeader) {
      // 只有文件头里的 ---/+++ 才是路径；内容行里以 "-- " 开头的不能误判
      if (line.startsWith('--- ')) oldPath = headerPath(line.slice(4), 'a/');
      else if (line.startsWith('+++ ')) {
        const target = line.slice(4);
        const path = target === '/dev/null' ? (oldPath ?? '') : headerPath(target, 'b/');
        current = files.get(path) ?? { added: [], removed: [] };
        files.set(path, current);
      } else if (line.startsWith('@@')) inHeader = false;
      continue;
    }
    if (current === undefined || line.startsWith('@@')) continue;
    if (line.startsWith('+')) current.added.push(line.slice(1));
    else if (line.startsWith('-')) current.removed.push(line.slice(1));
  }
  return files;
}

function headerPath(raw: string, prefix: string): string {
  let p = raw.replace(/\t$/, '');
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

function countExpect(lines: string[]): number {
  let n = 0;
  for (const line of lines) n += line.match(EXPECT_CALL)?.length ?? 0;
  return n;
}

function snippet(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > 120 ? trimmed.slice(0, 117) + '...' : trimmed;
}

/** "降规则"启发式：只看 src/ 和 test/ 下的代码文件。 */
export function scanWeakening(changes: Change[], diff: string): Finding[] {
  const findings: Finding[] = [];
  const hunks = parseUnifiedDiff(diff);
  for (const change of changes) {
    if (change.status === 'D' && isTestFile(change.path)) {
      findings.push({ kind: 'weakening', path: change.path, reason: '删除了测试文件', detail: '' });
      continue;
    }
    if (change.status === 'R' && isTestFile(change.oldPath!) && !isTestFile(change.path)) {
      findings.push({
        kind: 'weakening',
        path: `${change.oldPath} → ${change.path}`,
        reason: '测试文件被改名到测试目录之外（不会再被运行）',
        detail: '',
      });
      continue;
    }
    if (change.status === 'D' || !isCodeFile(change.path)) continue;
    const file = hunks.get(change.path);
    if (file === undefined) continue;
    for (const { re, reason } of WEAKENING_PATTERNS) {
      const hit = file.added.find((l) => re.test(l));
      if (hit !== undefined) findings.push({ kind: 'weakening', path: change.path, reason, detail: snippet(hit) });
    }
    if (change.status !== 'A' && isTestFile(change.path)) {
      const net = countExpect(file.added) - countExpect(file.removed);
      if (net < 0) {
        findings.push({
          kind: 'weakening',
          path: change.path,
          reason: `测试断言净减少 ${-net} 处（expect 调用）`,
          detail: `新增 ${countExpect(file.added)}，删除 ${countExpect(file.removed)}`,
        });
      }
    }
  }
  return findings;
}

export interface Decision {
  /** 本次检查是否通过 */
  pass: boolean;
  /** 是否要撤掉「红线已确认」标签（有新提交，旧确认作废） */
  removeLabel: boolean;
  /** 一句话状态 */
  status: 'clean' | 'needs-confirmation' | 'confirmed' | 'confirmation-reset';
}

/**
 * 判定逻辑（纯函数，便于测试）：
 * - 没有发现 → 通过
 * - 有发现 + 有确认标签 + 新推上来的那批提交（增量）又碰到红线 → 撤标签、不通过（需重新确认）
 *   （拿不到增量时按"碰到了"处理，宁严勿松）
 * - 有发现 + 有确认标签 → 通过（新提交没碰红线，之前的确认仍有效）
 * - 有发现 + 没有确认标签 → 不通过
 */
export function decide(
  findingCount: number,
  hasLabel: boolean,
  action: string,
  incrementalFindingCount?: number,
): Decision {
  if (findingCount === 0) return { pass: true, removeLabel: false, status: 'clean' };
  const newRedlineCommits = action === 'synchronize' && (incrementalFindingCount === undefined || incrementalFindingCount > 0);
  if (hasLabel && newRedlineCommits) return { pass: false, removeLabel: true, status: 'confirmation-reset' };
  if (hasLabel) return { pass: true, removeLabel: false, status: 'confirmed' };
  return { pass: false, removeLabel: false, status: 'needs-confirmation' };
}

function code(text: string): string {
  // 文件名可能带反引号或尖括号，统一转义后放进代码段
  return '`' + text.replace(/`/g, "'").replace(/[\r\n]/g, ' ') + '`';
}

export interface ReportContext {
  event: 'pr' | 'push';
  base: string;
  head: string;
  decision: Decision;
  confirmedBy?: string;
}

export function renderReport(findings: Finding[], ctx: ReportContext): string {
  const lines: string[] = [COMMENT_MARKER, '## 红线检查', ''];
  const range = `${ctx.base.slice(0, 7)}...${ctx.head.slice(0, 7)}`;
  const { status } = ctx.decision;
  if (status === 'clean') {
    lines.push(`✅ 本次改动（${code(range)}）没有碰到红线文件，也没有发现"降规则"的迹象。`);
    return lines.join('\n') + '\n';
  }
  if (status === 'confirmed') {
    lines.push(
      `✅ 已人工确认${ctx.confirmedBy ? `（标签由 @${ctx.confirmedBy} 添加）` : ''}。以下红线改动放行，记录保留在此供日后查。`,
    );
  } else if (status === 'confirmation-reset') {
    lines.push(`⚠️ 新推上来的提交又碰到了红线，之前的「${CONFIRM_LABEL}」已自动撤销 —— 需要重新确认。`);
  } else if (ctx.event === 'push') {
    lines.push(`⛔ 这次推送（${code(range)}）碰到了红线，而且没有经过已确认的 PR。`);
  } else {
    lines.push(`⛔ 这次改动碰到了红线，需要 Ludi 人工确认后才能变绿。`);
  }
  const files = findings.filter((f) => f.kind === 'redline-file');
  const weak = findings.filter((f) => f.kind === 'weakening');
  if (files.length > 0) {
    lines.push('', '### 碰到的红线文件', '', '| 文件 | 原因 | 命中规则 |', '| --- | --- | --- |');
    for (const f of files) lines.push(`| ${code(f.path)} | ${f.reason} | ${code(f.detail)} |`);
  }
  if (weak.length > 0) {
    lines.push('', '### 疑似"降规则"', '', '| 文件 | 原因 | 片段 |', '| --- | --- | --- |');
    for (const f of weak) lines.push(`| ${code(f.path)} | ${f.reason} | ${f.detail ? code(f.detail) : '—'} |`);
  }
  if (status !== 'confirmed' && ctx.event === 'push') {
    // 直接推送没有 PR 可加标签：说明怎么核实、怎么收尾
    lines.push(
      '',
      '### 怎么处理',
      '',
      '1. 点上面的「推送」链接，看这次改动是不是你本人授权的：有没有放松检查、跳过测试、改判定？',
      '2. 是你授权的 → 在这里留一句说明，然后关掉这个 issue。',
      '3. 不是 → 不要关。先把这次推送撤回（revert），再查是谁用了你的权限推送。',
    );
  } else if (status !== 'confirmed') {
    lines.push(
      '',
      '### 怎么处理',
      '',
      '1. 打开 **Files changed**，逐个看上面列出的文件：改动是不是你想要的？有没有放松检查、跳过测试、改判定？',
      `2. 没问题 → 在右侧 **Labels** 加上「${CONFIRM_LABEL}」，检查会自动重跑并变绿。`,
      '3. 有疑问 → 不要加标签，在 PR 里留言让 AI 解释或撤回。',
      '',
      `> 规则：AI 永远不能自己加「${CONFIRM_LABEL}」标签。确认之后若新提交又碰到红线，标签会被自动撤掉，需要重新确认。`,
    );
  }
  return lines.join('\n') + '\n';
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

export function collectChanges(repo: string, base: string, head: string): { changes: Change[]; diff: string } {
  const nameStatus = git(repo, ['diff', '--no-color', '--no-ext-diff', '--name-status', '-z', '-M', `${base}...${head}`]);
  const changes = parseNameStatusZ(nameStatus);
  const codePaths = changes.filter((c) => c.status !== 'D' && isCodeFile(c.path)).map((c) => c.path);
  let diff = '';
  if (codePaths.length > 0) {
    diff = git(repo, [
      '-c',
      'core.quotepath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '-U0',
      '-M',
      `${base}...${head}`,
      '--',
      ...codePaths,
    ]);
  }
  return { changes, diff };
}

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (!key.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) args.set(key.slice(2), 'true');
    else {
      args.set(key.slice(2), value);
      i++;
    }
  }
  return args;
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  const rulesPath = args.get('rules');
  const base = args.get('base');
  const head = args.get('head');
  if (!rulesPath || !base || !head) {
    console.error('用法: node scripts/redline-check.ts --rules <file> --base <sha> --head <sha> [...]');
    return 2;
  }
  const repo = args.get('repo') ?? '.';
  const event = args.get('event') === 'push' ? 'push' : 'pr';
  const rules = parseRules(readFileSync(rulesPath, 'utf8'));
  const scan = (from: string, to: string): Finding[] => {
    const { changes, diff } = collectChanges(repo, from, to);
    return [...matchRedlineFiles(changes, rules), ...scanWeakening(changes, diff)];
  };
  const { changes } = collectChanges(repo, base, head);
  const findings = scan(base, head);
  // 增量：上一次 PR 头 → 这一次 PR 头，只在 synchronize 时有意义
  const since = args.get('since');
  let incremental: number | undefined;
  if (since) {
    try {
      incremental = scan(since, head).length;
    } catch {
      incremental = undefined; // 取不到旧提交（如强推后）→ 按碰到红线处理
    }
  }
  const decision = decide(findings.length, args.get('has-label') === 'true', args.get('action') ?? '', incremental);
  const confirmedBy = args.get('confirmed-by');
  const report = renderReport(findings, { event, base, head, decision, ...(confirmedBy ? { confirmedBy } : {}) });
  const result = { ...decision, findingCount: findings.length, incrementalFindingCount: incremental ?? null, changedFiles: changes.length, findings };
  const outJson = args.get('out-json');
  const outMd = args.get('out-md');
  if (outJson) writeFileSync(outJson, JSON.stringify(result, null, 2) + '\n');
  if (outMd) writeFileSync(outMd, report);
  if (args.get('quiet') !== 'true') console.log(report);
  console.log(`changed=${changes.length} findings=${findings.length} status=${decision.status} pass=${decision.pass}`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
