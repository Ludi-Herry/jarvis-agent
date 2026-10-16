import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowDown } from "lucide-react";
import { motionTokens } from "../arc/motion-tokens";

/**
 * Edge sensors: marks a scroll box with data-fade-top / data-fade-bottom only when content is hidden past that edge,
 * so the CSS mask (.fade-y) fades the edge that has more — never a list that already shows everything.
 */
export function useScrollEdges(ref: RefObject<HTMLElement | null>, watch?: unknown) {
  useEffect(() => {
    const el = ref.current; if (!el) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const below = el.scrollHeight - el.clientHeight - el.scrollTop;
      el.toggleAttribute("data-fade-top", el.scrollTop > 4);
      el.toggleAttribute("data-fade-bottom", below > 4);
    };
    const queue = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    el.addEventListener("scroll", queue, { passive: true });
    const ro = new ResizeObserver(queue); ro.observe(el);
    const watchKids = () => { for (const c of Array.from(el.children)) ro.observe(c); };
    watchKids();
    const mo = new MutationObserver(() => { watchKids(); queue(); }); mo.observe(el, { childList: true });
    return () => { el.removeEventListener("scroll", queue); ro.disconnect(); mo.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [ref, watch]);
}

/** A plain scroll box with edge fades. Use for lists that are not chat (sidebar, side panel, canvas details). */
export function FadeScroll({ className, children, as: Tag = "div", ...rest }: React.HTMLAttributes<HTMLElement> & { as?: "div" | "aside" | "section" }) {
  const ref = useRef<HTMLElement>(null);
  useScrollEdges(ref);
  return <Tag ref={ref as any} className={`${className ?? ""} fade-y`} {...rest}>{children}</Tag>;
}

const NEAR = 40;          // px from the bottom that still counts as "at the latest"
const USER_WINDOW = 150;  // ms after a wheel / touch / key / pointer input during which scrolling is the user's, not ours

/**
 * Chat scroller that follows new output like a reader would expect:
 * – stays pinned to the bottom while you're there (typewriter growth, new cards, expanding steps),
 * – lets go the moment you scroll up, and never yanks you back while you read,
 * – shows「回到最新」when you're away, and「有新进展」if something arrived meanwhile,
 * – re-pins whenever you send (pin changes).
 */
export function ThreadScroll({ children, pin, startAtBottom = true }: { children: ReactNode; pin?: unknown; startAtBottom?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stuck = useRef(startAtBottom);
  const userAt = useRef(0);
  const dragging = useRef(false);
  const [away, setAway] = useState(false);
  const [fresh, setFresh] = useState(false);
  const reduced = useReducedMotion();
  useScrollEdges(ref);

  const gap = () => { const el = ref.current; return el ? el.scrollHeight - el.clientHeight - el.scrollTop : 0; };
  const isUser = () => dragging.current || performance.now() - userAt.current < USER_WINDOW;
  const toBottom = useCallback((smooth: boolean) => {
    const el = ref.current; if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduced ? "smooth" : "auto" });
  }, [reduced]);

  useEffect(() => {
    const el = ref.current; if (!el) return;
    const mark = () => { userAt.current = performance.now(); };
    const onWheel = (e: WheelEvent) => { mark(); if (e.deltaY < 0) stuck.current = false; };
    const onKey = (e: KeyboardEvent) => { if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(e.key)) { mark(); if (e.key === "PageUp" || e.key === "Home" || e.key === "ArrowUp") stuck.current = false; } };
    const onDown = (e: PointerEvent) => { if (e.target === el) { dragging.current = true; mark(); } };
    const onUp = () => { if (dragging.current) { dragging.current = false; mark(); } };
    const onScroll = () => {
      const g = gap();
      if (isUser()) stuck.current = g <= NEAR;
      else if (g <= NEAR) stuck.current = true; // content- or code-driven scroll can re-pin, never un-pin
      const isAway = !stuck.current && g > NEAR;
      setAway(isAway); if (!isAway) setFresh(false);
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", mark, { passive: true });
    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { el.removeEventListener("wheel", onWheel); el.removeEventListener("touchmove", mark); el.removeEventListener("pointerdown", onDown); window.removeEventListener("pointerup", onUp); window.removeEventListener("keydown", onKey); el.removeEventListener("scroll", onScroll); };
  }, []);

  // Follow growth: new items, typewriter text, steps opening. Big jumps glide, small ones snap so text never wobbles.
  useEffect(() => {
    const c = content.current; if (!c) return;
    let last = c.offsetHeight;
    const ro = new ResizeObserver(() => {
      const h = c.offsetHeight; const grew = h > last; last = h;
      if (!grew) { if (stuck.current && !isUser() && gap() > 1) toBottom(false); return; }
      if (stuck.current && !isUser()) toBottom(gap() > 160);
      else if (!stuck.current) setFresh(true);
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, [toBottom]);

  // Start at the latest (live task) and re-pin when you send.
  useEffect(() => {
    if (!startAtBottom) return;
    toBottom(false);
    // Enter animations translate the last item for ~.3s, which briefly changes the scroll range; settle once they finish.
    const id = setTimeout(() => { if (stuck.current && !isUser()) toBottom(false); }, 420);
    return () => clearTimeout(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const firstPin = useRef(true);
  useEffect(() => { if (firstPin.current) { firstPin.current = false; return; } stuck.current = true; setAway(false); setFresh(false); toBottom(true); }, [pin, toBottom]);

  return <div className="scroll-wrap">
    <div ref={ref} className="scroll fade-y">
      <div ref={content}>{children}</div>
    </div>
    <AnimatePresence>
      {away && <motion.button type="button" className={`to-latest${fresh ? " is-fresh" : ""}`} onClick={() => { stuck.current = true; setAway(false); setFresh(false); toBottom(true); }}
        initial={{ opacity: 0, y: 8, scale: .96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: .98 }} transition={motionTokens.spring.snappy as any}>
        <ArrowDown size={14} />{fresh ? "有新进展" : "回到最新"}
      </motion.button>}
    </AnimatePresence>
  </div>;
}
