/**
 * The three A-phase built-in tools: read / write / grep.
 *
 * Each is a plain {@link ToolDefinition} — a zod input schema plus a `run` side effect.
 * Relative paths resolve against `ctx.cwd` (the project root the loop injects); this is
 * the anchor every file tool needs, NOT a permission boundary. Per the green-lit A-phase
 * decision these run "bare" — no sandbox, no path confinement. The PermissionGate / sandbox
 * lands with Bash in phase B (tools/types.ts, plan §3.3).
 *
 * Expected, recoverable failures (missing file, unwritable path) come back as a
 * ToolRunResult with `error` set so the model gets a clean, actionable message instead of
 * a stack trace. The registry separately catches anything UNexpected that throws.
 */
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, resolve, relative, join } from 'node:path';
import { z } from 'zod';
import { isSensitivePath } from '../../runtime/permission/index.js';
import type { ToolDefinition } from './types.js';

/** Cap grep output so a broad pattern over a big tree can't blow up the context window. */
const GREP_MAX_MATCHES = 200;
/** Directories never worth walking for a code grep. */
const GREP_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);

export const readTool: ToolDefinition<{ path: string }> = {
  name: 'read',
  description: 'Read a UTF-8 text file and return its full contents. Path is relative to the project root.',
  capability: 'read-only',
  inputSchema: z.object({
    path: z.string().describe('File path to read, relative to the project root.'),
  }),
  run: async ({ path }, ctx) => {
    const abs = resolve(ctx.cwd, path);
    try {
      const content = await readFile(abs, 'utf8');
      return { content };
    } catch (err) {
      return { content: '', error: `Cannot read ${path}: ${message(err)}` };
    }
  },
};

export const writeTool: ToolDefinition<{ path: string; content: string }> = {
  name: 'write',
  description:
    'Write (overwrite) a UTF-8 text file, creating parent directories as needed. Path is relative to the project root.',
  capability: 'writes-files',
  inputSchema: z.object({
    path: z.string().describe('File path to write, relative to the project root.'),
    content: z.string().describe('Full file contents to write.'),
  }),
  run: async ({ path, content }, ctx) => {
    const abs = resolve(ctx.cwd, path);
    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
      return { content: `Wrote ${content.length} chars to ${path}` };
    } catch (err) {
      return { content: '', error: `Cannot write ${path}: ${message(err)}` };
    }
  },
};

export const grepTool: ToolDefinition<{ pattern: string; path?: string }> = {
  name: 'grep',
  description:
    'Search files for a JavaScript regular expression and return matching lines as "path:line:text". Searches a single file or recursively under a directory (default: project root).',
  capability: 'read-only',
  inputSchema: z.object({
    pattern: z.string().describe('A JavaScript regular expression to match against each line.'),
    path: z
      .string()
      .optional()
      .describe('File or directory to search, relative to the project root. Defaults to the root.'),
  }),
  run: async ({ pattern, path }, ctx) => {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (err) {
      return { content: '', error: `Invalid regular expression: ${message(err)}` };
    }

    const root = resolve(ctx.cwd, path ?? '.');
    const matches: string[] = [];
    let truncated = false;

    try {
      const files = await collectFiles(root);
      for (const file of files) {
        if (matches.length >= GREP_MAX_MATCHES) {
          truncated = true;
          break;
        }
        const text = await readFile(file, 'utf8').catch(() => null);
        if (text === null) continue; // unreadable/binary — skip, don't fail the whole grep
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            const rel = relative(ctx.cwd, file).replace(/\\/g, '/');
            matches.push(`${rel}:${i + 1}:${lines[i]}`);
            if (matches.length >= GREP_MAX_MATCHES) {
              truncated = true;
              break;
            }
          }
        }
      }
    } catch (err) {
      return { content: '', error: `Cannot search ${path ?? '.'}: ${message(err)}` };
    }

    if (matches.length === 0) {
      return { content: `No matches for /${pattern}/ under ${path ?? '.'}` };
    }
    const header = truncated ? `(showing first ${GREP_MAX_MATCHES} matches)\n` : '';
    return { content: header + matches.join('\n') };
  },
};

/** Recursively collect readable file paths under `root`, skipping noise directories. If
 *  `root` is itself a file, return just it. */
async function collectFiles(root: string): Promise<string[]> {
  const info = await stat(root);
  // grep is read-only and recurses on its own, so the PermissionGate (which only sees the call's
  // path arg) can't protect a secret reached by traversal — grep must skip secrets itself, reusing
  // the same policy as the gate. Otherwise `grep {pattern:"KEY"}` with no path would leak .env.
  if (info.isFile()) return isSensitivePath(root) ? [] : [root];

  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (isSensitivePath(full)) continue; // never read a secret file or descend into a secret dir
    if (entry.isDirectory()) {
      if (GREP_SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await collectFiles(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
