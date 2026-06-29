/**
 * checks — the deterministic two legs of goal verification (Phase D; Part7 §2 legs 1-2). These run
 * BEFORE any subjective judge and can't be bypassed by prompt injection — the cheapest, most
 * tamper-proof layer.
 *
 *  - **Leg 1**: the harness RE-RUNS the project's canonical check commands and trusts the REAL exit
 *    codes (`ExecResult.code`), never the builder's self-reported status. The command list comes from
 *    config, NEVER from the builder's claim, so a builder can't swap in a trivial command.
 *  - **Leg 2**: a deterministic git-diff scan of the test files vs the goal's creation-time baseline.
 *    Deleted / skipped / shrunk test files force a rejection — the most common reward-hacking shortcut.
 *
 * {@link classifyTestDiff} is PURE (unit-testable without a git repo); {@link runDeterministicChecks}
 * is the impure shell that runs the commands + git and feeds the pure classifier.
 */
import { runCommand } from '../../core/tools/run-command.js';
import type { DeterministicChecks, TestBaseline } from './goal.js';

/** Slow enough for a real build/test. */
const CHECK_TIMEOUT_MS = 300_000;
/** Per-check captured output cap (enough for a rejection continuation, bounded). */
const CHECK_OUTPUT_CHARS = 20_000;
/** git diff can be large; cap high so a real tamper deep in the diff isn't truncated away. */
const DIFF_OUTPUT_CHARS = 500_000;

/** Project canonical checks when a goal doesn't override (Jarvis's own four gates). */
export const DEFAULT_CHECK_COMMANDS = ['npm run typecheck', 'npm run lint', 'npm test', 'npm run build'];

/** git pathspec for the test tree (Jarvis convention). Overridable per goal. */
export const DEFAULT_TEST_PATHSPEC = 'test/';

/** True for a path that counts as a test file (used by the pure classifier as a second filter). */
const TEST_PATH = /(^|\/)(test|tests|__tests__|spec)\//i;
const TEST_FILE = /\.(test|spec)\.[tj]sx?$/i;
function isTestPath(p: string): boolean {
  return TEST_PATH.test(p) || TEST_FILE.test(p);
}

const CASE = /\b(?:it|test|describe)\s*\(/; // a test-case declaration
const SKIP = /\.(?:skip|only)\b|\bxit\b|\bxdescribe\b/; // a skip/only marker

export interface CheckDeps {
  shellPath: string;
  cwd: string;
  /** Fixed check commands — sourced from config, NEVER from the builder's claim. */
  checkCommands: string[];
  /** git pathspec for the test tree (leg 2). */
  testPathspec?: string;
  signal?: AbortSignal;
}

/**
 * Run both deterministic legs. Leg 1 re-runs every check command and ANDs the real exit codes. Leg 2
 * diffs the test tree vs the baseline and classifies tampering. No baseline (not a git repo / snapshot
 * failed) → leg 2 is inert (reported clean) — a known gap this batch, not a silent pass of leg 1.
 */
export async function runDeterministicChecks(
  deps: CheckDeps,
  baseline?: TestBaseline,
): Promise<DeterministicChecks> {
  const results: DeterministicChecks['results'] = [];
  let objectiveChecksPassed = true;
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

  return { objectiveChecksPassed, results, ...tamper };
}

/** Diff the test tree vs the baseline commit and classify. A failed git invocation → inert (clean). */
async function scanTestTamper(
  deps: CheckDeps,
  baseline: TestBaseline,
): Promise<{ testTamper: 'clean' | 'weakened-or-deleted'; tamperReason: string }> {
  const pathspec = deps.testPathspec ?? DEFAULT_TEST_PATHSPEC;
  const res = await runCommand(
    deps.shellPath,
    `git diff --no-color ${baseline.headSha} -- ${pathspec}`,
    deps.cwd,
    60_000,
    DIFF_OUTPUT_CHARS,
    deps.signal,
  );
  if (res.code !== 0) return { testTamper: 'clean', tamperReason: '' }; // git failed → inert (gap noted)
  return classifyTestDiff(res.output);
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
