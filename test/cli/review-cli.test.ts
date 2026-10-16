import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { spawnBudget } from './spawn-budget.js';
import {
  composeVerifierReport,
  decideVerdict,
  parseLoopLog,
  serializeGoalRecord,
  serializeLoopRecord,
  type DeterministicChecks,
  type PinnedRequirement,
} from '../../src/capabilities/goal/index.js';
import { CLI_EXIT } from '../../src/surfaces/cli/exit-codes.js';

const repo = process.cwd();
const entry = join(repo, 'src', 'surfaces', 'cli', 'jarvis.ts');
const tempDirs: string[] = [];

// This file intentionally launches several real CLI subprocesses per test. Full-suite worker
// contention can exceed Vitest's 5 s unit-test default even though each child has its own 20 s cap.
vi.setConfig({ testTimeout: spawnBudget(15_000) });
afterAll(() => vi.resetConfig());
const ESC = String.fromCharCode(27);
const KEY_SENTINEL = 'ark-sentinel-key-value-never-print';

const cleanChecks: DeterministicChecks = {
  objectiveChecksPassed: true,
  results: [{ command: 'npm test', code: 0, output: 'green' }],
  testTamper: 'clean',
  tamperReason: '',
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('jarvis review (terminal human review)', () => {
  it('discovers review commands from root and group help without a provider key', async () => {
    const [rootHelp, groupHelp, approveHelp] = await Promise.all([
      runJarvis(['--help']),
      runJarvis(['review', '--help']),
      runJarvis(['review', 'approve', '--help']),
    ]);

    expect(rootHelp.code).toBe(0);
    expect(rootHelp.stdout).toContain('review');
    expect(groupHelp).toMatchObject({ code: 0 });
    for (const command of ['list', 'show [options] <goal-id>', 'approve', 'reject']) {
      expect(groupHelp.stdout).toContain(command);
    }
    expect(approveHelp).toMatchObject({ code: 0 });
    expect(approveHelp.stdout).toContain('--requirement');
    expect(approveHelp.stdout).toContain('--note');
    for (const result of [rootHelp, groupHelp, approveHelp]) {
      expect(result.stderr).not.toContain(KEY_SENTINEL);
      expect(result.stderr).not.toContain('ARK_API_KEY');
    }
  }, spawnBudget(20_000));

  it('lists an empty workspace with exit 0 and the versioned contract', async () => {
    const workspace = await tempWorkspace('empty ');

    const text = await runJarvis(['--cwd', workspace, 'review', 'list']);
    const json = await runJarvis(['--cwd', workspace, 'review', 'list', '--json']);

    expect(text).toMatchObject({ code: 0 });
    expect(text.stdout).toContain('Pending human reviews: 0');
    expect(text.stdout).toContain('no pending human reviews');
    expect(json.code).toBe(0);
    const report = JSON.parse(json.stdout) as { schemaVersion: number; authority: { mode: string }; reviews: unknown[] };
    expect(report.schemaVersion).toBe(1);
    expect(report.authority.mode).toBe('observation-only');
    expect(report.reviews).toEqual([]);
  });

  it('lists and shows a parked goal with sanitized requirement text', async () => {
    const workspace = await tempWorkspace('show ');
    await writeParkedGoal(workspace, 'g-park', [
      { id: 'r1', text: `Ludi confirms the copy‮ reads naturally\nsecond line ${ESC}[31m` },
    ]);

    const list = await runJarvis(['--cwd', workspace, 'review', 'list']);
    expect(list).toMatchObject({ code: 0 });
    expect(list.stdout).toContain('g-park');
    expect(list.stdout).toContain('pending requirements: 1 (r1)');

    const show = await runJarvis(['--cwd', workspace, 'review', 'show', 'g-park']);
    expect(show).toMatchObject({ code: 0 });
    expect(show.stdout).toContain('Human review g-park (read-only)');
    expect(show.stdout).toContain('state: blocked  verdict: couldNotVerify');
    expect(show.stdout).toContain('- r1:');
    expect(show.stdout).toContain('reason:');
    expect(show.stdout).toContain('checks: objectiveChecksPassed=true  testTamper=clean');
    expect(show.stdout).not.toContain(ESC);
    expect(show.stdout).not.toContain('‮');
    // The embedded newline must be collapsed, never emitted as a real line break.
    expect(show.stdout).not.toContain('\nsecond line');

    const missing = await runJarvis(['--cwd', workspace, 'review', 'show', 'g-missing']);
    expect(missing.code).toBe(CLI_EXIT.USAGE);
    expect(missing.stderr).toContain('no pending human review');
  });

  it('records an approval end to end: goal completes via decideVerdict, audit lands, list empties', async () => {
    const workspace = await tempWorkspace('approve ');
    await writeParkedGoal(workspace, 'g-ok', [{ id: 'r1', text: 'Ludi confirms the copy reads naturally' }]);

    const approve = await runJarvis([
      '--cwd', workspace, 'review', 'approve', 'g-ok',
      '--requirement', 'r1', '--note', 'Copy is clear and ready.', '--reviewer', 'Ludi', '--json',
    ]);

    expect(approve.code).toBe(0);
    const report = JSON.parse(approve.stdout) as {
      authority: { mode: string; canCompleteGoals: boolean };
      decision: {
        goalId: string; requirementId: string; decision: string; reviewer: string;
        verdict: string; state: string; remainingParked: number; auditPath: string;
      };
    };
    expect(report.authority).toEqual({ mode: 'human-review', canCompleteGoals: false, canCompleteLoops: false });
    expect(report.decision).toMatchObject({
      goalId: 'g-ok',
      requirementId: 'r1',
      decision: 'approve',
      reviewer: 'Ludi',
      verdict: 'verified',
      state: 'complete',
      remainingParked: 0,
    });

    const audit = await readFile(join(workspace, 'data', 'human-reviews', 'g-ok.jsonl'), 'utf8');
    expect(audit).toContain('"human-review-decision"');
    expect(audit).toContain('"Copy is clear and ready."');

    const after = await runJarvis(['--cwd', workspace, 'review', 'list']);
    expect(after.stdout).toContain('no pending human reviews');

    const again = await runJarvis([
      '--cwd', workspace, 'review', 'approve', 'g-ok', '--requirement', 'r1', '--note', 'second pass',
    ]);
    expect(again.code).toBe(CLI_EXIT.USAGE);
    expect(again.stderr).toContain('no pending human review');
  });

  it('keeps undecided requirements parked and turns a rejection into a rejected verdict', async () => {
    const workspace = await tempWorkspace('partial ');
    await writeParkedGoal(workspace, 'g-two', [
      { id: 'r1', text: 'Ludi confirms the copy reads naturally' },
      { id: 'r2', text: 'Ludi confirms the layout matches the design' },
    ]);

    const approveOne = await runJarvis([
      '--cwd', workspace, 'review', 'approve', 'g-two', '--requirement', 'r1', '--note', 'copy ok',
    ]);
    expect(approveOne.code).toBe(0);
    expect(approveOne.stdout).toContain('state: blocked');
    expect(approveOne.stdout).toContain('remaining parked requirements: 1');

    const rejectTwo = await runJarvis([
      '--cwd', workspace, 'review', 'reject', 'g-two', '--requirement', 'r2', '--note', 'layout off',
    ]);
    expect(rejectTwo.code).toBe(0);
    expect(rejectTwo.stdout).toContain('resulting verdict: rejected');
    expect(rejectTwo.stdout).toContain('state: blocked');
    expect(rejectTwo.stdout).toContain('remaining parked requirements: 0');
  });

  it('appends the loop finish record when the parked goal belongs to a loop', async () => {
    const workspace = await tempWorkspace('loop ');
    await writeParkedGoal(workspace, 'g-loop', [{ id: 'r1', text: 'Ludi confirms the behavior' }]);
    await writeLoopWithBlockedGoal(workspace, 'loop-1', 'g-loop');

    const approve = await runJarvis([
      '--cwd', workspace, 'review', 'approve', 'g-loop', '--requirement', 'r1', '--note', 'confirmed', '--json',
    ]);

    expect(approve.code).toBe(0);
    const report = JSON.parse(approve.stdout) as { decision: { loop?: { loopId: string; index: number } } };
    expect(report.decision.loop).toEqual({ loopId: 'loop-1', index: 0 });

    const loopRecords = parseLoopLog(await readFile(join(workspace, 'data', 'loops', 'loop-1.jsonl'), 'utf8'));
    expect(loopRecords.at(-1)).toMatchObject({
      t: 'goal-finished',
      goalId: 'g-loop',
      state: 'complete',
      outcome: 'verified',
    });
  });

  it('rejects usage errors with exit 2 and isolates sibling-log corruption from a recorded decision', async () => {
    const workspace = await tempWorkspace('errors ');
    await writeParkedGoal(workspace, 'g-err', [{ id: 'r1', text: 'Ludi confirms the behavior' }]);

    const missingNote = await runJarvis(['--cwd', workspace, 'review', 'approve', 'g-err', '--requirement', 'r1']);
    expect(missingNote.code).toBe(CLI_EXIT.USAGE);

    const unknownRequirement = await runJarvis([
      '--cwd', workspace, 'review', 'approve', 'g-err', '--requirement', 'rX', '--note', 'nope',
    ]);
    expect(unknownRequirement.code).toBe(CLI_EXIT.USAGE);
    expect(unknownRequirement.stderr).toContain('unknown human-review requirement');

    const unsafeId = await runJarvis(['--cwd', workspace, 'review', 'show', '../evil']);
    expect(unsafeId.code).toBe(CLI_EXIT.USAGE);

    // A corrupt SIBLING log makes full-directory scans fail (list/show exit 7)
    // but must not rewrite the outcome of a decision that was already recorded.
    await writeFile(
      join(workspace, 'data', 'goals', 'g-corrupt.jsonl'),
      '{"t":"goal-created","id":"g-corrupt","objective":"o","objectiveHash":"h","budget":{"maxRounds":1},"pinned":[],"sessionId":"g-corrupt","createdAt":"t0"}\n'
        + '{"t":"goal-round","round":\n'
        + '{"t":"goal-state","state":"blocked","at":"t1"}\n',
      'utf8',
    );
    const list = await runJarvis(['--cwd', workspace, 'review', 'list']);
    expect(list.code).toBe(CLI_EXIT.STATE_CORRUPT);
    const show = await runJarvis(['--cwd', workspace, 'review', 'show', 'g-err']);
    expect(show.code).toBe(CLI_EXIT.STATE_CORRUPT);

    const approve = await runJarvis([
      '--cwd', workspace, 'review', 'approve', 'g-err', '--requirement', 'r1', '--note', 'recorded despite sibling damage',
    ]);
    expect(approve.code).toBe(0);
    expect(approve.stdout).toContain('decision recorded');
    expect(approve.stdout).toContain('state: complete');
    expect(approve.stdout).toContain('remaining parked requirements: unknown');
    const audit = await readFile(join(workspace, 'data', 'human-reviews', 'g-err.jsonl'), 'utf8');
    expect(audit).toContain('recorded despite sibling damage');
    const retry = await runJarvis([
      '--cwd', workspace, 'review', 'approve', 'g-err', '--requirement', 'r1', '--note', 'second pass',
    ]);
    expect(retry.code).toBe(CLI_EXIT.USAGE);
  });

  it('fails closed with exit 7 and appends nothing when the target goal log itself is corrupt', async () => {
    const workspace = await tempWorkspace('target corrupt ');
    await writeParkedGoal(workspace, 'g-target', [{ id: 'r1', text: 'Ludi confirms the behavior' }]);
    const goalPath = join(workspace, 'data', 'goals', 'g-target.jsonl');
    const original = await readFile(goalPath, 'utf8');
    const lines = original.trim().split('\n');
    const corrupted = `${lines[0]}\n{"t":"goal-round","round":\n${lines.slice(2).join('\n')}\n`;
    await writeFile(goalPath, corrupted, 'utf8');

    const approve = await runJarvis([
      '--cwd', workspace, 'review', 'approve', 'g-target', '--requirement', 'r1', '--note', 'must not land',
    ]);

    expect(approve.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expect(await readFile(goalPath, 'utf8')).toBe(corrupted);
    await expect(readFile(join(workspace, 'data', 'human-reviews', 'g-target.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('never loads a provider or echoes the credential value', async () => {
    const source = await readFile(join(repo, 'src', 'surfaces', 'cli', 'review.ts'), 'utf8');
    expect(source).not.toMatch(/createProvider|loadDoubaoConfig|loadEnvFile|ARK_API_KEY/u);

    const workspace = await tempWorkspace('nokey ');
    await writeParkedGoal(workspace, 'g-key', [{ id: 'r1', text: 'Ludi confirms the behavior' }]);

    const list = await runJarvis(['--cwd', workspace, 'review', 'list'], KEY_SENTINEL);
    const approve = await runJarvis(
      ['--cwd', workspace, 'review', 'approve', 'g-key', '--requirement', 'r1', '--note', 'ok'],
      KEY_SENTINEL,
    );

    expect(list).toMatchObject({ code: 0 });
    expect(approve).toMatchObject({ code: 0 });
    for (const result of [list, approve]) {
      expect(result.stdout).not.toContain(KEY_SENTINEL);
      expect(result.stderr).not.toContain(KEY_SENTINEL);
    }
  });
});

async function tempWorkspace(prefix: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `jarvis review e2e ${prefix}`));
  tempDirs.push(workspace);
  await mkdir(join(workspace, 'data', 'goals'), { recursive: true });
  await mkdir(join(workspace, 'data', 'loops'), { recursive: true });
  return workspace;
}

async function writeParkedGoal(workspace: string, goalId: string, pinned: PinnedRequirement[]): Promise<void> {
  const pinnedWithRoute = pinned.map((requirement) => ({ ...requirement, route: requirement.route ?? 'human' as const }));
  const report = composeVerifierReport({
    pinned: pinnedWithRoute,
    routes: new Map(pinnedWithRoute.map((requirement) => [requirement.id, requirement.route])),
  });
  const verdict = decideVerdict(cleanChecks, report, pinnedWithRoute);
  const text =
    serializeGoalRecord({
      t: 'goal-created',
      id: goalId,
      objective: 'Polish the visible copy.',
      objectiveHash: 'hash',
      budget: { maxRounds: 2 },
      pinned: pinnedWithRoute,
      sessionId: goalId,
      createdAt: '2026-07-03T17:00:00.000Z',
    })
    + serializeGoalRecord({
      t: 'goal-round',
      round: 1,
      turns: 3,
      tokens: 42,
      checks: cleanChecks,
      verdict,
      at: '2026-07-03T17:01:00.000Z',
    })
    + serializeGoalRecord({ t: 'goal-state', state: 'blocked', at: '2026-07-03T17:01:01.000Z' });
  await writeFile(join(workspace, 'data', 'goals', `${goalId}.jsonl`), text, 'utf8');
}

async function writeLoopWithBlockedGoal(workspace: string, loopId: string, goalId: string): Promise<void> {
  const text =
    serializeLoopRecord({
      t: 'loop-created',
      id: loopId,
      contract: {
        maxGoals: 1,
        maxTotalTokens: 1000,
        maxWallClockMs: 60_000,
        maxConsecutiveBlocked: 3,
        cnvWindow: 3,
        cnvThreshold: 3,
        perGoalBudget: { maxRounds: 2 },
      },
      objectives: ['Polish the visible copy.'],
      createdAt: '2026-07-03T17:00:00.000Z',
    })
    + serializeLoopRecord({ t: 'goal-started', index: 0, goalId, at: '2026-07-03T17:00:00.000Z' })
    + serializeLoopRecord({
      t: 'goal-finished',
      index: 0,
      goalId,
      state: 'blocked',
      outcome: 'couldNotVerify',
      rounds: 1,
      tokens: 42,
      at: '2026-07-03T17:01:01.000Z',
    });
  await writeFile(join(workspace, 'data', 'loops', `${loopId}.jsonl`), text, 'utf8');
}

function runJarvis(
  args: string[],
  apiKey: string | null = '',
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ARK_MODEL: 'review-cli-test-model' };
    delete env.JARVIS_HOOKS;
    delete env.ARK_VISION_MODEL;
    if (apiKey === null) delete env.ARK_API_KEY;
    else env.ARK_API_KEY = apiKey;
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', entry, ...args],
      { cwd: repo, env, encoding: 'utf8', timeout: spawnBudget(20_000), windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const rawCode: unknown = error === null ? 0 : (error as { code?: unknown }).code;
        const code = typeof rawCode === 'number' ? rawCode : null;
        done({ code, stdout, stderr });
      },
    );
    child.stdin?.end();
  });
}
