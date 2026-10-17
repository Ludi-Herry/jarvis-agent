import { Fragment } from "react";
import { motion } from "motion/react";
import { Check, ChevronRight, CircleCheck, Eye, GitCompareArrows, History as HistoryIcon, RotateCcw, SquarePen, Undo2 } from "lucide-react";
import type { Attachment, PastTask } from "../scenario";
import { Button } from "../arc/button/button";
import { ConfirmMorph } from "../arc/confirm-morph/confirm-morph";
import { Diffstat } from "./Bits";
import { enter, MsgActions, StepsGroup, Typewriter, UserBubble } from "./Thread";

export interface PastFollow { id: string; text: string; attachments?: Attachment[] }

/** Replays an earlier task from its record. The prototype cannot run it again, and says so. */
export function PastThread({ t, reverted, onRevert, follows, onOpenFile, onPanel, onEdit, onRestart }: {
  t: PastTask; reverted: boolean; onRevert: (v: boolean) => void; follows: PastFollow[];
  onOpenFile: (name: string) => void; onPanel: (tab: "changes" | "preview" | "terminal") => void; onEdit: (text: string) => void; onRestart: (text: string) => void;
}) {
  const n = t.files.length;
  const add = t.files.reduce((a, f) => a + f.add, 0), del = t.files.reduce((a, f) => a + f.del, 0);
  const check = t.steps.filter(s => s.type === "run").pop();
  const undo = <ConfirmMorph label="撤销" icon={<Undo2 size={14} />} prompt={`撤销这 ${n} 个文件的修改？`} confirmLabel="撤销" cancelLabel="不了" pendingLabel="正在撤销" doneLabel="已撤销" undoLabel="恢复" undoingLabel="正在恢复" tone="neutral"
    onConfirm={() => new Promise(r => setTimeout(r, 650)).then(() => onRevert(true))}
    onUndo={() => new Promise(r => setTimeout(r, 500)).then(() => onRevert(false))} resultTimeout={0} />;
  let card;
  if (t.outcome === "stopped") card = <motion.section {...enter} className="card notice">
    <header className="card-head"><span className="card-ico"><span className="stop-square" /></span><div><h3>你停止了任务</h3><p>停在「{t.steps[t.steps.length - 1]?.label}」之后，还没有改任何文件 · ¥{t.cost.toFixed(2)}</p></div></header>
    <footer className="card-foot"><Button size="sm" onClick={() => onRestart(t.prompt)}><SquarePen size={14} />用这个要求重新开始</Button><span className="card-hint">会开一个新任务，把原来的要求填好</span></footer>
  </motion.section>;
  else if (reverted) card = <motion.section {...enter} className="card result is-reverted">
    <header className="card-head"><span className="card-ico"><Undo2 size={15} /></span><div><h3>已撤销</h3><p>{n} 个文件已恢复到改之前的样子。</p></div></header>
    <footer className="card-foot"><Button size="sm" variant="secondary" onClick={() => onRevert(false)}><RotateCcw size={14} />恢复修改</Button></footer>
  </motion.section>;
  else card = <motion.section {...enter} className="card result" aria-label="已完成">
    <header className="card-head"><span className="card-ico tone-success"><CircleCheck size={16} /></span><div><h3>改好了</h3><p>{t.meta} · 用时 {t.elapsed} · ¥{t.cost.toFixed(2)}</p></div></header>
    <ul className="result-rows">
      <li><button type="button" className="result-row" onClick={() => onPanel("changes")}><GitCompareArrows size={15} className="muted-ico" /><span>修改了 {n} 个文件</span><Diffstat add={add} del={del} /><span className="row-link">查看<ChevronRight size={13} /></span></button></li>
      {check && <li><button type="button" className="result-row" onClick={() => onPanel("terminal")}><Check size={15} className="tone-success" /><span>检查都通过了</span><span className="row-sub">{check.label}</span><span className="row-link">看输出<ChevronRight size={13} /></span></button></li>}
    </ul>
    <footer className="card-foot"><Button size="sm" variant="secondary" onClick={() => onPanel("preview")}><Eye size={14} />看预览</Button><span className="grow" />{undo}</footer>
  </motion.section>;
  return <div className="thread">
    <p className="history-tag"><HistoryIcon size={12} />历史记录 · {t.meta}</p>
    <UserBubble text={t.prompt} onEdit={() => onEdit(t.prompt)} />
    <motion.div {...enter}><StepsGroup steps={t.steps} live={false} onOpenFile={onOpenFile} /></motion.div>
    <motion.div {...enter} className="msg-bot"><Typewriter text={t.reply} /><MsgActions text={t.reply} /></motion.div>
    {card}
    {follows.map(f => <Fragment key={f.id}>
      <UserBubble text={f.text} attachments={f.attachments} onEdit={() => onEdit(f.text)} />
      <motion.section {...enter} className="card notice">
        <header className="card-head"><span className="card-ico"><HistoryIcon size={15} /></span><div><h3>这是之前的任务记录</h3><p>演示稿里历史任务只能回放，不能接着跑。可以把这句话带到新任务里做。</p></div></header>
        <footer className="card-foot"><Button size="sm" variant="secondary" onClick={() => onRestart(f.text)}><SquarePen size={14} />开个新任务做这件事</Button></footer>
      </motion.section>
    </Fragment>)}
    <div className="thread-end" />
  </div>;
}
