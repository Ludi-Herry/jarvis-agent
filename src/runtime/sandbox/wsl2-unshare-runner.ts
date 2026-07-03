import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { SandboxLimits, SandboxRunRequest, SandboxRunResult, SandboxRunner } from './sandbox-runner.js';
import { auditSandboxRequest } from './sandbox-runner.js';

const RESULT_PREFIX = 'JARVIS_SANDBOX_RESULT\t';
const DEFAULT_DISTRO = 'Ubuntu-24.04';
const DEFAULT_WSL_EXE = 'wsl.exe';
const HOST_TIMEOUT_SLACK_MS = 5_000;
const HOST_CLEANUP_TIMEOUT_MS = 5_000;

interface SpawnResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string | Buffer;
  readonly stderr: string | Buffer;
  readonly error?: Error;
}

type SpawnSyncLike = (
  command: string,
  args: readonly string[],
  options: {
    input: string;
    encoding: 'utf8';
    env: NodeJS.ProcessEnv;
    timeout: number;
    windowsHide: true;
    maxBuffer: number;
  },
) => SpawnResult;

export interface Wsl2UnshareSandboxRunnerOptions {
  readonly distro?: string;
  readonly wslExe?: string;
  readonly spawnSync?: SpawnSyncLike;
  readonly hostTimeoutSlackMs?: number;
  readonly retainTempDirs?: boolean;
}

interface InnerResult {
  readonly status: 'completed' | 'failed-to-start' | 'timed-out';
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly durationMs?: number;
  readonly reason?: string;
}

export function createWsl2UnshareSandboxRunner(options: Wsl2UnshareSandboxRunnerOptions = {}): SandboxRunner {
  const distro = options.distro ?? DEFAULT_DISTRO;
  const wslExe = options.wslExe ?? DEFAULT_WSL_EXE;
  const runSpawnSync = options.spawnSync ?? spawnSync;
  const hostTimeoutSlackMs = options.hostTimeoutSlackMs ?? HOST_TIMEOUT_SLACK_MS;

  return {
    backend: 'wsl2-unshare',
    async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
      const audit = auditSandboxRequest('wsl2-unshare', request);
      if (request.networkMode !== 'none') {
        return { status: 'failed-to-start', backend: 'wsl2-unshare', audit, reason: 'Only networkMode "none" is supported.' };
      }
      const unsupportedLimits = unsupportedWslLimits(request.limits);
      if (unsupportedLimits.length > 0) {
        return {
          status: 'failed-to-start',
          backend: 'wsl2-unshare',
          audit,
          reason: `Unsupported WSL sandbox limits: ${unsupportedLimits.join(', ')}`,
        };
      }

      const retainTempDirs = options.retainTempDirs ?? false;
      const tempRoot = newWslTempRoot();
      const result = runSpawnSync(wslExe, ['-d', distro, '--', 'python3', '-'], {
        input: buildWslScript(request, retainTempDirs, tempRoot),
        encoding: 'utf8',
        env: sandboxHostEnv(),
        timeout: request.limits.timeoutMs + hostTimeoutSlackMs,
        windowsHide: true,
        maxBuffer: Math.max(request.limits.outputBytes * 4, 1024 * 1024),
      });

      const stdout = cleanOutput(result.stdout);
      const stderr = cleanOutput(result.stderr);
      if (result.error !== undefined) {
        if (!retainTempDirs) {
          cleanupWslTempRoot({
            tempRoot,
            runSpawnSync,
            wslExe,
            distro,
          });
        }
        const reason = result.error.message;
        const status = /timed out|ETIMEDOUT/i.test(reason) ? 'timed-out' : 'failed-to-start';
        return { status, backend: 'wsl2-unshare', audit, reason };
      }

      const inner = parseInnerResult(stdout);
      if (inner === undefined) {
        return {
          status: 'failed-to-start',
          backend: 'wsl2-unshare',
          audit,
          reason: `WSL runner did not return a sandbox result. status=${String(result.status)} signal=${String(result.signal)} stdout=${preview(stdout)} stderr=${preview(stderr)}`,
        };
      }

      if (inner.status === 'completed') {
        return {
          status: 'completed',
          backend: 'wsl2-unshare',
          audit,
          exitCode: inner.exitCode ?? 1,
          stdout: inner.stdout ?? '',
          stderr: inner.stderr ?? '',
          durationMs: inner.durationMs ?? 0,
        };
      }

      return {
        status: inner.status,
        backend: 'wsl2-unshare',
        audit,
        reason: inner.reason ?? `WSL sandbox ${inner.status}`,
      };
    },
  };
}

