# Loop Per-Goal Verifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `npm run loop` choose an independent leg-3 verifier model per objective while preserving the existing verification authority, resume safety, and trusted-config boundary.

**Architecture:** Keep `runGoal` and `decideVerdict` as the only completion path. Add a loop-only trusted verifier-map loader, derive one verifier decision per objective index, pass the selected provider into each `runGoal` call, and make cross-goal verifier health track samples per verifier key.

**Tech Stack:** TypeScript strict ESM, Vitest, existing Doubao provider config, append-only JSONL loop store, current `runLoop` / `runGoal` composition.

---

## Scope

This plan implements only per-goal heterogeneous verifier selection for `loop-cli`.

Out of scope for this slice:

- Single-goal `npm run goal` per-goal config. It already has one objective and keeps using `ARK_VERIFIER_MODEL`.
- Per-objective held-out checks. Loop held-out remains deferred because a shared hidden file does not map cleanly to a heterogeneous objective queue.
- Verifier exec / runtime app driving. The judge remains read-only (`read` + `grep`) and routes runtime-only evidence to `couldNotVerify`.
- Parallel goals and cron/daemon mode.

## Invariants

- `runLoop` still has zero completion authority. It records `runOne` summaries and never imports `runGoal`, `advanceGoalState`, or `decideVerdict`.
- `runGoal` still gates completion through deterministic checks, optional leg 3, and `decideVerdict`.
- Per-goal verifier config is opt-in. With no verifier map and no `ARK_VERIFIER_MODEL`, current loop behavior stays unchanged.
- The verifier map is a launch/user supplied trusted file. The loader canonicalizes the map path and cwd with realpath, then refuses any path inside cwd, including symlink and Windows `\\?\` bypasses.
- The objectives file remains plain one-objective-per-line. It is never treated as verifier config.
- The loop log and goal log remain untrusted for verifier configuration. Resume recomputes baseline and pinned requirements from the external verifier decision, then lets `runGoal` validate the existing goal/session logs.
- No per-goal "disable verifier" switch lands in this slice. A missing map entry uses the global `ARK_VERIFIER_MODEL` fallback; if that is absent, the goal uses deterministic legs only.
- An explicit verifier map that is missing, malformed, points inside cwd, names duplicate/out-of-range objective indexes, or selects the builder model fails before the loop starts.
- Cross-goal verifier health samples are bucketed by verifier key. Three `couldNotVerify` samples from three different verifier models do not prove one shared judge is broken.
- No secrets are logged. Model ids and map paths may be printed; API keys never are.

## User Contract

Fresh run:

```powershell
npm run loop -- H:\trusted\objectives.txt --verifier-map C:\Users\Administrator.DESKTOP-33TL0HO\.jarvis\loop-verifiers.json
```

Resume run:

```powershell
npm run resume:loop -- --verifier-map C:\Users\Administrator.DESKTOP-33TL0HO\.jarvis\loop-verifiers.json
```

Deterministic-only resume still uses a trusted map file outside cwd, with `{"goals":[]}`.

Verifier map schema:

```json
{
  "goals": [
    { "index": 0, "verifierModel": "deepseek-v4-pro" },
    { "index": 2, "verifierModel": "doubao-seed-2-1-pro-260628" }
  ]
}
```

Semantics:

- `index` is the zero-based objective index after blank lines and `#` comments are removed.
- A listed index uses its `verifierModel`.
- An unlisted index uses the existing global `ARK_VERIFIER_MODEL` decision.
- If both the map entry and global verifier are absent, that objective keeps deterministic-only verification.
- Resume must pass `--verifier-map <trusted file>` every time. Use a trusted empty map (`{"goals":[]}`) for deterministic-only resume; a missing cwd loop-log field is never accepted as implicit deterministic-only mode.

## Files

- Create: `src/capabilities/goal/loop-verifier-config.ts`
  - Parse and load the trusted verifier map.
  - Build a per-objective verifier plan from map overrides plus global `resolveVerifierConfig`.
  - Validate same-model independence at the config string layer.
- Create: `test/capabilities/goal/loop-verifier-config.test.ts`
  - Strict schema, trust-boundary, duplicate/out-of-range, fallback, and same-builder tests.
- Create: `src/surfaces/cli/loop-args.ts`
  - Parse `--resume`, `--force`, `--unattended`, `--verifier-map <path>`, and positionals without importing `loop-cli.ts`.
- Create: `test/cli/loop-args.test.ts`
  - Guard against `--verifier-map` being swallowed as an objective path.
- Modify: `src/capabilities/goal/loop.ts`
  - Add optional `verifierKey` to `GoalRunSummary`.
  - Track `VerifierHealthMonitor` instances per key.
