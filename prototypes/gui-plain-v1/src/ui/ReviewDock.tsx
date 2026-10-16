import { useEffect, useRef, useState, type PointerEvent as RPE } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, Moon, Play, Sun, Pause } from "lucide-react";
import SegmentedControl from "../arc/segmented-control/segmented-control";
import type { Snapshot } from "../store";
import oEmpty from "../assets/old/empty.webp";
import oRunning from "../assets/old/running.webp";
import oApproval from "../assets/old/approval.webp";
import oComplete from "../assets/old/complete.webp";
import oFailed from "../assets/old/failed.webp";
import oRecoverable from "../assets/old/recoverable.webp";

export const OLD: Record<Snapshot, string> = { empty: oEmpty, running: oRunning, approval: oApproval, complete: oComplete, failed: oFailed, interrupted: oRecoverable };
export type CompareMode = "new" | "split" | "old";

const STATES: { value: Snapshot; label: string }[] = [
  { value: "empty", label: "新建" }, { value: "running", label: "运行中" }, { value: "approval", label: "等你确认" },
  { value: "complete", label: "完成" }, { value: "failed", label: "没通过" }, { value: "interrupted", label: "没做完" },
];

export const NOTES: Record<Snapshot, { old: string[]; now: string[] }> = {
  empty: {
    old: ["顶部常驻「确定性试件」警示条，侧栏有「讨论区」「试件已连接」", "输入框下一行：范围 1 条 · 检查 1 条 · 预算 2轮×6步 ≤10分", "原生下拉选项目，模型旁写着「off」"],
    now: ["一句问候 + 一个输入框 + 3 个起手建议", "权限、模型收进输入框里的两个小按钮", "范围和预算自动推断，放进「…」里的高级设置"],
  },
  running: {
    old: ["顶栏「运行中 · 完成未授予」+ 暂停 + 红色急停", "状态条「在做什么 / 在等什么 / 下一步 / 预算」", "「补充会在下一次处理边界送达」"],
    now: ["只在一处说「正在修改 SettingsPanel.tsx」，配会动的 Orb", "发送键变成停止键", "运行中直接打字就是插话纠偏，马上生效"],
  },
  approval: {
    old: ["「写入文件 · 操作 write · 影响 仅允许本次请求」", "「即将批准的变更（预览，尚未执行）」+「查看调用参数」", "「完成授权仍由既有可信链决定」"],
    now: ["一句话：「要修改 2 个文件，可以吗？」", "允许 / 这个任务都允许 / 不允许；「换个改法」= 要求调整", "想看效果点「看改动」或去「预览」"],
  },
  complete: {
    old: ["「已完成 · 完成已授予」徽标", "「交付已获可信授权」「objective checks passed + human review approved」", "输入框「任务已结束，不再接收补充指令」"],
    now: ["一张结果卡：改了什么、检查过没有", "看预览 + 撤销（撤销后还能恢复）", "完成后还能接着说，开下一轮小改动"],
  },
  failed: {
    old: ["「检查未通过；本次交付没有可信完成授权」", "「已阻塞 · 任务无法继续 · 终态不会自动重跑」+「退出码 1」", "输入框「任务已阻塞，不再接收补充指令」"],
    now: ["「改完了，但检查没通过」+ 一句原因", "一键「让 Jarvis 修好」，也能直接说怎么处理", "完整输出在「终端」里，不藏结果"],
  },
  interrupted: {
    old: ["「可恢复 · 现场可以恢复」", "「检查已恢复的 Session 事实；通过恢复校验后才继续」", "「Runtime 当前不在可接收补充指令的状态」"],
    now: ["「上次没做完」+ 停在哪一步、改动在不在", "接着做 / 撤销改动", "恢复校验照常在后台做，界面只给结论"],
  },
};

