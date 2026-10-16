// The canvas: one view of the whole task. Flow (archify-style swimlanes), lifecycle, and timing, with a node passport and the todo list beside it.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, ChevronLeft, ChevronRight, CircleCheck, Crosshair, Eye, FileText, GitCompareArrows, Hand, Lightbulb, Maximize2, Minus, MessageSquare, CornerDownRight, Pause, Pencil, Play, Plus, RotateCcw, Search, ShieldCheck, Shapes, SquareTerminal, Undo2, Wrench, X } from "lucide-react";
import SegmentedControl from "../arc/segmented-control/segmented-control";
import { Button } from "../arc/button/button";
import { DonutChart } from "../arc/donut-chart/donut-chart";
import { UsageMeter } from "../arc/usage-meter/usage-meter";
import { Diffstat, Orb, fmtElapsed } from "../ui/Bits";
import type { Act } from "../store";
import { LANES, STAGES, STATUS_LABEL, type Flow, type FlowNode, type Lane, type LifeKey, type NStatus, type Todo } from "./model";

export type MapMode = "flow" | "state" | "time";
type Tab = "changes" | "preview" | "terminal";
export interface CanvasProps {
  flow: Flow; theme: "light" | "dark"; map: MapMode; setMap: (m: MapMode) => void; budget: number;
  act?: Act; phase: string; onOpenFile: (p: string) => void; onPanel: (t: Tab) => void; onExplain?: () => void;
}

const LANE_IX: Record<Lane, number> = { you: 0, jarvis: 1, files: 2, checks: 3 };
const G = 68, LW = 200, NW = 180, NH = 60, RH = 96, TOP = 14;
const W = G + LW * 4 + 12;

function nodeIcon(n: FlowNode, theme: "light" | "dark") {
  if (n.status === "running") return n.kind === "think" ? <Orb state="working" size={20} theme={theme} /> : <span className="spin" />;
  if (n.status === "failed") return <X size={14} />;
  switch (n.kind) {
    case "ask": return <MessageSquare size={14} />;
    case "interject": return <CornerDownRight size={14} />;
    case "read": return n.parts?.every(p => p.type === "search") ? <Search size={14} /> : <FileText size={14} />;
    case "plan": return <Lightbulb size={14} />;
    case "gate": return n.status === "waiting" ? <Hand size={14} /> : <ShieldCheck size={14} />;
    case "edit": return <Pencil size={14} />;
    case "check": return <SquareTerminal size={14} />;
    case "result": return n.outcome === "reverted" ? <Undo2 size={14} /> : <CircleCheck size={14} />;
    case "notice": return n.notice === "interrupted" ? <RotateCcw size={14} /> : n.notice === "discuss" ? <MessageSquare size={14} /> : <span className="stop-square is-sm" />;
    default: return <Lightbulb size={14} />;
  }
}
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

function Ring({ value, size = 30, stroke = 3 }: { value: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  return <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
    <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className="ring-track" />
    <motion.circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className="ring-fill" strokeDasharray={c} initial={false} animate={{ strokeDashoffset: c * (1 - Math.max(0, Math.min(1, value))) }} transition={{ type: "spring", visualDuration: .5, bounce: 0 }} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
  </svg>;
}

function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!on) return; const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, [on]);
  return now;
}

