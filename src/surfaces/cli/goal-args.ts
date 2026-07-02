export interface GoalCliArgs {
  objective: string;
  failOnWorktreeChange: boolean;
}

export function parseGoalArgs(argv: string[]): GoalCliArgs {
  const parts: string[] = [];
  let failOnWorktreeChange = false;

  for (const arg of argv) {
    if (arg === '--fail-on-worktree-change') {
      failOnWorktreeChange = true;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    parts.push(arg);
  }

  return { objective: parts.join(' ').trim(), failOnWorktreeChange };
}
