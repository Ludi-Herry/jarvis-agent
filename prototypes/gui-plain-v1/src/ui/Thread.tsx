import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronRight, CircleAlert, CircleCheck, CornerDownRight, Eye, FileCode2, FileText, GitCompareArrows, ListChecks, MessageCircle, Pencil, RotateCcw, Search, SquareTerminal, Undo2, Wrench, X } from "lucide-react";
import type { Act, S } from "../store";
import { files, TASK_PROMPT, type Item, type Step } from "../scenario";
import { Button } from "../arc/button/button";
import { ConfirmMorph } from "../arc/confirm-morph/confirm-morph";
import { TextShimmer } from "../arc/text-shimmer/text-shimmer";
import { Diffstat, Orb, fmtElapsed } from "./Bits";

const enter = { initial: { opacity: 0, y: 6, filter: "blur(3px)" }, animate: { opacity: 1, y: 0, filter: "blur(0px)" }, transition: { duration: .32, ease: [.16, 1, .3, 1] as any } };

function Typewriter({ text, animate }: { text: string; animate?: boolean }) {
  const [n, setN] = useState(animate ? 0 : text.length);
  useEffect(() => {
    if (!animate) { setN(text.length); return; }
    let i = 0; const id = window.setInterval(() => { i += 2; setN(Math.min(i, text.length)); if (i >= text.length) window.clearInterval(id); }, 28);
    return () => window.clearInterval(id);
  }, [text, animate]);
  return <p className="msg-text">{text.slice(0, n)}{n < text.length && <span className="caret" />}</p>;
}

const STEP_ICON: Record<Step["type"], any> = { read: FileText, search: Search, edit: Pencil, run: SquareTerminal, think: MessageCircle };
function summarize(steps: Step[]) {
  const c = (t: Step["type"]) => steps.filter(s => s.type === t).length;
  const parts = [c("read") && `看了 ${c("read")} 个文件`, c("search") && `查了 ${c("search")} 处`, c("edit") && `改了 ${c("edit")} 个文件`, c("run") && `跑了 ${c("run")} 项检查`].filter(Boolean);
  return parts.join("，");
}

function StepsGroup({ steps, live, liveNode }: { steps: Step[]; live: boolean; liveNode?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const running = steps.find(s => s.status === "running");
  const failed = steps.filter(s => s.status === "failed").length;
  useEffect(() => { if (failed) setOpen(true); }, [failed]);
  const Icon = running ? STEP_ICON[running.type] : ListChecks;
  return <div className="steps">
    <button type="button" className="steps-summary" aria-expanded={open} onClick={() => setOpen(o => !o)}>
      {live && liveNode ? liveNode : <><Icon size={15} className="muted-ico" /><span>{summarize(steps)}</span></>}
      {failed > 0 && <span className="steps-attn">{failed} 项没通过</span>}
      <ChevronRight size={14} className={`chev${open ? " is-open" : ""}`} />
    </button>
    <AnimatePresence initial={false}>
      {open && <motion.ul className="steps-list" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: "spring", visualDuration: .34, bounce: 0 }}>
        {steps.map(st => { const I = STEP_ICON[st.type]; const expandable = !!st.output; return <li key={st.id} className={`step is-${st.status}`}>
          <button type="button" className="step-row" disabled={!expandable} onClick={() => setOpenRun(r => r === st.id ? null : st.id)} aria-expanded={expandable ? openRun === st.id : undefined}>
            <span className="step-ico">{st.status === "running" ? <span className="spin" /> : st.status === "failed" ? <X size={13} /> : st.type === "run" ? <Check size={13} /> : <I size={13} />}</span>
            <span className="step-label">{st.label}</span>
            {st.target && <span className={`step-target${st.type === "run" ? " mono" : ""}`}>{st.target}</span>}
            <span className="step-ms">{st.status === "running" ? "" : `${(st.ms / 1000).toFixed(1)} 秒`}</span>
            {expandable && <ChevronRight size={13} className={`chev${openRun === st.id ? " is-open" : ""}`} />}
          </button>
          {expandable && openRun === st.id && <pre className="step-output">{st.output!.join("\n")}</pre>}
        </li>; })}
      </motion.ul>}
    </AnimatePresence>
  </div>;
}

