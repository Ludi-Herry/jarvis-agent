# Fixed Browser Smoke Feedback Design

> Status: design only, 2026-07-03. This is a narrow builder feedback and manual smoke plan. It does not add a verifier route, a fifth map, networked trusted proof, GUI app automation, or unattended generic bash.

## Decision

Build the next browser step as a fixed smoke feedback surface, not as trusted completion evidence.

Allowed first shape:

- Builder feedback tool registered only in goal/loop builder registries, parallel to `sandboxed_check`.
- Manual smoke script for humans to run when they want browser evidence.
- Fixed profile enum, no model-authored command, no arbitrary URL, no repo-controlled verifier route.
- No completion authority. Results can help the builder fix failures, and can help a human review, but they cannot change `decideVerdict`, `VerifierReport`, or `update_goal` semantics.

Keep the current hard boundary:

- `sandbox-command` trusted verifier route remains limited to inspection commands.
- Browser smoke output cannot prove goal-setter requirements.
- `human` route still parks until a separate GUI human-review product flow exists.
- Network defaults to off. Any local loopback mode needs a separate backend proof before implementation.

## Why This Slice

The product need is practical: a builder that can run `typecheck/lint/test/build` still cannot see whether a simple UI renders, crashes on load, or logs browser console errors. A fixed browser smoke gives useful feedback without letting the builder invent proof commands or self-authorize completion.

The risk is also clear: browser checks combine project code execution, an app process, a browser process, HTTP requests, caches, screenshots, and often downloaded browser binaries. Treating that as a trusted verifier would create a false sense of autonomy. The first step should improve iteration, not expand trust.

## MVP Contract

Candidate tool name: `browser_smoke`.

Candidate manual entry: `npm run sandbox:browser-smoke`.

Candidate input:

```ts
type BrowserSmokeProfile = 'static-dist' | 'local-preview';

interface BrowserSmokeInput {
  readonly profile: BrowserSmokeProfile;
  readonly reason?: string;
}
```

Profile rules:

- `static-dist`: opens a fixed built artifact such as `dist/index.html` from the sandbox-local copy. It does not start a server and does not need loopback.
- `local-preview`: starts a fixed package script in the sandbox-local copy, then opens `http://127.0.0.1:<allocated>/`. This profile stays disabled until the sandbox backend proves loopback-only networking with no external route.
- No arbitrary command, host, port, URL, browser executable path, or extra env from the model.
- If a repo lacks the expected artifact or script, return a normal feedback failure with clear stdout/stderr, not a tool schema escape hatch.

Result shape:

```ts
interface BrowserSmokeSummary {
  readonly profile: BrowserSmokeProfile;
  readonly status: 'passed' | 'failed' | 'unavailable' | 'timed-out';
  readonly url: string;
  readonly httpStatus?: number;
  readonly title?: string;
  readonly nonBlankPixels?: number;
  readonly consoleErrors: readonly string[];
  readonly pageErrors: readonly string[];
  readonly blockedRequests: readonly string[];
  readonly durationMs: number;
  readonly sandbox: {
    readonly backend: string;
    readonly networkMode: string;
    readonly mounts: readonly unknown[];
    readonly limits: unknown;
  };
}
```

Tool behavior:

- Completed smoke returns a summary as normal builder feedback.
- Browser missing, runner unavailable, failed sandbox setup, timeout, or loopback unsupported returns a feedback failure with audit context.
- Non-zero smoke result is not a tool exception unless the sandbox itself fails to start.
- The builder can read the result and keep editing through existing tools.

## Sandbox Boundary

Reuse the builder-check snapshot pattern:

- Host cwd mounted read-only.
- Copy into a sandbox-local work directory.
- Exclude `.env`, `.env.*`, `.ssh`, private keys, credentials, registry auth, and certificate/key-shaped paths.
- Independent `HOME`, browser profile, cache, temp dir, and npm cache.
- No inherited secret env or shell startup files.
- Timeout, output cap, process-tree kill, and no background process escape.

Browser-specific rules:

- Use only a browser executable already available to the approved runtime. Do not download browsers during the smoke.
- Never use the user's real browser profile, cookies, extensions, password store, or OS keychain.
- Disable persistent profile storage after the run.
- Capture only capped console/page errors and basic pixel statistics in MVP. Store screenshots only if a later artifact policy says where they go and how they are capped.
- Block or fail any request outside the allowed target. For `static-dist`, external requests should be reported as blocked. For future `local-preview`, only `127.0.0.1:<allocated>` is allowed.

