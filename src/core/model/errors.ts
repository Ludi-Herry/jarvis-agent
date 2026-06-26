/**
 * Turn a provider/SDK error into a readable, secret-free Error.
 *
 * Pure: maps an unknown thrown value (the OpenAI SDK's APIError carries `.status`
 * and `.message`) to a clear message. Never includes the API key — only the model
 * id, HTTP status, and the endpoint's own message.
 */

interface ApiErrorShape {
  status?: number;
  message?: string;
}

function asApiError(err: unknown): ApiErrorShape | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as Record<string, unknown>;
  const status = typeof e.status === 'number' ? e.status : undefined;
  const message = typeof e.message === 'string' ? e.message : undefined;
  if (status === undefined && message === undefined) return undefined;
  return { status, message };
}

function hint(status: number | undefined): string {
  switch (status) {
    case 401:
    case 403:
      return 'check ARK_API_KEY (auth rejected)';
    case 404:
      return 'check the model id / baseURL';
    case 429:
      return 'rate limited or out of quota';
    default:
      return status && status >= 500 ? 'endpoint server error, retry later' : 'request failed';
  }
}

export function describeModelError(err: unknown, model: string): Error {
  const api = asApiError(err);
  if (api) {
    const status = api.status !== undefined ? ` (HTTP ${api.status})` : '';
    const detail = api.message ? `: ${api.message}` : '';
    return new Error(`Doubao request failed for model "${model}"${status} — ${hint(api.status)}${detail}`);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`Doubao request failed for model "${model}" — ${message}`);
}
