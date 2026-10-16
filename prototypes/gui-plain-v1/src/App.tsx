import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Wifi, WifiOff, Archive, Copy, FolderOpen, Lightbulb, Menu, MessageSquare, MoreHorizontal, PanelLeftOpen, PanelRight, PencilLine, SlidersHorizontal, Undo2, Bug, Type, Workflow } from "lucide-react";
import { useDemo, type Act, type S, type Snapshot } from "./store";
import { files, INTERJECT, PAST_TASKS, PROJECTS, TASK_PROMPT, type Attachment, type Item, type PastTask, type Project, type Step } from "./scenario";
import { Sidebar, type LiveTask, type SettingsSection, type View } from "./ui/Sidebar";
import { Thread } from "./ui/Thread";
import { PastThread, type PastFollow } from "./ui/History";
import { Composer, UnsentBar } from "./ui/Composer";
import { PAGE_LABEL, SidePanel, type PageKind, type PanelData, type PanelTab } from "./ui/SidePanel";
import { CompareOverlay, ReviewDock, type CompareMode } from "./ui/ReviewDock";
import { AddProjectDialog, AdvancedDialog, SettingsDialog, ShortcutsDialog } from "./ui/Dialogs";
import { Diffstat, IconBtn, Orb, Pop, isIme } from "./ui/Bits";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "./arc/popover/popover";
import { copyText, NotifyContext, useNotifier } from "./ui/feedback";
import { MOD, usePrefs, useSystemDark } from "./prefs";
import { Canvas, type MapMode } from "./canvas/canvas-view";
import { ThreadScroll } from "./ui/scroll-area";
import { drafts } from "./ui/drafts";
import { PanelResizer, usePanelWidth } from "./ui/PanelResizer";
import { buildFlow, buildPastFlow } from "./canvas/model";
import { ExplainerDialog, type ExplainKind, type ExplainOrigin } from "./artifact/explainer";
import "./canvas/canvas.css";

const SUGGEST = [
  { icon: SlidersHorizontal, title: "调整组件样式", text: "把设置页的「保存」按钮改成主按钮样式，圆角跟输入框一致" },
  { icon: Type, title: "把文案改清楚", text: "首页空状态的提示文字改得更友好，别用技术词" },
  { icon: Bug, title: "修一个界面问题", text: "深色模式下输入框的边框看不见，帮我修一下" },
];
const PAGE_OF: Record<string, PageKind> = { t2: "home", t3: "input-dark", t4: "export", p1: "portfolio" };
const MAX_ATTACH = 6;

function useMedia(q: string) { const [m, setM] = useState(() => window.matchMedia(q).matches); useEffect(() => { const mq = window.matchMedia(q); const f = () => setM(mq.matches); mq.addEventListener("change", f); return () => mq.removeEventListener("change", f); }, [q]); return m; }
function snapOf(phase: string): Snapshot {
  return phase === "empty" ? "empty" : phase === "running" ? "running" : phase === "approval" ? "approval" : phase === "failed" ? "failed" : phase === "interrupted" ? "interrupted" : "complete";
}
function autoTitle(s: S) {
  if (s.phase === "empty") return "新任务";
  const u = s.items.find(i => i.kind === "user");
  if (!u || u.text === TASK_PROMPT) return "保存按钮改成主按钮样式";
  return u.text.length > 18 ? `${u.text.slice(0, 18)}…` : u.text;
}
const runsOf = (items: Item[]) => items.flatMap(i => i.kind === "steps" ? i.steps.filter(x => x.type === "run") : []) as Step[];
const isOverlayOpen = () => !!document.querySelector('[role="dialog"], [data-radix-popper-content-wrapper]');

function TopTitle({ title, canEdit, editing, setEditing, onRename }: { title: string; canEdit: boolean; editing: boolean; setEditing: (v: boolean) => void; onRename: (t: string) => void }) {
  const [v, setV] = useState(title);
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (editing) setV(title); }, [editing, title]);
  useEffect(() => { if (editing) requestAnimationFrame(() => { ref.current?.focus(); ref.current?.select(); }); }, [editing]);
  const commit = () => { const x = v.trim(); if (x && x !== title) onRename(x); setEditing(false); };
  if (editing) return <input ref={ref} autoFocus className="tt-input" value={v} aria-label="任务名称" onChange={e => setV(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === "Enter" && !isIme(e)) commit(); if (e.key === "Escape") { e.stopPropagation(); setEditing(false); } }} />;
  return <span className={`tt-main${canEdit ? " is-editable" : ""}`} onDoubleClick={canEdit ? () => setEditing(true) : undefined} title={canEdit ? "双击重命名" : undefined}>{title}</span>;
}

