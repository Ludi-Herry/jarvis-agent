/**
 * command — the deterministic command analyzer (the SECURITY ROOT). It decides whether a shell
 * command is dangerous or touches a secret, never trusting anything the model says (deepcode's
 * hole was believing a model-declared "safe"; we judge the command ourselves).
 *
 * It is built on a REAL bash parser (mvdan-sh, the JS build of mvdan/sh) rather than a hand-rolled
 * tokenizer. That switch (after the hand-rolled version kept leaking on shell grammar) is what
 * makes this both safer AND more precise: the AST distinguishes quoting from expansion (`"{a,b}"`
 * is literal, `{a,b}` expands), and the walk descends into compound commands — so `if …; then git
 * push --force; fi` is caught by finding the real `git push --force` inside, and
 * `for f in *; do prettier $f; done` is correctly allowed (it finds `prettier`, not a keyword).
 *
 * The boundary is fail-closed on what is genuinely runtime-unknowable: command/process
 * substitution output (`$(…)`, `<(…)`), an unresolved `$var` in program position or in a
 * destructive command's flags, brace expansion, and a parse error all return danger. Globs stay
 * allowed except when they could expand to a secret. Quotes/control-flow/wrappers are now parsed
 * precisely, so they are NOT blanket-denied.
 *
 * Pure: returns a {@link CommandAnalysis}; {@link decide} turns danger/sensitive into deny.
 */
import shModule from 'mvdan-sh';
import type { ShNode } from 'mvdan-sh';
import { isSensitivePath, globMatchesSecret } from './sensitive.js';

const { syntax } = shModule;

/** The analyzer's verdict. `reason` is the first explanation (shown on deny). */
export interface CommandAnalysis {
  danger: boolean;
  sensitive: boolean;
  reason?: string;
}

/** Max nesting to penetrate when re-parsing a shell string (`sh -c "sh -c '…'"`); beyond it we
 *  stop trying and fail closed. */
const MAX_DEPTH = 3;

/** Analyze one command line. Parse failures and over-deep nesting fail closed (danger). */
export function analyzeCommand(cmd: string): CommandAnalysis {
  const v = walkSource(cmd, 0);
  return { danger: v.danger, sensitive: v.sensitive, reason: v.reason };
}

interface Verdict {
  danger: boolean;
  sensitive: boolean;
  reason?: string;
}

const clean: Verdict = { danger: false, sensitive: false };
const danger = (reason: string): Verdict => ({ danger: true, sensitive: false, reason });
const sensitive = (reason: string): Verdict => ({ danger: false, sensitive: true, reason });
function combine(a: Verdict, b: Verdict): Verdict {
  return { danger: a.danger || b.danger, sensitive: a.sensitive || b.sensitive, reason: a.reason ?? b.reason };
}

// ----------------------------------------------------------------------------------------------
// AST helpers (mvdan-sh nodes are dynamic — read fields by name, cast explicitly).
// ----------------------------------------------------------------------------------------------

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): ShNode[] => (Array.isArray(v) ? (v as ShNode[]) : []);
const obj = (v: unknown): ShNode | undefined => (typeof v === 'object' && v !== null ? (v as ShNode) : undefined);
const typeOf = (n: ShNode): string => syntax.NodeType(n);

/** Parse + classify a shell source string. Walk visits every CallExpr (including those nested in
 *  compound commands and `$(…)`/`<(…)`) and every Redirect, so each is judged. */
function walkSource(src: string, depth: number): Verdict {
  if (depth > MAX_DEPTH) return danger(`shell nesting deeper than ${MAX_DEPTH} levels — too deep to verify safely`);

  let file: ShNode;
  try {
    file = syntax.NewParser(syntax.Variant(syntax.LangBash)).Parse(src, 'cmd');
  } catch (err) {
    return danger(`cannot parse command safely: ${err instanceof Error ? err.message : String(err)}`);
  }

  let v = clean;
  try {
    syntax.Walk(file, (node) => {
      if (node === null) return true;
      const t = typeOf(node);
      if (t === 'CallExpr') v = combine(v, classifyCall(node, depth, src));
      else if (t === 'DeclClause') {
        // declare/export/local/readonly/typeset — a `VAR=secret` value (`declare f=.env`).
        for (const asn of arr(node.Args)) v = combine(v, secretOfWord(describeWord(obj(asn.Value), src)));
      } else if (t === 'Redirect') {
        v = combine(v, secretOfWord(describeWord(obj(node.Word), src)));
      }
      return true;
    });
  } catch (err) {
    // Any analyzer error mid-walk → fail closed rather than letting it escape.
    return danger(`could not verify command safely: ${err instanceof Error ? err.message : String(err)}`);
  }
  return v;
}