export function Canvas({ flow, theme, map, setMap, budget, act, phase, onOpenFile, onPanel, onExplain }: CanvasProps) {
  const [picked, setPicked] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [still, setStill] = useState(false);
  const reduced = useReducedMotion();
  const now = useNow(flow.live);
  useEffect(() => { if (follow) setPicked(null); }, [flow.focus, follow]);
  const sel = picked && flow.nodes.some(n => n.id === picked) ? picked : flow.focus;
  const node = flow.nodes.find(n => n.id === sel);
  const elapsed = flow.live && flow.startedAt ? now - flow.startedAt : flow.elapsedMs;
  const pick = (id?: string) => { if (!id) return; setPicked(id); setFollow(false); };
  const step = (d: number) => { const i = flow.nodes.findIndex(n => n.id === sel); const n = flow.nodes[Math.max(0, Math.min(flow.nodes.length - 1, i + d))]; if (n) pick(n.id); };
  const checkText = flow.checks.fail ? `${flow.checks.fail} 项没通过` : flow.checks.pass ? `${flow.checks.pass} 项都通过` : "还没跑";

  return <div className={`canvas${still || reduced ? " is-still" : ""}`} onKeyDown={e => {
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") { if ((e.target as HTMLElement).closest(".fn, .wf-row, .cv-todos")) { e.preventDefault(); step(1); } }
    if (e.key === "ArrowUp" || e.key === "ArrowLeft") { if ((e.target as HTMLElement).closest(".fn, .wf-row, .cv-todos")) { e.preventDefault(); step(-1); } }
  }}>
    <div className="cv-head">
      <div className="cv-stats" role="group" aria-label="这个任务的概况">
        <span className="cv-stat is-ring"><Ring value={flow.total ? flow.done / flow.total : 0} /><span><b>{flow.done}/{flow.total}</b><small>要做的事</small></span></span>
        <span className="cv-stat"><b>{elapsed != null ? fmtElapsed(elapsed) : "—"}</b><small>用时</small></span>
        <span className="cv-stat"><b>¥{flow.cost.toFixed(2)}</b><small>花费 · 预算 ¥{budget}</small></span>
        <button type="button" className="cv-stat is-btn" onClick={() => onPanel("changes")} disabled={!flow.fileList.length}><b>{flow.fileList.length} 个文件 {flow.fileList.length > 0 && <Diffstat add={flow.add} del={flow.del} />}</b><small>改动</small></button>
        <button type="button" className="cv-stat is-btn" onClick={() => onPanel("terminal")} disabled={!flow.checks.pass && !flow.checks.fail}><b className={flow.checks.fail ? "tone-danger" : undefined}>{checkText}</b><small>检查</small></button>
      </div>
      <span className="grow" />
      <SegmentedControl label="画布视图" value={map} onValueChange={v => setMap(v as MapMode)} options={[{ value: "flow", label: "链路" }, { value: "state", label: "状态" }, { value: "time", label: "时间" }]} />
      {onExplain && <Button size="sm" variant="secondary" onClick={onExplain}><Shapes size={14} />讲解图</Button>}
    </div>
    <div className="cv-body">
      <div className="cv-main">
        {map === "flow" && <FlowMap flow={flow} sel={sel} onPick={pick} theme={theme} follow={follow} setFollow={setFollow} still={still || !!reduced} setStill={setStill} />}
        {map === "state" && <StateMap flow={flow} onPick={k => { const id = lifeNode(flow, k); if (id) pick(id); }} />}
        {map === "time" && <TimeMap flow={flow} sel={sel} onPick={pick} budget={budget} />}
      </div>
      <aside className="cv-side" aria-label="选中的一步和要做的事">
        <AnimatePresence mode="popLayout" initial={false}>
          {node && <Passport key={node.id} n={node} flow={flow} theme={theme} act={act} phase={phase} onOpenFile={onOpenFile} onPanel={onPanel} onExplain={onExplain} onStep={step} />}
        </AnimatePresence>
        <Todos flow={flow} sel={sel} onPick={pick} />
      </aside>
    </div>
  </div>;
}

