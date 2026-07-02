/**
 * checks — the deterministic legs of goal verification (Phase D; Part7 §2). These run BEFORE any
 * subjective judge and can't be bypassed by prompt injection — the cheapest, most tamper-proof layer.
 *
 *  - **Leg 1**: the harness RE-RUNS the project's canonical check commands and trusts the REAL exit
 *    codes (`ExecResult.code`), never the builder's self-reported status. The command list comes from
 *    config, NEVER from the builder's claim, so a builder can't swap in a trivial command.
 *  - **Leg 2**: a deterministic git-diff scan of the test files vs the goal's creation-time baseline.
 *    Deleted / skipped / shrunk test files force a rejection — the most common reward-hacking shortcut.
 *  - **Held-out leg**: SECRET hidden-assertion commands the builder never sees. Leg 1 re-runs the
 *    checks the builder KNOWS (catches "suite red"); the held-out leg runs the goal-setter's hidden
 *    assertions (catches "builder wrote weak self-passing tests" — it can't game what it can't see).
 *    Only runs when leg 1 is green; absent when no held-out commands are configured.
 *
 * {@link classifyTestDiff} is PURE (unit-testable without a git repo); {@link runDeterministicChecks}
 * is the impure shell that runs the commands + git and feeds the pure classifier.
 */
import { runCommand } from '../../core/tools/run-command.js';
import type {
  DeterministicChecks,
  HeldOutResult,
  TestBaseline,
  WorktreeChangePolicy,
  WorktreeStatusBaseline,
  WorktreeStatusCheck,
} from './goal.js';

/** Slow enough for a real build/test. */
const CHECK_TIMEOUT_MS = 300_000;
/** Per-check captured output cap (enough for a rejection continuation, bounded). */
const CHECK_OUTPUT_CHARS = 20_000;
/** git diff can be large; cap high so a real tamper deep in the diff isn't truncated away. */
const DIFF_OUTPUT_CHARS = 500_000;
const WORKTREE_STATUS_COMMAND = 'git status --porcelain --untracked-files=all' as const;
const WORKTREE_STATUS_OUTPUT_CHARS = 200_000;

/** Project canonical checks when a goal doesn't override (Jarvis's own four gates). */
export const DEFAULT_CHECK_COMMANDS = ['npm run typecheck', 'npm run lint', 'npm test', 'npm run build'];

/** True for a path that counts as a test file (used by the pure classifier as a second filter). */
const TEST_PATH = /(^|\/)(test|tests|__tests__|spec)\//i;
const TEST_FILE = /\.(test|spec)\.[tj]sx?$/i;
function isTestPath(p: string): boolean {
  return TEST_PATH.test(p) || TEST_FILE.test(p);
}

/** Files that DEFINE what the check commands do — editing them changes the verification ORACLE
 *  itself (e.g. package.json `scripts.test` → `exit 0`), neutralizing leg 1 WITHOUT touching test/.
 *  Treated as tampering (closes the "neutralize the oracle" bypass, H-1). */
const CHECK_ORACLE =
  /(^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig(?:\.[\w-]+)?\.json|\.eslintrc(?:\.[\w-]+)?|eslint\.config\.[\w.]+|vitest\.config\.[\w.]+|vitest\.workspace\.[\w.]+|jest\.config\.[\w.]+)$/i;
function isCheckOracle(p: string): boolean {
  return CHECK_ORACLE.test(p);
}

