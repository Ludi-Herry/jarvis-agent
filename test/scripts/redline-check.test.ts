import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMMENT_MARKER,
  CONFIRM_LABEL,
  collectChanges,
  decide,
  globToRegExp,
  main,
  matchRedlineFiles,
  parseNameStatusZ,
  parseRules,
  parseUnifiedDiff,
  renderReport,
  scanWeakening,
  type Change,
} from '../../scripts/redline-check.js';

// 这些片段故意拆开拼接，避免本测试文件自己被红线检查当成"降规则"
const SKIP = 'it.' + 'skip(';
const ONLY = 'describe.' + 'only(';
const SKIP_IF = 'it.' + 'skip' + 'If(';
const TS_IGNORE = '// @ts-' + 'ignore';
const ESLINT_OFF = '/* eslint-' + 'disable */';
const EXPECT = 'exp' + 'ect(';

const RULES_TEXT = [
  '# 注释行',
  '',
  '.github/** | 门禁与工作流',
  'AGENTS.md | AI 规则',
  'src/runtime/permission/** | 权限判定',
  'src/capabilities/goal/verdict.ts | 完成判定',
  '改删:docs/evidence/** | 证据只增不改',
  'docs/TODO-v01-evidence.md',
].join('\r\n');

describe('globToRegExp', () => {
  it('`**` 跨目录，`*` 不跨目录', () => {
    expect(globToRegExp('.github/**').test('.github/workflows/ci.yml')).toBe(true);
    expect(globToRegExp('.github/**').test('.githubx/a')).toBe(false);
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/x/a.ts')).toBe(false);
    expect(globToRegExp('**/secret.txt').test('secret.txt')).toBe(true);
    expect(globToRegExp('**/secret.txt').test('a/b/secret.txt')).toBe(true);
    expect(globToRegExp('a?c.md').test('abc.md')).toBe(true);
    expect(globToRegExp('a?c.md').test('a/c.md')).toBe(false);
  });

  it('精确文件名不会误配前缀或扩展', () => {
    const re = globToRegExp('AGENTS.md');
    expect(re.test('AGENTS.md')).toBe(true);
    expect(re.test('AGENTSxmd')).toBe(false);
    expect(re.test('docs/AGENTS.md')).toBe(false);
    expect(re.test('AGENTS.md.bak')).toBe(false);
  });
});

describe('parseRules', () => {
  it('解析规则、说明、注释、CRLF 和「改删:」前缀', () => {
    const rules = parseRules(RULES_TEXT);
    expect(rules.map((r) => r.pattern)).toEqual([
      '.github/**',
      'AGENTS.md',
      'src/runtime/permission/**',
      'src/capabilities/goal/verdict.ts',
      'docs/evidence/**',
      'docs/TODO-v01-evidence.md',
    ]);
    expect(rules[0]!.note).toBe('门禁与工作流');
    expect(rules[4]!.modifyOnly).toBe(true);
    expect(rules[0]!.modifyOnly).toBe(false);
    expect(rules[5]!.note).toBe('');
  });
});

describe('parseNameStatusZ', () => {
  it('解析增删改与改名', () => {
    const out = ['M', 'a.ts', 'A', 'b.ts', 'D', 'c.ts', 'R087', 'old.ts', 'new.ts', 'C100', 'x.ts', 'y.ts', ''].join('\0');
    expect(parseNameStatusZ(out)).toEqual<Change[]>([
      { status: 'M', path: 'a.ts' },
      { status: 'A', path: 'b.ts' },
      { status: 'D', path: 'c.ts' },
      { status: 'R', path: 'new.ts', oldPath: 'old.ts' },
      { status: 'C', path: 'y.ts', oldPath: 'x.ts' },
    ]);
  });
});

