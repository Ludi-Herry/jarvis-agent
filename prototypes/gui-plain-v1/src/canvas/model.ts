// Turns the scripted conversation into one flow: nodes on four lanes, todos and their progress, a lifecycle, and illustrative timing/cost.
// Shapes follow archify (workflow lanes, lifecycle, waterfall) but every label is plain Chinese for a non-programmer reader.
import { AFTER_DISCUSS, RESUME, type S } from "../store";
import { COPY, files, type FileChange, type Item, type PastTask, type Step } from "../scenario";

export type Lane = "you" | "jarvis" | "files" | "checks";
export const LANES: { id: Lane; label: string; hint: string }[] = [
  { id: "you", label: "你", hint: "要求、补充、确认" },
  { id: "jarvis", label: "Jarvis", hint: "看代码、想改法、交结果" },
  { id: "files", label: "项目文件", hint: "真正改动的地方" },
  { id: "checks", label: "检查", hint: "测试和类型检查" },
];
export type Stage = "understand" | "plan" | "confirm" | "edit" | "check" | "deliver";
export const STAGES: Record<Stage, { n: number; label: string }> = {
  understand: { n: 1, label: "理解" }, plan: { n: 2, label: "方案" }, confirm: { n: 3, label: "确认" },
  edit: { n: 4, label: "修改" }, check: { n: 5, label: "检查" }, deliver: { n: 6, label: "交付" },
};
export type NStatus = "done" | "running" | "waiting" | "failed" | "planned" | "skipped" | "stopped";
export const STATUS_LABEL: Record<NStatus, string> = { done: "完成", running: "进行中", waiting: "等你", failed: "没通过", planned: "待做", skipped: "跳过", stopped: "停了" };
export type NKind = "ask" | "interject" | "read" | "plan" | "gate" | "edit" | "check" | "result" | "notice" | "think";

export interface Part { id: string; type: Step["type"]; label: string; target?: string; status: "running" | "done" | "failed"; ms: number }
export interface FlowNode {
  id: string; kind: NKind; lane: Lane; stage: Stage; status: NStatus; title: string; sub?: string;
  quote?: string; detail?: string; parts?: Part[]; output?: string[]; tag?: string; final?: boolean; suggestion?: boolean;
  outcome?: "done" | "failed" | "reverted"; notice?: string; ms: number; cost: number; round: number;
}
export interface FlowEdge { id: string; from: string; to: string; label?: string; tone: "done" | "live" | "planned" | "fail" }
export interface Todo { id: string; label: string; status: NStatus; node?: string; tag?: string; note?: string }
export type LifeKey = "queued" | "understand" | "plan" | "gate" | "edit" | "check" | "deliver" | "discuss" | "failed" | "stopped" | "interrupted" | "reverted";
export interface Flow {
  nodes: FlowNode[]; edges: FlowEdge[]; todos: Todo[]; done: number; total: number; focus?: string;
  cost: number; tokens: number; elapsedMs: number | null; startedAt: number | null; live: boolean;
  fileList: FileChange[]; planFiles: FileChange[]; add: number; del: number; checks: { pass: number; fail: number; skipped: number; tests: string };
  stageCost: { key: Stage; label: string; value: number }[];
  life: { visits: Partial<Record<LifeKey, number>>; current: LifeKey; path: [LifeKey, LifeKey][] };
}

const strip = (label: string) => label.replace(/^(跑了|做了|看了|查了|改了|更新了|调整了)/, "").replace(/^构建了一遍$/, "构建一遍");
const verb = (label: string) => label.replace(/了/, "");
const clsOf = (t: Step["type"]) => t === "edit" ? "edit" : t === "run" ? "run" : "read";
function summarize(parts: Part[]) {
  const c = (t: Step["type"]) => parts.filter(p => p.type === t).length;
  return [c("read") && `看了 ${c("read")} 个文件`, c("search") && `查了 ${c("search")} 处`].filter(Boolean).join(" · ");
}
const stepStatus = (parts: Part[]): NStatus => parts.some(p => p.status === "running") ? "running" : parts.some(p => p.status === "failed") ? "failed" : "done";