- Modify: `src/capabilities/goal/loop-store.ts`
  - Persist optional `verifierKey` on `goal-finished`.
  - Replay keyed verifier samples for crash-safe health checkpoints.
- Modify: `test/capabilities/goal/loop.test.ts`
  - Add keyed health tests and update resume seed tests.
- Modify: `test/capabilities/goal/loop-store.test.ts`
  - Assert `verifierKey` round-trips through JSONL replay.
- Modify: `src/surfaces/cli/loop-cli.ts`
  - Use `parseLoopArgs`.
  - Load trusted verifier map once.
  - Build/cache verifier providers per model.
  - Select verifier provider and pinned requirements per objective index.
  - Return `verifierKey` in `GoalRunSummary` when a verifier was enabled for that objective.
- Modify: `docs/handoff-next.md`
  - Move per-goal verifier from defer to landed notes after implementation.
- Modify: `docs/handoff-codex.md`
  - Mirror the handoff status and redlines after implementation.

---

### Task 1: Add The Trusted Per-Goal Verifier Config Parser

**Files:**
- Create: `src/capabilities/goal/loop-verifier-config.ts`
- Test: `test/capabilities/goal/loop-verifier-config.test.ts`

- [ ] **Step 1: Write parser tests**

Add `test/capabilities/goal/loop-verifier-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildLoopVerifierPlan,
  loadLoopVerifierMap,
  parseLoopVerifierMap,
} from '../../../src/capabilities/goal/loop-verifier-config.js';
import type { DoubaoConfig } from '../../../src/core/model/types.js';

const builder: DoubaoConfig = {
  provider: 'doubao',
  apiKey: 'k',
  baseURL: 'https://example.test/v1',
  model: 'builder-model',
};

describe('parseLoopVerifierMap', () => {
  it('parses strict per-index verifier overrides', () => {
    expect(parseLoopVerifierMap(JSON.stringify({
      goals: [
        { index: 0, verifierModel: 'judge-a' },
        { index: 2, verifierModel: 'judge-b' },
      ],
    }))).toEqual({
      goals: [
        { index: 0, verifierModel: 'judge-a' },
        { index: 2, verifierModel: 'judge-b' },
      ],
    });
  });

  it.each([
    ['bad json', 'not-json{'],
    ['top-level array', '[]'],
    ['unknown top-level key', JSON.stringify({ goals: [], extra: true })],
    ['missing goals', JSON.stringify({})],
    ['goals is not array', JSON.stringify({ goals: {} })],
    ['entry is not object', JSON.stringify({ goals: [1] })],
    ['unknown entry key', JSON.stringify({ goals: [{ index: 0, verifierModel: 'judge', extra: true }] })],
    ['negative index', JSON.stringify({ goals: [{ index: -1, verifierModel: 'judge' }] })],
    ['fractional index', JSON.stringify({ goals: [{ index: 1.5, verifierModel: 'judge' }] })],
    ['blank verifier model', JSON.stringify({ goals: [{ index: 1, verifierModel: '   ' }] })],
    ['duplicate index', JSON.stringify({ goals: [{ index: 1, verifierModel: 'a' }, { index: 1, verifierModel: 'b' }] })],
  ])('throws for %s', (_label, text) => {
    expect(() => parseLoopVerifierMap(text)).toThrow();
  });
});

describe('loadLoopVerifierMap trust boundary', () => {
  const cwd = join(tmpdir(), 'jarvis-loop-repo');
  const outside = join(tmpdir(), 'loop-verifiers.json');
  const inside = join(cwd, 'loop-verifiers.json');

  it('loads a trusted file outside cwd after realpath', async () => {
    const text = JSON.stringify({ goals: [{ index: 0, verifierModel: 'judge-a' }] });
    const loaded = await loadLoopVerifierMap({
      path: outside,
      cwd,
      readText: async (p) => (p === resolve(outside) ? text : null),
      realpath: async (p) => resolve(p),
    });
    expect(loaded.goals[0]?.verifierModel).toBe('judge-a');
  });

  it('refuses a path that canonicalizes inside cwd', async () => {
    await expect(loadLoopVerifierMap({
      path: outside,
      cwd,
      readText: async () => JSON.stringify({ goals: [] }),
      realpath: async (p) => (p === outside ? inside : resolve(p)),
    })).rejects.toThrow(/inside the working directory/);
  });

  it('fails loudly when the explicit file cannot be resolved', async () => {
    await expect(loadLoopVerifierMap({
      path: outside,
      cwd,
      readText: async () => null,
      realpath: async () => null,
    })).rejects.toThrow(/cannot be read/);
  });
});

describe('buildLoopVerifierPlan', () => {
  it('uses per-index override, then global fallback, then deterministic-only fallback', () => {
    const plan = buildLoopVerifierPlan({
      objectivesCount: 3,
      builderConfig: builder,
      globalVerifier: { enabled: true, config: { ...builder, model: 'global-judge' } },
      map: { goals: [{ index: 1, verifierModel: 'per-goal-judge' }] },
    });
    expect(plan.decisions.map((d) => d.enabled ? d.config.model : 'off')).toEqual([
      'global-judge',
      'per-goal-judge',
      'global-judge',
    ]);
  });

  it('fails closed when an override points past the objective queue', () => {
    expect(() => buildLoopVerifierPlan({
      objectivesCount: 1,
      builderConfig: builder,
      globalVerifier: { enabled: false, reason: 'off' },
      map: { goals: [{ index: 3, verifierModel: 'judge' }] },
    })).toThrow(/out of range/);
  });

  it('fails closed when an override equals the builder model', () => {
    expect(() => buildLoopVerifierPlan({
      objectivesCount: 1,
      builderConfig: builder,
      globalVerifier: { enabled: false, reason: 'off' },
      map: { goals: [{ index: 0, verifierModel: 'builder-model' }] },
    })).toThrow(/equals the builder model/);
  });
});
```

