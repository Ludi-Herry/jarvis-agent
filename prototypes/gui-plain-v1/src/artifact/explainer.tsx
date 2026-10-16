// Explainer artifacts drawn the diagram-design way: an exploded axonometric of the settings page, a before / after breakdown, and the way of working.
// Geometry follows diagram-design's exploded-isometric spec: 2:1 dimetric iso(x,y,z) = (ox + x − y, oy + (x + y)/2 − z), faces shaded by one light, labels in one right column.
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { ChevronRight, Download, RotateCcw, Shapes } from "lucide-react";
import { Dialog, DialogContent } from "../arc/dialog/dialog";
import SegmentedControl from "../arc/segmented-control/segmented-control";
import { Button } from "../arc/button/button";
import type { Flow } from "../canvas/model";
import "./explainer.css";
import EXPORT_CSS from "./explainer.css?raw";

export type ExplainKind = "layers" | "delta" | "flow";
const KINDS: { value: ExplainKind; label: string; title: string; lede: string }[] = [
  { value: "layers", label: "分层拆解", title: "设置页拆开看：改在哪一层", lede: "把设置页按层拆开，从下往上是设计变量、页面、卡片（连同输入框）和按钮栏。蓝色是这次改的地方：保存按钮换成主按钮，圆角改用输入框的变量。" },
  { value: "delta", label: "改动前后", title: "改之前 / 改之后", lede: "同一张设置卡片，左边是原来的样子，右边是改完的样子。编号对应下面的表，每一行写着改了什么、在哪个文件。" },
  { value: "flow", label: "做法", title: "Jarvis 是怎么做的", lede: "实线是这次真的走过的路，虚线是别的情况会走的路。蓝色的一步需要你点头。" },
];

type P = [number, number];
const pts = (ps: P[]) => ps.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
interface Slab { x: number; y: number; w: number; d: number; t: number; z?: number; focal?: boolean }
interface Layer { id: string; name: string; sub: string; tag?: string; focal?: boolean; slabs: Slab[]; anchor?: number; plane?: { text: string; u: number; v: number; cls?: string }[] }

function Box({ s, z, I }: { s: Slab; z: number; I: (x: number, y: number, z: number) => P }) {
  const { x, y, w, d, t } = s; const b = z + (s.z ?? 0);
  const top = [I(x, y, b + t), I(x + w, y, b + t), I(x + w, y + d, b + t), I(x, y + d, b + t)];
  const left = [I(x, y + d, b), I(x + w, y + d, b), I(x + w, y + d, b + t), I(x, y + d, b + t)];
  const right = [I(x + w, y, b), I(x + w, y + d, b), I(x + w, y + d, b + t), I(x + w, y, b + t)];
  const hull = [I(x, y, b + t), I(x + w, y, b + t), I(x + w, y, b), I(x + w, y + d, b), I(x, y + d, b), I(x, y + d, b + t)];
  return <g className={`dd-box${s.focal ? " is-focal" : ""}`}>
    <polygon points={pts(left)} className="dd-left" /><polygon points={pts(right)} className="dd-right" /><polygon points={pts(top)} className="dd-top" /><polygon points={pts(hull)} className="dd-hull" />
  </g>;
}

