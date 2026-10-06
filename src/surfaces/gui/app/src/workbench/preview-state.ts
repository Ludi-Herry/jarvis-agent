/**
 * Batch 3 §C9–§C13: the preview tab's navigation state as pure computation. The stack holds
 * opened addresses oldest-first; `index` points at the one currently shown. Pushing drops any
 * forward entries, matching browser history semantics. Persistence is a view preference only
 * (localStorage per task), so parse failures fall back to an empty history.
 */
export interface PreviewHistory {
  readonly stack: readonly string[];
  readonly index: number;
}

export function initialPreviewHistory(): PreviewHistory {
  return { stack: [], index: -1 };
}

export function currentPreviewAddress(history: PreviewHistory): string | null {
  if (history.index < 0 || history.index >= history.stack.length) return null;
  return history.stack[history.index];
}

export function canStepPreview(history: PreviewHistory, delta: -1 | 1): boolean {
  const next = history.index + delta;
  return next >= 0 && next < history.stack.length;
}

export function pushPreviewAddress(history: PreviewHistory, url: string): PreviewHistory {
  const base = history.stack.slice(0, history.index + 1);
  if (base[base.length - 1] === url) return { stack: base, index: base.length - 1 };
  const stack = [...base, url];
  return { stack, index: stack.length - 1 };
}

export function stepPreview(history: PreviewHistory, delta: -1 | 1): PreviewHistory {
  if (!canStepPreview(history, delta)) return history;
  return { stack: history.stack, index: history.index + delta };
}

export function serializePreviewHistory(history: PreviewHistory): string {
  return JSON.stringify({ stack: history.stack, index: history.index });
}

export function parsePreviewHistory(raw: string | null): PreviewHistory {
  if (raw === null) return initialPreviewHistory();
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return initialPreviewHistory();
    const candidate = value as { stack?: unknown; index?: unknown };
    if (!Array.isArray(candidate.stack) || candidate.stack.some((item) => typeof item !== 'string')) {
      return initialPreviewHistory();
    }
    const stack = candidate.stack as readonly string[];
    const index = typeof candidate.index === 'number' && Number.isInteger(candidate.index)
      ? Math.min(Math.max(candidate.index, stack.length === 0 ? -1 : 0), stack.length - 1)
      : stack.length - 1;
    return { stack, index };
  } catch {
    return initialPreviewHistory();
  }
}
