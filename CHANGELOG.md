# Changelog

## 0.1.0 - 2026-07-03

- Added the GUI read-only console with observe-backed timeline, emergency stop, and human-review controls.
- Routed human-review decisions through trusted `human` route provenance, inline GUI note forms, JSONL audit, verifier report rewrite, and `decideVerdict`.
- Hardened GUI server loopback Host checks, control-plane CSRF headers, malformed URL handling, and non-loopback binding warnings.
- Hardened `loop:finalize` with latest-attempt replay, goal/session/human-audit cross-checks, tracked diff hash proposals, patch hash verification before apply, and safe loop id checks.
- Added cron support for trusted goal-setter requirements maps and recorded real unattended read-only pilot evidence.
- Added emergency-stop terminal records for running loops and parallel loops.
- Landed unattended worktree-isolated write for `--unattended --parallel`, keeping host worktree merge/manual.
- Documented release readiness, known issues, and deferred items for the local v1 line.
