export function assertParallelHooksCompatible(parallelMode: boolean, hooksEnabled: boolean): void {
  if (parallelMode && hooksEnabled) {
    throw new Error(
      '--parallel cannot run with hooks configured yet; hook cwd would not match per-goal worktrees. Run serial or disable hooks.',
    );
  }
}
