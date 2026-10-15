import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Check, ChevronDown, FolderClosed, Hand, Image, MessageCircle, Paperclip, Plus, Sparkles, X, Zap, Camera } from "lucide-react";
import { BorderBeam } from "border-beam";
import { Popover, PopoverContent, PopoverTrigger } from "../arc/popover/popover";
import { Switch } from "../arc/switch/switch";
import { Tooltip } from "../arc/tooltip/tooltip";
import type { Act, S } from "../store";
import { PERMISSIONS, type Mode } from "../scenario";

const MODE_ICON: Record<Mode, any> = { discuss: MessageCircle, ask: Hand, auto: Zap };

function placeholder(s: S) {
  switch (s.phase) {
    case "empty": return "说说你想改什么，比如「把保存按钮改成主按钮样式」";
    case "running": return "随时补充或纠正，Jarvis 会马上按你说的调整";
    case "approval": return "不想这么改？直接说你想怎么改";
    case "failed": return "说说怎么处理，或者点上面的「让 Jarvis 修好」";
    case "interrupted": return "可以先说说接下来要注意什么";
    default: return "接着说，比如「圆角再大一点」";
  }
}

function UsageRing({ cost, budget = 2 }: { cost: number; budget?: number }) {
  const r = 7, c = 2 * Math.PI * r, p = Math.min(1, cost / budget);
  return <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="usage-ring"><circle cx="9" cy="9" r={r} className="track" /><circle cx="9" cy="9" r={r} className="fill" strokeDasharray={c} strokeDashoffset={c * (1 - p)} transform="rotate(-90 9 9)" /></svg>;
}

export function Composer({ s, act, theme, variant = "dock", draft, setDraft, focusSignal }: { s: S; act: Act; theme: "light" | "dark"; variant?: "hero" | "dock"; draft: string; setDraft: (v: string) => void; focusSignal: number }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const [permOpen, setPermOpen] = useState(false);
  const busy = s.phase === "running" || s.phase === "approval";
  const showStop = busy && !draft.trim() && !s.attachments.length;
  const canSend = !!draft.trim() || s.attachments.length > 0;
  useEffect(() => { const el = ta.current; if (!el) return; el.style.height = "0px"; el.style.height = Math.min(200, el.scrollHeight) + "px"; }, [draft]);
  useEffect(() => { if (focusSignal) ta.current?.focus(); }, [focusSignal]);
  const send = () => { if (showStop) { act({ type: "stop" }); return; } if (!canSend) return; act({ type: "send", text: draft }); setDraft(""); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } };
  const M = MODE_ICON[s.mode];
  const perm = PERMISSIONS.find(p => p.value === s.mode)!;
  return <div className={`composer-wrap is-${variant}`}>
    <BorderBeam active={s.phase === "running"} size="md" colorVariant="ocean" theme={theme} strength={theme === "dark" ? .9 : .8} duration={2.6} className="beam">
      <div className="composer">
        <AnimatePresence initial={false}>{s.attachments.length > 0 && <motion.div className="attach-row" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
          {s.attachments.map((a, i) => <span key={i} className="attach-chip"><span className="attach-thumb"><Image size={13} /></span>{a}<button aria-label="移除" onClick={() => act({ type: "detach", i })}><X size={12} /></button></span>)}
        </motion.div>}</AnimatePresence>
        <textarea ref={ta} rows={1} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={onKey} placeholder={placeholder(s)} aria-label="给 Jarvis 的消息" />
        <div className="composer-bar">
          <Popover>
            <PopoverTrigger asChild><button type="button" className="chip-btn icon-only" aria-label="添加"><Plus size={16} /></button></PopoverTrigger>
            <PopoverContent className="menu" align="start" side="top">
              <button className="menu-item" onClick={() => act({ type: "attach", label: "截图.png" })}><Image size={15} />添加图片或截图</button>
              <button className="menu-item"><Paperclip size={15} />添加文件</button>
              <button className="menu-item" onClick={() => act({ type: "attach", label: "预览截图 · 设置页" })}><Camera size={15} />截一张当前预览</button>
            </PopoverContent>
          </Popover>
          <Popover open={permOpen} onOpenChange={setPermOpen}>
            <PopoverTrigger asChild><button type="button" className={`chip-btn mode-${s.mode}`} aria-label={`权限：${perm.label}`}><M size={15} /><span>{perm.label}</span>{s.mode === "ask" && s.allowAll && <span className="chip-note">本任务已放行</span>}<ChevronDown size={13} className="muted-ico" /></button></PopoverTrigger>
            <PopoverContent className="menu perm-menu" align="start" side="top">
              <div className="menu-label">Jarvis 可以做什么</div>
              {PERMISSIONS.map(p => { const I = MODE_ICON[p.value]; return <button key={p.value} className={`menu-item rich${s.mode === p.value ? " is-selected" : ""}`} onClick={() => { act({ type: "mode", mode: p.value }); setPermOpen(false); }}>
                <I size={16} /><span className="mi-text"><span className="mi-title">{p.label}</span><span className="mi-desc">{p.desc}</span></span>{s.mode === p.value && <Check size={15} className="mi-check" />}
              </button>; })}
              <div className="menu-sep" />
              <label className="menu-switch"><span className="mi-text"><span className="mi-title">这个任务里不再问</span><span className="mi-desc">只对当前任务生效，新任务会重新问</span></span><Switch checked={s.allowAll} disabled={s.mode !== "ask"} onCheckedChange={v => act({ type: "allowAll", value: v })} aria-label="这个任务里不再问" /></label>
            </PopoverContent>
          </Popover>
          <span className="grow" />
          <Popover>
            <PopoverTrigger asChild><button type="button" className="chip-btn" aria-label="模型与用量"><Sparkles size={14} className="muted-ico" /><span>V4.1 Flash</span>{s.cost > 0 && <span className="cost-tag">¥{s.cost.toFixed(2)}</span>}<ChevronDown size={13} className="muted-ico" /></button></PopoverTrigger>
            <PopoverContent className="menu model-menu" align="end" side="top">
              <div className="menu-label">模型</div>
              <button className="menu-item rich is-selected"><Sparkles size={16} /><span className="mi-text"><span className="mi-title">DeepSeek V4.1 Flash</span><span className="mi-desc">日常改动够用，速度快</span></span><Check size={15} className="mi-check" /></button>
              <button className="menu-item rich" disabled><Sparkles size={16} /><span className="mi-text"><span className="mi-title">深度思考</span><span className="mi-desc">复杂问题更稳 · 还没接入</span></span></button>
              <div className="menu-sep" />
              <div className="usage">
                <div className="usage-head"><span>这个任务用了</span><b>¥{s.cost.toFixed(2)}</b><span className="muted">/ 预算 ¥2.00</span></div>
                <div className="usage-bar"><i style={{ width: `${Math.min(100, s.cost / 2 * 100)}%` }} /></div>
                <div className="usage-foot">{(s.tokens / 10000).toFixed(1)} 万 tokens · 到了预算上限会自动停下</div>
              </div>
            </PopoverContent>
          </Popover>
          <Tooltip content={showStop ? "停止（Esc）" : "发送（Enter）"} side="top">
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
      <button type="button" className="sub-btn"><FolderClosed size={14} />jarvis-agent<ChevronDown size={12} /></button>
      <button type="button" className="sub-btn" onClick={() => act({ type: "attach", label: "截图.png" })}><Image size={14} />加截图</button>
      <span className="grow" />
      <span className="sub-hint">Enter 发送 · Shift Enter 换行</span>
    </div>}
  </div>;
}
