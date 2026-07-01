export interface LoopCliArgs {
  resume: boolean;
  force: boolean;
  unattended: boolean;
  noVerifierMap: boolean;
  verifierMapPath?: string;
  positional: string[];
}

export function parseLoopArgs(argv: string[]): LoopCliArgs {
  const parsed: LoopCliArgs = {
    resume: false,
    force: false,
    unattended: false,
    noVerifierMap: false,
    positional: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--resume') {
      parsed.resume = true;
      continue;
    }
    if (arg === '--force') {
      parsed.force = true;
      continue;
    }
    if (arg === '--unattended') {
      parsed.unattended = true;
      continue;
    }
    if (arg === '--verifier-map') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--') || value.trim() === '') {
        throw new Error('--verifier-map requires a path');
      }
      parsed.verifierMapPath = value;
      continue;
    }
    if (arg === '--no-verifier-map') {
      parsed.noVerifierMap = true;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    parsed.positional.push(arg);
  }

  if (parsed.verifierMapPath !== undefined && parsed.noVerifierMap) {
    throw new Error('--verifier-map and --no-verifier-map cannot be combined');
  }

  return parsed;
}
