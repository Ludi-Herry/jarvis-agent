import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serializeLoopRecord, type LoopContract } from '../../src/capabilities/goal/index.js';

describe('loop CLI parallel resume smoke', () => {
  it('fails before appending new loop records when a resumed parallel worktree is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis-loop-cli-cwd-'));
    const configDir = await mkdtemp(join(tmpdir(), 'jarvis-loop-cli-config-'));
    const home = await mkdtemp(join(tmpdir(), 'jarvis-loop-cli-home-'));
    try {
      await writeFile(join(cwd, '.env'), 'ARK_API_KEY=test-key\n', 'utf8');
      const verifierMap = join(configDir, 'loop-verifiers.json');
      const hookMap = join(configDir, 'loop-hooks.json');
      const worktreeRoot = join(configDir, 'worktrees');
      await writeFile(verifierMap, JSON.stringify({ goals: [] }), 'utf8');
      await writeFile(hookMap, JSON.stringify({ goals: [] }), 'utf8');

      const loopId = 'parallel-resume-missing-worktree';
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
      const loopPath = join(loopsDir, `${loopId}.jsonl`);
      const original =
        serializeLoopRecord({ t: 'loop-created', id: loopId, contract, objectives: ['inspect README'], createdAt: 't0' }) +
        serializeLoopRecord({ t: 'goal-started', index: 0, goalId: `${loopId}-g0-old`, at: 't1' });
      await writeFile(loopPath, original, 'utf8');

      const result = await runLoopCli(
        ['--resume', '--parallel', '2', '--worktree-root', worktreeRoot, '--verifier-map', verifierMap, '--hook-map', hookMap, '--unattended'],
        cwd,
        home,
      );

      expect(result.code).toBe(1);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('missing resumed worktree');
      await expect(readFile(loopPath, 'utf8')).resolves.toBe(original);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(configDir, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});

function runLoopCli(args: string[], cwd: string, home: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.ARK_API_KEY;
  delete env.ARK_VERIFIER_MODEL;
  delete env.ARK_VISION_MODEL;
  delete env.JARVIS_HOOKS;
  delete env.JARVIS_SHADOW_GIT;

  const child = spawn(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/surfaces/cli/loop-cli.ts'), ...args], {
    cwd,
    env,
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('loop CLI timed out'));
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
