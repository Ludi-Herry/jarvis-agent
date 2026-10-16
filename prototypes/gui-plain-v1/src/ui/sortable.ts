import { useEffect, useRef, useState, type RefObject } from "react";

const KEY = "jarvis-plain-v1-task-order";
type Orders = Record<string, string[]>;
function read(): Orders { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; } }

/** Per-project manual order of task ids. Ids that aren't in the saved order (new tasks) stay on top in their natural order. */
export function useTaskOrder() {
  const [orders, setOrders] = useState<Orders>(read);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(orders)); } catch { /* file:// */ } }, [orders]);
  const sort = <T extends { id: string }>(project: string, rows: T[]) => {
    const o = orders[project]; if (!o?.length) return rows;
    const at = (id: string) => { const i = o.indexOf(id); return i < 0 ? -1 : i; };
    return rows.map((r, n) => ({ r, n, i: at(r.id) })).sort((a, b) => (a.i - b.i) || (a.n - b.n)).map(x => x.r);
  };
  const move = (project: string, ids: string[], id: string, before: string | null) => {
    const list = ids.filter(x => x !== id);
    const at = before ? list.indexOf(before) : -1;
    list.splice(at < 0 ? list.length : at, 0, id);
    setOrders(v => ({ ...v, [project]: list }));
  };
  return { sort, move };
}

/**
 * Pointer drag-to-reorder for rows marked data-sort-id inside `container`.
 * 4px dead zone (a click stays a click), the dragged row becomes a 40% dashed ghost, a 2px line shows where it lands
 * (row midpoints decide), Esc cancels, and the click that ends a drag is swallowed.
 */
export function useSortable(container: RefObject<HTMLElement | null>, onDrop: (id: string, before: string | null) => void, enabled = true) {
  const [state, setState] = useState<{ id: string; line: number } | null>(null);
  const drop = useRef(onDrop); drop.current = onDrop;
  useEffect(() => {
    const el = container.current; if (!el || !enabled) return;
    let st: { id: string; x: number; y: number; on: boolean } | null = null;
    let target: { before: string | null } | null = null;
    const end = () => { st = null; target = null; setState(null); document.body.removeAttribute("data-sorting"); };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || e.pointerType === "touch") return; // touch keeps scrolling; reorder there via the keyboard / menu
      const t = e.target as HTMLElement; const row = t.closest<HTMLElement>("[data-sort-id]");
      if (!row || !t.closest(".task-main") || !el.contains(row)) return;
      st = { id: row.dataset.sortId!, x: e.clientX, y: e.clientY, on: false };
    };
    const move = (e: PointerEvent) => {
      if (!st) return;
      if (!st.on) { if (Math.hypot(e.clientX - st.x, e.clientY - st.y) < 4) return; st.on = true; document.body.setAttribute("data-sorting", ""); }
      const box = el.getBoundingClientRect(); let before: string | null = null; let y = 0;
      for (const r of Array.from(el.querySelectorAll<HTMLElement>("[data-sort-id]"))) {
        const rr = r.getBoundingClientRect();
        if (e.clientY < rr.top + rr.height / 2) { before = r.dataset.sortId!; y = rr.top - box.top; break; }
        y = rr.bottom - box.top;
      }
      target = { before }; setState({ id: st.id, line: y });
    };
    const up = () => {
      if (st?.on && target) {
        const { id } = st, { before } = target;
        if (before !== id) drop.current(id, before);
        const kill = (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault(); };
        window.addEventListener("click", kill, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", kill, true), 0);
      }
      end();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && st?.on) { e.stopPropagation(); end(); } };
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("keydown", key, true);
    return () => { el.removeEventListener("pointerdown", down); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("keydown", key, true); };
  }, [container, enabled]);
  return state;
}
