import type { LoopCronTask } from '../../capabilities/index.js';

export interface CronCliArgs {
  cronMapPath: string;
}

export function parseCronArgs(argv: string[]): CronCliArgs {
  let cronMapPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cron-map') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--') || value.trim() === '') throw new Error('--cron-map requires a path');
      cronMapPath = value;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    throw new Error(`unexpected positional argument: ${arg}`);
  }
  if (cronMapPath === undefined) throw new Error('Usage: npm run cron -- --cron-map <trusted-json>');
  return { cronMapPath };
}

export function buildLoopCronCommand(task: LoopCronTask): string {
  const parts = ['npm', 'run', 'loop', '--', shellQuote(task.objectivesFile)];
  if (task.unattended) parts.push('--unattended');
  if (task.verifierMapPath !== undefined) parts.push('--verifier-map', shellQuote(task.verifierMapPath));
  return parts.join(' ');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
