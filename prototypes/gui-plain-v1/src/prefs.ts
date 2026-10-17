import { useEffect, useState } from "react";
import type { Mode } from "./scenario";

export type ThemePref = "light" | "dark" | "system";
export interface Prefs { theme: ThemePref; defaultMode: Mode; autoPreview: boolean; sendKey: "enter" | "mod-enter"; budget: number }
export const DEFAULT_PREFS: Prefs = { theme: "light", defaultMode: "ask", autoPreview: true, sendKey: "enter", budget: 2 };
const KEY = "jarvis-plain-v1-prefs";

export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(() => {
    let stored: Partial<Prefs> = {};
    try { stored = JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { stored = {}; }
    const t = new URLSearchParams(location.search).get("theme");
    return { ...DEFAULT_PREFS, ...stored, ...(t === "dark" || t === "light" ? { theme: t } : {}) };
  });
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* file:// without storage */ } }, [prefs]);
  const patch = (p: Partial<Prefs>) => setPrefs(v => ({ ...v, ...p }));
  return [prefs, patch] as const;
}

export function useSystemDark() {
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => { const mq = window.matchMedia("(prefers-color-scheme: dark)"); const f = () => setDark(mq.matches); mq.addEventListener("change", f); return () => mq.removeEventListener("change", f); }, []);
  return dark;
}

export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