export function CompareOverlay({ mode, snap, onX, x }: { mode: CompareMode; snap: Snapshot; x: number; onX: (v: number) => void }) {
  const root = useRef<HTMLDivElement>(null);
  if (mode === "new") return null;
  const drag = (e: RPE) => { const r = root.current!.getBoundingClientRect(); onX(Math.max(3, Math.min(97, ((e.clientX - r.left) / r.width) * 100))); };
  return <div ref={root} className={`compare-overlay is-${mode}`} aria-hidden={mode === "split" ? undefined : true}>
    <img src={OLD[snap]} alt="旧版界面截图" style={mode === "split" ? { clipPath: `inset(0 ${100 - x}% 0 0)` } : undefined} />
    {mode === "split" && <>
      <div className="co-handle" style={{ left: `${x}%` }} onPointerDown={e => { (e.currentTarget as Element).setPointerCapture(e.pointerId); drag(e); }} onPointerMove={e => e.buttons && drag(e)} role="slider" aria-label="拖动对照旧版与新稿" aria-valuenow={Math.round(x)} tabIndex={0}><span className="co-knob">‹ ›</span></div>
      <span className="co-tag left" style={{ right: `calc(${100 - x}% + 14px)` }}>旧版</span>
      <span className="co-tag right" style={{ left: `calc(${x}% + 14px)` }}>新稿</span>
    </>}
    {mode === "old" && <span className="co-tag solo">旧版截图 · 同一状态</span>}
  </div>;
}

export function ReviewDock({ snap, onSnap, mode, setMode, theme, setTheme, onPlay, playing, openSignal = 0 }: { snap: Snapshot; onSnap: (s: Snapshot) => void; mode: CompareMode; setMode: (m: CompareMode) => void; theme: "light" | "dark"; setTheme: (t: "light" | "dark") => void; onPlay: () => void; playing: boolean; openSignal?: number }) {
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).get("dock") !== "0" && window.innerWidth > 760);
  useEffect(() => { if (openSignal) setOpen(true); }, [openSignal]);
  const n = NOTES[snap];
  return <div className={`dock${open ? " is-open" : ""}`}>
    <button type="button" className="dock-pill" onClick={() => setOpen(o => !o)} aria-expanded={open}><i className="dot" /><span className="dock-pill-name">走查台</span><span className="dock-pill-sub">{playing ? "自动演示中 · " : ""}{STATES.find(x => x.value === snap)?.label} · {mode === "new" ? "新稿" : mode === "old" ? "旧版" : "对照"}</span><ChevronDown size={14} className={`chev-up${open ? " is-open" : ""}`} /></button>
    <div className="dock-pop">
    <AnimatePresence initial={false}>
      {open && <motion.div className="dock-panel" initial={{ opacity: 0, y: -8, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: .98 }} transition={{ type: "spring", visualDuration: .3, bounce: .1 }}>
        <div className="dock-row">
          <span className="dock-label">状态</span>
          <div className="dock-states">{STATES.map(st => <button key={st.value} type="button" className={`dock-chip${snap === st.value ? " is-on" : ""}`} onClick={() => onSnap(st.value)}>{st.label}</button>)}</div>
        </div>
        <div className="dock-row">
          <span className="dock-label">对照</span>
          <SegmentedControl label="对照方式" value={mode} onValueChange={v => setMode(v as CompareMode)} options={[{ value: "new", label: "新稿" }, { value: "split", label: "滑动对照" }, { value: "old", label: "旧版" }]} />
        </div>
        <div className="dock-notes">
          <div className="is-old"><h5>旧版</h5><ul>{n.old.map(t => <li key={t}>{t}</li>)}</ul></div>
          <div className="is-new"><h5>新稿</h5><ul>{n.now.map(t => <li key={t}>{t}</li>)}</ul></div>
        </div>
        <div className="dock-row foot">
          <button type="button" className="dock-play" onClick={() => { if (!playing) setOpen(false); onPlay(); }}>{playing ? <Pause size={14} /> : <Play size={14} />}{playing ? "演示中，点页面任意处接管" : "从头自动演示"}</button>
          <span className="grow" />
          <button type="button" className="dock-icon" aria-label="收起走查台" onClick={() => setOpen(false)}><ChevronDown size={15} style={{ transform: "rotate(180deg)" }} /></button>
          <button type="button" className="dock-icon" aria-label={theme === "dark" ? "切到浅色" : "切到深色"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}</button>
        </div>
      </motion.div>}
    </AnimatePresence>
    </div>
  </div>;
}
