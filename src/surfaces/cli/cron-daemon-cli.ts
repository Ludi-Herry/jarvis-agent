import { readFile, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  FileLoopCronDaemonStore,
  FileLoopCronLock,
  FileLoopCronStore,
  createLoopCronDaemonSignalState,
  latestLoopPath,
  loadLoopCronConfig,
  loadLoopCronDaemonState,
  loadLoopCronState,
  runLoopCronDaemonOnce,
  sleepOrLoopCronDaemonSignal,
  type LoopCronTask,
} from '../../capabilities/index.js';
import { assertKeyNotInLaunchEnv, defaultShellPath, runCommand } from '../../core/index.js';
import { safeInline } from './approval.js';
import { buildLoopCronCommand } from './cron-args.js';
import { parseCronDaemonArgs } from './cron-daemon-args.js';

const LOOP_CRON_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const LOOP_CRON_LOCK_STALE_MS = LOOP_CRON_TIMEOUT_MS + 5 * 60 * 1000;
const LOOP_CRON_OUTPUT_LIMIT = 20_000;
const ARK_KEY_IN_LAUNCH_ENV = process.env.ARK_API_KEY !== undefined;

async function main(): Promise<void> {
  let args;
  try {
    args = parseCronDaemonArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  try {
    assertKeyNotInLaunchEnv(ARK_KEY_IN_LAUNCH_ENV);
  } catch (err) {
    console.error(`[cron:daemon] ${err instanceof Error ? err.message : String(err)}`);
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
    console.error(`[cron:daemon] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const cronDir = join(cwd, 'data', 'cron');
  const daemonLogPath = join(cronDir, 'loop-cron-daemon.jsonl');
  const daemonStore = new FileLoopCronDaemonStore(daemonLogPath);
  const daemonLock = await new FileLoopCronLock(join(cronDir, 'loop-cron-daemon.lock'), {
    staleMs: LOOP_CRON_LOCK_STALE_MS,
  }).tryAcquire();
  if (daemonLock === null) {
    console.error('[cron:daemon] daemon lock is held or unrecoverable; exiting');
    process.exitCode = 1;
    return;
  }

  const stop = createLoopCronDaemonSignalState();
  const shellPath = defaultShellPath();
  const cronLogPath = join(cronDir, 'loop-cron.jsonl');
  const scanLockPath = join(cronDir, 'loop-cron.lock');

  try {
    console.log(`Jarvis-Agent cron daemon - ${config.tasks.length} tasks from ${safeInline(config.path)} poll=${args.pollMs}ms`);
    await daemonStore.append({
      t: 'daemon-started',
      pid: process.pid,
      cronMapPath: config.path,
      pollMs: args.pollMs,
      startedAt: new Date().toISOString(),
    });

    while (!stop.requested) {
      await daemonLock.renew();
      await runDaemonScan({
        cwd,
        config,
        shellPath,
        cronLogPath,
        scanLockPath,
        daemonLogPath,
        daemonStore,
        shouldStop: () => stop.requested,
      });

      if (stop.requested) break;
      const nextWakeAt = new Date(Date.now() + args.pollMs).toISOString();
      await daemonStore.append({ t: 'daemon-heartbeat', at: new Date().toISOString(), nextWakeAt });
      console.log(`[cron:daemon] sleeping until ${safeInline(nextWakeAt)}`);
      await sleepOrLoopCronDaemonSignal(args.pollMs, stop);
    }

    await daemonStore.append({ t: 'daemon-stopped', reason: 'signal', at: new Date().toISOString() });
  } catch (err) {
    await daemonStore.append({ t: 'daemon-stopped', reason: 'error', at: new Date().toISOString() }).catch(() => undefined);
    console.error(`[cron:daemon] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    stop.dispose();
    await daemonLock.release();
  }
}

async function runDaemonScan(opts: {
  cwd: string;
  config: Awaited<ReturnType<typeof loadLoopCronConfig>>;
  shellPath: string;
  cronLogPath: string;
  scanLockPath: string;
  daemonLogPath: string;
  daemonStore: FileLoopCronDaemonStore;
  shouldStop: () => boolean;
}): Promise<void> {
  const scanLock = await new FileLoopCronLock(opts.scanLockPath, { staleMs: LOOP_CRON_LOCK_STALE_MS }).tryAcquire();
  if (scanLock === null) {
    await opts.daemonStore.append({ t: 'scan-skipped', reason: 'scan-lock-held', at: new Date().toISOString() });
    console.log('[cron:daemon] scan skipped: scan lock is held');
    return;
  }

  try {
    await opts.daemonStore.append({ t: 'scan-started', at: new Date().toISOString() });
    const cronStore = new FileLoopCronStore(opts.cronLogPath);
    const cronState = await loadLoopCronState(opts.cronLogPath);
    const daemonState = await loadLoopCronDaemonState(opts.daemonLogPath);
    const result = await runLoopCronDaemonOnce(opts.config, {
      cronStore,
      daemonStore: opts.daemonStore,
      cronState,
      daemonState,
      commandForTask: buildLoopCronCommand,
      beforeRunTask: async () => scanLock.renew(),
      shouldStop: opts.shouldStop,
      runTask: async (task) => runCronTask(task, opts.shellPath, opts.cwd),
    });
    await opts.daemonStore.append({ t: 'scan-finished', at: new Date().toISOString(), ...result });
    console.log(`cron daemon scan complete: triggered=${result.triggered} skipped=${result.skipped} parked=${result.parked}`);
  } finally {
    await scanLock.release();
  }
}

async function runCronTask(task: LoopCronTask, shellPath: string, cwd: string): Promise<{ exitCode: number | null; loopId?: string }> {
  const command = buildLoopCronCommand(task);
  console.log(`[cron:daemon] running ${safeInline(task.id)}: ${safeInline(command)}`);
  const before = await latestLoopPath(join(cwd, 'data', 'loops'));
  const res = await runCommand(shellPath, command, cwd, LOOP_CRON_TIMEOUT_MS, LOOP_CRON_OUTPUT_LIMIT);
  if (res.output.trim()) process.stdout.write(res.output);
  const after = await latestLoopPath(join(cwd, 'data', 'loops'));
  const loopId = after !== null && after !== before ? basename(after, '.jsonl') : undefined;
  if (res.code !== 0) {
    console.error(`[cron:daemon] task ${safeInline(task.id)} exited ${res.timedOut ? 'timeout' : String(res.code)}`);
  }
  return loopId === undefined ? { exitCode: res.code } : { exitCode: res.code, loopId };
}

main().catch((err: unknown) => {
  console.error('\n[cron:daemon] fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
