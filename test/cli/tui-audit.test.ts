import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileTuiActionAuditStore,
  loadTuiActionAudit,
} from '../../src/surfaces/cli/tui-audit.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('TUI action audit', () => {
  it('appends contiguous bounded metadata without prompt bodies or terminal controls', async () => {
    const cwd = await workspace('tui audit ');
    const store = new FileTuiActionAuditStore({
      cwd,
      sessionId: 'session-a',
      now: () => '2026-08-15T00:00:00.000Z',
    });

    await store.append({ kind: 'submit', mode: 'queue', textLength: 12, queueDepth: 1 });
    await store.append({
      kind: 'interrupt',
      source: 'ctrl-c',
      runId: `run\u001b[2J\r\nforged\u202eevil\u2066${'x'.repeat(1_000)}`,
    });

    const loaded = await loadTuiActionAudit({ cwd, sessionId: 'session-a' });
    expect(loaded.records.map((record) => record.seq)).toEqual([1, 2]);
    expect(loaded.records[1]).toMatchObject({ detail: { kind: 'interrupt', source: 'ctrl-c' } });
    const raw = await readFile(loaded.path, 'utf8');
    expect(raw).not.toContain('\u001b');
    expect(raw).not.toContain('\r\nforged');
    expect(raw).not.toContain('\u202e');
    expect(raw).not.toContain('\u2066');
    expect(raw).not.toContain('prompt');
    expect(raw.length).toBeLessThan(2_000);
  });

  it('refuses append when existing audit state is malformed', async () => {
    const cwd = await workspace('tui corrupt ');
    await mkdir(join(cwd, 'data', 'tui'), { recursive: true });
    await writeFile(join(cwd, 'data', 'tui', 'session-a.jsonl'), '{"bad":true}\n', 'utf8');
    const store = new FileTuiActionAuditStore({ cwd, sessionId: 'session-a' });

    await expect(store.append({ kind: 'eof' })).rejects.toThrow(/corrupt|invalid/u);
  });

  it('refuses a reparse escape without writing the external target', async () => {
    const cwd = await workspace('tui escape ');
    const outside = join(cwd, 'outside');
    await mkdir(join(cwd, 'data'), { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(cwd, 'data', 'tui'), process.platform === 'win32' ? 'junction' : 'dir');
    const store = new FileTuiActionAuditStore({ cwd, sessionId: 'session-a' });

    await expect(store.append({ kind: 'eof' })).rejects.toThrow(/symbolic link|reparse/u);
    await expect(readFile(join(outside, 'session-a.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an existing hard-linked action audit before append', async () => {
    const cwd = await workspace('tui hardlink ');
    const auditDir = join(cwd, 'data', 'tui');
    const outside = join(cwd, 'outside.txt');
    await mkdir(auditDir, { recursive: true });
    await writeFile(outside, 'sentinel', 'utf8');
    await link(outside, join(auditDir, 'session-a.jsonl'));
    const store = new FileTuiActionAuditStore({ cwd, sessionId: 'session-a' });

    await expect(store.append({ kind: 'eof' })).rejects.toThrow(/hard link/u);
    expect(await readFile(outside, 'utf8')).toBe('sentinel');
  });
});

async function workspace(label: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), `jarvis ${label}`));
  tempDirs.push(cwd);
  return cwd;
}
