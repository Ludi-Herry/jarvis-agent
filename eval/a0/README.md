# A0 development corpus

This directory holds the append-only, versioned A0 inputs defined by `docs/headless-a0-contract.md`.

- `evidence/` contains label-blind bundles. A runner may resolve only the paths listed by `modelVisibleA0Case`; it must never include `classification`, `expectedLeg3`, or `labelOrigin` in a model request.
- Evidence paths are repository-relative and reject absolute/rooted, UNC, extended/device, drive-relative (for example `C:fixture.txt`), `..`-segment, and Windows alternate-data-stream (`:`) forms.
- This lexical parser is only the first boundary. A runner must resolve the repository root and evidence target canonically at the file-open boundary, reject symlink/reparse escapes, and hash the bytes it actually opened before making them model-visible.
- `eval-cases.jsonl` is the harness-side corpus. Expected labels come from a fresh independent review of the evidence bundles and are not copied from stored Jarvis verdicts.
- Runtime observations are written to a caller-selected artifact directory. The runner must not rewrite this corpus or any Session/goal/loop log.

Every tampered observation whose `actualLeg3` is anything other than `contradicts` is a known-bad miss, including `cannotVerify`; all attempts remain in the report.

The six development cases cover valid evidence, tampering/receipt contradictions, and locally ambiguous claims. They freeze the first regression corpus; the separate R1 real-task pass still needs 10–20同形任务、每案三次运行和完整 report，不能把这些 fixtures 冒充真实使用数据。
