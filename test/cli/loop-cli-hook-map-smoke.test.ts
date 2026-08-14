import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_EXIT } from '../../src/surfaces/cli/exit-codes.js';

describe('loop CLI hook-map smoke', () => {
  it('exits before loop-created when a per-goal hook config is malformed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis-loop-cli-cwd-'));
    const configDir = await mkdtemp(join(tmpdir(), 'jarvis-loop-cli-config-'));
    const home = await mkdtemp(join(tmpdir(), 'jarvis-loop-cli-home-'));
    try {
      await writeFile(join(cwd, '.env'), 'ARK_API_KEY=test-key\n', 'utf8');
      const objectives = join(configDir, 'objectives.txt');
      const badHooks = join(configDir, 'bad-hooks.json');
      const hookMap = join(configDir, 'loop-hooks.json');
      await writeFile(objectives, 'inspect README\n', 'utf8');
      await writeFile(badHooks, 'not-json{', 'utf8');
      await writeFile(hookMap, JSON.stringify({ goals: [{ index: 0, hookPath: badHooks }] }), 'utf8');

      const result = await runLoopCli([objectives, '--hook-map', hookMap, '--allow-no-git', '--unattended'], cwd, home);

      expect(result.code).toBe(CLI_EXIT.USAGE);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('[hooks]');
      expect(output).toContain('hook map index 0');
      await expectNoLoopCreated(cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(configDir, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('exits before loop-created when --parallel is combined with hook-map hooks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jarvis-loop-cli-cwd-'));
    const configDir = await mkdtemp(join(tmpdir(), 'jarvis-loop-cli-config-'));
    const home = await mkdtemp(join(tmpdir(), 'jarvis-loop-cli-home-'));
    try {
      initGitFixture(cwd);
      await writeFile(join(cwd, '.env'), 'ARK_API_KEY=test-key\n', 'utf8');
      const objectives = join(configDir, 'objectives.txt');
      const hooks = join(configDir, 'goal-hooks.json');
      const hookMap = join(configDir, 'loop-hooks.json');
      const worktreeRoot = join(configDir, 'worktrees');
      await writeFile(objectives, 'inspect README\n', 'utf8');
      await writeFile(hooks, JSON.stringify({ PreToolUse: [{ command: 'echo hook' }] }), 'utf8');
      await writeFile(hookMap, JSON.stringify({ goals: [{ index: 0, hookPath: hooks }] }), 'utf8');

      const result = await runLoopCli(
        [objectives, '--hook-map', hookMap, '--parallel', '2', '--worktree-root', worktreeRoot, '--unattended'],
        cwd,
        home,
      );

      expect(result.code).toBe(CLI_EXIT.USAGE);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('--parallel cannot run with hooks');
      await expectNoLoopCreated(cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(configDir, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});

function initGitFixture(cwd: string): void {
  for (const args of [
    ['init'],
    ['-c', 'user.name=Jarvis Test', '-c', 'user.email=jarvis@example.test', 'commit', '--allow-empty', '-m', 'init'],
  ]) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`${result.stdout}${result.stderr}`);
  }
}

async function expectNoLoopCreated(cwd: string): Promise<void> {
  const loopsDir = join(cwd, 'data', 'loops');
  const entries = await readdir(loopsDir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  const jsonl = entries.filter((entry) => entry.endsWith('.jsonl'));
  const contents = await Promise.all(jsonl.map((entry) => readFile(join(loopsDir, entry), 'utf8')));
  expect(contents.join('\n')).not.toContain('"loop-created"');
  expect(jsonl).toEqual([]);
}

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
