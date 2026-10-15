# Changelog

## Unreleased

- Added plain-v1 GUI groundwork on branch `gui-plain-v1` (draft, pending Owner sign-off and local gates): a static before/after prototype, an approval-card "allow for this task" decision backed by the existing `allow-session` scopes, journaled composer permission modes (discuss / ask / auto; auto skips the ask only for contract file writes, commands still ask, hard denies untouched), baseline-tree undo/redo of contract write paths through a throwaway Git index with stale-token refusal, and a loopback-only `previewUrl` preset with an auto-preview predicate. Mode and undo UI wait for the P1 redesign; screenshot-to-Jarvis is designed only.
- Added GUI workbench batches 0–8 on the frozen V13 discussion baseline: workspace/task registry, discussion branches, read-only Git status, contract-driven free tasks with validated create/start, workspace presets and read-only command probe, concurrency caps, subagent wiring, preview and desk-side terminal panes, Markdown message rendering with code copy, structured pending-approval change previews, openable artifacts with confined file views, a read-only workspace tree, per-file diff blocks, pending-input withdraw/edit, attention and run-vitals strips, and the Owner-signed full-width reading overlay. Live projection now covers 18 fixtures; full gates: typecheck/lint/1,857 tests (2 pre-existing skips) and both builds green. Real-model task verification remains an Owner-scheduled window; the old P3 result stays NOT ACCEPTED.
- Changed deterministic-only results to `checksOnly`; routine project checks no longer authorize goal completion.
- Added Git tamper-baseline enforcement with an explicit serial `--allow-no-git` checks-only override.
- Added trustworthy loop/cron result propagation, stable exit codes, model/goal deadlines, and fail-closed refusal/unknown finish handling.
- Added JSONL integrity diagnostics to observe reports, including partial status, paths, line numbers, and exit code 7.
- Switched the active product route to CLI-first; added checkpoint/rewind, the TUI reducer/renderer/fallback path, and a separate v0.3 Desktop control-surface track.
- Added the unified `jarvis` root command, package bin metadata, package-derived version, pre-config `--cwd`, local read-only doctor text/JSON reports, and compatibility forwarding to existing CLI primitives.
- Added strict managed file mutations: read versions, expected-version updates, create-only writes, post versions, same-process serialization, and actionable conflict results.
- Added a bounded `edit` tool for exact, version-checked local replacements, reusing the existing file confinement, atomic write, and receipt path.
- Hardened `loop:finalize --cleanup` so Jarvis detaches only its verified `node_modules` dependency bridge before removing a worktree; unexpected link targets fail closed and host dependencies remain intact.
- Made attended `goal` interruption terminal and auditable: process or readline SIGINT closes the pending approval, records a deny pair, persists the goal as blocked, preserves JSONL, and exits 130.
- Added a three-denial runtime guardrail and tightened the goal prompt so read-only inspection prefers `read`/`grep`, local changes prefer `edit`, and repeated command-shaped approval retries halt as `permissionDenied`.
- Closed the first three-task dogfood stage with an evidence-backed NO-GO: all deliverables were recovered by the main thread, while Jarvis completed 0/3 naturally; safety stayed fail-closed with no false verification or orphan side effects.
- Closed the follow-up convergence/cost engineering stage: delegated tasks now have a whole-run deadline, line-mode denials can return bounded human feedback to the model and audit log, and `read` supports bounded line ranges with continuation hints.
- Recorded a single-task inspect canary as NO-GO: delegation timed out safely and ranged reads worked, while the parent still exceeded the five-minute/product-cost boundary without a final answer; further convergence patches are paused behind a system proposal.
- Narrowed inspect runs to read/grep with an eight-turn default and bounded grep lines/output. The follow-up canary cut visible tokens by about 71% and removed denied tools/offloads, but still ended at maxTurns without a final answer; product status remains NO-GO and further same-class tuning is stopped.
- Recorded a frozen-model comparison: `deepseek-v4-pro-ga-260813` completed the same inspect canary in seven turns with 181,819 visible tokens and 16 tool calls. Task feasibility passed, while product status and default-model adoption remain on hold because the original three tasks are unrevalidated and intermediate reasoning text leaks into the human stream.
- Diagnosed the DeepSeek stream boundary without code changes: the ARK GA non-thinking tool mode places planning text in `content`, while an explicit thinking-mode probe cleanly returns separate reasoning and no think tags. Default-model adoption remains paused behind a model-family thinking policy decision.
- Tested and reverted a run+inspect-only DeepSeek thinking policy. Enabled thinking removed all planning text/tags from content, but the frozen canary hit maxTurns at 256,764 visible tokens and 30 tool calls without a final answer. The previous code path is restored and DeepSeek adoption remains on hold.
- Froze the current Jarvis product route after the v0.1 and two-mode DeepSeek evidence remained NO-GO. The verified engineering baseline and immutable failure evidence are preserved; feature work, model tuning, canary replays, and beta claims are paused until an explicit reopening decision.
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
- Reorganized the documentation around one canonical home per fact: a concise README, a complete document map, current known-issue boundaries, and clearly labeled historical plans and handoffs.

## 0.1.0 GUI-first candidate - 2026-07-03

- Added the GUI read-only console with observe-backed timeline, emergency stop, and human-review controls.
- Routed human-review decisions through trusted `human` route provenance, inline GUI note forms, JSONL audit, verifier report rewrite, and `decideVerdict`.
- Hardened GUI server loopback Host checks, control-plane CSRF headers, malformed URL handling, and non-loopback binding warnings.
- Hardened `loop:finalize` with latest-attempt replay, goal/session/human-audit cross-checks, tracked diff hash proposals, patch hash verification before apply, and safe loop id checks.
- Added cron support for trusted goal-setter requirements maps and recorded real unattended read-only pilot evidence.
- Added emergency-stop terminal records for running loops and parallel loops.
- Landed unattended worktree-isolated write for `--unattended --parallel`, keeping host worktree merge/manual.
- Documented release readiness, known issues, and deferred items for the local v1 line.
