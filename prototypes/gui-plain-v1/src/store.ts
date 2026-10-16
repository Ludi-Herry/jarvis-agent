import { useCallback, useEffect, useReducer } from "react";
import { COPY, CHECK_FAIL, CHECK_OK, CHECK_TYPES, INTERJECT, READ_STEPS, TASK_PROMPT, type Attachment, type Item, type Mode, type Phase, type Step } from "./scenario";

export type Snapshot = "empty" | "running" | "approval" | "complete" | "failed" | "interrupted";
export type OrbKind = "working" | "searching" | "solving" | "composing" | "connecting" | "breathing";

export interface S {
  phase: Phase; mode: Mode; items: Item[]; status: string | null; orb: OrbKind;
  script: string[]; cursor: number; live: boolean;
  interjected: boolean; allowAll: boolean; outcome: "done" | "failed";
  applied: boolean; reverted: boolean; pendingFiles: boolean;
  cost: number; tokens: number; startedAt: number | null; endedAt: number | null;
  seq: number;
}

const MAIN = ["ack", "read1", "read2", "read3", "plan", "gateDiscuss", "preEdit", "gateApproval", "edit1", "edit2", "editEnd", "checkStart", "checkEnd", "typesStart", "typesEnd", "finish"];
const AFTER_DISCUSS = ["preEdit", "gateApproval", "edit1", "edit2", "editEnd", "checkStart", "checkEnd", "typesStart", "typesEnd", "finish"];
const FIX = ["fixAck", "fixEdit", "fixEditEnd", "checkStart", "checkEnd", "typesStart", "typesEnd", "finish"];
const RESUME = ["resume", "checkStart", "checkEnd", "typesStart", "typesEnd", "finish"];
const FOLLOW = ["fuAck", "fuEdit", "fuEditEnd", "checkStart", "checkEnd", "finish"];

const DELAY: Record<string, number> = { ack: 650, read1: 700, read2: 650, read3: 750, plan: 900, gateDiscuss: 900, preEdit: 600, gateApproval: 500, edit1: 700, edit2: 800, editEnd: 700, checkStart: 500, checkEnd: 1700, typesStart: 300, typesEnd: 1300, finish: 600, fixAck: 700, fixEdit: 800, fixEditEnd: 900, resume: 1300, fuAck: 700, fuEdit: 800, fuEditEnd: 900 };

export const initial = (mode: Mode = "ask"): S => ({ phase: "empty", mode, items: [], status: null, orb: "breathing", script: MAIN, cursor: 0, live: false, interjected: false, allowAll: false, outcome: "done", applied: false, reverted: false, pendingFiles: false, cost: 0, tokens: 0, startedAt: null, endedAt: null, seq: 0 });

const uid = (s: S, p: string) => `${p}${s.seq + 1}`;
function push(s: S, item: Item): S { return { ...s, seq: s.seq + 1, items: [...s.items, item] }; }
function lastSteps(s: S): Extract<Item, { kind: "steps" }> | undefined { const it = s.items[s.items.length - 1]; return it?.kind === "steps" ? it : undefined; }
function addStep(s: S, step: Step): S {
  const last = lastSteps(s);
  if (last) {
    const steps = last.steps.map(x => x.status === "running" ? { ...x, status: "done" as const } : x);
    return { ...s, items: [...s.items.slice(0, -1), { ...last, steps: [...steps, step] }] };
  }
  return push(s, { kind: "steps", id: uid(s, "g"), steps: [step] });
}
function settleSteps(s: S, failId?: string): S {
  const last = lastSteps(s); if (!last) return s;
  return { ...s, items: [...s.items.slice(0, -1), { ...last, steps: last.steps.map(x => x.status === "running" ? { ...x, status: x.id === failId ? "failed" as const : "done" as const } : x) }] };
}
const spend = (s: S, c: number, t: number): S => ({ ...s, cost: +(s.cost + c).toFixed(2), tokens: s.tokens + t });
const text = (s: S, t: string, animate: boolean) => push(s, { kind: "text", id: uid(s, "x"), text: t, animate });