- [ ] **Step 2: Run the new test and confirm RED**

Run:

```powershell
npm run test -- test/capabilities/goal/loop-verifier-config.test.ts
```

Expected: FAIL because `loop-verifier-config.ts` does not exist.

- [ ] **Step 3: Implement the parser and planner**

Create `src/capabilities/goal/loop-verifier-config.ts`:

```ts
import { isAbsolute, relative, resolve } from 'node:path';
import type { DoubaoConfig } from '../../core/model/types.js';
import type { VerifierResolution } from '../../core/model/config.js';
import type { ReadText } from '../rules/index.js';

export type RealPath = (path: string) => Promise<string | null>;

export interface LoopVerifierMapEntry {
  index: number;
  verifierModel: string;
}

export interface LoopVerifierMap {
  goals: LoopVerifierMapEntry[];
}

export type LoopVerifierDecision =
  | { enabled: true; config: DoubaoConfig; key: string; source: 'global' | 'map' }
  | { enabled: false; reason: string; source: 'none' | 'global-disabled' };

export interface LoopVerifierPlan {
  decisions: LoopVerifierDecision[];
  overrideCount: number;
}

export function parseLoopVerifierMap(text: string): LoopVerifierMap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`verifier map is not valid JSON: ${message(err)}`, { cause: err });
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('verifier map must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const unknownTop = Object.keys(obj).filter((k) => k !== 'goals');
  if (unknownTop.length > 0) throw new Error(`unknown verifier map keys: ${unknownTop.join(', ')}`);
  if (!Array.isArray(obj.goals)) throw new Error('verifier map .goals must be an array');

  const seen = new Set<number>();
  const goals: LoopVerifierMapEntry[] = obj.goals.map((item, i) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`goals[${i}] must be an object`);
    }
    const entry = item as Record<string, unknown>;
    const unknown = Object.keys(entry).filter((k) => k !== 'index' && k !== 'verifierModel');
    if (unknown.length > 0) throw new Error(`goals[${i}] has unknown keys: ${unknown.join(', ')}`);
    if (typeof entry.index !== 'number' || !Number.isInteger(entry.index) || entry.index < 0) {
      throw new Error(`goals[${i}].index must be a non-negative integer`);
    }
    if (seen.has(entry.index)) throw new Error(`duplicate verifier map index: ${entry.index}`);
    seen.add(entry.index);
    if (typeof entry.verifierModel !== 'string' || entry.verifierModel.trim() === '') {
      throw new Error(`goals[${i}].verifierModel must be a non-empty string`);
    }
    return { index: entry.index, verifierModel: entry.verifierModel.trim() };
  });
  return { goals };
}

export async function loadLoopVerifierMap(deps: {
  path: string;
  cwd: string;
  readText: ReadText;
  realpath?: RealPath;
}): Promise<LoopVerifierMap> {
  const source = deps.path.trim();
  if (source === '') throw new Error('verifier map path is blank');
  const canonCwd = (deps.realpath ? await deps.realpath(deps.cwd) : null) ?? resolve(deps.cwd);
  const canonPath = deps.realpath ? await deps.realpath(source) : resolve(source);
  if (canonPath === null) throw new Error(`verifier map cannot be read: ${source}`);
  if (isInsideCwd(canonPath, canonCwd)) {
    throw new Error(`verifier map is inside the working directory (${canonPath}); refusing repo-controlled verifier config`);
  }
  const text = await deps.readText(canonPath);
  if (text === null) throw new Error(`verifier map cannot be read: ${canonPath}`);
  return parseLoopVerifierMap(text);
}

export function buildLoopVerifierPlan(input: {
  objectivesCount: number;
  builderConfig: DoubaoConfig;
  globalVerifier: VerifierResolution;
  map?: LoopVerifierMap;
}): LoopVerifierPlan {
  const byIndex = new Map(input.map?.goals.map((g) => [g.index, g.verifierModel]) ?? []);
  for (const index of byIndex.keys()) {
    if (index >= input.objectivesCount) throw new Error(`verifier map index ${index} is out of range for ${input.objectivesCount} objectives`);
  }

  const decisions: LoopVerifierDecision[] = [];
  for (let index = 0; index < input.objectivesCount; index++) {
    const override = byIndex.get(index);
    if (override !== undefined) {
      if (override === input.builderConfig.model) {
        throw new Error(`verifier map index ${index} equals the builder model (${override})`);
      }
      decisions.push({
        enabled: true,
        config: { ...input.builderConfig, model: override },
        key: `model:${override}`,
        source: 'map',
      });
      continue;
    }
    if (input.globalVerifier.enabled) {
      decisions.push({
        enabled: true,
        config: input.globalVerifier.config,
        key: `model:${input.globalVerifier.config.model}`,
        source: 'global',
      });
    } else {
      decisions.push({ enabled: false, reason: input.globalVerifier.reason, source: 'global-disabled' });
    }
  }
  return { decisions, overrideCount: byIndex.size };
}

function isInsideCwd(absPath: string, cwd: string): boolean {
  const rel = relative(resolve(cwd), absPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 4: Run the parser tests and confirm GREEN**

Run:

```powershell
npm run test -- test/capabilities/goal/loop-verifier-config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Export the helper**

