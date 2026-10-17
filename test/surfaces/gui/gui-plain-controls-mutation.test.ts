/**
 * 变异测试补强（2026-10）：Stryker 把 plain-controls.ts 改坏 182 处，原测试漏掉的里面有几类会伤人：
 *
 * - 树 ID 校验去掉 ^ 或 $ → 拼进 git 命令的字符串可以夹带别的命令；
 * - git 失败或输出被截断却当成功 → 撤销时把合同里的文件当成"本任务新建"删掉；
 * - Windows 风格路径没归一 → 要恢复的文件被当成不存在，没恢复反而去删；
 * - 删除被标成"修改"、没变的文件也出现在撤销清单里 → 用户确认时看到的不是真实要发生的事。
 *
 * 这里用假的 git 执行器，精确断言"发出了哪些 git 命令、删了哪些文件"。真实 Git 的端到端用例在
 * gui-plain-controls.test.ts。
 */
import { describe, expect, it } from 'vitest';
import {
  AUTO_MODE_REASON, captureWritePathsTree, DEFAULT_GUI_PERMISSION_MODE, diffWritePaths, DISCUSS_MODE_REASON,
  normalizeWritePath, restoreWritePaths, type UndoGitDeps,
} from '../../../src/surfaces/gui/plain-controls.js';

const T1 = 'a'.repeat(40);
const T2 = 'b'.repeat(40);
const q = (value: string): string => `'${value}'`;

type Reply = { code: number | null; output: string; truncated?: boolean };

/** A fake git runner: replies by command prefix, records every command it was asked to run. */
function fakeGit(paths: string[], replies: Array<[prefix: string, reply: Reply]> = []): UndoGitDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    quote: q,
    paths,
    run: async (command) => {
      calls.push(command);
      const hit = replies.find(([prefix]) => command.startsWith(prefix));
      return hit ? hit[1] : { code: 0, output: '' };
    },
  };
}

describe('plain-controls — 默认档位与说明文字', () => {
  it('旧任务没有模式字段时按「改之前问我」处理', () => {
    expect(DEFAULT_GUI_PERMISSION_MODE).toBe('ask');
  });

  it('拒绝 / 放行理由写清楚是哪个档位', () => {
    expect(DISCUSS_MODE_REASON).toContain('只讨论');
    expect(AUTO_MODE_REASON).toContain('自动');
  });
});

describe('plain-controls — 路径归一', () => {
  it('反斜杠变斜杠，只去掉开头的 ./', () => {
    expect(normalizeWritePath('src\\ui\\panel.tsx')).toBe('src/ui/panel.tsx');
    expect(normalizeWritePath('./a.ts')).toBe('a.ts');
    expect(normalizeWritePath('a/./b.ts')).toBe('a/./b.ts');
  });
});

describe('plain-controls — 树 ID 必须整串是十六进制，不能夹带命令', () => {
  it.each([
    `${T1}; rm -rf ~`,
    `$(rm -rf ~)${T1}`,
    `${T1}\n`,
  ])('%j → 拒绝，且一条 git 都不跑', async (tree) => {
    const git = fakeGit(['a.ts']);
    await expect(restoreWritePaths({ ...git, tree, remove: async () => undefined })).rejects.toThrow('不是有效的 Git 树');
    await expect(captureWritePathsTree({ ...git, baseTree: tree, exists: () => true })).rejects.toThrow('不是有效的 Git 树');
    await expect(diffWritePaths(git, tree, T2)).rejects.toThrow('不是有效的 Git 树');
    expect(git.calls).toEqual([]);
  });
});

describe('plain-controls — git 失败或输出被截断：停下，不删文件', () => {
  it.each<[string, string, Reply]>([
    ['读取目标版本失败', 'git -c core.fsmonitor=false read-tree', { code: 128, output: 'fatal: bad tree' }],
    ['列文件失败', 'git -c core.quotePath=false ls-files', { code: 1, output: 'error' }],
    ['列文件输出被截断', 'git -c core.quotePath=false ls-files', { code: 0, output: '', truncated: true }],
    ['进程没有正常退出', 'git -c core.quotePath=false ls-files', { code: null, output: '' }],
  ])('%s', async (_name, prefix, reply) => {
    const git = fakeGit(['a.ts', 'b.ts'], [[prefix, reply]]);
    const removed: string[] = [];
    await expect(restoreWritePaths({ ...git, tree: T1, remove: async (p) => { removed.push(p); } })).rejects.toThrow();
    expect(removed).toEqual([]);
    expect(git.calls.some((c) => c.includes('checkout-index'))).toBe(false);
  });

  it('记录现状时 write-tree 输出不是树 ID → 拒绝', async () => {
    const git = fakeGit(['a.ts'], [['git -c core.fsmonitor=false write-tree', { code: 0, output: 'warning: something\n' }]]);
    await expect(captureWritePathsTree({ ...git, baseTree: T1, exists: () => true })).rejects.toThrow('不是有效的 Git 树');
  });
});

