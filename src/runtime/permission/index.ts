/**
 * permission barrel — public face of `src/runtime/permission` (B1, plan §3.2/§3.3).
 *
 * The agent loop imports {@link PermissionGate} (type) to gate tool calls; the CLI/demo build a
 * {@link DefaultPermissionGate} with an injected approver. The pure {@link decide} and
 * {@link defaultPolicy} stay exported so they're directly testable and reusable by the B5
 * RuleResolver.
 */
export {
  DefaultPermissionGate,
  type PermissionGate,
  type GateOptions,
  type GateOutcome,
  type Approver,
  type Approval,
  type ApprovalRequest,
} from './permission-gate.js';
export {
  decide,
  defaultPolicy,
  type Decision,
  type DecisionSource,
  type PermissionAction,
  type PermissionPolicy,
  type PermissionRequest,
} from './decide.js';
export { analyzeCommand, type CommandAnalysis, type SimpleCommand } from './command.js';
