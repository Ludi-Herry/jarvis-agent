import { useEffect, useRef, useState } from "react";
import * as D from "@radix-ui/react-dialog";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { motionTokens } from "../arc/motion-tokens";

export interface LightboxImage { url: string; label: string }
export interface LightboxOpen { index: number; from: DOMRect | null; ratio: number }

const MIN = 1, MAX = 4, DEADZONE = 4;

/**
 * Full-size view of an attached image. Grows out of the thumbnail you clicked and shrinks back into it.
 * Wheel / pinch zooms around the cursor, drag pans (4px dead zone so a click stays a click), double-click toggles 2×,
 * ←/→ walk through the message's images, Esc or the backdrop closes.
 */
export function Lightbox({ images, open, onClose, onIndex, returnFocus }: { images: LightboxImage[]; open: LightboxOpen | null; onClose: () => void; onIndex: (i: number) => void; returnFocus?: (i: number) => void }) {
  const last = useRef(0); if (open) last.current = open.index;
  const reduced = useReducedMotion();
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const [grab, setGrab] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const img = open ? images[open.index] : null;
  useEffect(() => { setView({ s: 1, x: 0, y: 0 }); }, [open?.index]);

  // Where the picture ends up: as large as fits in 88vw × 82vh at its own aspect ratio.
  const vw = typeof window === "undefined" ? 1200 : window.innerWidth, vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const ratio = open?.ratio || 4 / 3;
  const tw = Math.min(vw * .88, vh * .82 * ratio), th = tw / ratio;
  const from = open?.from;
  const morph = !reduced && from && open ? { x: from.left + from.width / 2 - vw / 2, y: from.top + from.height / 2 - vh / 2, scale: Math.max(.05, from.width / tw), opacity: .6 } : { opacity: 0, scale: .96 };

  const zoomAt = (next: number, cx: number, cy: number) => setView(v => {
    const s = Math.max(MIN, Math.min(MAX, next));
    if (s === MIN) return { s, x: 0, y: 0 };
    const px = cx - vw / 2, py = cy - vh / 2; // cursor relative to the centre the image scales around
    return { s, x: px - (px - v.x) * (s / v.s), y: py - (py - v.y) * (s / v.s) };
  });
  useEffect(() => {
    const el = stage.current; if (!el || !open) return;
    const wheel = (e: WheelEvent) => { e.preventDefault(); const d = Math.max(-40, Math.min(40, e.deltaY * (e.deltaMode === 1 ? 16 : 1))); zoomAt(view.s * Math.exp(-d * .01), e.clientX, e.clientY); };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  });

  const go = (d: number) => { if (!open || images.length < 2) return; onIndex((open.index + d + images.length) % images.length); };
  return <D.Root open={!!open} onOpenChange={v => { if (!v) onClose(); }}>
    <AnimatePresence>{open && img && <D.Portal key="lb" forceMount>
      <D.Overlay forceMount asChild><motion.div className="lb-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: motionTokens.duration.standard }} /></D.Overlay>
      <D.Content forceMount asChild aria-describedby={undefined} onCloseAutoFocus={e => { if (returnFocus) { e.preventDefault(); returnFocus(last.current); } }} onKeyDown={e => { if (e.key === "ArrowRight") { e.preventDefault(); go(1); } if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); } }}>
        <div className="lb" ref={stage}
          onPointerDown={e => { if ((e.target as HTMLElement).closest("button")) return; drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }}
          onPointerMove={e => { const d = drag.current; if (!d) return; const dx = e.clientX - d.x, dy = e.clientY - d.y; if (!d.moved && Math.hypot(dx, dy) < DEADZONE) return; d.moved = true; setGrab(true); if (view.s > 1) setView(v => ({ ...v, x: d.vx + dx, y: d.vy + dy })); }}
          onPointerUp={e => { const d = drag.current; drag.current = null; setGrab(false); if (d && !d.moved && !(e.target as HTMLElement).closest(".lb-img")) onClose(); }}
          onDoubleClick={e => { if ((e.target as HTMLElement).closest("button")) return; zoomAt(view.s > 1 ? 1 : 2, e.clientX, e.clientY); }}>
          <D.Title className="sr-only">{img.label}</D.Title>
          <motion.div key={open.index} className="lb-frame" style={{ width: tw, height: th }} initial={morph} animate={{ x: 0, y: 0, scale: 1, opacity: 1 }} exit={{ ...morph, opacity: 0, transition: { duration: motionTokens.duration.standard + .04, ease: motionTokens.ease.standard as any } }} transition={motionTokens.spring.smooth as any}>
            <img className={`lb-img${view.s > 1 ? " is-zoomed" : ""}${grab ? " is-grabbing" : ""}`} src={img.url} alt={img.label} draggable={false}
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, transition: grab ? "none" : `transform ${motionTokens.duration.standard}s cubic-bezier(.22,1,.36,1)` }} />
          </motion.div>
          <div className="lb-bar">
            <span className="lb-label">{img.label}{images.length > 1 && <span className="lb-count">{open.index + 1} / {images.length}</span>}</span>
            <span className="lb-hint">滚轮缩放 · 双击放大 · 拖动查看</span>
          </div>
          {images.length > 1 && <>
            <button type="button" className="lb-nav is-prev" aria-label="上一张" onClick={() => go(-1)}><ChevronLeft size={18} /></button>
            <button type="button" className="lb-nav is-next" aria-label="下一张" onClick={() => go(1)}><ChevronRight size={18} /></button>
          </>}
          <D.Close className="lb-close" aria-label="关闭"><X size={18} /></D.Close>
        </div>
      </D.Content>
    </D.Portal>}</AnimatePresence>
  </D.Root>;
}