Modify `src/capabilities/goal/index.ts`:

```ts
export * from './loop-verifier-config.js';
```

Run:

```powershell
npm run typecheck
```

Expected: PASS.

---

### Task 2: Add A Strict Loop CLI Argument Parser

**Files:**
- Create: `src/surfaces/cli/loop-args.ts`
- Test: `test/cli/loop-args.test.ts`

- [ ] **Step 1: Write parser tests**

Add `test/cli/loop-args.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseLoopArgs } from '../../src/surfaces/cli/loop-args.js';

describe('parseLoopArgs', () => {
  it('parses the objective file and verifier map without treating the map path as positional', () => {
    expect(parseLoopArgs(['objectives.txt', '--verifier-map', 'C:\\trusted\\loop-verifiers.json'])).toEqual({
      resume: false,
      force: false,
      unattended: false,
      verifierMapPath: 'C:\\trusted\\loop-verifiers.json',
      positional: ['objectives.txt'],
    });
  });

  it('parses resume flags with verifier map', () => {
    expect(parseLoopArgs(['--resume', '--force', '--unattended', '--verifier-map', '/trusted/map.json'])).toMatchObject({
      resume: true,
      force: true,
      unattended: true,
      verifierMapPath: '/trusted/map.json',
      positional: [],
    });
  });

  it('rejects a missing verifier-map value', () => {
    expect(() => parseLoopArgs(['objectives.txt', '--verifier-map'])).toThrow(/requires a path/);
  });

  it('rejects unknown flags so typoed safety config is visible', () => {
    expect(() => parseLoopArgs(['objectives.txt', '--verifier-mpa', '/trusted/map.json'])).toThrow(/unknown flag/);
  });
});
```

- [ ] **Step 2: Run the new test and confirm RED**

Run:

```powershell
npm run test -- test/cli/loop-args.test.ts
```

Expected: FAIL because `loop-args.ts` does not exist.

- [ ] **Step 3: Implement the parser**

Create `src/surfaces/cli/loop-args.ts`:

```ts
export interface LoopCliArgs {
  resume: boolean;
  force: boolean;
  unattended: boolean;
  verifierMapPath?: string;
  positional: string[];
}

export function parseLoopArgs(argv: string[]): LoopCliArgs {
  const parsed: LoopCliArgs = {
    resume: false,
    force: false,
    unattended: false,
    positional: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--resume') {
      parsed.resume = true;
      continue;
    }
    if (arg === '--force') {
      parsed.force = true;
      continue;
    }
    if (arg === '--unattended') {
      parsed.unattended = true;
      continue;
    }
    if (arg === '--verifier-map') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--') || value.trim() === '') {
        throw new Error('--verifier-map requires a path');
      }
      parsed.verifierMapPath = value;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    parsed.positional.push(arg);
  }
  return parsed;
}
```

- [ ] **Step 4: Run parser tests**

Run:

```powershell
npm run test -- test/cli/loop-args.test.ts
```

Expected: PASS.

---