function Layers({ interjected }: { interjected: boolean }) {
  // Four plates, bottom to top. The inputs sit on the card plate (they did not change); only the button bar lifts off, so the focal part reads first.
  const layers: Layer[] = [
    { id: "tokens", name: "设计变量", sub: "--radius-input · --color-primary", tag: "按钮改用它", slabs: [{ x: -150, y: -105, w: 300, d: 210, t: 10 }],
      plane: [{ text: "--radius-input: 10px", u: -96, v: 82, cls: "mono is-accent" }, { text: "--color-primary", u: -96, v: 96, cls: "mono" }] },
    { id: "page", name: "设置页", sub: "SettingsPanel.tsx", slabs: [{ x: -135, y: -95, w: 270, d: 190, t: 6 }], plane: [{ text: "设置", u: -70, v: 84 }] },
    { id: "card", name: "设置卡片 · 输入框", sub: "两个输入框圆角 10px · 没动", slabs: [{ x: -110, y: -75, w: 220, d: 150, t: 6 }, { x: -90, y: -58, w: 180, d: 24, t: 4, z: 6 }, { x: -90, y: -24, w: 180, d: 24, t: 4, z: 6 }] },
    { id: "footer", name: "按钮栏", sub: interjected ? "保存 → 主按钮 · 取消 → 文字按钮" : "保存 → 主按钮 · 圆角 10px", tag: "这次改的", focal: true,
      slabs: [{ x: -90, y: 22, w: 180, d: 34, t: 4 }, { x: -2, y: 28, w: 40, d: 22, t: 6, z: 4 }, { x: 44, y: 28, w: 44, d: 22, t: 6, z: 4, focal: true }], anchor: 0 },
  ];
  const GAP = 70, LIFT = 96; // the focal layer floats higher so its seat on the card stays visible
  const base = (l: Layer) => Math.max(...l.slabs.filter(x => !x.z).map(x => x.t));
  const zEx: number[] = [], zAs: number[] = [];
  layers.forEach((l, i) => {
    if (i === 0) { zEx.push(0); zAs.push(0); return; }
    const prevT = base(layers[i - 1]);
    zEx.push(zEx[i - 1] + prevT + (l.focal ? LIFT : GAP)); zAs.push(zAs[i - 1] + prevT);
  });
  const raw = (x: number, y: number, z: number): P => [x - y, (x + y) / 2 - z];
  // Fit the drawing: find the extent of every corner when exploded.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  layers.forEach((l, i) => l.slabs.forEach(s => { for (const [x, y] of [[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.d], [s.x, s.y + s.d]]) for (const z of [zEx[i] + (s.z ?? 0), zEx[i] + (s.z ?? 0) + s.t]) { const [px, py] = raw(x, y, z); minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py); } }));
  const ox = 24 - minX, oy = 28 - minY;
  const I = (x: number, y: number, z: number): P => [ox + x - y, oy + (x + y) / 2 - z];
  const labelX = ox + maxX + 72;
  // Labels keep one right column; when two anchors are close the leader bends so the text never overlaps.
  const anchors = layers.map((l, i) => { const s = l.slabs[l.anchor ?? 0]; return I(s.x + s.w, s.y, zEx[i] + s.t / 2); });
  const order = layers.map((_, i) => i).sort((p, q) => anchors[p][1] - anchors[q][1]);
  const ly: number[] = []; let last = -Infinity;
  for (const i of order) { ly[i] = Math.max(anchors[i][1], last + 50); last = ly[i]; }
  const W = labelX + 250, H = Math.max(maxY - minY + 56, last + 40);
  const fi = layers.findIndex(l => l.focal), ci = fi - 1;
  const seat = layers[fi].slabs[0], seatZ = zEx[ci] + base(layers[ci]), topZ = zEx[fi];
  const seatPoly = [I(seat.x, seat.y, seatZ), I(seat.x + seat.w, seat.y, seatZ), I(seat.x + seat.w, seat.y + seat.d, seatZ), I(seat.x, seat.y + seat.d, seatZ)];
  const drops: [number, number][] = [[seat.x, seat.y + seat.d], [seat.x + seat.w, seat.y + seat.d], [seat.x + seat.w, seat.y]];
  return <svg viewBox={`0 0 ${W.toFixed(0)} ${H.toFixed(0)}`} role="img" aria-label="设置页的分层拆解图：从下到上是设计变量、设置页、设置卡片和输入框、按钮栏，按钮栏是这次改动的地方">
    {layers.map((l, i) => <g key={l.id}>
      {l.focal && <g className="dd-seat" aria-hidden>
        <polygon points={pts(seatPoly)} />
        {drops.map(([x, y]) => { const [x1, y1] = I(x, y, seatZ), [x2, y2] = I(x, y, topZ); return <line key={`${x},${y}`} x1={x1} y1={y1} x2={x2} y2={y2} />; })}
      </g>}
      <g className="dd-layer" style={{ ["--collapse" as any]: `${(zEx[i] - zAs[i]).toFixed(1)}px` }}>
        {l.slabs.map((s, j) => <Box key={j} s={s} z={zEx[i]} I={I} />)}
        {l.plane?.map(p => { const top = zEx[i] + l.slabs[0].t; const [e, f] = I(0, 0, top); return <text key={p.text} className={`dd-plane ${p.cls ?? ""}`} transform={`matrix(1 .5 -1 .5 ${e.toFixed(1)} ${f.toFixed(1)})`} x={p.u} y={p.v}>{p.text}</text>; })}
      </g>
    </g>)}
    {layers.map((l, i) => { const [ax, ay] = anchors[i]; const y = ly[i]; const n = String(layers.length - i).padStart(2, "0");
      const d = Math.abs(y - ay) < .5 ? `M${(ax + 6).toFixed(1)} ${ay.toFixed(1)} H${labelX - 10}` : `M${(ax + 6).toFixed(1)} ${ay.toFixed(1)} H${labelX - 44} L${labelX - 26} ${y.toFixed(1)} H${labelX - 10}`;
      return <g key={l.id}>
      <path d={d} className="dd-leader" /><circle cx={ax + 4} cy={ay} r={2} className="dd-leader-dot" />
      <g className={`dd-label${l.focal ? " is-focal" : ""}`} transform={`translate(${labelX} ${y.toFixed(1)})`}>
        <text className="n" y={-3}>{n}</text><text className="name" x={24} y={-2}>{l.name}</text>
        {l.tag && <text className="tag" x={24 + [...l.name].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 14 : 5), 0) + 10} y={-3}>{l.tag}</text>}
        <text className="sub" x={24} y={14}>{l.sub}</text>
      </g></g>; })}
  </svg>;
}