Network policy:

- Default remains `networkMode: "none"`.
- `local-preview` needs a new proven backend capability: loopback-only inside the sandbox namespace. That capability must show there is no external route and no host service access.
- Do not use `networkMode: "explicit"` for browser smoke until it has allowlisted semantics, audit fields, and tests.

## Checks

MVP checks should stay boring and deterministic:

- Page reaches load or DOMContentLoaded before timeout.
- Final URL is the expected fixed target.
- If HTTP is used, status is 2xx or 3xx.
- Screenshot/pixel probe is non-blank. Use a simple threshold that catches all-white/all-transparent/all-black failures.
- `pageerror` entries fail the smoke.
- `console.error` entries fail the smoke unless a future fixed profile explicitly allows known benign messages.
- Requests outside the allowed target fail the smoke and list capped URLs.

The smoke result is still feedback. A passing smoke can never mark the goal complete.

## Implementation Order

1. Add unit tests for the schema and registry boundary:
   - absent from `buildDefaultRegistry()`;
   - present only in goal/loop builder registries;
   - rejects arbitrary command, arbitrary URL, host, port, and browser path;
   - result cannot be passed into `reportFromSandboxedRequirementChecks()`.
2. Add a small pure report mapper for browser smoke summaries.
3. Add a sandbox helper that builds the fixed script for `static-dist` only.
4. Add a fake-browser test harness before using any real browser.
5. Add a real smoke only if a local browser runtime is available without download.
6. Add `local-preview` after loopback-only sandbox proof lands.
7. Add manual `sandbox:browser-smoke` only after the builder tool path is covered.

## Required Tests

Security tests:

- Arbitrary URL and command inputs are rejected before runner invocation.
- Tool does not appear in the default registry or verifier registry.
- No `VerifierReport` path consumes browser smoke output.
- Sandbox request uses read-only host mount and sandbox-local copy.
- Secret-shaped files are excluded from the snapshot.
- Secret-shaped env vars are stripped.
- Browser profile and cache live under sandbox temp/home.
- External requests are blocked or reported as failed.
- Timeout kills app server and browser process tree.

Behavior tests:

- A tiny static fixture with visible text passes.
- A blank page fails non-blank threshold.
- A page with `console.error` fails and reports capped error text.
- A page with an unhandled exception fails and reports capped page error.
- A missing artifact or missing browser returns feedback failure, not raw bash fallback.
- Output is capped and cannot flood builder context.

Regression tests:

- `decideVerdict` outcomes are unchanged.
- `human` route continues to park.
- `sandbox-command` allow scope remains inspection-only.
- `sandboxed_check(typecheck/lint/test/build)` behavior is unchanged.

## Explicit Non-Goals

- No generic browser verifier.
- No app/browser/network requirement route.
- No GUI app automation.
- No arbitrary URL crawler.
- No external network smoke.
- No package installation or browser download during a smoke.
- No use of the user's real browser profile.
- No unattended bash policy change.
- No cron auto-resume, auto-merge, or auto-cleanup behavior.
- No local model routing, cost routing, enterprise connector, or automatic skill sedimentation.

## Open Decisions Before Code

- Browser source: preinstalled Chromium/Chrome path supplied by the operator, a checked-in test browser, or a devDependency with a no-download install policy.
- Artifact policy: whether screenshots are persisted, and if so under which audit directory and retention rule.
- Loopback proof: whether WSL2 can bring up loopback inside the current user/network namespace without exposing host or external routes.
- Profile naming: whether the builder-facing tool should be `browser_smoke` or a new `sandboxed_check` enum value. Prefer a separate builder-only tool if the output shape differs from project checks.
- Failure severity: whether `console.error` always fails, or whether fixed profiles can define known benign messages.

## Stop Condition For The Future Slice

The future implementation slice is done only when:

- `static-dist` runs in a sandbox-local copy with no network and no user profile.
- The builder receives useful failure output for blank page, console error, page error, missing browser, and timeout.
- The verifier/completion path has no import or data dependency on browser smoke output.
- `git diff --check`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and a real or skipped-with-reason browser smoke all have recorded evidence.
