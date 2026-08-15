# Headless agent-event v1 and A0 contract

> Status: frozen for implementation on 2026-08-15. This document defines the machine-output and A0 authority boundary. Adding, removing, or changing a field requires a new schema version; v1 readers validate exact shapes.

## 1. Authority boundary

- The headless stream is an observation and automation transport. It cannot approve tools, alter PermissionGate decisions, create verifier evidence, update a goal, or grant completion.
- `run.finished.completion.granted=true` is valid only for a goal that reached `complete / verified` through `decideVerdict`. Conversational runs and loop-level finishes always use `granted=false`.
- A0 consumes frozen evidence and recorded observations. It never rewrites Session, goal, loop, approval, or audit JSONL.
- Event projection reuses the existing EventBus. No second bus, verifier route, scheduler, map, or database is introduced.

## 2. Transport

The unified CLI accepts a global `--headless` flag for agent-running primitives:

```text
jarvis --headless run "inspect the repository"
jarvis --headless goal "fix the failing test"
jarvis --headless loop objectives.txt
```

Help and version metadata remain human CLI surfaces. Combining `--headless` with root/subcommand
help or version flags is rejected with usage exit 2 and empty stdout; callers must remove the flag.

- stdout contains one compact JSON object per line and no human text.
- Existing human progress and diagnostics move to stderr. The root renders child chunks as inert
  diagnostic records: terminal controls, CR/LF, and Unicode bidi formatting controls become visible
  markers and cannot change terminal state or forge a diagnostic line.
- Existing stable process exit codes remain authoritative.
- Every line is produced with standard JSON serialization. Raw ESC, CR, LF, ANSI color, clear-screen, or cursor-control bytes cannot appear inside a JSONL record.
- Headless mode is non-interactive. A permission decision that needs a person fails closed; it does not read an approval answer from stdin.
- The root process accepts internal event frames only when they carry the per-invocation HMAC delivered through a one-time dedicated descriptor. The child removes all internal transport markers before model or tool execution. An unsigned, altered, or partial frame makes the invocation fail with the runtime exit code; any earlier verified records remain incomplete because no trusted terminal follows.
- An authenticated internal frame is limited to 64 KiB before its newline. The root pauses the
  dedicated event descriptor when public stdout applies backpressure and resumes only on `drain`;
  oversized frames, source errors, and public-output failures all fail the transport closed.
- Transport failure first requests child termination, then escalates to forced termination after a
  bounded grace period. Close/error paths remove signal, stream, drain, and termination listeners.
- v1 `model.*` and `tool.*` cover calls connected to the existing AgentLoop EventBus. Pinned-requirement derivation and verifier-provider calls remain outside that bus. A0 must count those gaps when it measures request reconstruction; the stream cannot imply coverage it did not observe.

## 3. Common event envelope

Every record contains:

```ts
interface AgentEventEnvelopeV1 {
  schemaVersion: 1;
  sequence: number;          // contiguous within this process invocation, starting at 1
  type: AgentEventTypeV1;
  invocationId: string;      // run session id, goal id, or loop id
  sessionId: string | null;  // actual model Session id; null for loop-level events
  cwd: string;
  timestamp: string;         // ISO-8601 UTC
}
```

`sequence` orders the transport stream. It does not replace Session v2 `seq`, request receipts, tool receipts, or any durable store identity.

## 4. Event set and meanings

Each record contains the common envelope plus exactly one payload below. `?` marks the only
optional keys; a v1 reader rejects every unlisted key and invalid enum value.

```ts
type AgentEventPayloadV1 =
  | {
      type: 'session.started';
      root: 'run' | 'goal' | 'loop';
      resumed: boolean;
      model?: string;
    }
  | {
      type: 'model.started';
      modelRunId: string;
      turn: number;
      messageCount: number;
      toolSchemaCount: number;
      requestId?: string;
    }
  | {
      type: 'model.finished';
      modelRunId: string;
      turn: number;
      status: 'completed' | 'halted' | 'failed' | 'timed-out' | 'interrupted';
      requestId?: string;
      finishReason?: 'completed' | 'tool_calls' | 'truncated' | 'filtered' | 'paused' | 'refused' | 'unknown';
      rawFinishReason?: string;
      inputTokens?: number;
      outputTokens?: number;
    }
  | {
      type: 'tool.started';
      modelRunId: string;
      toolCallId: string;
      toolName: string;
      requestId?: string;
      executionId?: string;
    }
  | {
      type: 'tool.finished';
      modelRunId: string;
      toolCallId: string;
      toolName: string;
      outcome: 'committed' | 'denied' | 'failed' | 'unknown';
      requestId?: string;
      executionId?: string;
    }
  | {
      type: 'approval.required';
      requestId: string;
      toolName: string;
      capability: 'read-only' | 'writes-files' | 'executes-code' | 'network';
      reason: string;
    }
  | {
      type: 'approval.resolved';
      requestId: string;
      toolName: string;
      decision: 'allow-once' | 'allow-session' | 'deny' | 'error';
    }
  | {
      type: 'check.finished';
      goalId: string;
      checkId: string;
      kind: 'canonical' | 'tamper' | 'worktree' | 'held-out';
      status: 'passed' | 'failed' | 'unavailable';
      exitCode?: number;
    }
  | {
      type: 'run.finished';
      root: 'run' | 'goal' | 'loop';
      status: 'completed' | 'blocked' | 'unverified' | 'needs-human' | 'failed' | 'interrupted';
      exitCode: number;
      verdict?: 'verified' | 'checksOnly' | 'rejected' | 'couldNotVerify';
      completion:
        | { granted: false; authority: 'none' }
        | { granted: true; authority: 'decideVerdict' };
    };
```

