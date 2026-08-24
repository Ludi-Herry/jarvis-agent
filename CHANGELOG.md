# Changelog

## Unreleased - 2026-08-15

- Changed deterministic-only results to `checksOnly`; routine project checks no longer authorize goal completion.
- Added Git tamper-baseline enforcement with an explicit serial `--allow-no-git` checks-only override.
- Added trustworthy loop/cron result propagation, stable exit codes, model/goal deadlines, and fail-closed refusal/unknown finish handling.
- Added JSONL integrity diagnostics to observe reports, including partial status, paths, line numbers, and exit code 7.
- Switched the active product route to CLI-first; full-screen TUI and checkpoint/rewind are planned before the Desktop UI/UX release line.
- Added the unified `jarvis` root command, package bin metadata, package-derived version, pre-config `--cwd`, local read-only doctor text/JSON reports, and compatibility forwarding to existing CLI primitives.
- Added strict managed file mutations: read versions, expected-version updates, create-only writes, post versions, same-process serialization, and actionable conflict results.
- Added Session JSONL v2 with contiguous sequence numbers, full base composition identity, hashed request receipts, durable tool intent/terminal receipts, pending-effect resume blocking, and legacy v1 read compatibility.
- Added read-only `jarvis sessions list|show` text/JSON reports with integrity, composition, pending-effect, and resume guidance.
- Added dynamic-addendum provenance and resume validation: Skill manifest/source hashes in v2 headers, explicit no-addendum identity for goal/loop, per-run request receipt replay, and fail-closed drift/ambiguity handling.
- Hardened session selection and inspection with one shared ID/path boundary, Windows device-name rejection, filename/header identity checks, symlink/reparse escape refusal, terminal-safe sessions/resume/REPL error output, conservative `ready-for-resume-check` advice, and explicit unreadable or operationally corrupt exit 7 handling.
- Preserved filesystem failure identity through the root `--cwd`, latest-session discovery, and resolver-to-read window: only `ENOENT` maps to not found, while permission and I/O failures remain visible at exit 7.
- Halted uncertain tool and child-agent executions as durable unknown effects; tightened v2 logical-execution/projection and compaction-intent validation; parked finalize when receipt coverage is legacy or pending.
- Extended observation with Session format, pending tool effects, and v2 header/version/sequence integrity diagnostics.
- Completed the v0.3 G1-G4 GUI slices: additive emergency-stop observation, the warm-paper three-region workspace, CLI-equivalent human-review detail/history, bounded read-only approval history, explicit goal/loop timeline filters, and persisted `goal_round` budget progress. Ludi visual acceptance and independent browser verification are recorded in `docs/handoff-next.md`.
- Recorded the GPT-5.6 Sol Pro trust review, implementation corrections, narrowed v0.1 route, and a bounded ZCode/GLM-5.3 sessions handoff.
- Removed the earlier temporary R0.5 implementation notes and the unreferenced root placeholder after explicit cleanup approval.

## 0.1.0 - 2026-07-03

- Added the GUI read-only console with observe-backed timeline, emergency stop, and human-review controls.
- Routed human-review decisions through trusted `human` route provenance, inline GUI note forms, JSONL audit, verifier report rewrite, and `decideVerdict`.
- Hardened GUI server loopback Host checks, control-plane CSRF headers, malformed URL handling, and non-loopback binding warnings.
- Hardened `loop:finalize` with latest-attempt replay, goal/session/human-audit cross-checks, tracked diff hash proposals, patch hash verification before apply, and safe loop id checks.
- Added cron support for trusted goal-setter requirements maps and recorded real unattended read-only pilot evidence.
- Added emergency-stop terminal records for running loops and parallel loops.
- Landed unattended worktree-isolated write for `--unattended --parallel`, keeping host worktree merge/manual.
- Documented release readiness, known issues, and deferred items for the local v1 line.
