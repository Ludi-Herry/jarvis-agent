import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { JARVIS_VERSION } from './package-info.js';

export type DoctorStatus = 'ok' | 'warn' | 'error';

export interface DoctorCheck {
  id: 'node' | 'cwd' | 'provider' | 'git' | 'sandbox' | 'data';
  status: DoctorStatus;
  summary: string;
  next?: string;
}

export interface DoctorReport {
  schemaVersion: 1;
  version: string;
  cwd: string;
  readyFor: {
    chat: boolean;
    autonomous: boolean;
  };
  checks: DoctorCheck[];
}

export interface DoctorProbeResult {
  code: number | null;
  stdout: string;
  error?: string;
  timedOut?: boolean;
}

export interface DoctorDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  probe?: (command: string, args: string[], cwd: string, timeoutMs: number) => Promise<DoctorProbeResult>;
}

export async function collectDoctorReport(cwd: string, deps: DoctorDeps = {}): Promise<DoctorReport> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const probe = deps.probe ?? runDoctorProbe;
  const checks: DoctorCheck[] = [];

  const major = Number.parseInt(nodeVersion.split('.')[0] ?? '', 10);
  checks.push(
    Number.isFinite(major) && major >= 20
      ? { id: 'node', status: 'ok', summary: `Node ${nodeVersion} (requires >=20)` }
      : { id: 'node', status: 'error', summary: `Node ${nodeVersion || 'unknown'} is unsupported`, next: 'Install Node.js 20 or newer.' },
  );

  const cwdReady = await stat(cwd).then((value) => value.isDirectory()).catch(() => false);
  checks.push(
    cwdReady
      ? { id: 'cwd', status: 'ok', summary: `workspace directory is readable: ${cwd}` }
      : { id: 'cwd', status: 'error', summary: `workspace directory is unavailable: ${cwd}`, next: 'Pass an existing directory with --cwd <path>.' },
  );

  checks.push(await inspectProvider(cwd, env, platform));
  checks.push(await inspectGit(cwd, cwdReady, probe));
  checks.push(await inspectSandbox(cwd, cwdReady, platform, probe));
  checks.push(await inspectDataDirectory(cwd, cwdReady));

  const byId = new Map(checks.map((check) => [check.id, check]));
  const chatCheckIds: DoctorCheck['id'][] = ['node', 'cwd', 'provider', 'data'];
  const chat = chatCheckIds.every((id) => byId.get(id)?.status !== 'error');
  const autonomous = chat && byId.get('git')?.status === 'ok' && byId.get('sandbox')?.status === 'ok';

  return {
    schemaVersion: 1,
    version: JARVIS_VERSION,
    cwd,
    readyFor: { chat, autonomous },
    checks,
  };
}

export function doctorExitCode(report: DoctorReport): 0 | 2 {
  return report.checks.some((check) => check.status === 'error') ? 2 : 0;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `Jarvis doctor ${report.version}`,
    `cwd: ${report.cwd}`,
    `chat: ${report.readyFor.chat ? 'ready' : 'blocked'}`,
    `autonomous: ${report.readyFor.autonomous ? 'ready' : 'limited'}`,
    '',
  ];
  const mark: Record<DoctorStatus, string> = { ok: '[ok]', warn: '[warn]', error: '[error]' };
  for (const check of report.checks) {
    lines.push(`${mark[check.status]} ${check.id}: ${check.summary}`);
  }
  const next = Array.from(new Set(checksWithNext(report).map((check) => check.next as string)));
  if (next.length > 0) {
    lines.push('', 'next:');
    for (const action of next) lines.push(`  - ${action}`);
  }
  return `${lines.join('\n')}\n`;
}

