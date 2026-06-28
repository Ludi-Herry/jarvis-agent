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

/**
 * Redact secret-looking fragments an OpenAI-compatible endpoint might echo back inside an error
 * message — some reflect the request, which can carry an Authorization header or a key in a query
 * string. Conservative: masks API-key prefixes, bearer tokens, and labelled key/secret/token values
 * while leaving ordinary diagnostic text intact, so the surfaced error never re-leaks a credential.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***') // OpenAI-style keys (sk-, sk-proj-…)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._=+/-]{6,}/gi, '$1 ***') // auth-scheme tokens
    .replace(
      /\b(api[_-]?key|access[_-]?key|secret|token|password)("?\s*[=:]\s*"?)[A-Za-z0-9._-]{6,}/gi,
      '$1$2***',
    ); // labelled key=VALUE / "token": "VALUE" pairs
}

export function describeModelError(err: unknown, model: string): Error {
  const api = asApiError(err);
  if (api) {
    const detail = api.message ? `: ${redactSecrets(api.message)}` : '';
    return new Error(
      `Doubao request failed for model "${model}" (HTTP ${api.status}) — ${hint(api.status)}${detail}`,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`Doubao request failed for model "${model}" — ${redactSecrets(message)}`);
}
