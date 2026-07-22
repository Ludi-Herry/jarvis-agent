# Known Issues

Date: 2026-07-22

- GUI UI/UX polish and Luis section-by-section sign-off are still pending. This blocks public release readiness even though the non-UX blockers are closed.
- Cron daemon uses a single workspace lock. If a daemon is force-killed, the lock may need stale recovery before another daemon can start.
- Human-review audit writes are local JSONL only; there is no multi-user identity, connector, team workflow, or remote notification layer.
- `loop:finalize --cleanup` still has a LOW follow-up: add a fixture covering verified patch cleanup when a goal worktree contains the `node_modules` dependency bridge.
- Attended bash command-level session allow still has the known scheduler-command TOCTOU limitation described in `docs/security-review-baseline.md`.
- Token accounting remains partial because off-bus verifier and pinned-requirement derivation calls are unmeasured. `observe` labels this coverage as partial and the missing amount as unknown; loop rollups are displayed separately and no longer added to detailed goal tokens.
