/**
 * The three A-phase built-in tools: read / write / grep.
 *
 * Each is a plain {@link ToolDefinition} — a zod input schema plus a `run` side effect.
 * Paths resolve against `ctx.cwd` (the project root the loop injects) and are confined to it:
 * read/write/grep go through {@link safeResolve}, which rejects paths that escape cwd or resolve
 * (following symlinks) to a sensitive file — the file-tool analogue of bash's confined cwd. The
 * PermissionGate still gates each call by capability (read=allow, write=ask); this confinement is
 * the execution-layer backstop for what the gate, seeing only the literal path arg, can't catch.
 *
 * Expected, recoverable failures (missing file, unwritable path) come back as a
 * ToolRunResult with `error` set so the model gets a clean, actionable message instead of
 * a stack trace. The registry separately catches anything UNexpected that throws.
 */
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, relative, join } from 'node:path';
import { z } from 'zod';
import { isSensitivePath } from '../../runtime/permission/index.js';
import { safeResolve } from './safe-path.js';
import type { ToolDefinition } from './types.js';

/** Cap grep output so a broad pattern over a big tree can't blow up the context window. */
const GREP_MAX_MATCHES = 200;
/** Skip files larger than this (bytes): one huge or binary blob shouldn't be slurped into memory. */
const GREP_MAX_FILE_BYTES = 2_000_000;
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
    const safe = await safeResolve(ctx.cwd, path);
    if (!safe.ok) return { content: '', error: `Cannot read ${path}: ${safe.reason}` };
    try {
      const content = await readFile(safe.abs, 'utf8');
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
    const safe = await safeResolve(ctx.cwd, path);
    if (!safe.ok) return { content: '', error: `Cannot write ${path}: ${safe.reason}` };
    try {
      await mkdir(dirname(safe.abs), { recursive: true });
      await writeFile(safe.abs, content, 'utf8');
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

    const safe = await safeResolve(ctx.cwd, path ?? '.');
    if (!safe.ok) return { content: '', error: `Cannot search ${path ?? '.'}: ${safe.reason}` };

    const state: GrepState = {
      regex,
      cwd: ctx.cwd,
      signal: ctx.signal,
      matches: [],
      truncated: false,
      aborted: false,
      skippedLarge: 0,
    };
    try {
      await searchPath(safe.abs, state);
    } catch (err) {
      return { content: '', error: `Cannot search ${path ?? '.'}: ${message(err)}` };
    }
    if (ctx.signal?.aborted) state.aborted = true; // searchPath may have bailed before setting it

    const notes: string[] = [];
    if (state.aborted) notes.push('[aborted]');
    if (state.truncated) notes.push(`(showing first ${GREP_MAX_MATCHES} matches)`);
    if (state.skippedLarge > 0) {
      notes.push(`[skipped ${state.skippedLarge} file(s) over ${GREP_MAX_FILE_BYTES} bytes]`);
    }
    if (state.matches.length === 0) {
      return { content: notes.length > 0 ? notes.join(' ') : `No matches for /${pattern}/ under ${path ?? '.'}` };
    }
    const header = notes.length > 0 ? `${notes.join(' ')}\n` : '';
    return { content: header + state.matches.join('\n') };
  },
};

/** Mutable accumulator threaded through the streaming search, so traversal and matching share one
 *  state without buffering a full file list first. */
interface GrepState {
  regex: RegExp;
  cwd: string;
  signal?: AbortSignal;
  matches: string[];
  truncated: boolean; // hit GREP_MAX_MATCHES — stop searching
  aborted: boolean; // the turn's signal fired mid-search
  skippedLarge: number; // files skipped for exceeding GREP_MAX_FILE_BYTES
}

/** Walk `target` (a file or a directory) matching AS WE GO — no full file list is collected first,
 *  so a huge tree streams instead of buffering. Stops early on abort or once the match cap is hit.
 *  grep is read-only and recurses on its own, so the PermissionGate (which only sees the call's path
 *  arg) can't guard a secret reached by traversal — so we skip secret paths here, reusing the gate's
 *  policy; otherwise `grep {pattern:"KEY"}` with no path would leak .env. */
async function searchPath(target: string, state: GrepState): Promise<void> {
  if (state.truncated || state.aborted) return;
  if (state.signal?.aborted) {
    state.aborted = true;
    return;
  }

  const info = await stat(target);
  if (info.isFile()) {
    if (!isSensitivePath(target)) await searchFile(target, info.size, state);
    return;
  }

  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    if (state.truncated || state.aborted) return;
    if (state.signal?.aborted) {
      state.aborted = true;
      return;
    }
    const full = join(target, entry.name);
    if (isSensitivePath(full)) continue; // never read a secret file or descend into a secret dir
    if (entry.isDirectory()) {
      if (GREP_SKIP_DIRS.has(entry.name)) continue;
      await searchPath(full, state);
    } else if (entry.isFile()) {
      await searchFile(full, undefined, state); // dir entries carry no size — searchFile stats it
    }
  }
}

/** Match one file's lines into `state`, skipping it if it's too big to slurp safely. `knownSize`
 *  is the size the caller already stat'd (the root file); a directory entry passes undefined and we
 *  stat here. Checks the abort signal mid-file so even one large file stays interruptible. */
async function searchFile(file: string, knownSize: number | undefined, state: GrepState): Promise<void> {
  let size = knownSize;
  if (size === undefined) {
    const st = await stat(file).catch(() => null);
    if (st === null) return; // vanished/unreadable — skip, don't fail the whole grep
    size = st.size;
  }
  if (size > GREP_MAX_FILE_BYTES) {
    state.skippedLarge++; // too big to slurp into memory — skip and report the count
    return;
  }

  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) return; // binary/unreadable — skip, don't fail the whole grep
  const lines = text.split('\n');
  const rel = relative(state.cwd, file).replace(/\\/g, '/');
  for (let i = 0; i < lines.length; i++) {
    if (state.signal?.aborted) {
      state.aborted = true; // interruptible even partway through a single large file
      return;
    }
    if (state.regex.test(lines[i])) {
      state.matches.push(`${rel}:${i + 1}:${lines[i]}`);
      if (state.matches.length >= GREP_MAX_MATCHES) {
        state.truncated = true;
        return;
      }
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
