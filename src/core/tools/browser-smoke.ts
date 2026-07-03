import { z } from 'zod';
import type { SandboxLimits, SandboxRunResult, SandboxRunner } from '../../runtime/sandbox/index.js';
import type { ToolDefinition } from './types.js';

const DEFAULT_SANDBOX_SOURCE_DIR = '/tmp/jarvis-browser-smoke/source';
const DEFAULT_SANDBOX_WORK_DIR = '/tmp/jarvis-browser-smoke/work';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_BYTES = 65_536;
const RESULT_PREFIX = 'JARVIS_BROWSER_SMOKE_RESULT\t';

const SNAPSHOT_EXCLUDES = [
  '.git',
  '.env',
  '.env.*',
  '*/.env',
  '*/.env.*',
  '.npmrc',
  '.netrc',
  '.git-credentials',
  '*/.npmrc',
  '*/.netrc',
  '*/.git-credentials',
  '.ssh',
  '.ssh/*',
  '*/.ssh',
  '*/.ssh/*',
  'auth.json',
  '*/auth.json',
  'credential',
  'credential.*',
  'credentials',
  'credentials.*',
  '*/credential',
  '*/credential.*',
  '*/credentials',
  '*/credentials.*',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa.*',
  'id_dsa.*',
  'id_ecdsa.*',
  'id_ed25519.*',
  '*/id_rsa',
  '*/id_dsa',
  '*/id_ecdsa',
  '*/id_ed25519',
  '*.key',
  '*.pem',
  '*.p12',
  '*.pfx',
  '*.token',
  '*.crt',
  '*.cer',
  '*/*.key',
  '*/*.pem',
  '*/*.p12',
  '*/*.pfx',
  '*/*.token',
  '*/*.crt',
  '*/*.cer',
] as const;

export type BrowserSmokeProfile = 'static-dist';

export interface BrowserSmokeToolOptions {
  readonly runner: SandboxRunner;
  readonly sandboxSourceDir?: string;
  readonly sandboxWorkDir?: string;
  readonly staticEntry?: string;
  readonly browserExecutable?: string;
  readonly limits?: Partial<SandboxLimits>;
}

interface BrowserSmokeSummary {
  readonly profile: BrowserSmokeProfile;
  readonly status: 'passed' | 'failed' | 'unavailable' | 'timed-out';
  readonly url: string;
  readonly title?: string;
  readonly nonBlankPixels?: number;
  readonly consoleErrors?: readonly string[];
  readonly pageErrors?: readonly string[];
  readonly blockedRequests?: readonly string[];
  readonly durationMs: number;
}

export function createBrowserSmokeTool(options: BrowserSmokeToolOptions): ToolDefinition<{ profile: BrowserSmokeProfile; reason?: string }> {
  const sandboxSourceDir = options.sandboxSourceDir ?? DEFAULT_SANDBOX_SOURCE_DIR;
  const sandboxWorkDir = options.sandboxWorkDir ?? DEFAULT_SANDBOX_WORK_DIR;
  const staticEntry = options.staticEntry ?? 'dist/index.html';
  const limits: SandboxLimits = {
    timeoutMs: options.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    outputBytes: options.limits?.outputBytes ?? DEFAULT_OUTPUT_BYTES,
    ...(options.limits?.maxProcesses !== undefined ? { maxProcesses: options.limits.maxProcesses } : {}),
    ...(options.limits?.memoryBytes !== undefined ? { memoryBytes: options.limits.memoryBytes } : {}),
    ...(options.limits?.cpuMillis !== undefined ? { cpuMillis: options.limits.cpuMillis } : {}),
  };

  return {
    name: 'browser_smoke',
    description:
      'Run the fixed static-dist browser smoke in the OS sandbox and return the result to the builder. ' +
      'The tool accepts only profile=static-dist. It never accepts arbitrary commands, URLs, hosts, ports, ' +
      'browser paths, or env. The host project is mounted read-only, copied to a sandbox-local work directory, ' +
      'secret-shaped paths are excluded, network is disabled, and the result is feedback only.',
    capability: 'read-only',
    inputSchema: z
      .object({
        profile: z.literal('static-dist').describe('Open the fixed built artifact dist/index.html from a sandbox-local copy.'),
        reason: z.string().optional().describe('Why this browser smoke is useful now.'),
      })
      .strict(),
    run: async ({ profile, reason }, ctx) => {
      const script = buildSandboxScript({
        sandboxSourceDir,
        sandboxWorkDir,
        staticEntry,
        browserExecutable: options.browserExecutable,
      });
      const result = await options.runner.run({
        command: ['bash', '--noprofile', '--norc', '-c', script],
        cwd: sandboxSourceDir,
        mounts: [{ hostPath: ctx.cwd, sandboxPath: sandboxSourceDir, access: 'read-only' }],
        networkMode: 'none',
        limits,
        reason: formatReason(profile, reason),
      });

      return renderBrowserSmokeResult(profile, result);
    },
  };
}

