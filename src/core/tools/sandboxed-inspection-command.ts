import shModule from 'mvdan-sh';
import type { ShNode } from 'mvdan-sh';
import { analyzeCommand, isSensitivePath } from '../../runtime/permission/index.js';

const { syntax } = shModule;

export interface InspectionCommandDecision {
  readonly ok: boolean;
  readonly reason?: string;
}

const ok: InspectionCommandDecision = { ok: true };

const SIMPLE_NODE_TYPES = new Set(['File', 'Stmt', 'CallExpr', 'Word', 'Lit', 'SglQuoted', 'DblQuoted']);
const GLOB_META = /[*?]|\[.+?\]/;
const BRACE_EXPANSION = /\{[^{}]*(,|\.\.)[^{}]*\}/;
const GIT_DIFF_HARDENING_FLAGS = ['--no-ext-diff', '--no-textconv'] as const;

export function validateSandboxInspectionCommand(command: string): InspectionCommandDecision {
  const analysis = analyzeCommand(command);
  if (analysis.danger || analysis.sensitive) {
    return reject(analysis.reason ?? 'command is not safe enough for sandboxed inspection');
  }

  const parsed = parseInspectionWords(command);
  if (!parsed.ok) return reject(parsed.reason);
  return validateProgram(parsed.words);
}

export function hardenSandboxInspectionCommand(command: string): string {
  const parsed = parseInspectionWords(command);
  if (!parsed.ok) return command;

  const [program, subcommand, ...rest] = parsed.words;
  if (program === 'git' && subcommand === 'diff') {
    const missingFlags = GIT_DIFF_HARDENING_FLAGS.filter((flag) => !hasGitDiffFlag(rest, flag));
    if (missingFlags.length > 0) return shellWords(['git', 'diff', ...missingFlags, ...rest]);
  }
  return command;
}

function hasGitDiffFlag(args: readonly string[], flag: string): boolean {
  for (const arg of args) {
    if (arg === '--') return false;
    if (arg === flag) return true;
  }
  return false;
}

function parseInspectionWords(command: string): { readonly ok: true; readonly words: string[] } | { readonly ok: false; readonly reason: string } {
  let file: ShNode;
  try {
    file = syntax.NewParser(syntax.Variant(syntax.LangBash)).Parse(command, 'sandboxed-inspection');
  } catch (err) {
    return { ok: false, reason: `cannot parse command: ${message(err)}` };
  }

  const calls: string[][] = [];
  let unsupported: string | undefined;

  syntax.Walk(file, (node) => {
    if (node === null || unsupported !== undefined) return true;
    const type = typeOf(node);
    if (!SIMPLE_NODE_TYPES.has(type)) {
      unsupported = `unsupported shell syntax: ${type}`;
      return true;
    }
    if (type === 'CallExpr') {
      const words = literalWords(arr(node.Args));
      if (!words.ok) {
        unsupported = words.reason;
        return true;
      }
      calls.push(words.words);
    }
    return true;
  });

  if (unsupported !== undefined) return { ok: false, reason: unsupported };
  if (calls.length !== 1) return { ok: false, reason: `expected one simple inspection command, got ${calls.length}` };
  return { ok: true, words: calls[0] ?? [] };
}

function validateProgram(words: readonly string[]): InspectionCommandDecision {
  const [program, ...args] = words;
  if (program === undefined || program === '') return reject('empty command');
  if (!allArgsStayInsideProject(args)) return reject('inspection command must stay inside the project snapshot');

  switch (program) {
    case 'git':
      return validateGit(args);
    case 'stat':
      return args.length > 0 ? ok : reject('stat needs at least one path');
    case 'wc':
      return validateWc(args);
    default:
      return reject(`program is not in the sandboxed inspection allow scope: ${program}`);
  }
}

function validateGit(args: readonly string[]): InspectionCommandDecision {
  if (args.some(isGitPathspecMagic)) return reject('git pathspec magic is not allowed in sandboxed inspection commands');
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case 'status':
      return allFlags(rest, ['--short', '-s', '--porcelain', '--branch', '-b'])
        ? ok
        : reject('git status only allows short/porcelain/branch flags');
    case 'diff':
      return validateGitDiff(rest);
    case 'log':
      return validateGitLog(rest);
    case 'ls-files':
      return rest.every((arg) => arg === '--' || !arg.startsWith('-')) ? ok : reject('git ls-files only allows paths');
    default:
      return reject(`git subcommand is not in the sandboxed inspection allow scope: ${subcommand ?? '(missing)'}`);
  }
}

