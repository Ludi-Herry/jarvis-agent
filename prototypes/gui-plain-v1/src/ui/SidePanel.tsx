import { useMemo, useState } from "react";
import { Camera, FileCode2, GitCompareArrows, RefreshCw, RotateCcw, Undo2, X, Lock } from "lucide-react";
import SegmentedControl from "../arc/segmented-control/segmented-control";
import { Button } from "../arc/button/button";
import type { Act, S } from "../store";
import { files, type FileChange, type Step } from "../scenario";
import { Diffstat, IconBtn } from "./Bits";

export type PanelTab = "changes" | "preview" | "terminal";

function DiffView({ f }: { f: FileChange }) {
  return <div className="diff" role="table" aria-label={`${f.name} 的改动`}>
    {f.lines.map((l, i) => l.t === "hunk"
      ? <div key={i} className="diff-hunk">{l.text}</div>
      : <div key={i} className={`diff-line is-${l.t}`}><span className="ln">{l.a ?? ""}</span><span className="ln">{l.b ?? ""}</span><span className="sign">{l.t === "add" ? "+" : l.t === "del" ? "−" : ""}</span><code>{l.text}</code></div>)}
  </div>;
}

function Changes({ s, act, file, setFile }: { s: S; act: Act; file: string | null; setFile: (p: string) => void }) {
  if (s.reverted) return <div className="panel-empty"><Undo2 size={20} /><h4>改动已撤销</h4><p>两个文件都回到了改之前的样子。</p><Button size="sm" variant="secondary" onClick={() => act({ type: "revert", value: false })}><RotateCcw size={14} />恢复修改</Button></div>;
  if (!s.applied && !s.pendingFiles) return <div className="panel-empty"><GitCompareArrows size={20} /><h4>还没有改动</h4><p>Jarvis 改了文件以后，会在这里逐行列出来。</p></div>;
  const fs = files(s.interjected);
  const cur = fs.find(f => f.path === file) ?? fs[0];
  const add = fs.reduce((a, f) => a + f.add, 0), del = fs.reduce((a, f) => a + f.del, 0);
  return <div className="changes">
    <div className="changes-head">
      <span>{s.pendingFiles ? "准备修改" : "修改了"} {fs.length} 个文件</span><Diffstat add={add} del={del} />
      {s.pendingFiles ? <span className="pill tone-warning">等你确认</span> : <span className="grow" />}
      {!s.pendingFiles && (s.phase === "complete" || s.phase === "failed") && <Button size="sm" variant="ghost" onClick={() => act({ type: "revert", value: true })}><Undo2 size={14} />全部撤销</Button>}
    </div>
    <div className="file-tabs" role="tablist">{fs.map(f => <button key={f.path} role="tab" aria-selected={f.path === cur.path} className="file-tab" onClick={() => setFile(f.path)}><FileCode2 size={14} /><span>{f.name}</span><Diffstat add={f.add} del={f.del} /></button>)}</div>
    <div className="file-path mono">{cur.path}</div>
    <DiffView f={cur} />
  </div>;
}

function MockSettings({ after, interjected, marks, compact }: { after: boolean; interjected: boolean; marks?: boolean; compact?: boolean }) {
  return <div className={`mock${after ? " is-after" : ""}${compact ? " is-compact" : ""}`} aria-hidden>
    <div className="mock-title">设置</div>
    <div className="mock-sub">个人资料</div>
    <label className="mock-field"><span>名称</span><i>Ludi</i></label>
    {!compact && <label className="mock-field"><span>邮箱</span><i>ludi@example.com</i></label>}
    <div className="mock-foot">
      <span className={`mock-btn ${after && interjected ? "ghost" : "secondary"}`}>取消{marks && after && interjected && <b className="mark">2</b>}</span>
      <span className={`mock-btn ${after ? "primary" : "secondary"}`}>保存{marks && after && <b className="mark">1</b>}</span>
    </div>
  </div>;
}

