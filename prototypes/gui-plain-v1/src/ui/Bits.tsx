import { ThinkingOrb } from "thinking-orbs";
import type { ReactNode } from "react";
import { Tooltip } from "../arc/tooltip/tooltip";

export function Orb({ state, size = 20, theme }: { state: any; size?: 20 | 32 | 64; theme?: "light" | "dark" }) {
  return <ThinkingOrb state={state} size={size} theme={theme === "dark" ? "dark" : theme === "light" ? "light" : "auto"} aria-label="Jarvis 正在工作" style={{ width: size, height: size, flex: "none" }} />;
}
export function Diffstat({ add, del, muted }: { add: number; del: number; muted?: boolean }) {
  return <span className={`diffstat${muted ? " muted" : ""}`}><span className="add">+{add}</span><span className="del">−{del}</span></span>;
}
export function IconBtn({ label, onClick, children, active, tip = true, className, badge }: { label: string; onClick?: () => void; children: ReactNode; active?: boolean; tip?: boolean; className?: string; badge?: boolean }) {
  const b = <button type="button" className={`icon-btn${active ? " is-active" : ""}${className ? " " + className : ""}`} aria-label={label} aria-pressed={active} onClick={onClick}>{children}{badge && <span className="icon-btn-badge" />}</button>;
  return tip ? <Tooltip content={label} side="bottom">{b}</Tooltip> : b;
}
export function fmtElapsed(ms: number) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
}
