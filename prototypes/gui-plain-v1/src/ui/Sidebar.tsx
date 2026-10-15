import { ChevronDown, FolderClosed, PanelLeftClose, Search, Settings, SquarePen, Plus } from "lucide-react";
import type { S } from "../store";
import { OTHER_TASKS } from "../scenario";
import { Diffstat, IconBtn, Orb } from "./Bits";

export function TaskStatus({ s, theme }: { s: S; theme: "light" | "dark" }) {
  switch (s.phase) {
    case "running": return <span className="task-status"><Orb state="working" size={20} theme={theme} /></span>;
    case "approval": return <span className="task-status tone-warning"><i className="dot" />等你确认</span>;
    case "failed": return <span className="task-status tone-danger"><i className="dot" />没通过</span>;
    case "interrupted": return <span className="task-status tone-warning"><i className="dot" />没做完</span>;
    case "stopped": return <span className="task-status">已停止</span>;
    case "complete": return s.reverted ? <span className="task-status">已撤销</span> : <Diffstat add={s.interjected ? 8 : 7} del={s.interjected ? 3 : 2} />;
    default: return null;
  }
}

export function Sidebar({ s, theme, onNew, onCollapse, onPickCurrent, title }: { s: S; theme: "light" | "dark"; onNew: () => void; onCollapse: () => void; onPickCurrent: () => void; title: string }) {
  const hasCurrent = s.phase !== "empty";
  return <aside className="sidebar" aria-label="项目与任务">
    <div className="sb-top">
      <button className="ws-switch" type="button" aria-label="切换项目">
        <span className="ws-logo" aria-hidden>J</span>
        <span className="ws-name">Jarvis</span>
        <ChevronDown size={14} className="muted-ico" />
      </button>
      <div className="sb-top-actions">
        <IconBtn label="搜索任务"><Search size={16} /></IconBtn>
        <IconBtn label="收起侧栏" onClick={onCollapse}><PanelLeftClose size={16} /></IconBtn>
      </div>
    </div>
    <nav className="sb-nav">
      <button type="button" className={`sb-item${!hasCurrent ? " is-active" : ""}`} onClick={onNew}><SquarePen size={16} /><span>新建任务</span><kbd>Ctrl N</kbd></button>
    </nav>
    <div className="sb-section">
      <div className="sb-label"><FolderClosed size={13} /><span>jarvis-agent</span><button className="sb-label-add" aria-label="在这个项目里新建任务" onClick={onNew}><Plus size={13} /></button></div>
      {hasCurrent && <button type="button" className="task-row is-active" onClick={onPickCurrent}>
        <span className="task-title">{title}</span>
        <TaskStatus s={s} theme={theme} />
      </button>}
      {OTHER_TASKS.map(t => <button key={t.id} type="button" className="task-row">
        <span className="task-title">{t.title}</span>
        {t.stopped ? <span className="task-status">已停止</span> : <span className="task-meta">{t.meta}</span>}
      </button>)}
    </div>
    <div className="sb-section">
      <div className="sb-label"><FolderClosed size={13} /><span>portfolio-site</span></div>
      <button type="button" className="task-row"><span className="task-title">作品集首页换成两栏布局</span><span className="task-meta">10月8日</span></button>
    </div>
    <div className="sb-foot">
      {s.phase === "interrupted" && <div className="conn-warn"><i className="dot" />Jarvis 上次被关掉了</div>}
      <div className="me"><span className="avatar">L</span><span className="me-name">Ludi</span><IconBtn label="设置"><Settings size={16} /></IconBtn></div>
    </div>
  </aside>;
}