/** Script beat → the kind of node it will produce, so remaining beats can be drawn as planned nodes. */
const BEAT_KEY: Record<string, string> = { ack: "read", read1: "read", read2: "read", read3: "read", plan: "plan", preEdit: "plan", gateApproval: "gate", edit1: "edit", edit2: "edit", checkStart: "check", typesStart: "types", finish: "finish", fixAck: "fix", fixEdit: "fix", resume: "resume", fuAck: "fu", fuEdit: "fu" };
const KEY_STAGE: Record<string, Stage> = { read: "understand", plan: "plan", gate: "confirm", edit: "edit", fix: "edit", fu: "edit", check: "check", types: "check", resume: "check", finish: "deliver" };

class Builder {
  nodes: FlowNode[] = []; round = 0; stage: Stage = "understand"; pending?: string;
  add(n: Omit<FlowNode, "id" | "round" | "ms" | "cost"> & Partial<Pick<FlowNode, "ms" | "cost">>) {
    const node: FlowNode = { ms: 0, cost: 0, ...n, id: `${n.kind}-${this.nodes.length}`, round: this.round };
    if (this.pending && (node.lane === "jarvis" || node.lane === "files") && !node.detail) { node.detail = this.pending; this.pending = undefined; }
    this.nodes.push(node); this.stage = node.stage; return node;
  }
  last() { return this.nodes[this.nodes.length - 1]; }
  steps(steps: Step[], liveStatus?: string | null) {
    let i = 0;
    while (i < steps.length) {
      const c = clsOf(steps[i].type);
      if (c === "run") {
        const st = steps[i++];
        const status: NStatus = st.status === "running" ? "running" : st.status === "failed" ? "failed" : "done";
        this.add({ kind: "check", lane: "checks", stage: "check", status, title: strip(st.label), sub: status === "failed" ? "1 项没通过" : st.target, output: st.output, ms: st.ms, cost: st.label.includes("类型") ? 0 : .01,
          parts: [{ id: st.id, type: st.type, label: st.label, target: st.target, status: st.status, ms: st.ms }] });
        continue;
      }
      const group: Part[] = [];
      while (i < steps.length && clsOf(steps[i].type) === c) { const st = steps[i++]; group.push({ id: st.id, type: st.type, label: st.label, target: st.target, status: st.status, ms: st.ms }); }
      const status = stepStatus(group);
      const ms = group.reduce((a, p) => a + p.ms, 0);
      if (c === "read") this.add({ kind: "read", lane: "jarvis", stage: "understand", status, title: "看代码", sub: status === "running" && liveStatus ? liveStatus : summarize(group), parts: group, ms: ms + 650, cost: .03 + .02 * group.length });
      else {
        const names = group.map(p => p.target ?? "").filter(Boolean);
        this.add({ kind: "edit", lane: "files", stage: "edit", status, title: group.length > 1 ? `改 ${group.length} 个文件` : verb(group[0].label), sub: status === "running" && liveStatus ? liveStatus : names.join(" · "), parts: group, ms, cost: .04 * group.length + (this.round > 0 ? .03 : 0) });
      }
    }
  }
}

function planned(key: string, s: S | null, stopped: boolean): Omit<FlowNode, "id" | "round"> | null {
  const sub = stopped ? "继续后会做" : undefined;
  const base = { status: "planned" as NStatus, ms: 0, cost: 0, stage: KEY_STAGE[key] };
  switch (key) {
    case "read": return { ...base, kind: "read", lane: "jarvis", title: "看代码", sub: sub ?? "设置页和按钮样式" };
    case "plan": return { ...base, kind: "plan", lane: "jarvis", title: "定改法", sub };
    case "gate": return { ...base, kind: "gate", lane: "you", title: "等你确认", sub: sub ?? "改文件前先问你" };
    case "edit": return { ...base, kind: "edit", lane: "files", title: `改 ${files(!!s?.interjected).length} 个文件`, sub: sub ?? "SettingsPanel.tsx · button.css" };
    case "fix": return { ...base, kind: "edit", lane: "files", title: "更新测试快照", sub: sub ?? "SettingsPanel.test.tsx.snap" };
    case "fu": return { ...base, kind: "edit", lane: "files", title: "按你说的调整", sub: sub ?? "button.css" };
    case "check": return { ...base, kind: "check", lane: "checks", title: "设置页的测试", sub: sub ?? "npm test -- settings" };
    case "types": return { ...base, kind: "check", lane: "checks", title: "类型检查", sub: sub ?? "npx tsc --noEmit" };
    case "resume": return { ...base, kind: "think", lane: "jarvis", title: "恢复现场", sub: sub ?? "核对已改的文件还在" };
    case "finish": return { ...base, kind: "result", lane: "jarvis", title: "交给你看结果", sub: sub ?? "改了什么、检查过没有", final: true };
  }
  return null;
}
const keyOfNode = (n: FlowNode) => n.kind === "read" ? "read" : n.kind === "plan" ? "plan" : n.kind === "gate" ? "gate" : n.kind === "check" ? (n.title.includes("类型") ? "types" : "check")
  : n.kind === "edit" ? (n.title.includes("快照") ? "fix" : n.round > 0 ? "fu" : "edit") : n.kind === "result" ? "finish" : n.kind === "think" ? n.title : n.kind;