function ApprovalCard({ item, s, act, onOpenFile, onAdjust, onPanel }: { item: Extract<Item, { kind: "approval" }>; s: S; act: Act; onOpenFile: (p: string) => void; onAdjust: () => void; onPanel: (t: "changes" | "preview" | "terminal") => void }) {
  const fs = files(s.interjected);
  if (item.resolved) {
    const ok = item.resolved !== "denied" && item.resolved !== "adjusted";
    return <motion.div {...enter} className="resolved-line">{ok ? <Check size={14} /> : <X size={14} />}<span>{item.resolved === "allowed-all" ? "你允许了修改，并且这个任务里不再问" : item.resolved === "adjusted" ? "你要求换个改法，这一版没有改" : ok ? "你允许了修改 2 个文件" : "你没有允许这次修改"}</span></motion.div>;
  }
  return <motion.section {...enter} className="card approval" aria-label="需要你确认">
    <header className="card-head"><span className="card-ico tone-warning"><Pencil size={15} /></span><div><h3>要修改 {fs.length} 个文件，可以吗？</h3><p>改完会自动跑设置页的测试和类型检查。</p></div></header>
    <ul className="file-list">{fs.map(f => <li key={f.path}><button type="button" className="file-row" onClick={() => onOpenFile(f.path)}><FileCode2 size={15} className="muted-ico" /><span className="file-name">{f.name}</span><span className="file-dir">{f.dir}</span><Diffstat add={f.add} del={f.del} /><span className="file-open">看改动<ChevronRight size={13} /></span></button></li>)}
      <li><button type="button" className="file-row is-preview" onClick={() => onPanel("preview")}><Eye size={15} className="muted-ico" /><span className="file-name">先看看改完的效果</span><span className="file-dir">预览会按方案先渲染出来</span><span className="file-open">看预览<ChevronRight size={13} /></span></button></li></ul>
    <footer className="card-foot">
      <Button size="sm" onClick={() => act({ type: "approve", all: false })}>允许</Button>
      <Button size="sm" variant="secondary" onClick={() => act({ type: "approve", all: true })}>这个任务都允许</Button>
      <Button size="sm" variant="ghost" onClick={() => act({ type: "deny" })}>不允许</Button>
      <button type="button" className="card-hint link" onClick={onAdjust}>换个改法？直接在下面说</button>
    </footer>
  </motion.section>;
}

function ResultCard({ item, s, act, onPanel }: { item: Extract<Item, { kind: "result" }>; s: S; act: Act; onPanel: (t: "changes" | "preview" | "terminal") => void }) {
  const fs = files(s.interjected);
  const add = fs.reduce((a, f) => a + f.add, 0), del = fs.reduce((a, f) => a + f.del, 0);
  const meta = s.startedAt && s.endedAt ? `用时 ${fmtElapsed(s.endedAt - s.startedAt)} · ¥${s.cost.toFixed(2)}` : `¥${s.cost.toFixed(2)}`;
  const undo = <ConfirmMorph label="撤销" icon={<Undo2 size={14} />} prompt={`撤销这 ${fs.length} 个文件的修改？`} confirmLabel="撤销" cancelLabel="不了" pendingLabel="正在撤销" doneLabel="已撤销" undoLabel="恢复" undoingLabel="正在恢复" tone="neutral"
    onConfirm={() => new Promise(r => setTimeout(r, 650)).then(() => act({ type: "revert", value: true }))}
    onUndo={() => new Promise(r => setTimeout(r, 500)).then(() => act({ type: "revert", value: false }))} resultTimeout={0} />;
  if (item.reverted) return <motion.section {...enter} className="card result is-reverted">
    <header className="card-head"><span className="card-ico"><Undo2 size={15} /></span><div><h3>已撤销</h3><p>{fs.length} 个文件已恢复到改之前的样子。</p></div></header>
    <footer className="card-foot"><Button size="sm" variant="secondary" onClick={() => act({ type: "revert", value: false })}><RotateCcw size={14} />恢复修改</Button></footer>
  </motion.section>;
  const failed = item.outcome === "failed";
  return <motion.section {...enter} className={`card result${failed ? " is-failed" : ""}`} aria-label={failed ? "没通过检查" : "已完成"}>
    <header className="card-head">
      <span className={`card-ico ${failed ? "tone-danger" : "tone-success"}`}>{failed ? <CircleAlert size={16} /> : <CircleCheck size={16} />}</span>
      <div><h3>{failed ? "改完了，但检查没通过" : "改好了"}</h3><p>{meta}</p></div>
    </header>
    <ul className="result-rows">
      <li><button type="button" className="result-row" onClick={() => onPanel("changes")}><GitCompareArrows size={15} className="muted-ico" /><span>修改了 {fs.length} 个文件</span><Diffstat add={add} del={del} /><span className="row-link">查看<ChevronRight size={13} /></span></button></li>
      <li>{failed
        ? <button type="button" className="result-row" onClick={() => onPanel("terminal")}><X size={15} className="tone-danger" /><span>设置页测试 <b className="tone-danger">1 项没通过</b>：快照还是旧按钮</span><span className="row-link">看输出<ChevronRight size={13} /></span></button>
        : <div className="result-row is-static"><Check size={15} className="tone-success" /><span>检查都通过了</span><span className="row-sub">设置页测试 12 项 · 类型检查</span></div>}</li>
    </ul>
    <footer className="card-foot">
      {failed && <Button size="sm" onClick={() => act({ type: "fix" })}><Wrench size={14} />让 Jarvis 修好</Button>}
      <Button size="sm" variant="secondary" onClick={() => onPanel("preview")}><Eye size={14} />看预览</Button>
      <span className="grow" />
      {undo}
    </footer>
  </motion.section>;
}

