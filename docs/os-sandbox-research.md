# OS sandbox research

> Snapshot: 2026-07-02. Scope: unblock the two deferred items in `docs/handoff-next.md`: #2 objective routing and #6 verifier exec.
> Update 2026-07-03: minimal builder-facing `sandboxed_check` and `browser_smoke(static-dist)` paths now run fixed feedback checks in the OS sandbox and return output to the builder. They are self-iteration feedback channels with no verdict or completion authority.

## Decision summary

Recommended direction after Phase 3 v1: keep `cannotVerify -> park` and unattended raw bash `fail-closed deny` for generic runtime/app/browser/network work. The useful sandbox surface is a narrow `SandboxRunner` capability contract with fixed callers, visible audit evidence, and no fallback to raw `bash`. Do not turn the bash analyzer or command allow-list into unattended auto-allow.

Best next prototype on Luis' current machine: WSL2-backed Linux sandbox, because WSL2 Ubuntu exists locally and exposes user namespace quota plus cgroup v2. It still needs a deliberate runtime story: run from a copied project snapshot inside the Linux filesystem, keep Windows mounts out of scope, start with network disabled, and install/use a real sandbox primitive only after approval.

Windows-native AppContainer is the stronger long-term native Windows route, but it has higher implementation cost and likely needs a small native helper. Docker/Podman would give better operational UX if already installed; on this machine they are not present, and installing them is a system-level action.

## Current project boundary

The project already made the correct safety call:

- The verifier is pure file forensics. It has only `read` and `grep`.
- Runtime/app/browser requirements route to `cannotVerify`, then `decideVerdict` parks the goal for a human.
- `PermissionGate` deny is absolute, fail-closed, and the model never decides approval.
- Bash command analysis is a deny-oracle for human review. It cannot prove that arbitrary generated code is safe.
- Command-scoped session allow is attended-only. Unattended bash autonomy remains blocked on OS sandboxing.

This boundary preserves the user experience that matters most: Jarvis stays honest about what it can verify, and it avoids a false sense of autonomy.

## Capability target

A sandbox runner is useful only if it can enforce these properties independently of model output:

| Property | Required behavior |
| --- | --- |
| Filesystem | Run against a prepared project snapshot. Mount source read-only. Provide a small writable tmp/output area. No access to user home, shell profiles, SSH keys, browser cookies, `.env`, or Jarvis hidden verifier assets. |
| Network | Default no network. Any future network mode must be explicit, visible in the event stream, and unavailable to the verifier by default. |
| Process | Timeout, process-tree kill, PID limit, CPU/memory budget, output cap, and no background process escape. |
| Identity | Low-privilege identity/token. Strip inherited secret env. Do not inherit shell startup files. |
| Audit | Record command, cwd, sandbox backend, mounts, network mode, resource limits, exit code, duration, and capped stdout/stderr. |
| Failure mode | If sandbox creation fails or backend is unavailable, return an unverifiable result. Do not fall back to raw `bash`. |

## Option matrix

| Option | What it solves | Fit for Jarvis | Main risk/cost |
| --- | --- | --- | --- |
| Current boundary: no OS sandbox | Keeps verifier honest and unattended safe. | Keep as baseline. | No autonomous runtime verification. |
| Windows Job Object only | Process tree lifetime, accounting, and some resource limits. | Useful hardening for `runCommand`, insufficient as sandbox. | Does not isolate filesystem or network. |
| Windows restricted token + Job Object | Drops privileges and tightens process rights. | Possible medium step for native Windows. | Per-directory read-only and network denial are still awkward; arbitrary app behavior remains hard to reason about. |
| Windows AppContainer + Job Object | Native Windows app/process isolation with file, registry, credential, device, network, process, and window boundaries. | Best Windows-native security direction. | Needs profile/token/ACL lifecycle and probably a native helper; higher maintenance cost. |
| Windows Sandbox / Hyper-V VM | Strong disposable VM boundary. | Good manual danger lab, weak per-command primitive. | Heavy startup, interactive bias, state handoff friction. |
| WSL2 + Linux primitives | Can combine namespaces, Landlock/bubblewrap, cgroup v2, seccomp-style constraints. | Best local prototype path if we keep Windows mounts and host secrets out. | Needs Linux runtime setup, careful mount policy, and clarity that WSL integration itself is not the policy boundary. |
| Docker/Podman | Mature UX for read-only rootfs, no-network, volumes, pid/cpu/memory limits. | Good if already available or later approved. | Docker/Podman not installed here; daemon/socket trust is a separate high-value boundary. |
| Remote sandbox service | Strong isolation without local host changes. | Later option for CI/cloud workflows. | Cost, latency, privacy, and provider dependency. |