/* ---------- Flow map ---------- */
function FlowMap({ flow, sel, onPick, theme, follow, setFollow, still, setStill }: { flow: Flow; sel?: string; onPick: (id: string) => void; theme: "light" | "dark"; follow: boolean; setFollow: (v: boolean) => void; still: boolean; setStill: (v: boolean) => void }) {
  const vp = useRef<HTMLDivElement>(null);
  const [vw, setVw] = useState(800);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [hover, setHover] = useState<string | null>(null);
  const [lens, setLens] = useState<"all" | Lane>("all");
  const H = TOP + flow.nodes.length * RH + 20;
  const fit = Math.max(.55, Math.min(1, (vw - 24) / W));
  const z = zoom === "fit" ? fit : zoom;
  useLayoutEffect(() => {
    const el = vp.current; if (!el) return;
    const ro = new ResizeObserver(() => setVw(el.clientWidth)); ro.observe(el); setVw(el.clientWidth);
    const wheel = (e: WheelEvent) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); setZoom(cur => { const c = cur === "fit" ? fit : cur; return Math.max(.5, Math.min(1.6, +(c * (e.deltaY < 0 ? 1.1 : 1 / 1.1)).toFixed(2))); }); };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => { ro.disconnect(); el.removeEventListener("wheel", wheel); };
  }, [fit]);
  const pos = useMemo(() => new Map(flow.nodes.map((n, i) => [n.id, { x: G + LANE_IX[n.lane] * LW + (LW - NW) / 2, y: TOP + i * RH + (RH - NH) / 2 }])), [flow.nodes]);
  // Follow the newest step, like the thread scrolls to its end.
  useEffect(() => {
    if (!follow || !flow.focus) return; const p = pos.get(flow.focus); const el = vp.current; if (!p || !el) return;
    el.scrollTo({ top: Math.max(0, 40 + (p.y + NH / 2) * z - el.clientHeight / 2), behavior: still ? "auto" : "smooth" });
  }, [follow, flow.focus, pos, z, still]);
  // Drag the empty canvas to pan.
  const drag = useRef<{ x: number; y: number; l: number; t: number } | null>(null);
  const near = useMemo(() => { if (!hover) return null; const s = new Set([hover]); for (const e of flow.edges) { if (e.from === hover) s.add(e.to); if (e.to === hover) s.add(e.from); } return s; }, [hover, flow.edges]);
  const newRound = (i: number) => i > 0 && flow.nodes[i].round > flow.nodes[i - 1].round;
  const bands = useMemo(() => { const out: { stage: FlowNode["stage"]; a: number; b: number }[] = []; flow.nodes.forEach((n, i) => { const l = out[out.length - 1]; if (l && l.stage === n.stage) l.b = i; else out.push({ stage: n.stage, a: i, b: i }); }); return out; }, [flow.nodes]);
  const counts = useMemo(() => { const c: Partial<Record<NStatus, number>> = {}; for (const n of flow.nodes) c[n.status] = (c[n.status] ?? 0) + 1; return c; }, [flow.nodes]);
  const dimmed = (n: FlowNode) => (lens !== "all" && n.lane !== lens) || (near ? !near.has(n.id) : false);

  return <div className="fm">
    <div ref={vp} className="fm-viewport" tabIndex={-1}
      onPointerDown={e => { if ((e.target as HTMLElement).closest("button")) return; const el = vp.current!; drag.current = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop }; el.setPointerCapture(e.pointerId); el.classList.add("is-grabbing"); }}
      onPointerMove={e => { const d = drag.current; if (!d) return; const el = vp.current!; el.scrollLeft = d.l - (e.clientX - d.x); el.scrollTop = d.t - (e.clientY - d.y); if (Math.abs(e.clientY - d.y) > 4) setFollow(false); }}
      onPointerUp={() => { drag.current = null; vp.current?.classList.remove("is-grabbing"); }}>
      <div className={`fm-heads${z < .75 ? " is-tight" : ""}`} style={{ minWidth: W * z }}><div className="fm-heads-in" style={{ width: W * z }}>
        {LANES.map((l, i) => <div key={l.id} className={`fm-lane-head${lens === l.id ? " is-on" : ""}`} style={{ left: (G + i * LW) * z, width: LW * z }}><b>{l.label}</b><small>{l.hint}</small></div>)}
      </div></div>
      <div className="fm-sizer" style={{ width: W * z, height: H * z }}>
        <div className="fm-content" style={{ width: W, height: H, transform: `scale(${z})` }}>
          <svg className="fm-svg" width={W} height={H} aria-hidden>
            <defs>
              {(["done", "live", "planned", "fail"] as const).map(t => <marker key={t} id={`fm-arrow-${t}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0.8 L7 4 L0 7.2 Z" className={`fm-head is-${t}`} /></marker>)}
            </defs>
            {bands.map((b, i) => <g key={i} className="fm-band">
              {i % 2 === 0 && <rect x={6} y={TOP + b.a * RH + 3} width={W - 12} height={(b.b - b.a + 1) * RH - 6} rx={18} />}
              {newRound(b.a) && <line x1={6} x2={W - 6} y1={TOP + b.a * RH} y2={TOP + b.a * RH} className="fm-round-line" />}
            </g>)}
            {LANES.map((l, i) => i > 0 && <line key={l.id} x1={G + i * LW} x2={G + i * LW} y1={0} y2={H - 8} className="fm-lane-line" />)}
            {flow.edges.map(e => {
              const a = pos.get(e.from)!, b = pos.get(e.to)!;
              const x1 = a.x + NW / 2, y1 = a.y + NH, x2 = b.x + NW / 2, y2 = b.y - 2, my = y1 + (RH - NH) / 2;
              const r = Math.min(10, Math.abs(x2 - x1) / 2);
              const d = x1 === x2 ? `M${x1} ${y1} V${y2}` : `M${x1} ${y1} V${my - r} Q${x1} ${my} ${x1 + Math.sign(x2 - x1) * r} ${my} H${x2 - Math.sign(x2 - x1) * r} Q${x2} ${my} ${x2} ${my + r} V${y2}`;
              const on = near ? near.has(e.from) && near.has(e.to) && (e.from === hover || e.to === hover) : true;
              return <path key={e.id} d={d} className={`fm-edge is-${e.tone}${on ? "" : " is-dim"}`} markerEnd={`url(#fm-arrow-${e.tone})`} />;
            })}
          </svg>
          {bands.map((b, i) => <div key={i} className="fm-band-label" style={{ top: TOP + b.a * RH + 12 }}><i>{STAGES[b.stage].n}</i>{STAGES[b.stage].label}</div>)}
          {bands.map((b, i) => newRound(b.a) && <div key={`r${i}`} className="fm-round" style={{ top: TOP + b.a * RH - 9, right: 16 }}>第 {flow.nodes[b.a].round + 1} 轮</div>)}
          {flow.edges.map(e => {
            if (!e.label) return null;
            const a = pos.get(e.from)!, b = pos.get(e.to)!;
            const x1 = a.x + NW / 2, x2 = b.x + NW / 2, my = a.y + NH + (RH - NH) / 2;
            const x = x1 === x2 ? x1 + 10 : (x1 + x2) / 2;
            return <span key={e.id} className={`fm-edge-label is-${e.tone}${x1 === x2 ? " is-side" : ""}`} style={{ left: x, top: my }}>{e.label}</span>;
          })}
          {flow.nodes.map(n => { const p = pos.get(n.id)!; return <button key={n.id} type="button" data-node={n.id}
            className={`fn is-${n.status} kind-${n.kind}${n.final ? " is-final" : ""}${sel === n.id ? " is-selected" : ""}${dimmed(n) ? " is-dim" : ""}${n.suggestion ? " is-suggestion" : ""}`}
            style={{ left: p.x, top: p.y, width: NW, height: NH }} onClick={() => onPick(n.id)} onPointerEnter={() => setHover(n.id)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(n.id)} onBlur={() => setHover(null)}
            aria-label={`${n.title}，${STATUS_LABEL[n.status]}`} aria-pressed={sel === n.id}>
            <span className="fn-ico">{nodeIcon(n, theme)}</span>
            <span className="fn-body"><span className="fn-title">{n.title}</span>{n.sub && <span className={`fn-sub${n.kind === "check" && n.status !== "failed" && n.sub.includes(" ") && /^(npm|npx)/.test(n.sub) ? " mono" : ""}`}>{n.sub}</span>}</span>
            <span className="fn-meta">{n.status === "done" ? (n.ms ? secs(n.ms) : "") : STATUS_LABEL[n.status]}</span>
            {n.tag && <span className="fn-tag">{n.tag}</span>}
          </button>; })}
        </div>
      </div>
    </div>
    <div className="fm-toolbar" role="toolbar" aria-label="画布工具">
      <div className="tb-legend" aria-label="图例">{(["done", "running", "waiting", "failed", "stopped", "skipped", "planned"] as NStatus[]).filter(k => counts[k]).map(k => <span key={k} className={`lg is-${k}`} title={`${STATUS_LABEL[k]} ${counts[k]} 步`}><i /><span className="lg-name">{STATUS_LABEL[k]}</span><b>{counts[k]}</b></span>)}</div>
      <span className="tb-sep" />
      <div className="tb-group" role="group" aria-label="只看某一列">{([["all", "全部"], ["you", "你"], ["files", "改动"], ["checks", "检查"]] as const).map(([k, l]) => <button key={k} type="button" className={`tb-chip${lens === k ? " is-on" : ""}`} aria-pressed={lens === k} onClick={() => setLens(k)}>{l}</button>)}</div>
      <span className="tb-sep" />
      <button type="button" className="tb-btn" aria-label="缩小" onClick={() => setZoom(Math.max(.5, +(z / 1.15).toFixed(2)))}><Minus size={14} /></button>
      <button type="button" className="tb-zoom" onClick={() => setZoom(1)} title="回到 100%">{Math.round(z * 100)}%</button>
      <button type="button" className="tb-btn" aria-label="放大" onClick={() => setZoom(Math.min(1.6, +(z * 1.15).toFixed(2)))}><Plus size={14} /></button>
      <button type="button" className={`tb-btn${zoom === "fit" ? " is-on" : ""}`} aria-label="适应宽度" title="适应宽度" onClick={() => setZoom("fit")}><Maximize2 size={13} /></button>
      <span className="tb-sep" />
      <button type="button" className={`tb-btn${follow ? " is-on" : ""}`} aria-pressed={follow} title="跟着最新一步" aria-label="跟着最新一步" onClick={() => setFollow(!follow)}><Crosshair size={14} /></button>
      <button type="button" className={`tb-chip${still ? "" : " is-on"}`} aria-pressed={!still} onClick={() => setStill(!still)} title={still ? "动效已暂停" : "连线在流动"}>{still ? <Play size={12} /> : <Pause size={12} />}{still ? "静止" : "实时"}</button>
    </div>
  </div>;
}