function validateGitDiff(args: readonly string[]): InspectionCommandDecision {
  const allowedFlags = new Set(['--', '--stat', '--name-only', '--name-status', '--check', '--cached', '--staged', '--color=never', '--no-ext-diff', '--no-textconv']);
  for (const arg of args) {
    if (arg.startsWith('-') && !allowedFlags.has(arg)) return reject(`git diff flag is not allowed: ${arg}`);
  }
  return ok;
}

function validateGitLog(args: readonly string[]): InspectionCommandDecision {
  const allowedFlags = new Set(['--', '--oneline', '--decorate', '--no-decorate', '--color=never']);
  for (const arg of args) {
    if (arg.startsWith('--max-count=')) continue;
    if (/^-\d+$/.test(arg)) continue;
    if (arg.startsWith('-') && !allowedFlags.has(arg)) return reject(`git log flag is not allowed: ${arg}`);
  }
  return ok;
}

function validateWc(args: readonly string[]): InspectionCommandDecision {
  const allowedFlags = new Set(['-l', '-c', '-m', '-w']);
  const paths = args.filter((arg) => !arg.startsWith('-'));
  if (paths.length === 0) return reject('wc needs at least one path');
  for (const arg of args) {
    if (arg.startsWith('-') && !allowedFlags.has(arg)) return reject(`wc flag is not allowed: ${arg}`);
  }
  return ok;
}

function allFlags(args: readonly string[], allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return args.every((arg) => set.has(arg));
}

function isGitPathspecMagic(arg: string): boolean {
  return arg.startsWith(':(');
}

function allArgsStayInsideProject(args: readonly string[]): boolean {
  return args.every((arg) => {
    if (arg === '--') return true;
    if (arg.startsWith('-')) return true;
    const normalized = arg.replace(/\\/g, '/').toLowerCase();
    if (normalized.startsWith('/') || normalized.startsWith('~')) return false;
    if (normalized === '..' || normalized.includes('../') || normalized.includes('/..')) return false;
    if (normalized.includes('.env') || normalized.includes('.ssh') || normalized.includes('id_rsa')) return false;
    return !isSensitivePath(arg);
  });
}

function literalWords(words: readonly ShNode[]): { readonly ok: true; readonly words: string[] } | { readonly ok: false; readonly reason: string } {
  const out: string[] = [];
  for (const word of words) {
    const literal = literalWord(word);
    if (!literal.ok) return literal;
    out.push(literal.value);
  }
  return { ok: true, words: out };
}

function literalWord(word: ShNode): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string } {
  let value = '';
  for (const part of arr(word.Parts)) {
    const type = typeOf(part);
    if (type === 'Lit') {
      const text = str(part.Value);
      if (GLOB_META.test(text) || BRACE_EXPANSION.test(text)) return { ok: false, reason: 'unquoted glob/brace expansion is not allowed' };
      value += text;
    } else if (type === 'SglQuoted') {
      if (part.Dollar === true && str(part.Value).includes('\\')) return { ok: false, reason: 'ANSI-C quoted escapes are not allowed' };
      value += str(part.Value);
    } else if (type === 'DblQuoted') {
      for (const inner of arr(part.Parts)) {
        if (typeOf(inner) !== 'Lit') return { ok: false, reason: 'shell expansion is not allowed' };
        value += str(inner.Value);
      }
    } else {
      return { ok: false, reason: 'shell expansion is not allowed' };
    }
  }
  return { ok: true, value };
}

function reject(reason: string): InspectionCommandDecision {
  return { ok: false, reason };
}

function shellWords(words: readonly string[]): string {
  return words.map(shellWord).join(' ');
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:=,@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function typeOf(node: ShNode): string {
  return syntax.NodeType(node);
}

function arr(value: unknown): ShNode[] {
  return Array.isArray(value) ? (value as ShNode[]) : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const record = err as Record<string, unknown>;
    const goError = record.Error;
    if (typeof goError === 'function') {
      try {
        const text = (goError as () => unknown).call(err);
        if (typeof text === 'string' && text.trim() !== '' && text !== '[object Object]') return text;
      } catch {
        // Fall through to generic formatting.
      }
    }
  }
  return String(err);
}
