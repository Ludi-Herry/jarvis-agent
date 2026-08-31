/**
 * The four A-phase built-in tools: read / write / edit / grep.
 *
 * Each is a plain {@link ToolDefinition} — a zod input schema plus a `run` side effect.
 * Paths resolve against `ctx.cwd` (the project root the loop injects) and are confined to it:
 * read/write/edit/grep go through {@link safeResolve}, which rejects paths that escape cwd or resolve
 * (following symlinks) to a sensitive file — the file-tool analogue of bash's confined cwd. The
 * PermissionGate still gates each call by capability (read=allow, write=ask); this confinement is
 * the execution-layer backstop for what the gate, seeing only the literal path arg, can't catch.
 *
 * Expected, recoverable failures (missing file, unwritable path) come back as a
 * ToolRunResult with `error` set so the model gets a clean, actionable message instead of
 * a stack trace. The registry separately catches anything UNexpected that throws.
 */
import { open, readFile, lstat, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, relative, join } from 'node:path';
import { z } from 'zod';
import { isGitMetadataPath, isSensitivePath } from '../../runtime/permission/index.js';
import { fileVersion, isFileVersion } from './file-version.js';
import { safeResolve } from './safe-path.js';
import type { ToolDefinition } from './types.js';

/** Cap grep output so a broad pattern over a big tree can't blow up the context window. */
const GREP_MAX_MATCHES = 200;
/** A ranged read stays small enough to be useful after grep without becoming another full-file read. */
const READ_MAX_LINES = 1_000;
/** Skip files larger than this (bytes): one huge or binary blob shouldn't be slurped into memory. */
const GREP_MAX_FILE_BYTES = 2_000_000;
/** Directories never worth walking for a code grep. */
const GREP_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);

const readInputSchema = z.object({
  path: z.string().describe('File path to read, relative to the project root.'),
  startLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('First 1-based line to return. Provide together with maxLines for a ranged read.'),
  maxLines: z
    .number()
    .int()
    .min(1)
    .max(READ_MAX_LINES)
    .optional()
    .describe(`Maximum lines to return (1-${READ_MAX_LINES}). Provide together with startLine.`),
}).superRefine((input, ctx) => {
  if ((input.startLine === undefined) !== (input.maxLines === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'startLine and maxLines must be provided together',
    });
  }
});

type ReadInput = z.infer<typeof readInputSchema>;

export const readTool: ToolDefinition<ReadInput> = {
  name: 'read',
  description:
    'Read a UTF-8 text file and return an opaque full-file version. Default: return the full contents. ' +
    'For a large file, use grep first, then pass startLine and maxLines to return a bounded range with a continuation hint. ' +
    'Pass that version as edit.expectedVersion for a local change or write.expectedVersion for a full replacement.',
  capability: 'read-only',
  inputSchema: readInputSchema,
  run: async ({ path, startLine, maxLines }, ctx) => {
    if ((startLine === undefined) !== (maxLines === undefined)) {
      return { content: '', error: `Cannot read ${path}: startLine and maxLines must be provided together` };
    }
    const safe = await safeResolve(ctx.cwd, path);
    if (!safe.ok) return { content: '', error: `Cannot read ${path}: ${safe.reason}` };
    try {
      const bytes = await readFile(safe.abs);
      const text = bytes.toString('utf8');
      if (startLine !== undefined && maxLines !== undefined) {
        const range = readLineRange(text, startLine, maxLines);
        if (!range.ok) return { content: '', error: `Cannot read ${path}: ${range.reason}` };
        return {
          content: range.content,
          fileReceipt: { kind: 'read', path, version: fileVersion(bytes) },
        };
      }
      return {
        content: text,
        fileReceipt: { kind: 'read', path, version: fileVersion(bytes) },
      };
    } catch (err) {
      return { content: '', error: `Cannot read ${path}: ${message(err)}` };
    }
  },
};

