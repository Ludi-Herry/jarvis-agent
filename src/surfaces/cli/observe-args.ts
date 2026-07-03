export interface ObserveCliArgs {
  format: 'text' | 'json';
  dataDir?: string;
}

export function parseObserveArgs(argv: string[]): ObserveCliArgs {
  const parsed: ObserveCliArgs = { format: 'text' };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      parsed.format = 'json';
      continue;
    }
    if (arg === '--data-dir') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--') || value.trim() === '') throw new Error('--data-dir requires a path');
      parsed.dataDir = value;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    throw new Error(`unexpected argument: ${arg}`);
  }

  return parsed;
}