function Delta({ interjected }: { interjected: boolean }) {
  const panel = (px: number, after: boolean) => {
    const sx = px + 296, cx = px + 214, by = 226;
    return <g>
      <text x={px + 10} y={18} className="dd-t head">{after ? "改之后" : "改之前"}</text>
      <text x={px + 70} y={18} className="dd-t mono">{after ? "variant=\"primary\" · var(--radius-input)" : "variant=\"secondary\" · 6px"}</text>
      <rect x={px + 10} y={32} width={390} height={262} rx={14} className="dd-box-flat" />
      <text x={px + 30} y={62} className="dd-t head">设置</text>
      <text x={px + 30} y={88} className="dd-t sm">名称</text><rect x={px + 30} y={94} width={350} height={32} rx={10} className="dd-box-flat" />
      <text x={px + 30} y={148} className="dd-t sm">邮箱</text><rect x={px + 30} y={154} width={350} height={32} rx={10} className="dd-box-flat" />
      <line x1={px + 10} x2={px + 400} y1={208} y2={208} className="dd-hair" />
      {after && interjected ? <text x={cx + 36} y={by + 21} textAnchor="middle" className="dd-t">取消</text>
        : <><rect x={cx} y={by} width={72} height={32} rx={after ? 10 : 6} className="dd-box-flat" /><text x={cx + 36} y={by + 21} textAnchor="middle" className="dd-t">取消</text></>}
      <rect x={sx} y={by} width={84} height={32} rx={after ? 10 : 6} className={after ? "dd-fill-accent" : "dd-box-flat"} />
      <text x={sx + 42} y={by + 21} textAnchor="middle" className={`dd-t${after ? " on-accent" : ""}`}>保存</text>
      {after ? <>
        <line x1={px + 380} x2={px + 380} y1={186} y2={by} className="dd-guide" />
        <g className="dd-mark" transform={`translate(${sx - 10} ${by - 8})`}><circle r={8} /><text y={3.5} textAnchor="middle">1</text></g>
        <g className="dd-mark" transform={`translate(${px + 392} ${206})`}><circle r={8} /><text y={3.5} textAnchor="middle">2</text></g>
        {interjected && <g className="dd-mark" transform={`translate(${cx + 8} ${by - 8})`}><circle r={8} /><text y={3.5} textAnchor="middle">3</text></g>}
        <line x1={sx + 42} x2={sx + 42} y1={by + 34} y2={304} className="dd-line" /><text x={sx + 34} y={320} textAnchor="end" className="dd-t accent">圆角 10px，和输入框对齐</text>
      </> : <><line x1={sx + 42} x2={sx + 42} y1={by + 34} y2={304} className="dd-line" /><text x={sx + 34} y={320} textAnchor="end" className="dd-t sm">圆角 6px，比输入框小一圈</text></>}
    </g>;
  };
  const rows = [
    { n: 1, what: "保存按钮的样式", was: "secondary（次要）", now: "primary（主按钮）", where: "SettingsPanel.tsx:43" },
    { n: 2, what: "按钮圆角", was: "6px", now: "var(--radius-input) = 10px", where: "button.css:14" },
    ...(interjected ? [{ n: 3, what: "取消按钮的样式", was: "secondary（次要）", now: "ghost（文字按钮）", where: "SettingsPanel.tsx:42" }] : []),
    { n: interjected ? 4 : 3, what: "新增主按钮样式", was: "没有", now: ".btn-primary：主色背景、白字、悬停变深", where: "button.css:17–21" },
  ];
  return <>
    <svg viewBox="0 0 920 332" role="img" aria-label="改动前后对照：保存按钮从次要样式改成主按钮，圆角从 6px 改成和输入框一致的 10px">
      {panel(10, false)}
      <g transform="translate(442 166)"><line x1={-14} x2={18} y1={0} y2={0} className="dd-line" /><path d="M18 -4 L26 0 L18 4 Z" className="dd-arrow" /></g>
      {panel(480, true)}
    </svg>
    <table className="dd-delta"><thead><tr><th></th><th>改了什么</th><th>原来</th><th>现在</th><th>在哪</th></tr></thead>
      <tbody>{rows.map(r => <tr key={r.n}><td className="n">{r.n}</td><td>{r.what}</td><td className="was">{r.was}</td><td>{r.now}</td><td className="mono">{r.where}</td></tr>)}</tbody></table>
  </>;
}