function readLineRange(
  text: string,
  startLine: number,
  maxLines: number,
): { ok: true; content: string } | { ok: false; reason: string } {
  const lines = text === ''
    ? []
    : (text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu) ?? []).filter((line) => line !== '');
  if (startLine > lines.length) {
    if (lines.length === 0 && startLine === 1) {
      return { ok: true, content: '[lines 0 of 0]\n[end of file]' };
    }
    return {
      ok: false,
      reason: `startLine ${startLine} is past the end of the file (${lines.length} lines)`,
    };
  }

  const selected = lines.slice(startLine - 1, startLine - 1 + maxLines);
  const endLine = startLine + selected.length - 1;
  const body = selected.join('');
  const separator = /[\r\n]$/u.test(body) ? '' : '\n';
  const tail = endLine < lines.length
    ? `[next: startLine=${endLine + 1}, maxLines=${maxLines}]`
    : '[end of file]';
  return {
    ok: true,
    content: `[lines ${startLine}-${endLine} of ${lines.length}]\n${body}${separator}${tail}`,
  };
}

const writeInputSchema = z.object({
  path: z.string().describe('File path to write, relative to the project root.'),
  content: z.string().describe('Full UTF-8 file contents to write.'),
  expectedVersion: z
    .string()
    .refine(isFileVersion, 'expectedVersion must be an fv1 token returned by read')
    .optional()
    .describe('Required when replacing an existing file; use the exact version returned by read.'),
  createOnly: z
    .literal(true)
    .optional()
    .describe('Required when creating a new file; fails if the target already exists.'),
}).superRefine((input, ctx) => {
  const count = (input.expectedVersion === undefined ? 0 : 1) + (input.createOnly === true ? 1 : 0);
  if (count !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'provide exactly one write precondition: expectedVersion or createOnly:true',
    });
  }
});

type WriteInput = z.infer<typeof writeInputSchema>;

export const writeTool: ToolDefinition<WriteInput> = {
  name: 'write',
  description:
    'Create or replace a UTF-8 text file with an explicit concurrency precondition. ' +
    'Use createOnly:true for a new path, or read first and pass expectedVersion for an existing file. ' +
    'A successful result returns postVersion.',
  capability: 'writes-files',
  inputSchema: writeInputSchema,
  run: async ({ path, content, expectedVersion, createOnly }, ctx) => {
    const precondition = createOnly === true ? 'createOnly' : 'expectedVersion';
    if ((createOnly === true) === (expectedVersion !== undefined)) {
      return {
        content: '',
        error: `Cannot write ${path}: provide exactly one precondition (expectedVersion or createOnly:true)`,
        fileReceipt: { kind: 'write', path, precondition, outcome: 'conflict' },
      };
    }
    const safe = await safeResolve(ctx.cwd, path);
    if (!safe.ok) return { content: '', error: `Cannot write ${path}: ${safe.reason}` };
    if (isGitMetadataPath(ctx.cwd, safe.abs)) {
      return { content: '', error: `Cannot write ${path}: refusing to mutate git metadata` };
    }
    return withWriteLock(safe.abs, async () => {
      if (createOnly === true) return createFile(path, safe.abs, content, ctx.cwd);
      return replaceFile(path, safe.abs, content, expectedVersion as string, ctx.cwd);
    });
  },
};

const editInputSchema = z.object({
  path: z.string().describe('Existing UTF-8 file path to edit, relative to the project root.'),
  oldText: z.string().min(1).describe('Exact existing text to replace; it must occur exactly once.'),
  newText: z.string().describe('Replacement text. Only the unique oldText match is changed.'),
  expectedVersion: z
    .string()
    .refine(isFileVersion, 'expectedVersion must be an fv1 token returned by read')
    .describe('Exact version returned by read; stale versions fail without changing the file.'),
}).superRefine((input, ctx) => {
  if (input.oldText === input.newText) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'oldText and newText must differ',
    });
  }
});

type EditInput = z.infer<typeof editInputSchema>;

