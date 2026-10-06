/** Concrete Web projection only. Session, PermissionGate and Goal remain the authorities. */
export type GuiRunStatus = 'idle' | 'starting' | 'running' | 'approval' | 'pausing' | 'paused'
  | 'checking' | 'stopping' | 'interrupted' | 'blocked' | 'complete' | 'recoverable' | 'unavailable';

/** Transport state of one GUI subscriber. It never overrides a persisted runtime fact. */
export type GuiConnectionState = 'loading' | 'connecting' | 'connected' | 'disconnected' | 'unavailable';

export interface GuiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  status: 'running' | 'complete' | 'incomplete';
  toolIds: string[];
}

export interface GuiTool {
  id: string;
  name: string;
  arguments: string;
  status: 'proposed' | 'running' | 'committed' | 'denied' | 'failed' | 'unknown';
  output?: string;
  path?: string;
}

export interface GuiApproval {
  requestId: string;
  toolName: string;
  capability: string;
  reason: string;
  detail: string;
  arguments: string;
}

export interface GuiLiveSnapshot {
  id: string;
  sequence: number;
  objective: string;
  cwd: string;
  model: string;
  sessionId: string;
  goalId: string;
  status: GuiRunStatus;
  phase: string;
  nextAction: string;
  startedAt: string;
  elapsedMs: number;
  messages: GuiMessage[];
  tools: GuiTool[];
  approval: GuiApproval | null;
  approvalHistory: Array<{ requestId: string; toolName: string; decision: string; reason?: string }>;
  pendingInputs: string[];
  completion: { granted: boolean; verdict: string; rationale: string };
  evidenceToken: string | null;
  review: null | { requirements: Array<{ requirementId: string; text: string; reason: string }> };
  checks: Array<{ command: string; code: number | null; output: string }>;
  diff: string;
  artifacts: Array<{ path: string; outcome: string }>;
  usage: { inputTokens: number; outputTokens: number; costCny: number | null; costNote: string };
  limits: { maxRounds: number; maxTurns: number; turnTimeoutMs: number; wallClockMs: number };
  sources: { session: string; goal: string; approvals: string; events: string };
  warnings: string[];
  capabilities: { submit: boolean; pause: boolean; continue: boolean; stop: boolean; resume: boolean };
}

export interface GuiLiveOverview {
  cwd: string;
  enabled: boolean;
  task: { objective: string; requirements: string[] } | null;
  sessions: Array<{ id: string; objective: string; status: GuiRunStatus }>;
  activeId: string | null;
}

/** Full projection replacement makes replay idempotent; sequence belongs to one task event journal. */
export interface GuiStreamFrame {
  id: string;
  sequence: number;
  snapshot: GuiLiveSnapshot;
}
