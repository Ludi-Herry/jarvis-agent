/**
 * No-download WSL2 sandbox smoke probe.
 *
 * This is a capability probe, not production sandboxing. It verifies what the current machine can
 * enforce with already-installed WSL/Linux tools before Jarvis wires any verifier exec capability.
 *
 * Run: npm run sandbox:smoke
 */
import { spawnSync } from 'node:child_process';

const distro = process.env.JARVIS_SANDBOX_WSL_DISTRO ?? 'Ubuntu-24.04';
const outputPreviewLimit = 4_000;

type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'INFO';

interface Check {
  status: CheckStatus;
  name: string;
  detail: string;
}

interface WslRun {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error?: string;
}

function main(): void {
  console.log(`WSL distro: ${distro}`);
  console.log('Scope: no downloads, no production integration, no cleanup of created temp fixture.');

  const capabilityRun = runWsl(capabilityScript(), 15_000);
  printRun('capability probe', capabilityRun);

  const timeoutRun = runWsl("timeout 1s bash -lc 'sleep 5'\n", 5_000);
  const timeoutCheck: Check =
    timeoutRun.status === 124
      ? { status: 'PASS', name: 'timeout_bounds_command', detail: 'GNU timeout stopped a long command' }
      : {
          status: 'FAIL',
          name: 'timeout_bounds_command',
          detail: `expected exit 124, got status=${String(timeoutRun.status)} signal=${String(timeoutRun.signal)}`,
        };

  const outputRun = runWsl("python3 - <<'PY'\nprint('x' * 20000)\nPY\n", 10_000);
  const rawOutputLength = outputRun.stdout.length;
  const capped = cap(outputRun.stdout, outputPreviewLimit);
  const outputCheck: Check =
    capped.length <= outputPreviewLimit + 80 && rawOutputLength > outputPreviewLimit
      ? {
          status: 'PASS',
          name: 'host_output_cap_preview',
          detail: `raw=${rawOutputLength} preview=${capped.length}`,
        }
      : {
          status: 'FAIL',
          name: 'host_output_cap_preview',
          detail: `raw=${rawOutputLength} preview=${capped.length}`,
        };

  const checks = [...parseChecks(capabilityRun.stdout), timeoutCheck, outputCheck];
  printSummary(checks);

  const failed = checks.filter((check) => check.status === 'FAIL');
  if (failed.length > 0) process.exitCode = 1;
}

function runWsl(script: string, timeoutMs: number): WslRun {
  const result = spawnSync('wsl.exe', ['-d', distro, '--', 'bash', '-s'], {
    input: toLf(script),
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });

  return {
    status: result.status,
    signal: result.signal,
    stdout: cleanOutput(result.stdout),
    stderr: cleanOutput(result.stderr),
    error: result.error instanceof Error ? result.error.message : undefined,
  };
}