/* ---------- Lifecycle ---------- */
// Hand-placed like a diagram-design state lifecycle: the happy path on one row, side states above and below, every label on its own side of its line.
const LIFE: { k: LifeKey; label: string; x: number; y: number }[] = [
  { k: "queued", label: "收到要求", x: 60, y: 170 }, { k: "understand", label: "看代码", x: 180, y: 170 }, { k: "plan", label: "定改法", x: 300, y: 170 },
  { k: "edit", label: "修改", x: 500, y: 170 }, { k: "check", label: "检查", x: 640, y: 170 }, { k: "deliver", label: "交付", x: 790, y: 170 },
  { k: "discuss", label: "只讨论", x: 230, y: 56 }, { k: "gate", label: "等你确认", x: 400, y: 56 }, { k: "reverted", label: "已撤销", x: 790, y: 56 },
  { k: "stopped", label: "停下了", x: 420, y: 290 }, { k: "failed", label: "没通过", x: 600, y: 290 }, { k: "interrupted", label: "没做完", x: 760, y: 290 },
];
const LIFE_EDGES: { a: LifeKey; b: LifeKey; d: string; label?: string; lx?: number; ly?: number; anchor?: "start" | "middle" | "end" }[] = [
  { a: "queued", b: "understand", d: "M108 170 H130" }, { a: "understand", b: "plan", d: "M228 170 H250" },
  { a: "plan", b: "edit", d: "M348 170 H450", label: "自动模式", lx: 399, ly: 162 },
  { a: "edit", b: "check", d: "M548 170 H590", label: "改完", lx: 569, ly: 162 },
  { a: "check", b: "deliver", d: "M688 170 H740", label: "都通过", lx: 714, ly: 162 },
  { a: "plan", b: "discuss", d: "M282 151 C282 112 236 112 236 77", label: "只讨论", lx: 252, ly: 118, anchor: "end" },
  { a: "discuss", b: "gate", d: "M278 56 H350", label: "动手改", lx: 314, ly: 48 },
  { a: "plan", b: "gate", d: "M318 151 C318 108 384 112 384 77", label: "要改文件", lx: 346, ly: 120, anchor: "start" },
  { a: "gate", b: "gate", d: "M386 36 C380 6 420 6 414 36", label: "换个改法", lx: 400, ly: 12 },
  { a: "gate", b: "edit", d: "M436 70 C470 80 488 110 488 149", label: "允许", lx: 478, ly: 98, anchor: "start" },
  { a: "plan", b: "stopped", d: "M330 189 C330 240 380 268 396 271", label: "没允许", lx: 340, ly: 252, anchor: "end" },
  { a: "edit", b: "stopped", d: "M478 189 C478 228 446 240 440 271", label: "你停止", lx: 452, ly: 222, anchor: "end" },
  { a: "stopped", b: "edit", d: "M456 271 C462 238 500 232 500 191", label: "继续", lx: 486, ly: 248, anchor: "start" },
  { a: "check", b: "failed", d: "M624 189 V271", label: "没通过", lx: 630, ly: 236, anchor: "start" },
  { a: "failed", b: "edit", d: "M580 271 C580 232 520 230 520 191", label: "修好再检查", lx: 546, ly: 220, anchor: "end" },
  { a: "check", b: "interrupted", d: "M668 189 C668 230 740 236 744 271", label: "被关掉", lx: 690, ly: 248, anchor: "end" },
  { a: "interrupted", b: "check", d: "M770 271 C770 222 690 226 682 191", label: "接着做", lx: 758, ly: 226, anchor: "start" },
  { a: "deliver", b: "reverted", d: "M778 151 V77", label: "撤销", lx: 772, ly: 118, anchor: "end" },
  { a: "reverted", b: "deliver", d: "M802 77 V149", label: "恢复", lx: 808, ly: 118, anchor: "start" },
  { a: "deliver", b: "edit", d: "M754 151 C754 112 530 112 530 149", label: "接着改", lx: 642, ly: 112 },
];
const BW = 96, BH = 38;
function lifeNode(flow: Flow, k: LifeKey) {
  const match = (n: FlowNode) => k === "understand" ? n.kind === "read" : k === "plan" ? n.kind === "plan" : k === "gate" ? n.kind === "gate" : k === "edit" ? n.kind === "edit" : k === "check" ? n.kind === "check"
    : k === "deliver" || k === "reverted" ? n.kind === "result" && n.outcome !== "failed" : k === "failed" ? n.kind === "result" && n.outcome === "failed" : k === "queued" ? n.kind === "ask" : n.notice === k || (k === "stopped" && n.status === "stopped");
  return [...flow.nodes].reverse().find(n => n.status !== "planned" && match(n))?.id ?? flow.nodes.find(match)?.id;
}
function StateMap({ flow, onPick }: { flow: Flow; onPick: (k: LifeKey) => void }) {
  const at = (k: LifeKey) => LIFE.find(x => x.k === k)!;
  const walked = new Set(flow.life.path.map(([a, b]) => `${a}>${b}`));
  const seq: LifeKey[] = flow.life.path.length ? [flow.life.path[0][0], ...flow.life.path.map(([, b]) => b)] : [flow.life.current];
  const loops = Object.values(flow.life.visits).filter(v => (v ?? 0) > 1).length;
  const tone: Partial<Record<LifeKey, string>> = { failed: "danger", interrupted: "warning", gate: "warning", stopped: "muted", reverted: "muted", discuss: "muted" };
  return <div className="sm-map">
    <div className="sm-note"><b>任务的状态</b><span>实线是这次真的走过的路，虚线是可能走的路。点一个状态，右边会显示那一步。</span></div>
    <div className="sm-body"><svg className="sm-svg" viewBox="0 0 880 330" role="img" aria-label={`任务状态图，现在在「${at(flow.life.current).label}」`}>
      <defs><marker id="sm-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0.8 L7 4 L0 7.2 Z" /></marker>
        <marker id="sm-arrow-on" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0.8 L7 4 L0 7.2 Z" /></marker></defs>
      {LIFE_EDGES.map(e => { const on = walked.has(`${e.a}>${e.b}`); return <g key={`${e.a}>${e.b}`} className={`sm-edge${on ? " is-on" : ""}`}>
        <path d={e.d} markerEnd={`url(#${on ? "sm-arrow-on" : "sm-arrow"})`} />
        {e.label && <text x={e.lx} y={e.ly} textAnchor={e.anchor ?? "middle"}>{e.label}</text>}
      </g>; })}
      {LIFE.map(s => { const v = flow.life.visits[s.k] ?? 0; const cur = flow.life.current === s.k; return <g key={s.k} className={`sm-node${v ? " is-visited" : ""}${cur ? " is-current" : ""}${tone[s.k] ? ` tone-${tone[s.k]}` : ""}${s.k === "deliver" ? " is-final" : ""}`} transform={`translate(${s.x - BW / 2} ${s.y - BH / 2})`}
        role="button" tabIndex={v ? 0 : -1} aria-label={`${s.label}${v ? `，走过 ${v} 次` : "，没走到"}${cur ? "，现在在这" : ""}`} onClick={() => v && onPick(s.k)} onKeyDown={ev => { if ((ev.key === "Enter" || ev.key === " ") && v) { ev.preventDefault(); onPick(s.k); } }}>
        {s.k === "deliver" && <rect x={-4} y={-4} width={BW + 8} height={BH + 8} rx={16} className="sm-outer" />}
        <rect width={BW} height={BH} rx={12} />
        <text x={BW / 2} y={BH / 2 + 4.5} textAnchor="middle">{s.label}</text>
        {v > 1 && <g transform={`translate(${BW - 6} -6)`}><circle r={9} className="sm-count" /><text y={3.5} textAnchor="middle" className="sm-count-t">{v}</text></g>}
        {cur && <text x={BW / 2} y={s.y < 100 ? -9 : BH + 15} textAnchor="middle" className="sm-here">现在在这</text>}
      </g>; })}
    </svg>
    </div>
    <section className="sm-walk" aria-label="这次走过的路">
      <header><b>这次走过的路</b><span>{seq.length} 个状态{loops ? ` · 有 ${loops} 个状态走了不止一次` : ""}</span></header>
      <ol>{seq.map((k, i) => { const last = i === seq.length - 1; return <li key={`${k}-${i}`}>
        <button type="button" className={last ? "is-cur" : ""} onClick={() => onPick(k)}><i className="sm-step mono">{i + 1}</i>{at(k).label}</button>
        {!last && <ChevronRight size={13} className="sm-sep" aria-hidden />}
      </li>; })}</ol>
    </section>
  </div>;
}