describe('matchRedlineFiles', () => {
  const rules = parseRules(RULES_TEXT);

  it('改、删红线文件都会被标出', () => {
    const findings = matchRedlineFiles(
      [
        { status: 'M', path: '.github/workflows/ci.yml' },
        { status: 'D', path: 'src/runtime/permission/decide.ts' },
        { status: 'M', path: 'src/core/agent.ts' },
      ],
      rules,
    );
    expect(findings.map((f) => f.path)).toEqual(['.github/workflows/ci.yml', 'src/runtime/permission/decide.ts']);
    expect(findings[0]!.reason).toContain('修改');
    expect(findings[1]!.reason).toContain('删除');
    expect(findings[1]!.detail).toBe('src/runtime/permission/**');
  });

  it('新增红线目录里的文件也算（普通规则）', () => {
    const findings = matchRedlineFiles([{ status: 'A', path: 'src/runtime/permission/new-rule.ts' }], rules);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.reason).toContain('新增');
  });

  it('「改删:」规则：新增证据不报，改/删/改名证据要报', () => {
    expect(matchRedlineFiles([{ status: 'A', path: 'docs/evidence/run-1.json' }], rules)).toEqual([]);
    expect(matchRedlineFiles([{ status: 'C', path: 'docs/evidence/copy.json', oldPath: 'x.json' }], rules)).toEqual(
      [],
    );
    const findings = matchRedlineFiles(
      [
        { status: 'M', path: 'docs/evidence/run-1.json' },
        { status: 'D', path: 'docs/evidence/run-2.json' },
        { status: 'R', path: 'docs/old/run-3.json', oldPath: 'docs/evidence/run-3.json' },
      ],
      rules,
    );
    expect(findings).toHaveLength(3);
    expect(findings[0]!.detail).toBe('改删:docs/evidence/**');
    expect(findings[2]!.path).toBe('docs/evidence/run-3.json → docs/old/run-3.json');
  });

  it('改名：把红线文件挪走要报；从外面改名进「改删:」目录不报', () => {
    const out = matchRedlineFiles([{ status: 'R', path: 'src/legacy/decide.ts', oldPath: 'src/runtime/permission/decide.ts' }], rules);
    expect(out).toHaveLength(1);
    expect(out[0]!.reason).toContain('改名');
    expect(matchRedlineFiles([{ status: 'R', path: 'docs/evidence/a.json', oldPath: 'tmp/a.json' }], rules)).toEqual([]);
  });

  it('一个文件命中多条规则只报一次', () => {
    const doubled = parseRules('.github/** | a\n.github/workflows/** | b');
    expect(matchRedlineFiles([{ status: 'M', path: '.github/workflows/ci.yml' }], doubled)).toHaveLength(1);
  });
});

function diffFor(path: string, added: string[], removed: string[] = []): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,0 +1,1 @@',
    ...removed.map((l) => '-' + l),
    ...added.map((l) => '+' + l),
  ].join('\n');
}

describe('parseUnifiedDiff', () => {
  it('内容行里以 "-- " / "++ " 开头时不会被当成文件头', () => {
    const diff = [
      'diff --git a/test/a.test.ts b/test/a.test.ts',
      '--- a/test/a.test.ts',
      '+++ b/test/a.test.ts',
      '@@ -3 +3 @@',
      '--- removed line starting with dashes',
      '+++ added line starting with pluses',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    expect([...files.keys()]).toEqual(['test/a.test.ts']);
    expect(files.get('test/a.test.ts')).toEqual({
      added: ['++ added line starting with pluses'],
      removed: ['-- removed line starting with dashes'],
    });
  });

  it('新文件（--- /dev/null）按新路径归档', () => {
    const diff = ['diff --git a/src/x.ts b/src/x.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/x.ts', '@@ -0,0 +1 @@', '+const a = 1;'].join('\n');
    expect(parseUnifiedDiff(diff).get('src/x.ts')).toEqual({ added: ['const a = 1;'], removed: [] });
  });
});

describe('scanWeakening', () => {
  it('新增跳过测试、条件跳过、关类型检查、关 lint 都会被标出', () => {
    const path = 'test/runtime/permission/decide.test.ts';
    const diff = diffFor(path, [`  ${SKIP}'x', () => {});`, `  ${SKIP_IF}(true)('y', () => {});`, TS_IGNORE, ESLINT_OFF]);
    const findings = scanWeakening([{ status: 'M', path }], diff);
    expect(findings.map((f) => f.reason)).toEqual([
      '新增了跳过/独跑测试（.skip/.only/.todo）',
      '新增了条件跳过测试（skipIf/runIf）',
      '新增了关闭类型检查的注释',
      '新增了关闭 lint 规则的注释',
    ]);
  });

  it('.only 在 src 里新增也算；新文件同样检查', () => {
    const path = 'src/runtime/x.ts';
    const findings = scanWeakening([{ status: 'A', path }], diffFor(path, [`${ONLY}'z', () => {})`]));
    expect(findings).toHaveLength(1);
  });

  it('只是删掉跳过（变严格）不报', () => {
    const path = 'test/a.test.ts';
    expect(scanWeakening([{ status: 'M', path }], diffFor(path, [], [`${SKIP}'x', () => {});`]))).toEqual([]);
  });

  it('删除测试文件要报；删除普通源码不算"降规则"', () => {
    const findings = scanWeakening(
      [
        { status: 'D', path: 'test/runtime/permission/command.test.ts' },
        { status: 'D', path: 'src/old.ts' },
      ],
      '',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.reason).toBe('删除了测试文件');
  });

  it('测试文件被改名到测试目录之外要报', () => {
    const findings = scanWeakening([{ status: 'R', path: 'docs/old-test.ts', oldPath: 'test/a.test.ts' }], '');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.reason).toContain('改名');
  });

  it('修改的测试文件里断言净减少要报，净增加或持平不报', () => {
    const path = 'test/a.test.ts';
    const fewer = scanWeakening(
      [{ status: 'M', path }],
      diffFor(path, [`${EXPECT}a).toBe(1);`], [`${EXPECT}a).toBe(1);`, `${EXPECT}b).toBe(2); ${EXPECT}c).toBe(3);`]),
    );
    expect(fewer).toHaveLength(1);
    expect(fewer[0]!.reason).toBe('测试断言净减少 2 处（expect 调用）');
    const same = scanWeakening([{ status: 'M', path }], diffFor(path, [`${EXPECT}a).toBe(2);`], [`${EXPECT}a).toBe(1);`]));
    expect(same).toEqual([]);
  });

  it('文档、脚本等非 src/test 代码不做"降规则"扫描', () => {
    expect(scanWeakening([{ status: 'M', path: 'docs/a.md' }], diffFor('docs/a.md', [SKIP]))).toEqual([]);
  });
});

