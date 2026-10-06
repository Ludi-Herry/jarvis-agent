import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { GuiMessage } from '../../../live-types.js';
import {
  currentTurnIndex,
  selectStickyTurn,
  shouldShowConversationMap,
  summarize,
  tickFractions,
  type TurnGeometry,
} from './scroll-rules.js';

export interface HistoryGeometry {
  readonly turns: readonly TurnGeometry[];
  readonly sticky: TurnGeometry | null;
  readonly mapVisible: boolean;
  readonly ticks: readonly number[];
  readonly activeIndex: number;
  readonly atLatest: boolean;
  readonly scrollable: boolean;
}

export interface HistoryGeometryApi extends HistoryGeometry {
  readonly onScroll: (event: { readonly currentTarget: HTMLElement }) => void;
  readonly scrollToTurn: (id: string) => void;
  readonly scrollToLatest: () => void;
}

const EMPTY: HistoryGeometry = {
  turns: [], sticky: null, mapVisible: false, ticks: [], activeIndex: -1, atLatest: true, scrollable: false,
};

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function turnTextsOf(messages: readonly GuiMessage[]): Map<string, { question: string; answer: string }> {
  const entries = new Map<string, { question: string; answer: string }>();
  for (let index = 0; index < messages.length; index += 1) {
    const item = messages[index];
    if (item.role !== 'user') continue;
    let answer = '';
    for (let next = index + 1; next < messages.length; next += 1) {
      if (messages[next].role === 'assistant') { answer = messages[next].text; break; }
    }
    entries.set(item.id, { question: summarize(item.text, 120), answer: summarize(answer === '' ? '（尚无回复）' : answer, 90) });
  }
  return entries;
}

/**
 * Reads the rendered history geometry so the sticky question and the positioning track follow the
 * real message layout. It only measures; message facts and order come from the projection.
 */
export function useHistoryGeometry(
  containerRef: RefObject<HTMLElement | null>,
  messages: readonly GuiMessage[],
): HistoryGeometryApi {
  const [geometry, setGeometry] = useState<HistoryGeometry>(EMPTY);
  const scrolledRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const turnTexts = useMemo(() => turnTextsOf(messages), [messages]);

  const measure = useCallback(() => {
    frameRef.current = null;
    const container = containerRef.current;
    if (container === null) return;
    const containerRect = container.getBoundingClientRect();
    const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-turn-id]'));
    const turns: TurnGeometry[] = [];
    let gutterWidth = containerRect.width;
    for (const node of nodes) {
      const id = node.dataset.turnId;
      if (id === undefined) continue;
      const text = turnTexts.get(id);
      if (text === undefined) continue;
      const rect = node.getBoundingClientRect();
      gutterWidth = Math.min(gutterWidth, Math.max(0, rect.left - containerRect.left));
      turns.push({
        id,
        questionTop: rect.top - containerRect.top + container.scrollTop,
        questionBottom: rect.bottom - containerRect.top + container.scrollTop,
        question: text.question,
        answer: text.answer,
      });
    }
    const scrollablePx = container.scrollHeight - container.clientHeight;
    // The viewport auto-scrolls to the newest message before this hook's effects run, so a
    // non-top position counts as "has scrolled" even when no scroll event reached us yet.
    const hasScrolled = scrolledRef.current || container.scrollTop > 4;
    setGeometry({
      turns,
      sticky: selectStickyTurn(turns, container.scrollTop),
      mapVisible: shouldShowConversationMap({
        windowWidth: window.innerWidth,
        gutterWidth,
        turnCount: turns.length,
        scrollablePx,
        hasScrolled,
      }),
      ticks: tickFractions(turns, container.scrollHeight),
      activeIndex: currentTurnIndex(turns, container.scrollTop, container.clientHeight),
      atLatest: scrollablePx - container.scrollTop < 48,
      scrollable: scrollablePx > 0,
    });
  }, [containerRef, turnTexts]);

  const schedule = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(measure);
  }, [measure]);

  useLayoutEffect(() => {
    schedule();
  }, [messages.length, schedule]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    for (const child of Array.from(container.children)) observer.observe(child);
    window.addEventListener('resize', schedule);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
  }, [containerRef, schedule]);

  const onScroll = useCallback((event: { readonly currentTarget: HTMLElement }) => {
    if (event.currentTarget.scrollTop > 0) scrolledRef.current = true;
    schedule();
  }, [schedule]);

  const scrollToTurn = useCallback((id: string) => {
    const container = containerRef.current;
    if (container === null) return;
    const node = container.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(id)}"]`);
    if (node === null) return;
    const top = node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    container.scrollTo({ top: Math.max(0, top - 12), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [containerRef]);

  const scrollToLatest = useCallback(() => {
    const container = containerRef.current;
    if (container === null) return;
    container.scrollTo({ top: container.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [containerRef]);

  return { ...geometry, onScroll, scrollToTurn, scrollToLatest };
}
