import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultShellPath, runCommand } from '../../../src/core/index.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../../src/core/model/types.js';
import { GuiLiveError, GuiSessionHost, type GuiTaskDefinition } from '../../../src/surfaces/gui/live-session.js';
import { splitDiffByFile } from '../../../src/surfaces/gui/app/src/workbench/diff.js';

function model(): ModelProvider {
  const provider: ModelProvider = {
    capability: { maxContextTokens: 100_000, maxOutputTokens: 16_384, thinking: false, toolUse: true, imageIn: false, videoIn: false },
    async *call(): AsyncGenerator<ModelDelta, ModelResult> {
      yield { type: 'text', text: '确定回复' };
      return { text: '确定回复', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'completed', rawFinishReason: 'stop' };
    },
    withThinking: () => provider,
    withMaxCompletionTokens: () => provider,
  };
  return provider;
}

function freeContract(cwd: string): GuiTaskDefinition {
  return {
    objective: '批七阅读试件：只读浏览工作区', cwd,
    requirements: ['界面如实显示目录列表或失败原因'], writePaths: ['answer.mjs'],
    checkCommands: ['node --check answer.mjs'], maxRounds: 1, maxTurns: 6, wallClockMs: 30_000,
  };
}

/** Git-initialized temp workspace (createTask's workspace gate needs git), same shape as batch 4/5. */
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), 'jarvis-gui-b7-test-'));
  await writeFile(join(cwd, 'seed.txt'), 'fixture baseline\n', 'utf8');
  await writeFile(join(cwd, '.gitignore'), 'data/\n', 'utf8');
  for (const command of ['git init -q', 'git add -- seed.txt .gitignore', 'git -c user.name=Fixture -c user.email=fixture@example.test commit -qm fixture']) {
    const result = await runCommand(defaultShellPath(), command, cwd, 15_000, 4000);
    expect(result.code, result.output).toBe(0);
  }
  return { cwd };
}

async function createdTaskHost() {
  const { cwd } = await workspace();
  const host = new GuiSessionHost({ cwd, dataDir: join(cwd, 'data'), provider: model(), modelName: 'deterministic-test' });
  const created = await host.createTask(freeContract(cwd));
  return { cwd, host, id: created.id };
}

async function expectGuiError(promise: Promise<unknown>, status: number): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GuiLiveError);
    expect((error as GuiLiveError).status).toBe(status);
    return;
  }
  throw new Error(`expected GuiLiveError(${status})`);
}

describe('批7 只读目录端点（safeResolve 台账 + 排序 + 排除）', () => {
  it('lists the root dirs-first with file sizes; .git and sensitive entries are never listed', async () => {
    const { cwd, host, id } = await createdTaskHost();
    await mkdir(join(cwd, 'adir'));
    await writeFile(join(cwd, 'adir', 'inner.txt'), 'inner');
    await writeFile(join(cwd, 'bfile.txt'), 'hello');
    await writeFile(join(cwd, '.env'), 'ARK_API_KEY=secret\n');
    try {
      const tree = await host.listWorkspaceDir(id, '');
      const names = tree.entries.map((entry) => entry.name);
      expect(names).toContain('adir');
      expect(names).toContain('bfile.txt');
      expect(names).toContain('seed.txt');
      expect(names).not.toContain('.git');
      expect(names).not.toContain('.env');
      const kinds = tree.entries.map((entry) => entry.kind);
      const firstFile = kinds.indexOf('file');
      expect(kinds.slice(0, firstFile).every((kind) => kind === 'dir')).toBe(true);
      expect(kinds.slice(firstFile).every((kind) => kind !== 'dir')).toBe(true);
      expect(tree.entries.find((entry) => entry.name === 'bfile.txt')?.size).toBe(5);
      expect(tree.entries.every((entry) => entry.link === false)).toBe(true);
      expect(tree.truncated).toBe(false);
      const inner = await host.listWorkspaceDir(id, 'adir');
      expect(inner.entries).toEqual([{ name: 'inner.txt', kind: 'file', link: false, size: 5 }]);
      expect(inner.path).toBe('adir');
    } finally { await host.dispose(); }
  });

  it('403s an escaping path and 404s a file or a missing directory', async () => {
    const { cwd, host, id } = await createdTaskHost();
    await writeFile(join(cwd, 'plain.txt'), 'x');
    try {
      await expectGuiError(host.listWorkspaceDir(id, '../outside'), 403);
      await expectGuiError(host.listWorkspaceDir(id, 'plain.txt'), 404);
      await expectGuiError(host.listWorkspaceDir(id, 'missing'), 404);
    } finally { await host.dispose(); }
  });

  it('403s a symlinked directory that resolves outside the workspace', async () => {
    const { cwd, host, id } = await createdTaskHost();
    const outside = await mkdtemp(join(tmpdir(), 'jarvis-gui-b7-outside-'));
    let linked = true;
    try {
      await symlink(outside, join(cwd, 'escape-link'), 'junction');
    } catch {
      linked = false; // sandboxed environments without symlink permission: boundary check untestable here
    }
    try {
      if (linked) await expectGuiError(host.listWorkspaceDir(id, 'escape-link'), 403);
    } finally { await host.dispose(); }
  });

  it('caps one level at 500 entries and flags it truncated', async () => {
    const { cwd, host, id } = await createdTaskHost();
    const many = join(cwd, 'many');
    await mkdir(many);
    await Promise.all(Array.from({ length: 502 }, (_, index) => writeFile(join(many, `f${String(index).padStart(3, '0')}.txt`), '')));
    try {
      const tree = await host.listWorkspaceDir(id, 'many');
      expect(tree.truncated).toBe(true);
      expect(tree.entries).toHaveLength(500);
    } finally { await host.dispose(); }
  });
});

