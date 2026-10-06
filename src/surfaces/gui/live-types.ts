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

/** Operator-owned task contract. The browser/model cannot edit checks, paths or budgets. */
export interface GuiTaskContract {
  objective: string;
  cwd: string;
  requirements: string[];
  writePaths: string[];
  checkCommands: string[];
  shellCommands?: string[];
  maxRounds: number;
  maxTurns: number;
  wallClockMs: number;
  pricing?: { inputCnyPerMillion: number; outputCnyPerMillion: number; source: string };
  /** Optional model id override; start falls back to the CLI policy model. */
  model?: string;
  /** Optional thinking effort; start falls back to 'off'. */
  thinking?: string;
  /** Workspace binding from the server registry; fixed once the task is created. */
  workspaceId?: string;
  /** Discussion-branch provenance. Server-assigned at fork creation. */
  sourceRef?: { parentId: string; turnId: string; summary: string };
}

export interface GuiWorkspaceInfo {
  id: string;
  name: string;
  cwd: string;
  createdAt: string;
  archived: boolean;
  sort: number;
}

export interface GuiModelInfo {
  id: string;
  label: string;
  maxContextTokens: number;
  thinkingLevels: string[];
}

export interface GuiModelsResponse {
  models: GuiModelInfo[];
  defaultModel: string;
}

export interface GuiTaskFieldError {
  field: string;
  message: string;
}

export interface GuiTaskValidateResponse {
  ok: boolean;
  errors: GuiTaskFieldError[];
  task?: GuiTaskContract;
}

/** Read-only git worktree observation; either a parsed status or an honest unavailability reason. */
export type GuiGitStatus = { at: string } & (
  | { unavailable: string }
  | { branch: string; ahead: number; behind: number; uncommitted: number; worktree: 'clean' | 'dirty' }
);

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
  /** Thinking effort recorded in the task contract; 'off' when unset. */
  thinking?: string;
  sessionId: string;
  goalId: string;
  status: GuiRunStatus;
  phase: string;
  nextAction: string;
  startedAt: string;
  elapsedMs: number;
  /** Operator metadata folded from gui_meta events (rename/pin/archive). */
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  /** Discussion-branch provenance, present only on forked tasks. */
  sourceRef?: { parentId: string; turnId: string; summary: string };
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

export interface GuiLiveOverviewSession {
  id: string;
  title: string;
  objective: string;
  status: GuiRunStatus;
  workspaceId: string;
  pinned: boolean;
  archived: boolean;
  updatedAt: string;
  lastMessage: string;
  sourceRef?: { parentId: string; turnId: string; summary: string };
}

export interface GuiLiveOverview {
  cwd: string;
  enabled: boolean;
  task: { objective: string; requirements: string[] } | null;
  sessions: GuiLiveOverviewSession[];
  activeId: string | null;
  workspaces: GuiWorkspaceInfo[];
}

/** Full projection replacement makes replay idempotent; sequence belongs to one task event journal. */
export interface GuiStreamFrame {
  id: string;
  sequence: number;
  snapshot: GuiLiveSnapshot;
}
