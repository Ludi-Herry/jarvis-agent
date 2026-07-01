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
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { defaultShellPath } from '../../core/index.js';
import { ShadowGit } from '../../capabilities/index.js';
import { parseApprovalChoice, renderApprovalRequest } from './approval.js';

export interface ShadowCliShadow {
  log(limit?: number): Promise<string[]>;
  restore(ref: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface ShadowCliDeps {
  argv?: string[];
  cwd?: string;
  shadow?: ShadowCliShadow;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  error?: NodeJS.WritableStream;
}

export async function runShadowCli(deps: ShadowCliDeps = {}): Promise<number> {
  const [sub, arg] = deps.argv ?? process.argv.slice(2);
  const cwd = deps.cwd ?? process.cwd();
  const shadow = deps.shadow ?? new ShadowGit({ shellPath: defaultShellPath(), cwd, gitDir: join(cwd, 'data', 'shadow') });
  const out = deps.output ?? process.stdout;
  const err = deps.error ?? process.stderr;
  const input = deps.input ?? process.stdin;

  if (sub === 'log') {
    const limit = arg ? Math.max(1, Number.parseInt(arg, 10) || 50) : 50;
    const lines = await shadow.log(limit);
    if (lines.length === 0) {
      out.write('(没有快照 —— 用 JARVIS_SHADOW_GIT=1 npm run goal -- "<目标>" 跑一次自主任务即会逐轮快照)\n');
      return 0;
    }
    for (const line of lines) out.write(`${line}\n`);
    return 0;
  }

  if (sub === 'restore') {
    if (!arg) {
      err.write('用法: npm run shadow -- restore <sha>\n');
      return 1;
    }
    if (arg.startsWith('-')) {
      // A ref starting with '-' would be read as a git option, not a revision — refuse it.
      err.write(`无效的快照引用: ${arg}\n`);
      return 1;
    }
    out.write(
      renderApprovalRequest(
        {
          toolName: 'shadow-restore',
          capability: 'writes-files',
          args: { ref: arg, cwd, effect: 'overwrite tracked working-tree files with this shadow snapshot' },
          reason: 'restore 会覆盖工作树里被 shadow 追踪的文件',
        },
        { sessionAllowed: false },
      ),
    );
    const answer = await readOneLine(input);
    if (parseApprovalChoice(answer ?? '') !== 'allow-once') {
      err.write('已取消 shadow restore（未收到明确允许）。\n');
      return 1;
    }
    const res = await shadow.restore(arg);
    if (res.ok) {
      out.write(`已把工作树恢复到 ${arg}。\n`);
      return 0;
    } else {
      err.write(`恢复失败: ${res.reason}\n`);
      return 1;
    }
  }

  err.write('用法: npm run shadow -- log [N] | restore <sha>\n');
  return 1;
}

async function readOneLine(input: NodeJS.ReadableStream): Promise<string | null> {
  const rl = createInterface({ input });
  try {
    for await (const line of rl) return line;
    return null;
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  process.exitCode = await runShadowCli();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error('\n[shadow] fatal:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
