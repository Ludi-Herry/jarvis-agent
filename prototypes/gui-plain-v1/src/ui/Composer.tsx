import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Camera, Check, ChevronDown, FileText, FolderClosed, FolderPlus, Hand, Image, MessageCircle, Paperclip, Plus, Sparkles, Upload, Wallet, X, Zap } from "lucide-react";
import { BorderBeam } from "border-beam";
import { Popover, PopoverContent, PopoverTrigger } from "../arc/popover/popover";
import { Switch } from "../arc/switch/switch";
import { Tooltip } from "../arc/tooltip/tooltip";
import { PERMISSIONS, type Attachment, type Mode, type Phase, type Project } from "../scenario";
import { MOD, type Prefs } from "../prefs";
import { useNotify } from "./feedback";

const MODE_ICON: Record<Mode, any> = { discuss: MessageCircle, ask: Hand, auto: Zap };
const MAX_ATTACH = 6;

export function placeholderFor(phase: Phase | "past") {
  switch (phase) {
    case "empty": return "说说你想改什么，比如「把保存按钮改成主按钮样式」";
    case "running": return "随时补充或纠正，Jarvis 会马上按你说的调整";
    case "approval": return "不想这么改？直接说你想怎么改";
    case "failed": return "说说怎么处理，或者点上面的「让 Jarvis 修好」";
    case "interrupted": return "可以先说说接下来要注意什么";
    default: return "接着说，比如「圆角再大一点」";
  }
}

export function toAttachments(list: FileList | File[]): Attachment[] {
  return Array.from(list).map(f => {
    const image = f.type.startsWith("image/");
    return { label: f.name || (image ? "粘贴的图片.png" : "文件"), kind: image ? "image" : "file", url: image ? URL.createObjectURL(f) : undefined };
  });
}

export function AttachChip({ a, onRemove }: { a: Attachment; onRemove?: () => void }) {
  return <span className="attach-chip">
    <span className={`attach-thumb${a.url ? " has-img" : ""}`}>{a.url ? <img src={a.url} alt="" /> : a.kind === "image" ? <Image size={13} /> : <FileText size={13} />}</span>
    <span className="attach-name">{a.label}</span>
    {onRemove && <button type="button" aria-label={`移除 ${a.label}`} onClick={onRemove}><X size={12} /></button>}
  </span>;
}

export interface ComposerProps {
  variant?: "hero" | "dock"; theme: "light" | "dark"; phase: Phase | "past"; beam: boolean;
  mode: Mode; onMode: (m: Mode) => void; allowAll: boolean; onAllowAll: (v: boolean) => void;
  cost: number; tokens: number; budget: number; sendKey: Prefs["sendKey"];
  draft: string; setDraft: (v: string) => void; focusSignal: number;
  attachments: Attachment[]; setAttachments: (fn: (a: Attachment[]) => Attachment[]) => void;
  onSend: (text: string) => void; onStop: () => void; canStop: boolean;
  shotLabel?: string; onOpenSettings: (section: "usage" | "general") => void;
  projects?: Project[]; project?: string; onProject?: (id: string) => void; onAddProject?: () => void;
}

