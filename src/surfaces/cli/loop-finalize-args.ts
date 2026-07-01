export interface LoopFinalizeCliArgs {
  loopId: string;
  worktreeRootPath?: string;
  merge: boolean;
}

export function parseLoopFinalizeArgs(argv: string[]): LoopFinalizeCliArgs {
  let loopId: string | undefined;
  let worktreeRootPath: string | undefined;
  let merge = false;

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
      throw new Error('loop finalize cleanup is not implemented in this slice');
    }
    if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    throw new Error(`unexpected positional argument: ${arg}`);
  }

  if (loopId === undefined) throw new Error('Usage: npm run loop:finalize -- --loop <id>');
  return worktreeRootPath === undefined ? { loopId, merge } : { loopId, worktreeRootPath, merge };
}
