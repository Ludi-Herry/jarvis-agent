/**
 * goal — the Goal as a first-class persistent object + the verdict/checks vocabulary (Phase D).
 *
 * A Goal is the unit of autonomy: an immutable `objective`, a state machine, a budget, and (for the
 * tamper leg) a test baseline snapshot. The GoalLoop (goal-loop.ts) drives a builder agent toward it
 * over many rounds and only marks it complete after independent verification — never on the builder's
 * own say-so (blueprint §9; Part7 "judge ≠ player").
 *
 * This file is types only. The pure decision points live in state.ts (advanceGoalState) and
 * verdict.ts (decideVerdict); persistence in runtime/goal/goal-store.ts.
 *
 * Leg 3 (the independent LLM judge) is DEFERRED this batch: the `VerifierReport` / evidence-strength
 * vocabulary is defined so the seam is typed, but no verifier is spawned and `decideVerdict` treats a
 * present report as fail-closed (see verdict.ts).
 */

/** The goal state machine (a subset for this batch: active → complete | blocked). `active` keeps the
 *  loop running; `complete` is a verified finish; `blocked` is fail-closed (handed to a human). */
export type GoalState = 'active' | 'complete' | 'blocked';

/** The verifier verdict — three states (Part7). `couldNotVerify` is the fail-closed third state that
 *  a binary allow/deny lacks: "couldn't prove done" must never collapse into "done". */
export type VerdictOutcome = 'verified' | 'rejected' | 'couldNotVerify';

/** What a builder claims when it calls `update_goal`. `verification` is the builder's self-report of
 *  what it ran — treated as a HINT only; the harness never trusts it to decide the verdict. */
export interface GoalClaim {
  status: 'complete' | 'blocked';
  verification?: string;
}

/** The deterministic two legs' result (harness-produced; fed to the pure decideVerdict). */
export interface DeterministicChecks {
  /** Leg 1: the AND of every canonical check command's real exit code (harness re-ran them). */
  objectiveChecksPassed: boolean;
  /** What leg 1 actually ran — observable, and the basis for the rejection continuation. */
  results: Array<{ command: string; code: number | null; output: string }>;
  /** Leg 2: deterministic git-diff scan of the test files vs the goal's baseline. */
  testTamper: 'clean' | 'weakened-or-deleted';
  /** Why leg 2 fired (for the continuation / verdict rationale), or '' when clean. */
  tamperReason: string;
}

// ── Leg 3 vocabulary (DEFERRED this batch; types only so the seam is stable) ──

/** Evidence strength five-classes (Part7, borrowed from the completion audit). */
export type EvidenceStrength = 'proves' | 'contradicts' | 'incomplete' | 'tooWeak' | 'missing';
/** Claim scope axis — a narrow check must not support a broad claim (Part7). */
export type ClaimScope = 'matched' | 'narrowerThanClaim';

/** A pinned requirement: derived once at goal creation, then immutable (leg 3 scores each one). */
export interface PinnedRequirement {
  id: string;
  text: string;
}

/** The independent verifier's report (leg 3, deferred). `verdict` is NOT here — it's computed by the
 *  pure decideVerdict, never self-reported (Part7 removes the double source of truth). */
export interface VerifierReport {
  feature: 'works' | 'broken';
  expected: string;
  observed: string;
  evidence: string;
  perRequirement: Array<{ requirementId: string; strength: EvidenceStrength; scope: ClaimScope }>;
  couldNotVerify: string[];
  rationale: string;
}

/** The verdict produced by decideVerdict (pure). `report` is present only once leg 3 is enabled. */
export interface Verdict {
  outcome: VerdictOutcome;
  rationale: string;
  report?: VerifierReport;
}

/** Goal-level budget (separate from the per-runAgent {@link Budget}, which stays {maxTurns}). */
export interface GoalBudget {
  /** Hard cap on verification rounds (the outer loop's backstop). */
  maxRounds: number;
  /** Optional cap on cumulative builder turns across all rounds (summed from RunOutcome.turns). */
  maxTotalTurns?: number;
  /** Optional cap on cumulative tokens (summed from the bus `usage` events). */
  maxTotalTokens?: number;
}

/** Leg 2 baseline, snapshotted at goal creation so tamper detection is immune to pre-goal dirty
 *  changes and survives a restart (Part7 point 4). Absent when not a git repo. */
export interface TestBaseline {
  headSha: string;
  testFiles: Array<{ path: string; blobHash: string }>;
}

/** A goal: an immutable objective + state + budget + (optional) test baseline + the session it drives. */
export interface Goal {
  id: string;
  /** The objective — IMMUTABLE after creation; verified against {@link objectiveHash}. */
  objective: string;
  objectiveHash: string;
  state: GoalState;
  budget: GoalBudget;
  testBaseline?: TestBaseline;
  /** The conversation log id this goal drives (cross-reference; messages live in the SessionStore). */
  sessionId: string;
  createdAt: string;
}