export default function App() {
  const [s, act] = useDemo();
  const [prefs, patch] = usePrefs();
  const sysDark = useSystemDark();
  const theme: "light" | "dark" = prefs.theme === "system" ? (sysDark ? "dark" : "light") : prefs.theme;
  const { notify, node: toastNode } = useNotifier();
  const narrow = useMedia("(max-width: 820px)");
  const mid = useMedia("(max-width: 1180px)");
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelW, setPanelW] = usePanelWidth();
  const [sidebar, setSidebar] = useState(!narrow);
  const [panel, setPanel] = useState(false);
  const [tab, setTab] = useState<PanelTab>("changes");
  const [file, setFile] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => drafts.get("current"));
  const [unsent, setUnsent] = useState<{ text: string; attachments: Attachment[]; where: string } | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [focusSignal, setFocus] = useState(0);
  const [compare, setCompare] = useState<CompareMode>("new");
  const [cx, setCx] = useState(50);
  const [snap, setSnap] = useState<Snapshot>("empty");
  const [playing, setPlaying] = useState(false);
  const [view, setView] = useState<View>({ kind: "current" });
  const draftKey = view.kind === "past" ? view.id : "current";
  useEffect(() => { drafts.set(draftKey, draft); }, [draft, draftKey]);
  const [projects, setProjects] = useState<Project[]>(PROJECTS);
  const [past, setPast] = useState<PastTask[]>(PAST_TASKS);
  const [pastRev, setPastRev] = useState<Record<string, boolean>>({});
  const [follows, setFollows] = useState<Record<string, PastFollow[]>>({});
  const [curProject, setCurProject] = useState("jarvis-agent");
  const [curTitle, setCurTitle] = useState<string | null>(null);
  const [parked, setParked] = useState<LiveTask[]>([]);
  const [settings, setSettings] = useState<{ open: boolean; section: SettingsSection; focus?: string }>({ open: false, section: "general" });
  const [addOpen, setAddOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [dockSignal, setDockSignal] = useState(0);
  const [stage, setStage] = useState<"thread" | "canvas">("thread");
  const [map, setMap] = useState<MapMode>("flow");
  const [explain, setExplain] = useState<{ open: boolean; kind: ExplainKind; from?: ExplainOrigin }>({ open: false, kind: "layers" });
  const openExplain = (kind: ExplainKind = "layers", from?: ExplainOrigin) => setExplain({ open: true, kind, from });

  const curName = curTitle ?? autoTitle(s);
  const visiblePast = past.filter(t => projects.some(p => p.id === t.project));
  const pastTask = view.kind === "past" ? visiblePast.find(t => t.id === view.id) : undefined;
  const projOf = (id: string) => projects.find(p => p.id === id) ?? projects[0];
  const curProj = projOf(curProject);
  const viewProj = pastTask ? projOf(pastTask.project) : curProj;
  const busy = s.phase === "running" || s.phase === "approval";
  const live = useRef({ s, curName, curProject }); live.current = { s, curName, curProject };
  const sRef = useRef(s); sRef.current = s;

  useEffect(() => {
    const q = new URLSearchParams(location.search); const st = q.get("state") as Snapshot | null;
    if (st && st !== "empty") { act({ type: "snapshot", snap: st }); setSnap(st); } else act({ type: "mode", mode: prefs.defaultMode });
    const p = q.get("panel") as PanelTab | null; if (p) { setTab(p); setPanel(true); }
    const c = q.get("compare") as CompareMode | null; if (c) setCompare(c);
    const h = q.get("past"); if (h) setView({ kind: "past", id: h });
    const pr = q.get("project"); if (pr) setCurProject(pr);
    if (q.get("view") === "canvas") setStage("canvas");
    const m = q.get("map") as MapMode | null; if (m === "flow" || m === "state" || m === "time") setMap(m);
    const ex = q.get("explain") as ExplainKind | null; if (ex === "layers" || ex === "delta" || ex === "flow") setExplain({ open: true, kind: ex });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [act]);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { setSidebar(!narrow); }, [narrow]);
  useEffect(() => { if (s.phase !== "empty") setSnap(snapOf(s.phase)); }, [s.phase]);
  useEffect(() => { if (view.kind === "past" && !pastTask) setView({ kind: "current" }); }, [view, pastTask]);
  // P3: when a live run finishes, the preview opens by itself on wide screens (only for a local preview address).
  const prevPhase = useRef(s.phase);
  useEffect(() => {
    if (prevPhase.current === "running" && s.phase === "complete" && !mid && prefs.autoPreview && curProj.previewUrl && view.kind === "current") { setTab("preview"); setPanel(true); }
    prevPhase.current = s.phase;
  }, [s.phase, mid, prefs.autoPreview, curProj.previewUrl, view.kind]);

  const fs = files(s.interjected);
  const revertToast = (n: number, undo: () => void) => notify({ icon: <Undo2 size={15} />, text: `已撤销 ${n} 个文件的修改`, action: { label: "恢复", run: undo } });
  const actUI = useCallback<Act>(a => { act(a); if (a.type === "revert" && a.value) revertToast(files(sRef.current.interjected).length, () => act({ type: "revert", value: false })); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [act, notify]);
  const revertPast = (id: string, v: boolean) => {
    setPastRev(r => ({ ...r, [id]: v }));
    const t = past.find(x => x.id === id);
    if (v && t) revertToast(t.files.length, () => setPastRev(r => ({ ...r, [id]: false })));
  };

  const surfaceReset = () => { setPanel(false); setFile(null); setRenaming(false); };
  const closeOnNarrow = () => { if (narrow) setSidebar(false); };
  const parkCurrent = () => {
    const c = live.current;
    if (c.s.phase === "empty") return;
    const key = `k${Date.now().toString(36)}`; drafts.move("current", key);
    setParked(ps => [{ key, title: c.curName, project: c.curProject, s: c.s }, ...ps]);
  };
  const clearCurrent = () => { act({ type: "snapshot", snap: "empty" }); act({ type: "mode", mode: prefs.defaultMode }); setSnap("empty"); setCurTitle(null); };
  const startNew = (project?: string, text = "") => {
    setPlaying(false); parkCurrent(); clearCurrent();
    if (project) setCurProject(project);
    setView({ kind: "current" }); setDraft(text); setAttachments([]); surfaceReset(); setFocus(n => n + 1); closeOnNarrow();
  };
  const restore = (t: LiveTask) => {
    parkCurrent();
    act({ type: "restore", state: t.s }); setCurTitle(t.title); setCurProject(t.project); setSnap(snapOf(t.s.phase));
    const d = drafts.get(t.key); drafts.set(t.key, "");
    setView({ kind: "current" }); setDraft(d); setAttachments([]); surfaceReset();
  };
  const openLive = (key: string) => {
    setPlaying(false);
    if (key === "cur") { if (view.kind !== "current") { setView({ kind: "current" }); setDraft(drafts.get("current")); surfaceReset(); } closeOnNarrow(); return; }
    const t = parked.find(x => x.key === key); if (!t) return;
    setParked(ps => ps.filter(x => x.key !== key)); restore(t); closeOnNarrow();
  };
  const renameLive = (key: string, t: string) => { if (key === "cur") setCurTitle(t); else setParked(ps => ps.map(x => x.key === key ? { ...x, title: t } : x)); };
  const archiveLive = (key: string) => {
    if (key === "cur") {
      const saved: LiveTask = { key: "cur", title: live.current.curName, project: live.current.curProject, s: live.current.s };
      setPlaying(false); clearCurrent(); setView({ kind: "current" }); surfaceReset();
      notify({ icon: <Archive size={15} />, text: `已归档「${saved.title}」`, action: { label: "撤销", run: () => restore(saved) } });
      return;
    }
    const i = parked.findIndex(x => x.key === key); const t = parked[i]; if (!t) return;
    setParked(ps => ps.filter(x => x.key !== key));
    notify({ icon: <Archive size={15} />, text: `已归档「${t.title}」`, action: { label: "撤销", run: () => setParked(ps => [...ps.slice(0, i), t, ...ps.slice(i)]) } });
  };
  const openPast = (id: string) => { setPlaying(false); if (!(view.kind === "past" && view.id === id)) { setView({ kind: "past", id }); surfaceReset(); setDraft(drafts.get(id)); setAttachments([]); } closeOnNarrow(); };
  const renamePast = (id: string, title: string) => setPast(ps => ps.map(x => x.id === id ? { ...x, title } : x));
  const archivePast = (id: string) => {
    const i = past.findIndex(x => x.id === id); const t = past[i]; if (!t) return;
    setPast(ps => ps.filter(x => x.id !== id));
    notify({ icon: <Archive size={15} />, text: `已归档「${t.title}」`, action: { label: "撤销", run: () => setPast(ps => [...ps.slice(0, i), t, ...ps.slice(i)]) } });
  };
  const removeProject = (id: string) => {
    const p = projects.find(x => x.id === id); if (!p) return;
    if (projects.length <= 1) { notify({ tone: "info", text: "至少要留一个项目" }); return; }
    if ((curProject === id && s.phase !== "empty") || parked.some(x => x.project === id)) { notify({ tone: "info", text: `${p.name} 里还有进行中的任务，先把它归档` }); return; }
    const prev = projects;
    setProjects(ps => ps.filter(x => x.id !== id));
    if (curProject === id) setCurProject(prev.find(x => x.id !== id)!.id);
    notify({ text: `已从列表移除 ${p.name}，文件夹不会删`, action: { label: "撤销", run: () => setProjects(prev) } });
  };
  const addProject = (p: Project) => {
    setProjects(ps => [...ps, p]); setAddOpen(false);
    if (view.kind === "current" && s.phase === "empty") setCurProject(p.id);
    notify({ text: `已添加 ${p.name}` });
  };
  const openSettings = (section: SettingsSection = "general", focus?: string) => setSettings({ open: true, section, focus });
  const openPanel = (t: PanelTab) => { setTab(t); setPanel(true); };
  const openFile = (p: string) => { setFile(p); setTab("changes"); setPanel(true); };
  const pickSnap = (v: Snapshot) => { setPlaying(false); act({ type: "snapshot", snap: v }); setSnap(v); setDraft(""); setAttachments([]); setPanel(false); setFile(null); setView({ kind: "current" }); setCurTitle(null); setCurProject("jarvis-agent"); };
  const editText = (t: string) => { setDraft(t); setFocus(n => n + 1); };
  const shot = (a: Attachment) => { setAttachments(cur => cur.length >= MAX_ATTACH ? cur : [...cur, a]); setFocus(n => n + 1); if (mid) setPanel(false); notify({ text: "已把预览截图放进输入框" }); };

  // Auto demo: types the task, interjects once, approves, then hands back.
  useEffect(() => {
    if (!playing) return;
    let dead = false; const T: number[] = [];
    const wait = (ms: number) => new Promise<void>(r => T.push(window.setTimeout(r, ms)));
    const type = async (t: string) => { for (let i = 1; i <= t.length; i++) { if (dead) return; setDraft(t.slice(0, i)); await wait(38); } };
    (async () => {
      act({ type: "play" }); setPanel(false); setDraft(""); setAttachments([]); setSnap("empty"); setView({ kind: "current" }); setCurTitle(null); setCurProject("jarvis-agent");
      await wait(700); await type(TASK_PROMPT); await wait(450); if (dead) return;
      act({ type: "send", text: TASK_PROMPT }); setDraft("");
      await wait(4300); await type(INTERJECT); await wait(400); if (dead) return;
      act({ type: "send", text: INTERJECT }); setDraft("");
      for (let i = 0; i < 80 && !dead; i++) { await wait(250); if (sRef.current.phase === "approval") break; }
      if (dead) return; await wait(1900); if (sRef.current.phase === "approval") act({ type: "approve", all: false });
      for (let i = 0; i < 80 && !dead; i++) { await wait(250); if (sRef.current.phase !== "running") break; }
      setPlaying(false);
    })();
    const stop = (e: PointerEvent) => { if (!(e.target as Element).closest(".dock")) setPlaying(false); };
    window.addEventListener("pointerdown", stop, true);
    return () => { dead = true; T.forEach(clearTimeout); window.removeEventListener("pointerdown", stop, true); };
  }, [playing, act]);

  // Keyboard: the same shortcuts listed in 键盘快捷键. Single keys never fire while typing.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    if (isIme(e)) return;
    const mod = e.ctrlKey || e.metaKey; const k = e.key.toLowerCase();
    const typing = !!(e.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable='true']");
    if (e.key === "Escape") { if (view.kind === "current" && busy && !isOverlayOpen() && !playing) { e.preventDefault(); act({ type: "stop" }); } return; }
    if (document.querySelector('[role="dialog"]')) return;
    // ⌘/Ctrl Enter answers the approval card with 允许 — only when the composer is empty, so it can't swallow a message you meant to send.
    if (mod && e.key === "Enter" && view.kind === "current" && s.phase === "approval" && !draft.trim() && attachments.length === 0) { e.preventDefault(); act({ type: "approve", all: false }); return; }
    if (mod && k === "k") { e.preventDefault(); setSidebar(true); setSearchOpen(true); return; }
    if (mod && k === "b") { e.preventDefault(); setSidebar(v => !v); return; }
    if (mod && e.key === "\\") { e.preventDefault(); setPanel(v => !v); return; }
    if (mod && e.key === ",") { e.preventDefault(); openSettings(); return; }
    if (mod && k === "g") { e.preventDefault(); if (hasTask) setStage(v => v === "canvas" ? "thread" : "canvas"); return; }
    if ((mod && k === "n") || (e.altKey && e.code === "KeyN")) { e.preventDefault(); startNew(); return; }
    if (e.key === "?" && !typing && !mod) { e.preventDefault(); setKeysOpen(true); }
  };
  useEffect(() => { const h = (e: KeyboardEvent) => keys.current(e); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, []);

  const panelData: PanelData = pastTask ? {
    key: pastTask.id, files: pastTask.files, applied: pastTask.files.length > 0, pending: false, reverted: !!pastRev[pastTask.id], canRevertAll: pastTask.files.length > 0 && !pastRev[pastTask.id],
    runs: pastTask.steps.filter(x => x.type === "run"), project: viewProj, path: pastTask.previewPath, page: PAGE_OF[pastTask.id] ?? "settings", interjected: false,
    emptyNote: pastTask.outcome === "stopped" ? "这个任务在动手前就停了，没有改任何文件。" : undefined, onRevert: v => revertPast(pastTask.id, v),
  } : {
    key: `cur-${curProject}`, files: fs, applied: s.applied, pending: s.pendingFiles, reverted: s.reverted, canRevertAll: !s.pendingFiles && s.applied && !s.reverted && (s.phase === "complete" || s.phase === "failed"),
    runs: runsOf(s.items), project: curProj, path: "/settings", page: "settings", interjected: s.interjected, onRevert: v => actUI({ type: "revert", value: v }),
  };
  const shotLabel = viewProj.previewUrl ? `预览截图 · ${PAGE_LABEL[panelData.page]}` : undefined;
  const pAdd = panelData.files.reduce((a, f) => a + f.add, 0), pDel = panelData.files.reduce((a, f) => a + f.del, 0);
  const showChanges = panelData.applied && !panelData.reverted && panelData.files.length > 0;
  const title = pastTask ? pastTask.title : curName;
  const hasTask = !!pastTask || s.phase !== "empty";
  const flow = useMemo(() => pastTask ? buildPastFlow(pastTask, !!pastRev[pastTask.id]) : buildFlow(s), [pastTask, pastRev, s]);
  const onCanvas = stage === "canvas" && hasTask;
  const showFrac = !pastTask && (s.phase === "running" || s.phase === "approval");
  const hour = new Date().getHours();
  const hello = hour < 11 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";

  const copyConversation = () => {
    const lines = pastTask
      ? [`你：${pastTask.prompt}`, `Jarvis：${pastTask.reply}`, ...(follows[pastTask.id] ?? []).map(f => `你：${f.text}`)]
      : s.items.flatMap(i => i.kind === "user" ? [`你：${i.text}`] : i.kind === "text" ? [`Jarvis：${i.text}`] : i.kind === "result" ? [i.reverted ? "（改动已撤销）" : i.outcome === "failed" ? "（改完了，但检查没通过）" : "（改好了，检查都通过了）"] : []);
    copyText(`${title}\n\n${lines.join("\n\n")}`).then(ok => notify(ok ? { text: "已复制整段对话" } : { tone: "info", text: "浏览器没允许复制" }));
  };
  const common = {
    theme, mode: s.mode, onMode: (m: S["mode"]) => act({ type: "mode", mode: m }), allowAll: s.allowAll, onAllowAll: (v: boolean) => act({ type: "allowAll", value: v }),
    budget: prefs.budget, sendKey: prefs.sendKey, draft, setDraft, focusSignal, attachments, setAttachments, shotLabel, onOpenSettings: (sec: "usage" | "general") => openSettings(sec),
  };
  // Offline: keep the message instead of losing it. It waits above the composer with 重发 / 删掉.
  const holdIfOffline = (text: string) => {
    if (navigator.onLine) return false;
    setUnsent({ text, attachments, where: draftKey }); setDraft(""); setAttachments([]);
    return true;
  };
  const sendCurrent = (text: string) => { if (holdIfOffline(text)) return; act({ type: "send", text, attachments, project: curProject }); setDraft(""); setAttachments([]); };
  const sendPast = (text: string) => {
    if (!pastTask || holdIfOffline(text)) return;
    const body = text.trim() || (attachments.length > 1 ? `看看这 ${attachments.length} 个附件` : "看看这个附件");
    setFollows(f => ({ ...f, [pastTask.id]: [...(f[pastTask.id] ?? []), { id: `f${Date.now()}`, text: body, attachments: attachments.length ? attachments : undefined }] }));
    setDraft(""); setAttachments([]);
  };

  const retryUnsent = () => {
    if (!unsent) return;
    if (!navigator.onLine) { notify({ tone: "info", icon: <WifiOff size={15} />, text: "还是没连上网，连上后再点重发" }); return; }
    const u = unsent; setUnsent(null);
    if (pastTask && u.where === pastTask.id) { const body = u.text.trim() || "看看这个附件"; setFollows(f => ({ ...f, [pastTask.id]: [...(f[pastTask.id] ?? []), { id: `f${Date.now()}`, text: body, attachments: u.attachments.length ? u.attachments : undefined }] })); }
    else act({ type: "send", text: u.text, attachments: u.attachments, project: curProject });
  };
  useEffect(() => {
    if (!unsent) return;
    const on = () => notify({ tone: "info", icon: <Wifi size={15} />, text: "网络恢复了", action: { label: "重发", run: retryUnsent } });
    window.addEventListener("online", on); return () => window.removeEventListener("online", on);
  }); // re-bind every render so the retry sees the latest view
  const unsentBar = unsent && unsent.where === draftKey ? <UnsentBar text={unsent.text} n={unsent.attachments.length} onRetry={retryUnsent} onDiscard={() => setUnsent(null)} onEdit={() => { setDraft(unsent.text); setAttachments(() => unsent.attachments); setUnsent(null); setFocus(n => n + 1); }} /> : null;

  return <NotifyContext.Provider value={notify}>
  <div className={`app${sidebar ? " has-sidebar" : ""}${panel ? " has-panel" : ""}${narrow ? " is-narrow" : ""}${mid ? " is-mid" : ""}`}>
    <AnimatePresence initial={false}>
      {sidebar && <motion.div className="sidebar-shell" initial={narrow ? { x: -290 } : { opacity: 0 }} animate={narrow ? { x: 0 } : { opacity: 1 }} exit={narrow ? { x: -290 } : { opacity: 0 }} transition={{ type: "spring", visualDuration: .32, bounce: 0 }}>
        <Sidebar s={s} theme={theme} view={pastTask ? view : { kind: "current" }} projects={projects} past={visiblePast} live={[{ key: "cur", title: curName, project: curProject, s }, ...parked]}
          searchOpen={searchOpen} setSearchOpen={setSearchOpen} themePref={prefs.theme} setThemePref={t => patch({ theme: t })}
          onNew={p => startNew(p)} onCollapse={() => setSidebar(false)} onOpenLive={openLive} onOpenPast={openPast}
          onRenameLive={renameLive} onRenamePast={renamePast} onArchiveLive={archiveLive} onArchivePast={archivePast}
          onRemoveProject={removeProject} onSettings={openSettings} onAddProject={() => setAddOpen(true)} onShortcuts={() => setKeysOpen(true)} />
      </motion.div>}
    </AnimatePresence>
    {narrow && sidebar && <div className="scrim" onClick={() => setSidebar(false)} />}
    <main className="main">
      <header className="topbar">
        {!sidebar && <IconBtn label={narrow ? "打开菜单" : `展开侧栏（${MOD} B）`} onClick={() => setSidebar(true)}>{narrow ? <Menu size={17} /> : <PanelLeftOpen size={17} />}</IconBtn>}
        <div className="topbar-title">
          <TopTitle title={title} canEdit={hasTask} editing={renaming} setEditing={setRenaming} onRename={t => pastTask ? renamePast(pastTask.id, t) : setCurTitle(t)} />
          {hasTask && !narrow && !renaming && <span className="tt-crumb">{viewProj.name}</span>}
        </div>
        <span className="grow" />
        <ReviewDock snap={snap} onSnap={pickSnap} mode={compare} setMode={setCompare} theme={theme} setTheme={t => patch({ theme: t })} onPlay={() => setPlaying(p => !p)} playing={playing} openSignal={dockSignal} />
        <span className="grow" />
        {hasTask && <div className="stage-switch" role="group" aria-label="对话或画布">
          <button type="button" className={stage === "thread" ? "is-on" : undefined} aria-pressed={stage === "thread"} onClick={() => setStage("thread")} title={`对话（${MOD} G 切换）`}><MessageSquare size={14} /><span>对话</span></button>
          <button type="button" className={stage === "canvas" ? "is-on" : undefined} aria-pressed={stage === "canvas"} onClick={() => setStage("canvas")} title={`画布：整条链路和进度（${MOD} G 切换）`}><Workflow size={14} /><span>画布</span>{showFrac && <Pop as="b" value={flow.done} className="ts-frac">{flow.done}/{flow.total}</Pop>}</button>
        </div>}
        {showChanges && <button type="button" className="changes-pill" onClick={() => openPanel("changes")}><span>{panelData.files.length} 个文件</span><Diffstat add={pAdd} del={pDel} /></button>}
        {hasTask && <Popover>
          <PopoverTrigger asChild><button type="button" className="icon-btn" aria-label="这个任务的更多操作"><MoreHorizontal size={17} /></button></PopoverTrigger>
          <PopoverContent className="menu" align="end">
            <PopoverCloseItem icon={<PencilLine size={15} />} onClick={() => setRenaming(true)}>重命名</PopoverCloseItem>
            <PopoverCloseItem icon={<FolderOpen size={15} />} onClick={() => notify({ tone: "info", icon: <FolderOpen size={15} />, text: `演示稿：会在资源管理器里打开 ${viewProj.path}` })}>在文件夹中打开项目</PopoverCloseItem>
            <PopoverCloseItem icon={<Copy size={15} />} onClick={copyConversation}>复制对话</PopoverCloseItem>
            <div className="menu-sep" />
            <PopoverCloseItem icon={<SlidersHorizontal size={15} />} onClick={() => setAdvanced(true)}>范围与预算…</PopoverCloseItem>
            <PopoverCloseItem icon={<Archive size={15} />} danger onClick={() => pastTask ? archivePast(pastTask.id) : archiveLive("cur")}>归档</PopoverCloseItem>
          </PopoverContent>
        </Popover>}
        <IconBtn label={panel ? `收起面板（${MOD} \\）` : `更改 · 预览 · 终端（${MOD} \\）`} active={panel} onClick={() => setPanel(p => !p)} badge={showChanges && !panel}><PanelRight size={17} /></IconBtn>
      </header>

      {pastTask ? <>
        {onCanvas ? <Canvas key={pastTask.id} flow={flow} theme={theme} map={map} setMap={setMap} budget={prefs.budget} phase={pastTask.outcome === "stopped" ? "stopped" : "complete"} onOpenFile={openFile} onPanel={openPanel} />
        : <ThreadScroll key={pastTask.id} startAtBottom={false} pin={(follows[pastTask.id] ?? []).length}><PastThread t={pastTask} reverted={!!pastRev[pastTask.id]} onRevert={v => revertPast(pastTask.id, v)} follows={follows[pastTask.id] ?? []}
          onOpenFile={openFile} onPanel={openPanel} onEdit={editText} onRestart={text => startNew(pastTask.project, text)} /></ThreadScroll>}
        <div className="dock-composer">{unsentBar}<Composer {...common} phase="past" beam={false} cost={pastTask.cost} tokens={Math.round(pastTask.cost * 62000)} onSend={sendPast} onStop={() => {}} canStop={false} /></div>
      </> : s.phase === "empty" ? <div className="hero">
        <div className="hero-orb"><Orb state="breathing" size={64} theme={theme} /></div>
        <h1>{hello}，Ludi。今天想改点什么？</h1>
        {unsentBar}
        <Composer {...common} variant="hero" phase="empty" beam={false} cost={0} tokens={0} onSend={sendCurrent} onStop={() => {}} canStop={false}
          projects={projects} project={curProject} onProject={setCurProject} onAddProject={() => setAddOpen(true)} />
        <div className="suggest">{SUGGEST.map((x, i) => <button key={x.title} type="button" className="suggest-card is-cascade" style={{ "--i": i + 2 } as CSSProperties} onClick={() => editText(x.text)}><x.icon size={16} className="muted-ico" /><span className="sg-title">{x.title}</span><span className="sg-text">{x.text}</span></button>)}</div>
        <p className="hero-tip"><Lightbulb size={13} />想先聊聊再动手？把输入框里的「改之前问我」切成「只讨论」。</p>
      </div> : <>
        {onCanvas ? <Canvas flow={flow} theme={theme} map={map} setMap={setMap} budget={prefs.budget} act={actUI} phase={s.phase} onOpenFile={openFile} onPanel={openPanel} onExplain={(k, f) => openExplain(k ?? "layers", f)} />
        : <ThreadScroll pin={s.items.filter(i => i.kind === "user").length}><Thread s={s} act={actUI} theme={theme} onOpenFile={openFile} onPanel={openPanel} onAdjust={() => setFocus(n => n + 1)} onEdit={editText} onExplain={openExplain} /></ThreadScroll>}
        <div className="dock-composer">{unsentBar}<Composer {...common} phase={s.phase} beam={s.phase === "running"} cost={s.cost} tokens={s.tokens} onSend={sendCurrent} onStop={() => act({ type: "stop" })} canStop={busy} /></div>
      </>}
      {toastNode}
    </main>
    <AnimatePresence initial={false}>
      {panel && <motion.div ref={panelRef} className="panel-shell" initial={mid ? { x: 480 } : { opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={mid ? { x: 480 } : { opacity: 0, x: 24 }} transition={{ type: "spring", visualDuration: .34, bounce: 0 }}>
        {!mid && <PanelResizer panel={panelRef} width={panelW} setWidth={setPanelW} onCollapse={() => setPanel(false)} />}
        <SidePanel d={panelData} tab={tab} setTab={setTab} file={file} setFile={setFile} onClose={() => setPanel(false)} onShot={shot} onSetUrl={() => openSettings("projects", viewProj.id)} />
      </motion.div>}
    </AnimatePresence>
    {mid && panel && <div className="scrim" onClick={() => setPanel(false)} />}

    <SettingsDialog open={settings.open} onOpenChange={v => setSettings(x => ({ ...x, open: v }))} section={settings.section} setSection={sec => setSettings(x => ({ ...x, section: sec, focus: undefined }))} focusProject={settings.focus}
      prefs={prefs} patch={patch} themePref={prefs.theme} setThemePref={t => patch({ theme: t })} projects={projects}
      onPreviewUrl={(id, url) => setProjects(ps => ps.map(p => p.id === id ? { ...p, previewUrl: url } : p))} onRemoveProject={removeProject}
      onAddProject={() => { setSettings(x => ({ ...x, open: false })); setAddOpen(true); }} onOpenDock={() => setDockSignal(n => n + 1)} />
    <AddProjectDialog open={addOpen} onOpenChange={setAddOpen} projects={projects} onAdd={addProject} />
    <ShortcutsDialog open={keysOpen} onOpenChange={setKeysOpen} />
    <ExplainerDialog origin={explain.from} open={explain.open} onOpenChange={v => setExplain(x => ({ ...x, open: v }))} kind={explain.kind} setKind={k => setExplain(x => ({ ...x, kind: k }))} interjected={s.interjected} flow={pastTask ? undefined : flow} nFiles={files(s.interjected).length} />
    <AdvancedDialog open={advanced} onOpenChange={setAdvanced} project={viewProj} budget={prefs.budget} onEditPreview={() => { setAdvanced(false); openSettings("projects", viewProj.id); }} />

    <CompareOverlay mode={compare} snap={snap} x={cx} onX={setCx} />
  </div>
  </NotifyContext.Provider>;
}

/** A menu row that closes its popover before acting. */
function PopoverCloseItem({ icon, children, onClick, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return <PopoverClose asChild><button className={`menu-item${danger ? " is-danger" : ""}`} onClick={onClick}>{icon}{children}</button></PopoverClose>;
}
