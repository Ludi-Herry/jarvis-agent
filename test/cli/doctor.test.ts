import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectDoctorReport,
  doctorExitCode,
  formatDoctorReport,
  type DoctorProbeResult,
} from '../../src/surfaces/cli/doctor.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jarvis-doctor-'));
  await mkdir(join(dir, 'data'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const okProbe = async (): Promise<DoctorProbeResult> => ({ code: 0, stdout: 'true\n' });

describe('collectDoctorReport', () => {
  it('reports a chat-ready workspace without claiming an unproved sandbox or exposing the credential', async () => {
    await writeFile(join(dir, '.env'), 'ARK_API_KEY="super-secret-do-not-print"\n', 'utf8');

    const report = await collectDoctorReport(dir, {
      env: {},
      platform: 'win32',
      nodeVersion: '20.12.0',
      probe: okProbe,
    });

    expect(report.schemaVersion).toBe(1);
    expect(report.readyFor).toEqual({ chat: true, autonomous: false });
    expect(report.checks.find((check) => check.id === 'provider')).toMatchObject({
      status: 'ok',
      summary: expect.stringContaining('workspace .env'),
    });
    expect(report.checks.find((check) => check.id === 'sandbox')).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('full containment smoke was not run'),
    });
    expect(JSON.stringify(report)).not.toContain('super-secret-do-not-print');
    expect(doctorExitCode(report)).toBe(0);
  });

  it('returns actionable blocked/limited status when credentials and local prerequisites are missing', async () => {
    const failedProbe = async (): Promise<DoctorProbeResult> => ({ code: 1, stdout: '' });

    const report = await collectDoctorReport(dir, {
      env: {},
      platform: 'win32',
      nodeVersion: '20.12.0',
      probe: failedProbe,
    });
    const text = formatDoctorReport(report);

    expect(report.readyFor).toEqual({ chat: false, autonomous: false });
    expect(doctorExitCode(report)).toBe(2);
    expect(text).toContain('[error] provider:');
    expect(text).toContain('[warn] git:');
    expect(text).toContain('next:');
    expect(text).toContain('Copy .env.example to .env');
  });

  it('does not treat an empty quoted .env key with a comment as configured', async () => {
    await writeFile(join(dir, '.env'), 'ARK_API_KEY="" # fill this later\n', 'utf8');

    const report = await collectDoctorReport(dir, {
      env: {},
      platform: 'win32',
      nodeVersion: '20.12.0',
      probe: okProbe,
    });

    expect(report.checks.find((check) => check.id === 'provider')).toMatchObject({ status: 'error' });
    expect(report.readyFor.chat).toBe(false);
  });

  it('rejects a launch-environment credential source on Linux without printing its value', async () => {
    const report = await collectDoctorReport(dir, {
      env: { ARK_API_KEY: 'linux-secret' },
      platform: 'linux',
      nodeVersion: '22.0.0',
      probe: okProbe,
    });

    expect(report.checks.find((check) => check.id === 'provider')).toMatchObject({ status: 'error' });
    expect(JSON.stringify(report)).not.toContain('linux-secret');
    expect(doctorExitCode(report)).toBe(2);
  });

  it('ignores inherited Git control variables when checking the workspace baseline', async () => {
    const previousGitDir = process.env.GIT_DIR;
    const previousGitWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = join(dir, 'attacker-selected-git-dir');
    process.env.GIT_WORK_TREE = dir;
    try {
      const report = await collectDoctorReport(process.cwd(), {
        env: {},
        platform: 'darwin',
        nodeVersion: '22.0.0',
      });

      expect(report.checks.find((check) => check.id === 'git')).toMatchObject({ status: 'ok' });
    } finally {
      restoreEnv('GIT_DIR', previousGitDir);
      restoreEnv('GIT_WORK_TREE', previousGitWorkTree);
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
