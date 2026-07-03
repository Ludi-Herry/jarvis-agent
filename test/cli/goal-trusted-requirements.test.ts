import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadGoalCliTrustedRequirements } from '../../src/surfaces/cli/goal-trusted-requirements.js';

describe('goal CLI trusted requirements loading', () => {
  it('loads goal-setter-authored requirements from a trusted path outside the working tree', async () => {
    const cwd = join(tmpdir(), 'jarvis-goal-cli-repo');
    const trustedPath = join(tmpdir(), 'goal-setter-requirements.json');

    const source = await loadGoalCliTrustedRequirements({
      goalSetterRequirementsPath: trustedPath,
      cwd,
      forbiddenRoots: [cwd],
      readText: readMap({
        [trustedPath]: JSON.stringify({
          version: 1,
          requirements: [
            { id: 'r1', text: 'status is inspectable', route: 'sandbox-command', command: 'git status --short' },
            { id: 'r2', text: 'docs are updated', route: 'llm' },
            { id: 'r3', text: 'copy reads naturally', route: 'human' },
          ],
        }),
      }),
      realpath: realpathIdentity,
    });

    expect(source.kind).toBe('goal-setter-requirements');
    if (source.kind !== 'goal-setter-requirements') throw new Error('unexpected source');
    expect(source.plan.pinned).toEqual([
      { id: 'r1', text: 'status is inspectable', route: 'sandbox-command' },
      { id: 'r2', text: 'docs are updated', route: 'llm' },
      { id: 'r3', text: 'copy reads naturally', route: 'human' },
    ]);
    expect(source.plan.routes.get('r1')).toBe('sandbox-command');
    expect(source.plan.routes.get('r2')).toBe('llm');
    expect(source.plan.routes.get('r3')).toBe('human');
    expect(source.plan.commands).toEqual([{ requirementId: 'r1', command: 'git status --short' }]);
  });

  it('refuses goal-setter-authored requirements inside the working tree', async () => {
    const cwd = join(tmpdir(), 'jarvis-goal-cli-repo');
    const repoPath = join(cwd, 'goal-setter-requirements.json');

    await expect(
      loadGoalCliTrustedRequirements({
        goalSetterRequirementsPath: repoPath,
        cwd,
        forbiddenRoots: [cwd],
        readText: readMap({ [repoPath]: JSON.stringify({ version: 1, requirements: [] }) }),
        realpath: realpathIdentity,
      }),
    ).rejects.toThrow(/refusing repo-controlled goal-setter requirements/);
  });

  it('refuses ambiguous sandbox-only and goal-setter requirement sources', async () => {
    await expect(
      loadGoalCliTrustedRequirements({
        sandboxCheckPlanPath: join(tmpdir(), 'sandbox-checks.json'),
        goalSetterRequirementsPath: join(tmpdir(), 'goal-setter-requirements.json'),
        cwd: join(tmpdir(), 'jarvis-goal-cli-repo'),
        forbiddenRoots: [],
        readText: readMap({}),
        realpath: realpathIdentity,
      }),
    ).rejects.toThrow(/choose one trusted requirements source/);
  });
});

function readMap(files: Record<string, string>): (path: string) => Promise<string | null> {
  return async (path) => files[path] ?? null;
}

async function realpathIdentity(path: string): Promise<string> {
  return path;
}
