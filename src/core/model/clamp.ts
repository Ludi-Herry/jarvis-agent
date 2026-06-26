/**
 * Clamp a requested max-output-tokens value to a provider's hard ceiling.
 *
 * OpenAI-compatibility gotcha from kimi-code (knowledge base Part8 §5.2):
 * third-party endpoints reject `max_tokens` above their limit, so we clamp before
 * sending. By default the provider sends no cap at all (lets the server decide);
 * this only runs when a caller explicitly sets one via `withMaxCompletionTokens`.
 *
 * Pure decision point.
 */
export function clampMaxTokens(requested: number, cap: number): number {
  if (!Number.isFinite(requested)) return cap;
  return Math.max(1, Math.min(Math.floor(requested), cap));
}