### Task 3: Make Verifier Health Keyed By Verifier Identity

**Files:**
- Modify: `src/capabilities/goal/loop.ts`
- Modify: `test/capabilities/goal/loop.test.ts`

- [ ] **Step 1: Add failing keyed-health tests**

Add these tests to `test/capabilities/goal/loop.test.ts` under the verifier-health describe block:

```ts
it('trips verifier-health when couldNotVerify samples share the same verifier key', async () => {
  const bus = new InMemoryEventBus();
  const { store } = fakeStore();
  const { runOne } = scriptedRunOne([
    { state: 'blocked', outcome: 'couldNotVerify', verifierKey: 'model:a', rounds: 1 },
  ]);

  const result = await runLoop(
    { id: 'L', objectives: ['a', 'b', 'c', 'd'], contract: contract({ cnvWindow: 3, cnvThreshold: 3, maxConsecutiveBlocked: 100 }) },
    { bus, loopStore: store, runOne },
  );

  expect(result.reason).toBe('verifier-health');
  expect(result.started).toBe(3);
});

it('does not merge couldNotVerify health across different verifier keys', async () => {
  const bus = new InMemoryEventBus();
  const { store } = fakeStore();
  const summaries: GoalRunSummary[] = [
    { state: 'blocked', outcome: 'couldNotVerify', verifierKey: 'model:a', rounds: 1 },
    { state: 'blocked', outcome: 'couldNotVerify', verifierKey: 'model:b', rounds: 1 },
    { state: 'blocked', outcome: 'couldNotVerify', verifierKey: 'model:c', rounds: 1 },
  ];
  const { runOne } = scriptedRunOne(summaries);

  const result = await runLoop(
    { id: 'L', objectives: ['a', 'b', 'c'], contract: contract({ cnvWindow: 3, cnvThreshold: 3, maxConsecutiveBlocked: 100 }) },
    { bus, loopStore: store, runOne },
  );

  expect(result.reason).toBe('queue-empty');
  expect(result.started).toBe(3);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```powershell
npm run test -- test/capabilities/goal/loop.test.ts
```

Expected: FAIL because `GoalRunSummary.verifierKey` is not supported and health still uses one shared monitor.

- [ ] **Step 3: Update loop health data structures**

Modify `src/capabilities/goal/loop.ts`:

```ts
export interface VerifierOutcomeSample {
  outcome: VerdictOutcome;
  verifierKey?: string;
}

export interface GoalRunSummary {
  state: GoalState;
  outcome?: VerdictOutcome;
  verifierKey?: string;
  rounds: number;
  tokens?: number;
}

export interface LoopDeps {
  bus: EventBus;
  loopStore: LoopStore;
  runOne: (objective: string, goalId: string, attempt: LoopGoalAttempt) => Promise<GoalRunSummary>;
  signal?: AbortSignal;
  now?: () => number;
  stamp?: () => string;
  finished?: Set<number>;
  outcomes?: Array<VerdictOutcome | VerifierOutcomeSample>;
  inFlight?: Map<number, string>;
  consecutiveBlocked?: number;
  cumulativeTokens?: number;
}
```

Add these helpers near `VerifierHealthMonitor`:

```ts
const DEFAULT_VERIFIER_HEALTH_KEY = '__default__';

function sampleOutcome(sample: VerdictOutcome | VerifierOutcomeSample): VerdictOutcome {
  return typeof sample === 'string' ? sample : sample.outcome;
}

function sampleKey(sample: VerdictOutcome | VerifierOutcomeSample): string {
  return typeof sample === 'string' ? DEFAULT_VERIFIER_HEALTH_KEY : (sample.verifierKey ?? DEFAULT_VERIFIER_HEALTH_KEY);
}
```

Replace the single monitor in `runLoop` with a keyed map:

```ts
const monitors = new Map<string, VerifierHealthMonitor>();
const monitorFor = (key: string): VerifierHealthMonitor => {
  let monitor = monitors.get(key);
  if (monitor === undefined) {
    monitor = new VerifierHealthMonitor(c.cnvWindow, c.cnvThreshold);
    monitors.set(key, monitor);
  }
  return monitor;
};
for (const o of deps.outcomes ?? []) monitorFor(sampleKey(o)).record(sampleOutcome(o));
const anyMonitorTripped = (): boolean => [...monitors.values()].some((m) => m.isTripped());
```

Replace the pre-run monitor check:

```ts
if (anyMonitorTripped()) {
  reason = 'verifier-health';
  break;
}
```

Replace the post-goal monitor record:

```ts
if (outcome !== undefined && monitorFor(result.verifierKey ?? DEFAULT_VERIFIER_HEALTH_KEY).record(outcome) === 'halt') {
  reason = 'verifier-health';
  break;
}
```

- [ ] **Step 4: Run loop tests**

Run:

```powershell
npm run test -- test/capabilities/goal/loop.test.ts
```

Expected: PASS.

---

### Task 4: Persist And Replay Verifier Keys

**Files:**
- Modify: `src/capabilities/goal/loop-store.ts`
- Modify: `test/capabilities/goal/loop-store.test.ts`

- [ ] **Step 1: Add failing persistence tests**

Update the first round-trip assertion in `test/capabilities/goal/loop-store.test.ts`:

```ts
await store.recordFinished({
  index: 0,
  goalId: 'L1-g0-x',
  state: 'complete',
  outcome: 'verified',
  verifierKey: 'model:judge-a',
  rounds: 2,
  tokens: 100,
  at: 't2',
});
```

Change the outcome assertion:

```ts
expect(replay.outcomes).toEqual([
  { outcome: 'verified', verifierKey: 'model:judge-a' },
  { outcome: 'couldNotVerify' },
]);
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```powershell
npm run test -- test/capabilities/goal/loop-store.test.ts
```

