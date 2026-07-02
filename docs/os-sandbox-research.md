# OS sandbox research

> Snapshot: 2026-07-02. Scope: unblock the two deferred items in `docs/handoff-next.md`: #2 objective routing and #6 verifier exec.

## Decision summary

Recommended direction: keep the current `cannotVerify -> park` and unattended `fail-closed deny` boundary until a real sandbox runner exists. The first useful research deliverable is a narrow `SandboxRunner` capability contract plus a local proof of capability. Do not turn the bash analyzer or command allow-list into unattended auto-allow.

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
- Caveat: the WSL runner leaves `/tmp/jarvis-wsl2-unshare.*` payload folders and the `/tmp/jarvis-sandbox/project` mount target directory for inspection. It does not auto-delete temp directories.

GoalLoop sandbox smoke:

- Entry: `npm run sandbox:goal-smoke`.
- File: `scripts/os-sandbox-goal-smoke.ts`.
- Path: creates a trusted sandbox check plan outside the repository, loads it through `loadSandboxedCheckPlan()`, runs `runGoal()` with a fake builder/model and real `createWsl2UnshareSandboxRunner()`, then verifies completion through `decideVerdict`.
- 2026-07-02 result on this machine: passed.
- Scope: proves the opt-in goal verifier path can produce a runtime-proof `verified` verdict without calling an external model. It does not register `sandboxed_exec` in the default tool registry and does not make the normal verifier execute arbitrary commands.
- Caveat: the script leaves `%TEMP%\jarvis-sandbox-goal-plan-*` plus the WSL runner temp folders in place for inspection. It does not auto-delete temp directories.

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
- `src/runtime/sandbox/wsl2-unshare-runner.ts` adds an opt-in `createWsl2UnshareSandboxRunner()` implementation using `wsl.exe`, Linux `unshare -Urnmpf --mount-proc`, read-only bind mounts, tmpfs shadows over `/mnt` and `/home`, no network namespace, timeout, process group kill, output cap, scrubbed env, fixed Git inspection config, and fail-closed rejection for unsupported resource limits.
- `test/tools/sandboxed-exec.test.ts` covers default-registry absence, request shape, network mode, read-only mount, and unavailable no-exec behavior.
- `test/tools/sandboxed-inspection-command.test.ts` covers allowed inspection commands and rejects interpreters, writes, file listing, network-adjacent Git actions, shell composition, redirects, sensitive paths, and absolute paths.
- `test/runtime/wsl2-unshare-runner.test.ts` covers WSL spawn shape, scrubbed shell startup hooks and credential-shaped env, structured marker parsing, no-marker fail closed, spawn timeout mapping, and network mode rejection before spawn.

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

### Phase 3 - verifier exec and objective routing

Only after Phase 2 passes:

- Give the verifier sandboxed exec for clearly declared requirements.
- Keep requirement scoring deterministic: runtime-backed evidence can prove an item only when the sandboxed command is tied to that requirement.
- Add `goal-setter-authored-requirements` if objective routing needs stable `(requirement, command)` pairs.
- Route objective items with a pure function such as `hasTrustedCommand -> objective`.

Status on 2026-07-02:

- `src/capabilities/goal/sandboxed-check-report.ts` adds `reportFromSandboxedRequirementChecks(...)`.
- It is a pure mapping layer for trusted `(requirementId, command, SandboxRunResult)` records. It does not spawn, register a tool, or expose verifier exec.
- Completed exit code 0 maps to `proves/matched`; completed non-zero maps to `contradicts/matched`; unavailable, failed-to-start, timed-out, missing check, duplicate check, or unknown requirement maps fail-closed through `cannotVerify` / `couldNotVerify`.
- `test/capabilities/goal/sandboxed-check-report.test.ts` asserts the downstream `decideVerdict` outcomes: all passing trusted checks can verify, sandbox unavailable parks as `couldNotVerify`, and non-zero trusted checks reject.
- This mapper is only valid for trusted per-requirement commands authored outside the builder. It is not a way to let the model generate its own proof commands.
- `src/capabilities/goal/sandboxed-check-config.ts` adds a trusted JSON plan loader. The plan file must live outside the working directory and, from the CLI path, outside the detected repository/workspace root. It uses a top-level `requirements` array and validates each command with the same sandboxed inspection allow scope.
- `src/capabilities/goal/goal-loop.ts` now accepts optional `sandboxedRequirementCommands` plus `sandboxRunner`. When present and deterministic legs are clean, it runs those commands through the sandbox runner and builds the verifier report through the mapper. If the runner is missing or a command is rejected, the result parks through `couldNotVerify`; it never falls back to raw bash.
- `src/surfaces/cli/goal-cli.ts` supports `JARVIS_SANDBOX_CHECKS_FILE=<trusted-json-outside-repo>` for single-goal runs. The path is deleted from `process.env` after loading so the builder cannot read it back via bash.
- `test/capabilities/goal/sandboxed-check-config.test.ts` covers trusted-file parsing, cwd-outside enforcement, duplicate ids, unknown keys, and command-scope rejection.
- `test/capabilities/goal/goal-loop-sandboxed-checks.test.ts` covers sandbox checks taking precedence over the LLM verifier, missing runner parking, and unsafe configured commands being rejected before runner invocation.

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