export function Composer(p: ComposerProps) {
  const { variant = "dock", theme, draft, setDraft, attachments } = p;
  const notify = useNotify();
  const ta = useRef<HTMLTextAreaElement>(null);
  const imgInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [permOpen, setPermOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [projOpen, setProjOpen] = useState(false);
  const [drag, setDrag] = useState(false);
  const dragDepth = useRef(0);
  const canSend = !!draft.trim() || attachments.length > 0;
  const showStop = p.canStop && !canSend;
  useEffect(() => { const el = ta.current; if (!el) return; el.style.height = "0px"; el.style.height = Math.min(200, el.scrollHeight) + "px"; }, [draft]);
  useEffect(() => { if (p.focusSignal) { const el = ta.current; el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); } }, [p.focusSignal]);

  const add = (list: Attachment[]) => {
    if (!list.length) return;
    p.setAttachments(cur => {
      const room = MAX_ATTACH - cur.length;
      if (room <= 0 || list.length > room) notify({ tone: "info", text: `一条消息最多带 ${MAX_ATTACH} 个附件` });
      return [...cur, ...list.slice(0, Math.max(0, room))];
    });
    ta.current?.focus();
  };
  const send = () => { if (showStop) { p.onStop(); return; } if (!canSend) return; p.onSend(draft); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (p.sendKey === "enter" ? !e.shiftKey && !mod : mod) { e.preventDefault(); send(); }
  };
  const onPaste = (e: ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData.files).filter(f => f.type.startsWith("image/"));
    if (imgs.length) { e.preventDefault(); add(toAttachments(imgs)); }
  };
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  const dnd = {
    onDragEnter: (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current += 1; setDrag(true); },
    onDragOver: (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); },
    onDragLeave: () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDrag(false); },
    onDrop: (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current = 0; setDrag(false); add(toAttachments(e.dataTransfer.files)); },
  };
  const pickFiles = (input: HTMLInputElement | null) => { setPlusOpen(false); input?.click(); };
  const shot = () => { setPlusOpen(false); if (p.shotLabel) add([{ label: p.shotLabel, kind: "image" }]); };

  const M = MODE_ICON[p.mode];
  const perm = PERMISSIONS.find(x => x.value === p.mode)!;
  const proj = p.projects?.find(x => x.id === p.project);
  const sendHint = p.sendKey === "enter" ? "Enter 发送 · Shift Enter 换行" : `${MOD} Enter 发送 · Enter 换行`;
  return <div className={`composer-wrap is-${variant}`} {...dnd}>
    <input ref={imgInput} type="file" accept="image/*" multiple hidden onChange={e => { if (e.target.files) add(toAttachments(e.target.files)); e.target.value = ""; }} />
    <input ref={fileInput} type="file" multiple hidden onChange={e => { if (e.target.files) add(toAttachments(e.target.files)); e.target.value = ""; }} />
    <BorderBeam active={p.beam} size="md" colorVariant="ocean" theme={theme} strength={theme === "dark" ? .9 : .8} duration={2.6} className="beam">
      <div className={`composer${drag ? " is-drag" : ""}`}>
        <AnimatePresence>{drag && <motion.div className="drop-cover" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: .15 }}><Upload size={18} />松开，添加到这条消息</motion.div>}</AnimatePresence>
        <AnimatePresence initial={false}>{attachments.length > 0 && <motion.div className="attach-row" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
          {attachments.map((a, i) => <AttachChip key={`${a.label}-${i}`} a={a} onRemove={() => p.setAttachments(cur => cur.filter((_, j) => j !== i))} />)}
        </motion.div>}</AnimatePresence>
        <textarea ref={ta} rows={1} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={onKey} onPaste={onPaste} placeholder={placeholderFor(p.phase)} aria-label="给 Jarvis 的消息" />
        <div className="composer-bar">
          <Popover open={plusOpen} onOpenChange={setPlusOpen}>
            <PopoverTrigger asChild><button type="button" className="chip-btn icon-only" aria-label="添加图片或文件"><Plus size={16} /></button></PopoverTrigger>
            <PopoverContent className="menu" align="start" side="top">
              <button className="menu-item" onClick={() => pickFiles(imgInput.current)}><Image size={15} />添加图片或截图</button>
              <button className="menu-item" onClick={() => pickFiles(fileInput.current)}><Paperclip size={15} />添加文件</button>
              <button className="menu-item" disabled={!p.shotLabel} onClick={shot}><Camera size={15} /><span className="mi-text"><span>截一张当前预览</span>{!p.shotLabel && <span className="mi-desc">先设置这个项目的预览地址</span>}</span></button>
              <div className="menu-sep" />
              <div className="menu-label">也可以直接粘贴截图，或把文件拖进输入框</div>
            </PopoverContent>
          </Popover>
          <Popover open={permOpen} onOpenChange={setPermOpen}>
            <PopoverTrigger asChild><button type="button" className={`chip-btn mode-${p.mode}`} aria-label={`权限：${perm.label}`}><M size={15} /><span>{perm.label}</span>{p.mode === "ask" && p.allowAll && <span className="chip-note">本任务已放行</span>}<ChevronDown size={13} className="muted-ico" /></button></PopoverTrigger>
            <PopoverContent className="menu perm-menu" align="start" side="top">
              <div className="menu-label">Jarvis 可以做什么</div>
              {PERMISSIONS.map(x => { const I = MODE_ICON[x.value]; return <button key={x.value} className={`menu-item rich${p.mode === x.value ? " is-selected" : ""}`} onClick={() => { p.onMode(x.value); setPermOpen(false); }}>
                <I size={16} /><span className="mi-text"><span className="mi-title">{x.label}</span><span className="mi-desc">{x.desc}</span></span>{p.mode === x.value && <Check size={15} className="mi-check" />}
              </button>; })}
              <div className="menu-sep" />
              <label className="menu-switch"><span className="mi-text"><span className="mi-title">这个任务里不再问</span><span className="mi-desc">只对当前任务生效，新任务会重新问</span></span><Switch checked={p.allowAll} disabled={p.mode !== "ask"} onCheckedChange={p.onAllowAll} aria-label="这个任务里不再问" /></label>
              <button className="menu-item menu-foot-link" onClick={() => { setPermOpen(false); p.onOpenSettings("general"); }}>新任务的默认权限…</button>
            </PopoverContent>
          </Popover>
          <span className="grow" />
          <Popover open={modelOpen} onOpenChange={setModelOpen}>
            <PopoverTrigger asChild><button type="button" className="chip-btn" aria-label="模型与用量"><Sparkles size={14} className="muted-ico" /><span>V4.1 Flash</span>{p.cost > 0 && <span className="cost-tag">¥{p.cost.toFixed(2)}</span>}<ChevronDown size={13} className="muted-ico" /></button></PopoverTrigger>
            <PopoverContent className="menu model-menu" align="end" side="top">
              <div className="menu-label">模型</div>
              <button className="menu-item rich is-selected" onClick={() => setModelOpen(false)}><Sparkles size={16} /><span className="mi-text"><span className="mi-title">DeepSeek V4.1 Flash</span><span className="mi-desc">日常改动够用，速度快</span></span><Check size={15} className="mi-check" /></button>
              <button className="menu-item rich" disabled><Sparkles size={16} /><span className="mi-text"><span className="mi-title">深度思考</span><span className="mi-desc">复杂问题更稳 · 还没接入</span></span></button>
              <div className="menu-sep" />
              <div className="usage">
                <div className="usage-head"><span>这个任务用了</span><b>¥{p.cost.toFixed(2)}</b><span className="muted">/ 预算 ¥{p.budget.toFixed(2)}</span></div>
                <div className="usage-bar"><i style={{ width: `${Math.min(100, p.cost / p.budget * 100)}%` }} /></div>
                <div className="usage-foot">{(p.tokens / 10000).toFixed(1)} 万 tokens · 到了预算上限会自动停下</div>
              </div>
              <button className="menu-item" onClick={() => { setModelOpen(false); p.onOpenSettings("usage"); }}><Wallet size={15} />改预算…</button>
            </PopoverContent>
          </Popover>
          <Tooltip content={showStop ? "停止（Esc）" : p.sendKey === "enter" ? "发送（Enter）" : `发送（${MOD} Enter）`} side="top">
            <button type="button" className={`send-btn${showStop ? " is-stop" : ""}`} disabled={!showStop && !canSend} onClick={send} aria-label={showStop ? "停止" : "发送"}>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span key={showStop ? "stop" : "send"} className="send-ico" initial={{ scale: .5, opacity: 0, filter: "blur(2px)" }} animate={{ scale: 1, opacity: 1, filter: "blur(0px)" }} exit={{ scale: .5, opacity: 0, filter: "blur(2px)" }} transition={{ type: "spring", visualDuration: .26, bounce: .12 }}>
                  {showStop ? <span className="stop-square" /> : <ArrowUp size={16} strokeWidth={2.4} />}
                </motion.span>
              </AnimatePresence>
            </button>
          </Tooltip>
        </div>
      </div>
    </BorderBeam>
    {variant === "hero" && <div className="composer-sub">
      <Popover open={projOpen} onOpenChange={setProjOpen}>
        <PopoverTrigger asChild><button type="button" className="sub-btn" aria-label={`项目：${proj?.name ?? ""}`}><FolderClosed size={14} />{proj?.name}<ChevronDown size={12} /></button></PopoverTrigger>
        <PopoverContent className="menu proj-menu" align="start" side="bottom" sideOffset={6}>
          <div className="menu-label">在哪个项目里做</div>
          {p.projects?.map(x => <button key={x.id} className={`menu-item rich${x.id === p.project ? " is-selected" : ""}`} onClick={() => { p.onProject?.(x.id); setProjOpen(false); }}>
            <FolderClosed size={16} /><span className="mi-text"><span className="mi-title">{x.name}</span><span className="mi-desc mono">{x.path}</span></span>{x.id === p.project && <Check size={15} className="mi-check" />}
          </button>)}
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => { setProjOpen(false); p.onAddProject?.(); }}><FolderPlus size={15} />添加项目…</button>
        </PopoverContent>
      </Popover>
      <button type="button" className="sub-btn" onClick={() => imgInput.current?.click()}><Image size={14} />加截图</button>
      <span className="grow" />
      <button type="button" className="sub-hint" onClick={() => p.onOpenSettings("general")} title="在设置里改发送方式">{sendHint}</button>
    </div>}
  </div>;
}