- `session.started` means a durable Session header exists or a validated Session was resumed.
- `model.started` means provider I/O is about to start. When `requestId` is present, the request
  receipt is durable; legacy receipt-disabled sessions omit that identity.
- `model.finished` excludes reasoning and response text.
- `tool.started` means tool intent entered host dispatch. When `executionId` and `requestId` are
  present, the corresponding receipt identity is durable; legacy receipt-disabled sessions omit
  those keys. The event does not prove that a side effect began, and arguments stay excluded.
- `tool.finished` excludes tool output and write content.
- `approval.required` carries a bounded policy reason. Tool arguments and the human-only detail
  stay excluded. `approval.resolved` also excludes arbitrary approver error text. In a loop these
  events retain the active goal Session ID; loop-level terminal records use `sessionId=null`.
- `check.finished` never includes held-out commands or output.
- `run.finished` is the only handled terminal. A granted completion also requires `root='goal'`,
  `status='completed'`, `exitCode=0`, and `verdict='verified'`; the writer rejects every other
  combination.

Ordering invariants:

1. `session.started` precedes model/tool/check events for that Session.
2. Each `model.started` has at most one matching `model.finished`.
3. Each `tool.started` has at most one matching `tool.finished`; a known uncertain execution ends as `unknown`. A missing finish remains an orphan signal.
4. When a tool needs approval, `approval.required` and `approval.resolved` occur after its
   `tool.started` and before its denied `tool.finished`.
5. `run.finished` is last for a normally closed invocation.
6. Stream write failure is a runtime failure; the host cannot silently continue while claiming machine observability.

Usage/config/trust rejection before `session.started` can produce an empty stream and a non-zero process exit. After `session.started`, a missing terminal means an unhandled host failure or failed event transport; consumers must treat the invocation as incomplete.

## 5. A0 case corpus

`eval/a0/eval-cases.jsonl` is append-only. Each case is one strict JSON object:

```ts
interface A0CaseV1 {
  schemaVersion: 1;
  caseId: string;
  classification: 'valid' | 'tampered' | 'ambiguous';
  objective: string;
  evidence: Array<{
    path: string;            // repository-relative
    selector?: string;       // test name, JSONL record selector, or evidence key
    sha256?: string;
  }>;
  expectedLeg3: 'proves' | 'contradicts' | 'cannotVerify';
  labelOrigin: {
    kind: 'independent-review';
    reviewer: string;
    source: string;
    labeledAt: string;
  };
  promptVersion: string;
  modelPolicy: { builder: string; verifier: string };
  repetitions: 3;
  tags: string[];
}
```

The classification and expected label must align: valid→proves, tampered→contradicts, ambiguous→cannotVerify. Labels are newly assigned from the evidence bundle by an independent reviewer; historical stored verdicts cannot be copied as expected labels.

The corpus parser rejects absolute, rooted, drive-relative, device, alternate-data-stream, and
`..` evidence paths. The runner must additionally resolve the repository root and target
canonically at the file-open boundary, reject symlink/reparse escapes, and hash the bytes it
actually opened before making them model-visible.

`promptVersion` and both `modelPolicy` values are opaque, versioned policy IDs. The runner binds them to concrete prompt bytes and model IDs in a separate immutable run manifest; changing either binding requires a new policy/version ID and never rewrites prior cases.

## 6. A0 observations and report

Each case must have attempts 1, 2, and 3. An observation records:

- actual leg-3 label;
- total tokens and latency;
- whether the model-visible request was reconstructable;
- orphan side-effect count;
- receiptless attempt count;
- stale Recall action count.

The pure report computes:

- bad-case miss rate;
- good-case false-positive rate;
- park rate;
- repeated-label consistency;
- mean tokens per case;
- p95 latency;
- request reconstructability rate;
- orphan side effects, receiptless attempts, and stale Recall actions.

A0 GO requires complete 3-run coverage, zero known-bad misses, good-case false-positive rate ≤10%, consistency ≥90%, and zero orphan side effects, receiptless attempts, or stale Recall actions. The runner reports all failures; it cannot rewrite labels or discard attempts to make the gate pass.

## 7. GLM-5.3 implementation seam

After the TypeScript types and pure report tests for this document are green, GLM-5.3 may independently implement:

- strict file loading for `eval/a0/eval-cases.jsonl` and an observations JSONL;
- a read-only CLI that prints the computed report;
- fixture organization and contract tests;
- sessions search/filter/sort/pagination and Windows/help/completion mechanics in a separate worktree.

GLM-5.3 must stop if its work needs to change `decideVerdict`, PermissionGate, GoalLoop completion, Session schema/receipts, headless authority meanings, or any trusted map.
