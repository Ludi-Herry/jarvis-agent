import { useEffect, useRef, useState, type RefObject } from "react";

const KEY = "jarvis-plain-v1-panel-width";
const MIN_PANEL = 360, MIN_THREAD = 420, COLLAPSE_AT = 300, DEADZONE = 4, STEP = 16;

/** Ask the side panel to grow by `extra` px (e.g. so a split diff fits). The resizer clamps it to what the window allows. */
export const WIDEN_EVENT = "jarvis:panel-widen";
export const requestPanelWiden = (extra: number) => window.dispatchEvent(new CustomEvent<number>(WIDEN_EVENT, { detail: extra }));

/** Remembered side-panel width (null = the default clamp(400px, 35vw, 540px)). */
export function usePanelWidth() {
  const [w, setW] = useState<number | null>(() => { try { const v = Number(localStorage.getItem(KEY)); return v > 0 ? v : null; } catch { return null; } });
  useEffect(() => { try { w ? localStorage.setItem(KEY, String(Math.round(w))) : localStorage.removeItem(KEY); } catch { /* file:// */ } }, [w]);
  return [w, setW] as const;
}

/**
 * The divider between the conversation and the side panel. Drag to resize (4px dead zone so a click never jumps),
 * double-click to reset, Esc mid-drag to cancel, ←/→ to nudge, drag far right to fold the panel away.
 * While dragging, iframes stop eating the pointer (body[data-pane-dragging]).
 */
export function PanelResizer({ panel, width, setWidth, onCollapse }: { panel: RefObject<HTMLElement | null>; width: number | null; setWidth: (w: number | null) => void; onCollapse: () => void }) {
  const [drag, setDrag] = useState<"idle" | "armed" | "dragging">("idle");
  const [folding, setFolding] = useState(false);
  const g = useRef({ x: 0, w: 0, cur: 0, fold: false });
  const max = () => {
    const main = panel.current?.parentElement?.querySelector(".main") as HTMLElement | null;
    const others = main ? window.innerWidth - (panel.current?.getBoundingClientRect().width ?? 0) - main.getBoundingClientRect().width : 0; // sidebar etc.
    return Math.max(MIN_PANEL, window.innerWidth - others - MIN_THREAD);
  };
  const clamp = (v: number) => Math.min(max(), Math.max(MIN_PANEL, v));
  const apply = (v: number | null) => { if (panel.current) panel.current.style.width = v ? `${v}px` : ""; };

  useEffect(() => {
    if (drag === "idle") return;
    const move = (e: PointerEvent) => {
      const dx = g.current.x - e.clientX; // dragging left widens the panel
      if (drag === "armed") { if (Math.abs(dx) < DEADZONE) return; setDrag("dragging"); document.body.setAttribute("data-pane-dragging", ""); }
      const raw = g.current.w + dx;
      const fold = raw < COLLAPSE_AT; g.current.fold = fold; setFolding(fold);
      g.current.cur = clamp(raw); apply(g.current.cur);
    };
    const end = () => {
      document.body.removeAttribute("data-pane-dragging");
      if (drag === "dragging") {
        if (g.current.fold) { apply(width); onCollapse(); }
        else setWidth(g.current.cur);
      }
      setFolding(false); setDrag("idle");
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); apply(width); g.current.fold = false; document.body.removeAttribute("data-pane-dragging"); setFolding(false); setDrag("idle"); } };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end); window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); window.removeEventListener("keydown", key, true); };
  }, [drag, width]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const widen = (e: Event) => {
      const extra = (e as CustomEvent<number>).detail, el = panel.current; if (!(extra > 0) || !el) return;
      el.classList.add("is-easing"); window.setTimeout(() => el.classList.remove("is-easing"), 320);
      setWidth(clamp(now() + extra));
    };
    window.addEventListener(WIDEN_EVENT, widen); return () => window.removeEventListener(WIDEN_EVENT, widen);
  }); // re-bind each render so clamp/now see the live layout
  useEffect(() => { apply(width); }, [width]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => apply(null), []); // eslint-disable-line react-hooks/exhaustive-deps -- overlay layouts own the width
  useEffect(() => { panel.current?.classList.toggle("is-folding", folding); }, [folding, panel]);

  const now = () => Math.round(panel.current?.getBoundingClientRect().width ?? width ?? 0);
  return <div className={`pane-resizer${drag === "dragging" ? " is-dragging" : ""}`} role="separator" aria-orientation="vertical" aria-label="调整面板宽度（双击恢复默认）" aria-valuenow={now()} aria-valuemin={MIN_PANEL} tabIndex={0}
    onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); g.current = { x: e.clientX, w: now(), cur: now(), fold: false }; setDrag("armed"); }}
    onDoubleClick={() => setWidth(null)}
    onKeyDown={e => {
      const d = e.key === "ArrowLeft" ? 1 : e.key === "ArrowRight" ? -1 : 0;
      if (d) { e.preventDefault(); setWidth(clamp(now() + d * (e.shiftKey ? STEP * 4 : STEP))); }
      if (e.key === "Enter") { e.preventDefault(); setWidth(null); }
    }} />;
}
