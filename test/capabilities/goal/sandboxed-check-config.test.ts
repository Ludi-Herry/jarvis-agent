import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSandboxedCheckPlan, parseSandboxedCheckPlan } from '../../../src/capabilities/goal/sandboxed-check-config.js';

describe('parseSandboxedCheckPlan', () => {
  it('parses trusted requirements and validates inspection commands', () => {
    const plan = parseSandboxedCheckPlan(
      JSON.stringify({
        requirements: [
          { id: 'r1', text: 'shows status', command: 'git status --short' },
          { id: 'r2', text: 'counts README lines', command: 'wc -l README.md' },
          { id: 'r3', text: 'human-only requirement' },
        ],
      }),
    );

    expect(plan.requirements).toEqual([
      { id: 'r1', text: 'shows status', command: 'git status --short' },
      { id: 'r2', text: 'counts README lines', command: 'wc -l README.md' },
      { id: 'r3', text: 'human-only requirement' },
    ]);
  });

  it('accepts a UTF-8 BOM prefix from Windows-authored JSON files', () => {
    const plan = parseSandboxedCheckPlan(
      `\uFEFF${JSON.stringify({
        requirements: [{ id: 'r1', text: 'shows status', command: 'git status --short' }],
      })}`,
    );

    expect(plan.requirements).toEqual([{ id: 'r1', text: 'shows status', command: 'git status --short' }]);
  });

  it('rejects unknown keys, duplicate ids, and commands outside the inspection scope', () => {
    expect(() => parseSandboxedCheckPlan(JSON.stringify({ requirements: [], extra: true }))).toThrow(/unknown/);
    expect(() =>
      parseSandboxedCheckPlan(
        JSON.stringify({
          requirements: [
            { id: 'r1', text: 'a', command: 'git status --short' },
            { id: 'r1', text: 'b', command: 'git diff --stat' },
          ],
        }),
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      parseSandboxedCheckPlan(
        JSON.stringify({
          requirements: [{ id: 'r1', text: 'unsafe', command: 'touch proof' }],
        }),
      ),
    ).toThrow(/outside sandbox inspection scope/);
  });
});

describe('loadSandboxedCheckPlan', () => {
  it('loads a trusted file outside cwd', async () => {
    const trustedPath = resolve('tmp', 'trusted', 'sandbox-plan.json');
    const cwd = resolve('tmp', 'jarvis-agent');
    const loaded = await loadSandboxedCheckPlan({
      path: trustedPath,
      cwd,
      readText: async () =>
        JSON.stringify({
          requirements: [{ id: 'r1', text: 'shows status', command: 'git status --short' }],
        }),
      realpath: async (path) => path,
    });

    expect(loaded.path).toBe(trustedPath);
    expect(loaded.pinned).toEqual([{ id: 'r1', text: 'shows status' }]);
    expect(loaded.commands).toEqual([{ requirementId: 'r1', command: 'git status --short' }]);
  });

  it('refuses repo-controlled sandbox check config', async () => {
    const cwd = resolve('tmp', 'jarvis-agent');
    await expect(
      loadSandboxedCheckPlan({
        path: join(cwd, 'sandbox-plan.json'),
        cwd,
        readText: async () => '{"requirements":[]}',
        realpath: async (path) => path,
      }),
    ).rejects.toThrow(/forbidden working tree/);
  });

  it('refuses repo-controlled config even when cwd is a subdirectory', async () => {
    const root = resolve('tmp', 'jarvis-agent');
    await expect(
      loadSandboxedCheckPlan({
        path: join(root, 'sandbox-plan.json'),
        cwd: join(root, 'src'),
        forbiddenRoots: [root],
        readText: async () => '{"requirements":[]}',
        realpath: async (path) => path,
      }),
    ).rejects.toThrow(/forbidden working tree/);
  });

  it('refuses outside-looking config after realpath resolves inside cwd', async () => {
    const cwd = resolve('tmp', 'jarvis-agent');
    const outsideLookingPath = resolve('tmp', 'trusted-looking', 'sandbox-plan.json');
    const resolvedInside = join(cwd, 'sandbox-plan.json');

    await expect(
      loadSandboxedCheckPlan({
        path: outsideLookingPath,
        cwd,
        readText: async () => '{"requirements":[]}',
        realpath: async (path) => (path === outsideLookingPath ? resolvedInside : path),
      }),
    ).rejects.toThrow(/forbidden working tree/);
  });
});
