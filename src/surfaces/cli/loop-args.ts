export interface LoopCliArgs {
  resume: boolean;
  force: boolean;
  unattended: boolean;
  noVerifierMap: boolean;
  parallel: number;
  verifierMapPath?: string;
  hookMapPath?: string;
  sandboxCheckMapPath?: string;
  goalSetterRequirementsMapPath?: string;
  worktreeRootPath?: string;
  positional: string[];
}

const MAX_PARALLEL = 4;

export function parseLoopArgs(argv: string[]): LoopCliArgs {
  const parsed: LoopCliArgs = {
    resume: false,
    force: false,
    unattended: false,
    noVerifierMap: false,
    parallel: 1,
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
    if (arg === '--hook-map') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--') || value.trim() === '') {
        throw new Error('--hook-map requires a path');
      }
      parsed.hookMapPath = value;
      continue;
    }
    if (arg === '--sandbox-check-map') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--') || value.trim() === '') {
        throw new Error('--sandbox-check-map requires a path');
      }
      parsed.sandboxCheckMapPath = value;
      continue;
    }
    if (arg === '--goal-setter-requirements-map') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--') || value.trim() === '') {
        throw new Error('--goal-setter-requirements-map requires a path');
      }
      parsed.goalSetterRequirementsMapPath = value;
      continue;
    }
    if (arg === '--parallel') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error('--parallel requires a positive integer');
      parsed.parallel = parseParallel(value);
      continue;
    }
    if (arg === '--worktree-root') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--') || value.trim() === '') {
        throw new Error('--worktree-root requires a path');
      }
      parsed.worktreeRootPath = value;
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
  if (parsed.sandboxCheckMapPath !== undefined && parsed.goalSetterRequirementsMapPath !== undefined) {
    throw new Error('--sandbox-check-map and --goal-setter-requirements-map cannot be combined');
  }
  if (parsed.resume && parsed.parallel > 1 && parsed.worktreeRootPath === undefined) {
    throw new Error('--worktree-root is required for parallel resume');
  }

  return parsed;
}

function parseParallel(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error('--parallel requires a positive integer');
  const parsed = Number(value);
  if (parsed > MAX_PARALLEL) throw new Error(`--parallel must be at most ${MAX_PARALLEL}`);
  return parsed;
}