const CASE = /\b(?:it|test|describe)\s*\(/; // a test-case declaration
const SKIP = /\.(?:skip|only|todo)\b|\b(?:xit|xdescribe|xtest|fit|fdescribe)\b/; // skip/only/focus marker

export interface CheckDeps {
  shellPath: string;
  cwd: string;
  /** Fixed check commands — sourced from config, NEVER from the builder's claim. */
  checkCommands: string[];
  /** Held-out leg: SECRET hidden-assertion commands the builder never sees — sourced from config, NEVER
   *  the claim, and (unlike checkCommands) never surfaced back to the builder. Absent/empty → no
   *  held-out leg (it stays `undefined` on the result; decideVerdict treats absence as "leg not run"). */
  heldOutCommands?: string[];
  /** Worktree status captured before the goal/loop run. Absent -> no worktree audit leg. */
  worktreeBaseline?: WorktreeStatusBaseline;
  /** `audit` records changes only; `forbid` makes any baseline drift reject. */
  worktreeChangePolicy?: WorktreeChangePolicy;
  signal?: AbortSignal;
}

/**
 * Run both deterministic legs. Leg 1 re-runs every check command and ANDs the real exit codes (empty
 * command list → fail closed). Leg 2 diffs the whole worktree vs the baseline and classifies tampering
 * over test files AND check-oracle files. No baseline (not a git repo) → leg 2 is inert (clean) — a
 * known gap; but a PRESENT baseline whose git diff fails or truncates fails CLOSED, not clean.
 */
export async function runDeterministicChecks(
  deps: CheckDeps,
  baseline?: TestBaseline,
): Promise<DeterministicChecks> {
  const worktreeStatus = deps.worktreeBaseline
    ? await scanWorktreeStatus(deps, deps.worktreeBaseline, deps.worktreeChangePolicy ?? 'audit')
    : undefined;
  if (worktreeStatus?.policy === 'forbid' && worktreeStatus.changed) {
    return {
      objectiveChecksPassed: false,
      results: [],
      testTamper: 'clean',
      tamperReason: '',
      worktreeStatus,
    };
  }

  const results: DeterministicChecks['results'] = [];
  // No check commands → nothing was actually verified → fail closed (a vacuous AND must not pass).
  let objectiveChecksPassed = deps.checkCommands.length > 0;
  for (const command of deps.checkCommands) {
    const res = await runCommand(
      deps.shellPath,
      command,
      deps.cwd,
      CHECK_TIMEOUT_MS,
      CHECK_OUTPUT_CHARS,
      deps.signal,
    );
    results.push({ command, code: res.code, output: res.output });
    if (res.code !== 0) objectiveChecksPassed = false; // trust the REAL exit code, not a self-report
  }

  const tamper = baseline
    ? await scanTestTamper(deps, baseline)
    : { testTamper: 'clean' as const, tamperReason: '' };

  // Held-out leg (the hidden-assertion leg). Run ONLY when leg 1 is green: a red leg 1 already rejects,
  // and the held-out leg's whole point is the "weak self-written tests pass (leg 1 green) but the real
  // requirement is unmet" case. Absent/empty held-out commands → no leg (heldOut stays undefined).
  const heldOut =
    objectiveChecksPassed && deps.heldOutCommands && deps.heldOutCommands.length > 0
      ? await runHeldOut(deps, deps.heldOutCommands)
      : undefined;

  return { objectiveChecksPassed, results, ...tamper, ...(worktreeStatus ? { worktreeStatus } : {}), ...(heldOut ? { heldOut } : {}) };
}

export async function snapshotWorktreeStatus(
  shellPath: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<WorktreeStatusBaseline | undefined> {
  const res = await runCommand(shellPath, WORKTREE_STATUS_COMMAND, cwd, 30_000, WORKTREE_STATUS_OUTPUT_CHARS, signal);
  if (res.code !== 0) return undefined;
  return { command: WORKTREE_STATUS_COMMAND, baseline: normalizePorcelainStatus(res.output) };
}

export function classifyWorktreeStatusChange(
  baseline: string,
  current: string,
): Pick<WorktreeStatusCheck, 'changed' | 'changedEntries'> {
  const baselineEntries = porcelainEntries(baseline);
  const currentEntries = porcelainEntries(current);
  const baselineSet = new Set(baselineEntries);
  const currentSet = new Set(currentEntries);
  const added = currentEntries.filter((entry) => !baselineSet.has(entry));
  const removed = baselineEntries
    .filter((entry) => !currentSet.has(entry))
    .map((entry) => `removed since baseline: ${entry}`);
  const changedEntries = [...added, ...removed];
  return { changed: changedEntries.length > 0, changedEntries };
}

/** Run the secret held-out commands and AND their real exit codes. Same trust model as leg 1 (the real
 *  exit code, never a self-report), but these commands are NEVER revealed to the builder. */
async function runHeldOut(deps: CheckDeps, commands: string[]): Promise<HeldOutResult> {
  const results: HeldOutResult['results'] = [];
  let passed = true;
  for (const command of commands) {
    const res = await runCommand(
      deps.shellPath,
      command,
      deps.cwd,
      CHECK_TIMEOUT_MS,
      CHECK_OUTPUT_CHARS,
      deps.signal,
    );
    results.push({ command, code: res.code, output: res.output });
    if (res.code !== 0) passed = false; // trust the REAL exit code
  }
  return { passed, results };
}

/** Diff the test tree vs the baseline commit and classify. A failed git invocation → inert (clean). */
async function scanTestTamper(
  deps: CheckDeps,
  baseline: TestBaseline,
): Promise<{ testTamper: 'clean' | 'weakened-or-deleted'; tamperReason: string }> {
  // Whole-worktree diff vs the baseline (no pathspec): classifyTestDiff filters to test files AND
  // check-oracle files, so ordinary source edits are ignored but neutralizing the oracle isn't.
  const res = await runCommand(
    deps.shellPath,
    `git diff --no-color ${baseline.headSha}`,
    deps.cwd,
    60_000,
    DIFF_OUTPUT_CHARS,
    deps.signal,
  );
  if (res.code !== 0) {
    // git failed with a baseline present (unreachable sha / broken index): we CANNOT confirm the
    // tests + oracle are untampered, so fail CLOSED rather than silently passing the leg.
    return {
      testTamper: 'weakened-or-deleted',
      tamperReason: `git diff failed (code ${res.code ?? 'killed'}); cannot verify tests untampered`,
    };
  }
  if (res.truncated) {
    // The diff hit the output cap — a tamper/oracle edit later in the (path-sorted) diff could be cut
    // off, so we cannot confirm clean. Fail closed rather than pass on a partial diff (else a builder
    // could bury a real edit behind a huge change to push it past the cap).
    return {
      testTamper: 'weakened-or-deleted',
      tamperReason: `git diff exceeded the ${DIFF_OUTPUT_CHARS}-char cap; cannot fully verify tests untampered`,
    };
  }
  return classifyTestDiff(res.output);
}

async function scanWorktreeStatus(
  deps: CheckDeps,
  baseline: WorktreeStatusBaseline,
  policy: WorktreeChangePolicy,
): Promise<WorktreeStatusCheck> {
  const res = await runCommand(
    deps.shellPath,
    WORKTREE_STATUS_COMMAND,
    deps.cwd,
    30_000,
    WORKTREE_STATUS_OUTPUT_CHARS,
    deps.signal,
  );
  if (res.code !== 0) {
    return {
      ...baseline,
      policy,
      current: '',
      changed: true,
      changedEntries: [],
      error: `git status failed (code ${res.code ?? 'killed'})`,
    };
  }
  if (res.truncated) {
    return {
      ...baseline,
      policy,
      current: normalizePorcelainStatus(res.output),
      changed: true,
      changedEntries: [],
      error: `git status exceeded the ${WORKTREE_STATUS_OUTPUT_CHARS}-char cap`,
    };
  }
  const current = normalizePorcelainStatus(res.output);
  return { ...baseline, policy, current, ...classifyWorktreeStatusChange(baseline.baseline, current) };
}

function normalizePorcelainStatus(text: string): string {
  return porcelainEntries(text).join('\n');
}

function porcelainEntries(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line !== '');
}

/**
 * PURE: classify a unified git diff for test tampering. Fires on the deterministically-detectable
 * shortcuts (Part7 §9 admits semantic weakening like `toBe`→`toBeDefined` is NOT detectable here —
 * that's leg 3's job):
 *  - a test file deleted,
 *  - a skip/only marker added (`.skip` / `.only` / `xit` / `xdescribe`),
 *  - net test-case count drop (more `it(`/`test(`/`describe(` removed than added).
 */
export function classifyTestDiff(diff: string): {
  testTamper: 'clean' | 'weakened-or-deleted';
  tamperReason: string;
} {
  let currentFile = '';
  let isTest = false;
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      const m = /b\/(\S+)/.exec(line);
      currentFile = m ? m[1] : '';
      if (isCheckOracle(currentFile)) {
        // editing a check-oracle file neutralizes leg 1 — fail closed regardless of its contents.
        return {
          testTamper: 'weakened-or-deleted',
          tamperReason: `check-oracle file modified: ${currentFile}`,
        };
      }
      isTest = isTestPath(currentFile);
      continue;
    }
    if (!isTest) continue;
    if (line.startsWith('deleted file mode')) {
      return { testTamper: 'weakened-or-deleted', tamperReason: `test file deleted: ${currentFile}` };
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue; // file headers, not content
    if (line.startsWith('+')) {
      if (SKIP.test(line)) {
        return { testTamper: 'weakened-or-deleted', tamperReason: `skip/only added in ${currentFile}` };
      }
      if (CASE.test(line)) added++;
    } else if (line.startsWith('-')) {
      if (CASE.test(line)) removed++;
    }
  }
  if (removed > added) {
    return {
      testTamper: 'weakened-or-deleted',
      tamperReason: `test cases dropped (${removed} removed vs ${added} added)`,
    };
  }
  return { testTamper: 'clean', tamperReason: '' };
}
