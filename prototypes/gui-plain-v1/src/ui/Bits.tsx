import { ThinkingOrb } from "thinking-orbs";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Tooltip } from "../arc/tooltip/tooltip";

export function Orb({ state, size = 20, theme }: { state: any; size?: 20 | 32 | 64; theme?: "light" | "dark" }) {
  return <ThinkingOrb state={state} size={size} theme={theme === "dark" ? "dark" : theme === "light" ? "light" : "auto"} aria-label="Jarvis 正在工作" style={{ width: size, height: size, flex: "none" }} />;
}
export function Diffstat({ add, del, muted }: { add: number; del: number; muted?: boolean }) {
  return <Pop value={`${add}/${del}`} className={`diffstat${muted ? " muted" : ""}`}><span className="add">+{add}</span><span className="del">−{del}</span></Pop>;
}
/** A number that gives a tiny 1.06× pop when it changes (never on first render), so progress is noticed without motion noise. */
export function Pop({ value, className, children, title, as: Tag = "span" }: { value: string | number; className?: string; children: ReactNode; title?: string; as?: "span" | "b" }) {
  const prev = useRef(value);
  const [n, setN] = useState(0);
  useEffect(() => { if (prev.current !== value) { prev.current = value; setN(x => x + 1); } }, [value]);
  return <Tag key={n} className={`${className ?? ""}${n ? " num-pop" : ""}`} title={title}>{children}</Tag>;
}
export function IconBtn({ label, onClick, children, active, tip = true, className, badge, disabled }: { label: string; onClick?: () => void; children: ReactNode; active?: boolean; tip?: boolean; className?: string; badge?: boolean; disabled?: boolean }) {
  const b = <button type="button" className={`icon-btn${active ? " is-active" : ""}${className ? " " + className : ""}`} aria-label={label} aria-pressed={active} onClick={onClick} disabled={disabled}>{children}{badge && <span className="icon-btn-badge" />}</button>;
  return tip && !disabled ? <Tooltip content={label} side="bottom">{b}</Tooltip> : b;
}
export function fmtElapsed(ms: number) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
}
/** True while an IME (Chinese/Japanese input) is mid-composition — Enter then means "pick this candidate", never "send/submit". Safari reports keyCode 229 after compositionend, so check all three. */
export function isIme(e: { key?: string; keyCode?: number; nativeEvent?: { isComposing?: boolean }; isComposing?: boolean }) {
  return !!(e.nativeEvent?.isComposing || e.isComposing || e.keyCode === 229);
}
/** ↑/↓ (and Home/End) move focus between sibling items matching `selector` inside the list that handled the key. */
export function arrowNav(e: { key: string; target: EventTarget; currentTarget: EventTarget; preventDefault: () => void }, selector: string) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const here = (e.target as HTMLElement).closest(selector); if (!here) return;
  const all = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(selector)).filter(el => !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
  const i = all.indexOf(here as HTMLElement); if (i < 0) return;
  const j = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : Math.max(0, Math.min(all.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
  e.preventDefault(); all[j].focus(); all[j].scrollIntoView({ block: "nearest" });
}