function Notice({ item, s, act }: { item: Extract<Item, { kind: "notice" }>; s: S; act: Act }) {
  if (item.tone === "demo") return <motion.p {...enter} className="notice-line">演示稿只有一条剧本，下面按示例任务「{TASK_PROMPT}」走一遍。</motion.p>;
  if (item.tone === "denied") return <motion.p {...enter} className="notice-line">这次没有改任何文件。想换个做法，直接在下面说就行。</motion.p>;
  if (item.tone === "resumed") return <motion.div {...enter} className="resolved-line"><Check size={14} /><span>已恢复现场，接着跑检查</span></motion.div>;
  if (item.tone === "stopped") return <motion.section {...enter} className="card notice">
    <header className="card-head"><span className="card-ico"><span className="stop-square" /></span><div><h3>你停止了任务</h3><p>{s.applied ? "已经改的文件都保留着，可以接着做，也可以撤销。" : "还没有改任何文件。"}</p></div></header>
    {s.phase === "stopped" && <footer className="card-foot"><Button size="sm" variant="secondary" onClick={() => act({ type: "continue" })}>继续</Button>{s.applied && <Button size="sm" variant="ghost" onClick={() => act({ type: "revert", value: true })}><Undo2 size={14} />撤销已改的</Button>}</footer>}
  </motion.section>;
  if (item.tone === "interrupted") return <motion.section {...enter} className="card notice is-warn">
    <header className="card-head"><span className="card-ico tone-warning"><RotateCcw size={15} /></span><div><h3>上次没做完</h3><p>Jarvis 被关掉时，任务停在「跑检查」这一步。已改的 2 个文件都在。</p></div></header>
    <footer className="card-foot"><Button size="sm" onClick={() => act({ type: "resume" })}>接着做</Button><Button size="sm" variant="secondary" onClick={() => act({ type: "revert", value: true })}><Undo2 size={14} />撤销改动</Button></footer>
  </motion.section>;
  // discuss
  return <motion.section {...enter} className="card notice">
    <header className="card-head"><span className="card-ico"><MessageCircle size={15} /></span><div><h3>这是只讨论模式</h3><p>我只看、只聊，不会改文件。</p></div></header>
    {s.phase === "idle" && <footer className="card-foot"><Button size="sm" onClick={() => act({ type: "startFromDiscuss" })}>动手改</Button><span className="card-hint">会切到「改之前问我」</span></footer>}
  </motion.section>;
}

function StatusLine({ s, theme, inline }: { s: S; theme: "light" | "dark"; inline?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  if (s.phase !== "running" && s.phase !== "approval") return null;
  const elapsed = s.startedAt ? fmtElapsed(now - s.startedAt) : "";
  const body = <>
    {s.phase === "approval" ? <><span className="pulse-dot" /><span>等你确认后继续</span></> : <><Orb state={s.orb} size={20} theme={theme} /><TextShimmer>{s.status ?? "正在想"}</TextShimmer></>}
    <span className="status-meta">{elapsed}</span>
  </>;
  return inline ? <span className="status-inline" role="status" aria-live="polite">{body}</span> : <div className="status-line" role="status" aria-live="polite">{body}</div>;
}

export function Thread({ s, act, theme, onOpenFile, onPanel, onAdjust }: { s: S; act: Act; theme: "light" | "dark"; onOpenFile: (p: string) => void; onPanel: (t: "changes" | "preview" | "terminal") => void; onAdjust: () => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const go = () => end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    go(); const a = setTimeout(go, 120), b = setTimeout(go, 450);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [s.items.length, s.phase]);
  const live = s.phase === "running";
  const lastIsSteps = s.items[s.items.length - 1]?.kind === "steps";
  const inlineStatus = live && lastIsSteps;
  return <div className="thread">
    {s.items.map((it, idx) => {
      switch (it.kind) {
        case "user": return <motion.div {...enter} key={it.id} className="msg-user-wrap">{it.interject && <span className="interject-tag"><CornerDownRight size={12} />{s.items[idx - 1]?.kind === "approval" ? "要求调整" : "运行中补充"}</span>}<div className="msg-user">{it.text}</div></motion.div>;
        case "text": return <motion.div {...enter} key={it.id}><Typewriter text={it.text} animate={it.animate} /></motion.div>;
        case "steps": return <motion.div {...enter} key={it.id}><StepsGroup steps={it.steps} live={inlineStatus && idx === s.items.length - 1} liveNode={<StatusLine s={s} theme={theme} inline />} /></motion.div>;
        case "approval": return <ApprovalCard key={it.id} item={it} s={s} act={act} onOpenFile={onOpenFile} onAdjust={onAdjust} onPanel={onPanel} />;
        case "result": return <ResultCard key={it.id} item={it} s={s} act={act} onPanel={onPanel} />;
        case "notice": return <Notice key={it.id} item={it} s={s} act={act} />;
      }
    })}
    {!inlineStatus && <StatusLine s={s} theme={theme} />}
    <div ref={end} className="thread-end" />
  </div>;
}