function edgesFor(nodes: FlowNode[]): FlowEdge[] {
  const out: FlowEdge[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1], b = nodes[i];
    let label: string | undefined;
    if (b.kind === "interject") label = b.tag === "要求调整" ? "换改法" : "插话";
    else if (a.kind === "gate" && a.status === "done") label = "允许";
    else if (b.kind === "gate" && a.kind !== "gate") label = "要改文件";
    else if (a.kind === "edit" && b.kind === "check") label = "改完自动检查";
    else if (a.kind === "check" && a.status === "failed") label = "1 项没通过";
    else if (b.suggestion && b.kind === "edit") label = "让 Jarvis 修好";
    else if (a.kind === "result" && b.kind === "ask") label = "接着说";
    const tone: FlowEdge["tone"] = b.status === "planned" || b.status === "skipped" ? (b.suggestion ? "fail" : "planned") : b.status === "running" || b.status === "waiting" ? "live" : a.status === "failed" ? "fail" : "done";
    out.push({ id: `${a.id}>${b.id}`, from: a.id, to: b.id, label, tone });
  }
  return out;
}

function lifeOf(nodes: FlowNode[], phase: string, reverted: boolean): Flow["life"] {
  const visits: Partial<Record<LifeKey, number>> = { queued: 1 };
  const seq: LifeKey[] = ["queued"];
  const keyOf = (n: FlowNode): LifeKey | null => n.status === "planned" ? null
    : n.kind === "read" ? "understand" : n.kind === "plan" ? "plan" : n.kind === "gate" ? (n.status === "stopped" ? "stopped" : "gate")
    : n.kind === "edit" ? "edit" : n.kind === "check" ? (n.status === "skipped" ? null : "check") : n.kind === "result" ? (n.outcome === "failed" ? "failed" : "deliver")
    : n.kind === "notice" ? (n.notice === "stopped" ? "stopped" : n.notice === "interrupted" ? "interrupted" : n.notice === "discuss" ? "discuss" : null)
    : n.kind === "think" ? (n.title === "恢复现场" ? "check" : null) : null;
  let lastGate: FlowNode | null = null;
  for (const n of nodes) {
    const k = keyOf(n); if (!k) continue;
    // Asking again after "换个改法" is a loop on the gate, not the same visit.
    const again = k === "gate" && lastGate?.status === "skipped" && n !== lastGate;
    if (n.kind === "gate") lastGate = n;
    if (seq[seq.length - 1] !== k || again) { seq.push(k); visits[k] = (visits[k] ?? 0) + 1; }
  }
  if (reverted) { seq.push("reverted"); visits.reverted = 1; }
  const path: [LifeKey, LifeKey][] = [];
  for (let i = 1; i < seq.length; i++) path.push([seq[i - 1], seq[i]]);
  const running = nodes.find(n => n.status === "running");
  const current: LifeKey = phase === "approval" ? "gate" : phase === "failed" ? "failed" : phase === "interrupted" ? "interrupted" : phase === "stopped" ? "stopped"
    : phase === "idle" ? (seq[seq.length - 1] ?? "plan") : phase === "complete" ? (reverted ? "reverted" : "deliver")
    : running ? (keyOf(running) ?? KEY_LIFE[running.stage]) : seq[seq.length - 1];
  return { visits, current, path };
}
const KEY_LIFE: Record<Stage, LifeKey> = { understand: "understand", plan: "plan", confirm: "gate", edit: "edit", check: "check", deliver: "deliver" };

