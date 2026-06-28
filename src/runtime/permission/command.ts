/**
 * command — the deterministic command-tree analyzer (B2, plan §3.3). The SECURITY ROOT of the
 * whole gate: it decides whether a shell command is dangerous or touches a secret by PARSING it,
 * never by trusting anything the model says. (deepcode's exploit was believing a model-declared
 * `sideEffects=[]`; we read the command tree ourselves.)
 *
 * Target shell is POSIX sh (Git Bash on Windows) — chosen so the dangerous shapes we must catch
 * (`rm -rf`, `sh -c "..."` nesting, pipes, `$(...)`) carry their well-understood POSIX meaning and
 * the reference parsers (codex execpolicy, openhanako tokenizer) port cleanly. cmd/PowerShell are
 * a later extension (plan §7); a command we cannot parse is treated as dangerous, not waved through.
 *
 * Three ideas, all fail-closed:
 *  1. **Tokenize for real.** Quotes/escapes are honored so `git "push" --force` and `rm -rf /` are
 *     seen for what they are; an unterminated quote (unparseable) is dangerous by default.
 *  2. **Penetrate nesting.** `sh -c "git push --force"` re-parses the inner string (openhanako),
 *     and wrappers (`sudo`, `env X=Y`, `xargs`, `timeout`) are unwrapped to the real command. Depth
 *     is capped at {@link MAX_DEPTH}; exceeding it is dangerous.
 *  3. **Inline code is opaque.** `python -c`, `node -e`, `eval` execute strings we cannot statically
 *     read, so they are dangerous outright (codex's BANNED_PREFIX rationale) — we never try to parse
 *     arbitrary code, we refuse it.
 *
 * Pure and stateless: returns {@link CommandAnalysis} so {@link decide} (decide.ts) can turn a
 * `danger`/`sensitive` verdict into deny. Every guardrail here has a "really triggers" unit test
 * (AGENTS.md), including the nested and fail-closed paths.
 */
import type { PermissionPolicy } from './decide.js';

/** A single command: its program and the rest of its words. Redirect targets are pulled aside. */
export interface SimpleCommand {
  program: string;
  args: string[];
  /** Files this command writes/reads via redirection (`> .env`), checked against secret paths. */
  redirectTargets: string[];
}

/** The analyzer's verdict. `commands` is the flattened tree (including penetrated inner commands),
 *  exposed so callers/tests can see exactly what was parsed — not a model's say-so. */
export interface CommandAnalysis {
  commands: SimpleCommand[];
  danger: boolean;
  sensitive: boolean;
  /** The first matched reason, explainable (shown on deny). Undefined only when neither flag is set. */
  reason?: string;
}

/** Max shell-nesting depth to penetrate (`sh -c "sh -c '...'"`). openhanako uses 3; beyond it we
 *  stop trying to understand and fail closed. */
const MAX_DEPTH = 3;

/**
 * Analyze one command line. The headline entry point. Tokenization or depth failures return
 * `danger: true` (fail-closed) rather than throwing, so the gate can deny with a reason.
 */
export function analyzeCommand(cmd: string, policy: PermissionPolicy): CommandAnalysis {
  const commands: SimpleCommand[] = [];
  const verdict = walk(cmd, policy, 0, commands);
  return { commands, danger: verdict.danger, sensitive: verdict.sensitive, reason: verdict.reason };
}

interface Verdict {
  danger: boolean;
  sensitive: boolean;
  reason?: string;
}

/** Parse one command string at a given nesting depth, append its simple commands to `out`, and
 *  return the combined verdict (recursing into penetrated inner commands). */
function walk(cmd: string, policy: PermissionPolicy, depth: number, out: SimpleCommand[]): Verdict {
  if (depth > MAX_DEPTH) {
    return danger(`shell nesting deeper than ${MAX_DEPTH} levels — too deep to verify safely`);
  }

  let tokens: Token[];
  try {
    tokens = tokenize(cmd);
  } catch (err) {
    // Unparseable (e.g. unterminated quote) → cannot verify → dangerous.
    return danger(`cannot parse command safely: ${err instanceof Error ? err.message : String(err)}`);
  }

  let worst: Verdict = { danger: false, sensitive: false };
  for (const segment of splitSegments(tokens)) {
    const v = analyzeSegment(segment, policy, depth, out);
    worst = combine(worst, v);
  }
  return worst;
}