function newWslTempRoot(): string {
  return `/tmp/jarvis-wsl2-unshare-${randomUUID()}`;
}

function buildWslScript(request: SandboxRunRequest, retainTempDirs: boolean, tempRoot: string): string {
  const payload = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  return `${outerPython(payload, retainTempDirs, tempRoot)}\n`;
}

function unsupportedWslLimits(limits: SandboxLimits): string[] {
  const unsupported: string[] = [];
  if (limits.maxProcesses !== undefined) unsupported.push('maxProcesses');
  if (limits.memoryBytes !== undefined) unsupported.push('memoryBytes');
  if (limits.cpuMillis !== undefined) unsupported.push('cpuMillis');
  return unsupported;
}

function outerPython(payloadBase64: string, retainTempDirs: boolean, tempRoot: string): string {
  return String.raw`import atexit
import base64
import json
import os
import re
import shutil
import subprocess
import sys

RESULT_PREFIX = "JARVIS_SANDBOX_RESULT\t"
PAYLOAD_B64 = "${payloadBase64}"
TEMP_ROOT = ${JSON.stringify(tempRoot)}
RETAIN_TEMP_DIR = ${retainTempDirs ? 'True' : 'False'}
SECRET_COMPONENT_RE = re.compile(r"(^|_)(KEY|PAT|DSN)($|_)")
SECRET_CONN_RE = re.compile(r"(^|_)(DATABASE|DB|MONGODB?|REDIS|POSTGRES(QL)?|MYSQL|MARIADB|AMQP|RABBITMQ|CLICKHOUSE|ELASTIC(SEARCH)?|CONNECTION)_(URL|URI|DSN|CONN|CONNECTION|STRING)")
GIT_ENV = {
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_COUNT": "4",
    "GIT_CONFIG_KEY_0": "core.pager",
    "GIT_CONFIG_VALUE_0": "cat",
    "GIT_CONFIG_KEY_1": "core.fsmonitor",
    "GIT_CONFIG_VALUE_1": "false",
    "GIT_CONFIG_KEY_2": "core.hooksPath",
    "GIT_CONFIG_VALUE_2": "/dev/null",
    "GIT_CONFIG_KEY_3": "interactive.diffFilter",
    "GIT_CONFIG_VALUE_3": "",
    "GIT_PAGER": "cat",
    "PAGER": "cat",
}

def emit(obj):
    print(RESULT_PREFIX + json.dumps(obj, ensure_ascii=False), flush=True)

def fail(reason):
    emit({"status": "failed-to-start", "reason": reason})
    sys.exit(0)

def is_secret_env_name(name):
    upper = name.upper()
    if upper.startswith("ARK_"):
        return True
    if re.search(r"SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|APIKEY|AUTHORIZATION|PRIVATE_KEY|ACCESS_KEY", upper):
        return True
    if SECRET_COMPONENT_RE.search(upper):
        return True
    return SECRET_CONN_RE.search(upper) is not None

def sandbox_env():
    env = {}
    for name, value in os.environ.items():
        upper = name.upper()
        if upper in ("BASH_ENV", "ENV"):
            continue
        if upper.startswith("GIT_"):
            continue
        if is_secret_env_name(upper):
            continue
        env[name] = value
    env.update(GIT_ENV)
    return env

SAFE_ENV = sandbox_env()
payload = json.loads(base64.b64decode(PAYLOAD_B64).decode("utf-8"))
root = os.path.realpath(TEMP_ROOT)
tmp = os.path.realpath("/tmp")
if os.path.dirname(root) != tmp or not os.path.basename(root).startswith("jarvis-wsl2-unshare-"):
    fail(f"unsafe sandbox temp root: {TEMP_ROOT}")
try:
    os.makedirs(root, mode=0o700, exist_ok=False)
except FileExistsError:
    fail(f"sandbox temp root already exists: {TEMP_ROOT}")
if not RETAIN_TEMP_DIR:
    atexit.register(lambda: shutil.rmtree(root, ignore_errors=True))
inner_py = os.path.join(root, "inner.py")
payload_json = os.path.join(root, "payload.json")

def wslpath(path):
    completed = subprocess.run(["wslpath", "-a", path], text=True, capture_output=True, env=SAFE_ENV)
    if completed.returncode != 0:
        fail(f"wslpath failed for {path}: {completed.stderr.strip()}")
    return completed.stdout.strip()

resolved_mounts = []
for index, mount in enumerate(payload["mounts"]):
    source = wslpath(mount["hostPath"])
    if not os.path.exists(source):
        fail(f"mount source does not exist: {mount['hostPath']} -> {source}")
    resolved = dict(mount)
    resolved["resolvedHostPath"] = source
    resolved_mounts.append(resolved)
payload["mounts"] = resolved_mounts
payload["sandboxTempRoot"] = root

with open(payload_json, "w", encoding="utf-8") as handle:
    json.dump(payload, handle)

with open(inner_py, "w", encoding="utf-8") as handle:
    handle.write(r'''import json
import os
import re
import signal
import subprocess
import sys
import time

RESULT_PREFIX = "JARVIS_SANDBOX_RESULT\t"
SECRET_COMPONENT_RE = re.compile(r"(^|_)(KEY|PAT|DSN)($|_)")
SECRET_CONN_RE = re.compile(r"(^|_)(DATABASE|DB|MONGODB?|REDIS|POSTGRES(QL)?|MYSQL|MARIADB|AMQP|RABBITMQ|CLICKHOUSE|ELASTIC(SEARCH)?|CONNECTION)_(URL|URI|DSN|CONN|CONNECTION|STRING)")
GIT_ENV = {
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_COUNT": "4",
    "GIT_CONFIG_KEY_0": "core.pager",
    "GIT_CONFIG_VALUE_0": "cat",
    "GIT_CONFIG_KEY_1": "core.fsmonitor",
    "GIT_CONFIG_VALUE_1": "false",
    "GIT_CONFIG_KEY_2": "core.hooksPath",
    "GIT_CONFIG_VALUE_2": "/dev/null",
    "GIT_CONFIG_KEY_3": "interactive.diffFilter",
    "GIT_CONFIG_VALUE_3": "",
    "GIT_PAGER": "cat",
    "PAGER": "cat",
}

def emit(obj):
    print(RESULT_PREFIX + json.dumps(obj, ensure_ascii=False), flush=True)

def fail(reason):
    emit({"status": "failed-to-start", "reason": reason})
    sys.exit(0)

def is_secret_env_name(name):
    upper = name.upper()
    if upper.startswith("ARK_"):
        return True
    if re.search(r"SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|APIKEY|AUTHORIZATION|PRIVATE_KEY|ACCESS_KEY", upper):
        return True
    if SECRET_COMPONENT_RE.search(upper):
        return True
    return SECRET_CONN_RE.search(upper) is not None

def sandbox_env():
    env = {}
    for name, value in os.environ.items():
        upper = name.upper()
        if upper in ("BASH_ENV", "ENV"):
            continue
        if upper.startswith("GIT_"):
            continue
        if is_secret_env_name(upper):
            continue
        env[name] = value
    env.update(GIT_ENV)
    return env

def run_checked(args):
    completed = subprocess.run(args, text=True, capture_output=True, env=SAFE_ENV)
    if completed.returncode != 0:
        fail(f"{' '.join(args)} failed: {completed.stderr.strip()}")

def cap_pair(stdout, stderr, limit):
    out = stdout[:limit]
    remaining = max(0, limit - len(out))
    err = stderr[:remaining]
    return out.decode("utf-8", errors="replace"), err.decode("utf-8", errors="replace")

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)

SAFE_ENV = sandbox_env()
subprocess.run(["mount", "--make-rprivate", "/"], text=True, capture_output=True, env=SAFE_ENV)

try:
    for mount in payload["mounts"]:
        os.makedirs(mount["sandboxPath"], exist_ok=True)
        run_checked(["mount", "--bind", mount["resolvedHostPath"], mount["sandboxPath"]])
        if mount["access"] == "read-only":
            run_checked(["mount", "-o", "remount,bind,ro", mount["sandboxPath"]])

    os.makedirs("/mnt", exist_ok=True)
    run_checked(["mount", "-t", "tmpfs", "tmpfs", "/mnt"])
    os.makedirs("/home", exist_ok=True)
    run_checked(["mount", "-t", "tmpfs", "tmpfs", "/home"])

    cwd = payload["cwd"]
    if not os.path.isdir(cwd):
        fail(f"sandbox cwd does not exist: {cwd}")

    started = time.monotonic()
    proc = subprocess.Popen(
        payload["command"],
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        env=SAFE_ENV,
    )
    try:
        stdout, stderr = proc.communicate(timeout=payload["limits"]["timeoutMs"] / 1000)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.communicate()
        emit({"status": "timed-out", "reason": f"timed out after {payload['limits']['timeoutMs']}ms"})
        sys.exit(0)

    duration_ms = int((time.monotonic() - started) * 1000)
    stdout_text, stderr_text = cap_pair(stdout, stderr, int(payload["limits"]["outputBytes"]))
    emit({
        "status": "completed",
        "exitCode": proc.returncode,
        "stdout": stdout_text,
        "stderr": stderr_text,
        "durationMs": duration_ms,
    })
except Exception as exc:
    fail(f"{type(exc).__name__}: {exc}")
''')

completed = subprocess.run(
    ["unshare", "-Urnmpf", "--mount-proc", "python3", inner_py, payload_json],
    text=True,
    capture_output=True,
    env=SAFE_ENV,
)

if completed.stdout:
    print(completed.stdout, end="")
if completed.stderr:
    sys.stderr.write(completed.stderr)
if completed.returncode != 0 and RESULT_PREFIX not in completed.stdout:
    fail(f"unshare exited {completed.returncode}: {completed.stderr.strip()}")`;
}

