# Changelog

## Unreleased - 2026-08-14

- Changed deterministic-only results to `checksOnly`; routine project checks no longer authorize goal completion.
- Added Git tamper-baseline enforcement with an explicit serial `--allow-no-git` checks-only override.
- Added trustworthy loop/cron result propagation, stable exit codes, model/goal deadlines, and fail-closed refusal/unknown finish handling.
- Added JSONL integrity diagnostics to observe reports, including partial status, paths, line numbers, and exit code 7.
- Switched the active product route to CLI-first; full-screen TUI and checkpoint/rewind are planned before the Desktop UI/UX release line.
- Added the unified `jarvis` root command, package bin metadata, package-derived version, pre-config `--cwd`, local read-only doctor text/JSON reports, and compatibility forwarding to existing CLI primitives.
- Added strict managed file mutations: read versions, expected-version updates, create-only writes, post versions, same-process serialization, and actionable conflict results.
- Added Session JSONL v2 with contiguous sequence numbers, full base composition identity, hashed request receipts, durable tool intent/terminal receipts, pending-effect resume blocking, and legacy v1 read compatibility.
- Halted uncertain tool and child-agent executions as durable unknown effects; tightened v2 logical-execution/projection and compaction-intent validation; parked finalize when receipt coverage is legacy or pending.
- Extended observation with Session format, pending tool effects, and v2 header/version/sequence integrity diagnostics.
- Recorded the GPT-5.6 Sol Pro trust review, implementation corrections, narrowed v0.1 route, and a bounded ZCode/GLM-5.3 sessions handoff.

## 0.1.0 - 2026-07-03

- Added the GUI read-only console with observe-backed timeline, emergency stop, and human-review controls.
- Routed human-review decisions through trusted `human` route provenance, inline GUI note forms, JSONL audit, verifier report rewrite, and `decideVerdict`.
- Hardened GUI server loopback Host checks, control-plane CSRF headers, malformed URL handling, and non-loopback binding warnings.
- Hardened `loop:finalize` with latest-attempt replay, goal/session/human-audit cross-checks, tracked diff hash proposals, patch hash verification before apply, and safe loop id checks.
- Added cron support for trusted goal-setter requirements maps and recorded real unattended read-only pilot evidence.
- Added emergency-stop terminal records for running loops and parallel loops.
- Landed unattended worktree-isolated write for `--unattended --parallel`, keeping host worktree merge/manual.
- Documented release readiness, known issues, and deferred items for the local v1 line.