/** Analyze one pipeline segment (the words between `|`/`;`/`&&`/`||`). Builds the SimpleCommand,
 *  classifies it, penetrates wrappers and `$(...)` substitutions, and returns the verdict. */
function analyzeSegment(
  segment: Token[],
  policy: PermissionPolicy,
  depth: number,
  out: SimpleCommand[],
): Verdict {
  // First, penetrate any command substitutions present anywhere in the segment ($(...), `...`).
  let sub: Verdict = { danger: false, sensitive: false };
  for (const tok of segment) {
    if (tok.kind === 'subst') sub = combine(sub, walk(tok.inner, policy, depth + 1, out));
  }

  // An assignment VALUE can carry a secret path a later `$var` expands to (`X=.env cat $X`,
  // `f=.env; cat $f`). Static analysis can't follow the expansion, but it can see the literal value.
  for (const tok of segment) {
    if (tok.kind !== 'word' || !ASSIGNMENT.test(tok.value)) continue;
    const value = tok.value.slice(tok.value.indexOf('=') + 1);
    if (policy.sensitivePaths.some((re) => re.test(normalize(value)))) {
      sub = combine(sub, { danger: false, sensitive: true, reason: `assignment exposes a secret path: '${value}'` });
    }
  }

  // A command whose PROGRAM comes from a substitution (`$(echo rm) -rf x`) runs whatever the
  // substitution prints — unverifiable, so fail closed. (The inner is still penetrated above.)
  for (const tok of segment) {
    if (tok.kind === 'redirect') continue;
    if (tok.kind === 'word' && ASSIGNMENT.test(tok.value)) continue; // leading VAR=VAL
    if (tok.kind === 'subst') {
      sub = combine(sub, danger('program produced by command substitution — cannot verify'));
    }
    break; // first head token reached
  }

  const cmd = toSimpleCommand(segment);
  if (cmd === undefined) return sub; // no program (e.g. a bare assignment or empty) — nothing to run
  out.push(cmd);

  // Secret path anywhere in program/args/redirect targets (read OR write — deepcode hole).
  const secret = secretHit(cmd, policy);
  if (secret !== undefined) {
    sub = combine(sub, { danger: false, sensitive: true, reason: `touches a secret path: '${secret}'` });
  }

  // Penetrate shell wrappers / inline interpreters to the real intent.
  sub = combine(sub, classify(cmd, policy, depth, out));
  return sub;
}

/** Classify a simple command: BANNED interpreters (inline code AND bare stdin), shell `-c`
 *  penetration, wrapper penetration (sudo/env/xargs/timeout/…), and the dangerous-pattern rules. */
