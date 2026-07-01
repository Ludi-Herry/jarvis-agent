export interface LoopFinalizeCliArgs {
  loopId: string;
  worktreeRootPath?: string;
  merge: boolean;
  cleanup: boolean;
}

export function parseLoopFinalizeArgs(argv: string[]): LoopFinalizeCliArgs {
  let loopId: string | undefined;
  let worktreeRootPath: string | undefined;
  let merge = false;
  let cleanup = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--loop') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--') || value.trim() === '') throw new Error('--loop requires an id');
      loopId = value;
      continue;
    }
    if (arg === '--worktree-root') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--') || value.trim() === '') throw new Error('--worktree-root requires a path');
      worktreeRootPath = value;
      continue;
    }
    if (arg === '--merge') {
      merge = true;
      continue;
    }
    if (arg === '--cleanup') {
      cleanup = true;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    throw new Error(`unexpected positional argument: ${arg}`);
  }

  if (loopId === undefined) throw new Error('Usage: npm run loop:finalize -- --loop <id>');
  if (merge && cleanup) throw new Error('cannot combine --merge and --cleanup in one invocation');
  return worktreeRootPath === undefined ? { loopId, merge, cleanup } : { loopId, worktreeRootPath, merge, cleanup };
}
