# Loop Mid-Goal Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume a loop item that crashed after `goal-started` without losing the in-progress goal conversation, verification history, or goal id.

**Architecture:** Keep `runGoal` as the only component allowed to finish a goal. `replayLoop` identifies logged attempts by index, `runLoop` reuses their latest `goalId`, and `loop-cli` loads the existing goal/session JSONL before calling `runGoal`. Cwd loop logs are not trusted for completion, verifier health, or token seeds; logged attempts are rechecked before a fresh `goal-finished` line is recorded. `runGoal` receives an explicit resume state, skips duplicate headers, seeds prior messages/rounds/turns/tokens/breaker state, and still routes all completion through deterministic checks, optional leg 3, and `decideVerdict`.

**Tech Stack:** TypeScript strict ESM, Vitest, append-only JSONL stores, existing `FileGoalStore`, `FileSessionStore`, `runLoop`, and `runGoal`.

---

## Scope

This plan implements only the first safe loop heavy slice: mid-goal resume.

Deferred slices stay separate:

- Per-goal heterogeneous verifier: needs a queue item schema and verifier config per objective.
- Parallel goals: needs worktree isolation and shared resource policy.
- Cron/daemon loop: needs a process lifecycle contract, reporting path, and OS-level supervision choices.

## Invariants

- `runLoop` still has zero completion authority. It records the state returned by `runOne` and never imports `decideVerdict`.
- `runGoal` still gates completion through the existing verification legs. A resumed active goal cannot become complete without a fresh or already-persisted verified verdict.
- A resumed terminal `complete` goal must have a persisted final verdict with `outcome === 'verified'`, then `runGoal` reruns verification before loop records `goal-finished`; malformed logs fail closed.
- A resumed active goal restores the reject breaker from persisted `goal-round` verdicts, so two prior rejects plus one new reject trips the guardrail.
- Resume does not trust `data/goals/<goalId>.jsonl` for verification parameters: caller-supplied baseline/pinned are used, and CLI resume recomputes them.
- Session resume reuses the existing `data/sessions/<goalId>.jsonl` cursor; it does not write a duplicate session header.
- Session resume requires a valid session header matching goal id and cwd.
- Goal resume reuses the existing `data/goals/<goalId>.jsonl`; it does not write a duplicate `goal-created` record.
- `loop-halted` human checkpoints still apply before any resumed item runs.
- `data/loops/*.jsonl` under cwd supplies queue/contract/goalId only; `goal-finished.state/outcome/tokens` are audit fields and do not seed skip sets, verifier health, or budget.

## Files

- Modify: `src/capabilities/goal/loop-store.ts`
  - Add resumable logged attempts to `LoopReplay`.
  - Make `replayLoop` fold both `goal-started` and `goal-finished` into that map without trusting finished state/outcome/tokens.
- Modify: `src/capabilities/goal/loop.ts`
  - Pass resume metadata into `runOne`.
  - Reuse in-flight goal ids from replay.
- Modify: `src/capabilities/goal/goal-loop.ts`
  - Add explicit `GoalResumeState`.
  - Seed goal/messages/round count/breaker from resume state.
  - Validate terminal resume states fail closed on malformed completion logs.
- Modify: `src/surfaces/cli/loop-cli.ts`
  - Import `loadGoal` and `loadSession`.
  - On resumed in-flight attempts, load the existing goal/session logs and pass them to `runGoal`.
  - Construct `FileSessionStore(sessionPath, replayed.messages.length)` on resume.
- Test: `test/capabilities/goal/loop-store.test.ts`
- Test: `test/capabilities/goal/loop.test.ts`
- Test: `test/capabilities/goal/goal-loop.test.ts`

---

### Task 1: Teach LoopStore To Replay In-Flight Attempts

