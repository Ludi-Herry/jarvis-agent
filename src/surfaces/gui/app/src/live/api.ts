import type {
  GuiGitStatus,
  GuiLiveOverview,
  GuiLiveSnapshot,
  GuiModelsResponse,
  GuiTaskValidateResponse,
  GuiWorkspaceInfo,
} from '../../../live-types.js';

const GUI_HEADERS = {
  'content-type': 'application/json',
  'x-jarvis-gui': '1',
} as const;

/** Keep the validated draft and prevent duplicate creation while a request is in flight. */
export async function submitTaskDraft(
  lock: { current: boolean },
  input: GuiFreeTaskInput,
  validate: (input: GuiFreeTaskInput) => Promise<boolean>,
  commit: (input: GuiFreeTaskInput) => Promise<unknown>,
): Promise<void> {
  if (lock.current) return;
  lock.current = true;
  try {
    if (await validate(input)) await commit(input);
  } finally {
    lock.current = false;
  }
}

export class LiveApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'LiveApiError';
    this.status = status;
  }
}

async function responseMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (text.trim() === '') return `请求失败（${response.status}）`;
  try {
    const value = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof value.message === 'string' && value.message.trim() !== '') return value.message;
    if (typeof value.error === 'string' && value.error.trim() !== '') return value.error;
  } catch {
    // The backend can return plain text for an early startup failure.
  }
  return text;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new LiveApiError(await responseMessage(response), response.status);
  try {
    return await response.json() as T;
  } catch {
    throw new LiveApiError('服务返回了无法读取的数据。', response.status);
  }
}

export async function getLiveOverview(signal?: AbortSignal): Promise<GuiLiveOverview> {
  const response = await fetch('/api/live', {
    headers: { accept: 'application/json' },
    signal,
  });
  return readJson<GuiLiveOverview>(response);
}
export async function getLiveSnapshot(id: string, signal?: AbortSignal): Promise<GuiLiveSnapshot> {
  const response = await fetch(`/api/live/${encodeURIComponent(id)}`, {
    headers: { accept: 'application/json' },
    signal,
  });
  return readJson<GuiLiveSnapshot>(response);
}

export async function postLiveSnapshot(
  path: string,
  body: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<GuiLiveSnapshot> {
  return postLiveJson<GuiLiveSnapshot>(path, body, signal);
}

async function postLiveJson<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: GUI_HEADERS,
    body: JSON.stringify(body),
    signal,
  });
  return readJson<T>(response);
}

/** Free task contract body; the server derives requirements when omitted. */
export interface GuiFreeTaskInput {
  readonly objective: string;
  readonly cwd: string;
  readonly workspaceId?: string;
  readonly requirements?: readonly string[];
  readonly writePaths: readonly string[];
  readonly checkCommands: readonly string[];
  readonly shellCommands?: readonly string[];
  readonly maxRounds: number;
  readonly maxTurns: number;
  readonly wallClockMs: number;
  readonly model?: string;
  readonly thinking?: string;
}

/** Discussion branch: the server clones the parent contract from this reference. */
export interface GuiForkTaskInput {
  readonly forkFrom: {
    readonly parentId: string;
    readonly turnId: string;
  };
}

export type GuiCreateTaskInput = GuiFreeTaskInput | GuiForkTaskInput;

export interface GuiMetaPatch {
  readonly title?: string | null;
  readonly pinned?: boolean;
  readonly archived?: boolean;
}

export interface GuiWorkspaceInput {
  readonly name: string;
  readonly cwd: string;
}

export async function createLiveTask(input: GuiCreateTaskInput, signal?: AbortSignal): Promise<GuiLiveSnapshot> {
  return postLiveJson<GuiLiveSnapshot>('/api/live/task', input, signal);
}

export async function validateLiveTask(input: GuiCreateTaskInput, signal?: AbortSignal): Promise<GuiTaskValidateResponse> {
  return postLiveJson<GuiTaskValidateResponse>('/api/live/task/validate', input, signal);
}

export async function startLiveTask(id: string, signal?: AbortSignal): Promise<GuiLiveSnapshot> {
  return postLiveJson<GuiLiveSnapshot>(`/api/live/${encodeURIComponent(id)}/start`, {}, signal);
}

export async function postLiveMeta(id: string, patch: GuiMetaPatch, signal?: AbortSignal): Promise<GuiLiveSnapshot> {
  return postLiveJson<GuiLiveSnapshot>(`/api/live/${encodeURIComponent(id)}/meta`, patch, signal);
}

export async function createLiveWorkspace(input: GuiWorkspaceInput, signal?: AbortSignal): Promise<{ workspaces: GuiWorkspaceInfo[] }> {
  return postLiveJson<{ workspaces: GuiWorkspaceInfo[] }>('/api/live/workspaces', input, signal);
}

export async function getLiveGitStatus(id: string, signal?: AbortSignal): Promise<GuiGitStatus> {
  const response = await fetch(`/api/live/${encodeURIComponent(id)}/git`, {
    headers: { accept: 'application/json' },
    signal,
  });
  return readJson<GuiGitStatus>(response);
}

/** Batch 3 §D14: attended desk-side terminal; server spawns in the task cwd. */
export async function postTerminalCommand(id: string, command: string, signal?: AbortSignal): Promise<GuiLiveSnapshot> {
  return postLiveJson<GuiLiveSnapshot>(`/api/live/${encodeURIComponent(id)}/terminal`, { command }, signal);
}

/** Batch 3 §D16: cancel the in-flight desk-side command (409 when none runs). */
export async function postTerminalCancel(id: string, signal?: AbortSignal): Promise<GuiLiveSnapshot> {
  return postLiveJson<GuiLiveSnapshot>(`/api/live/${encodeURIComponent(id)}/terminal/cancel`, {}, signal);
}

export async function getLiveModels(signal?: AbortSignal): Promise<GuiModelsResponse> {
  const response = await fetch('/api/live/models', {
    headers: { accept: 'application/json' },
    signal,
  });
  return readJson<GuiModelsResponse>(response);
}
