import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultShellPath, runCommand } from '../../../src/core/index.js';
import {
  AUTO_MODE_REASON, captureWritePathsTree, decideModeGate, diffWritePaths, DISCUSS_MODE_REASON,
  parsePermissionMode, restoreWritePaths, undoBlocker, type UndoGitDeps,
} from '../../../src/surfaces/gui/plain-controls.js';
import { resolvePreviewSource, shouldAutoOpenPreview } from '../../../src/surfaces/gui/preview-policy.js';

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

describe('plain-v1 permission modes (pure)', () => {
  it('parses only the three composer modes', () => {
    expect(parsePermissionMode('discuss')).toBe('discuss');
    expect(parsePermissionMode('ask')).toBe('ask');
    expect(parsePermissionMode('auto')).toBe('auto');
    expect(parsePermissionMode('yolo')).toBeUndefined();
    expect(parsePermissionMode(undefined)).toBeUndefined();
  });

  it('discuss refuses every non-read effect but keeps reads and goal bookkeeping', () => {
    for (const capability of ['writes-files', 'executes-code', 'network'] as const) {
      expect(decideModeGate({ mode: 'discuss', toolName: 'x', capability, hardAction: 'ask' })).toEqual({ kind: 'deny', reason: DISCUSS_MODE_REASON });
    }
    expect(decideModeGate({ mode: 'discuss', toolName: 'read', capability: 'read-only', hardAction: 'allow' })).toEqual({ kind: 'defer' });
    expect(decideModeGate({ mode: 'discuss', toolName: 'update_goal', capability: 'writes-files', hardAction: 'ask' })).toEqual({ kind: 'defer' });
  });

  it('auto skips the ask only for a file write; commands and network still go to the gate', () => {
    expect(decideModeGate({ mode: 'auto', toolName: 'write', capability: 'writes-files', hardAction: 'ask' })).toEqual({ kind: 'allow', reason: AUTO_MODE_REASON });
    expect(decideModeGate({ mode: 'auto', toolName: 'bash', capability: 'executes-code', hardAction: 'ask' })).toEqual({ kind: 'defer' });
    expect(decideModeGate({ mode: 'auto', toolName: 'fetch', capability: 'network', hardAction: 'ask' })).toEqual({ kind: 'defer' });
  });

  it('never reinterprets a hard deny, and ask / absent keep today\'s behavior', () => {
    for (const mode of ['discuss', 'ask', 'auto', undefined] as const) {
      expect(decideModeGate({ mode, toolName: 'write', capability: 'writes-files', hardAction: 'deny' })).toEqual({ kind: 'defer' });
    }
    expect(decideModeGate({ mode: 'ask', toolName: 'write', capability: 'writes-files', hardAction: 'ask' })).toEqual({ kind: 'defer' });
    expect(decideModeGate({ mode: undefined, toolName: 'bash', capability: 'executes-code', hardAction: 'ask' })).toEqual({ kind: 'defer' });
  });
});

describe('plain-v1 undo blockers (pure)', () => {
  const idle = { started: true, running: false, resumable: false, reviewing: false, terminalRunning: false, workspaceBusy: false };
  it('allows undo only for a started, settled task in a quiet workspace', () => {
    expect(undoBlocker(idle)).toBeUndefined();
    expect(undoBlocker({ ...idle, started: false })).toContain('还没开始');
    expect(undoBlocker({ ...idle, running: true })).toContain('进行中');
    expect(undoBlocker({ ...idle, resumable: true })).toContain('接着跑');
    expect(undoBlocker({ ...idle, reviewing: true })).toContain('验收');
    expect(undoBlocker({ ...idle, terminalRunning: true })).toContain('终端');
    expect(undoBlocker({ ...idle, workspaceBusy: true })).toContain('同一个项目');
  });
});

describe('plain-v1 auto preview (pure)', () => {
  it('opens only a loopback page, once, after a settled task changed a UI file', () => {
    const base = { previewUrl: 'http://localhost:5173/settings', changedPaths: ['src/settings/SettingsPanel.tsx'], settled: true, alreadyHandled: false };
    expect(shouldAutoOpenPreview(base)).toBe(true);
    expect(shouldAutoOpenPreview({ ...base, settled: false })).toBe(false);
    expect(shouldAutoOpenPreview({ ...base, alreadyHandled: true })).toBe(false);
    expect(shouldAutoOpenPreview({ ...base, previewUrl: undefined })).toBe(false);
    expect(shouldAutoOpenPreview({ ...base, previewUrl: 'https://example.com' })).toBe(false);
    expect(shouldAutoOpenPreview({ ...base, changedPaths: ['src/core/loop.ts', 'README.md'] })).toBe(false);
    expect(shouldAutoOpenPreview({ ...base, changedPaths: ['src/styles/button.css'] })).toBe(true);
    expect(resolvePreviewSource('http://127.0.0.1:4173/').kind).toBe('loopback');
  });
});