**Files:**
- Modify: `src/capabilities/goal/loop-store.ts`
- Test: `test/capabilities/goal/loop-store.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test to `test/capabilities/goal/loop-store.test.ts`:

```ts
it('replays the latest started-without-finished goal as an in-flight resume attempt', async () => {
  const path = join(dir, 'L-inflight.jsonl');
  const store = new FileLoopStore(path);
  await store.writeCreated({ id: 'L', contract: CONTRACT, objectives: ['a', 'b', 'c'], createdAt: 't0' });
  await store.recordStarted({ index: 0, goalId: 'L-g0-old', at: 't1' });
  await store.recordFinished({ index: 0, goalId: 'L-g0-old', state: 'complete', outcome: 'verified', rounds: 1, tokens: 10, at: 't2' });
  await store.recordStarted({ index: 1, goalId: 'L-g1-first', at: 't3' });
  await store.recordStarted({ index: 1, goalId: 'L-g1-resume', at: 't4' });

  const replay = await loadLoop(path);

  expect([...replay.finished]).toEqual([]);
  expect([...replay.inFlight]).toEqual([
    [0, 'L-g0-old'],
    [1, 'L-g1-resume'],
  ]);
});
```

- [ ] **Step 2: Run RED**

Run:

```powershell
npm test -- test/capabilities/goal/loop-store.test.ts
```

Expected: fails because `LoopReplay` has no `inFlight` property.

- [ ] **Step 3: Implement the minimal replay state**

In `src/capabilities/goal/loop-store.ts`, extend `LoopReplay`:

```ts
/** Logged attempts to recheck, keyed by queue index. Sequential loop has at most one, but a map keeps replay future-compatible. */
inFlight: Map<number, string>;
```

In `replayLoop`, add:

```ts
const inFlight = new Map<number, string>();
```

Handle records:

```ts
case 'goal-started':
  inFlight.set(record.index, record.goalId);
  break;
case 'goal-finished':
  inFlight.set(record.index, record.goalId);
  break;
```

Return it:

```ts
return { id, contract, objectives, finished, inFlight, outcomes, goalsFinished: finished.size, cumulativeTokens, consecutiveBlocked, halted };
```

- [ ] **Step 4: Run GREEN**

Run:

```powershell
npm test -- test/capabilities/goal/loop-store.test.ts
```

Expected: all loop-store tests pass.

---

### Task 2: Make RunLoop Reuse In-Flight Goal IDs

**Files:**
- Modify: `src/capabilities/goal/loop.ts`
- Test: `test/capabilities/goal/loop.test.ts`

- [ ] **Step 1: Write the failing test**

Add the test under `describe('runLoop - resume', ...)`:

```ts
it('reuses an in-flight goalId on resume and tells runOne it is resuming', async () => {
  const bus = new InMemoryEventBus();
  const { store, records } = fakeStore();
  const calls: Array<{ objective: string; goalId: string; resumed: boolean; index: number }> = [];
  const runOne = async (objective: string, goalId: string, attempt: { index: number; resumed: boolean }): Promise<GoalRunSummary> => {
    calls.push({ objective, goalId, resumed: attempt.resumed, index: attempt.index });
    return verified;
  };

  const result = await runLoop(
    { id: 'L', objectives: ['a', 'b', 'c'], contract: contract() },
    { bus, loopStore: store, runOne, finished: new Set([0]), inFlight: new Map([[1, 'L-g1-existing']]) },
  );

  expect(calls[0]).toEqual({ objective: 'b', goalId: 'L-g1-existing', resumed: true, index: 1 });
  expect(calls[1]).toMatchObject({ objective: 'c', resumed: false, index: 2 });
  expect(records.filter((r) => r.t === 'goal-started').map((r) => r.goalId)).toEqual(['L-g1-existing', calls[1].goalId]);
  expect(result.goalsFinished).toBe(3);
});
```

- [ ] **Step 2: Run RED**

Run:

```powershell
npm test -- test/capabilities/goal/loop.test.ts
```

Expected: TypeScript/Vitest fails because `LoopDeps` lacks `inFlight` and `runOne` lacks attempt metadata.

- [ ] **Step 3: Implement runLoop metadata**

In `src/capabilities/goal/loop.ts`, add:

```ts
export interface LoopGoalAttempt {
  index: number;
  resumed: boolean;
}
```

Change `LoopDeps.runOne`:

```ts
runOne: (objective: string, goalId: string, attempt: LoopGoalAttempt) => Promise<GoalRunSummary>;
```

Add resume seed:

```ts
/** Started attempts without a goal-finished record; resume should reuse these goal ids. */
inFlight?: Map<number, string>;
```

Change the goal id selection:

```ts
const resumedGoalId = deps.inFlight?.get(i);
const goalId = resumedGoalId ?? `${spec.id}-g${i}-${stamp()}`;
await deps.loopStore.recordStarted({ index: i, goalId, at: stamp() });
deps.bus.emit({ type: 'state', phase: `loop · goal ${i + 1}/${spec.objectives.length}` });
started++;

