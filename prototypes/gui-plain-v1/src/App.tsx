import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Copy, FolderOpen, Menu, MoreHorizontal, PanelLeftOpen, PanelRight, PencilLine, SlidersHorizontal, Undo2, Lightbulb, Bug, Type } from "lucide-react";
import { useDemo, type Snapshot } from "./store";
import { files, INTERJECT, TASK_PROMPT } from "./scenario";
import { Sidebar } from "./ui/Sidebar";
import { Thread } from "./ui/Thread";
import { Composer } from "./ui/Composer";
import { SidePanel, type PanelTab } from "./ui/SidePanel";
import { CompareOverlay, ReviewDock, type CompareMode } from "./ui/ReviewDock";
import { Diffstat, IconBtn, Orb } from "./ui/Bits";
import { Popover, PopoverContent, PopoverTrigger } from "./arc/popover/popover";
import { Dialog, DialogContent } from "./arc/dialog/dialog";
import { Button } from "./arc/button/button";

const SUGGEST = [
  { icon: SlidersHorizontal, title: "调整组件样式", text: "把设置页的「保存」按钮改成主按钮样式，圆角跟输入框一致" },
  { icon: Type, title: "把文案改清楚", text: "首页空状态的提示文字改得更友好，别用技术词" },
  { icon: Bug, title: "修一个界面问题", text: "深色模式下输入框的边框看不见，帮我修一下" },
];

function useMedia(q: string) { const [m, setM] = useState(() => window.matchMedia(q).matches); useEffect(() => { const mq = window.matchMedia(q); const f = () => setM(mq.matches); mq.addEventListener("change", f); return () => mq.removeEventListener("change", f); }, [q]); return m; }

function snapOf(phase: string): Snapshot {
  return phase === "empty" ? "empty" : phase === "running" ? "running" : phase === "approval" ? "approval" : phase === "failed" ? "failed" : phase === "interrupted" ? "interrupted" : "complete";
}