/** One beat of the script. `anim` is false when building a static snapshot. */
function beat(s0: S, name: string, anim: boolean): S {
  let s = s0;
  switch (name) {
    case "ack": return spend({ ...text(s, COPY.ack, anim), status: "正在看设置页的代码", orb: "searching" }, .03, 1800);
    case "read1": return spend(addStep({ ...s, status: "正在看 SettingsPanel.tsx" }, { ...READ_STEPS[0], status: "running" }), .02, 2600);
    case "read2": return spend(addStep({ ...s, status: "正在看 button.css" }, { ...READ_STEPS[1], status: "running" }), .02, 1400);
    case "read3": return spend(addStep({ ...s, status: "正在查圆角变量" }, { ...READ_STEPS[2], status: "running" }), .02, 900);
    case "plan": s = settleSteps(s); return spend({ ...text(s, COPY.plan, anim), status: "正在想怎么改", orb: "composing" }, .05, 3200);
    case "gateDiscuss":
      if (s.mode !== "discuss") return s;
      s = push(s, { kind: "notice", id: uid(s, "n"), tone: "discuss" });
      return { ...s, phase: "idle", live: false, status: null, endedAt: Date.now() };
    case "preEdit": return { ...s, status: "准备修改 2 个文件", orb: "composing" };
    case "gateApproval":
      if (s.mode !== "ask" || s.allowAll) return s;
      s = push(s, { kind: "approval", id: uid(s, "a") });
      return { ...s, phase: "approval", live: false, status: "等你确认", pendingFiles: true };
    case "edit1": return spend(addStep({ ...s, status: "正在修改 SettingsPanel.tsx", orb: "working", pendingFiles: false }, { id: "e1", type: "edit", label: "改了设置页", target: "SettingsPanel.tsx", ms: 600, status: "running" }), .04, 2100);
    case "edit2": return spend(addStep({ ...s, status: "正在修改 button.css", applied: true }, { id: "e2", type: "edit", label: "改了按钮样式", target: "button.css", ms: 500, status: "running" }), .04, 1900);
    case "editEnd": return { ...settleSteps(s), applied: true };
    case "checkStart": return spend(addStep({ ...s, status: "正在跑设置页的测试", orb: "solving" }, { ...(s.outcome === "failed" ? CHECK_FAIL : CHECK_OK), id: uid(s, "c"), status: "running" }), .01, 600);
    case "checkEnd": {
      const last = lastSteps(s); const run = last?.steps[last.steps.length - 1];
      s = settleSteps(s, s.outcome === "failed" ? run?.id : undefined);
      if (s.outcome === "failed") { const i = s.script.indexOf("typesEnd"); return { ...s, cursor: i }; }
      return s;
    }
    case "typesStart": return addStep({ ...s, status: "正在做类型检查" }, { ...CHECK_TYPES, id: uid(s, "t"), status: "running" });
    case "typesEnd": return settleSteps(s);
    case "finish": {
      const failed = s.outcome === "failed";
      s = text(s, failed ? COPY.failText : s.interjected ? COPY.doneTextInterject : COPY.doneText, anim);
      s = push(s, { kind: "result", id: uid(s, "r"), outcome: failed ? "failed" : "done" });
      return spend({ ...s, phase: failed ? "failed" : "complete", live: false, status: null, orb: "breathing", endedAt: Date.now() }, .04, 1500);
    }
    case "fixAck": return spend({ ...text(s, COPY.fixAck, anim), status: "正在更新快照", orb: "working", outcome: "done" }, .03, 1500);
    case "fixEdit": return addStep(s, { id: uid(s, "f"), type: "edit", label: "更新了测试快照", target: "SettingsPanel.test.tsx.snap", ms: 300, status: "running" });
    case "fixEditEnd": return settleSteps(s);
    case "resume": s = push(s, { kind: "notice", id: uid(s, "n"), tone: "resumed" }); return { ...s, status: "接着跑检查", orb: "solving" };
    case "fuAck": return spend({ ...text(s, "好的，我来调整。", anim), status: "正在调整", orb: "working" }, .03, 1500);
    case "fuEdit": return addStep(s, { id: uid(s, "u"), type: "edit", label: "调整了按钮样式", target: "button.css", ms: 400, status: "running" });
    case "fuEditEnd": return settleSteps(s);
  }
  return s;
}