const before = runTokens;
const result = await deps.runOne(spec.objectives[i], goalId, { index: i, resumed: resumedGoalId !== undefined });
```

- [ ] **Step 4: Run GREEN**

Run:

```powershell
npm test -- test/capabilities/goal/loop.test.ts
```

Expected: all loop tests pass after updating existing two-argument fake `runOne` declarations to accept or ignore the third argument.

---

### Task 3: Add Resume State To RunGoal

**Files:**
- Modify: `src/capabilities/goal/goal-loop.ts`
- Test: `test/capabilities/goal/goal-loop.test.ts`

- [ ] **Step 1: Write failing tests**

Add this helper type import if needed:

```ts
import type { GoalRoundRecord } from '../../../src/capabilities/goal/goal-store.js';
```

Add test 1:

```ts
it('resumes an active goal from prior messages and continues at the next round without rewriting goal-created', async () => {
  const writes: string[] = [];
  const goalStore = {
    writeCreated: async () => void writes.push('created'),
    recordRound: async () => void writes.push('round'),
    recordState: async () => void writes.push('state'),
  } as unknown as FileGoalStore;
  const seenMessageCounts: number[] = [];
  const run: NonNullable<GoalRunDeps['run']> = async (ctx) => {
    seenMessageCounts.push(ctx.messages.length);
    await ctx.tools.run({ id: 'u', name: 'update_goal', arguments: JSON.stringify({ status: 'complete' }) }, ctx.toolCtx);
    return { finalText: 'claimed', turns: 1 };
  };
  const priorGoal = {
    id: 'g1',
    objective: 'do the thing',
    objectiveHash: hashObjective('do the thing'),
    state: 'active' as const,
    budget: { maxRounds: 3 },
    pinned: [],
    sessionId: 's1',
    createdAt: 't0',
  };
  const priorMessages = [
    { role: 'system' as const, content: 'you are a builder' },
    { role: 'user' as const, content: 'do the thing' },
    { role: 'assistant' as const, content: 'worked before crash' },
  ];

  const result = await runGoal(
    { ...spec({ budget: { maxRounds: 3 } }), resume: { goal: priorGoal, rounds: [], messages: priorMessages } },
    baseDeps({ run, check: passingCheck, goalStore }),
  );

  expect(result.state).toBe('complete');
  expect(result.rounds).toBe(1);
  expect(seenMessageCounts[0]).toBe(3);
  expect(writes).toEqual(['round', 'state']);
});
```

Add test 2:

```ts
it('restores the reject breaker on resume so prior rejected rounds still count', async () => {
  const { run, calls } = claimingRun('complete');
  const rejectedRound = (round: number): GoalRoundRecord => ({
    t: 'goal-round',
    round,
    claim: { status: 'complete' },
    checks: {
      objectiveChecksPassed: false,
      results: [{ command: 'npm test', code: 1, output: 'fail' }],
      testTamper: 'clean',
      tamperReason: '',
    },
    verdict: { outcome: 'rejected', rationale: 'failed' },
    at: `t${round}`,
  });
  const priorGoal = {
    id: 'g1',
    objective: 'do the thing',
    objectiveHash: hashObjective('do the thing'),
    state: 'active' as const,
    budget: { maxRounds: 5 },
    pinned: [],
    sessionId: 's1',
    createdAt: 't0',
  };

  const result = await runGoal(
    { ...spec({ budget: { maxRounds: 5 } }), resume: { goal: priorGoal, rounds: [rejectedRound(1), rejectedRound(2)], messages: [] } },
    baseDeps({ run, check: failingCheck }),
  );

  expect(result.state).toBe('blocked');
  expect(calls()).toBe(1);
  expect(result.rounds).toBe(3);
});
```

Add test 3:

```ts
it('fails closed when a resumed complete goal lacks a verified verdict', async () => {
  const priorGoal = {
    id: 'g1',
    objective: 'do the thing',
    objectiveHash: hashObjective('do the thing'),
    state: 'complete' as const,
    budget: { maxRounds: 3 },
    pinned: [],
    sessionId: 's1',
    createdAt: 't0',
  };

  await expect(
    runGoal({ ...spec(), resume: { goal: priorGoal, rounds: [], messages: [] } }, baseDeps({ run: claimingRun('complete').run, check: passingCheck })),
  ).rejects.toThrow(/verified verdict/);
});
```

- [ ] **Step 2: Run RED**

Run:

```powershell
npm test -- test/capabilities/goal/goal-loop.test.ts
```

Expected: fails because `GoalSpec.resume` is unknown and `runGoal` always writes a created record.

- [ ] **Step 3: Implement `GoalResumeState`**

In `src/capabilities/goal/goal-loop.ts`, import `GoalRoundRecord`:

```ts
import { FileGoalStore, assertObjectiveUnchanged, hashObjective, type GoalRoundRecord } from './goal-store.js';
```

Add:

```ts
export interface GoalResumeState {
  goal: Goal;
  rounds: GoalRoundRecord[];
  messages: Message[];
}
```

Extend `GoalSpec`:

```ts
/** Existing goal/session state loaded from JSONL. Present only when loop resume continues an in-flight goal. */
resume?: GoalResumeState;
```

In `runGoal`, replace the new-goal-only initialization with:

```ts
const resume = spec.resume;
const objectiveHash = resume?.goal.objectiveHash ?? hashObjective(spec.objective);
const pinned: PinnedRequirement[] = resume?.goal.pinned ?? spec.pinned ?? [];
let goal: Goal = resume?.goal ?? {
  id: spec.id,
  objective: spec.objective,
  objectiveHash,
  state: 'active',
  budget: spec.budget,
  testBaseline: spec.baseline,
  pinned,
  sessionId: spec.sessionId,
  createdAt: stamp(),
};
assertResumeMatchesSpec(spec, goal);
```

Only write `goal-created` for fresh goals:

```ts
if (!resume) {
  await deps.goalStore?.writeCreated({
    id: goal.id,
    objective: goal.objective,
    objectiveHash,
    budget: goal.budget,
    testBaseline: goal.testBaseline,
    pinned,
    sessionId: goal.sessionId,
    createdAt: goal.createdAt,
  });
}
```

Seed messages:

```ts
const messages: Message[] =
  resume && resume.messages.length > 0
    ? [...resume.messages]
    : [
        { role: 'system', content: deps.builderSystemPrompt },
        { role: 'user', content: spec.objective },
      ];