/* ---------- Timing ---------- */
function TimeMap({ flow, sel, onPick, budget }: { flow: Flow; sel?: string; onPick: (id: string) => void; budget: number }) {
  const rows = flow.nodes.filter(n => n.status !== "planned");
  const later = flow.nodes.filter(n => n.status === "planned");
  let t = 0; const bars = rows.map(n => { const b = { n, start: t, ms: n.status === "running" ? Math.max(n.ms, 800) : n.ms }; t += b.ms; return b; });
  const T = Math.max(t, 1000);
  const stepS = T < 9000 ? 1 : T < 18000 ? 2 : 5;
  const ticks = Array.from({ length: Math.floor(T / 1000 / stepS) + 1 }, (_, i) => i * stepS);
  const meter = flow.stageCost.length > 4 ? [...flow.stageCost.slice(0, 3), { key: "rest", label: "其余", value: +flow.stageCost.slice(3).reduce((a, x) => a + x.value, 0).toFixed(2) }] : flow.stageCost;
  const runs = flow.nodes.filter(n => n.kind === "check");
  const passed = runs.filter(n => n.status === "done").length, failed = runs.filter(n => n.status === "failed").length, skipped = runs.filter(n => n.status === "skipped" || n.status === "planned").length;
  return <div className="tm">
    <section className="tm-card">
      <header className="tm-head"><b>每一步花了多久</b><span className="tm-badge">示意时长</span><span className="tm-sub">按剧本估算，不是真实计时 · 合计约 {secs(t)}</span></header>
      <div className="wf" role="list">
        <div className="wf-axis" aria-hidden><span />{<div className="wf-ticks">{ticks.map(s => <i key={s} style={{ left: `${s * 1000 / T * 100}%` }}>{s} 秒</i>)}</div>}<span /></div>
        {bars.map(({ n, start, ms }) => <button key={n.id} type="button" role="listitem" className={`wf-row is-${n.status}${sel === n.id ? " is-selected" : ""}`} onClick={() => onPick(n.id)}>
          <span className="wf-label"><i className={`lane-dot lane-${n.lane}`} />{n.title}</span>
          <span className="wf-track">{ticks.map(s => <i key={s} className="wf-grid" style={{ left: `${s * 1000 / T * 100}%` }} />)}
            {ms > 0 ? <span className={`wf-bar lane-${n.lane}${n.kind === "gate" ? " is-wait" : ""}`} style={{ left: `${start / T * 100}%`, width: `max(3px, ${ms / T * 100}%)` }} /> : <span className="wf-dot" style={{ left: `${start / T * 100}%` }} />}
          </span>
          <span className="wf-ms">{n.status === "running" ? "进行中" : ms ? secs(ms) : n.kind === "interject" ? "插话" : ""}</span>
        </button>)}
        {later.length > 0 && <p className="wf-later">还要做：{later.map(n => n.title).join("、")}</p>}
      </div>
    </section>
    <div className="tm-grid">
      <section className="tm-card">
        <header className="tm-head"><b>花费按阶段</b></header>
        {flow.stageCost.length ? <DonutChart data={flow.stageCost.map(x => ({ key: x.key, label: x.label, value: x.value }))} label="这次任务的花费，按阶段" formatValue={v => `¥${v.toFixed(2)}`} totalLabel="合计" otherLabel="其余" emptyLabel="还没有花费" size={140} thickness={18} legend legendAction="select" className="tm-donut" /> : <p className="muted tm-empty">还没有花费。</p>}
      </section>
      <section className="tm-card">
        <UsageMeter label="这个任务的预算" segments={meter.map(x => ({ id: x.key, label: x.label, value: x.value }))} limit={budget} prefix="¥" decimals={2} freeLabel="还剩" overLabel="超出" />
        <div className="tm-tests">
          <header className="tm-head"><b>检查结果</b></header>
          <div className="tt-badges"><span className="tt-b is-pass"><Check size={12} />{passed} 通过</span><span className={`tt-b is-fail${failed ? "" : " is-zero"}`}><X size={12} />{failed} 没通过</span><span className="tt-b is-skip">{skipped} 待跑</span></div>
          <div className="tt-bar" aria-hidden><i className="is-pass" style={{ flex: passed }} /><i className="is-fail" style={{ flex: failed }} /><i className="is-skip" style={{ flex: skipped }} /></div>
          {flow.checks.tests && <p className="tt-line mono">{flow.checks.tests}</p>}
        </div>
      </section>
    </div>
  </div>;
}