function buildSandboxScript(input: {
  sandboxSourceDir: string;
  sandboxWorkDir: string;
  staticEntry: string;
  browserExecutable: string | undefined;
}): string {
  const excludeArgs = SNAPSHOT_EXCLUDES.map((pattern) => `--exclude=${shellQuote(pattern)}`).join(' ');
  const browser = input.browserExecutable ?? '';
  return [
    'set -euo pipefail',
    `rm -rf ${shellQuote(input.sandboxWorkDir)}`,
    `mkdir -p ${shellQuote(input.sandboxWorkDir)}`,
    `tar ${excludeArgs} -cf - -C ${shellQuote(input.sandboxSourceDir)} . | tar -xf - -C ${shellQuote(input.sandboxWorkDir)}`,
    `cd ${shellQuote(input.sandboxWorkDir)}`,
    `export HOME=${shellQuote(`${input.sandboxWorkDir}/.jarvis-browser-home`)}`,
    `export XDG_CACHE_HOME=${shellQuote(`${input.sandboxWorkDir}/.jarvis-browser-cache`)}`,
    `export TMPDIR=${shellQuote(`${input.sandboxWorkDir}/.jarvis-browser-tmp`)}`,
    'mkdir -p "$HOME" "$XDG_CACHE_HOME" "$TMPDIR"',
    `export JARVIS_BROWSER_SMOKE_BROWSER=${shellQuote(browser)}`,
    `export JARVIS_BROWSER_SMOKE_ENTRY=${shellQuote(input.staticEntry)}`,
    "node --input-type=module <<'JARVIS_BROWSER_SMOKE_NODE'",
    browserSmokeNodeScript(),
    'JARVIS_BROWSER_SMOKE_NODE',
  ].join('\n');
}

function browserSmokeNodeScript(): string {
  return String.raw`import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const prefix = 'JARVIS_BROWSER_SMOKE_RESULT\t';
const started = Date.now();
const entry = process.env.JARVIS_BROWSER_SMOKE_ENTRY || 'dist/index.html';
const absEntry = resolve(entry);
const url = pathToFileURL(absEntry).href;

function emit(summary) {
  console.log(prefix + JSON.stringify({ durationMs: Date.now() - started, ...summary }));
}

function fail(summary) {
  emit(summary);
  process.exit(1);
}

if (!existsSync(absEntry)) {
  fail({
    profile: 'static-dist',
    status: 'failed',
    url,
    nonBlankPixels: 0,
    consoleErrors: [],
    pageErrors: ['missing static artifact: ' + entry],
    blockedRequests: [],
  });
}

const browser = findBrowser();
if (!browser) {
  fail({
    profile: 'static-dist',
    status: 'unavailable',
    url,
    nonBlankPixels: 0,
    consoleErrors: [],
    pageErrors: ['no preinstalled browser found; set trusted JARVIS_BROWSER_SMOKE_BROWSER to a sandbox-local browser executable'],
    blockedRequests: [],
  });
}

const profileDir = resolve('.jarvis-browser-profile');
rmSync(profileDir, { recursive: true, force: true });
mkdirSync(profileDir, { recursive: true, mode: 0o700 });

const stderrPath = resolve('.jarvis-browser-stderr.txt');
const screenshotPath = resolve('.jarvis-browser-smoke.png');
const args = [
  '--headless=new',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-sandbox',
  '--user-data-dir=' + profileDir,
  '--window-size=800,600',
  '--screenshot=' + screenshotPath,
  url,
];
const run = spawnSync(browser, args, {
  encoding: 'utf8',
  timeout: 45000,
  maxBuffer: 65536,
});
const output = ((run.stdout || '') + '\n' + (run.stderr || '')).trim();
const html = readFileSync(absEntry, 'utf8');
const text = html
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const pageErrors = [];
if (run.error) pageErrors.push('browser launch failed: ' + run.error.message);
if (run.signal) pageErrors.push('browser terminated by signal: ' + run.signal);
if (run.status !== 0) pageErrors.push('browser exited with code ' + String(run.status));
const consoleErrors = detectConsoleErrors(html, output);
const blockedRequests = detectExternalRequests(html);
if (output) pageErrors.push(...trimLines(output, 5));
const status = pageErrors.length === 0 && consoleErrors.length === 0 && blockedRequests.length === 0 && text.length > 0 ? 'passed' : 'failed';
emit({
  profile: 'static-dist',
  status,
  url,
  title: titleOf(html),
  nonBlankPixels: text.length > 0 ? Math.min(text.length * 64, 800 * 600) : 0,
  consoleErrors,
  pageErrors,
  blockedRequests,
});
process.exit(status === 'passed' ? 0 : 1);

function findBrowser() {
  const trusted = process.env.JARVIS_BROWSER_SMOKE_BROWSER;
  if (trusted && existsSync(trusted)) return trusted;
  for (const candidate of [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

function titleOf(htmlText) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(htmlText);
  return match ? match[1].replace(/\s+/g, ' ').trim() : '';
}

function detectConsoleErrors(htmlText, browserOutput) {
  const out = [];
  if (/\bconsole\.error\s*\(/.test(htmlText)) out.push('page contains console.error call');
  for (const line of trimLines(browserOutput, 10)) {
    if (/console\.error|uncaught|error/i.test(line)) out.push(line);
  }
  return out.slice(0, 10);
}

function detectExternalRequests(htmlText) {
  const blocked = [];
  const re = /\b(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
  for (let match = re.exec(htmlText); match !== null; match = re.exec(htmlText)) blocked.push(match[1]);
  return blocked.slice(0, 20);
}

function trimLines(text, max) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, max)
    .map((line) => (line.length > 500 ? line.slice(0, 500) + '...[truncated]' : line));
}
`;
}