function Way({ flow, nFiles }: { flow?: Flow; nFiles: number }) {
  const real = (flow?.nodes ?? []).filter(n => n.status !== "planned" && n.status !== "skipped");
  const has = (f: (k: string, t: string, s: string) => boolean) => real.some(n => f(n.kind, n.title, n.status));
  const seen = new Set<string>(["ask"]);
  if (has(k => k === "read")) seen.add("read");
  if (has(k => k === "plan")) { seen.add("plan"); seen.add("q1"); }
  const gate = has((k, _t, s) => k === "gate" && s !== "skipped"); if (gate) seen.add("gate");
  const edit = has((k, t) => k === "edit" && !t.includes("快照")); if (edit) seen.add("edit");
  const check = has(k => k === "check"); if (check) { seen.add("check"); seen.add("q2"); }
  const failed = has((k, _t, s) => k === "check" && s === "failed");
  const fixed = has((k, t) => k === "edit" && t.includes("快照")); if (fixed) seen.add("fix");
  const done = has((k, _t, s) => k === "result" && s === "done"); if (done) seen.add("done");
  const nodes = [
    { id: "ask", label: "你的要求", w: 84, shape: "oval" }, { id: "read", label: "看代码", w: 76 }, { id: "plan", label: "定改法", w: 76 },
    { id: "q1", label: "改之前问我？", w: 112, shape: "diamond" }, { id: "gate", label: "等你确认", w: 84, focal: true }, { id: "edit", label: `改 ${nFiles} 个文件`, w: 92 },
    { id: "check", label: "测试 + 类型检查", w: 120 }, { id: "q2", label: "都通过？", w: 92, shape: "diamond" }, { id: "done", label: "交给你", w: 80, shape: "oval" },
  ];
  const Y = 118, NH = 40;
  const sum = nodes.reduce((a, n) => a + n.w, 0); const gap = (1080 - sum) / (nodes.length - 1);
  let x = 20; const at: Record<string, { x: number; w: number; cx: number }> = {};
  for (const n of nodes) { at[n.id] = { x, w: n.w, cx: x + n.w / 2 }; x += n.w + gap; }
  const fix = { cx: at.check.cx, y: 214, w: 84 };
  const edges: { d: string; on: boolean; label?: string; lx?: number; ly?: number }[] = [];
  const seq: [string, string, string?][] = [["ask", "read"], ["read", "plan"], ["plan", "q1"], ["q1", "gate", "是"], ["gate", "edit", "允许"], ["edit", "check"], ["check", "q2"], ["q2", "done", "是"]];
  for (const [a, b, label] of seq) {
    const on = seen.has(a) && seen.has(b) && (a !== "q2" || done) && (a !== "q1" || gate);
    const x1 = at[a].x + at[a].w, x2 = at[b].x - 2;
    edges.push({ d: `M${x1} ${Y} L${x2} ${Y}`, on, label, lx: (x1 + x2) / 2, ly: Y - 8 });
  }
  const top = Y - 56;
  edges.push({ d: `M${at.q1.cx} ${Y - 28} V${top} H${at.edit.cx} V${Y - NH / 2 - 2}`, on: !gate && edit, label: "自动模式：不问", lx: (at.q1.cx + at.edit.cx) / 2, ly: top - 6 });
  edges.push({ d: `M${at.q2.cx} ${Y + 28} V${fix.y} H${fix.cx + fix.w / 2 + 2}`, on: failed, label: "否", lx: at.q2.cx + 10, ly: fix.y - 30 });
  edges.push({ d: `M${fix.cx} ${fix.y - NH / 2} V${Y + NH / 2 + 2}`, on: fixed, label: "修好再检查", lx: fix.cx - 8, ly: (fix.y - NH / 2 + Y + NH / 2) / 2 + 4 });
  edges.push({ d: `M${at.gate.cx} ${Y + NH / 2} C${at.gate.cx} ${Y + 78} ${at.plan.cx} ${Y + 78} ${at.plan.cx} ${Y + NH / 2 + 2}`, on: has((k, _t, s) => k === "gate" && s === "skipped"), label: "换个改法", lx: (at.gate.cx + at.plan.cx) / 2, ly: Y + 70 });
  const node = (n: typeof nodes[number]) => {
    const p = at[n.id]; const on = seen.has(n.id); const cls = `dd-node${on ? "" : " is-off"}${n.focal ? " is-focal" : ""}`;
    if (n.shape === "oval") return <g key={n.id} className={cls}>{n.id === "done" && <rect x={p.x - 4} y={Y - NH / 2 - 4} width={p.w + 8} height={NH + 8} rx={(NH + 8) / 2} className="outer" />}<rect x={p.x} y={Y - NH / 2} width={p.w} height={NH} rx={NH / 2} /><text x={p.cx} y={Y + 4.5} textAnchor="middle" className="dd-t">{n.label}</text></g>;
    if (n.shape === "diamond") return <g key={n.id} className={cls}><polygon points={pts([[p.x, Y], [p.cx, Y - 28], [p.x + p.w, Y], [p.cx, Y + 28]])} /><text x={p.cx} y={Y + 4} textAnchor="middle" className="dd-t" style={{ fontSize: 11 }}>{n.label}</text></g>;
    return <g key={n.id} className={cls}><rect x={p.x} y={Y - NH / 2} width={p.w} height={NH} rx={6} /><text x={p.cx} y={Y + 4.5} textAnchor="middle" className="dd-t">{n.label}</text></g>;
  };
  return <svg viewBox="0 0 1120 262" role="img" aria-label="Jarvis 的做法流程图：看代码、定改法、需要时等你确认、改文件、跑检查，没通过就修好再检查，最后交给你">
    <defs><marker id="dd-ar" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0.8 L7 4 L0 7.2 Z" className="dd-arrow" /></marker>
      <marker id="dd-ar-off" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0.8 L7 4 L0 7.2 Z" className="dd-arrow is-off" /></marker></defs>
    {edges.map((e, i) => <g key={i}><path d={e.d} className={`dd-edge${e.on ? "" : " is-off"}`} markerEnd={`url(#${e.on ? "dd-ar" : "dd-ar-off"})`} />{e.label && <text x={e.lx} y={e.ly} textAnchor="middle" className={`dd-elabel${e.on ? " is-on" : ""}`}>{e.label}</text>}</g>)}
    {nodes.map(node)}
    <g className={`dd-node${seen.has("fix") ? "" : " is-off"}`}><rect x={fix.cx - fix.w / 2} y={fix.y - NH / 2} width={fix.w} height={NH} rx={6} /><text x={fix.cx} y={fix.y + 4.5} textAnchor="middle" className="dd-t">修好</text></g>
    <text x={20} y={250} className="dd-key">实线：这次走过的路　虚线：别的情况　双圈：终点</text>
  </svg>;
}