Expected: FAIL because `verifierKey` is not accepted or replayed.

- [ ] **Step 3: Update loop-store types and replay**

Modify `src/capabilities/goal/loop-store.ts`:

```ts
import type { GoalState, VerdictOutcome } from './goal.js';
import type { LoopContract, LoopHaltReason, LoopStore, VerifierOutcomeSample } from './loop.js';
```

Update `LoopRecord`:

```ts
| {
    t: 'goal-finished';
    index: number;
    goalId: string;
    state: GoalState;
    outcome?: VerdictOutcome;
    verifierKey?: string;
    rounds: number;
    tokens: number;
    at: string;
  }
```

Update `LoopReplay`:

```ts
outcomes: VerifierOutcomeSample[];
```

Update `recordFinished` signatures in `LoopStore` and `FileLoopStore` to accept `verifierKey?: string`.

Update replay folding:

```ts
if (record.outcome !== undefined) {
  const sample: VerifierOutcomeSample =
    record.verifierKey === undefined ? { outcome: record.outcome } : { outcome: record.outcome, verifierKey: record.verifierKey };
  outcomes.push(sample);
}
```

- [ ] **Step 4: Run store and loop tests**

Run:

```powershell
npm run test -- test/capabilities/goal/loop-store.test.ts test/capabilities/goal/loop.test.ts
```

Expected: PASS.

---

### Task 5: Wire Per-Goal Verifier Selection Into Loop CLI

**Files:**
- Modify: `src/surfaces/cli/loop-cli.ts`
- Modify: `test/cli/loop-args.test.ts`
- Existing helper tests from Task 1 cover the config planner.

- [ ] **Step 1: Replace manual argv parsing**

Modify imports in `src/surfaces/cli/loop-cli.ts`:

```ts
import { readFile, realpath } from 'node:fs/promises';
import { parseLoopArgs } from './loop-args.js';
```

Also import verifier helpers:

```ts
import {
  buildLoopVerifierPlan,
  loadLoopVerifierMap,
  type LoopVerifierDecision,
  type LoopVerifierMap,
} from '../../capabilities/index.js';
```

Replace:

```ts
const argv = process.argv.slice(2);
const resume = argv.includes('--resume');
const force = argv.includes('--force');
const unattended = argv.includes('--unattended');
const positional = argv.filter((a) => !a.startsWith('--'));
```

with:

```ts
let args;
try {
  args = parseLoopArgs(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
  return;
}
const { resume, force, unattended, positional, verifierMapPath } = args;
```

- [ ] **Step 2: Load the trusted verifier map after cwd is known**

After `const cwd = process.cwd();` add:

```ts
let verifierMap: LoopVerifierMap | undefined;
if (verifierMapPath !== undefined) {
  try {
    verifierMap = await loadLoopVerifierMap({
      path: verifierMapPath,
      cwd,
      readText: async (p) => readFile(p, 'utf8').catch(() => null),
      realpath: async (p) => realpath(p).catch(() => null),
    });
  } catch (err) {
    console.error(`[loop verifier] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
}
```

- [ ] **Step 3: Build the verifier plan after objectives are known**

Replace the single global verifier provider creation:

```ts
const verifier = resolveVerifierConfig(process.env, config);
const verifierProvider: ModelProvider | undefined = verifier.enabled
  ? createProvider(verifier.config).withThinking('off')
  : undefined;
