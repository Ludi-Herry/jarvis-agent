/**
 * Safe compaction split points — pure functions (plan §3.5, borrowed from kimi-code's
 * `canSplitAfter`).
 *
 * Compaction summarizes an OLD prefix of the conversation and keeps a RECENT tail verbatim.
 * The cut must land on a coherent boundary, or the model receives a broken transcript: a
 * tool result with no preceding tool call, or a user turn torn from the reply it triggered.
 * These rules decide where the knife may fall; the loop/ContextManager never split anywhere
 * `canSplitAfter` rejects. Kept pure so every rule (especially "never after a tool call") is
 * provable in isolation.
 */
import type { Message } from '../types.js';

/**
 * May the conversation be cut BETWEEN message `i` and `i + 1` (i.e. summarize `…i`, keep
 * `i+1…`)? False unless the boundary is coherent:
 *  - there must BE something on each side (no out-of-range / empty tail);
 *  - not right after a `user` message — it belongs with the assistant reply it prompted;
 *  - not right after an assistant that made tool calls — its tool results follow and must
 *    not be orphaned (the acceptance case: "false after a tool call");
 *  - not right before a `tool` message — the tail must not START with a result whose call
 *    we just summarized away.
 */
export function canSplitAfter(messages: Message[], i: number): boolean {
  const cur = messages[i];
  const next = messages[i + 1];
  if (!cur || !next) return false;
  if (cur.role === 'user') return false;
  if (cur.role === 'assistant' && cur.toolCalls && cur.toolCalls.length > 0) return false;
  if (next.role === 'tool') return false;
  return true;
}

/**
 * Index where the kept tail should begin: aim to keep the last `keepRecent` messages, then
 * walk EARLIER (keeping more, never less) until the boundary is safe per {@link canSplitAfter}.
 * `headStart` is the first index eligible to be summarized — 1 when a system prompt occupies
 * index 0 so it's preserved as the immutable prefix, else 0.
 *
 * Returns `headStart` when no safe cut summarizes anything (e.g. the whole tail is one
 * unsplittable tool group): the caller treats that as "nothing to compact" and skips.
 */
export function findSplitPoint(messages: Message[], keepRecent: number, headStart: number): number {
  let idx = Math.max(headStart, messages.length - keepRecent);
  while (idx > headStart && !canSplitAfter(messages, idx - 1)) idx--;
  return idx;
}