async function inspectProvider(cwd: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<DoctorCheck> {
  const launchKey = env.ARK_API_KEY?.trim();
  if (launchKey) {
    if (platform === 'linux') {
      return {
        id: 'provider',
        status: 'error',
        summary: 'ARK_API_KEY comes from the launch environment, which Jarvis rejects on Linux',
        next: 'Unset ARK_API_KEY in the shell and place it in the workspace .env file.',
      };
    }
    return { id: 'provider', status: 'ok', summary: 'Doubao/ARK credential source: launch environment (value hidden)' };
  }

  const envText = await readFile(join(cwd, '.env'), 'utf8').catch(() => null);
  if (envText !== null && envFileHasNonBlankValue(envText, 'ARK_API_KEY')) {
    return { id: 'provider', status: 'ok', summary: 'Doubao/ARK credential source: workspace .env (value hidden)' };
  }
  return {
    id: 'provider',
    status: 'error',
    summary: 'Doubao/ARK credential is missing',
    next: 'Copy .env.example to .env and fill in ARK_API_KEY.',
  };
}

async function inspectGit(
  cwd: string,
  cwdReady: boolean,
  probe: NonNullable<DoctorDeps['probe']>,
): Promise<DoctorCheck> {
  if (!cwdReady) return { id: 'git', status: 'warn', summary: 'Git probe skipped because cwd is unavailable' };
  const result = await probe('git', ['rev-parse', '--is-inside-work-tree'], cwd, 3_000);
  if (result.code === 0 && result.stdout.trim() === 'true') {
    return { id: 'git', status: 'ok', summary: 'Git worktree detected; tamper baseline is available' };
  }
  return {
    id: 'git',
    status: 'warn',
    summary: result.error ? `Git probe failed: ${result.error}` : 'cwd is not inside a Git worktree',
    next: 'Use a Git worktree before autonomous goal/loop runs, or accept checks-only with --allow-no-git.',
  };
}

async function inspectSandbox(
  cwd: string,
  cwdReady: boolean,
  platform: NodeJS.Platform,
  probe: NonNullable<DoctorDeps['probe']>,
): Promise<DoctorCheck> {
  if (!cwdReady) return { id: 'sandbox', status: 'warn', summary: 'sandbox probe skipped because cwd is unavailable' };
  const invocation = sandboxProbe(platform);
  if (invocation === null) {
    return {
      id: 'sandbox',
      status: 'warn',
      summary: `wsl2-unshare sandbox probe is unsupported on ${platform}`,
      next: 'Run npm run sandbox:smoke on a supported host before autonomous maintenance.',
    };
  }
  const result = await probe(invocation.command, invocation.args, cwd, 5_000);
  if (result.code === 0) {
    return {
      id: 'sandbox',
      status: 'warn',
      summary: 'unshare command is available; full containment smoke was not run',
      next: 'Run npm run sandbox:smoke for the full sandbox acceptance check.',
    };
  }
  return {
    id: 'sandbox',
    status: 'warn',
    summary: result.timedOut ? 'sandbox command probe timed out' : `wsl2-unshare command probe failed${result.error ? `: ${result.error}` : ''}`,
    next: 'Run npm run sandbox:smoke and fix the reported backend issue before autonomous maintenance.',
  };
}

async function inspectDataDirectory(cwd: string, cwdReady: boolean): Promise<DoctorCheck> {
  if (!cwdReady) return { id: 'data', status: 'error', summary: 'data directory cannot be resolved because cwd is unavailable' };
  const dataDir = join(cwd, 'data');
  const info = await stat(dataDir).catch(() => null);
  if (info !== null && !info.isDirectory()) {
    return { id: 'data', status: 'error', summary: `${dataDir} exists but is not a directory`, next: 'Move the conflicting path before starting Jarvis.' };
  }
  const accessTarget = info === null ? cwd : dataDir;
  const usable = await access(accessTarget, constants.R_OK | constants.W_OK).then(() => true).catch(() => false);
  if (!usable) {
    return { id: 'data', status: 'error', summary: `session data path is not readable and writable: ${dataDir}`, next: 'Grant the current user read/write access to the workspace data path.' };
  }
  return info === null
    ? { id: 'data', status: 'warn', summary: `data directory will be created on first run: ${dataDir}` }
    : { id: 'data', status: 'ok', summary: `session data directory is readable and writable: ${dataDir}` };
}

function envFileHasNonBlankValue(text: string, name: string): boolean {
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
    if (!match || match[1] !== name) continue;
    const raw = stripEnvComment(match[2] ?? '').trim();
    const value = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1)
      : raw;
    return value.trim() !== '';
  }
  return false;
}

function stripEnvComment(raw: string): string {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote === '"') {
      escaped = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = quote === char ? undefined : quote ?? char;
      continue;
    }
    if (char === '#' && quote === undefined && (index === 0 || /\s/u.test(raw[index - 1] ?? ''))) {
      return raw.slice(0, index);
    }
  }
  return raw;
}

function sandboxProbe(platform: NodeJS.Platform): { command: string; args: string[] } | null {
  if (platform === 'win32') {
    return { command: 'wsl.exe', args: ['-e', 'sh', '-lc', 'command -v unshare >/dev/null 2>&1'] };
  }
  if (platform === 'linux') {
    return { command: 'sh', args: ['-lc', 'command -v unshare >/dev/null 2>&1'] };
  }
  return null;
}

function checksWithNext(report: DoctorReport): DoctorCheck[] {
  return report.checks.filter((check): check is DoctorCheck & { next: string } => typeof check.next === 'string');
}

function runDoctorProbe(command: string, args: string[], cwd: string, timeoutMs: number): Promise<DoctorProbeResult> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.BASH_ENV;
    delete env.ENV;
    if (command.toLowerCase() === 'git' || command.toLowerCase().endsWith('git.exe')) {
      for (const name of Object.keys(env)) {
        if (name.toUpperCase().startsWith('GIT_')) delete env[name];
      }
    }
    execFile(command, args, { cwd, env, timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 }, (error, stdout) => {
      const err = error as NodeJS.ErrnoException | null;
      resolve({
        code: error === null ? 0 : typeof err?.code === 'number' ? err.code : null,
        stdout: typeof stdout === 'string' ? stdout : '',
        ...(error === null ? {} : { error: err?.code === 'ETIMEDOUT' ? 'timed out' : error.message }),
        ...(err?.code === 'ETIMEDOUT' ? { timedOut: true } : {}),
      });
    });
  });
}
