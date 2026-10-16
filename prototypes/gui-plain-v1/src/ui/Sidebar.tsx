import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as RKeyboardEvent, type ReactNode } from "react";
import { buildFlow } from "../canvas/model";
import { AnimatePresence, motion } from "motion/react";
import { Archive, BookOpen, ChevronDown, ChevronRight, Copy, Folder, FolderOpen, FolderPlus, Globe, Keyboard, MoreHorizontal, PanelLeftClose, PencilLine, Plus, Search, Settings, SquarePen, Trash2, X, Monitor } from "lucide-react";
import type { S } from "../store";
import type { PastTask, Project } from "../scenario";
import type { ThemePref } from "../prefs";
import { MOD } from "../prefs";
import { Popover, PopoverContent, PopoverTrigger } from "../arc/popover/popover";
import SegmentedControl from "../arc/segmented-control/segmented-control";
import { Diffstat, IconBtn, Orb, Pop, arrowNav, isIme } from "./Bits";
import { copyText, useNotify } from "./feedback";
import { FadeScroll } from "./scroll-area";
import { useSortable, useTaskOrder } from "./sortable";

export type View = { kind: "current" } | { kind: "past"; id: string };
type Filter = "all" | "running" | "attention" | "done";
const FILTERS: { value: Filter; label: string }[] = [{ value: "all", label: "全部" }, { value: "running", label: "进行中" }, { value: "attention", label: "等我处理" }, { value: "done", label: "已完成" }];
export type SettingsSection = "general" | "appearance" | "projects" | "usage" | "about";

export function TaskStatus({ s, theme }: { s: S; theme: "light" | "dark" }) {
  switch (s.phase) {
    case "running": { const f = buildFlow(s); return <span className="task-status" title={`要做的事 ${f.done}/${f.total}`}><Pop value={f.done} className="ts-frac">{f.done}/{f.total}</Pop><Orb state="working" size={20} theme={theme} /></span>; }
    case "approval": return <span className="task-status tone-warning"><span className="pulse-dot is-sm" aria-hidden />等你确认</span>;
    case "failed": return <span className="task-status tone-danger"><i className="dot" />没通过</span>;
    case "interrupted": return <span className="task-status tone-warning"><i className="dot" />没做完</span>;
    case "stopped": return <span className="task-status">已停止</span>;
    case "complete": return s.reverted ? <span className="task-status">已撤销</span> : <Diffstat add={s.interjected ? 8 : 7} del={s.interjected ? 3 : 2} />;
    default: return null;
  }
}

/** One task line: click opens, double-click renames, the hover menu renames or archives. */
function TaskRow({ title, active, right, onOpen, onRename, onArchive, onCopy, sortId }: { sortId?: string; title: string; active: boolean; right: ReactNode; onOpen: () => void; onRename: (t: string) => void; onArchive: () => void; onCopy: () => void }) {
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [val, setVal] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (editing) setVal(title); }, [editing, title]);
  useEffect(() => { if (editing) requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); }); }, [editing]);
  const commit = () => { const v = val.trim(); if (v && v !== title) onRename(v); setEditing(false); };
  return <div data-sort-id={sortId} className={`task-row${active ? " is-active" : ""}${menu ? " is-menu" : ""}${editing ? " is-editing" : ""}`}>
    {editing
      ? <input ref={input} autoFocus className="task-rename" value={val} aria-label="任务名称" onChange={e => setVal(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === "Enter" && !isIme(e)) commit(); if (e.key === "Escape") { e.stopPropagation(); setEditing(false); } }} />
      : <button type="button" className="task-main" aria-current={active ? "page" : undefined} onClick={onOpen} onDoubleClick={() => setEditing(true)} title="双击重命名">
          <span className="task-title">{title}</span><span className="task-right">{right}</span>
        </button>}
    {!editing && <Popover open={menu} onOpenChange={setMenu}>
      <PopoverTrigger asChild><button type="button" className="task-more" aria-label={`「${title}」的操作`}><MoreHorizontal size={15} /></button></PopoverTrigger>
      <PopoverContent className="menu" align="start" side="right" sideOffset={6}>
        <button className="menu-item" onClick={() => { setMenu(false); setEditing(true); }}><PencilLine size={15} />重命名</button>
        <button className="menu-item" onClick={() => { setMenu(false); onCopy(); }}><Copy size={15} />复制任务名称</button>
        <div className="menu-sep" />
        <button className="menu-item is-danger" onClick={() => { setMenu(false); onArchive(); }}><Archive size={15} />归档</button>
      </PopoverContent>
    </Popover>}
  </div>;
}