function capabilityScript(): string {
  return String.raw`set -u
result() {
  status="$1"
  name="$2"
  shift 2
  detail="$*"
  printf 'RESULT\t%s\t%s\t%s\n' "$status" "$name" "$detail"
}

result INFO kernel "$(uname -a)"
result INFO user "$(id -un)"

if command -v unshare >/dev/null 2>&1; then
  result PASS tool_unshare "$(command -v unshare)"
else
  result FAIL tool_unshare missing
fi

if command -v python3 >/dev/null 2>&1; then
  result PASS tool_python3 "$(command -v python3)"
else
  result FAIL tool_python3 missing
fi

if test -r /proc/sys/user/max_user_namespaces; then
  max_user_namespaces="$(cat /proc/sys/user/max_user_namespaces)"
  if test "$max_user_namespaces" -gt 0 2>/dev/null; then
    result PASS user_namespaces "max=$max_user_namespaces"
  else
    result FAIL user_namespaces "max=$max_user_namespaces"
  fi
else
  result WARN user_namespaces unavailable
fi

if stat -fc %T /sys/fs/cgroup >/tmp/jarvis-cgroup-fs.txt 2>/dev/null; then
  cgroup_fs="$(cat /tmp/jarvis-cgroup-fs.txt)"
  if test "$cgroup_fs" = cgroup2fs; then
    result PASS cgroup_v2 "$cgroup_fs"
  else
    result WARN cgroup_v2 "$cgroup_fs"
  fi
else
  result WARN cgroup_v2 unavailable
fi

root="$(mktemp -d /tmp/jarvis-sandbox-smoke.XXXXXX)"
mkdir -p "$root/src" "$root/out" "$root/view/src"
printf 'fixture\n' > "$root/src/input.txt"
result INFO temp_fixture "$root"

if unshare -Urnm bash -s "$root" <<'INNER'
set -u
root="$1"
fail=0

result() {
  status="$1"
  name="$2"
  shift 2
  detail="$*"
  printf 'RESULT\t%s\t%s\t%s\n' "$status" "$name" "$detail"
}

mark_fail() {
  fail=1
  result FAIL "$1" "$2"
}

mount --make-rprivate / >/dev/null 2>&1 || true

if mount --bind "$root/src" "$root/view/src" >/dev/null 2>&1; then
  result PASS bind_source ok
else
  mark_fail bind_source "mount --bind failed"
fi

if mount -o remount,bind,ro "$root/view/src" >/dev/null 2>&1; then
  result PASS remount_source_readonly ok
else
  mark_fail remount_source_readonly "remount ro failed"
fi

if touch "$root/view/src/write-probe" >/dev/null 2>&1; then
  mark_fail readonly_source_write "write unexpectedly succeeded"
else
  result PASS readonly_source_write denied
fi

if touch "$root/out/write-ok" >/dev/null 2>&1; then
  result PASS writable_output ok
else
  mark_fail writable_output "write failed"
fi

if mount -t tmpfs tmpfs /mnt >/dev/null 2>&1; then
  if test -e /mnt/c || test -e /mnt/h; then
    mark_fail hide_windows_mounts "windows mounts still visible"
  else
    result PASS hide_windows_mounts hidden
  fi
else
  mark_fail hide_windows_mounts "tmpfs over /mnt failed"
fi

if mount -t tmpfs tmpfs /home >/dev/null 2>&1; then
  if test -e "$HOME"; then
    mark_fail hide_home "home still visible at $HOME"
  else
    result PASS hide_home hidden
  fi
else
  mark_fail hide_home "tmpfs over /home failed"
fi

python3 - <<'PY'
import socket

sock = socket.socket()
sock.settimeout(1)
try:
    sock.connect(("1.1.1.1", 53))
except OSError as exc:
    print(f"RESULT\tPASS\tnetwork_blocked\t{exc.__class__.__name__}")
else:
    print("RESULT\tFAIL\tnetwork_blocked\tconnect unexpectedly succeeded")
finally:
    sock.close()
PY

exit "$fail"
INNER
then
  result PASS unshare_sandbox_probe completed
else
  result FAIL unshare_sandbox_probe "unshare/mount/network probe failed"
fi
`;
}

function parseChecks(text: string): Check[] {
  const checks: Check[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('RESULT\t')) continue;
    const [, rawStatus, name, ...detailParts] = line.split('\t');
    if (!isCheckStatus(rawStatus) || name === undefined) continue;
    checks.push({ status: rawStatus, name, detail: detailParts.join('\t') });
  }
  return checks;
}

function isCheckStatus(value: string | undefined): value is CheckStatus {
  return value === 'PASS' || value === 'FAIL' || value === 'WARN' || value === 'INFO';
}

function printRun(label: string, run: WslRun): void {
  console.log(`\n=== ${label} ===`);
  console.log(`status=${String(run.status)} signal=${String(run.signal)}${run.error ? ` error=${run.error}` : ''}`);
  if (run.stdout.trim() !== '') console.log(cap(run.stdout, outputPreviewLimit));
  if (run.stderr.trim() !== '') console.error(cap(run.stderr, outputPreviewLimit));
}

function printSummary(checks: Check[]): void {
  console.log('\n=== summary ===');
  for (const check of checks) {
    console.log(`${check.status.padEnd(4)} ${check.name} ${check.detail}`);
  }

  const counts = checks.reduce(
    (acc, check) => {
      acc[check.status] += 1;
      return acc;
    },
    { PASS: 0, FAIL: 0, WARN: 0, INFO: 0 } satisfies Record<CheckStatus, number>,
  );
  console.log(`\nPASS=${counts.PASS} FAIL=${counts.FAIL} WARN=${counts.WARN} INFO=${counts.INFO}`);
}

function cap(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[output capped: ${text.length - limit} chars omitted]`;
}

function cleanOutput(value: string | Buffer | null | undefined): string {
  const text = typeof value === 'string' ? value : value?.toString('utf8') ?? '';
  return text.replace(/\0/g, '').replace(/\r\n/g, '\n');
}

function toLf(script: string): string {
  return script.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

main();
