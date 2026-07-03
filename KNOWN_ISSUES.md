# Known Issues

Date: 2026-07-03

- GUI UI/UX polish and Luis section-by-section sign-off are still pending. This blocks public release readiness even though the non-UX blockers are closed.
- `observe` can show the latest emergency-stopped goal as `active` while the enclosing loop is correctly `halted: emergency-stop`; the loop terminal record is authoritative for R3.
- Cron daemon uses a single workspace lock. If a daemon is force-killed, the lock may need stale recovery before another daemon can start.
- Human-review audit writes are local JSONL only; there is no multi-user identity, connector, team workflow, or remote notification layer.
- `loop:finalize --cleanup` still has a LOW follow-up: add a fixture covering verified patch cleanup when a goal worktree contains the `node_modules` dependency bridge.
- Attended bash command-level session allow still has the known scheduler-command TOCTOU limitation described in `docs/security-review-baseline.md`.
- Token accounting for off-bus verifier and pinned-requirement derivation remains approximate.