function classify(cmd: SimpleCommand, policy: PermissionPolicy, depth: number, out: SimpleCommand[]): Verdict {
  // Bound wrapper/penetration recursion the same way walk() does — without this, a chain of
  // nested wrappers (`command command command … echo`) makes the suffix scan blow up and the gate
  // hangs instead of failing closed.
  if (depth > MAX_DEPTH) {
    return danger(`command nesting deeper than ${MAX_DEPTH} levels — too deep to verify safely`);
  }

  const prog = basename(cmd.program);

  // 0. Fail-closed on shell grammar we don't fully model — better to deny than mis-classify a
  //    dangerous command as safe (the bypass class found in review):
  //    - a control keyword as the program (`if … then git push --force; fi`, `{ rm -rf; }`, `! rm`);
  //    - a program built from an unresolved $expansion (`cmd=rm; $cmd -rf x`);
  //    - a danger-capable program with a $expansion in its args (`rm $flags`, `git $sub`).
  if (SHELL_KEYWORDS.has(prog)) {
    return danger(`shell control construct '${prog}' — too complex to verify; put the logic in a script file`);
  }
  if (cmd.program.includes('$')) {
    return danger('program name built from an unresolved variable expansion');
  }
  if (DANGER_CAPABLE.has(prog) && cmd.args.some((a) => a.includes('$'))) {
    return danger(`'${prog}' with an unresolved $expansion in its arguments — cannot verify the flags/target`);
  }

  // 1. Code interpreters (python/node/ruby/…). Inline code (`-c`/`-e`) is opaque → refuse. A BARE
  //    interpreter reads its program from stdin (`curl … | python`, heredoc) → also refuse. Running
  //    a visible script file (`python x.py`) or a print-and-exit info flag (`node -v`) is fine.
  if (CODE_INTERPRETERS.has(prog)) {
    if (hasInlineCodeFlag(cmd.args)) {
      return danger(`inline code execution via '${prog}' cannot be statically verified`);
    }
    if (!runsAScriptFile(cmd.args) && !isInfoOnly(prog, cmd.args)) {
      return danger(`bare '${prog}' reads its program from stdin (e.g. piped from curl)`);
    }
    return clean();
  }

  // 2. `script -c "<shell string>"` carries a command the same way a shell does — penetrate it.
  if (prog === 'script') {
    const inner = inlineShellString(cmd.args);
    if (inner !== undefined) return walk(inner, policy, depth + 1, out);
    return clean();
  }

  // 3. Shell interpreters: penetrate `-c "<inner>"` (openhanako); a bare shell (pipe sink / stdin)
  //    is dangerous; `bash script.sh` (a visible file) is fine.
  if (SHELL_INTERPRETERS.has(prog)) {
    const inner = inlineShellString(cmd.args);
    if (inner !== undefined) return walk(inner, policy, depth + 1, out);
    if (!runsAScriptFile(cmd.args)) {
      return danger(`bare '${prog}' invocation executes unverified input (e.g. piped from curl)`);
    }
    return clean();
  }

  // 4. Transparent wrappers (timeout/nice/xargs/env/sudo/…). The wrapper's OWN options and operands
  //    (a timeout duration, an `xargs -I{}`, an `env VAR=VAL`) must not hide the real command, so we
  //    classify EVERY command-candidate suffix — each non-option, non-assignment word as a program
  //    with the words after it as its args. This catches `timeout 5 rm -rf /` and `xargs -0 rm -rf`
  //    no matter what precedes the real command (fail-closed over precise per-wrapper parsing).
  if (WRAPPERS.has(prog)) {
    let v: Verdict =
      prog === 'sudo' || prog === 'doas' || prog === 'su' ? danger(`privilege escalation via '${prog}'`) : clean();

    // `command -v/-V X` is a lookup ("is X installed?"), not execution — only when the FLAG IS FIRST
    // (`command rm -r -v` is a real recursive rm, not a lookup).
    if (prog === 'command' && (cmd.args[0] === '-v' || cmd.args[0] === '-V')) return v;

    // Some wrappers run a shell STRING operand (`flock -c "…"`, `watch "rm -rf /"`,
    // `parallel "rm {}" ::: …`). Re-parse that string so a quoted command can't hide as one token.
    if (prog === 'flock') {
      const sh = inlineShellString(cmd.args);
      if (sh !== undefined) v = combine(v, walk(sh, policy, depth + 1, out));
    }
    if (prog === 'watch' || prog === 'parallel') {
      v = combine(v, walk(commandOperand(prog, cmd.args), policy, depth + 1, out));
    }

    // The argv form: classify every command-candidate suffix so the wrapper's own options/operands
    // (a duration, `xargs -I{}`, `flock <file>`) can't demote the real command. depth+1 bounds it.
    for (let k = 0; k < cmd.args.length; k++) {
      const word = cmd.args[k];
      if (word.startsWith('-')) continue; // an option (or its attached value)
      if (ASSIGNMENT.test(word)) continue; // env VAR=VAL
      const inner: SimpleCommand = { program: word, args: cmd.args.slice(k + 1), redirectTargets: [] };
      const secret = secretHit(inner, policy);
      if (secret !== undefined) {
        v = combine(v, { danger: false, sensitive: true, reason: `touches a secret path: '${secret}'` });
      }
      v = combine(v, classify(inner, policy, depth + 1, out));
    }
    return v;
  }

  // 5. `git -c key=val` can run arbitrary commands via config — aliases (`!cmd`), pager/editor/
  //    askpass/external-diff/merge-driver/filter (the value IS a command), or hooksPath/fsmonitor
  //    (the value is an executable path run on git operations). Penetrate the VALUE as a command so
  //    a benign value (`core.pager=cat`) stays safe while a command value is caught.
  if (prog === 'git') {
    let g = clean();
    for (let i = 0; i + 1 < cmd.args.length; i++) {
      if (cmd.args[i] !== '-c') continue;
      const kv = cmd.args[i + 1];
      const eq = kv.indexOf('=');
      if (eq < 0) continue;
      const key = kv.slice(0, eq).toLowerCase();
      const raw = kv.slice(eq + 1);
      const bang = raw.startsWith('!');
      if (/^core\.(hookspath|fsmonitor)$/.test(key)) {
        g = combine(g, danger(`git -c ${key} points at an executable run on git operations`));
      } else if (bang || GIT_COMMAND_CONFIG.test(key)) {
        g = combine(g, walk(bang ? raw.slice(1) : raw, policy, depth + 1, out));
      }
    }
    if (g.danger || g.sensitive) return g;
    // else fall through to the dangerous-subcommand rules below (push --force, reset --hard, …)
  }

  // 6. Data-driven dangerous-command rules.
  for (const rule of DANGEROUS) {
    if (rule.test(prog, cmd.args)) return danger(rule.reason);
  }
  return clean();
}