## Local machine evidence

Host probe:

- Windows 11 Pro, build 26200.
- Hypervisor present.
- `docker`, `podman`, and `bwrap` are not on the Windows PATH.
- WSL exists. Default distro: `Ubuntu-24.04`, WSL2.

WSL probe:

- Kernel: `6.6.87.2-microsoft-standard-WSL2`.
- `user.max_user_namespaces = 63637`.
- cgroup filesystem: `cgroup2fs`.
- cgroup controllers include `cpu`, `io`, `memory`, and `pids`.
- Installed tools found: `unshare`, `systemd-run`, `python3`.
- Missing inside WSL: `bwrap`, `firejail`, `docker`, `podman`, native Linux `node`.
- `npm` resolves to `/mnt/c/Program Files/nodejs//npm`, which means the current Linux environment would accidentally cross into the Windows runtime. A real prototype should install or provide Linux-local runtime dependencies only after approval.
- WSL emits a localhost proxy warning in NAT mode. Treat network policy as explicit work, not an assumed default.

No-download smoke script:

- Entry: `npm run sandbox:smoke`.
- File: `scripts/os-sandbox-smoke.ts`.
- Backend: WSL2 `Ubuntu-24.04`, Linux `unshare`, `python3`, and cgroup v2. No package download or production runtime wiring.
- 2026-07-02 result on this machine: `PASS=14 FAIL=0 WARN=0 INFO=3`.
- Proven in the smoke: bind a fixture source read-only, deny writes to source, allow writes to an output area, hide Windows mounts by shadowing `/mnt`, hide Linux home by shadowing `/home`, block outbound socket connect via network namespace, bound a long command with `timeout`, and cap host-side output preview.
- Caveat: the script intentionally leaves the WSL `/tmp/jarvis-sandbox-smoke.*` fixture in place for inspection. It does not delete files or directories automatically.

Real runner smoke:

- Entry: `npm run sandbox:runner-smoke`.
- File: `scripts/os-sandbox-runner-smoke.ts`.
- Path: explicit `createWsl2UnshareSandboxRunner()` call. This bypasses the model-facing `sandboxed_exec` allow scope so the smoke can test isolation behavior such as denied writes and blocked network connects.
- 2026-07-02 result on this machine: passed.
- Proven in the smoke: command cwd is `/tmp/jarvis-sandbox/project`, `package.json` is visible through the read-only project mount, writing to the project root is denied, `/mnt/c` and `/mnt/h` are hidden, outbound socket connect is blocked, a forced long command returns `timed-out`, and the result reports `[sandbox backend: wsl2-unshare]` with exit code 0.
- Security hardening: the WSL wrapper starts with `python3 -` rather than an outer bash, strips `BASH_ENV`, `ENV`, credential-shaped env vars, and inherited `GIT_*` values before launch, then gives inner commands a scrubbed env with fixed Git config to disable pager, external diff, fsmonitor, hooks path, and interactive diff filter. Sandboxed bash commands use `bash --noprofile --norc -c`, so they do not load login profiles or rc files.
- Current WSL limit support is intentionally narrow: `timeoutMs` and `outputBytes` are enforced; `maxProcesses`, `memoryBytes`, and `cpuMillis` fail closed with `failed-to-start` until a real cgroup/job-control implementation exists.
- Temp policy: the WSL runner creates host-known `/tmp/jarvis-wsl2-unshare-*` payload folders and cleans them by default. If WSL spawn fails or the host-side timeout kills the runner before guest `atexit` can run, the host performs a best-effort second WSL cleanup against that known temp root. Smoke/debug callers can pass `retainTempDirs: true` to keep WSL payload folders for inspection.