function cleanupWslTempRoot(input: {
  tempRoot: string;
  runSpawnSync: SpawnSyncLike;
  wslExe: string;
  distro: string;
}): void {
  try {
    input.runSpawnSync(input.wslExe, ['-d', input.distro, '--', 'python3', '-'], {
      input: buildWslCleanupScript(input.tempRoot),
      encoding: 'utf8',
      env: sandboxHostEnv(),
      timeout: HOST_CLEANUP_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 128 * 1024,
    });
  } catch {
    // Keep the original sandbox failure as the user-facing result; cleanup is best-effort.
  }
}

function buildWslCleanupScript(tempRoot: string): string {
  return `import os\nimport shutil\nimport sys\n\nroot = os.path.realpath(${JSON.stringify(tempRoot)})\ntmp = os.path.realpath("/tmp")\nif os.path.dirname(root) != tmp or not os.path.basename(root).startswith("jarvis-wsl2-unshare-"):\n    sys.exit(0)\nshutil.rmtree(root, ignore_errors=True)\n`;
}

function parseInnerResult(stdout: string): InnerResult | undefined {
  const lines = stdout.split('\n').filter((line) => line.startsWith(RESULT_PREFIX));
  const last = lines.at(-1);
  if (last === undefined) return undefined;

  try {
    return JSON.parse(last.slice(RESULT_PREFIX.length)) as InnerResult;
  } catch {
    return undefined;
  }
}