/* ---------- Passport ---------- */
function Passport({ n, flow, theme, act, phase, onOpenFile, onPanel, onExplain, onStep }: { n: FlowNode; flow: Flow; theme: "light" | "dark"; act?: Act; phase: string; onOpenFile: (p: string) => void; onPanel: (t: Tab) => void; onExplain?: () => void; onStep: (d: number) => void }) {
  const i = flow.nodes.findIndex(x => x.id === n.id);
  const lane = LANES.find(l => l.id === n.lane)!;
  let actions: ReactNode = null;
  if (act && n.kind === "gate" && n.status === "waiting" && phase === "approval") actions = <>
    <Button size="sm" onClick={() => act({ type: "approve", all: false })}>允许</Button>
    <Button size="sm" variant="secondary" onClick={() => act({ type: "approve", all: true })}>这个任务都允许</Button>
    <Button size="sm" variant="ghost" onClick={() => act({ type: "deny" })}>不允许</Button>
  </>;
  else if (act && n.kind === "result" && n.status === "failed" && phase === "failed") actions = <><Button size="sm" onClick={() => act({ type: "fix" })}><Wrench size={14} />让 Jarvis 修好</Button><Button size="sm" variant="secondary" onClick={() => onPanel("terminal")}>看输出</Button></>;
  else if (act && n.notice === "interrupted" && phase === "interrupted") actions = <Button size="sm" onClick={() => act({ type: "resume" })}>接着做</Button>;
  else if (act && n.notice === "stopped" && phase === "stopped") actions = <Button size="sm" variant="secondary" onClick={() => act({ type: "continue" })}>继续</Button>;
  else if (n.kind === "result" && n.outcome === "done") actions = <><Button size="sm" variant="secondary" onClick={() => onPanel("preview")}><Eye size={14} />看预览</Button><Button size="sm" variant="ghost" onClick={() => onPanel("changes")}><GitCompareArrows size={14} />看改动</Button>{onExplain && <Button size="sm" variant="ghost" onClick={onExplain}><Shapes size={14} />讲解图</Button>}</>;
  else if (n.kind === "check" && n.output) actions = <Button size="sm" variant="secondary" onClick={() => onPanel("terminal")}><SquareTerminal size={14} />在终端里看</Button>;
  else if (n.kind === "gate" && n.status !== "planned") actions = <Button size="sm" variant="secondary" onClick={() => onPanel("changes")}><GitCompareArrows size={14} />看要改的文件</Button>;
  return <motion.section className={`cv-card pp is-${n.status}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ type: "spring", visualDuration: .26, bounce: 0 }} aria-live="polite">
    <header className="pp-head">
      <span className={`pp-ico fn-ico is-${n.status}`}>{nodeIcon(n, theme)}</span>
      <div><h3>{n.title}</h3><p>{lane.label} · {STAGES[n.stage].label} · 第 {i + 1} 步</p></div>
      <span className={`pp-badge is-${n.status}`}>{STATUS_LABEL[n.status]}</span>
    </header>
    {n.quote && <blockquote className="pp-quote">{n.quote}</blockquote>}
    {n.detail && <p className="pp-said"><b>Jarvis</b>{n.detail}</p>}
    {n.parts && n.kind !== "check" && <ul className="pp-parts">{n.parts.map(p => { const opens = p.type === "edit" && p.status !== "running" && !!p.target; return <li key={p.id}>
      <button type="button" className="pp-part" disabled={!opens} onClick={() => opens && onOpenFile(p.target!)}>
        <span className={`pp-pi is-${p.status}`}>{p.status === "running" ? <span className="spin" /> : p.status === "failed" ? <X size={12} /> : <Check size={12} />}</span>
        <span className="pp-pl">{p.label}</span><span className="pp-pt">{p.target}</span>{opens ? <span className="row-link">看改动<ChevronRight size={12} /></span> : <span className="pp-pm">{p.status === "running" ? "" : secs(p.ms)}</span>}
      </button></li>; })}</ul>}
    {n.kind === "gate" && n.status !== "skipped" && flow.planFiles.length > 0 && <ul className="pp-parts">{flow.planFiles.map(f => <li key={f.path}>
      <button type="button" className="pp-part" onClick={() => onOpenFile(f.path)}><span className="pp-pi"><Pencil size={11} /></span><span className="pp-pl">{f.name}</span><span className="pp-pt">{f.dir}</span><Diffstat add={f.add} del={f.del} /><span className="row-link">看改动<ChevronRight size={12} /></span></button></li>)}</ul>}
    {n.output && <pre className="pp-out">{n.output.join("\n")}</pre>}
    {n.status === "planned" && <p className="pp-plan">{n.suggestion ? "建议的下一步：点「让 Jarvis 修好」或直接在下面说。" : "还没做到这一步。顺序可能会随你的补充调整。"}</p>}
    <dl className="pp-meta">
      <div><dt>示意用时</dt><dd>{n.status === "running" ? "进行中" : n.status === "waiting" ? "等你" : n.ms ? secs(n.ms) : "—"}</dd></div>
      <div><dt>花费</dt><dd>{n.cost ? `¥${n.cost.toFixed(2)}` : "—"}</dd></div>
    </dl>
    {actions && <div className="pp-actions">{actions}</div>}
    <footer className="pp-nav">
      <button type="button" className="pp-step" onClick={() => onStep(-1)} disabled={i <= 0}><ChevronLeft size={14} />上一步</button>
      <span>{i + 1} / {flow.nodes.length}</span>
      <button type="button" className="pp-step" onClick={() => onStep(1)} disabled={i >= flow.nodes.length - 1}>下一步<ChevronRight size={14} /></button>
    </footer>
  </motion.section>;
}

/* ---------- Todos ---------- */
function TodoMark({ s }: { s: NStatus }) {
  if (s === "done") return <span className="td-mark is-done"><Check size={11} strokeWidth={3} /></span>;
  if (s === "running") return <span className="td-mark is-running"><span className="spin" /></span>;
  if (s === "failed") return <span className="td-mark is-failed"><X size={11} strokeWidth={3} /></span>;
  if (s === "waiting") return <span className="td-mark is-waiting"><i /></span>;
  if (s === "stopped") return <span className="td-mark is-stopped"><i /></span>;
  if (s === "skipped") return <span className="td-mark is-skipped"><Minus size={11} strokeWidth={3} /></span>;
  return <span className="td-mark is-planned" />;
}
function Todos({ flow, sel, onPick }: { flow: Flow; sel?: string; onPick: (id: string) => void }) {
  const attn = flow.todos.filter(t => t.status === "waiting" || t.status === "failed").length;
  return <section className="cv-card cv-todos" aria-label="要做的事">
    <header className="td-head"><Ring value={flow.total ? flow.done / flow.total : 0} size={28} /><div><h3>要做的事</h3><p>{flow.done}/{flow.total} 完成{attn ? ` · ${attn} 项要你看` : ""}</p></div></header>
    <ol className="td-list">{flow.todos.map((t: Todo) => <li key={t.id}>
      <button type="button" className={`td-row is-${t.status}${t.node && t.node === sel ? " is-selected" : ""}`} onClick={() => t.node && onPick(t.node)} disabled={!t.node}>
        <TodoMark s={t.status} />
        <span className="td-label">{t.label}{t.note && <small>{t.note}</small>}</span>
        {t.tag && <span className="td-tag">{t.tag}</span>}
        {t.status === "running" && <span className="td-bar" aria-hidden><i /></span>}
      </button>
    </li>)}</ol>
  </section>;
}
