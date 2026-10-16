/** Unsent text survives switching tasks and reloading — one draft per conversation. */
const KEY = "jarvis-plain-v1-drafts";
function read(): Record<string, string> { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; } }
function write(m: Record<string, string>) { try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* file:// without storage */ } }
export const drafts = {
  get(k: string) { return read()[k] ?? ""; },
  set(k: string, v: string) { const m = read(); if ((m[k] ?? "") === v) return; if (v.trim()) m[k] = v; else delete m[k]; write(m); },
  move(from: string, to: string) { const m = read(); if (m[from]) { m[to] = m[from]; delete m[from]; write(m); } },
};