function cleanOutput(value: string | Buffer | null | undefined): string {
  const text = typeof value === 'string' ? value : value?.toString('utf8') ?? '';
  return text.replace(/\0/g, '').replace(/\r\n/g, '\n');
}

function preview(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 500)}...`;
}

function sandboxHostEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (upper === 'BASH_ENV' || upper === 'ENV') {
      delete env[name];
      continue;
    }
    if (upper.startsWith('GIT_') || isSecretEnvName(upper)) delete env[name];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'core.pager',
    GIT_CONFIG_VALUE_0: 'cat',
    GIT_CONFIG_KEY_1: 'core.fsmonitor',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'core.hooksPath',
    GIT_CONFIG_VALUE_2: '/dev/null',
    GIT_CONFIG_KEY_3: 'interactive.diffFilter',
    GIT_CONFIG_VALUE_3: '',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  };
}

function isSecretEnvName(name: string): boolean {
  if (name.startsWith('ARK_')) return true;
  if (/SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|APIKEY|AUTHORIZATION|PRIVATE_KEY|ACCESS_KEY/.test(name)) return true;
  if (/(^|_)(KEY|PAT|DSN)($|_)/.test(name)) return true;
  return /(^|_)(DATABASE|DB|MONGODB?|REDIS|POSTGRES(QL)?|MYSQL|MARIADB|AMQP|RABBITMQ|CLICKHOUSE|ELASTIC(SEARCH)?|CONNECTION)_(URL|URI|DSN|CONN|CONNECTION|STRING)/.test(name);
}