describe('decide', () => {
  it('四种情况', () => {
    expect(decide(0, false, 'opened')).toEqual({ pass: true, removeLabel: false, status: 'clean' });
    expect(decide(0, true, 'synchronize')).toEqual({ pass: true, removeLabel: false, status: 'clean' });
    expect(decide(2, false, 'opened')).toEqual({ pass: false, removeLabel: false, status: 'needs-confirmation' });
    expect(decide(2, true, 'labeled')).toEqual({ pass: true, removeLabel: false, status: 'confirmed' });
    expect(decide(2, true, 'synchronize')).toEqual({ pass: false, removeLabel: true, status: 'confirmation-reset' });
  });

  it('确认后的新提交：没碰红线 → 确认保留；碰了 → 撤销；拿不到增量 → 按碰了处理', () => {
    expect(decide(2, true, 'synchronize', 0)).toEqual({ pass: true, removeLabel: false, status: 'confirmed' });
    expect(decide(2, true, 'synchronize', 1)).toEqual({ pass: false, removeLabel: true, status: 'confirmation-reset' });
    expect(decide(2, true, 'synchronize', undefined).status).toBe('confirmation-reset');
    expect(decide(2, false, 'synchronize', 0)).toEqual({ pass: false, removeLabel: false, status: 'needs-confirmation' });
  });
});

describe('renderReport', () => {
  const ctx = { event: 'pr' as const, base: 'a'.repeat(40), head: 'b'.repeat(40) };

  it('需要确认时给出中文操作说明和标签名', () => {
    const md = renderReport([{ kind: 'redline-file', path: 'AGENTS.md', reason: '修改了红线文件', detail: 'AGENTS.md' }], {
      ...ctx,
      decision: decide(1, false, 'opened'),
    });
    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
    expect(md).toContain('⛔');
    expect(md).toContain(`「${CONFIRM_LABEL}」`);
    expect(md).toContain('AI 永远不能自己加');
  });

  it('已确认时记录是谁加的标签，且不再给操作说明', () => {
    const md = renderReport([{ kind: 'weakening', path: 'test/a.test.ts', reason: 'x', detail: '' }], {
      ...ctx,
      decision: decide(1, true, 'labeled'),
      confirmedBy: 'Ludi-Herry',
    });
    expect(md).toContain('@Ludi-Herry');
    expect(md).not.toContain('怎么处理');
  });

  it('文件名里的反引号被转义，不会破坏表格', () => {
    const md = renderReport([{ kind: 'redline-file', path: 'a`b.md', reason: 'r', detail: 'd' }], {
      ...ctx,
      decision: decide(1, false, 'opened'),
    });
    expect(md).toContain("`a'b.md`");
  });

  it('没有发现时一句话说明', () => {
    const md = renderReport([], { ...ctx, decision: decide(0, false, 'opened') });
    expect(md).toContain('✅');
    expect(md).not.toContain('|');
  });
});

