/**
 * Real WSL2 runner smoke for the opt-in sandboxed_exec path.
 *
 * This does not register sandboxed_exec in Jarvis' default tool registry and does not wire the
 * runner into the verifier. It proves the explicit WSL2 runner path directly, including isolation
 * checks that the model-facing sandboxed_exec allow scope intentionally rejects. It retains WSL temp
 * payload folders for manual inspection; production runner calls clean them by default.
 *
 * Run: npm run sandbox:runner-smoke
 */
import { createWsl2UnshareSandboxRunner, type SandboxRunResult } from '../src/runtime/index.js';

async function main(): Promise<void> {
  const runner = createWsl2UnshareSandboxRunner({ retainTempDirs: true });
  const prevBashEnv = process.env.BASH_ENV;
  const prevEnv = process.env.ENV;
  const prevSecret = process.env.JARVIS_TEST_SECRET_TOKEN;
  const prevGitExternalDiff = process.env.GIT_EXTERNAL_DIFF;
  process.env.BASH_ENV = '/tmp/jarvis-should-not-source.sh';
  process.env.ENV = '/tmp/jarvis-should-not-source-posix.sh';
  process.env.JARVIS_TEST_SECRET_TOKEN = 'LEAKME-DO-NOT-EXFIL';
  process.env.GIT_EXTERNAL_DIFF = '/tmp/jarvis-evil-diff.sh';

  const command = [
    'printf "cwd="; pwd',
    'test -z "${BASH_ENV:-}" && echo "bash_env=empty" || echo "bash_env=leaked"',
    'test -z "${ENV:-}" && echo "env_startup=empty" || echo "env_startup=leaked"',
    'test -z "${JARVIS_TEST_SECRET_TOKEN:-}" && echo "secret_env=hidden" || echo "secret_env=leaked"',
    'test -z "${GIT_EXTERNAL_DIFF:-}" && echo "git_external_diff=empty" || echo "git_external_diff=leaked"',
    'test "${GIT_CONFIG_NOSYSTEM:-}" = "1" && test "${GIT_CONFIG_GLOBAL:-}" = "/dev/null" && echo "git_config=hardened" || echo "git_config=weak"',
    'test -f package.json && echo "package_json=visible" || echo "package_json=missing"',
    'if touch .jarvis-sandbox-write-probe 2>/tmp/jarvis-write.err; then echo "source_write=unexpected_allow"; else echo "source_write=denied"; fi',
    'if test -e /mnt/c || test -e /mnt/h; then echo "windows_mounts=visible"; else echo "windows_mounts=hidden"; fi',
    `python3 - <<'PY'
import socket

sock = socket.socket()
sock.settimeout(1)
try:
    sock.connect(("1.1.1.1", 53))
except OSError as exc:
    print(f"network=blocked:{exc.__class__.__name__}")
else:
    print("network=unexpected_allow")
finally:
    sock.close()
PY`,
  ].join('\n');

  let result: SandboxRunResult | undefined;
  let timeoutProbe: SandboxRunResult | undefined;
  try {
    result = await runner.run({
      command: ['bash', '--noprofile', '--norc', '-c', command],
      cwd: '/tmp/jarvis-sandbox/project',
      mounts: [{ hostPath: process.cwd(), sandboxPath: '/tmp/jarvis-sandbox/project', access: 'read-only' }],
      networkMode: 'none',
      limits: { timeoutMs: 8_000, outputBytes: 12_000 },
      reason: 'real wsl2-unshare runner smoke',
    });
    timeoutProbe = await runner.run({
      command: ['bash', '--noprofile', '--norc', '-c', 'sleep 30'],
      cwd: '/tmp/jarvis-sandbox/project',
      mounts: [{ hostPath: process.cwd(), sandboxPath: '/tmp/jarvis-sandbox/project', access: 'read-only' }],
      networkMode: 'none',
      limits: { timeoutMs: 500, outputBytes: 1_000 },
      reason: 'real wsl2-unshare timeout smoke',
    });
  } finally {
    restoreEnv('BASH_ENV', prevBashEnv);
    restoreEnv('ENV', prevEnv);
    restoreEnv('JARVIS_TEST_SECRET_TOKEN', prevSecret);
    restoreEnv('GIT_EXTERNAL_DIFF', prevGitExternalDiff);
  }

  if (result === undefined || timeoutProbe === undefined) {
    console.error('sandbox runner did not return a smoke result');
    console.log(`\n=== sandbox runner smoke FAILED ===`);
    process.exitCode = 1;
    return;
  }

  if (result.status !== 'completed') {
    console.error(`${result.status}: ${result.reason}`);
    console.log(`\n=== sandbox runner smoke FAILED ===`);
    process.exitCode = 1;
    return;
  }

  const content = `${result.stdout}\n${result.stderr}`;
  console.log(result.stdout);
  if (result.stderr.trim() !== '') console.error(result.stderr);
  console.log(`timeout_probe=${timeoutProbe.status}`);
  console.log(`[sandbox backend: ${result.backend}]`);
  console.log(`[exit code: ${result.exitCode}]`);

  const ok =
    result.exitCode === 0 &&
    content.includes('bash_env=empty') &&
    content.includes('env_startup=empty') &&
    content.includes('secret_env=hidden') &&
    content.includes('git_external_diff=empty') &&
    content.includes('git_config=hardened') &&
    content.includes('package_json=visible') &&
    content.includes('source_write=denied') &&
    content.includes('windows_mounts=hidden') &&
    content.includes('network=blocked') &&
    timeoutProbe.status === 'timed-out';

  console.log(`\n=== sandbox runner smoke ${ok ? 'PASSED' : 'FAILED'} ===`);
  if (!ok) process.exitCode = 1;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