/** One word resolved into what we can know statically: its literal text plus flags for the parts
 *  we CANNOT resolve (a `$var`, a `$(…)`/`<(…)`, a brace expansion, a glob). */
interface WordDesc {
  value: string; // concatenated literal text (quoted parts included, inert)
  hasParam: boolean; // contains $var / ${…} / $((…))
  hasSubst: boolean; // contains $(…) / `…` / <(…) — output is unknowable
  hasBrace: boolean; // a bare (unquoted) brace expansion {a,b} / {x..y}
  hasGlob: boolean; // a bare (unquoted) glob * ? [...]
}

const BRACE_EXPANSION = /\{[^{}]*(,|\.\.)[^{}]*\}/;
/** A glob is `*`/`?`, or a `[...]` char class — a LONE `[` (the `test` builtin) is not a glob. */
const GLOB_META = /[*?]|\[.+?\]/;

function describeWord(word: ShNode | undefined, src: string): WordDesc {
  const d: WordDesc = { value: '', hasParam: false, hasSubst: false, hasBrace: false, hasGlob: false };
  if (!word) return d;
  for (const part of arr(word.Parts)) {
    switch (typeOf(part)) {
      case 'Lit': {
        const v = str(part.Value);
        d.value += v;
        if (BRACE_EXPANSION.test(v)) d.hasBrace = true;
        if (GLOB_META.test(v)) d.hasGlob = true;
        break;
      }
      case 'SglQuoted':
        // `$'…'` (ANSI-C) keeps its RAW source in Value (escapes undecoded). If it carries backslash
        // escapes we can't safely re-parse it (`$'\x72\x6d'` → rm), so fail closed. Plain `'…'` and
        // escape-free `$'…'` are literal.
        if (part.Dollar === true && str(part.Value).includes('\\')) d.hasSubst = true;
        d.value += str(part.Value);
        break;
      case 'DblQuoted':
        for (const inner of arr(part.Parts)) {
          const it = typeOf(inner);
          if (it === 'Lit') d.value += str(inner.Value); // quoted → globs/braces inert
          else if (it === 'ParamExp' || it === 'ArithmExp') markExpansion(d, inner, src);
          else if (it === 'CmdSubst' || it === 'ProcSubst') d.hasSubst = true;
        }
        break;
      case 'ParamExp':
      case 'ArithmExp':
        markExpansion(d, part, src);
        break;
      case 'CmdSubst':
      case 'ProcSubst':
        d.hasSubst = true;
        break;
      default:
        d.hasSubst = true; // an unmodeled part → treat as unknowable, fail closed
    }
  }
  return d;
}

/** A `$var`/arithmetic expansion is a param unless its OWN source carries a command substitution
 *  (`${x:-$(cmd)}`, `${x:$(cmd):1}`, `$(( $(cmd) ))`) — mvdan's Walk doesn't descend into arithmetic
 *  sub-contexts, so we scan the node's source text (via Pos/End) instead. */
function markExpansion(d: WordDesc, node: ShNode, src: string): void {
  const text = sourceOf(node, src);
  if (text.includes('$(') || text.includes('`')) d.hasSubst = true;
  else d.hasParam = true;
}

/** The exact source substring of a node (via Pos/End offsets); the whole source on any failure, so
 *  a substitution can't slip past a missing offset. */
function sourceOf(node: ShNode, src: string): string {
  const a = nodeOffset(node, 'Pos');
  const b = nodeOffset(node, 'End');
  return a >= 0 && b >= a && b <= src.length ? src.slice(a, b) : src;
}

