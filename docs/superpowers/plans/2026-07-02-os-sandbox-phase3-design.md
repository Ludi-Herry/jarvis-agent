# OS Sandbox Phase 3 Design Slice

> Status: implemented slice, 2026-07-02. Parser/loader, composite report, goal CLI, loop CLI, resume matching, docs, tests, and a real loop CLI route-map smoke have landed.

## Goal

Phase 3 promotes the current trusted sandbox check plan into a formal **goal-setter-authored requirements** contract. The aim is to let Jarvis verify objective requirements with sandbox runtime evidence while keeping subjective or human-only requirements on the existing leg-3 path.

Success means:

- Requirement text and optional proof commands come from a trusted goal-setter file outside the repo/worktree, not from the builder or repo-controlled logs.
- Each requirement has one deterministic verification route.
- Resume cannot change the requirement contract through cwd JSONL edits, path swaps, or trusted-file drift.
- Runtime evidence can prove only the requirement it is tied to.
- Missing runner, rejected command, timeout, missing command, unknown id, duplicate id, or changed contract parks or rejects through existing `decideVerdict` rules. It never falls back to raw bash.

## Current Baseline

Already landed:

- `JARVIS_SANDBOX_CHECKS_FILE` for single-goal trusted sandbox checks.
- `--sandbox-check-map <trusted-json>` for loop per-goal sandbox checks.
- WSL2 `createWsl2UnshareSandboxRunner()` with read-only mount, no network, env scrubbing, resource/output limits, default temp cleanup, and host-side timeout cleanup.
- Sandbox report mapping from trusted `(requirementId, command, SandboxRunResult)` to `VerifierReport`.
- Resume path matching for `--sandbox-check-map`, including fail-closed behavior when the original loop header lacks `sandboxCheckMapPath`.

The missing Phase 3 piece is the authority model for requirement creation. Current `pinned` requirements can be LLM-derived; a command attached to those after the fact would reopen reward-hacking. Phase 3 therefore needs the goal-setter to provide the requirements and their proof routes up front.

## Data Model

Use a versioned trusted JSON contract. Keep the first implementation close to the existing plan/map shape, then add route semantics without renaming the user-facing feature mid-flight.

Single-goal file:

```json
{
  "version": 1,
  "requirements": [
    {
      "id": "r1",
      "text": "README documents the sandbox trusted checks entry point.",
      "route": "sandbox-command",
      "command": "git diff -- README.md docs/os-sandbox-research.md"
    },
    {
      "id": "r2",
      "text": "The UX copy is clear enough for a human operator.",
      "route": "llm"
    }
  ]
}
```

Loop file:

```json
{
  "version": 1,
  "goals": [
    {
      "index": 0,
      "requirements": [
        {
          "id": "r1",
          "text": "package.json still defines the test script.",
          "route": "sandbox-command",
          "command": "git diff -- package.json"
        }
      ]
    }
  ]
}
```

Type shape:

```ts
type RequirementRoute = 'sandbox-command' | 'llm' | 'human';

interface GoalSetterRequirement {
  readonly id: string;
  readonly text: string;
  readonly route: RequirementRoute;
  readonly command?: string;
}

interface LoadedGoalSetterRequirements {
  readonly path: string;
  readonly hash: string;
  readonly pinned: PinnedRequirement[];
  readonly routes: Map<string, RequirementRoute>;
  readonly commands: SandboxedRequirementCommand[];
}
```

Route rules:

- `sandbox-command`: `command` is required and must pass `validateSandboxInspectionCommand()` for Phase 3 v1.
- `llm`: `command` is forbidden; the independent verifier scores this requirement with read/grep evidence.
- `human`: `command` is forbidden; the requirement maps to `cannotVerify` until a human or future GUI review path handles it.
- Missing `route` is a schema error in the new contract. Legacy `requirements[].command` without `route` can remain supported only through the existing `sandbox-check` loader during migration.
- `id` is unique per goal, non-empty, stable, and used as the only join key between requirement, command result, LLM score, and final verdict.

Command scope for v1 stays narrow: `git status`, `git diff`, `git log`, `git ls-files`, `stat`, and `wc`. App runners, interpreters, package scripts, browser driving, and networked checks need a later `sandbox-runtime-command` route with a copied Linux-side project snapshot and runtime dependency policy.

## Trust Boundary

Trusted sources:

- Goal-setter-authored JSON file supplied by the operator.
- Canonical realpath outside the current cwd, detected repository/workspace root, and parallel worktree base root.
- Strict schema parser with unknown-key rejection.
- Command allow scope checked at load time and again before runner invocation.