// ----------------------------------------------------------------------------------------------
// Dangerous-command rules (data-driven so adding one is a single line + a test).
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
        a.some((w) => w.startsWith('+') || w.startsWith(':'))), // +ref / :ref rewrite or delete
    reason: 'force/delete push rewrites or removes remote refs (git push --force/--delete)',
  },
  { test: (p, a) => p === 'git' && a.includes('reset') && hasLong(a, '--hard'), reason: 'git reset --hard discards work' },
  {
    test: (p, a) => p === 'git' && a.includes('clean') && (hasShort(a, 'f') || hasLong(a, '--force')),
    reason: 'git clean -f deletes untracked files',
  },
  { test: (p, a) => p === 'git' && a.includes('branch') && hasShort(a, 'D'), reason: 'git branch -D force-deletes a branch' },
  { test: (p, a) => p === 'git' && a.includes('filter-branch'), reason: 'git filter-branch rewrites history' },
  // `find … -exec/-delete` runs/deletes per match — a classic deletion vector.
  {
    test: (p, a) => p === 'find' && a.some((w) => w === '-exec' || w === '-execdir' || w === '-ok' || w === '-okdir' || w === '-delete'),
    reason: 'find -exec/-delete runs or deletes per match',
  },
  {
    test: (p, a) =>
      (p === 'chmod' || p === 'chown' || p === 'chgrp') && (hasShort(a, 'R') || hasShort(a, 'r') || hasLong(a, '--recursive')),
    reason: 'recursive permission/ownership change',
  },
  // awk/sed program text can shell out (`system(...)`, pipe to a command) — opaque, refuse.
  {
    test: (p, a) =>
      (p === 'awk' || p === 'gawk' || p === 'mawk' || p === 'nawk') &&
      a.some((w) => /system\s*\(|\|\s*("|'|getline)|print[^;]*\|/.test(w)),
    reason: 'awk program shells out (system()/pipe)',
  },
  // vim/ex run a shell via `:!`, `:call system()`, `:python` etc — an opaque ex command. A `-c`/
  // `--cmd` is always refused; a `+` operand is refused only when it's an ex command (starts with a
  // letter or `!`), so navigation (`+10`, `+/foo`, `+$`, bare `+`) stays safe.
  {
    test: (p, a) => VIM_FAMILY.has(p) && a.some((w) => w === '-c' || w === '--cmd' || /^\+[A-Za-z!]/.test(w)),
    reason: 'vim/ex runs an opaque editor command (-c/+cmd; e.g. :!shell, :call system())',
  },
  // Publishing is an outward, hard-to-undo action — never let the agent do it unattended.
  {
    test: (p, a) => (p === 'npm' || p === 'yarn' || p === 'pnpm' || p === 'bun') && a.includes('publish'),
    reason: 'package publish is an outward release',
  },
  { test: (p) => p === 'eval', reason: 'eval executes a dynamically built command' },
  { test: (p) => p === 'shutdown' || p === 'reboot' || p === 'halt' || p === 'poweroff', reason: 'system power control' },
  { test: (p) => p === 'mkfs' || p.startsWith('mkfs.') || p === 'dd' || p === 'fdisk', reason: 'raw disk / filesystem write' },
  { test: (p) => p === 'shred', reason: 'shred irrecoverably destroys files' },
];

// ----------------------------------------------------------------------------------------------
// Interpreter / wrapper tables.
// ----------------------------------------------------------------------------------------------

/** Shell reserved words / control constructs. When one of these is the PROGRAM of a simple command,
 *  the real command is hidden inside a compound structure we don't fully parse — fail closed (a
 *  visible script file is the supported way to run shell logic). */
const SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
  'select', 'function', 'in', '{', '}', '!', '[[', ']]', 'coproc',
]);