export default function App() {
  const [s, act] = useDemo();
  const [theme, setTheme] = useState<"light" | "dark">(() => (new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light"));
  const narrow = useMedia("(max-width: 820px)");
  const mid = useMedia("(max-width: 1180px)");
  const [sidebar, setSidebar] = useState(!narrow);
  const [panel, setPanel] = useState(false);
  const [tab, setTab] = useState<PanelTab>("changes");
  const [file, setFile] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [focusSignal, setFocus] = useState(0);
  const [compare, setCompare] = useState<CompareMode>("new");
  const [cx, setCx] = useState(50);
  const [snap, setSnap] = useState<Snapshot>("empty");
  const [advanced, setAdvanced] = useState(false);
  const [toast, setToast] = useState<null | "reverted">(null);
  const [playing, setPlaying] = useState(false);
  const sRef = useRef(s); sRef.current = s;
  useEffect(() => { const q = new URLSearchParams(location.search); const st = q.get("state") as Snapshot | null; if (st && st !== "empty") { act({ type: "snapshot", snap: st }); setSnap(st); } const p = q.get("panel") as PanelTab | null; if (p) { setTab(p); setPanel(true); } const c = q.get("compare") as CompareMode | null; if (c) setCompare(c); }, [act]);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { setSidebar(!narrow); }, [narrow]);
  useEffect(() => { if (s.phase !== "empty") setSnap(snapOf(s.phase)); }, [s.phase]);
  // Undo feedback lives in one toast with a way back.
  const prevRev = useRef(s.reverted);
  useEffect(() => { if (s.reverted && !prevRev.current) setToast("reverted"); if (!s.reverted) setToast(null); prevRev.current = s.reverted; }, [s.reverted]);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), 5000); return () => clearTimeout(id); }, [toast]);
  // P3: when a live run finishes, the preview opens by itself on wide screens.
  const prevPhase = useRef(s.phase);
  useEffect(() => { if (prevPhase.current === "running" && s.phase === "complete" && !mid) { setTab("preview"); setPanel(true); } prevPhase.current = s.phase; }, [s.phase, mid]);

  const openPanel = useCallback((t: PanelTab) => { setTab(t); setPanel(true); }, []);
  const openFile = useCallback((p: string) => { setFile(p); setTab("changes"); setPanel(true); }, []);
  const pickSnap = (v: Snapshot) => { setPlaying(false); act({ type: "snapshot", snap: v }); setSnap(v); setDraft(""); setPanel(false); setFile(null); };

  // Auto demo: types the task, interjects once, approves, then hands back.
  useEffect(() => {
    if (!playing) return;
    let dead = false; const T: number[] = [];
    const wait = (ms: number) => new Promise<void>(r => T.push(window.setTimeout(r, ms)));
    const type = async (t: string) => { for (let i = 1; i <= t.length; i++) { if (dead) return; setDraft(t.slice(0, i)); await wait(38); } };
    (async () => {
      act({ type: "play" }); setPanel(false); setDraft(""); setSnap("empty");
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

  const title = s.phase === "empty" ? "新任务" : "保存按钮改成主按钮样式";
  const fs = files(s.interjected);
  const add = fs.reduce((a, f) => a + f.add, 0), del = fs.reduce((a, f) => a + f.del, 0);
  const showChanges = s.applied && !s.reverted;
  const hour = new Date().getHours();
  const hello = hour < 11 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";

  return <div className={`app${sidebar ? " has-sidebar" : ""}${panel ? " has-panel" : ""}${narrow ? " is-narrow" : ""}${mid ? " is-mid" : ""}`}>
    <AnimatePresence initial={false}>
      {sidebar && <motion.div className="sidebar-shell" initial={narrow ? { x: -290 } : { opacity: 0 }} animate={narrow ? { x: 0 } : { opacity: 1 }} exit={narrow ? { x: -290 } : { opacity: 0 }} transition={{ type: "spring", visualDuration: .32, bounce: 0 }}>
        <Sidebar s={s} theme={theme} title={title} onNew={() => { pickSnap("empty"); if (narrow) setSidebar(false); }} onCollapse={() => setSidebar(false)} onPickCurrent={() => narrow && setSidebar(false)} />
      </motion.div>}
    </AnimatePresence>
    {narrow && sidebar && <div className="scrim" onClick={() => setSidebar(false)} />}
    <main className="main">
      <header className="topbar">
        {!sidebar && <IconBtn label={narrow ? "打开菜单" : "展开侧栏"} onClick={() => setSidebar(true)}>{narrow ? <Menu size={17} /> : <PanelLeftOpen size={17} />}</IconBtn>}
        <div className="topbar-title"><span className="tt-main">{title}</span>{s.phase !== "empty" && !narrow && <span className="tt-crumb">jarvis-agent</span>}</div>
        <span className="grow" />
        <ReviewDock snap={snap} onSnap={pickSnap} mode={compare} setMode={setCompare} theme={theme} setTheme={setTheme} onPlay={() => setPlaying(p => !p)} playing={playing} />
        <span className="grow" />
        {showChanges && <button type="button" className="changes-pill" onClick={() => openPanel("changes")}><span>{fs.length} 个文件</span><Diffstat add={add} del={del} /></button>}
        {s.phase !== "empty" && <Popover>
          <PopoverTrigger asChild><button type="button" className="icon-btn" aria-label="更多"><MoreHorizontal size={17} /></button></PopoverTrigger>
          <PopoverContent className="menu" align="end">
            <button className="menu-item"><PencilLine size={15} />重命名</button>
            <button className="menu-item"><FolderOpen size={15} />在文件夹中打开项目</button>
            <button className="menu-item"><Copy size={15} />复制对话</button>
            <div className="menu-sep" />
            <button className="menu-item" onClick={() => setAdvanced(true)}><SlidersHorizontal size={15} />范围与预算…</button>
          </PopoverContent>
        </Popover>}
        <IconBtn label={panel ? "收起面板" : "更改 · 预览 · 终端"} active={panel} onClick={() => setPanel(p => !p)} badge={showChanges && !panel}><PanelRight size={17} /></IconBtn>
      </header>

      {s.phase === "empty" ? <div className="hero">
        <div className="hero-orb"><Orb state="breathing" size={64} theme={theme} /></div>
        <h1>{hello}，Ludi。今天想改点什么？</h1>
        <Composer s={s} act={act} theme={theme} variant="hero" draft={draft} setDraft={setDraft} focusSignal={focusSignal} />
        <div className="suggest">{SUGGEST.map(x => <button key={x.title} type="button" className="suggest-card" onClick={() => { setDraft(x.text); setFocus(n => n + 1); }}><x.icon size={16} className="muted-ico" /><span className="sg-title">{x.title}</span><span className="sg-text">{x.text}</span></button>)}</div>
        <p className="hero-tip"><Lightbulb size={13} />想先聊聊再动手？把输入框里的「改之前问我」切成「只讨论」。</p>
      </div> : <>
        <div className="scroll"><Thread s={s} act={act} theme={theme} onOpenFile={openFile} onPanel={openPanel} onAdjust={() => setFocus(n => n + 1)} /></div>
        <div className="dock-composer"><Composer s={s} act={act} theme={theme} draft={draft} setDraft={setDraft} focusSignal={focusSignal} /></div>
      </>}
      <div className="toast-wrap"><AnimatePresence>{toast && <motion.div className="toast" role="status" initial={{ opacity: 0, y: 10, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: .98 }} transition={{ type: "spring", visualDuration: .3, bounce: .12 }}>
        <Undo2 size={15} /><span>已撤销 {fs.length} 个文件的修改</span><button type="button" onClick={() => act({ type: "revert", value: false })}>恢复</button>
      </motion.div>}</AnimatePresence></div>
    </main>
    <AnimatePresence initial={false}>
      {panel && <motion.div className="panel-shell" initial={mid ? { x: 480 } : { opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={mid ? { x: 480 } : { opacity: 0, x: 24 }} transition={{ type: "spring", visualDuration: .34, bounce: 0 }}>
        <SidePanel s={s} act={act} tab={tab} setTab={setTab} file={file} setFile={setFile} onClose={() => setPanel(false)} onShot={() => { setFocus(n => n + 1); if (mid) setPanel(false); }} />
      </motion.div>}
    </AnimatePresence>
    {mid && panel && <div className="scrim" onClick={() => setPanel(false)} />}

    <Dialog open={advanced} onOpenChange={setAdvanced}>
      <DialogContent title="范围与预算" description="平时不用管：Jarvis 会按任务自动推断。这些限制在后台照常生效。">
        <dl className="adv">
          <div><dt>可以改的文件</dt><dd><code>src/settings/**</code> <code>src/styles/**</code><span className="auto">自动</span></dd></div>
          <div><dt>完成前要跑的检查</dt><dd><code>npm test -- settings</code> <code>npx tsc --noEmit</code><span className="auto">自动</span></dd></div>
          <div><dt>预算</dt><dd>¥2.00 · 最长 15 分钟<span className="auto">默认</span></dd></div>
          <div><dt>运行位置</dt><dd>只在 jarvis-agent 文件夹里</dd></div>
        </dl>
        <div className="adv-foot"><Button size="sm" variant="secondary" onClick={() => setAdvanced(false)}>好的</Button></div>
      </DialogContent>
    </Dialog>

    <CompareOverlay mode={compare} snap={snap} x={cx} onX={setCx} />
  </div>;
}
