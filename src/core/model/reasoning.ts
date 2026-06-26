/**
 * Reasoning-field extraction — an OpenAI-compatibility gotcha from kimi-code
 * (knowledge base Part8 §5.1): third-party reasoning models put thinking content
 * under one of three field names. We probe all three, and allow an explicit
 * override for non-standard endpoints.
 *
 * Pure decision point.
 */

/** The three known field names, in priority order. */
const REASONING_KEYS = ['reasoning_content', 'reasoning_details', 'reasoning'] as const;

/**
 * Pull reasoning text out of a streamed delta or a full message object.
 *
 * @param obj          The `delta` (streaming) or `message` object from the API.
 * @param reasoningKey Optional override field name for non-standard endpoints.
 * @returns The reasoning string, or `undefined` if none / not a string.
 */
export function extractReasoning(
  obj: Record<string, unknown> | null | undefined,
  reasoningKey?: string,
): string | undefined {
  if (!obj) return undefined;
  const keys = reasoningKey ? [reasoningKey, ...REASONING_KEYS] : REASONING_KEYS;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