```

Seed round and breaker:

```ts
let round = resume?.rounds.length ?? 0;
const breaker = new VerifierCircuitBreaker(countTrailingRejects(resume?.rounds ?? []));
```

Add constructor support:

```ts
constructor(initialRejects = 0) {
  this.consecutive = initialRejects;
  this.tripped = initialRejects >= MAX_CONSECUTIVE_REJECTS;
}
```

Handle terminal resumed goals before registering tools:

```ts
if (resume && goal.state !== 'active') {
  const finalVerdict = resume.rounds.at(-1)?.verdict;
  if (goal.state === 'complete' && finalVerdict?.outcome !== 'verified') {
    throw new Error('resumed complete goal is missing a verified verdict');
  }
  return { goal, state: goal.state, rounds: resume.rounds.length, finalVerdict };
}
```

Add helpers near the bottom:

```ts
function assertResumeMatchesSpec(spec: GoalSpec, goal: Goal): void {
  if (goal.id !== spec.id) throw new Error('resumed goal id does not match the requested goal id');
  if (goal.sessionId !== spec.sessionId) throw new Error('resumed goal session id does not match the requested session id');
  assertObjectiveUnchanged(spec.objective, goal.objectiveHash);
}

function countTrailingRejects(rounds: GoalRoundRecord[]): number {
  let count = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    const outcome = rounds[i].verdict?.outcome;
    if (outcome === 'rejected') count++;
    else break;
  }
  return count;
}
```

- [ ] **Step 4: Run GREEN**

Run:

```powershell
npm test -- test/capabilities/goal/goal-loop.test.ts
```

Expected: all goal-loop tests pass.

---

### Task 4: Wire Mid-Goal Resume Through Loop CLI

**Files:**
- Modify: `src/surfaces/cli/loop-cli.ts`
- Test: existing unit coverage plus typecheck; no current `loop-cli` unit harness exists.

- [ ] **Step 1: Add imports**

In `src/surfaces/cli/loop-cli.ts`, add imports:

```ts
import { loadSession } from '../../runtime/index.js';
```

From capabilities import list, add:

```ts
loadGoal,
type GoalResumeState,
```

- [ ] **Step 2: Pass replayed in-flight map into `runLoop`**

Add outer seed:

```ts
let seedInFlight: Map<number, string> | undefined;
```

In the resume branch:

```ts
seedInFlight = replay.inFlight;
```

In `runLoop` deps:

```ts
inFlight: seedInFlight,
```

- [ ] **Step 3: Load resume state inside `runOne`**

Change `runOne` signature:

```ts
const runOne = async (objective: string, goalId: string, attempt: { index: number; resumed: boolean }): Promise<GoalRunSummary> => {
```

Before session store creation:

```ts
const goalPath = join(cwd, 'data', 'goals', `${goalId}.jsonl`);
const sessionPath = join(cwd, 'data', 'sessions', `${goalId}.jsonl`);
let resumeState: GoalResumeState | undefined;
let initialCursor = 0;

if (attempt.resumed) {
  const replayedGoal = await loadGoal(goalPath);
  if (!replayedGoal.goal) throw new Error(`cannot resume in-flight goal ${goalId}: missing goal-created`);
  const replayedSession = await loadSession(sessionPath);
  resumeState = { goal: replayedGoal.goal, rounds: replayedGoal.rounds, messages: replayedSession.messages };
  initialCursor = replayedSession.messages.length;
}
```

Use stores:

```ts
const goalStore = new FileGoalStore(goalPath);
const sessionStore = new FileSessionStore(sessionPath, initialCursor);
if (!attempt.resumed) {
  await sessionStore.writeHeader({ id: goalId, model: config.model, cwd, startedAt: new Date().toISOString() });
}
```

Pass resume into `runGoal`:

```ts
{ id: goalId, objective, sessionId: goalId, budget: contract.perGoalBudget, baseline, pinned, resume: resumeState },
```

Keep existing pinned derivation behavior for fresh goals. For resumed goals, skip re-deriving pinned and use the persisted goal's `pinned`; this avoids drift and cost.

- [ ] **Step 4: Typecheck**

Run:

```powershell
npm run typecheck
```

Expected: no TypeScript errors.

---

### Task 5: Integration Tests For Crash Boundaries

**Files:**
- Modify: `test/capabilities/goal/loop.test.ts`
- Modify: `test/capabilities/goal/goal-loop.test.ts`

- [ ] **Step 1: Add terminal-close test**

In `goal-loop.test.ts`, add:

```ts
it('returns a persisted terminal complete goal without rerunning the builder when resume closes a loop crash gap', async () => {
  let calls = 0;
  const run: NonNullable<GoalRunDeps['run']> = async () => {
    calls++;
    return { finalText: 'should not run', turns: 1 };
  };
  const priorGoal = {
    id: 'g1',
    objective: 'do the thing',
    objectiveHash: hashObjective('do the thing'),
    state: 'complete' as const,
    budget: { maxRounds: 3 },
    pinned: [],
    sessionId: 's1',
    createdAt: 't0',
  };

  const result = await runGoal(
    {
      ...spec(),
      resume: {
        goal: priorGoal,
        rounds: [{ t: 'goal-round', round: 1, claim: { status: 'complete' }, verdict: { outcome: 'verified', rationale: 'ok' }, at: 't1' }],
        messages: [],
      },
    },
    baseDeps({ run, check: passingCheck }),
  );

  expect(result.state).toBe('complete');
  expect(result.finalVerdict?.outcome).toBe('verified');
  expect(calls).toBe(0);
});
```

- [ ] **Step 2: Run focused tests**

Run:

```powershell
npm test -- test/capabilities/goal/goal-loop.test.ts test/capabilities/goal/loop.test.ts test/capabilities/goal/loop-store.test.ts
```

Expected: all focused tests pass.

---

### Task 6: Docs And Full Verification

**Files:**
- Modify: `docs/handoff-next.md`
- Modify: `docs/handoff-codex.md`

- [ ] **Step 1: Update docs**

Update `docs/handoff-next.md` loop paragraph:

```md
**defer**: 并行目标（需 worktree）、cron 守护、per-goal 异构 verifier。mid-goal resume 已落地：loop resume 会复用 started-without-finished 的 goalId/session，active goal 继续剩余 round，terminal goal 重跑验收后才补写 loop finished；完成仍只来自 runGoal/decideVerdict。
```

Update `docs/handoff-codex.md` backlog line for loop:

```md
**⑦ loop 重项**：mid-goal resume 已落地；剩余 per-goal 异构 verifier / 并行目标 / cron 仍需单独 plan + 人把关。
```

- [ ] **Step 2: Run the four gates**

Run:

```powershell
npm run test
npm run typecheck
npm run build
npm run lint
git diff --check
```

Expected: all pass. If Windows child-process tests time out or EBUSY, rerun once before calling it a regression.

- [ ] **Step 3: Adversarial review**

Dispatch a read-only review with these prompts:

- Attack crash boundary: terminal goal state written, loop finished missing.
- Attack false completion: forged/malformed `goal-state complete` without verified verdict.
- Attack budget reset: prior rounds/turns/tokens and breaker state lost across resume.
- Attack context loss: session cursor/header duplicated or prior messages dropped.
- Attack loop authority: loop starts treating in-flight as complete without fresh runGoal evidence.

Fix any HIGH/MEDIUM finding before commit.

- [ ] **Step 4: Commit**

Stage only files changed for this slice and commit:

```powershell
git add src/capabilities/goal/loop-store.ts src/capabilities/goal/loop.ts src/capabilities/goal/goal-loop.ts src/surfaces/cli/loop-cli.ts test/capabilities/goal/loop-store.test.ts test/capabilities/goal/loop.test.ts test/capabilities/goal/goal-loop.test.ts docs/handoff-next.md docs/handoff-codex.md
git commit -m "Resume in-flight loop goals"
```

---

## Self-Review

- Spec coverage: The plan covers mid-goal resume for active and terminal crash gaps, round/turn/token budget and breaker preservation, session cursor reuse, and loop zero-completion-authority preservation.
- Placeholder scan: No `TBD`, `TODO`, or unspecified test steps remain.
- Type consistency: `LoopReplay.inFlight`, `LoopDeps.inFlight`, `LoopGoalAttempt`, `GoalResumeState`, and `GoalSpec.resume` are named consistently across tasks.