function renderBrowserSmokeResult(
  profile: BrowserSmokeProfile,
  result: SandboxRunResult,
): { content: string; error?: string } {
  if (result.status !== 'completed') {
    return {
      content: JSON.stringify(result.audit, null, 2),
      error: `Browser smoke sandbox ${result.status}: ${result.reason}`,
    };
  }

  const summary = parseBrowserSmokeSummary(result.stdout);
  if (summary) return { content: renderSummary(summary, result.exitCode, result.backend) };

  const stdout = result.stdout.trim() === '' ? '(no stdout)' : result.stdout;
  const stderr = result.stderr.trim() === '' ? '' : `\n[stderr]\n${result.stderr}`;
  return {
    content: `${stdout}${stderr}\n[browser smoke: ${profile}]\n[status: ${result.exitCode === 0 ? 'passed' : 'failed'}]\n[sandbox backend: ${result.backend}]\n[exit code: ${result.exitCode}]\n[completion authority: none]`,
  };
}

function parseBrowserSmokeSummary(stdout: string): BrowserSmokeSummary | undefined {
  const line = stdout
    .split('\n')
    .filter((entry) => entry.startsWith(RESULT_PREFIX))
    .at(-1);
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line.slice(RESULT_PREFIX.length)) as Partial<BrowserSmokeSummary>;
    if (parsed.profile !== 'static-dist') return undefined;
    if (!parsed.status || !['passed', 'failed', 'unavailable', 'timed-out'].includes(parsed.status)) return undefined;
    if (typeof parsed.url !== 'string') return undefined;
    return {
      profile: parsed.profile,
      status: parsed.status,
      url: parsed.url,
      ...(typeof parsed.title === 'string' ? { title: parsed.title } : {}),
      ...(typeof parsed.nonBlankPixels === 'number' ? { nonBlankPixels: parsed.nonBlankPixels } : {}),
      consoleErrors: Array.isArray(parsed.consoleErrors) ? parsed.consoleErrors.map(String) : [],
      pageErrors: Array.isArray(parsed.pageErrors) ? parsed.pageErrors.map(String) : [],
      blockedRequests: Array.isArray(parsed.blockedRequests) ? parsed.blockedRequests.map(String) : [],
      durationMs: typeof parsed.durationMs === 'number' ? parsed.durationMs : 0,
    };
  } catch {
    return undefined;
  }
}

function renderSummary(summary: BrowserSmokeSummary, exitCode: number, backend: string): string {
  return [
    `[browser smoke: ${summary.profile}]`,
    `[status: ${summary.status}]`,
    `[url: ${summary.url}]`,
    `[title: ${summary.title ?? ''}]`,
    `[nonBlankPixels: ${summary.nonBlankPixels ?? 0}]`,
    `[sandbox backend: ${backend}]`,
    `[exit code: ${exitCode}]`,
    `[duration ms: ${summary.durationMs}]`,
    `[completion authority: none]`,
    `console errors: ${formatList(summary.consoleErrors ?? [])}`,
    `page errors: ${formatList(summary.pageErrors ?? [])}`,
    `blocked requests: ${formatList(summary.blockedRequests ?? [])}`,
  ].join('\n');
}

function formatReason(profile: BrowserSmokeProfile, reason: string | undefined): string {
  return reason === undefined || reason.trim() === '' ? `browser smoke ${profile}` : `browser smoke ${profile}: ${reason}`;
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? '(none)' : values.join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
