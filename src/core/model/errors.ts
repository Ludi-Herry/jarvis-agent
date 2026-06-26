/**
 * Turn a provider/SDK error into a readable, secret-free Error.
 *
 * Pure: maps an unknown thrown value (the OpenAI SDK's APIError carries a numeric
 * `.status`) to a clear message. Never includes the API key — only the model id,
 * HTTP status, and the endpoint's own message.
 */

interface ApiErrorShape {
  status: number;
  message?: string;
}

/**
 * Detect an HTTP API error structurally via its numeric `.status`. Requiring
 * `status` is deliberate: every JS Error has a string `.message`, so matching on
 * message alone would treat plain Errors (and aborts) as API errors and make the
 * generic branch in describeModelError dead code.
 */
function asApiError(err: unknown): ApiErrorShape | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.status !== 'number') return undefined;
  return { status: e.status, message: typeof e.message === 'string' ? e.message : undefined };
}

function hint(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return 'check ARK_API_KEY (auth rejected)';
    case 404:
      return 'check the model id / baseURL';
    case 429:
      return 'rate limited or out of quota';
    default:
      return status >= 500 ? 'endpoint server error, retry later' : 'request failed';
  }
}

export function describeModelError(err: unknown, model: string): Error {
  const api = asApiError(err);
  if (api) {
    const detail = api.message ? `: ${api.message}` : '';
    return new Error(
      `Doubao request failed for model "${model}" (HTTP ${api.status}) — ${hint(api.status)}${detail}`,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`Doubao request failed for model "${model}" — ${message}`);
}