type A =
  | { type: "beat" } | { type: "send"; text: string; attachments?: Attachment[]; project?: string } | { type: "snapshot"; snap: Snapshot }
  | { type: "mode"; mode: Mode } | { type: "allowAll"; value: boolean }
  | { type: "approve"; all: boolean } | { type: "deny" } | { type: "stop" } | { type: "continue" }
  | { type: "fix" } | { type: "resume" } | { type: "startFromDiscuss" }
  | { type: "revert"; value: boolean } | { type: "play" } | { type: "restore"; state: S };

function startRun(s: S, script: string[], phase: Phase = "running"): S { return { ...s, phase, script, cursor: 0, live: true, status: "正在想", orb: "composing", endedAt: null }; }

function reducer(s: S, a: A): S {
  switch (a.type) {
    case "beat": {
      if (!s.live || s.cursor >= s.script.length) return s;
      const name = s.script[s.cursor];
      const n = beat({ ...s, cursor: s.cursor + 1 }, name, true);
      return n;
    }
    case "send": {
      const t = a.text.trim(); const att = a.attachments?.length ? a.attachments : undefined;
      if (!t && !att) return s;
      const body = t || (att!.length > 1 ? `看看这 ${att!.length} 个附件` : "看看这个附件");
      const user = (id: string, extra?: { interject?: boolean }) => ({ kind: "user" as const, id, text: body, attachments: att, ...extra });
      if (s.phase === "empty") {
        const base = { ...initial(s.mode), allowAll: s.allowAll, startedAt: Date.now() };
        let n = push(base, user("u0"));
        // The prototype only has one script; be upfront when the typed task or project differs from it.
        if (body !== TASK_PROMPT || (a.project && a.project !== "jarvis-agent")) n = push(n, { kind: "notice", id: "n-demo", tone: "demo" });
        return startRun(n, MAIN);
      }
      if (s.phase === "approval") {
        // Typing during an approval is "要求调整": the pending request is withdrawn and Jarvis re-plans before asking again.
        const items = s.items.map(it => it.kind === "approval" && !it.resolved ? { ...it, resolved: "adjusted" as const } : it);
        let n = push({ ...s, items }, user(uid(s, "u"), { interject: true }));
        n = text(n, "收到，我按你说的改一下方案，改好再给你确认。", true);
        const at = n.script.indexOf("preEdit");
        return { ...n, interjected: true, phase: "running", live: true, pendingFiles: false, status: "正在调整方案", orb: "composing", cursor: at >= 0 ? at : n.cursor };
      }
      if (s.phase === "running") {
        let n = push(s, user(uid(s, "u"), { interject: true }));
        n = text(n, body.includes("取消") ? COPY.interjectAck : "收到，我按你说的调整。", true);
        return { ...n, interjected: true };
      }
      const n = push({ ...s, reverted: false }, user(uid(s, "u")));
      return startRun({ ...n, outcome: "done" }, FOLLOW);
    }
    case "snapshot": return snapshot(a.snap, s.mode === "discuss" ? "ask" : s.mode, s.allowAll);
    case "mode": return { ...s, mode: a.mode };
    case "allowAll": return { ...s, allowAll: a.value };
    case "approve": {
      const items = s.items.map(it => it.kind === "approval" && !it.resolved ? { ...it, resolved: a.all ? "allowed-all" as const : "allowed" as const } : it);
      return { ...s, items, allowAll: a.all || s.allowAll, phase: "running", live: true, status: "开始修改", orb: "working" };
    }
    case "deny": {
      const items = s.items.map(it => it.kind === "approval" && !it.resolved ? { ...it, resolved: "denied" as const } : it);
      const n = push({ ...s, items }, { kind: "notice", id: uid(s, "n"), tone: "denied" });
      return { ...n, phase: "idle", live: false, status: null, pendingFiles: false, endedAt: Date.now() };
    }
    case "stop": {
      if (s.phase !== "running" && s.phase !== "approval") return s;
      const items = s.items.map(it => it.kind === "approval" && !it.resolved ? { ...it, resolved: "denied" as const } : it);
      const n = settleSteps(push({ ...s, items }, { kind: "notice", id: uid(s, "n"), tone: "stopped" }));
      // A stop that lands before the approval gate is passed rewinds the cursor to it, so Continue asks again.
      const gate = s.script.indexOf("gateApproval");
      const cursor = s.phase === "approval" && gate >= 0 ? gate : s.cursor;
      return { ...n, cursor, phase: "stopped", live: false, status: null, pendingFiles: false, endedAt: Date.now() };
    }
    case "continue": return { ...s, phase: "running", live: true, status: "继续", orb: "working", endedAt: null };
    case "fix": return startRun(push({ ...s, outcome: "done" }, { kind: "user", id: uid(s, "u"), text: COPY.fixUser }), FIX);
    case "resume": return { ...s, phase: "running", script: RESUME, cursor: 0, live: true, status: "正在恢复现场", orb: "connecting", items: s.items.filter(i => !(i.kind === "notice" && i.tone === "interrupted")) };
    case "startFromDiscuss": return startRun(push({ ...s, mode: s.mode === "discuss" ? "ask" : s.mode }, { kind: "user", id: uid(s, "u"), text: "可以，动手吧" }), AFTER_DISCUSS);
    case "revert": return { ...s, reverted: a.value, items: s.items.map(it => it.kind === "result" ? { ...it, reverted: a.value } : it) };
    case "play": return { ...initial(s.mode), allowAll: false };
    case "restore": return a.state;
  }
}

