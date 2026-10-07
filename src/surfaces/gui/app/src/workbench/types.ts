import type {
  GuiConnectionState,
  GuiFileView,
  GuiGitStatus,
  GuiLiveOverview,
  GuiLiveSnapshot,
  GuiModelsResponse,
  GuiTaskValidateResponse,
} from '../../../live-types.js';
import type { GuiCreateTaskInput, GuiMetaPatch, GuiWorkspaceInput } from '../live/api.js';
import type { HumanReviewDecision } from '../live/use-live-session.js';

/**
 * The workbench is a harness surface, not a second runtime. It renders the existing Jarvis
 * projection and forwards intents to existing runtime entries; it never decides permission,
 * completion or recovery on its own.
 */
export interface WorkbenchCommands {
  readonly chooseSession: (id: string | null) => void;
  readonly start: (text: string, taskId?: string) => Promise<unknown>;
  readonly submitInput: (text: string) => Promise<unknown>;
  readonly pause: () => Promise<unknown>;
  readonly continueRun: () => Promise<unknown>;
  readonly stop: (reason: string) => Promise<unknown>;
  readonly resume: () => Promise<unknown>;
  readonly decide: (requestId: string, decision: 'allow-once' | 'deny', reason?: string) => Promise<unknown>;
  readonly submitReview: (decisions: readonly HumanReviewDecision[]) => Promise<unknown>;
  readonly updateMeta: (id: string, patch: GuiMetaPatch) => Promise<unknown>;
  readonly createWorkspace: (input: GuiWorkspaceInput) => Promise<unknown>;
  readonly validateTask: (input: GuiCreateTaskInput) => Promise<GuiTaskValidateResponse>;
  readonly createTask: (input: GuiCreateTaskInput) => Promise<GuiLiveSnapshot>;
  readonly createBranch: (turnId: string) => Promise<GuiLiveSnapshot>;
  readonly getGit: (id: string) => Promise<GuiGitStatus>;
  readonly getFileView: (taskId: string, path: string) => Promise<GuiFileView>;
  readonly openFileExternal: (taskId: string, path: string) => Promise<{ ok: true }>;
  readonly runTerminal: (command: string) => Promise<unknown>;
  readonly cancelTerminal: () => Promise<unknown>;
}

export interface WorkbenchNotices {
  readonly overviewLoading: boolean;
  readonly overviewError: string | null;
  readonly connectionNotice: string | null;
  readonly streamWarning: string | null;
  readonly actionError: string | null;
}

/** `fixture` renders deterministic specimens and must stay visibly labelled as not a real run. */
export type WorkbenchProvenance = 'live' | 'fixture';

export interface WorkbenchInput {
  readonly overview: GuiLiveOverview | null;
  readonly snapshot: GuiLiveSnapshot | null;
  readonly selectedId: string | null;
  readonly connection: GuiConnectionState;
  readonly actionPending: string | null;
  readonly notices: WorkbenchNotices;
  readonly commands: WorkbenchCommands;
  readonly provenance: WorkbenchProvenance;
  /** Real model catalog from the host; null until loaded or when fixtures omit it. */
  readonly models: GuiModelsResponse | null;
}

export type { HumanReviewDecision };
