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
  /** Batch 5 §启动: user-confirmed drafting presets; absent until explicitly saved. */
  presets?: GuiWorkspacePresets;
}

/** Operator-confirmed per-workspace drafting defaults; saved only by an explicit user action. */
export interface GuiWorkspacePresets {
  writePaths: string[];
  checkCommands: string[];
  maxRounds: number;
  maxTurns: number;
  minutes: number;
  savedAt: string;
  /** plain-v1 P3: local dev-server page the preview opens after a task changes UI files.
   *  Loopback only (preview-policy); absent until the user saves one. */
  previewUrl?: string;
}

export interface GuiWorkspaceProbe {
  candidates: Array<{ command: string; source: string }>;
  note: string;
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

/** On-demand read of one workspace file for the operator's preview; never persisted or journaled. */
export interface GuiFileView {
  path: string;
  kind: 'text' | 'image';
  /** kind==='image' → raw base64 with `mime`; kind==='text' → decoded content (possibly truncated). */
  content: string;
  mime?: string;
  truncated: boolean;
  sizeBytes: number;
  at: string;
}

/** Batch 7 §工作空间: one lazy directory level of the task workspace (read-only navigation). */
export interface GuiWorkspaceTree {
  path: string; // as requested, '' = workspace root
  entries: Array<{ name: string; kind: 'dir' | 'file' | 'other'; link: boolean; size?: number }>;
  truncated: boolean;
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
  /** plain-v1 P2: what 「这个任务都允许」 (allow-session) would cover — this tool for the rest of the
   *  run, or only this exact command. Absent on pre-v1 journals. */
  sessionScope?: 'tool' | 'command';
}

/** plain-v1 P2: composer permission mode. Absent on a snapshot means 'ask' (pre-v1 behavior).
 *  - discuss: Jarvis may read but never writes files or runs commands.
 *  - ask:     every write/command waits for 允许 / 这个任务都允许 / 不允许.
 *  - auto:    writes to files the task contract lists go through without asking; commands still ask. */
export type GuiPermissionMode = 'discuss' | 'ask' | 'auto';

/** plain-v1 P2: one write path that undo/redo would change. */
export interface GuiUndoFile {
  path: string;
  change: 'added' | 'modified' | 'deleted';
}

/** plain-v1 P2: GET /api/live/:id/undo. `token` must be echoed to POST undo/redo; it is the tree of
 *  the files as they were when this plan was computed, so a confirm on a stale view is refused. */
export interface GuiUndoPlan {
  kind: 'undo' | 'redo';
  available: boolean;
  reason?: string;
  files: GuiUndoFile[];
  token: string | null;
}

/** plain-v1 P2: the last undo/redo, folded from gui_undo journal events. */
export interface GuiUndoState {
  state: 'undone' | 'redone';
  at: string;
  files: GuiUndoFile[];
  /** Tree the write paths were restored to. */
  restoredTree: string;
  /** Tree of the write paths just before this operation (what redo would bring back). */
  savedTree: string;
}

/** One desk-side terminal command, folded from gui_terminal events (contract §D14). Observation
 *  only — terminal output never enters evidence/checks/diff authority (§D18). */
export interface GuiTerminalEntry {
  command: string;
  code: number | null;
  /** Merged out chunks, head+tail truncated to the cap when oversized. */
  output: string;
  canceled: boolean;
  /** Batch 5 §恢复: why the entry was canceled (folded from the gui_terminal cancel reason). */
  cause?: 'user' | 'timeout' | 'interrupted';
  at: string;
}

export interface GuiTerminalState {
  running: { command: string; startedAt: string } | null;
  history: GuiTerminalEntry[];
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
  /** Desk-side terminal state (batch 3 §D); absent when the journal carries no gui_terminal event. */
  terminal?: GuiTerminalState;
  /** plain-v1 P2: composer permission mode; absent = 'ask'. */
  permissionMode?: GuiPermissionMode;
  /** plain-v1 P2: last undo/redo of this task's file changes; absent until the user undoes. */
  undo?: GuiUndoState;
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
  /** The most recently active running task (legacy single-activity pointer). */
  activeId: string | null;
  /** Every running task id (batch 3 §A4); reproducible from sessions' run state. */
  activeIds: string[];
  workspaces: GuiWorkspaceInfo[];
}

/** Full projection replacement makes replay idempotent; sequence belongs to one task event journal. */
export interface GuiStreamFrame {
  id: string;
  sequence: number;
  snapshot: GuiLiveSnapshot;
}