/** Builds a frozen state by replaying the script instantly. */
export function snapshot(snap: Snapshot, mode: Mode, allowAll = false): S {
  let s: S = { ...initial(mode), allowAll };
  if (snap === "empty") return s;
  const m: Mode = snap === "approval" ? "ask" : mode;
  s = { ...s, mode: m, allowAll: snap === "approval" ? false : allowAll, startedAt: Date.now() - 52_000, outcome: snap === "failed" ? "failed" : "done", phase: "running", live: true };
  s = push(s, { kind: "user", id: "u0", text: TASK_PROMPT });
  const run = (until: string, opts?: { interjectAfter?: string; skipGate?: boolean }) => {
    for (const name of MAIN) {
      if (name === "gateApproval" && opts?.skipGate) {
        if (s.mode === "ask") s = push(s, { kind: "approval", id: uid(s, "a"), resolved: "allowed" });
        if (name === until) break; continue;
      }
      if (name === "gateDiscuss") continue;
      if (s.outcome === "failed" && (name === "typesStart" || name === "typesEnd")) continue;
      s = beat(s, name, false);
      if (opts?.interjectAfter === name) {
        s = push(s, { kind: "user", id: uid(s, "u"), text: INTERJECT, interject: true });
        s = { ...text(s, COPY.interjectAck, false), interjected: true };
      }
      if (name === until) break;
    }
  };
  if (snap === "running") { run("edit1", { interjectAfter: "plan", skipGate: true }); s = { ...s, live: false, cursor: MAIN.indexOf("edit1") + 1 }; return s; }
  if (snap === "approval") { run("gateApproval", { interjectAfter: "plan" }); s = { ...s, cursor: MAIN.indexOf("gateApproval") + 1 }; return s; }
  if (snap === "interrupted") {
    run("checkStart", { interjectAfter: "plan", skipGate: true });
    s = settleSteps(s);
    const last = lastSteps(s);
    if (last) s = { ...s, items: [...s.items.slice(0, -1), { ...last, steps: last.steps.slice(0, -1) }] };
    s = push(s, { kind: "notice", id: uid(s, "n"), tone: "interrupted" });
    return { ...s, phase: "interrupted", live: false, status: null, applied: true, endedAt: Date.now() };
  }
  // complete / failed
  run("finish", { interjectAfter: "plan", skipGate: true });
  return { ...s, startedAt: Date.now() - 72_000, endedAt: Date.now() };
}

export function useDemo() {
  const [s, dispatch] = useReducer(reducer, undefined, () => initial("ask"));
  useEffect(() => {
    if (!s.live || s.cursor >= s.script.length) return;
    const name = s.script[s.cursor];
    const id = window.setTimeout(() => dispatch({ type: "beat" }), DELAY[name] ?? 600);
    return () => window.clearTimeout(id);
  }, [s.live, s.cursor, s.script]);
  const act = useCallback((a: A) => dispatch(a), []);
  return [s, act] as const;
}
export type Act = ReturnType<typeof useDemo>[1];