/** Pure destructive mutators whose danger hinges on a flag (`rm -r`, `chmod -R`). If one of these
 *  carries a `$`expansion in its args, that flag is unverifiable → fail closed. Deliberately SMALL:
 *  git/npm/find/awk/vim are excluded because `$` is common in their legit args (commit messages,
 *  `npm run $x`, awk `$1`, vim `+$`); a `$`-synthesized dangerous flag there downgrades deny→ask
 *  (human-visible) — a documented residual, not a silent bypass. The program-position `$` check
 *  (e.g. `$cmd -rf`) covers the synthesized-program case for everything. */
const DANGER_CAPABLE = new Set(['rm', 'rmdir', 'chmod', 'chown', 'chgrp']);

/** Shells whose `-c "<string>"` we penetrate, and whose bare invocation is dangerous. */
const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'csh', 'tcsh']);

/** Non-shell interpreters whose inline `-c`/`-e` code is opaque and therefore refused. */
const CODE_INTERPRETERS = new Set(['python', 'python2', 'python3', 'py', 'node', 'nodejs', 'deno', 'bun', 'ruby', 'perl', 'php', 'lua']);

/** Transparent wrappers — we classify every command-candidate suffix after the wrapper's own
 *  options/operands. sudo/doas/su additionally count as privilege escalation. `command`/`exec`/
 *  `builtin` run a following command directly; `watch`/`parallel`/`flock -c` carry a shell string
 *  (handled before the suffix scan); `find` is a dangerous rule (its `-exec` syntax differs). */
const WRAPPERS = new Set([
  'sudo', 'doas', 'su', 'env', 'xargs', 'nohup', 'time', 'nice', 'ionice', 'timeout', 'stdbuf',
  'setsid', 'command', 'exec', 'builtin', 'watch', 'flock', 'chroot', 'parallel', 'busybox', 'toybox',
]);

/** Editors that run a shell via the ex `:!` escape (through `-c`/`+cmd`). */
const VIM_FAMILY = new Set(['vim', 'vi', 'view', 'nvim', 'ex', 'gvim', 'rvim', 'rview', 'vimdiff', 'evim']);

/** `git -c` config keys whose VALUE is a command git will run (penetrated as a command). Keys that
 *  instead point at an executable path (core.hooksPath/fsmonitor) are handled separately. */
const GIT_COMMAND_CONFIG =
  /^(alias\.|pager\.|core\.(pager|editor|sshcommand|askpass)|sequence\.editor|diff\.external|diff\..*\.command|merge\..*\.driver|filter\..*\.(clean|smudge|process)|gpg\.(program|.*\.program)|uploadpack\.|receivepack\.|protocol\..*\.command)/;

/** node-family: `-v`/`-V` both print version and exit (safe). */
const NODE_FAMILY = new Set(['node', 'nodejs', 'deno', 'bun']);
/** python-family: `-V` prints version and exits, but `-v` is verbose (still runs). */
const PYTHON_FAMILY = new Set(['python', 'python2', 'python3', 'py']);

/** A `VAR=VAL` assignment word (leading env in a command, e.g. `FOO=bar cmd`). */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** True when a non-shell interpreter is asked to run inline code (`-c`, `-e`, `--eval`, `-p`), or a
 *  COMBINED short bundle that contains an eval letter (`-ic`, `-pe`): the code is opaque, refuse. */
function hasInlineCodeFlag(args: string[]): boolean {
  return args.some(
    (a) =>
      a === '-c' ||
      a === '-e' ||
      a === '--eval' ||
      a === '-p' ||
      a === '--print' ||
      a === '--eval-file' ||
      (/^-[a-z]+$/.test(a) && (a.includes('c') || a.includes('e'))),
  );
}