function finishFlow(b: Builder, extra: { s: S | null; todos: Todo[]; cost: number; tokens: number; startedAt: number | null; endedAt: number | null; live: boolean; fileList: FileChange[]; planFiles: FileChange[]; phase: string; reverted: boolean; now: number }): Flow {
  const nodes = b.nodes;
  // Spread the real total over the nodes by their illustrative weights, so the charts add up to what the composer shows.
  const w = nodes.reduce((a, n) => a + n.cost, 0);
  if (w > 0 && extra.cost > 0) for (const n of nodes) n.cost = +(n.cost / w * extra.cost).toFixed(3);
  const stageCost = (Object.keys(STAGES) as Stage[]).map(k => ({ key: k, label: STAGES[k].label, value: +nodes.filter(n => n.stage === k).reduce((a, n) => a + n.cost, 0).toFixed(2) })).filter(x => x.value > 0);
  const checks = nodes.filter(n => n.kind === "check" && n.status !== "planned");
  const lastBy = (t: string) => [...checks].reverse().find(n => n.title === t);
  const titles = [...new Set(checks.map(n => n.title))];
  const latest = titles.map(lastBy).filter(Boolean) as FlowNode[];
  const tests = latest.map(n => n.output?.find(l => /^Tests:/.test(l))).filter(Boolean).pop() ?? "";
  const done = extra.todos.filter(t => t.status === "done" || t.status === "skipped").length;
  const focus = nodes.find(n => n.status === "running" || n.status === "waiting")?.id ?? [...nodes].reverse().find(n => n.status !== "planned")?.id;
  return {
    nodes, edges: edgesFor(nodes), todos: extra.todos, done, total: extra.todos.length, focus,
    cost: extra.cost, tokens: extra.tokens, startedAt: extra.startedAt, live: extra.live,
    elapsedMs: extra.startedAt != null ? (extra.endedAt ?? extra.now) - extra.startedAt : null,
    fileList: extra.fileList, planFiles: extra.planFiles, add: extra.fileList.reduce((a, f) => a + f.add, 0), del: extra.fileList.reduce((a, f) => a + f.del, 0),
    checks: { pass: latest.filter(n => n.status === "done").length, fail: latest.filter(n => n.status === "failed").length, skipped: latest.filter(n => n.status === "skipped").length, tests },
    stageCost, life: lifeOf(nodes, extra.phase, extra.reverted),
  };
}