Untrusted sources:

- Builder messages and tool outputs.
- cwd files, including `data/goals/*.jsonl`, `data/loops/*.jsonl`, generated artifacts, and repo content.
- LLM-derived `pinned` requirements when a goal-setter contract is active.
- Any command suggested by the builder, verifier, repo docs, package scripts, hooks, or prior logs.

Boundary decisions:

- The trusted file path and content hash are authority metadata. cwd logs can record them for audit, but cannot replace them.
- The builder may learn requirement text because it needs to implement the goal. It must not learn hidden assertions; those remain `JARVIS_HELDOUT_CHECKS_FILE`.
- Goal-setter requirements are auditable, not secret. Do not put passwords, tokens, secret paths, or hidden expected outputs in the requirement contract.
- Runtime proof evidence can include command, exit code, stdout/stderr, backend, mounts, network mode, and limits. If evidence must stay secret, use held-out checks instead.
- `sandbox-command` proof takes precedence over LLM scoring for the same requirement. The LLM cannot upgrade, downgrade, or reinterpret a command-backed requirement.

## Verification Semantics

Phase 3 should produce a composite `VerifierReport`:

1. Run deterministic legs first: canonical checks, tamper detection, held-out checks.
2. If deterministic legs are clean, route each pinned requirement:
   - `sandbox-command`: run the trusted command in WSL2 sandbox and map status to `proves`, `contradicts`, or `cannotVerify`.
   - `llm`: send only these requirement ids/texts to the existing independent verifier.
   - `human`: add `cannotVerify`.
3. Merge per-requirement scores by id into one report.
4. Reject duplicate, missing, or unknown ids before calling `decideVerdict`.
5. Let the existing `decideVerdict(checks, report, pinned)` compute the final outcome.

Outcome mapping:

- sandbox completed with exit code 0: `proves`.
- sandbox completed with non-zero exit code: `contradicts`.
- runner unavailable, failed-to-start, timed-out, command rejected, missing command, or unsupported route: `cannotVerify`.
- LLM `contradicts` remains a hard reject for LLM-routed requirements.
- Any command-backed requirement with no sandbox result is `cannotVerify`.
- Any requirement omitted from the merged report is `cannotVerify`.

## Resume Semantics

Fresh run writes trusted metadata before any goal work starts:

- `requirementsPath`: canonical trusted file path.
- `requirementsHash`: SHA-256 hash of the canonical file bytes after UTF-8 BOM stripping.
- For loop: store the map path/hash in `loop-created`; each goal keeps only the relevant pinned requirements in `goal-created`.
- For single goal: store path/hash in `goal-created` if a goal-setter contract is active.

Resume rules:

- If the original run recorded a requirements path/hash, the current command must provide the same canonical path and the same hash.
- If the original run recorded a requirements path/hash and the current command omits the requirements file, fail closed before appending new records.
- If the original run lacks requirements path/hash and the current command provides a requirements file, fail closed. This prevents a tampered or pre-Phase-3 log from gaining a new trusted contract.
- If the path matches but hash differs, fail closed. A changed trusted file starts a new goal/loop.
- If the path/hash match, rebuild the route plan from the current trusted file and pass that into `runGoal`. Do not trust `goal.pinned` from cwd logs when an active trusted contract exists.
- Parallel resume keeps the existing worktree rule: the requirements map must be outside cwd, repo root, and worktree base root.

## Implementation Slice

Implemented file-level slice:

1. Added `src/capabilities/goal/goal-setter-requirements.ts`.
   - Parser, loader, SHA-256 hash, path boundary checks, route validation, loop map builder, resume path/hash matcher.
   - Keep current `sandboxed-check-config.ts` as compatibility or have it delegate to the new parser.
2. Added `src/capabilities/goal/composite-verifier-report.ts`.
   - Merge sandbox command results, LLM verifier report for `llm` routes, and human-only `cannotVerify` rows.
   - Enforce exact pinned coverage.
3. Updated `goal-cli.ts`.
   - Decision landed in slice 4: use launch-captured `JARVIS_GOAL_SETTER_REQUIREMENTS_FILE` for the new route contract; keep `JARVIS_SANDBOX_CHECKS_FILE` for legacy sandbox-only compatibility.
   - When a goal-setter contract is present, derive `pinned` from it and skip LLM-derived requirements.
4. Updated `loop-cli.ts`.
   - Decision landed in slice 5: add `--goal-setter-requirements-map <trusted-json>` for the new route contract; keep `--sandbox-check-map` sandbox-only.
   - Store path/hash in loop header and require same path/hash on resume.
