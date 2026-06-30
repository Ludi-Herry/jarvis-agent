/**
 * surfaces/cli/shadow-cli — view / roll back the shadow-git history (Phase E shadow-git).
 *
 * A goal run with JARVIS_SHADOW_GIT=1 snapshots the working tree to data/shadow each round. This CLI
 * lets the operator read that history and restore the working tree to a snapshot.
 *
 * Run:  npm run shadow -- log [N]        (list the most recent N snapshots, default 50)
 *       npm run shadow -- restore <sha>  (OVERWRITE the working tree's tracked files with that snapshot)
 */
import { join } from 'node:path';
import { defaultShellPath } from '../../core/index.js';
import { ShadowGit } from '../../capabilities/index.js';

async function main(): Promise<void> {
  const [sub, arg] = process.argv.slice(2);
  const cwd = process.cwd();
  const shadow = new ShadowGit({ shellPath: defaultShellPath(), cwd, gitDir: join(cwd, 'data', 'shadow') });

  if (sub === 'log') {
    const limit = arg ? Math.max(1, Number.parseInt(arg, 10) || 50) : 50;
    const lines = await shadow.log(limit);
    if (lines.length === 0) {
      console.log('(没有快照 —— 用 JARVIS_SHADOW_GIT=1 npm run goal -- "<目标>" 跑一次自主任务即会逐轮快照)');
      return;
    }
    for (const line of lines) console.log(line);
    return;
  }

  if (sub === 'restore') {
    if (!arg) {
      console.error('用法: npm run shadow -- restore <sha>');
      process.exitCode = 1;
      return;
    }
    if (arg.startsWith('-')) {
      // A ref starting with '-' would be read as a git option, not a revision — refuse it.
      console.error(`无效的快照引用: ${arg}`);
      process.exitCode = 1;
      return;
    }
    console.log(`⚠ 将用快照 ${arg} 覆盖工作树里被追踪的文件(你自己的改动若未提交会被覆盖)。`);
    const res = await shadow.restore(arg);
    if (res.ok) {
      console.log(`已把工作树恢复到 ${arg}。`);
    } else {
      console.error(`恢复失败: ${res.reason}`);
      process.exitCode = 1;
    }
    return;
  }

  console.error('用法: npm run shadow -- log [N] | restore <sha>');
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error('\n[shadow] fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