describe('plain-controls — 撤销 / 恢复发出的 git 命令', () => {
  it('Windows 路径照样认出"版本里有这个文件"：写回它，只删真正不存在的', async () => {
    const git = fakeGit(['src\\a.ts', './b.ts', 'gone.ts'], [
      ['git -c core.quotePath=false ls-files', { code: 0, output: 'src/a.ts\r\nb.ts\r\n' }],
    ]);
    const removed: string[] = [];
    await restoreWritePaths({ ...git, tree: T1, remove: async (p) => { removed.push(p); } });
    expect(git.calls).toEqual([
      `git -c core.fsmonitor=false read-tree ${T1}`,
      "git -c core.quotePath=false ls-files -- 'src/a.ts' 'b.ts' 'gone.ts'",
      "git -c core.fsmonitor=false checkout-index -f -- 'src/a.ts' 'b.ts'",
    ]);
    expect(removed).toEqual(['gone.ts']);
  });

  it('版本里一个都没有 → 不跑 checkout-index，全部删除', async () => {
    const git = fakeGit(['new1.ts', 'new2.ts']);
    const removed: string[] = [];
    await restoreWritePaths({ ...git, tree: T1, remove: async (p) => { removed.push(p); } });
    expect(git.calls.some((c) => c.includes('checkout-index'))).toBe(false);
    expect(removed).toEqual(['new1.ts', 'new2.ts']);
  });

  it('合同没有写入路径 → 什么都不做', async () => {
    const git = fakeGit([]);
    await restoreWritePaths({ ...git, tree: T1, remove: async () => { throw new Error('不该删'); } });
    expect(git.calls).toEqual([]);
  });

  it('记录现状：在的文件 add，不在的文件从索引里去掉', async () => {
    const git = fakeGit(['src\\a.ts', 'gone.ts'], [['git -c core.fsmonitor=false write-tree', { code: 0, output: `${T2}\n` }]]);
    const tree = await captureWritePathsTree({ ...git, baseTree: T1, exists: (p) => p === 'src/a.ts' });
    expect(tree).toBe(T2);
    expect(git.calls).toEqual([
      `git -c core.fsmonitor=false read-tree ${T1}`,
      "git -c core.fsmonitor=false add -- 'src/a.ts'",
      "git -c core.fsmonitor=false rm -q --cached --ignore-unmatch -- 'gone.ts'",
      'git -c core.fsmonitor=false write-tree',
    ]);
  });
});

describe('plain-controls — 撤销清单如实列出增删改', () => {
  it('按合同顺序列出；删除标"deleted"；没变的文件不出现', async () => {
    const git = fakeGit(['c.ts', 'src\\a.ts', 'b.ts', 'untouched.ts'], [
      ['git -c core.quotePath=false diff', { code: 0, output: 'M\tsrc/a.ts\nD\tb.ts\nA\tc.ts\n' }],
    ]);
    expect(await diffWritePaths(git, T1, T2)).toEqual([
      { path: 'c.ts', change: 'added' },
      { path: 'src/a.ts', change: 'modified' },
      { path: 'b.ts', change: 'deleted' },
    ]);
    expect(git.calls).toEqual([
      `git -c core.quotePath=false diff --relative --no-renames --name-status ${T1} ${T2} -- 'c.ts' 'src/a.ts' 'b.ts' 'untouched.ts'`,
    ]);
  });

  it('两棵树相同或合同没有写入路径 → 空清单，不跑 git', async () => {
    const same = fakeGit(['a.ts']);
    expect(await diffWritePaths(same, T1, T1)).toEqual([]);
    expect(same.calls).toEqual([]);
    const none = fakeGit([]);
    expect(await diffWritePaths(none, T1, T2)).toEqual([]);
    expect(none.calls).toEqual([]);
  });

  it('比较失败 → 报错，不返回半截清单', async () => {
    const git = fakeGit(['a.ts'], [['git -c core.quotePath=false diff', { code: 0, output: 'M\ta.ts\n', truncated: true }]]);
    await expect(diffWritePaths(git, T1, T2)).rejects.toThrow('无法比较改动');
  });
});
