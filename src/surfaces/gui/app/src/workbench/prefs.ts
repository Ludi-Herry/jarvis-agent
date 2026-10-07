import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Display preferences only. Drafts, focus, scroll position and panel state live in the browser;
 * runtime facts never depend on them and a blocked storage access must not block a task.
 */

const DRAFT_PREFIX = 'jarvis.gui.live.draft.';
const SCROLL_PREFIX = 'jarvis.gui.live.scroll.';
const EVIDENCE_TAB_KEY = 'jarvis.gui.live.evidence-tab';
const REVIEW_EXPANDED_KEY = 'jarvis.gui.live.review-expanded';
const RAIL_COLLAPSED_KEY = 'jarvis.gui.workbench.rail-collapsed';
const MONITOR_OPEN_KEY = 'jarvis.gui.workbench.monitor-open';
const PREVIEW_HISTORY_PREFIX = 'jarvis.gui.live.previewHistory:';

export type EvidenceTab = 'diff' | 'verification' | 'context' | 'subagents' | 'preview' | 'terminal' | 'files';

const EVIDENCE_TABS: readonly EvidenceTab[] = ['diff', 'verification', 'context', 'subagents', 'preview', 'terminal', 'files'];

export function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Optional UI preference.
  }
}

export function storageRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // A blocked storage write must not block the live task.
  }
}

export function draftKey(scope: string): string {
  return `${DRAFT_PREFIX}${scope}`;
}

/** Preview panel history per task (batch 3 §C13): a view preference, never a runtime fact. */
export function previewHistoryKey(taskId: string): string {
  return `${PREVIEW_HISTORY_PREFIX}${taskId}`;
}

export function initialEvidenceTab(): EvidenceTab {
  const saved = storageGet(EVIDENCE_TAB_KEY);
  return (EVIDENCE_TABS as readonly string[]).includes(saved ?? '') ? saved as EvidenceTab : 'diff';
}

export function usePersistentFlag(key: string, initial: () => boolean) {
  const [value, setValue] = useState(initial);
  const update = useCallback((next: boolean) => {
    setValue(next);
    storageSet(key, String(next));
  }, [key]);
  return [value, update] as const;
}

export function initialExpanded(): boolean {
  return storageGet(REVIEW_EXPANDED_KEY) === 'true';
}

export function initialRailCollapsed(): boolean {
  return storageGet(RAIL_COLLAPSED_KEY) === 'true';
}

export function initialMonitorOpen(): boolean {
  return storageGet(MONITOR_OPEN_KEY) !== 'false';
}

export const prefKeys = {
  evidenceTab: EVIDENCE_TAB_KEY,
  reviewExpanded: REVIEW_EXPANDED_KEY,
  railCollapsed: RAIL_COLLAPSED_KEY,
  monitorOpen: MONITOR_OPEN_KEY,
} as const;

/** Restores a pane's reading position once per scope change; runtime facts drive the content. */
export function useRememberedScroll(
  ref: RefObject<HTMLElement | null>,
  pane: 'conversation' | 'context' | 'rail',
  scope: string,
) {
  const key = `${SCROLL_PREFIX}${pane}.${scope}`;
  const appliedFor = useRef<string | null>(null);
  const userMoved = useRef(false);
  // The viewport's own mount-time scroll-to-bottom also fires scroll events; persisting those
  // would overwrite the reader's position with "bottom" on every reload.
  const persistAfter = useRef(0);

  /** Attach-time restore: the thread viewport auto-scrolls to the newest message in an effect, so the saved position must land before that. */
  const attach = useCallback((node: HTMLElement | null) => {
    ref.current = node;
    if (node === null || appliedFor.current === key) return;
    appliedFor.current = key;
    userMoved.current = false;
    persistAfter.current = performance.now() + 800;
    const saved = Number(storageGet(key));
    if (Number.isFinite(saved) && saved > 0) node.scrollTop = saved;
  }, [key, ref]);

  // The thread viewport settles its own scroll-to-bottom after mount; re-assert the saved
  // position a few times unless the reader has already taken over the scroll.
  useEffect(() => {
    const node = ref.current;
    const saved = Number(storageGet(key));
    if (node === null || !Number.isFinite(saved) || saved <= 0) return undefined;
    const markMoved = () => { userMoved.current = true; };
    node.addEventListener('wheel', markMoved, { passive: true });
    node.addEventListener('touchstart', markMoved, { passive: true });
    node.addEventListener('keydown', markMoved);
    const timers = [0, 250, 600].map((delay) => window.setTimeout(() => {
      if (!userMoved.current && ref.current !== null) ref.current.scrollTop = saved;
    }, delay));
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      node.removeEventListener('wheel', markMoved);
      node.removeEventListener('touchstart', markMoved);
      node.removeEventListener('keydown', markMoved);
    };
  }, [key, ref]);

  const onScroll = useCallback((event: { readonly currentTarget: HTMLElement }) => {
    if (performance.now() < persistAfter.current) return;
    storageSet(key, String(event.currentTarget.scrollTop));
  }, [key]);

  return { onScroll, attach };
}