function ProjectGroup({ p, children, count, forceOpen, onNewIn, onRemove, onPreview, ids, onReorder }: { p: Project; children: ReactNode; count: number; forceOpen: boolean; onNewIn: () => void; onRemove: () => void; onPreview: () => void; ids: string[]; onReorder?: (id: string, before: string | null) => void }) {
  const [open, setOpen] = useState(true);
  const rowsRef = useRef<HTMLDivElement>(null);
  const refocus = (id: string) => requestAnimationFrame(() => rowsRef.current?.querySelector<HTMLElement>(`[data-sort-id="${id}"] .task-main`)?.focus());
  // Alt ↑ / Alt ↓ moves the focused task within its project — the keyboard twin of dragging.
  const keyMove = (e: RKeyboardEvent) => {
    if (!onReorder || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-sort-id]")?.dataset.sortId; if (!id) return;
    e.preventDefault(); e.stopPropagation();
    const i = ids.indexOf(id), j = e.key === "ArrowUp" ? i - 1 : i + 2;
    if (e.key === "ArrowUp" && i <= 0) return; if (e.key === "ArrowDown" && i >= ids.length - 1) return;
    onReorder(id, ids[j] ?? null); refocus(id);
  };
  const [menu, setMenu] = useState(false);
  const notify = useNotify();
  const shown = open || forceOpen;
  const sorting = useSortable(rowsRef, (id, before) => onReorder?.(id, before), shown && !!onReorder);
  useEffect(() => { rowsRef.current?.querySelectorAll<HTMLElement>("[data-sort-id]").forEach(r => r.classList.toggle("is-ghost", r.dataset.sortId === sorting?.id)); }, [sorting?.id]);
  const Ico = shown ? FolderOpen : Folder;
  return <div className="sb-section">
    <div className={`sb-label${menu ? " is-menu" : ""}`}>
      <button type="button" className="sb-label-btn" aria-expanded={shown} onClick={() => setOpen(o => !o)} title={shown ? "收起" : "展开"}>
        <Ico size={13} /><span className="sb-label-name">{p.name}</span>
        {!shown && count > 0 && <span className="sb-count">{count}</span>}
        <ChevronRight size={12} className={`chev sb-chev${shown ? " is-open" : ""}`} />
      </button>
      <span className="sb-label-actions">
        <IconBtn className="sb-mini" label="在这个项目里新建任务" onClick={onNewIn}><Plus size={14} /></IconBtn>
        <Popover open={menu} onOpenChange={setMenu}>
          <PopoverTrigger asChild><button type="button" className="icon-btn sb-mini" aria-label={`${p.name} 的操作`}><MoreHorizontal size={14} /></button></PopoverTrigger>
          <PopoverContent className="menu" align="start" side="right" sideOffset={6}>
            <div className="menu-label mono">{p.path}</div>
            <button className="menu-item" onClick={() => { setMenu(false); onNewIn(); }}><SquarePen size={15} />在这个项目里新建任务</button>
            <button className="menu-item" onClick={() => { setMenu(false); notify({ tone: "info", text: `演示稿：会在资源管理器里打开 ${p.path}` }); }}><FolderOpen size={15} />在文件夹中打开</button>
            <button className="menu-item" onClick={() => { setMenu(false); onPreview(); }}><Globe size={15} /><span className="mi-text"><span>预览地址</span><span className="mi-desc">{p.previewUrl ?? "还没设置"}</span></span></button>
            <div className="menu-sep" />
            <button className="menu-item is-danger" onClick={() => { setMenu(false); onRemove(); }}><Trash2 size={15} />从列表移除</button>
          </PopoverContent>
        </Popover>
      </span>
    </div>
    <AnimatePresence initial={false}>
      {shown && <motion.div ref={rowsRef} onKeyDown={keyMove} data-dragging={sorting?.id} className={`sb-rows${sorting ? " is-sorting" : ""}`} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: "spring", visualDuration: .28, bounce: 0 }}>
        {children}
        {sorting && <span className="sort-line" style={{ top: sorting.line }} aria-hidden />}
        {count === 0 && !forceOpen && <button type="button" className="sb-empty-row" onClick={onNewIn}><Plus size={13} />还没有任务，新建一个</button>}
      </motion.div>}
    </AnimatePresence>
  </div>;
}

/** A task that owns a live demo state: the open one ("cur") or one you switched away from. */
export interface LiveTask { key: string; title: string; project: string; s: S }

export interface SidebarProps {
  s: S; theme: "light" | "dark"; live: LiveTask[]; view: View; projects: Project[]; past: PastTask[];
  searchOpen: boolean; setSearchOpen: (v: boolean) => void; themePref: ThemePref; setThemePref: (t: ThemePref) => void;
  onNew: (project?: string) => void; onCollapse: () => void; onOpenLive: (key: string) => void; onOpenPast: (id: string) => void;
  onRenameLive: (key: string, t: string) => void; onRenamePast: (id: string, t: string) => void; onArchiveLive: (key: string) => void; onArchivePast: (id: string) => void;
  onRemoveProject: (id: string) => void; onSettings: (section?: SettingsSection, project?: string) => void; onAddProject: () => void; onShortcuts: () => void;
}