/** True when an interpreter is invoked only to print version/help and exit, so it runs no program.
 *  The short version flag is interpreter-specific: `-v`/`-V` for node-family, `-V` for
 *  python-family and perl, `-v`/`-V` for perl; everywhere else (notably ruby, where `-v`/`-V` are
 *  verbose and still execute) only the universal long forms exempt. */
function isInfoOnly(prog: string, args: string[]): boolean {
  const has = (f: string): boolean => args.includes(f);
  if (has('--version') || has('-h') || has('--help') || has('-?')) return true;
  if (NODE_FAMILY.has(prog) && (has('-v') || has('-V'))) return true;
  if ((PYTHON_FAMILY.has(prog) || prog === 'perl') && has('-V')) return true;
  if (prog === 'perl' && has('-v')) return true;
  return false;
}

/** The shell command string a `watch`/`parallel` invocation runs. Skip only the WRAPPER's own
 *  leading options (and `-n`/`-j`-style value options), then take the rest VERBATIM — the inner
 *  command keeps its own flags (so `watch rm -rf /` stays `rm -rf /`, not `rm /`). For `parallel`,
 *  the command template ends at `:::`/`::::`. */
function commandOperand(prog: string, args: string[]): string {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '-n' || a === '--interval' || a === '--jobs' || a === '-j' || a === '-P') {
      i += 2; // option + its value
      continue;
    }
    if (a.startsWith('-')) {
      i++;
      continue;
    }
    break; // first non-option token — the inner command starts here
  }
  const rest = args.slice(i);
  if (prog === 'parallel') {
    const stop = rest.findIndex((a) => a === ':::' || a === '::::' || a === ':::+' || a === '::::+');
    return (stop >= 0 ? rest.slice(0, stop) : rest).join(' ');
  }
  return rest.join(' ');
}

/** The string after a shell's `-c` — including a COMBINED short bundle that contains `c`
 *  (`-lc`, `-ec`, `-euxc`): the next operand is the command string. Returns undefined otherwise. */