function Figure({ kind, interjected, flow, nFiles, exploded, figRef }: { kind: ExplainKind; interjected: boolean; flow?: Flow; nFiles: number; exploded: boolean; figRef?: React.Ref<HTMLElement> }) {
  const k = KINDS.find(x => x.value === kind)!;
  return <figure ref={figRef as any} className={`dd${kind === "layers" ? " dd-explode" : ""}${exploded ? " dd-exploded" : ""}`}>
    <h2 className="dd-title">{k.title}</h2>
    <p className="dd-lede">{k.lede}</p>
    {kind === "layers" ? <Layers interjected={interjected} /> : kind === "delta" ? <Delta interjected={interjected} /> : <Way flow={flow} nFiles={nFiles} />}
    <figcaption className="dd-cap"><span>任务：保存按钮改成主按钮样式</span><span>项目：jarvis-agent</span><span>画法：diagram-design（MIT）</span><span>示意图，不是截图</span></figcaption>
  </figure>;
}

function download(el: HTMLElement | null, title: string, kind: ExplainKind) {
  if (!el) return;
  const cs = getComputedStyle(el);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  const vars = `:root{--surface:${v("--surface")};--foreground:${v("--foreground")};--text-muted:${v("--text-muted")};--border-strong:${v("--border-strong")};--border:${v("--border")};--info:${v("--info")};--font-body:${v("--font-body")};--font-mono:${v("--font-mono")}}`;
  const body = el.outerHTML.replace(" dd-exploded", "");
  const replay = `<script>const go=()=>document.querySelectorAll('.dd-explode').forEach(e=>{e.classList.remove('dd-exploded');requestAnimationFrame(()=>requestAnimationFrame(()=>e.classList.add('dd-exploded')))});addEventListener('load',go);addEventListener('click',go);</script>`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${vars}body{margin:0;padding:40px 24px;background:var(--surface);-webkit-font-smoothing:antialiased}.dd{max-width:1040px;margin:0 auto}${EXPORT_CSS}</style></head><body>${body}${replay}</body></html>`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  // ASCII file name: some browsers drop non-ASCII download names and save as "download".
  a.download = `jarvis-explainer-${kind}.html`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function ExplainerDialog({ open, onOpenChange, kind, setKind, interjected, flow, nFiles }: { open: boolean; onOpenChange: (v: boolean) => void; kind: ExplainKind; setKind: (k: ExplainKind) => void; interjected: boolean; flow?: Flow; nFiles: number }) {
  const [exploded, setExploded] = useState(false);
  const fig = useRef<HTMLElement>(null);
  const replay = () => { setExploded(false); window.setTimeout(() => setExploded(true), 380); };
  useEffect(() => { if (!open) { setExploded(false); return; } const id = window.setTimeout(() => setExploded(true), 450); return () => window.clearTimeout(id); }, [open, kind]);
  const k = KINDS.find(x => x.value === kind)!;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="explain-dialog" title="讲解图" description="按这次的改动画的示意图。可以下载成一个 HTML 文件发给别人。">
      <div className="ex-bar">
        <SegmentedControl label="讲解图类型" value={kind} onValueChange={v => setKind(v as ExplainKind)} options={KINDS.map(x => ({ value: x.value, label: x.label }))} />
        <span className="grow" />
        {kind === "layers" && <Button size="sm" variant="ghost" onClick={replay}><RotateCcw size={14} />重新拆开</Button>}
        <Button size="sm" variant="secondary" onClick={() => download(fig.current, k.title, k.value)}><Download size={14} />下载 HTML</Button>
      </div>
      <div className="ex-paper"><Figure kind={kind} interjected={interjected} flow={flow} nFiles={nFiles} exploded={exploded} figRef={fig} /></div>
    </DialogContent>
  </Dialog>;
}

/** Thread card under the result: the artifact, with a small drawing that opens the viewer. */
export function ArtifactCard({ onOpen }: { onOpen: (k: ExplainKind) => void }) {
  const I = (x: number, y: number, z: number): P => [52 + (x - y) * .32, 36 + (x + y) / 2 * .32 - z];
  const slab = (w: number, d: number, z: number, focal?: boolean) => <Box s={{ x: -w / 2, y: -d / 2, w, d, t: 3, focal }} z={z} I={I} />;
  return <motion.section className="card artifact" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .32, ease: [.16, 1, .3, 1] }} aria-label="讲解图">
    <button type="button" className="artifact-thumb dd" onClick={() => onOpen("layers")} aria-label="打开分层拆解图">
      <svg viewBox="0 0 104 76" aria-hidden>{slab(120, 84, 0)}{slab(96, 66, 14)}{slab(64, 18, 28, true)}</svg>
    </button>
    <div className="artifact-body">
      <h3><Shapes size={14} />讲解图：这次改了什么</h3>
      <p>把设置页拆成几层，标出改在哪；再配一张改动前后和做法图。</p>
      <div className="artifact-links">{KINDS.map(x => <button key={x.value} type="button" onClick={() => onOpen(x.value)}>{x.label}<ChevronRight size={12} /></button>)}</div>
    </div>
  </motion.section>;
}
export { KINDS };