5. Updated `runGoal`.
   - Accept a route plan instead of only `sandboxedRequirementCommands`.
   - Run sandbox and LLM routes separately, then merge into one report.
6. Updated docs and ran real smoke coverage.
   - README minimal example.
   - `docs/os-sandbox-research.md` Phase 3 status.
   - Real loop CLI route-map smoke: `npm run loop -- <temp-objectives> --goal-setter-requirements-map <temp-map> --unattended` reached `sandboxed verifier...` and finished `verified` / `complete` / `queue-empty`.

## Test Matrix

Parser and schema:

- accepts a versioned single-goal contract with `sandbox-command`, `llm`, and `human` routes.
- rejects unknown top-level keys, unknown requirement keys, missing `version`, unsupported `version`, empty `requirements`, duplicate ids, blank text, blank id.
- rejects `sandbox-command` without `command`.
- rejects `llm` or `human` with `command`.
- rejects commands outside `validateSandboxInspectionCommand()`.
- keeps legacy sandbox-check parser behavior unchanged until migration is explicit.

Path and trust boundary:

- loads a trusted file outside cwd.
- rejects a file inside cwd.
- rejects a file inside detected repo/workspace root when launched from a subdirectory.
- rejects a symlink or junction that resolves inside cwd/repo/worktree root.
- rejects a loop requirements map inside the parallel worktree base root.
- computes a stable hash after UTF-8 BOM stripping.

Resume:

- same canonical path and same hash passes.
- missing current requirements file fails when original path/hash exists.
- current requirements file fails when original path/hash is missing.
- path mismatch fails.
- hash mismatch fails.
- loop resume fails before appending records on any path/hash mismatch.
- parallel resume still fails on missing worktree after path/hash has passed.

Routing and report merge:

- command-backed requirement with exit code 0 maps to `proves`.
- command-backed requirement with non-zero exit maps to `contradicts`.
- command-backed requirement with unavailable runner maps to `cannotVerify` and blocks.
- command-backed requirement with timeout maps to `cannotVerify` and blocks.
- command-backed requirement with unsafe command is rejected before runner invocation and maps to `cannotVerify`.
- LLM-routed requirement is scored by the independent verifier and merged by id.
- human-routed requirement maps to `cannotVerify`.
- LLM report cannot score ids outside the LLM-routed subset.
- LLM report cannot override a command-backed requirement.
- missing, duplicate, or unknown merged ids produce `couldNotVerify`.
- empty pinned list cannot verify.

CLI and smoke:

- single-goal CLI uses a trusted external contract and reaches `sandboxed verifier...`.
- loop CLI uses a trusted external map and reaches `verified` for a command-backed requirement.
- loop CLI with one command-backed requirement and one human route parks.
- repo-controlled map exits before `loop-created`.
- changed trusted map on resume exits before new loop records.
- no runner path in tests parks without raw bash fallback.

Security review checklist:

- Check that no builder-controlled file can supply requirement commands.
- Check that no cwd JSONL field can widen permissions on resume.
- Check that command-backed evidence cannot be replaced by LLM text.
- Check that unsupported runtime commands fail closed.
- Check that report evidence does not leak held-out secrets.

## Non-Goals

- No general app runner route in Phase 3 v1.
- No browser/app driving verifier.
- No networked verifier command.
- No automatic generation of trusted commands by the builder or verifier.
- No automatic migration of old goal logs into goal-setter contracts.
- No GUI human-review flow for `human` routes.
- No change to held-out secret semantics.

## Open Questions

- Naming: keep `sandbox-check-map` as the user-facing flag for compatibility, or introduce `requirements-map` and keep the old flag as an alias.
- Hash policy: hash raw canonical file bytes or normalized parsed JSON. Raw bytes catch every operator edit; normalized JSON is friendlier across formatting changes.
- LLM subset prompt: create a verifier prompt variant for LLM-routed requirements only, or reuse current prompt with a narrowed pinned list.
- Evidence retention: keep stdout/stderr in report as the current mapper does, or cap more aggressively for Phase 3 contracts.

Recommended defaults:

- Keep existing flags for the first implementation and document the broader meaning.
- Hash raw bytes after BOM stripping, because requirement contracts are authority documents.
- Use a narrowed pinned list for LLM-routed requirements and merge reports deterministically.
- Keep current output caps and audit evidence; rely on the trust rule that goal-setter requirements are auditable and non-secret.
