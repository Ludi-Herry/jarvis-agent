export interface LoopFinalizeCliArgs {
  loopId: string;
  worktreeRootPath?: string;
}

export function parseLoopFinalizeArgs(argv: string[]): LoopFinalizeCliArgs {
  let loopId: string | undefined;
  let worktreeRootPath: string | undefined;

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
    if (arg === '--merge' || arg === '--cleanup') {
      throw new Error('loop finalize is report-only in this slice; merge/cleanup are not implemented');
    }
    if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    throw new Error(`unexpected positional argument: ${arg}`);
  }

  if (loopId === undefined) throw new Error('Usage: npm run loop:finalize -- --loop <id>');
  return worktreeRootPath === undefined ? { loopId } : { loopId, worktreeRootPath };
}