function nodeOffset(node: ShNode, which: 'Pos' | 'End'): number {
  const posFn = node[which];
  if (typeof posFn !== 'function') return -1;
  const pos = (posFn as () => unknown).call(node);
  if (pos === null || typeof pos !== 'object') return -1;
  const offFn = (pos as ShNode).Offset;
  if (typeof offFn !== 'function') return -1;
  const n = (offFn as () => unknown).call(pos);
  return typeof n === 'number' ? n : -1;
}

const isStatic = (d: WordDesc): boolean => !d.hasParam && !d.hasSubst && !d.hasBrace && !d.hasGlob;

/** A word that names a secret path → sensitive. Catches a literal path, a secret-matching glob, and
 *  the literal SUFFIX of a `$var` word (`$HOME/.ssh/id_rsa`, `${PWD}/.env`). */
function secretOfWord(d: WordDesc): Verdict {
  if (d.hasSubst) return clean; // output unknowable here (the command is flagged danger globally)
  if (d.hasGlob && globMatchesSecret(d.value)) return sensitive(`a glob that can expand to a secret: '${d.value}'`);
  if (d.value !== '' && isSensitivePath(d.value)) return sensitive(`touches a secret path: '${d.value}'`);
  return clean;
}

/** Classify one CallExpr: check its leading assignments for secrets, then its program + args. */
function classifyCall(call: ShNode, depth: number, src: string): Verdict {
  let v = clean;
  for (const assign of arr(call.Assigns)) {
    // `X=.env cmd` — the value can carry a secret a later `$X` expands to.
    v = combine(v, secretOfWord(describeWord(obj(assign.Value), src)));
  }
  const descs = arr(call.Args).map((w) => describeWord(w, src));
  return combine(v, classifyWords(descs, depth));
}

/** The heart: classify a command given its words (program at [0]), with the same rule set as
 *  before but now operating on properly-resolved words. Used for the top command and, recursively,
 *  for the inner command of a wrapper. */
function classifyWords(descs: WordDesc[], depth: number): Verdict {
  if (depth > MAX_DEPTH) return danger(`command nesting deeper than ${MAX_DEPTH} levels — too deep to verify safely`);
  if (descs.length === 0) return clean;

  // Fail-closed on the genuinely runtime-unknowable:
  if (descs.some((d) => d.hasSubst)) {
    return danger('command or argument built from command/process substitution — output cannot be verified');
  }
  if (descs.some((d) => d.hasBrace)) {
    return danger('brace expansion can synthesize arguments — cannot verify; quote it or list explicitly');
  }
  const prog0 = descs[0];
  if (prog0.hasParam) return danger('program name built from an unresolved variable expansion');
  if (prog0.hasGlob) return danger('program name built from a glob');

  const prog = basename(prog0.value);
  const argDescs = descs.slice(1);
  const args = argDescs.map((d) => d.value);

  let v: Verdict = clean;
  // Secret paths: program-aware so `echo .env` (text, not a path read) isn't over-blocked, while a
  // file-path program reading/writing a secret is caught. Redirect WRITE targets and declaration
  // builtins (`declare f=.env`) are handled in walkSource.
  if (FILE_PATH_PROGS.has(prog)) {
    for (const d of argDescs) v = combine(v, secretOfWord(d));
  } else if (GREP_PROGS.has(prog)) {
    // grep PATTERN FILE…: the FIRST non-flag operand is the search PATTERN (text, not a path); the rest
    // are files grep READS. Scan only the files — so `grep .env README` (.env is the pattern) isn't
    // over-blocked while `grep -a . .env` / `grep x /proc/$PPID/environ` (reads a secret) is caught.
    let sawPattern = false;
    for (const d of argDescs) {
      if (!sawPattern) {
        if (!d.value.startsWith('-')) sawPattern = true; // this operand is the pattern — skip it
        continue;
      }
      v = combine(v, secretOfWord(d));
    }
  }

  // A destructive mutator with an unresolved $arg hides its flag/target → fail closed.
  if (DANGER_CAPABLE.has(prog) && argDescs.some((d) => d.hasParam)) {
    return combine(v, danger(`'${prog}' with an unresolved $expansion in its arguments — cannot verify the flag/target`));
  }

  return combine(v, classifyProgram(prog, args, argDescs, depth));
}