export function Sidebar(p: SidebarProps) {
  const { s, theme, view, projects, past, live } = p;
  const notify = useNotify();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const order = useTaskOrder();
  const [brand, setBrand] = useState(false);
  const [me, setMe] = useState(false);
  const hasCurrent = s.phase !== "empty";
  const needle = p.searchOpen ? q.trim().toLowerCase() : "";
  const match = (t: string) => !needle || t.toLowerCase().includes(needle);
  useEffect(() => { if (!p.searchOpen) { setQ(""); setFilter("all"); } }, [p.searchOpen]);
  const copy = (t: string) => copyText(t).then(ok => notify(ok ? { text: "已复制任务名称" } : { tone: "info", text: "浏览器没允许复制" }));
  const catOf = (ph: S["phase"]): Exclude<Filter, "all"> | "other" => ph === "running" ? "running" : ph === "approval" || ph === "failed" || ph === "interrupted" ? "attention" : ph === "complete" ? "done" : "other";
  const groups = projects.map(pr => {
    let rows: { id: string; cat: string; node: ReactNode }[] = [];
    for (const lt of live) if (lt.project === pr.id && lt.s.phase !== "empty" && match(lt.title)) rows.push({ id: lt.key, cat: catOf(lt.s.phase), node: <TaskRow key={lt.key} sortId={lt.key} title={lt.title} active={lt.key === "cur" && view.kind === "current"} right={<TaskStatus s={lt.s} theme={theme} />} onOpen={() => p.onOpenLive(lt.key)} onRename={v => p.onRenameLive(lt.key, v)} onArchive={() => p.onArchiveLive(lt.key)} onCopy={() => copy(lt.title)} /> });
    for (const t of past) if (t.project === pr.id && match(t.title)) rows.push({ id: t.id, cat: t.outcome === "stopped" ? "other" : "done", node: <TaskRow key={t.id} sortId={t.id} title={t.title} active={view.kind === "past" && view.id === t.id} right={t.outcome === "stopped" ? <span className="task-status">已停止</span> : <span className="task-meta">{t.meta}</span>} onOpen={() => p.onOpenPast(t.id)} onRename={v => p.onRenamePast(t.id, v)} onArchive={() => p.onArchivePast(t.id)} onCopy={() => copy(t.title)} /> });
    rows = order.sort(pr.id, rows);
    const counts = { running: 0, attention: 0, done: 0 } as Record<string, number>; for (const r of rows) counts[r.cat] = (counts[r.cat] ?? 0) + 1;
    const ids = rows.map(r => r.id);
    const shownRows = filter === "all" ? rows : rows.filter(r => r.cat === filter);
    return { pr, rows: shownRows.map(r => r.node), ids, counts };
  });
  const total = (c: Exclude<Filter, "all">) => groups.reduce((a, g) => a + (g.counts[c] ?? 0), 0);
  const narrowing = !!needle || filter !== "all";
  const visible = narrowing ? groups.filter(g => g.rows.length > 0) : groups;
  const pick = (fn: () => void, close: (v: boolean) => void) => () => { close(false); fn(); };
  return <aside className="sidebar" aria-label="项目与任务">
    <div className="sb-top">
      <Popover open={brand} onOpenChange={setBrand}>
        <PopoverTrigger asChild><button className="ws-switch" type="button" aria-label="Jarvis 菜单">
          <span className="ws-logo" aria-hidden>J</span><span className="ws-name">Jarvis</span><ChevronDown size={14} className="muted-ico" />
        </button></PopoverTrigger>
        <PopoverContent className="menu brand-menu" align="start" sideOffset={6}>
          <div className="menu-head"><span className="ws-logo" aria-hidden>J</span><span className="mi-text"><span className="mi-title">Jarvis</span><span className="mi-desc">本机运行 · {projects.length} 个项目</span></span></div>
          <div className="menu-sep" />
          <button className="menu-item" onClick={pick(() => p.onNew(), setBrand)}><SquarePen size={15} />新建任务<kbd>{MOD} N</kbd></button>
          <button className="menu-item" onClick={pick(() => p.setSearchOpen(true), setBrand)}><Search size={15} />搜索任务<kbd>{MOD} K</kbd></button>
          <button className="menu-item" onClick={pick(p.onAddProject, setBrand)}><FolderPlus size={15} />添加项目…</button>
          <div className="menu-sep" />
          <button className="menu-item" onClick={pick(() => p.onSettings(), setBrand)}><Settings size={15} />设置<kbd>{MOD} ,</kbd></button>
          <button className="menu-item" onClick={pick(p.onShortcuts, setBrand)}><Keyboard size={15} />键盘快捷键<kbd>?</kbd></button>
          <button className="menu-item" onClick={pick(() => p.onSettings("about"), setBrand)}><BookOpen size={15} />关于这份对照稿</button>
        </PopoverContent>
      </Popover>
      <div className="sb-top-actions">
        <IconBtn label={`搜索任务（${MOD} K）`} active={p.searchOpen} onClick={() => p.setSearchOpen(!p.searchOpen)}><Search size={16} /></IconBtn>
        <IconBtn label={`收起侧栏（${MOD} B）`} onClick={p.onCollapse}><PanelLeftClose size={16} /></IconBtn>
      </div>
    </div>
    <AnimatePresence initial={false}>
      {p.searchOpen && <motion.div className="sb-search-wrap" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: "spring", visualDuration: .24, bounce: 0 }}>
        <label className="sb-search"><Search size={14} className="muted-ico" />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="搜索任务" aria-label="搜索任务" onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); p.setSearchOpen(false); } }} />
          {q && <button type="button" aria-label="清空" onClick={() => setQ("")}><X size={13} /></button>}
        </label>
        <div className="sb-filters" role="radiogroup" aria-label="按状态筛选">
          {FILTERS.map(f => { const n = f.value === "all" ? 0 : total(f.value); return <button key={f.value} type="button" role="radio" aria-checked={filter === f.value} className={`sb-filter${filter === f.value ? " is-on" : ""}`} onClick={() => setFilter(f.value)} disabled={f.value !== "all" && n === 0 && filter !== f.value}>{f.label}{n > 0 && <span>{n}</span>}</button>; })}
        </div>
      </motion.div>}
    </AnimatePresence>
    <nav className="sb-nav">
      <button type="button" className={`sb-item${!hasCurrent && view.kind === "current" ? " is-active" : ""}`} onClick={() => p.onNew()}><SquarePen size={16} /><span>新建任务</span><kbd>{MOD} N</kbd></button>
    </nav>
    <FadeScroll className="sb-scroll" onKeyDown={e => arrowNav(e, ".task-main")}>
      {visible.map(({ pr, rows, ids }) => <ProjectGroup key={pr.id} p={pr} count={rows.length} forceOpen={narrowing} ids={ids} onReorder={narrowing ? undefined : (id, before) => order.move(pr.id, ids, id, before)} onNewIn={() => p.onNew(pr.id)} onRemove={() => p.onRemoveProject(pr.id)} onPreview={() => p.onSettings("projects", pr.id)}>{rows}</ProjectGroup>)}
      {narrowing && visible.length === 0 && <p className="sb-none">{needle ? `没有找到「${q.trim()}」` : "这一类里还没有任务"}</p>}
      {!needle && <button type="button" className="sb-add-project" onClick={p.onAddProject}><FolderPlus size={14} />添加项目</button>}
    </FadeScroll>
    <div className="sb-foot">
      {s.phase === "interrupted" && <div className="conn-warn"><i className="dot" />Jarvis 上次被关掉了</div>}
      <div className="me">
        <Popover open={me} onOpenChange={setMe}>
          <PopoverTrigger asChild><button type="button" className="me-btn" aria-label="账户与外观"><span className="avatar">L</span><span className="me-name">Ludi</span><ChevronDown size={13} className="muted-ico" /></button></PopoverTrigger>
          <PopoverContent className="menu me-menu" align="start" side="top" sideOffset={6}>
            <div className="menu-head"><span className="avatar">L</span><span className="mi-text"><span className="mi-title">Ludi</span><span className="mi-desc">本机账户 · 数据只存在这台电脑上</span></span></div>
            <div className="menu-sep" />
            <div className="menu-label">外观</div>
            <div className="menu-seg"><SegmentedControl label="外观" value={p.themePref} onValueChange={v => p.setThemePref(v as ThemePref)} options={[{ value: "light", label: "浅色" }, { value: "dark", label: "深色" }, { value: "system", label: "跟随系统" }]} /></div>
            <div className="menu-sep" />
            <button className="menu-item" onClick={pick(() => p.onSettings(), setMe)}><Settings size={15} />设置<kbd>{MOD} ,</kbd></button>
            <button className="menu-item" onClick={pick(p.onShortcuts, setMe)}><Keyboard size={15} />键盘快捷键<kbd>?</kbd></button>
            <button className="menu-item" onClick={pick(() => p.onSettings("about"), setMe)}><Monitor size={15} />关于这份对照稿</button>
          </PopoverContent>
        </Popover>
        <IconBtn label={`设置（${MOD} ,）`} onClick={() => p.onSettings()}><Settings size={16} /></IconBtn>
      </div>
    </div>
  </aside>;
}