/** The live (or snapshot) task. */
export function buildFlow(s: S, now = Date.now()): Flow {
  const b = new Builder();
  const items = s.items;
  items.forEach((it: Item, idx) => {
    switch (it.kind) {
      case "user": {
        if (!b.nodes.length) { b.add({ kind: "ask", lane: "you", stage: "understand", status: "done", title: "你提了要求", quote: it.text, sub: it.text, ms: 300 }); break; }
        if (it.interject) {
          const adjust = items[idx - 1]?.kind === "approval";
          b.add({ kind: "interject", lane: "you", stage: b.stage, status: "done", title: adjust ? "你要求换个改法" : "你补充了一句", quote: it.text, sub: it.text, tag: adjust ? "要求调整" : "运行中补充", ms: 0 });
          break;
        }
        b.round++;
        const title = it.text === COPY.fixUser ? "你让 Jarvis 修好" : it.text === "可以，动手吧" ? "你说可以动手" : "你接着说";
        b.add({ kind: "ask", lane: "you", stage: it.text === "可以，动手吧" ? "confirm" : "understand", status: "done", title, quote: it.text, sub: it.text, ms: 300 });
        break;
      }
      case "text": {
        const prev = b.last();
        if (it.text === COPY.plan) b.add({ kind: "plan", lane: "jarvis", stage: "plan", status: "done", title: "定改法", sub: "保存换主按钮 · 圆角用输入框的变量", detail: it.text, ms: 900, cost: .05 });
        else if (prev?.kind === "interject" && !prev.detail) prev.detail = it.text;
        else if (items[idx + 1]?.kind === "result") b.pending = it.text;
        else b.pending = b.pending ? `${b.pending}\n${it.text}` : it.text;
        break;
      }
      case "steps": b.steps(it.steps, s.phase === "running" ? s.status : null); break;
      case "approval": {
        const r = it.resolved;
        const status: NStatus = !r ? (s.phase === "approval" ? "waiting" : "stopped") : r === "denied" ? "stopped" : r === "adjusted" ? "skipped" : "done";
        const n = files(s.interjected).length;
        b.add({ kind: "gate", lane: "you", stage: "confirm", status, title: !r ? (status === "waiting" ? "等你确认" : "没等到确认") : r === "allowed-all" ? "你允许了，不再问" : r === "allowed" ? "你允许了" : r === "denied" ? "你没允许" : "这一版没改",
          sub: r === "adjusted" ? "你要求换个改法" : `要改 ${n} 个文件`, ms: r ? 1900 : 0 });
        break;
      }
      case "result": {
        const outcome = it.reverted ? "reverted" : it.outcome;
        const fs = files(s.interjected);
        b.add({ kind: "result", lane: "jarvis", stage: "deliver", status: it.outcome === "failed" && !it.reverted ? "failed" : "done", final: true, outcome,
          title: it.reverted ? "已撤销" : it.outcome === "failed" ? "检查没通过" : "改好了", sub: it.reverted ? `${fs.length} 个文件已恢复` : it.outcome === "failed" ? "快照里还是旧按钮" : `${fs.length} 个文件 · 检查都通过了`,
          detail: b.pending, ms: 600, cost: .04 });
        b.pending = undefined;
        break;
      }
      case "notice": {
        if (it.tone === "demo" || it.tone === "denied") break;
        if (it.tone === "stopped") b.add({ kind: "notice", notice: "stopped", lane: "you", stage: b.stage, status: "stopped", title: "你停止了任务", sub: s.applied ? "已改的文件都保留着" : "还没改任何文件" });
        else if (it.tone === "interrupted") b.add({ kind: "notice", notice: "interrupted", lane: "jarvis", stage: "check", status: s.phase === "interrupted" ? "waiting" : "done", title: "上次没做完", sub: "停在跑检查这一步" });
        else if (it.tone === "resumed") b.add({ kind: "think", lane: "jarvis", stage: "check", status: "done", title: "恢复现场", sub: "已改的 2 个文件都在", ms: 1300 });
        else if (it.tone === "discuss") b.add({ kind: "notice", notice: "discuss", lane: "jarvis", stage: "plan", status: s.phase === "idle" ? "waiting" : "done", title: "只讨论，没动手", sub: "等你说要不要改" });
        break;
      }
    }
  });

  // Failed checks stop the rest of the checks; say so instead of leaving a gap.
  const failedCheck = b.nodes.some(n => n.kind === "check" && n.status === "failed") && b.nodes[b.nodes.length - 1]?.kind !== "check";
  if (failedCheck && s.outcome === "failed" && !b.nodes.some(n => n.title === "类型检查")) {
    const at = b.nodes.findIndex(n => n.kind === "check" && n.status === "failed");
    const skip: FlowNode = { id: `check-skip`, kind: "check", lane: "checks", stage: "check", status: "skipped", title: "类型检查", sub: "测试先没通过，这次没跑", ms: 0, cost: 0, round: b.nodes[at].round };
    b.nodes.splice(at + 1, 0, skip);
  }

  // Nothing is running between two beats: show what Jarvis is doing right now.
  const running = s.phase === "running" && !b.nodes.some(n => n.status === "running");
  let rest: string[] = [];
  if (s.phase === "running" || s.phase === "approval" || s.phase === "stopped") rest = s.script.slice(s.cursor);
  else if (s.phase === "interrupted") rest = RESUME;
  else if (s.phase === "idle" && b.nodes.some(n => n.notice === "discuss")) rest = AFTER_DISCUSS;
  let liveKey: string | undefined;
  if (running) {
    liveKey = rest.map(k => BEAT_KEY[k]).find(Boolean);
    b.add({ kind: "think", lane: "jarvis", stage: liveKey ? KEY_STAGE[liveKey] : b.stage, status: "running", title: s.status ?? "正在想", sub: "Jarvis 正在做", ms: 700 });
  }
  const seen = new Set<string>(b.nodes.filter(n => n.status === "running").map(keyOfNode));
  if (liveKey) seen.add(liveKey);
  const gateOff = s.mode === "auto" || s.allowAll;
  for (const beat of rest) {
    const k = BEAT_KEY[beat]; if (!k || seen.has(k)) continue;
    if (k === "gate" && (gateOff && s.phase !== "idle")) continue;
    if (s.outcome === "failed" && k === "types" && b.nodes.some(n => n.kind === "check" && n.status === "failed")) continue;
    seen.add(k);
    const p = planned(k, s, s.phase === "stopped"); if (p) b.add(p);
  }
  if (s.phase === "failed") {
    b.add({ kind: "edit", lane: "files", stage: "edit", status: "planned", suggestion: true, title: "更新测试快照", sub: "建议：这是预期内的变化" });
    b.add({ kind: "check", lane: "checks", stage: "check", status: "planned", title: "再跑一遍检查", sub: "测试 + 类型检查" });
  }

  return finishFlow(b, { s, todos: todosFor(s, b.nodes), cost: s.cost, tokens: s.tokens, startedAt: s.startedAt, endedAt: s.endedAt, live: s.phase === "running", fileList: s.applied && !s.reverted ? files(s.interjected) : [], planFiles: files(s.interjected), phase: s.phase, reverted: s.reverted, now });
}

