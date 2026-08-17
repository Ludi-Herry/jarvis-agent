import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// This file launches real CLI subprocesses; full-suite worker contention can
// exceed Vitest's 5 s default even though each child has its own cap.
vi.setConfig({ testTimeout: 20_000 });
afterAll(() => vi.resetConfig());
import { CLI_EXIT } from '../../src/surfaces/cli/exit-codes.js';

describe('loop CLI sandbox-check-map trust boundary', () => {
  it('refuses a sandbox-check-map inside the repository root when launched from a subdirectory', async () => {
    const repo = await mkFixtureDir('jarvis-loop-sandbox-repo-');
    const home = await mkFixtureDir('jarvis-loop-sandbox-home-');
    try {
      const cwd = join(repo, 'nested');
      await mkdir(join(repo, '.git'), { recursive: true });
      await mkdir(cwd, { recursive: true });
      await writeFile(join(cwd, '.env'), 'ARK_API_KEY=test-key\n', 'utf8');
      const mapPath = join(repo, 'loop-sandbox-checks.json');
      const objectives = join(home, 'empty-objectives.txt');
      await writeFile(mapPath, JSON.stringify({ goals: [] }), 'utf8');
      await writeFile(objectives, '', 'utf8');

      const result = await runLoopCli(
        [objectives, '--sandbox-check-map', mapPath, '--allow-no-git', '--unattended'],
        cwd,
        home,
      );

      expect(result.code).toBe(CLI_EXIT.USAGE);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('[loop sandbox checks]');
      expect(output).toContain('forbidden working tree');
      await expectNoLoopCreated(cwd);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('refuses a sandbox-check-map inside the parallel worktree root', async () => {
    const cwd = await mkFixtureDir('jarvis-loop-sandbox-cwd-');
    const home = await mkFixtureDir('jarvis-loop-sandbox-home-');
    const config = await mkFixtureDir('jarvis-loop-sandbox-config-');
    try {
      initGitFixture(cwd);
      await writeFile(join(cwd, '.env'), 'ARK_API_KEY=test-key\n', 'utf8');
      const worktreeRoot = join(config, 'worktrees');
      await mkdir(worktreeRoot, { recursive: true });
      const mapPath = join(worktreeRoot, 'loop-sandbox-checks.json');
      const objectives = join(config, 'empty-objectives.txt');
      await writeFile(mapPath, JSON.stringify({ goals: [] }), 'utf8');
      await writeFile(objectives, '', 'utf8');

      const result = await runLoopCli(
        [objectives, '--parallel', '2', '--worktree-root', worktreeRoot, '--sandbox-check-map', mapPath, '--unattended'],
        cwd,
        home,
      );

      expect(result.code).toBe(CLI_EXIT.USAGE);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('[loop sandbox checks]');
      expect(output).toContain('forbidden working tree');
      await expectNoLoopCreated(cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
      await rm(config, { recursive: true, force: true });
    }
  });
});

describe('loop CLI goal-setter requirements map trust boundary', () => {
  it('refuses a goal-setter requirements map inside the repository root when launched from a subdirectory', async () => {
    const repo = await mkFixtureDir('jarvis-loop-requirements-repo-');
    const home = await mkFixtureDir('jarvis-loop-requirements-home-');
    try {
      const cwd = join(repo, 'nested');
      await mkdir(join(repo, '.git'), { recursive: true });
      await mkdir(cwd, { recursive: true });
      await writeFile(join(cwd, '.env'), 'ARK_API_KEY=test-key\n', 'utf8');
      const mapPath = join(repo, 'loop-goal-setter-requirements.json');
      const objectives = join(home, 'empty-objectives.txt');
      await writeFile(mapPath, JSON.stringify({ version: 1, goals: [] }), 'utf8');
      await writeFile(objectives, '', 'utf8');

      const result = await runLoopCli(
        [objectives, '--goal-setter-requirements-map', mapPath, '--allow-no-git', '--unattended'],
        cwd,
        home,
      );

      expect(result.code).toBe(CLI_EXIT.USAGE);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('[loop goal-setter requirements]');
      expect(output).toContain('forbidden working tree');
      await expectNoLoopCreated(cwd);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('refuses a goal-setter requirements map inside the parallel worktree root', async () => {
    const cwd = await mkFixtureDir('jarvis-loop-requirements-cwd-');
    const home = await mkFixtureDir('jarvis-loop-requirements-home-');
    const config = await mkFixtureDir('jarvis-loop-requirements-config-');
    try {
      initGitFixture(cwd);
      await writeFile(join(cwd, '.env'), 'ARK_API_KEY=test-key\n', 'utf8');
      const worktreeRoot = join(config, 'worktrees');
      await mkdir(worktreeRoot, { recursive: true });
      const mapPath = join(worktreeRoot, 'loop-goal-setter-requirements.json');
      const objectives = join(config, 'empty-objectives.txt');
      await writeFile(mapPath, JSON.stringify({ version: 1, goals: [] }), 'utf8');
      await writeFile(objectives, '', 'utf8');

      const result = await runLoopCli(
        [objectives, '--parallel', '2', '--worktree-root', worktreeRoot, '--goal-setter-requirements-map', mapPath, '--unattended'],
        cwd,
        home,
      );

      expect(result.code).toBe(CLI_EXIT.USAGE);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('[loop goal-setter requirements]');
      expect(output).toContain('forbidden working tree');
      await expectNoLoopCreated(cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
      await rm(config, { recursive: true, force: true });
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

async function mkFixtureDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
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