function inlineShellString(args: string[]): string | undefined {
  const i = args.findIndex((a) => a === '-c' || /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return undefined;
}

/** True when a shell is given a script file to run (a non-flag, non-`-c` operand). */
function runsAScriptFile(args: string[]): boolean {
  return args.some((a) => !a.startsWith('-') && a !== '-c');
}

// ----------------------------------------------------------------------------------------------
// Tokenizer (POSIX subset) + segmentation.
// ----------------------------------------------------------------------------------------------

type Token =
  | { kind: 'word'; value: string }
  | { kind: 'op'; value: '|' | '||' | '&&' | ';' | '&' }
  | { kind: 'redirect' } // a `>`/`>>`/`<` etc.; the following word is its target
  | { kind: 'subst'; inner: string }; // $(...) or `...`, inner command to penetrate

/**
 * Tokenize a POSIX-ish command line. Honors single quotes (fully literal), double quotes (with
 * `\` escaping `"`/`\`/`$`/backtick), backslash escapes, `$(...)`/backtick substitutions, the
 * control operators `| || && ; &`, grouping `()`, and redirections. Throws on an unterminated
 * quote or substitution so the caller fails closed.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let word = '';
  let inWord = false;

  const flushWord = (): void => {
    if (inWord) {
      tokens.push({ kind: 'word', value: word });
      word = '';
      inWord = false;
    }
  };

  while (i < input.length) {
    const ch = input[i];

    if (ch === ' ' || ch === '\t') {
      flushWord();
      i++;
      continue;
    }
    // A newline ends a command (like `;`), so `echo ok\nrm -rf /` is TWO commands, not one with
    // `rm` demoted to an argument. (A backslash-newline continuation is handled by the `\` branch.)
    if (ch === '\n' || ch === '\r') {
      flushWord();
      tokens.push({ kind: 'op', value: ';' });
      i++;
      continue;
    }

    // Command substitution: $(...) with nested-paren balancing. Flush the current word so the
    // subst is its own token (we penetrate it regardless of position; merging words across it
    // isn't needed for safety).
    if (ch === '$' && input[i + 1] === '(') {
      flushWord();
      const { inner, next } = readBalanced(input, i + 2, '(', ')');
      tokens.push({ kind: 'subst', inner });
      i = next;
      continue;
    }
    // ANSI-C quoting $'...': the $ is consumed and the content is a literal string (NOT a `$word`).
    // Without this, `bash -c $'git push --force'` parses program as `$git` and slips past. If the
    // content has backslash escapes we don't decode (`$'\x72\x6d'`), fail closed by throwing.
    if (ch === '$' && input[i + 1] === "'") {
      const end = input.indexOf("'", i + 2);
      if (end < 0) throw new Error("unterminated $'...' quote");
      const content = input.slice(i + 2, end);
      if (content.includes('\\')) throw new Error("$'...' with escape sequences — cannot verify");
      word += content;
      inWord = true;
      i = end + 1;
      continue;
    }
    // Locale quoting $"...": the $ is dropped; the rest is a normal double-quoted string.
    if (ch === '$' && input[i + 1] === '"') {
      i++; // consume the $, let the " be handled by the double-quote branch next iteration
      continue;
    }
    // Backtick substitution.
    if (ch === '`') {
      flushWord();
      const end = input.indexOf('`', i + 1);
      if (end < 0) throw new Error('unterminated backtick substitution');
      tokens.push({ kind: 'subst', inner: input.slice(i + 1, end) });
      i = end + 1;
      continue;
    }

    // Single quotes: everything literal until the next single quote.
    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) throw new Error('unterminated single quote');
      word += input.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }

    // Double quotes: literal except \ before " \ $ ` and substitutions inside.
    if (ch === '"') {
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length && '"\\$`'.includes(input[i + 1])) {
          word += input[i + 1];
          i += 2;
        } else if (input[i] === '$' && input[i + 1] === '(') {
          const { inner, next } = readBalanced(input, i + 2, '(', ')');
          tokens.push({ kind: 'subst', inner });
          i = next;
        } else if (input[i] === '`') {
          const end = input.indexOf('`', i + 1);
          if (end < 0) throw new Error('unterminated backtick in double quote');
          tokens.push({ kind: 'subst', inner: input.slice(i + 1, end) });
          i = end + 1;
        } else {
          word += input[i];
          i++;
        }
      }
      if (i >= input.length) throw new Error('unterminated double quote');
      inWord = true;
      i++; // closing "
      continue;
    }

    // Backslash escape outside quotes.
    if (ch === '\\') {
      if (input[i + 1] === '\n' || input[i + 1] === '\r') {
        i += 2; // line continuation — backslash-newline is removed, no word break
      } else if (i + 1 < input.length) {
        word += input[i + 1];
        inWord = true;
        i += 2;
      } else {
        i++; // trailing backslash — ignore
      }
      continue;
    }

    // Control operators.
    if (ch === '|') {
      flushWord();
      if (input[i + 1] === '|') { tokens.push({ kind: 'op', value: '||' }); i += 2; }
      else { tokens.push({ kind: 'op', value: '|' }); i++; }
      continue;
    }
    if (ch === '&') {
      flushWord();
      if (input[i + 1] === '&') { tokens.push({ kind: 'op', value: '&&' }); i += 2; }
      else { tokens.push({ kind: 'op', value: '&' }); i++; }
      continue;
    }
    if (ch === ';') {
      flushWord();
      tokens.push({ kind: 'op', value: ';' });
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      // Grouping/subshell — treat as a segment boundary (the contents are analyzed as their own
      // segments by virtue of the surrounding operators). Flush and skip the paren.
      flushWord();
      tokens.push({ kind: 'op', value: ';' });
      i++;
      continue;
    }
    // Redirections (optionally fd-prefixed like `2>`): emit a redirect marker; target is next word.
    if (ch === '>' || ch === '<') {
      flushWord();
      tokens.push({ kind: 'redirect' });
      i += ch === '>' && input[i + 1] === '>' ? 2 : 1;
      continue;
    }
    // A leading fd digit before a redirect (`2>`): peek.
    if (/[0-9]/.test(ch) && (input[i + 1] === '>' || input[i + 1] === '<')) {
      flushWord();
      tokens.push({ kind: 'redirect' });
      i += input[i + 2] === '>' ? 3 : 2;
      continue;
    }

    // Ordinary character.
    word += ch;
    inWord = true;
    i++;
  }
  flushWord();
  return tokens;
}

/** Read a substring with balanced delimiters starting just after an opener; returns the inner
 *  text and the index past the matching closer. Throws if unbalanced. */
function readBalanced(input: string, start: number, open: string, close: string): { inner: string; next: number } {
  let depth = 1;
  let i = start;
  while (i < input.length) {
    if (input[i] === open) depth++;
    else if (input[i] === close) {
      depth--;
      if (depth === 0) return { inner: input.slice(start, i), next: i + 1 };
    }
    i++;
  }
  throw new Error('unterminated command substitution');
}

/** Split a token stream into segments at the control operators `| || && ; &`. Each segment is the
 *  words (and redirects/substitutions) of one simple command. */
function splitSegments(tokens: Token[]): Token[][] {
  const segments: Token[][] = [];
  let current: Token[] = [];
  for (const tok of tokens) {
    if (tok.kind === 'op') {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push(tok);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** Turn one segment's tokens into a SimpleCommand: first word is the program, the rest are args,
 *  and any word following a redirect marker is a redirect target. Substitutions are skipped here
 *  (penetrated separately). Returns undefined when there's no program word. */
function toSimpleCommand(segment: Token[]): SimpleCommand | undefined {
  const words: string[] = [];
  const redirectTargets: string[] = [];
  let expectTarget = false;
  for (const tok of segment) {
    if (tok.kind === 'redirect') { expectTarget = true; continue; }
    if (tok.kind === 'word') {
      if (expectTarget) { redirectTargets.push(tok.value); expectTarget = false; }
      else words.push(tok.value);
    }
    // subst tokens contribute no word here
  }
  // Skip leading `VAR=VAL` assignments so `FOO=bar rm -rf /` is seen as `rm`, not a program named
  // `FOO=bar` with `rm` demoted to an argument (the same leak the wrapper scan guards against).
  let p = 0;
  while (p < words.length && ASSIGNMENT.test(words[p])) p++;
  if (p >= words.length) {
    // No program word. But a redirection still acts on the filesystem (`FOO=bar > .env`, bare
    // `> .env` truncates a secret), so surface those targets for the secret-path check.
    return redirectTargets.length > 0 ? { program: '', args: [], redirectTargets } : undefined;
  }
  return { program: words[p], args: words.slice(p + 1), redirectTargets };
}

// ----------------------------------------------------------------------------------------------
// Small helpers.
// ----------------------------------------------------------------------------------------------

/** The first secret-bearing path among program, args, and redirect targets, or undefined. */
function secretHit(cmd: SimpleCommand, policy: PermissionPolicy): string | undefined {
  const candidates = [cmd.program, ...cmd.args, ...cmd.redirectTargets];
  for (const c of candidates) {
    if (policy.sensitivePaths.some((re) => re.test(normalize(c)))) return c;
  }
  return undefined;
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

/** The final path component of a program (so `/usr/bin/rm` and `rm` classify the same). */
function basename(program: string): string {
  const norm = program.replace(/\\/g, '/');
  const slash = norm.lastIndexOf('/');
  return slash >= 0 ? norm.slice(slash + 1) : norm;
}

/** A combined short flag like `-rf` includes letter `r`/`f`; `--long` forms are excluded here. */
function hasShort(args: string[], letter: string): boolean {
  return args.some((a) => /^-[A-Za-z]+$/.test(a) && a.slice(1).includes(letter));
}

function hasLong(args: string[], name: string): boolean {
  return args.some((a) => a === name || a.startsWith(`${name}=`));
}

function danger(reason: string): Verdict {
  return { danger: true, sensitive: false, reason };
}

function clean(): Verdict {
  return { danger: false, sensitive: false };
}

/** Merge two verdicts keeping the worst; the first set reason wins (reasons are only set together
 *  with a positive danger/sensitive flag, so `a.reason ?? b.reason` is the earliest explanation). */
function combine(a: Verdict, b: Verdict): Verdict {
  return { danger: a.danger || b.danger, sensitive: a.sensitive || b.sensitive, reason: a.reason ?? b.reason };
}
