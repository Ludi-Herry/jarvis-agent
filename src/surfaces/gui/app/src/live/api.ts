import type {
  GuiLiveOverview,
  GuiLiveSnapshot,
} from '../../../live-types.js';

const GUI_HEADERS = {
  'content-type': 'application/json',
  'x-jarvis-gui': '1',
} as const;

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
  const response = await fetch(path, {
    method: 'POST',
    headers: GUI_HEADERS,
    body: JSON.stringify(body),
    signal,
  });
  return readJson<GuiLiveSnapshot>(response);
}

