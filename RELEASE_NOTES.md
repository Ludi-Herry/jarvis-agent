# Jarvis-Agent 0.1.0 Release Notes

Date: 2026-07-03

This local release candidate closes the non-UX release blockers for the GUI-first v1 path:

- R2 evidence: 6 real-interval cron daemon runs for `r2-readonly-20260703-124756`, all exit 0, all parked as `blocked / couldNotVerify`, false verified count 0.
- R3 evidence: built-in Browser clicked the GUI emergency stop button at `2026-07-03T20:01:55.048Z`; loop `2026-07-03T20-01-28-688Z` recorded `loop-halted` with reason `emergency-stop`.
- R5 evidence: built-in Browser validated the inline human-review form; audit was written to `data/human-reviews/g-human-gui-smoke.jsonl`, and the goal finished `complete / verified` through `decideVerdict`.
- R7 evidence: human-review provenance spoofing and `loop:finalize` false-positive merge paths were mitigated with goal/session/human-audit/diff-hash/patch-hash gates; final codex adversarial review returned `HIGH? no`.

Final local four-gate verification passed for this candidate: `npm run typecheck`, `npm run lint`, `npm run build`, and `npm test` (102 files / 1060 passed / 1 skipped). If the remaining GUI UI/UX pass changes code, rerun the four gates before any external release action. Publishing, pushing, or public deployment remains a manual Luis decision.

Known issues are tracked in `KNOWN_ISSUES.md`.
