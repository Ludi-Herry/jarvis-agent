import { readFile, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createEmergencyStopSignal } from '../../runtime/index.js';
import {
  FileLoopCronLock,
  FileLoopCronStore,
  latestLoopPath,
  loadLoopCronConfig,
  loadLoopCronState,
  runLoopCronOnce,
  type LoopCronTask,
} from '../../capabilities/index.js';
import { assertKeyNotInLaunchEnv, defaultShellPath, runCommand } from '../../core/index.js';
import { safeInline } from './approval.js';
import { buildLoopCronCommand, parseCronArgs } from './cron-args.js';

const LOOP_CRON_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const LOOP_CRON_LOCK_STALE_MS = LOOP_CRON_TIMEOUT_MS + 5 * 60 * 1000;
const LOOP_CRON_OUTPUT_LIMIT = 20_000;
const ARK_KEY_IN_LAUNCH_ENV = process.env.ARK_API_KEY !== undefined;

async function main(): Promise<void> {
  let args;
  try {
    args = parseCronArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  try {
    assertKeyNotInLaunchEnv(ARK_KEY_IN_LAUNCH_ENV);
  } catch (err) {
    console.error(`[cron] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  let config;
  try {
    config = await loadLoopCronConfig({
      path: args.cronMapPath,
      cwd,
      readText: async (p) => readFile(p, 'utf8').catch(() => null),
      realpath: async (p) => realpath(p).catch(() => null),
    });
  } catch (err) {
    console.error(`[cron] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const cronLogPath = join(cwd, 'data', 'cron', 'loop-cron.jsonl');
  const lock = await new FileLoopCronLock(join(cwd, 'data', 'cron', 'loop-cron.lock'), {
    staleMs: LOOP_CRON_LOCK_STALE_MS,
  }).tryAcquire();
  if (lock === null) {
    console.error('[cron] cron scan lock is held or unrecoverable; skipped');
    process.exitCode = 1;
    return;
  }
  const store = new FileLoopCronStore(cronLogPath);
  const emergencyStop = createEmergencyStopSignal({
    cwd,
    onStop: (state) => {
      console.error(`\n[emergency-stop] ${safeInline(state.record?.reason ?? state.error ?? 'stop requested')}`);
    },
  });
  try {
    const state = await loadLoopCronState(cronLogPath);
    const shellPath = defaultShellPath();

    console.log(`Jarvis-Agent cron scan - ${config.tasks.length} tasks from ${safeInline(config.path)}`);
    const result = await runLoopCronOnce(config, {
      store,
      state,
      beforeRunTask: async () => lock.renew(),
      shouldStop: () => emergencyStop.signal.aborted,
      runTask: async (task) => runCronTask(task, shellPath, cwd, emergencyStop.signal),
    });
    console.log(`cron scan complete: triggered=${result.triggered} skipped=${result.skipped}`);
  } finally {
    emergencyStop.dispose();
    await lock.release();
  }
}

async function runCronTask(task: LoopCronTask, shellPath: string, cwd: string, signal?: AbortSignal): Promise<{ exitCode: number | null; loopId?: string }> {
  const command = buildLoopCronCommand(task);
  console.log(`[cron] running ${safeInline(task.id)}: ${safeInline(command)}`);
  const before = await latestLoopPath(join(cwd, 'data', 'loops'));
  const res = await runCommand(shellPath, command, cwd, LOOP_CRON_TIMEOUT_MS, LOOP_CRON_OUTPUT_LIMIT, signal);
  if (res.output.trim()) process.stdout.write(res.output);
  const after = await latestLoopPath(join(cwd, 'data', 'loops'));
  const loopId = after !== null && after !== before ? basename(after, '.jsonl') : undefined;
  if (res.code !== 0) {
    console.error(`[cron] task ${safeInline(task.id)} exited ${res.timedOut ? 'timeout' : String(res.code)}`);
  }
  return loopId === undefined ? { exitCode: res.code } : { exitCode: res.code, loopId };
}

main().catch((err: unknown) => {
  console.error('\n[cron] fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