export const editTool: ToolDefinition<EditInput> = {
  name: 'edit',
  description:
    'Make one bounded change to an existing UTF-8 file without resending the full file. ' +
    'Read first, then pass the returned expectedVersion plus an oldText that occurs exactly once. ' +
    'The edit reuses write confinement, concurrency checks, atomic replacement, and post-write verification.',
  capability: 'writes-files',
  inputSchema: editInputSchema,
  run: async ({ path, oldText, newText, expectedVersion }, ctx) => {
    const receipt = { kind: 'write' as const, path, precondition: 'expectedVersion' as const, expectedVersion };
    const safe = await safeResolve(ctx.cwd, path);
    if (!safe.ok) return { content: '', error: `Cannot edit ${path}: ${safe.reason}` };
    if (isGitMetadataPath(ctx.cwd, safe.abs)) {
      return { content: '', error: `Cannot edit ${path}: refusing to mutate git metadata` };
    }
    return withWriteLock(safe.abs, async () => {
      let bytes: Buffer;
      try {
        bytes = await readFile(safe.abs);
      } catch (err) {
        const outcome = errorCode(err) === 'ENOENT' ? 'conflict' as const : 'unknown' as const;
        return {
          content: '',
          error: outcome === 'conflict'
            ? `Cannot edit ${path}: target does not exist`
            : `Cannot read current version of ${path}: ${message(err)}`,
          fileReceipt: { ...receipt, outcome },
        };
      }

      const preVersion = fileVersion(bytes);
      if (preVersion !== expectedVersion) {
        return {
          content: '',
          error: `Write conflict for ${path}: expected ${expectedVersion}, current version is ${preVersion}; read again before retrying`,
          fileReceipt: { ...receipt, outcome: 'conflict' as const, preVersion },
        };
      }

      const content = bytes.toString('utf8');
      const first = content.indexOf(oldText);
      const second = first < 0 ? -1 : content.indexOf(oldText, first + 1);
      if (first < 0 || second >= 0) {
        return {
          content: '',
          error: `Cannot edit ${path}: oldText must occur exactly once`,
          fileReceipt: { ...receipt, outcome: 'conflict' as const, preVersion },
        };
      }

      const updated = content.slice(0, first) + newText + content.slice(first + oldText.length);
      const result = await replaceFile(path, safe.abs, updated, expectedVersion, ctx.cwd);
      if (result.error !== undefined) return result;
      return {
        ...result,
        content: `Edited ${path} (${oldText.length} chars replaced with ${newText.length}); ${result.content}`,
      };
    });
  },
};

const writeLocks = new Map<string, Promise<void>>();

/** Serialize writes made by this process to the same path. External processes remain outside this lock. */
async function withWriteLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? path.toLowerCase() : path;
  const previous = writeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  writeLocks.set(key, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (writeLocks.get(key) === queued) writeLocks.delete(key);
  }
}

async function createFile(path: string, abs: string, content: string, cwd: string) {
  const receipt = { kind: 'write' as const, path, precondition: 'createOnly' as const };
  try {
    await mkdir(dirname(abs), { recursive: true });
    const checked = await safeResolve(cwd, path);
    if (!checked.ok || checked.abs !== abs) {
      return {
        content: '',
        error: `Cannot write ${path}: ${checked.ok ? 'resolved target changed during write' : checked.reason}`,
        fileReceipt: { ...receipt, outcome: 'unknown' as const },
      };
    }
    const handle = await open(abs, 'wx');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    const postVersion = fileVersion(await readFile(abs));
    const intendedVersion = fileVersion(Buffer.from(content, 'utf8'));
    if (postVersion !== intendedVersion) {
      return {
        content: '',
        error: `Cannot confirm write ${path}: file changed during post-write verification`,
        fileReceipt: { ...receipt, outcome: 'unknown' as const, postVersion },
      };
    }
    return {
      content: `Created ${path} (${content.length} chars); postVersion=${postVersion}`,
      fileReceipt: { ...receipt, outcome: 'applied' as const, postVersion },
    };
  } catch (err) {
    const outcome = errorCode(err) === 'EEXIST' ? 'conflict' as const : 'unknown' as const;
    return {
      content: '',
      error: outcome === 'conflict'
        ? `Cannot create ${path}: target already exists; read it and retry with expectedVersion`
        : `Cannot write ${path}: ${message(err)}`,
      fileReceipt: { ...receipt, outcome },
    };
  }
}

