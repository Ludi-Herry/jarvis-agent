export interface CronDaemonCliArgs {
  cronMapPath: string;
  pollMs: number;
}

const DEFAULT_POLL_MS = 60_000;
const MIN_POLL_MS = 10_000;
const MAX_POLL_MS = 3_600_000;

export function parseCronDaemonArgs(argv: string[]): CronDaemonCliArgs {
  let cronMapPath: string | undefined;
  let pollMs = DEFAULT_POLL_MS;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cron-map') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--') || value.trim() === '') throw new Error('--cron-map requires a path');
      cronMapPath = value;
      continue;
    }
    if (arg === '--poll-ms') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--') || value.trim() === '') throw new Error('--poll-ms requires a value');
      pollMs = parsePollMs(value);
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    throw new Error(`unexpected positional argument: ${arg}`);
  }

  if (cronMapPath === undefined) throw new Error('Usage: npm run cron:daemon -- --cron-map <trusted-json>');
  return { cronMapPath, pollMs };
}

function parsePollMs(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_POLL_MS || parsed > MAX_POLL_MS) {
    throw new Error(`--poll-ms must be an integer from ${MIN_POLL_MS} to ${MAX_POLL_MS}`);
  }
  return parsed;
}
