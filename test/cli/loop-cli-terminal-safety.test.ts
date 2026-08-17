import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// This file launches real CLI subprocesses; full-suite worker contention can
// exceed Vitest's 5 s default even though each child has its own cap.
vi.setConfig({ testTimeout: 20_000 });
afterAll(() => vi.resetConfig());
import {
  serializeLoopRecord,
  type LoopContract,
} from '../../src/capabilities/goal/index.js';
import { CLI_EXIT } from '../../src/surfaces/cli/exit-codes.js';

const ESC = String.fromCharCode(27);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loop CLI terminal safety', () => {
  it('single-lines an early hostile argument error', async () => {
    const cwd = await tempDir('cwd');
    const home = await tempDir('home');
    const attack = `--evil${ESC}[2J${ESC}[31m\r\nFORGED-LOOP-ARG`;

    const result = await runLoopCli([attack], cwd, home);

    expect(result.code).toBe(CLI_EXIT.USAGE);
    expectSingleLine(result.stderr, 'FORGED-LOOP-ARG');
  });

  it('single-lines a hostile hook-map path error', async () => {
    const cwd = await configuredWorkspace('hook-map');
    const home = await tempDir('home');
    const configDir = await tempDir('config');
    const hookMap = join(configDir, 'hooks.json');
    const attack = join(configDir, `missing${ESC}[2J${ESC}[31m\r\nFORGED-HOOK-PATH.json`);
    await writeFile(hookMap, JSON.stringify({ goals: [{ index: 0, hookPath: attack }] }), 'utf8');

    const result = await runLoopCli(['--allow-no-git', '--hook-map', hookMap], cwd, home);

    expect(result.code).toBe(CLI_EXIT.USAGE);
    expectSingleLine(result.stderr, 'FORGED-HOOK-PATH.json');
  });

  it('single-lines a hostile in-flight goal identity on the actual resume path', async () => {
    const cwd = await configuredWorkspace('resume');
    const home = await tempDir('home');
    const configDir = await tempDir('config');
    const verifierMap = join(configDir, 'verifiers.json');
    const hookMap = join(configDir, 'hooks.json');
    const sandboxMap = join(configDir, 'sandbox.json');
    const worktreeRoot = join(configDir, `worktrees${ESC}[2J${ESC}[31m\r\nFORGED-RESUME-PATH`);
    for (const path of [verifierMap, hookMap, sandboxMap]) {
      await writeFile(path, JSON.stringify({ goals: [] }), 'utf8');
    }
    initGitFixture(cwd);

    const loopId = 'terminal-safe-resume';
    const goalId = `${loopId}-g0`;
    const contract: LoopContract = {
      maxGoals: 1,
      maxTotalTokens: 1000,
      maxWallClockMs: 1000,
      maxConsecutiveBlocked: 3,
      cnvWindow: 3,
      cnvThreshold: 3,
      perGoalBudget: { maxRounds: 1, maxTotalTokens: 1000 },
    };
    const loopsDir = join(cwd, 'data', 'loops');
    await mkdir(loopsDir, { recursive: true });
    await writeFile(
      join(loopsDir, `${loopId}.jsonl`),
      serializeLoopRecord({
        t: 'loop-created',
        id: loopId,
        contract,
        objectives: ['inspect README'],
        verifierMapPath: resolve(verifierMap),
        hookMapPath: resolve(hookMap),
        sandboxCheckMapPath: resolve(sandboxMap),
        createdAt: 't0',
      }) + serializeLoopRecord({ t: 'goal-started', index: 0, goalId, at: 't1' }),
      'utf8',
    );

    const result = await runLoopCli([
      '--resume',
      '--parallel', '2',
      '--worktree-root', worktreeRoot,
      '--verifier-map', verifierMap,
      '--hook-map', hookMap,
      '--sandbox-check-map', sandboxMap,
      '--unattended',
    ], cwd, home);

    expect(result.code).toBe(CLI_EXIT.STATE_CORRUPT);
    expectSingleLine(result.stderr, 'FORGED-RESUME-PATH');
    expect(result.stderr).toContain('[loop resume]');
  }, 30_000);
});

function expectSingleLine(output: string, marker: string): void {
  expect(output).not.toContain(ESC);
  expect(output).not.toContain('\r');
  expect(output).not.toContain(`\n${marker}`);
  expect(output).toContain(marker);
}

async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `jarvis-loop-terminal-${label}-`));
  tempDirs.push(dir);
  return dir;
}

async function configuredWorkspace(label: string): Promise<string> {
  const cwd = await tempDir(label);
  await writeFile(join(cwd, '.env'), 'ARK_API_KEY=test-key\n', 'utf8');
  return cwd;
}

function initGitFixture(cwd: string): void {
  for (const args of [
    ['init'],
    ['-c', 'user.name=Jarvis Test', '-c', 'user.email=jarvis@example.test', 'commit', '--allow-empty', '-m', 'init'],
  ]) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`${result.stdout}${result.stderr}`);
  }
}

function runLoopCli(
  args: string[],
  cwd: string,
  home: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.ARK_API_KEY;
  delete env.ARK_VERIFIER_MODEL;
  delete env.ARK_VISION_MODEL;
  delete env.JARVIS_HOOKS;
  delete env.JARVIS_SHADOW_GIT;

  const child = spawn(
    process.execPath,
    [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/surfaces/cli/loop-cli.ts'), ...args],
    { cwd, env, windowsHide: true },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });

  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('loop CLI terminal-safety test timed out'));
    }, 30_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}