describe('plain-v1 task-scoped undo (real Git, throwaway index)', () => {
  it('restores write paths to the baseline tree, removes created files, and redoes symmetrically', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis-gui-undo-'));
    const sh = (command: string, index?: string) => runCommand(defaultShellPath(), command, cwd, 15_000, 200_000, undefined,
      { scrubGitEnv: true, ...(index ? { extraEnv: { GIT_INDEX_FILE: index.replaceAll('\\', '/') } } : {}) });
    await mkdir(join(cwd, 'src', 'ui'), { recursive: true });
    await writeFile(join(cwd, 'src', 'ui', 'my panel.tsx'), 'export const v = 1;\n', 'utf8');
    await writeFile(join(cwd, 'keep.txt'), 'outside the contract\n', 'utf8');
    for (const command of ['git init -q', 'git add -A', 'git -c user.name=Fixture -c user.email=fixture@example.test commit -qm fixture']) {
      const result = await sh(command);
      expect(result.code, result.output).toBe(0);
    }
    const userIndexBefore = await readFile(join(cwd, '.git', 'index'));
    // Same shape as GuiSessionHost.captureBaseline: a private index of HEAD, frozen as a tree.
    const baselineIndex = join(cwd, '..', `${cwd.split(/[\\/]/u).at(-1)}-baseline.index`);
    expect((await sh('git read-tree HEAD', baselineIndex)).code).toBe(0);
    const baseline = (await sh('git write-tree', baselineIndex)).output.trim();

    const paths = ['src/ui/my panel.tsx', 'src/ui/button.css'];
    const undoIndex = join(cwd, '..', `${cwd.split(/[\\/]/u).at(-1)}-undo.index`);
    const git: UndoGitDeps = { run: (command) => sh(command, undoIndex), quote: shellQuote, paths };
    const exists = (path: string) => existsSync(resolve(cwd, path));
    const removed: string[] = [];
    const remove = async (path: string) => { removed.push(path); await rm(resolve(cwd, path), { force: true }); };

    expect(await captureWritePathsTree({ ...git, baseTree: baseline, exists })).toBe(baseline);

    // The "task" edits one tracked file and creates a new one; a file outside the contract also changes.
    await writeFile(join(cwd, 'src', 'ui', 'my panel.tsx'), 'export const v = 2;\n', 'utf8');
    await writeFile(join(cwd, 'src', 'ui', 'button.css'), '.primary { border-radius: 10px; }\n', 'utf8');
    await writeFile(join(cwd, 'keep.txt'), 'user edit outside the contract\n', 'utf8');
    const after = await captureWritePathsTree({ ...git, baseTree: baseline, exists });
    expect(after).not.toBe(baseline);
    expect(await diffWritePaths(git, baseline, after)).toEqual([
      { path: 'src/ui/my panel.tsx', change: 'modified' },
      { path: 'src/ui/button.css', change: 'added' },
    ]);

    await restoreWritePaths({ ...git, tree: baseline, remove });
    expect(await readFile(join(cwd, 'src', 'ui', 'my panel.tsx'), 'utf8')).toBe('export const v = 1;\n');
    expect(existsSync(join(cwd, 'src', 'ui', 'button.css'))).toBe(false);
    expect(removed).toEqual(['src/ui/button.css']);
    expect(await readFile(join(cwd, 'keep.txt'), 'utf8')).toBe('user edit outside the contract\n');
    expect(await captureWritePathsTree({ ...git, baseTree: baseline, exists })).toBe(baseline);

    await restoreWritePaths({ ...git, tree: after, remove });
    expect(await readFile(join(cwd, 'src', 'ui', 'my panel.tsx'), 'utf8')).toBe('export const v = 2;\n');
    expect(await readFile(join(cwd, 'src', 'ui', 'button.css'), 'utf8')).toBe('.primary { border-radius: 10px; }\n');
    expect(await captureWritePathsTree({ ...git, baseTree: baseline, exists })).toBe(after);

    expect(await readFile(join(cwd, '.git', 'index'))).toEqual(userIndexBefore);
  }, 30_000);

  it('refuses a malformed tree id before running Git', async () => {
    const calls: string[] = [];
    const git: UndoGitDeps = { run: async (command) => { calls.push(command); return { code: 0, output: '' }; }, quote: shellQuote, paths: ['a.ts'] };
    await expect(restoreWritePaths({ ...git, tree: 'HEAD; rm -rf /', remove: async () => undefined })).rejects.toThrow('不是有效的 Git 树');
    await expect(diffWritePaths(git, 'abc', 'def')).rejects.toThrow('不是有效的 Git 树');
    expect(calls).toEqual([]);
  });
});