async function replaceFile(path: string, abs: string, content: string, expectedVersion: string, cwd: string) {
  const receipt = { kind: 'write' as const, path, precondition: 'expectedVersion' as const, expectedVersion };
  let preVersion: string;
  let originalMode: number;
  try {
    const [bytes, info, leaf] = await Promise.all([readFile(abs), stat(abs), lstat(abs)]);
    if (leaf.isSymbolicLink()) {
      return {
        content: '',
        error: `Cannot replace ${path}: the target is a symbolic link; write the real project path explicitly`,
        fileReceipt: { ...receipt, outcome: 'conflict' as const },
      };
    }
    if (info.nlink > 1) {
      return {
        content: '',
        error: `Cannot replace ${path}: the target has multiple hard links; write an independent project path`,
        fileReceipt: { ...receipt, outcome: 'conflict' as const },
      };
    }
    preVersion = fileVersion(bytes);
    originalMode = info.mode;
  } catch (err) {
    const outcome = errorCode(err) === 'ENOENT' ? 'conflict' as const : 'unknown' as const;
    return {
      content: '',
      error: outcome === 'conflict'
        ? `Cannot replace ${path}: target does not exist; retry with createOnly:true`
        : `Cannot read current version of ${path}: ${message(err)}`,
      fileReceipt: { ...receipt, outcome },
    };
  }
  if (preVersion !== expectedVersion) {
    return {
      content: '',
      error: `Write conflict for ${path}: expected ${expectedVersion}, current version is ${preVersion}; read again before retrying`,
      fileReceipt: { ...receipt, outcome: 'conflict' as const, preVersion },
    };
  }

  const temp = join(dirname(abs), `.jarvis-write-${basename(abs)}-${randomUUID()}.tmp`);
  let tempExists = false;
  try {
    const handle = await open(temp, 'wx', originalMode);
    tempExists = true;
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    const checked = await safeResolve(cwd, path);
    if (!checked.ok || checked.abs !== abs) {
      return {
        content: '',
        error: `Cannot replace ${path}: ${checked.ok ? 'resolved target changed during write' : checked.reason}`,
        fileReceipt: { ...receipt, outcome: 'unknown' as const, preVersion },
      };
    }
    const [beforeBytes, beforeLeaf] = await Promise.all([readFile(abs), lstat(abs)]);
    if (beforeLeaf.isSymbolicLink()) {
      return {
        content: '',
        error: `Cannot replace ${path}: the target became a symbolic link before commit`,
        fileReceipt: { ...receipt, outcome: 'conflict' as const, preVersion },
      };
    }
    if (beforeLeaf.nlink > 1 || beforeLeaf.mode !== originalMode) {
      return {
        content: '',
        error: `Write conflict for ${path}: file metadata changed before commit; read again before retrying`,
        fileReceipt: { ...receipt, outcome: 'conflict' as const, preVersion },
      };
    }
    const beforeCommit = fileVersion(beforeBytes);
    if (beforeCommit !== expectedVersion) {
      return {
        content: '',
        error: `Write conflict for ${path}: file changed before commit; read again before retrying`,
        fileReceipt: { ...receipt, outcome: 'conflict' as const, preVersion: beforeCommit },
      };
    }

    await rename(temp, abs);
    tempExists = false;
    const postVersion = fileVersion(await readFile(abs));
    const intendedVersion = fileVersion(Buffer.from(content, 'utf8'));
    if (postVersion !== intendedVersion) {
      return {
        content: '',
        error: `Cannot confirm write ${path}: file changed during post-write verification`,
        fileReceipt: { ...receipt, outcome: 'unknown' as const, preVersion, postVersion },
      };
    }
    return {
      content: `Wrote ${content.length} chars to ${path}; postVersion=${postVersion}`,
      fileReceipt: { ...receipt, outcome: 'applied' as const, preVersion, postVersion },
    };
  } catch (err) {
    return {
      content: '',
      error: `Cannot write ${path}: ${message(err)}`,
      fileReceipt: { ...receipt, outcome: 'unknown' as const, preVersion },
    };
  } finally {
    if (tempExists) await unlink(temp).catch(() => undefined);
  }
}

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

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined;
}