function Preview({ s, act, onShot }: { s: S; act: Act; onShot: () => void }) {
  const pending = s.pendingFiles && !s.applied;
  const has = (s.applied || s.pendingFiles) && !s.reverted;
  const [view, setView] = useState<"before" | "compare" | "after">("compare");
  const v = has ? view : "before";
  return <div className="preview">
    <div className="browser">
      <div className="browser-bar"><span className="dots"><i /><i /><i /></span><span className="url mono">localhost:5173/settings</span><span className={`live-tag${pending ? " is-pending" : ""}`}><i className="dot" />{pending ? "预计效果 · 还没改" : has ? "改完已自动刷新" : "实时"}</span><IconBtn label="刷新"><RefreshCw size={14} /></IconBtn></div>
      <div className={`browser-stage${v === "compare" ? " is-compare" : ""}`}>
        {v === "compare" ? <>
          <figure className="cmp-col"><figcaption>改之前</figcaption><div className="cmp-frame"><MockSettings after={false} interjected={s.interjected} compact /></div></figure>
          <figure className="cmp-col"><figcaption>{pending ? "改之后（预计）" : "改之后"}</figcaption><div className="cmp-frame"><MockSettings after interjected={s.interjected} marks compact /></div></figure>
        </> : <MockSettings after={v === "after"} interjected={s.interjected} marks={v === "after"} />}
      </div>
    </div>
    <div className="preview-bar">
      {has ? <SegmentedControl label="预览方式" value={view} onValueChange={v => setView(v as any)} options={[{ value: "before", label: "改之前" }, { value: "compare", label: "对比" }, { value: "after", label: "改之后" }]} /> : <span className="muted">还没有改动，显示的是当前页面</span>}
      <span className="grow" />
      <Button size="sm" variant="secondary" onClick={() => { act({ type: "attach", label: "预览截图 · 设置页" }); onShot(); }}><Camera size={14} />截图发给 Jarvis</Button>
    </div>
    {pending && <p className="pending-note">这是按方案预先渲染的效果，你点「允许」后才会真的改文件。</p>}
    {has && <ol className="change-notes">
      <li><b className="mark">1</b><span><strong>保存按钮</strong>次要样式 → 主按钮（蓝底白字），圆角 6px → 10px</span></li>
      {s.interjected && <li><b className="mark">2</b><span><strong>取消按钮</strong>次要样式 → 文字按钮，圆角 6px → 10px</span></li>}
      <li className="muted-note">输入框没动，圆角本来就是 10px</li>
    </ol>}
  </div>;
}

function Terminal({ s }: { s: S }) {
  const runs = useMemo(() => s.items.flatMap(i => i.kind === "steps" ? i.steps.filter(x => x.type === "run") : []) as Step[], [s.items]);
  if (!runs.length) return <div className="panel-empty"><span className="mono big">&gt;_</span><h4>还没跑过命令</h4><p>Jarvis 跑测试、类型检查时，完整输出都在这里。</p></div>;
  return <div className="term">
    <div className="term-head"><Lock size={12} />只在 jarvis-agent 文件夹里运行</div>
    <pre className="term-body">{runs.map(r => `$ ${r.target}\n${r.status === "running" ? "…" : (r.output ?? []).join("\n")}\n${r.status === "running" ? "" : r.status === "failed" ? "× 没通过（退出码 1）" : "√ 完成"}\n`).join("\n")}</pre>
  </div>;
}

export function SidePanel({ s, act, tab, setTab, file, setFile, onClose, onShot }: { s: S; act: Act; tab: PanelTab; setTab: (t: PanelTab) => void; file: string | null; setFile: (p: string) => void; onClose: () => void; onShot: () => void }) {
  const n = (s.applied || s.pendingFiles) && !s.reverted ? files(s.interjected).length : 0;
  return <aside className="panel" aria-label="更改、预览和终端">
    <div className="panel-head">
      <SegmentedControl label="面板" value={tab} onValueChange={v => setTab(v as PanelTab)} options={[{ value: "changes", label: "更改", accessory: n ? <span className="seg-count">{n}</span> : undefined }, { value: "preview", label: "预览" }, { value: "terminal", label: "终端" }]} />
      <span className="grow" />
      <IconBtn label="关闭面板" onClick={onClose}><X size={16} /></IconBtn>
    </div>
    <div className="panel-body">
      {tab === "changes" && <Changes s={s} act={act} file={file} setFile={setFile} />}
      {tab === "preview" && <Preview s={s} act={act} onShot={onShot} />}
      {tab === "terminal" && <Terminal s={s} />}
    </div>
  </aside>;
}