/** Requirement-level todos for the one scripted task; each follows the node that does it. */
function todosFor(s: S, nodes: FlowNode[]): Todo[] {
  const real = nodes.filter(n => n.status !== "planned");
  const pick = (f: (n: FlowNode) => boolean) => [...real].reverse().find(f);
  const plan = (f: (n: FlowNode) => boolean) => nodes.find(n => n.status === "planned" && f(n));
  const st = (n?: FlowNode, fallback: NStatus = "planned"): NStatus => n ? n.status : fallback;
  const part = (target: string) => {
    const n = [...real].reverse().find(x => x.kind === "edit" && x.round === 0 && x.parts?.some(p => p.target === target));
    const p = n?.parts?.find(x => x.target === target);
    return { node: n?.id ?? plan(x => x.kind === "edit")?.id, status: (p ? p.status : "planned") as NStatus };
  };
  const out: Todo[] = [];
  const read = pick(n => n.kind === "read") ?? plan(n => n.kind === "read");
  out.push({ id: "t-read", label: "看懂现在的写法", status: st(read), node: read?.id });
  const pl = pick(n => n.kind === "plan") ?? plan(n => n.kind === "plan");
  out.push({ id: "t-plan", label: "定改法", status: st(pl), node: pl?.id });
  const gate = pick(n => n.kind === "gate") ?? plan(n => n.kind === "gate");
  const discuss = nodes.some(n => n.notice === "discuss") && s.phase === "idle";
  if (gate) out.push({ id: "t-gate", label: "等你确认", status: gate.status === "skipped" ? "planned" : gate.status, node: gate.id, note: gate.status === "stopped" ? "你没允许，这次没改" : undefined });
  else out.push({ id: "t-gate", label: "等你确认", status: discuss ? "planned" : "skipped", note: discuss ? "只讨论模式，先不改" : s.mode === "auto" ? "自动模式，不用确认" : "这个任务都允许了" });
  const a = part("SettingsPanel.tsx"), c = part("button.css");
  out.push({ id: "t-save", label: "保存按钮换成主按钮", status: a.status, node: a.node });
  out.push({ id: "t-radius", label: "圆角跟输入框一致（10px）", status: c.status, node: c.node });
  if (s.interjected) out.push({ id: "t-cancel", label: "取消按钮改成文字按钮", status: a.status, node: a.node, tag: "你补充的" });
  const test = pick(n => n.kind === "check" && n.title.includes("设置页")) ?? plan(n => n.kind === "check" && !n.title.includes("类型"));
  out.push({ id: "t-test", label: "跑设置页的测试", status: st(test), node: test?.id, note: test?.status === "failed" ? "快照还是旧按钮" : undefined });
  const fix = pick(n => n.kind === "edit" && n.title.includes("快照")) ?? nodes.find(n => n.suggestion);
  if (fix) out.push({ id: "t-fix", label: "更新测试快照", status: fix.status, node: fix.id, tag: fix.suggestion ? "建议" : "你让修的" });
  const types = pick(n => n.title === "类型检查") ?? plan(n => n.title === "类型检查");
  out.push({ id: "t-types", label: "类型检查", status: st(types), node: types?.id, note: types?.status === "skipped" ? "测试先没通过" : undefined });
  const fu = pick(n => n.kind === "edit" && n.round > 0 && !n.title.includes("快照")) ?? plan(n => n.kind === "edit" && n.title === "按你说的调整");
  if (fu) out.push({ id: "t-fu", label: "按你说的调整", status: fu.status, node: fu.id, tag: "你接着说的" });
  const res = pick(n => n.kind === "result") ?? plan(n => n.kind === "result");
  out.push({ id: "t-result", label: "交给你看结果", status: res ? (res.outcome === "reverted" ? "done" : res.status) : "planned", node: res?.id, note: res?.outcome === "reverted" ? "已撤销" : res?.status === "failed" ? "改完了，检查没通过" : undefined });
  if (s.phase === "stopped" || s.phase === "idle") for (const t of out) if (t.status === "running") t.status = "stopped";
  return out;
}