describe('批7 splitDiffByFile 纯函数（多文件分块）', () => {
  const TWO_FILE_DIFF = 'diff --git a/docs/guide.md b/docs/guide.md\nnew file mode 100644\nindex 0000000..1f2d3e4\n--- /dev/null\n+++ b/docs/guide.md\n@@ -0,0 +1 @@\n+# 引导\n'
    + 'diff --git a/src/a.ts b/src/a.ts\nindex 8c1e2f4..2b7a91c 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n const keep = 1;\n-const old = 2;\n+const fresh = 2;\n+const extra = 3;\n';

  it('groups two files with bare paths and per-file counts', () => {
    const { files, truncated } = splitDiffByFile(TWO_FILE_DIFF);
    expect(truncated).toBe(false);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: 'docs/guide.md', added: 1, removed: 0, binary: false });
    expect(files[1]).toMatchObject({ path: 'src/a.ts', added: 2, removed: 1, binary: false });
    expect(files[1].rows.some((row) => row.kind === 'added' && row.text === '+const fresh = 2;')).toBe(true);
    expect(files[1].rows.every((row) => !row.text.startsWith('diff --git'))).toBe(true);
  });

  it('uses the a-side path for a deleted file', () => {
    const { files } = splitDiffByFile('diff --git a/old.txt b/old.txt\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-旧时一行\n');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'old.txt', added: 0, removed: 1, binary: false });
  });

  it('marks binary blocks honestly with zero line counts', () => {
    const { files } = splitDiffByFile('diff --git a/shot.bin b/shot.bin\nindex 1111111..2222222 100644\nBinary files a/shot.bin and b/shot.bin differ\n');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'shot.bin', added: 0, removed: 0, binary: true });
  });

  it('empty input yields no blocks and no truncation', () => {
    expect(splitDiffByFile('')).toEqual({ files: [], truncated: false });
    expect(splitDiffByFile('Diff 读取失败：非 git 输出')).toEqual({ files: [], truncated: false });
  });

  it('caps the total classified rows at 400 across blocks', () => {
    const file = (name: string, count: number, start: number) => `diff --git a/${name} b/${name}\nindex 1111111..2222222 100644\n--- a/${name}\n+++ b/${name}\n@@ -1,${count} +1,${count} @@\n${Array.from({ length: count }, (_, index) => `-old-${String(start + index)}`).join('\n')}\n`;
    const { files, truncated } = splitDiffByFile(file('one.txt', 300, 0) + file('two.txt', 160, 300));
    expect(truncated).toBe(true);
    const total = files.reduce((sum, block) => sum + block.rows.length, 0);
    expect(total).toBeLessThanOrEqual(400);
    expect(files.length).toBeGreaterThan(0);
  });
});
