/**
 * decide — the PermissionGate's pure decision point (plan §3.2/§3.3, AGENTS.md "决策点写成
 * 无状态纯函数 + 单测").
 *
 * Given WHAT a tool wants to do (its declared {@link ToolCapability}) and WHAT it's about to
 * touch (its parsed arguments), return `allow | ask | deny` with an explainable, categorized
 * reason. Two principles drive the whole milestone:
 *
 *  1. The decision is the RUNTIME's, derived deterministically from the capability tag and the
 *     arguments — never reported by the model. (deepcode's hole was trusting a model-declared
 *     `sideEffects=[]`; we never ask the model what it intends to do.)
 *  2. A secret-bearing path is denied for READ as well as write. deepcode only blocked writes;
 *     reading `.env` to exfiltrate is just as dangerous, so the sensitive-path check runs BEFORE
 *     the capability default and applies regardless of read/write.
 *
 * Stateless and side-effect-free: the stateful parts (asking a human, remembering a session
 * grant) live in the gate (permission-gate.ts), which calls this to get the base verdict.
 * The command-tree parser that classifies `executes-code` calls lands in B2; here such a call
 * just defaults to `ask`.
 */
import type { ToolCapability } from '../../core/tools/types.js';
import { analyzeCommand } from './command.js';

/** The three verdicts. `review` (a deferred-to-a-reviewer lane) is intentionally out of B. */
export type PermissionAction = 'allow' | 'ask' | 'deny';

/** Where a verdict came from, so the reason is explainable (plan §3.2). `command` is the B2
 *  command-tree analyzer; `rule` is the B5 RuleResolver (not emitted yet). */
export type DecisionSource = 'capability' | 'sensitive-path' | 'command' | 'rule';

export interface Decision {
  action: PermissionAction;
  /** Human-readable justification (shown to the user on `ask`, fed to the model on `deny`). */
  reason: string;
  source: DecisionSource;
}

/** What the gate hands `decide`: the tool's name, its declared effect class, and its parsed
 *  arguments (so input-dependent predicates — "is this path a secret?" — can run). */
export interface PermissionRequest {
  toolName: string;
  capability: ToolCapability;
  args: Record<string, unknown>;
}

/** The risk matrix `decide` applies. A built-in {@link defaultPolicy} covers B1; the B5
 *  RuleResolver will produce richer policies (per-path allow/deny) that merge over this. */
export interface PermissionPolicy {
  /** Path patterns whose READ or WRITE is always denied — tested against a normalized
   *  (forward-slashed, lower-cased) path. Secrets, never to be read or written. */
  sensitivePaths: RegExp[];
  /** The default action per capability when no sensitive path or rule matches. */
  capabilityDefault: Record<ToolCapability, PermissionAction>;
}

/** Argument keys that name a filesystem path — the only keys scanned for secrets. Scanning by
 *  key name (not every string) means `write`'s `content` is NOT searched, so a file whose text
 *  merely mentions ".env" isn't denied; only an actual `.env` *target* is. */
const PATH_KEY = /(^|_)(path|file|filename|dir|directory|target)s?$/i;

/**
 * The default risk matrix (plan §3.2 + §3.3 file-path subset). The sensitive list covers the
 * obvious secret shapes; B2's command parser extends coverage to paths buried inside shell
 * commands. It's a plain array so adding a pattern is a one-liner.
 */
export function defaultPolicy(): PermissionPolicy {
  return {
    sensitivePaths: [
      /(^|\/)\.env(\.|$|\*)/, //      .env, .env.local, .env.production, dir/.env, .env* (glob)
      /\.(key|pem|p12|pfx|token|crt|cer)$/, // private keys / certs / tokens by extension
      /(^|\/)auth\.json$/, //         service-account / auth blobs
      /(^|\/)\.npmrc$/, //            holds registry auth tokens
      /(^|\/)\.netrc$/, //            holds machine credentials
      /(^|\/)\.git-credentials$/, //  git stored credentials
      /(^|\/)\.ssh(\/|$)/, //         anything under an .ssh directory
      /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/, // ssh private keys (and .pub — conservative)
      /(^|\/)credentials(\.|$)/, //   aws/gcloud credentials files
      /(^|\/)\.\*$/, //               a bare dotfile glob (`.*`) expands to include secrets like .env
    ],
    capabilityDefault: {
      'read-only': 'allow',
      'writes-files': 'ask',
      'executes-code': 'ask', // B1: no command parser yet → ask; B2 replaces this with a parse
      network: 'ask',
    },
  };
}

/**
 * Decide the action for one tool call. Order is the safety contract: a sensitive-path hit DENIES
 * first (so read-only never lets a secret through), and only then does the capability default
 * apply.
 */
export function decide(req: PermissionRequest, policy: PermissionPolicy): Decision {
  const hit = sensitiveHit(req.args, policy.sensitivePaths);
  if (hit !== undefined) {
    return {
      action: 'deny',
      reason: `'${hit}' is a secret-bearing path; reading or writing it is blocked`,
      source: 'sensitive-path',
    };
  }

  // executes-code is the one capability whose verdict is NOT a static default: parse the command
  // tree deterministically (B2) and deny anything dangerous or secret-touching. A clean command
  // still needs approval — parsing decides "not dangerous", not "trusted".
  if (req.capability === 'executes-code') {
    const command = typeof req.args.command === 'string' ? req.args.command : '';
    const analysis = analyzeCommand(command, policy);
    if (analysis.danger) {
      return { action: 'deny', reason: analysis.reason ?? 'dangerous command', source: 'command' };
    }
    if (analysis.sensitive) {
      return { action: 'deny', reason: analysis.reason ?? 'command touches a secret path', source: 'command' };
    }
    return { action: 'ask', reason: 'runs a shell command — approve to execute', source: 'command' };
  }

  const action = policy.capabilityDefault[req.capability];
  return { action, reason: capabilityReason(req.capability, action), source: 'capability' };
}

/** The first path-like argument value that matches a sensitive pattern, or `undefined`. Array
 *  values (e.g. a multi-path arg) are checked element-by-element. */
function sensitiveHit(args: Record<string, unknown>, patterns: RegExp[]): string | undefined {
  for (const [key, value] of Object.entries(args)) {
    if (!PATH_KEY.test(key)) continue;
    for (const candidate of toStrings(value)) {
      if (patterns.some((re) => re.test(normalize(candidate)))) return candidate;
    }
  }
  return undefined;
}

function toStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/** Normalize for matching: forward slashes + lower case (Windows paths/casing must not let a
 *  secret slip past — `.ENV` and `conf\.env` both normalize to a matchable form). */
function normalize(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

function capabilityReason(capability: ToolCapability, action: PermissionAction): string {
  switch (capability) {
    case 'read-only':
      return 'read-only operation';
    case 'writes-files':
      return 'writes files — review before applying';
    case 'executes-code':
      return 'executes a command — command-tree parsing lands in B2';
    case 'network':
      return 'accesses the network';
    default:
      // Exhaustiveness guard: a new capability without a reason would surface here.
      return `${capability as string} (${action})`;
  }
}