describe('真实 git 仓库端到端', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function sh(args: string[]): string {
    return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      encoding: 'utf8',
    });
  }
  function put(path: string, content: string): void {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }

  it('标出红线文件和降规则，忽略普通改动', () => {
    dir = mkdtempSync(join(tmpdir(), 'redline-'));
    sh(['init', '-q', '-b', 'main']);
    sh(['config', 'core.autocrlf', 'false']);
    put('.github/redlines.txt', RULES_TEXT);
    put('src/runtime/permission/decide.ts', 'export const a = 1;\n');
    put('test/a.test.ts', `${EXPECT}1).toBe(1);\n${EXPECT}2).toBe(2);\n`);
    put('test/gone.test.ts', `${EXPECT}1).toBe(1);\n`);
    put('docs/evidence/run-1.json', '{}\n');
    put('docs/中文 文档.md', '旧\n');
    sh(['add', '-A']);
    sh(['commit', '-q', '-m', 'base']);
    const base = sh(['rev-parse', 'HEAD']).trim();

    put('src/runtime/permission/decide.ts', 'export const a = 2;\n');
    put('test/a.test.ts', `${EXPECT}1).toBe(1);\n`);
    unlinkSync(join(dir, 'test/gone.test.ts'));
    put('docs/evidence/run-2.json', '{}\n');
    put('docs/中文 文档.md', '新\n');
    put('src/core/x.ts', `${TS_IGNORE}\nexport const x = 1;\n`);
    sh(['add', '-A']);
    sh(['commit', '-q', '-m', 'change']);
    const head = sh(['rev-parse', 'HEAD']).trim();

    const { changes } = collectChanges(dir, base, head);
    expect(changes.map((c) => `${c.status} ${c.path}`).sort()).toEqual(
      [
        'A docs/evidence/run-2.json',
        'A src/core/x.ts',
        'D test/gone.test.ts',
        'M docs/中文 文档.md',
        'M src/runtime/permission/decide.ts',
        'M test/a.test.ts',
      ].sort(),
    );

    const outJson = join(dir, 'result.json');
    const outMd = join(dir, 'report.md');
    const code = main([
      '--rules',
      join(dir, '.github/redlines.txt'),
      '--base',
      base,
      '--head',
      head,
      '--repo',
      dir,
      '--action',
      'opened',
      '--out-json',
      outJson,
      '--out-md',
      outMd,
      '--quiet',
    ]);
    expect(code).toBe(0);
    const result = JSON.parse(readFileSync(outJson, 'utf8')) as {
      pass: boolean;
      status: string;
      findingCount: number;
      findings: Array<{ kind: string; path: string; reason: string }>;
    };
    expect(result.pass).toBe(false);
    expect(result.status).toBe('needs-confirmation');
    expect(result.findings.map((f) => `${f.kind}:${f.path}`).sort()).toEqual(
      [
        'redline-file:src/runtime/permission/decide.ts',
        'weakening:src/core/x.ts',
        'weakening:test/a.test.ts',
        'weakening:test/gone.test.ts',
      ].sort(),
    );
    expect(readFileSync(outMd, 'utf8')).toContain(COMMENT_MARKER);

    // 已确认后再推一个只改普通文件的提交：确认保留
    put('README.md', 'hello\n');
    sh(['add', '-A']);
    sh(['commit', '-q', '-m', 'docs']);
    const head2 = sh(['rev-parse', 'HEAD']).trim();
    const common = ['--rules', join(dir, '.github/redlines.txt'), '--base', base, '--repo', dir, '--action', 'synchronize'];
    const run = (h: string, since: string) => {
      expect(main([...common, '--head', h, '--since', since, '--has-label', 'true', '--out-json', outJson, '--quiet'])).toBe(0);
      return JSON.parse(readFileSync(outJson, 'utf8')) as { status: string; removeLabel: boolean; incrementalFindingCount: number | null };
    };
    expect(run(head2, head)).toMatchObject({ status: 'confirmed', removeLabel: false, incrementalFindingCount: 0 });

    // 再推一个碰权限文件的提交：确认撤销
    put('src/runtime/permission/decide.ts', 'export const a = 3;\n');
    sh(['add', '-A']);
    sh(['commit', '-q', '-m', 'perm']);
    const head3 = sh(['rev-parse', 'HEAD']).trim();
    expect(run(head3, head2)).toMatchObject({ status: 'confirmation-reset', removeLabel: true, incrementalFindingCount: 1 });

    // 旧提交不存在（比如强推后取不到）：按碰到红线处理
    expect(run(head3, 'f'.repeat(40))).toMatchObject({ status: 'confirmation-reset', incrementalFindingCount: null });
  }, 30_000);

  it('参数不全时返回 2', () => {
    expect(main(['--rules', 'x'])).toBe(2);
  });
});
