import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, Info } from "lucide-react";

export interface Note { text: string; icon?: ReactNode; tone?: "ok" | "info"; action?: { label: string; run: () => void }; ms?: number }
type Notify = (note: Note) => void;

const Ctx = createContext<Notify>(() => {});
export const NotifyContext = Ctx;
export const useNotify = () => useContext(Ctx);

/** One toast at a time (PastaUI keeps feedback quiet); a new note replaces the old one. */
export function useNotifier() {
  const [note, setNote] = useState<(Note & { id: number }) | null>(null);
  const seq = useRef(0);
  const notify = useCallback<Notify>(n => { seq.current += 1; setNote({ ...n, id: seq.current }); }, []);
  useEffect(() => { if (!note) return; const id = setTimeout(() => setNote(null), note.ms ?? (note.action ? 5200 : 2600)); return () => clearTimeout(id); }, [note]);
  const node = <div className="toast-wrap" aria-live="polite"><AnimatePresence mode="popLayout">{note && <motion.div key={note.id} className="toast" role="status" initial={{ opacity: 0, y: 10, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: .98 }} transition={{ type: "spring", visualDuration: .3, bounce: .12 }}>
    <span className="toast-ico">{note.icon ?? (note.tone === "info" ? <Info size={15} /> : <Check size={15} />)}</span>
    <span>{note.text}</span>
    {note.action && <button type="button" onClick={() => { note.action!.run(); setNote(null); }}>{note.action.label}</button>}
  </motion.div>}</AnimatePresence></div>;
  return { notify, node };
}

export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch { ok = false; } ta.remove(); return ok;
  }
}

/** Copy with in-place feedback: the icon turns into a ✓ for 2.5s. Only a failure raises a toast. */
export function useCopy(ms = 2500) {
  const notify = useNotify();
  const [done, setDone] = useState(false);
  const timer = useRef(0);
  const copy = useCallback(async (text: string) => {
    const ok = await copyText(text);
    if (!ok) { notify({ tone: "info", text: "浏览器没允许复制" }); return; }
    setDone(true); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setDone(false), ms);
  }, [ms, notify]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { done, copy };
}

/** Copy ↔ Check crossfade (scale + blur, popLayout so the button never changes size). */
export function CopyGlyph({ done, size = 13 }: { done: boolean; size?: number }) {
  return <span className="copy-glyph" style={{ width: size, height: size }}><AnimatePresence mode="popLayout" initial={false}>
    <motion.span key={done ? "ok" : "copy"} className={done ? "is-done" : undefined} initial={{ opacity: 0, scale: .6, filter: "blur(2px)" }} animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }} exit={{ opacity: 0, scale: .6, filter: "blur(2px)" }} transition={{ type: "spring", visualDuration: .22, bounce: .2 }}>
      {done ? <Check size={size} /> : <Copy size={size} />}
    </motion.span>
  </AnimatePresence></span>;
}
