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
 * Leg 3 (the independent LLM judge) is LANDED this batch: a goal carries the harness-pinned
 * requirement list (`pinned`), and once a verifier provider is configured `decideVerdict` scores a
 * present `VerifierReport` over the evidence_strength × claim_scope table (Part7 §4) instead of
 * failing it closed. With no verifier configured the `report===undefined` path is the batch-1
 * deterministic-only fallback, unchanged.
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

/** The held-out leg's result: secret hidden-assertion commands the builder NEVER sees. Leg 1 re-runs
 *  the checks the builder KNOWS (catches "suite red"); the held-out leg runs the goal-setter's SECRET
 *  assertions (catches "builder wrote weak self-passing tests" — it can't game what it can't see). A
 *  held-out result that is `undefined` on {@link DeterministicChecks} means NO held-out leg was
 *  configured: the leg is ABSENT (a known weaker-confidence state), neither a pass nor a fail. */
export interface HeldOutResult {
  /** AND of every held-out command's real exit code (harness ran them; trusts the codes). */
  passed: boolean;
  /** The commands + output — for the LOCAL audit log (goalStore) ONLY. NEVER fed back to the builder
   *  or put on the EventBus, or the assertions would stop being held-out. */
  results: Array<{ command: string; code: number | null; output: string }>;
}

/** The deterministic legs' result (harness-produced; fed to the pure decideVerdict). */
export interface DeterministicChecks {
  /** Leg 1: the AND of every canonical check command's real exit code (harness re-ran them). */
  objectiveChecksPassed: boolean;
  /** What leg 1 actually ran — observable, and the basis for the rejection continuation. */
  results: Array<{ command: string; code: number | null; output: string }>;
  /** Leg 2: deterministic git-diff scan of the test files vs the goal's baseline. */
  testTamper: 'clean' | 'weakened-or-deleted';
  /** Why leg 2 fired (for the continuation / verdict rationale), or '' when clean. */
  tamperReason: string;
  /** Held-out leg: secret hidden assertions the builder never sees. `undefined` = leg not configured
   *  (absent — a known weaker-confidence state, surfaced explicitly; NOT treated as a pass). */
  heldOut?: HeldOutResult;
}

// ── Leg 3 vocabulary (the independent LLM judge — landed this batch) ──

/** Evidence strength (Part7's five-classes borrowed from the completion audit, + `cannotVerify`).
 *  `cannotVerify` separates "I could NOT verify this requirement locally" (→ park to a human) from
 *  `incomplete`/`missing` (= "I inspected it and it is partial/absent" → reject, builder fixes). Without
 *  it the judge had to overload incomplete/missing for execution/external requirements it can't check,
 *  which `decideVerdict` then hard-rejected — looping the builder on work it actually did. */
export type EvidenceStrength =
  | 'proves'
  | 'contradicts'
  | 'incomplete'
  | 'tooWeak'
  | 'missing'
  | 'cannotVerify';
/** Claim scope axis — a narrow check must not support a broad claim (Part7). */
export type ClaimScope = 'matched' | 'narrowerThanClaim';

/** A pinned requirement: derived once at goal creation (one LLM decomposition of the objective),
 *  then immutable. The verifier scores EVERY one (decideVerdict fails closed on any unscored), so the
 *  builder can neither narrow the requirement set nor influence what gets judged (Part7 §3.2 step 3). */
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
  /** Harness-pinned requirement list (leg 3), derived once at creation then immutable. Empty when no
   *  verifier is configured (batch-1 deterministic-only fallback) — the verifier scores each entry. */
  pinned: PinnedRequirement[];
  /** The conversation log id this goal drives (cross-reference; messages live in the SessionStore). */
  sessionId: string;
  createdAt: string;
}