GoalLoop sandbox smoke:

- Entry: `npm run sandbox:goal-smoke`.
- File: `scripts/os-sandbox-goal-smoke.ts`.
- Path: creates a trusted sandbox check plan outside the repository, loads it through `loadSandboxedCheckPlan()`, runs `runGoal()` with a fake builder/model and real `createWsl2UnshareSandboxRunner()`, then verifies completion through `decideVerdict`.
- 2026-07-02 result on this machine: passed.
- Scope: proves the opt-in goal verifier path can produce a runtime-proof `verified` verdict without calling an external model. It does not register `sandboxed_exec` in the default tool registry and does not make the normal verifier execute arbitrary commands.
- Caveat: the script leaves `%TEMP%\jarvis-sandbox-goal-plan-*` in place for inspection and explicitly asks the runner to retain WSL payload folders. Production callers use the runner default cleanup path.

## External source notes

Primary-source findings:

- Microsoft Job Objects can terminate associated processes when the job handle is closed with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; they are process/resource management, not a full filesystem/network sandbox. Source: [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).
- Microsoft AppContainer is designed to restrict application process access to system resources, user data, credentials, devices, files, network, processes, and windows unless explicitly permitted. Sources: [Implementing an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer), [AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation).
- `CreateRestrictedToken` can create a restricted access token and the result can be used with `CreateProcessAsUser`. Source: [CreateRestrictedToken](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken).
- Windows Sandbox is a disposable VM-style environment; closing it discards software and files, and networking can be configured. Source: [Windows Sandbox](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/).
- Linux seccomp filters syscalls and reduces kernel attack surface; the kernel docs explicitly warn that syscall filtering alone should not be treated as a full sandbox. Source: [Linux seccomp filter](https://docs.kernel.org/userspace-api/seccomp_filter.html).
- Linux Landlock lets unprivileged processes restrict their ambient filesystem and network rights, and restrictions apply to the process plus future children. Source: [Linux Landlock](https://docs.kernel.org/userspace-api/landlock.html).
- Linux namespaces partition process views, but they need composition with mount, user, pid, network, cgroup, and other controls. Source: [Linux namespaces](https://man7.org/linux/man-pages/man7/namespaces.7.html).
- Linux cgroups track and limit process groups. Source: [Linux cgroups](https://man7.org/linux/man-pages/man7/cgroups.7.html).
- Docker supports read-only root filesystems, no-network style operation, pid/cpu/memory/cgroup options, and volume control. Docker socket bind mounts grant host-daemon control and must be avoided for untrusted work. Source: [docker run reference](https://docs.docker.com/reference/cli/docker/container/run/).
- Bubblewrap creates an empty mount namespace/root tmpfs and lets callers bind only selected paths. Its README states that callers must define the policy model. Source: [bubblewrap README](https://github.com/containers/bubblewrap).

## Recommended roadmap

### Phase 0 - contract and no-op integration

Status on 2026-07-02:

- `src/runtime/sandbox/sandbox-runner.ts` defines the `SandboxRunner` contract, request shape, audit shape, limits, mount policy, network mode, and result union.
- `createUnavailableSandboxRunner()` is the only runtime implementation. It records the request into an audit result and returns `status: "unavailable"`.
- `test/runtime/sandbox-runner.test.ts` proves the unavailable runner does not execute the requested command and snapshots audit data.
- `src/runtime/index.ts` exports the contract for later integration, but no verifier, PermissionGate, or bash path calls it yet.

Deliverables:

- Add a `SandboxRunner` design note or interface sketch with the fields in the capability target above.
- Keep `verifier.ts` read/grep-only.
- Keep unattended bash fail-closed.
- Add documentation that `SandboxRunner` unavailable means `cannotVerify`, never raw command fallback.

Acceptance:

- No production behavior change.
- Security review can point to one contract for files, network, process, identity, audit, and failure mode.

### Phase 1 - local proof of capability

Prototype outside the agent loop first. A first no-download smoke now exists as `npm run sandbox:smoke`; keep it as capability evidence, not production enforcement.

Recommended WSL2 shape:

1. Keep using a temporary Linux-side fixture until dependency/runtime choices are approved.
2. Run harmless commands with a read-only source bind and writable output/tmp.
3. Prove writes to source fail.
4. Prove Windows mounts and Linux home are hidden in the namespace.
5. Prove network is disabled or explicitly marked unavailable.
6. Prove timeout bounds long-running commands.
7. Prove output previews are capped.

Candidate commands:

- Start with `python3` or shell-only probes because Linux-local Node is not installed.
- Use Node/npm only after a Linux-local runtime is explicitly approved and separated from `/mnt/c`.

Acceptance:

- Evidence log shows the sandbox prevents source writes, secret reads, network use, and process escape.
- Failure to create sandbox returns a structured unavailable result.
- No Jarvis verifier exec yet.

### Phase 2 - sandboxed inspection exec

Add a narrow internal tool, for example `sandboxed_exec`, but keep it out of the default registry until tests prove the boundary.

Status on 2026-07-02:

- `src/core/tools/sandboxed-exec.ts` adds `createSandboxedExecTool({ runner })`.
- The tool declares `capability: "executes-code"` so PermissionGate treats it like code execution if a caller explicitly registers it later.
- `buildDefaultRegistry()` does not register `sandboxed_exec`.
- The tool forces `networkMode: "none"` and mounts the project cwd read-only into the sandbox request.
- `src/core/tools/sandboxed-inspection-command.ts` restricts `sandboxed_exec` to one simple inspection command: no pipes, redirects, control flow, variables, command substitution, globs, absolute paths, parent traversal, or sensitive paths. Current programs are intentionally narrow: `git status`, `git diff`, `git log`, `git ls-files`, `stat`, and `wc`.
- The default sandbox cwd is `/tmp/jarvis-sandbox/project` so the WSL2 unprivileged namespace can create the mount target without sudo.
- With `createUnavailableSandboxRunner()`, the tool returns `Sandbox unavailable: ...` and never falls back to raw bash.
- `src/runtime/sandbox/wsl2-unshare-runner.ts` adds an opt-in `createWsl2UnshareSandboxRunner()` implementation using `wsl.exe`, Linux `unshare -Urnmpf --mount-proc`, read-only bind mounts, tmpfs shadows over `/mnt` and `/home`, no network namespace, timeout, process group kill, output cap, scrubbed env, fixed Git inspection config, host-known WSL payload temp roots with default cleanup plus host-side timeout cleanup, an explicit `retainTempDirs` smoke/debug option, and fail-closed rejection for unsupported resource limits.
- `test/tools/sandboxed-exec.test.ts` covers default-registry absence, request shape, network mode, read-only mount, and unavailable no-exec behavior.
- `test/tools/sandboxed-inspection-command.test.ts` covers allowed inspection commands and rejects interpreters, writes, file listing, network-adjacent Git actions, shell composition, redirects, sensitive paths, and absolute paths.
- `test/runtime/wsl2-unshare-runner.test.ts` covers WSL spawn shape, scrubbed shell startup hooks and credential-shaped env, default temp cleanup plus explicit retain, host-side cleanup after spawn timeout, structured marker parsing, no-marker fail closed, spawn timeout mapping, and network mode rejection before spawn.

Allowed early scope:

- Deterministic inspection commands that do not run project code: currently `git status`, `git diff`, `git log`, `git ls-files`, `stat`, and `wc`, each under the single-simple-command allow scope above.

Hold back:

- `find`, broad file listing, `cat`, `grep`, `npm test`, app start, browser driving, arbitrary interpreters, package installation, and network. Existing `read`/`grep` tools remain better for ordinary file access because they already enforce secret-path policy.

Required tests:

- Cannot write source.
- Cannot read `.env`, hidden held-out files, home secrets, SSH keys, or browser state.
- Cannot use network in default mode.
- Timeout kills child processes.
- Output is capped.
- Backend unavailable routes to `couldNotVerify`.
- No code path falls back to raw `bash`.

### Phase 2.5 - sandboxed builder project checks

Status on 2026-07-03:

- `src/core/tools/sandboxed-builder-check.ts` adds `createSandboxedBuilderCheckTool({ runner })`.
- The tool is named `sandboxed_check` and is registered only into goal/loop builder registries, not into `buildDefaultRegistry()`.
- Input accepts only `check: "typecheck" | "lint" | "test" | "build"`, mapping to `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`.
- The tool declares `capability: "read-only"` because the command surface is fixed by the harness, the host project is mounted read-only, writes go to a sandbox-local copy, secret-shaped paths (`.env`, `.ssh`, private keys, credentials, registry auth files) are excluded from the snapshot, and network is disabled.
- Non-zero check exits return stdout/stderr/exit code as normal builder feedback. Sandbox unavailable, failed-to-start, and timeout are tool errors with audit context.
- `src/surfaces/cli/goal-cli.ts` and `src/surfaces/cli/loop-cli.ts` register the tool for builders via `registerBuilderSandboxTools(...)`. The verifier registry remains `read`/`grep` only.
- `test/tools/sandboxed-builder-check.test.ts` and `test/cli/builder-sandbox-tools.test.ts` cover default-registry absence, fixed request shape, read-only host mount, sandbox-local copy, non-zero output feedback, arbitrary command rejection, and builder registry wiring.

Local runtime caveat:

- The WSL backend still depends on Linux-local `node/npm` to run these project checks successfully. If the backend lacks that runtime, the result is a sandbox failure or a non-zero check output that the builder can see. The harness still does not install dependencies, enable network, or fall back to host raw bash.

Acceptance:

- Builder can iterate on `typecheck/lint/test/build` failures without asking for generic bash approval.
- The tool cannot prove trusted requirements, merge verifier reports, or mark a goal complete.
- Host project writes from build artifacts stay outside the working tree unless the builder separately edits files through gated tools.

### Phase 2.6 - fixed browser smoke feedback

Status on 2026-07-03:

- Design doc: `docs/superpowers/plans/2026-07-03-fixed-browser-smoke-feedback-design.md`.
- `src/core/tools/browser-smoke.ts` adds `createBrowserSmokeTool({ runner })`.
- The tool is named `browser_smoke` and is registered only into goal/loop builder registries through `registerBuilderSandboxTools(...)`.
- Manual entry: `npm run sandbox:browser-smoke`.
- Current input is fixed to `profile: "static-dist"`, with no model-authored command, arbitrary URL, host, port, browser path, or extra env. Requests for `local-preview` are rejected before runner invocation.
- `static-dist` opens `dist/index.html` from a sandbox-local copy with `networkMode: "none"`.
- `local-preview` remains blocked until the sandbox backend proves loopback-only networking with no external route and no host service access.
- Browser smoke output cannot prove trusted requirements, cannot merge into `VerifierReport`, and cannot mark a goal complete.
- Browser runtime must be preapproved and local. The smoke must not download browsers, inherit the user's browser profile, read cookies, use shell startup files, or reuse real home/cache directories.
- If no approved browser is available, the smoke returns an `unavailable` feedback result. This is a skipped manual smoke, not a fallback to host bash or a verifier proof.

Acceptance:

- Arbitrary URL/command schema rejection.
- Default registry and verifier registry absence.
- Read-only host mount plus sandbox-local copy with secret-shaped paths excluded.
- Independent browser profile/cache/temp.
- External request report evidence for static artifacts.
- Timeout is enforced by sandbox limits and browser subprocess timeout.
- No verifier route, route map, or completion path consumes `browser_smoke` output.
- Regression tests show `decideVerdict`, `human` route, and inspection-only `sandbox-command` behavior are unchanged.

### Phase 2.7 - manual real-model autonomous coding smoke

Status on 2026-07-03:

- CI-safe autonomous coding coverage remains in `test/capabilities/goal/autonomous-coding-smoke.test.ts`.
- `scripts/autonomous-coding-model-smoke.ts` adds an opt-in real-model smoke: temp fixture outside this repo, broken `add(a, b)` implementation, builder sees `sandboxed_check(test)` red output, edits only fixture code, reruns until green, then calls `update_goal(complete)`.
- The script registers `sandboxed_check` but does not register browser smoke, bash, network, cron, merge, or cleanup tools.
- It needs a model key and is not part of the default test suite.
- The completion boundary stays unchanged: red/green sandbox feedback is only builder input, while final completion still needs `runGoal` / `decideVerdict`, deterministic checks, and held-out coverage.

### Phase 3 - verifier exec and objective routing

Design entry: `docs/superpowers/plans/2026-07-02-os-sandbox-phase3-design.md`.

Only after Phase 2 passes and the goal-setter-authored requirements contract is accepted:

- Give the verifier sandboxed exec for clearly declared requirements.
- Keep requirement scoring deterministic: runtime-backed evidence can prove an item only when the sandboxed command is tied to that requirement.
- Add `goal-setter-authored-requirements` if objective routing needs stable `(requirement, command)` pairs.
- Route objective items with a pure function such as `hasTrustedCommand -> objective`.

Status on 2026-07-02:

- `src/capabilities/goal/sandboxed-check-report.ts` adds `reportFromSandboxedRequirementChecks(...)`.
- It is a pure mapping layer for trusted `(requirementId, command, SandboxRunResult)` records. It does not spawn, register a tool, or expose verifier exec.
- Completed exit code 0 maps to `proves/matched`; completed non-zero maps to `contradicts/matched`; unavailable, failed-to-start, timed-out, missing check, duplicate check, or unknown requirement maps fail-closed through `cannotVerify` / `couldNotVerify`.
- `test/capabilities/goal/sandboxed-check-report.test.ts` asserts the downstream `decideVerdict` outcomes: all passing trusted checks can verify, sandbox unavailable parks as `couldNotVerify`, and non-zero trusted checks reject.
- Verifier evidence for sandbox checks now includes the sandbox audit context (`backend`, `mounts`, `networkMode`, `limits`) beside the trusted command and stdout/stderr, so later reviews can reconstruct the execution boundary used for each requirement.
- This mapper is only valid for trusted per-requirement commands authored outside the builder. It is not a way to let the model generate its own proof commands.
- `src/capabilities/goal/sandboxed-check-config.ts` adds a trusted JSON plan loader. The plan file must live outside the working directory and, from the CLI path, outside the detected repository/workspace root. It uses a top-level `requirements` array and validates each command with the same sandboxed inspection allow scope.
- `src/capabilities/goal/goal-setter-requirements.ts` adds the Phase 3 route contract loader: `version: 1`, per-requirement `route`, SHA-256 hash, forbidden working-tree boundary checks, loop map builder, and resume path/hash matcher.
- `src/capabilities/goal/composite-verifier-report.ts` merges `sandbox-command`, `llm`, and `human` per-requirement outcomes into one `VerifierReport`. LLM reports cannot score command-backed or human-routed requirements.
- `src/capabilities/goal/goal-loop.ts` now accepts optional `sandboxedRequirementCommands` plus `sandboxRunner`, and optional `goalSetterRequirementRoutes`. With a route map, it runs sandbox and LLM routes separately, then composes the report. If the runner is missing, a command is rejected, a route is missing, or a route result is absent, the result parks through `couldNotVerify`; it never falls back to raw bash.
- `src/surfaces/cli/goal-cli.ts` supports `JARVIS_SANDBOX_CHECKS_FILE=<trusted-json-outside-repo>` for single-goal runs. The path is deleted from `process.env` after loading so the builder cannot read it back via bash.
- `src/surfaces/cli/goal-cli.ts` supports launch-captured `JARVIS_GOAL_SETTER_REQUIREMENTS_FILE=<trusted-json-outside-repo>` for single-goal route contracts. The variable is captured before `.env` loads, deleted from `process.env`, and rejected if combined with `JARVIS_SANDBOX_CHECKS_FILE`.
- `src/surfaces/cli/loop-cli.ts` supports `--sandbox-check-map <trusted-json-outside-repo-and-worktree>` for multi-goal runs. The map is keyed by objective index, stored in the loop header for resume path matching, and reloaded from the current trusted file on every resume. Resume rejects any current `--sandbox-check-map` when the original loop header is missing `sandboxCheckMapPath`, because the original trusted file cannot be proven. CLI loading refuses maps inside the current cwd, detected repository/workspace root, and parallel worktree base root. Use `{"goals":[]}` as the trusted empty map.
- `src/surfaces/cli/loop-cli.ts` supports `--goal-setter-requirements-map <trusted-json-outside-repo-and-worktree>` for multi-goal route contracts. The loop header records the canonical path plus SHA-256 hash, and resume requires the same path/hash before rebuilding the route plan from the current trusted file.
- `src/capabilities/goal/checks.ts`, `goal-cli.ts`, and `loop-cli.ts` capture `git status --porcelain --untracked-files=all` before each goal run and record current status in `goal-round.checks.worktreeStatus`. The default policy is audit-only; `--fail-on-worktree-change` makes status drift a deterministic reject before sandbox/LLM verifier routes run.
- `test/capabilities/goal/sandboxed-check-config.test.ts` covers trusted-file parsing, cwd-outside enforcement, duplicate ids, unknown keys, and command-scope rejection.
- `test/capabilities/goal/goal-setter-requirements.test.ts`, `test/capabilities/goal/composite-verifier-report.test.ts`, and `test/cli/goal-trusted-requirements.test.ts` cover the route contract parser/loader, composite report trust boundary, and single-goal CLI trusted-source loading.
- `test/capabilities/goal/loop-sandboxed-check-config.test.ts` covers per-index trusted sandbox maps, cwd-outside enforcement, resume path matching, and out-of-range indexes. `test/cli/loop-cli-sandbox-map-boundary.test.ts` covers the CLI-only repository root and parallel worktree root forbidden boundaries for sandbox-only maps and goal-setter requirements maps.
- `test/cli/loop-cli-goal-setter-requirements.test.ts`, `test/cli/loop-args.test.ts`, and `test/capabilities/goal/loop-store.test.ts` cover loop CLI route-map wiring, args parsing, and loop-created path/hash replay.
- `test/capabilities/goal/goal-loop-sandboxed-checks.test.ts` covers legacy sandbox-only checks, mixed sandbox+LLM routes, missing LLM provider parking, human route parking, missing runner parking, and unsafe configured commands being rejected before runner invocation.
- A real loop CLI smoke ran on 2026-07-02 with `npm run loop -- <temp-objectives> --sandbox-check-map <temp-map> --unattended`. The run used a trusted map outside repo/worktree, reached `sandboxed verifier...`, and finished `verified` / `complete` / `queue-empty`.
- A real loop CLI route-map smoke ran on 2026-07-02 with `npm run loop -- <temp-objectives> --goal-setter-requirements-map <temp-map> --unattended`. The run used a trusted map outside repo/worktree, showed `Goal-setter requirements: per-goal route-map overrides 1/1 goals`, reached `sandboxed verifier...`, recorded `wsl2-unshare` read-only audit evidence for `stat package.json` and `stat README.md`, and finished `verified` / `complete` / `queue-empty`.

Trusted single-goal plan shape:

```json
{
  "requirements": [
    {
      "id": "r1",
      "text": "The working tree status can be inspected.",
      "command": "git status --short"
    },
    {
      "id": "r2",
      "text": "A human-only or visual requirement without a trusted command."
    }
  ]
}
```

Acceptance:

- Builder cannot author or mutate the command that proves its own requirement.
- Verifier prompt injection still cannot escape read-only/sandboxed capabilities.
- `cannotVerify` remains the fallback for missing or unsupported runtime proof.

## Explicit non-goals

- Do not add unattended bash auto-allow from command patterns.
- Do not load allow policy from the current repo.
- Do not give verifier raw `bash`.
- Do not enable default network for verifier/runtime proof.
- Do not treat Job Objects alone as a security sandbox.
- Do not install Docker, Podman, bubblewrap, or Linux Node without explicit approval.

## Open decisions

1. Primary backend: WSL2 prototype first, or invest directly in Windows AppContainer.
2. Runtime target: inspection-only proof, Node test/build proof, or browser/app proof.
3. Dependency policy: whether installing WSL-local `bubblewrap` and Node is acceptable.
4. Network policy: always off for verifier, or later allow a brokered mode for specific workflows.
5. Event UX: how CLI/GUI should explain sandbox unavailable vs requirement unverifiable.