/** Program-specific classification: interpreters, wrappers, git -c, and the dangerous-pattern rules. */
function classifyProgram(prog: string, args: string[], argDescs: WordDesc[], depth: number): Verdict {
  // 0. Builtins/commands that EXECUTE a carried string or callback — penetrate it (re-parse), or
  //    fail closed if it's non-literal. Otherwise a dangerous command hides inside.
  if (prog === 'trap') {
    // `trap <action> SIG…`; skip options (incl. a `--` terminator). Reset (`-`)/ignore (`''`) carry none.
    let i = 0;
    while (i < argDescs.length && argDescs[i].value.startsWith('-')) {
      const wasTerminator = argDescs[i].value === '--';
      i++;
      if (wasTerminator) break;
    }
    const action = argDescs[i];
    if (!action || action.value === '' || action.value === '-') return clean;
    if (!isStatic(action)) return danger('trap installs a non-literal action — cannot verify');
    return walkSource(action.value, depth + 1);
  }
  if (prog === 'env') {
    const split = splitStringOperand(args, argDescs); // `env -S '<cmd>'` / `--split-string=<cmd>`
    if (split !== undefined) {
      return split.isLiteral ? walkSource(split.value, depth + 1) : danger('env -S with a non-literal string — cannot verify');
    }
    // no -S → fall through to the wrapper handling below (env VAR=VAL cmd)
  }
  if (prog === 'mapfile' || prog === 'readarray' || prog === 'compgen' || prog === 'complete') {
    const i = args.indexOf('-C');
    if (i >= 0 && i + 1 < argDescs.length) {
      const cb = argDescs[i + 1];
      return isStatic(cb) ? walkSource(cb.value, depth + 1) : danger(`${prog} -C runs a non-literal callback — cannot verify`);
    }
    if (prog === 'complete' && args.includes('-F')) return danger('complete -F runs a shell function on completion — cannot verify');
  }
  if (prog === 'bind' && args.some((a) => a === '-x' || a.startsWith('-x'))) {
    return danger('bind -x binds a key to a shell command — cannot verify');
  }
  if (prog === 'ssh') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) {
      const opt = args[i];
      i++;
      if (SSH_VALUE_OPTS.has(opt)) i++; // skip the option's value
    }
    if (i + 1 < args.length) return danger('ssh runs a command on a remote host — cannot verify'); // host + remote cmd
  }
  if (prog === 'ps' && psPrintsEnv(args)) {
    // `ps` with the BSD `e` flag (ps e / eww / auxe / axe) or `-o environ` prints each process's
    // ENVIRONMENT — on Linux that exposes the parent process's INITIAL env (which holds ARK_API_KEY;
    // /proc/<pid>/environ shows the launch env, immune to a runtime delete), so it leaks the key even
    // though the env-var was scrubbed and the /proc file read is blocked. A plain `ps aux`/`-ef` is fine.
    return sensitive('ps with environment output (e / -o environ) can read another process\'s secrets');
  }

  // 1. Code interpreters: inline code (`-c`/`-e`/bundles) is opaque; a bare interpreter reads its
  //    program from stdin (curl | python). A script file or info flag is fine.
  if (CODE_INTERPRETERS.has(prog)) {
    if (hasInlineCodeFlag(args)) return danger(`inline code execution via '${prog}' cannot be statically verified`);
    if (!runsAScriptFile(args) && !isInfoOnly(prog, args)) {
      return danger(`bare '${prog}' reads its program from stdin (e.g. piped from curl)`);
    }
    return clean;
  }

  // 2. Shell interpreters / `script` / `flock`: penetrate the `-c "<string>"` operand by re-parsing.
  if (SHELL_INTERPRETERS.has(prog) || prog === 'script' || prog === 'flock') {
    const i = args.findIndex((a) => a === '-c' || /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    if (i >= 0 && i + 1 < argDescs.length) {
      const inner = argDescs[i + 1];
      if (!isStatic(inner)) return danger(`'${prog} -c' with a non-literal command string — cannot verify`);
      return walkSource(inner.value, depth + 1);
    }
    if (SHELL_INTERPRETERS.has(prog)) {
      if (!runsAScriptFile(args)) return danger(`bare '${prog}' invocation executes unverified input (e.g. piped from curl)`);
      return clean; // `bash script.sh` — a visible file
    }
    // script/flock with no -c → fall through to wrapper handling below
  }

  // 3. Transparent wrappers: classify the inner command. sudo/doas/su also escalate privilege.
  if (WRAPPERS.has(prog)) {
    let v: Verdict = prog === 'sudo' || prog === 'doas' || prog === 'su' ? danger(`privilege escalation via '${prog}'`) : clean;
    if (prog === 'command' && (args[0] === '-v' || args[0] === '-V')) return v; // a lookup, not execution
    if (prog === 'watch' || prog === 'parallel') {
      v = combine(v, walkSource(commandOperand(prog, args), depth + 1));
    }
    for (let k = 0; k < argDescs.length; k++) {
      if (args[k].startsWith('-') || ASSIGNMENT.test(args[k])) continue; // wrapper's own option / VAR=VAL
      v = combine(v, classifyWords(argDescs.slice(k), depth + 1));
    }
    return v;
  }

  // 4. `git -c key=val` can run a command via config (alias `!cmd`, pager/editor/hook/driver…).
  if (prog === 'git') {
    let g: Verdict = clean;
    for (let i = 0; i + 1 < args.length; i++) {
      if (args[i] !== '-c') continue;
      const eq = args[i + 1].indexOf('=');
      if (eq < 0) continue;
      const key = args[i + 1].slice(0, eq).toLowerCase();
      const rawVal = args[i + 1].slice(eq + 1);
      const bang = rawVal.startsWith('!');
      if (/^core\.(hookspath|fsmonitor)$/.test(key)) g = combine(g, danger(`git -c ${key} points at an executable run on git operations`));
      else if (bang || GIT_COMMAND_CONFIG.test(key)) g = combine(g, walkSource(bang ? rawVal.slice(1) : rawVal, depth + 1));
    }
    if (g.danger || g.sensitive) return g;
  }

  // 5. Data-driven dangerous-command rules.
  for (const rule of DANGEROUS) {
    if (rule.test(prog, args)) return danger(rule.reason);
  }
  return clean;
}