/** An earlier task, rebuilt from its record. */
export function buildPastFlow(t: PastTask, reverted: boolean): Flow {
  const b = new Builder();
  b.add({ kind: "ask", lane: "you", stage: "understand", status: "done", title: "你提了要求", quote: t.prompt, sub: t.prompt, ms: 300 });
  b.pending = "好的，我先看看现在是怎么写的。";
  b.steps(t.steps);
  const stopped = t.outcome === "stopped";
  if (stopped) {
    b.add({ kind: "plan", lane: "jarvis", stage: "plan", status: "done", title: "找到原因", sub: "打算只在选了白色背景时才填充", detail: t.reply, ms: 900, cost: .02 });
    b.add({ kind: "notice", notice: "stopped", lane: "you", stage: "plan", status: "stopped", title: "你停止了任务", sub: "还没改任何文件" });
  } else b.add({ kind: "result", lane: "jarvis", stage: "deliver", status: "done", final: true, outcome: reverted ? "reverted" : "done", title: reverted ? "已撤销" : "改好了",
    sub: reverted ? `${t.files.length} 个文件已恢复` : `${t.files.length} 个文件 · 检查都通过了`, detail: t.reply, ms: 600, cost: .04 });
  const todos: Todo[] = [];
  const read = b.nodes.find(n => n.kind === "read");
  todos.push({ id: "p-read", label: "看懂现在的写法", status: read ? "done" : "skipped", node: read?.id });
  for (const n of b.nodes.filter(x => x.kind === "edit")) for (const p of n.parts ?? []) todos.push({ id: `p-${p.id}`, label: `${verb(p.label)}（${p.target}）`, status: "done", node: n.id });
  if (stopped) todos.push({ id: "p-fix", label: "改导出逻辑", status: "stopped", note: "你在动手前停了" });
  for (const n of b.nodes.filter(x => x.kind === "check")) todos.push({ id: `p-${n.id}`, label: n.title, status: n.status, node: n.id });
  const res = b.nodes.find(n => n.kind === "result");
  todos.push({ id: "p-result", label: "交给你看结果", status: res ? "done" : "stopped", node: res?.id, note: reverted ? "已撤销" : undefined });
  const ms = (t.elapsed.match(/(\d+) 分/)?.[1] ? +t.elapsed.match(/(\d+) 分/)![1] * 60 : 0) + +(t.elapsed.match(/(\d+) 秒/)?.[1] ?? 0);
  return finishFlow(b, { s: null, todos, cost: t.cost, tokens: Math.round(t.cost * 62000), startedAt: 0, endedAt: ms * 1000, live: false, fileList: reverted ? [] : t.files, planFiles: t.files, phase: stopped ? "stopped" : reverted ? "complete" : "complete", reverted, now: 0 });
}