```

with:

```ts
const verifier = resolveVerifierConfig(process.env, config);
let verifierPlan;
try {
  verifierPlan = buildLoopVerifierPlan({
    objectivesCount: objectives.length,
    builderConfig: config,
    globalVerifier: verifier,
    map: verifierMap,
  });
} catch (err) {
  console.error(`[loop verifier] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
  return;
}

const verifierProviders = new Map<string, ModelProvider>();
function providerForVerifier(decision: LoopVerifierDecision): ModelProvider | undefined {
  if (!decision.enabled) return undefined;
  let cached = verifierProviders.get(decision.key);
  if (cached === undefined) {
    cached = createProvider(decision.config).withThinking('off');
    verifierProviders.set(decision.key, cached);
  }
  return cached;
}
```

- [ ] **Step 4: Update console status**

Replace the current verifier line:

```ts
console.log(verifier.enabled ? `腿3: 独立裁判已启用(${safeInline(verifier.config.model)})` : `腿3: 未启用(${safeInline(verifier.reason)})`);
```

with:

```ts
const enabledVerifierCount = verifierPlan.decisions.filter((d) => d.enabled).length;
console.log(
  enabledVerifierCount > 0
    ? `腿3: ${enabledVerifierCount}/${objectives.length} 个目标启用独立裁判` +
        (verifierPlan.overrideCount > 0 ? `, verifier-map 覆盖 ${verifierPlan.overrideCount} 项` : '')
    : `腿3: 未启用(${safeInline(verifier.reason)})`,
);
```

- [ ] **Step 5: Select verifier per objective in runOne**

Inside `runOne`, before pinned derivation:

```ts
const verifierDecision = verifierPlan.decisions[attempt.index];
if (verifierDecision === undefined) {
  throw new Error(`missing verifier decision for objective index ${attempt.index}`);
}
const verifierProvider = providerForVerifier(verifierDecision);
```

Leave pinned derivation through the builder provider:

```ts
let pinned: PinnedRequirement[] = [];
if (verifierProvider) {
  pinned = await derivePinnedRequirements(objective, provider);
  if (pinned.length === 0) {
    bus.emit({ type: 'goal_state', goalId, state: 'blocked' });
    return { state: 'blocked', rounds: resumeState?.rounds.length ?? 0, tokens: sumRoundTokens(resumeState?.rounds ?? []) };
  }
} else if (resumeState && resumeState.goal.pinned.length > 0) {
  bus.emit({ type: 'goal_state', goalId, state: 'blocked' });
  return { state: 'blocked', rounds: resumeState.rounds.length, tokens: sumRoundTokens(resumeState.rounds) };
}
```

Update the final summary:

```ts
return {
  state: result.state,
  outcome: result.finalVerdict?.outcome,
  verifierKey: verifierDecision.enabled ? verifierDecision.key : undefined,
  rounds: result.rounds,
  tokens: result.tokens,
};
```

- [ ] **Step 6: Persist verifier key through runLoop**

In `src/capabilities/goal/loop.ts`, update `recordFinished` call:

```ts
await deps.loopStore.recordFinished({
  index: i,
  goalId,
  state: result.state,
  outcome,
  verifierKey: result.verifierKey,
  rounds: result.rounds,
  tokens,
  at: stamp(),
});
```

- [ ] **Step 7: Run CLI-adjacent tests**

Run:

```powershell
npm run test -- test/cli/loop-args.test.ts test/capabilities/goal/loop-verifier-config.test.ts test/capabilities/goal/loop.test.ts test/capabilities/goal/loop-store.test.ts
```

Expected: PASS.

---

### Task 6: Add A Resume Safety Test For Keyed Health

**Files:**
- Modify: `test/capabilities/goal/loop.test.ts`

- [ ] **Step 1: Add failing resume test**

Add this under the resume describe block:

```ts
it('re-asserts verifier-health on resume only for a verifier key that reached threshold', async () => {
  const bus = new InMemoryEventBus();
  const { store } = fakeStore();
  const { runOne, seen } = scriptedRunOne([verified]);
  const result = await runLoop(
    { id: 'L', objectives: ['a', 'b', 'c', 'd'], contract: contract({ cnvWindow: 3, cnvThreshold: 3, maxConsecutiveBlocked: 100 }) },
    {
      bus,
      loopStore: store,
      runOne,
      finished: new Set([0, 1, 2]),
      outcomes: [
        { outcome: 'couldNotVerify', verifierKey: 'model:a' },
        { outcome: 'couldNotVerify', verifierKey: 'model:a' },
        { outcome: 'couldNotVerify', verifierKey: 'model:b' },
      ],
    },
  );
  expect(result.reason).toBe('queue-empty');
  expect(seen).toEqual(['d']);
});
```

- [ ] **Step 2: Add the threshold variant**

Add:

```ts
it('halts before running on resume when one verifier key is already unhealthy', async () => {
  const bus = new InMemoryEventBus();
  const { store } = fakeStore();
  const { runOne, seen } = scriptedRunOne([verified]);
  const result = await runLoop(
    { id: 'L', objectives: ['a', 'b', 'c', 'd'], contract: contract({ cnvWindow: 3, cnvThreshold: 3, maxConsecutiveBlocked: 100 }) },
    {
      bus,
      loopStore: store,
      runOne,
      finished: new Set([0, 1, 2]),
      outcomes: [
        { outcome: 'couldNotVerify', verifierKey: 'model:a' },
        { outcome: 'couldNotVerify', verifierKey: 'model:a' },
        { outcome: 'couldNotVerify', verifierKey: 'model:a' },
      ],
    },
  );
  expect(result.reason).toBe('verifier-health');
  expect(result.started).toBe(0);
  expect(seen).toEqual([]);
});
```

- [ ] **Step 3: Run focused loop tests**

Run:

```powershell
npm run test -- test/capabilities/goal/loop.test.ts
```

Expected: PASS after Task 3 changes.

---

### Task 7: Update Handoff Docs

**Files:**
- Modify: `docs/handoff-next.md`
- Modify: `docs/handoff-codex.md`

- [ ] **Step 1: Update loop status after implementation**

In both handoff files, replace the loop backlog sentence with wording that says:

```md
per-goal heterogeneous verifier 已落地：`npm run loop -- <objectives> --verifier-map <cwd外 JSON>` 可按 objective index 覆盖腿3模型；配置 realpath 后拒 cwd 内，schema 严格校验，resume 不信 loop/goal 日志里的 verifier 配置；`VerifierHealthMonitor` 按 verifier key 分桶。
```

- [ ] **Step 2: Keep remaining defer accurate**

Keep these as remaining loop backlog:

```md
并行目标（需 worktree 隔离）/ cron 守护仍 defer。
```

- [ ] **Step 3: Run docs smoke**

Run:

```powershell
git diff --check
```

Expected: PASS.

---

### Task 8: Full Verification And Commit

**Files:**
- All changed files from Tasks 1-7.

- [ ] **Step 1: Run focused tests**

Run:

```powershell
npm run test -- test/capabilities/goal/loop-verifier-config.test.ts test/cli/loop-args.test.ts test/capabilities/goal/loop.test.ts test/capabilities/goal/loop-store.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the full four gates**

Run:

```powershell
npm run test
npm run typecheck
npm run build
npm run lint
```

Expected:

- `npm run test`: PASS
- `npm run typecheck`: PASS
- `npm run build`: PASS
- `npm run lint`: PASS

- [ ] **Step 3: Run whitespace check**

Run:

```powershell
git diff --check
```

Expected: PASS.

- [ ] **Step 4: Dispatch adversarial review**

Ask a fresh review agent to attack:

```text
Review per-goal loop verifier as an adversary. Focus on trusted-config bypasses, same-model independence theater, resume trusting cwd logs, typoed config silently disabling verifier, verifier-health mixing different judges, and any path where loop gains completion authority. Return only blocking findings with file/line references.
```

Expected: no HIGH/MEDIUM findings before commit. If findings land, fix them and rerun focused tests plus the four gates.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src/capabilities/goal/loop-verifier-config.ts src/capabilities/goal/index.ts src/capabilities/goal/loop.ts src/capabilities/goal/loop-store.ts src/surfaces/cli/loop-args.ts src/surfaces/cli/loop-cli.ts test/capabilities/goal/loop-verifier-config.test.ts test/capabilities/goal/loop.test.ts test/capabilities/goal/loop-store.test.ts test/cli/loop-args.test.ts docs/handoff-next.md docs/handoff-codex.md docs/superpowers/plans/2026-07-01-loop-per-goal-verifier.md
git commit -m "Add per-goal loop verifier plan"
```

Use the final implementation commit message if code has landed:

```powershell
git commit -m "Add per-goal loop verifier selection"
```

## Self-Review

Spec coverage:

- Per-goal verifier source: Task 1 and Task 5.
- Trusted path boundary: Task 1 loader tests.
- Strict malformed behavior: Task 1 parser tests and explicit loader failure.
- Resume safety: Task 5 recomputes decisions; Task 6 keyed health replay.
- Cross-goal health: Task 3 and Task 6.
- Docs and verification: Task 7 and Task 8.

Placeholder scan:

- No placeholder marker remains in the task text.
- No empty "add validation" steps.
- Every code-changing task includes exact target files and concrete snippets.

Type consistency:

- `LoopVerifierDecision.key` feeds `GoalRunSummary.verifierKey`.
- `LoopStore.recordFinished.verifierKey` persists the same optional key.
- `LoopReplay.outcomes` feeds `LoopDeps.outcomes`.
