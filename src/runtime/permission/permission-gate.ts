/**
 * PermissionGate — the runtime enforcer that sits between the agent loop and every tool's side
 * effect (plan §3.2). The loop calls {@link PermissionGate.check} before running a tool; the
 * gate returns whether to proceed, and on refusal a reason the loop feeds back to the model.
 *
 * It owns the only stateful parts of permissioning — the injected human {@link Approver} and the
 * per-session allowlist — and delegates the actual verdict to the pure {@link decide}. Injection
 * mirrors how A wired EventBus/ContextManager: tests pass a scripted approver, B4 passes the
 * real REPL approver, and absence means non-interactive.
 *
 * Three invariants make this a gate and not a suggestion:
 *  - **deny is absolute.** A hard deny (a secret path, a banned command) is returned before the
 *    approver or the session allowlist is ever consulted, so neither can unlock it. `allow-session`
 *    on `write` can never reach `.env`.
 *  - **fail closed.** No approver (pipe/headless/CI), an approver that throws — both deny. The
 *    safe default when we cannot get a human "yes" is "no" (plan §3.2, Hermes/Codex consensus).
 *  - **the model never decides.** The verdict comes from the capability tag + parsed arguments,
 *    not from anything the model says about its own intent.
 */
import type { ToolCall } from '../../core/types.js';
import type { ToolCapability } from '../../core/tools/types.js';
import { decide, defaultPolicy, type DecisionSource, type PermissionPolicy } from './decide.js';

/** A human's answer to an `ask`. `allow-session` also grants the tool for the rest of the run. */
export type Approval = 'allow-once' | 'allow-session' | 'deny';

/** What an approver is shown when a call needs review. */
export interface ApprovalRequest {
  toolName: string;
  capability: ToolCapability;
  args: Record<string, unknown>;
  /** Why approval is required (from {@link decide}). */
  reason: string;
}

/** The injected approval callback. B1 ships scripted/absent approvers; B4 ships the REPL one. */
export type Approver = (req: ApprovalRequest) => Promise<Approval>;

/** The gate's verdict for one call. `allowed` drives the loop; `reason`/`source` explain it. */
export interface GateOutcome {
  allowed: boolean;
  reason: string;
  source: DecisionSource | 'user' | 'fail-closed';
}

export interface PermissionGate {
  /** Decide and enforce for one tool call. `capability` is `undefined` for an unknown tool —
   *  the gate fails closed on it (an effect it can't classify can't be allowed). */
  check(call: ToolCall, capability: ToolCapability | undefined): Promise<GateOutcome>;
}

export interface GateOptions {
  /** Asked whenever a call resolves to `ask`. Absent → every `ask` fails closed (deny). */
  approver?: Approver;
  /** The risk matrix; defaults to {@link defaultPolicy}. The B5 RuleResolver supplies richer ones. */
  policy?: PermissionPolicy;
}

export class DefaultPermissionGate implements PermissionGate {
  private readonly approver?: Approver;
  private readonly policy: PermissionPolicy;
  /** Tool names the user has approved for the rest of this session (`allow-session`). Keyed by
   *  tool name — "you allowed `write` this session". It only ever short-circuits the `ask` lane;
   *  a `deny` is decided before this is read, so a session grant can never override one. */
  private readonly sessionGrants = new Set<string>();

  constructor(opts: GateOptions = {}) {
    this.approver = opts.approver;
    this.policy = opts.policy ?? defaultPolicy();
  }

  async check(call: ToolCall, capability: ToolCapability | undefined): Promise<GateOutcome> {
    // Unknown tool: no declared capability → no classifiable effect → fail closed. (The model
    // hallucinated a tool that doesn't exist; refusing it with a clear reason is correct.)
    if (capability === undefined) {
      return {
        allowed: false,
        reason: `unknown tool '${call.name}' has no declared capability`,
        source: 'fail-closed',
      };
    }

    const args = parseArgs(call.arguments);
    const decision = decide({ toolName: call.name, capability, args }, this.policy);

    if (decision.action === 'allow') {
      return { allowed: true, reason: decision.reason, source: decision.source };
    }
    // deny is absolute — return before touching the session allowlist or the approver.
    if (decision.action === 'deny') {
      return { allowed: false, reason: decision.reason, source: decision.source };
    }

    // action === 'ask'
    if (this.sessionGrants.has(call.name)) {
      return { allowed: true, reason: `session-approved: ${call.name}`, source: 'user' };
    }
    if (this.approver === undefined) {
      // Non-interactive: there's no human to say yes, so fail closed.
      return {
        allowed: false,
        reason: `approval required but no approver available — ${decision.reason}`,
        source: 'fail-closed',
      };
    }

    let verdict: Approval;
    try {
      verdict = await this.approver({ toolName: call.name, capability, args, reason: decision.reason });
    } catch (err) {
      // An approver that throws (or a timeout, later) is a non-answer → fail closed.
      return { allowed: false, reason: `approver failed — ${message(err)}`, source: 'fail-closed' };
    }

    if (verdict === 'deny') {
      return { allowed: false, reason: `denied by user — ${decision.reason}`, source: 'user' };
    }
    if (verdict === 'allow-session') {
      this.sessionGrants.add(call.name);
    }
    return { allowed: true, reason: `approved by user (${verdict})`, source: 'user' };
  }
}

/** Parse the model's raw JSON arguments leniently — a non-object or unparseable payload yields
 *  `{}`, so the sensitive-path scan simply finds no path and the capability default still gates
 *  the call (the registry surfaces the real JSON error later if it runs). */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw.trim() === '' ? '{}' : raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