// ----------------------------------------------------------------------------------------------
// Dangerous-command rules + interpreter/wrapper tables (carried over; now fed clean literals).
// ----------------------------------------------------------------------------------------------

interface DangerRule {
  test: (prog: string, args: string[]) => boolean;
  reason: string;
}

const DANGEROUS: DangerRule[] = [
  {
    test: (p, a) =>
      p === 'rm' && (hasShort(a, 'r') || hasShort(a, 'R') || hasLong(a, '--recursive') || hasLong(a, '--no-preserve-root')),
    reason: 'recursive file deletion (rm -r)',
  },
  {
    test: (p, a) =>
      p === 'git' &&
      a.includes('push') &&
      (hasShort(a, 'f') ||
        hasLong(a, '--force') ||
        hasLong(a, '--force-with-lease') ||
        hasLong(a, '--delete') ||
        hasLong(a, '--mirror') ||
        hasLong(a, '--prune') ||
        a.some((w) => w.startsWith('+') || w.startsWith(':'))),
    reason: 'force/delete push rewrites or removes remote refs (git push --force/--delete)',
  },
  { test: (p, a) => p === 'git' && a.includes('reset') && hasLong(a, '--hard'), reason: 'git reset --hard discards work' },
  { test: (p, a) => p === 'git' && a.includes('clean') && (hasShort(a, 'f') || hasLong(a, '--force')), reason: 'git clean -f deletes untracked files' },
  { test: (p, a) => p === 'git' && a.includes('branch') && hasShort(a, 'D'), reason: 'git branch -D force-deletes a branch' },
  { test: (p, a) => p === 'git' && a.includes('filter-branch'), reason: 'git filter-branch rewrites history' },
  {
    test: (p, a) => p === 'find' && a.some((w) => w === '-exec' || w === '-execdir' || w === '-ok' || w === '-okdir' || w === '-delete'),
    reason: 'find -exec/-delete runs or deletes per match',
  },
  {
    test: (p, a) => (p === 'chmod' || p === 'chown' || p === 'chgrp') && (hasShort(a, 'R') || hasShort(a, 'r') || hasLong(a, '--recursive')),
    reason: 'recursive permission/ownership change',
  },
  {
    test: (p, a) => (p === 'awk' || p === 'gawk' || p === 'mawk' || p === 'nawk') && a.some((w) => /system\s*\(|\|\s*("|'|getline)|print[^;]*\|/.test(w)),
    reason: 'awk program shells out (system()/pipe)',
  },
  {
    test: (p, a) => VIM_FAMILY.has(p) && a.some((w) => w === '-c' || w === '--cmd' || /^\+[A-Za-z!]/.test(w)),
    reason: 'vim/ex runs an opaque editor command (-c/+cmd; e.g. :!shell, :call system())',
  },
  { test: (p, a) => (p === 'npm' || p === 'yarn' || p === 'pnpm' || p === 'bun') && a.includes('publish'), reason: 'package publish is an outward release' },
  { test: (p) => p === 'eval', reason: 'eval executes a dynamically built command' },
  { test: (p) => p === 'source' || p === '.', reason: 'source/. executes another script in-place' },
  { test: (p, a) => p === 'alias' && a.some((w) => w.includes('=')), reason: 'alias definition can hide a command' },
  { test: (p, a) => p === 'shopt' && a.includes('expand_aliases'), reason: 'enabling alias expansion can hide commands' },
  { test: (p) => p === 'shutdown' || p === 'reboot' || p === 'halt' || p === 'poweroff', reason: 'system power control' },
  { test: (p) => p === 'mkfs' || p.startsWith('mkfs.') || p === 'dd' || p === 'fdisk', reason: 'raw disk / filesystem write' },
  { test: (p) => p === 'shred', reason: 'shred irrecoverably destroys files' },
];

const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'csh', 'tcsh']);
const CODE_INTERPRETERS = new Set(['python', 'python2', 'python3', 'py', 'node', 'nodejs', 'deno', 'bun', 'ruby', 'perl', 'php', 'lua']);
const WRAPPERS = new Set([
  'sudo', 'doas', 'su', 'env', 'xargs', 'nohup', 'time', 'nice', 'ionice', 'timeout', 'stdbuf',
  'setsid', 'command', 'exec', 'builtin', 'watch', 'flock', 'chroot', 'parallel', 'busybox', 'toybox',
]);
const NODE_FAMILY = new Set(['node', 'nodejs', 'deno', 'bun']);
const PYTHON_FAMILY = new Set(['python', 'python2', 'python3', 'py']);
const VIM_FAMILY = new Set(['vim', 'vi', 'view', 'nvim', 'ex', 'gvim', 'rvim', 'rview', 'vimdiff', 'evim']);

/** Destructive mutators whose danger hinges on a flag (`rm -r`, `chmod -R`). A `$`expansion in
 *  their args hides that flag → fail closed. Deliberately small (git/npm/find/awk/vim excluded —
 *  `$` is common in their legit args; a `$`-synthesized flag there downgrades deny→ask). */
const DANGER_CAPABLE = new Set(['rm', 'rmdir', 'chmod', 'chown', 'chgrp']);

/** Programs whose non-flag args are file paths they read/write — only THESE get a secret-path scan,
 *  so `echo .env` / `grep .env` (where `.env` is text/a pattern) aren't over-blocked. */
const FILE_PATH_PROGS = new Set([
  'cat', 'tac', 'nl', 'head', 'tail', 'less', 'more', 'most', 'od', 'xxd', 'hexdump', 'strings',
  'base64', 'base32', 'cp', 'mv', 'install', 'ln', 'dd', 'tee', 'truncate', 'rm', 'rmdir', 'shred',
  'sed', 'awk', 'gawk', 'mawk', 'nawk', 'diff', 'cmp', 'patch', 'tar', 'zip', 'unzip', 'gzip',
  'gunzip', 'bzip2', 'xz', 'zcat', 'scp', 'rsync', 'sha1sum', 'sha256sum', 'sha512sum', 'md5sum',
  'openssl', 'gpg', 'jq', 'yq', 'vim', 'vi', 'view', 'nvim', 'emacs', 'nano', 'code', 'wc',
]);

/** grep family — like {@link FILE_PATH_PROGS} but the FIRST non-flag operand is the search PATTERN, not
 *  a file; only the operands AFTER it are files read (handled specially in {@link classifyWords}). */
const GREP_PROGS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ripgrep']);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const GIT_COMMAND_CONFIG =
  /^(alias\.|pager\.|core\.(pager|editor|sshcommand|askpass)|sequence\.editor|diff\.external|diff\..*\.command|merge\..*\.driver|filter\..*\.(clean|smudge|process)|gpg\.(program|.*\.program)|uploadpack\.|receivepack\.|protocol\..*\.command)/;

function hasInlineCodeFlag(args: string[]): boolean {
  return args.some(
    (a) =>
      a === '-c' || a === '-e' || a === '--eval' || a === '-p' || a === '--print' || a === '--eval-file' || (/^-[a-z]+$/.test(a) && (a.includes('c') || a.includes('e'))),
  );
}

function isInfoOnly(prog: string, args: string[]): boolean {
  const has = (f: string): boolean => args.includes(f);
  if (has('--version') || has('-h') || has('--help') || has('-?')) return true;
  if (NODE_FAMILY.has(prog) && (has('-v') || has('-V'))) return true;
  if ((PYTHON_FAMILY.has(prog) || prog === 'perl') && has('-V')) return true;
  if (prog === 'perl' && has('-v')) return true;
  return false;
}

/** stdin-equivalent "file" operands — running these means executing stdin/heredoc, NOT a visible
 *  file, so they must not count as a script file (`bash /dev/stdin <<EOF …`). */
const STDIN_PATHS = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0']);

function runsAScriptFile(args: string[]): boolean {
  return args.some((a) => !a.startsWith('-') && a !== '-c' && !STDIN_PATHS.has(a) && !/^\/dev\/fd\/|^\/proc\/self\/fd\//.test(a));
}

/** True when a `ps` invocation requests ENVIRONMENT output. The BSD `e` flag (a non-dash bundle
 *  containing `e`: `e`/`eww`/`auxe`/`axe`) prints each process's environment; `-o environ` /
 *  `--format environ` select the environ column. A plain `ps aux` / `ps -ef` (no env) is allowed. */
function psPrintsEnv(args: string[]): boolean {
  return args.some(
    (a) =>
      /environ/i.test(a) || // -o environ / --format environ / -oenviron / --format=environ
      (!a.startsWith('-') && /^[a-z]+$/i.test(a) && a.toLowerCase().includes('e')), // BSD bundle with `e`
  );
}

/** ssh options that consume the following argument (so the host isn't mistaken for an option value). */
const SSH_VALUE_OPTS = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w']);

/** The command string carried by `env -S`/`--split-string`, or undefined. */
function splitStringOperand(args: string[], argDescs: WordDesc[]): { value: string; isLiteral: boolean } | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-S' && i + 1 < argDescs.length) return { value: args[i + 1], isLiteral: isStatic(argDescs[i + 1]) };
    if (a.startsWith('-S') && a.length > 2) return { value: a.slice(2), isLiteral: isStatic(argDescs[i]) };
    if (a.startsWith('--split-string=')) return { value: a.slice('--split-string='.length), isLiteral: isStatic(argDescs[i]) };
    if (a === '--split-string' && i + 1 < argDescs.length) return { value: args[i + 1], isLiteral: isStatic(argDescs[i + 1]) };
  }
  return undefined;
}


/** The shell command string a `watch`/`parallel` runs: operands after the wrapper's own options. */
function commandOperand(prog: string, args: string[]): string {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '-n' || a === '--interval' || a === '--jobs' || a === '-j' || a === '-P') { i += 2; continue; }
    if (a.startsWith('-')) { i++; continue; }
    break;
  }
  const rest = args.slice(i);
  if (prog === 'parallel') {
    const stop = rest.findIndex((a) => a === ':::' || a === '::::' || a === ':::+' || a === '::::+');
    return (stop >= 0 ? rest.slice(0, stop) : rest).join(' ');
  }
  return rest.join(' ');
}

function basename(program: string): string {
  const norm = program.replace(/\\/g, '/');
  const slash = norm.lastIndexOf('/');
  return slash >= 0 ? norm.slice(slash + 1) : norm;
}

function hasShort(args: string[], letter: string): boolean {
  return args.some((a) => /^-[A-Za-z]+$/.test(a) && a.slice(1).includes(letter));
}

function hasLong(args: string[], name: string): boolean {
  return args.some((a) => a === name || a.startsWith(`${name}=`));
}
