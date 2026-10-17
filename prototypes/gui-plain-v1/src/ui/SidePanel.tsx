import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Camera, Copy, ExternalLink, FileCode2, GitCompareArrows, Globe, Lock, Monitor, RotateCcw, RotateCw, Settings2, Smartphone, SquareArrowOutUpRight, Undo2, X } from "lucide-react";
import SegmentedControl from "../arc/segmented-control/segmented-control";
import { Button } from "../arc/button/button";
import type { Attachment, FileChange, Project, Step } from "../scenario";
import { Diffstat, IconBtn } from "./Bits";
import { copyText, useNotify } from "./feedback";

export type PanelTab = "changes" | "preview" | "terminal";
export type PageKind = "settings" | "home" | "input-dark" | "export" | "portfolio";
export const PAGE_LABEL: Record<PageKind, string> = { settings: "设置页", home: "首页", "input-dark": "设置页（深色）", export: "导出页", portfolio: "作品集首页" };

/** Everything the panel needs about one task, whether it is the live demo or a replayed record. */
export interface PanelData {
  key: string; files: FileChange[]; applied: boolean; pending: boolean; reverted: boolean; canRevertAll: boolean;
  runs: Step[]; project: Project; path: string; page: PageKind; interjected: boolean; emptyNote?: string;
  onRevert: (v: boolean) => void;
}

function DiffView({ f }: { f: FileChange }) {
  return <div className="diff" role="table" aria-label={`${f.name} 的改动`}>
    {f.lines.map((l, i) => l.t === "hunk"
      ? <div key={i} className="diff-hunk">{l.text}</div>
      : <div key={i} className={`diff-line is-${l.t}`}><span className="ln">{l.a ?? ""}</span><span className="ln">{l.b ?? ""}</span><span className="sign">{l.t === "add" ? "+" : l.t === "del" ? "−" : ""}</span><code>{l.text}</code></div>)}
  </div>;
}

function Changes({ d, file, setFile }: { d: PanelData; file: string | null; setFile: (p: string) => void }) {
  const notify = useNotify();
  const n = d.files.length;
  if (d.reverted && n) return <div className="panel-empty"><Undo2 size={20} /><h4>改动已撤销</h4><p>{n} 个文件都回到了改之前的样子。</p><Button size="sm" variant="secondary" onClick={() => d.onRevert(false)}><RotateCcw size={14} />恢复修改</Button></div>;
  if ((!d.applied && !d.pending) || !n) return <div className="panel-empty"><GitCompareArrows size={20} /><h4>{d.emptyNote ? "这个任务没有改文件" : "还没有改动"}</h4><p>{d.emptyNote ?? "Jarvis 改了文件以后，会在这里逐行列出来。"}</p></div>;
  const cur = d.files.find(f => f.path === file || f.name === file) ?? d.files[0];
  const add = d.files.reduce((a, f) => a + f.add, 0), del = d.files.reduce((a, f) => a + f.del, 0);
  const full = `${d.project.path}\\${cur.path.replace(/\//g, "\\")}`;
  return <div className="changes">
    <div className="changes-head">
      <span>{d.pending && !d.applied ? "准备修改" : "修改了"} {n} 个文件</span><Diffstat add={add} del={del} />
      {d.pending && !d.applied ? <span className="pill tone-warning">等你确认</span> : <span className="grow" />}
      {d.canRevertAll && <Button size="sm" variant="ghost" onClick={() => d.onRevert(true)}><Undo2 size={14} />全部撤销</Button>}
    </div>
    <div className="file-tabs" role="tablist">{d.files.map(f => <button key={f.path} role="tab" aria-selected={f.path === cur.path} className="file-tab" onClick={() => setFile(f.path)}><FileCode2 size={14} /><span>{f.name}</span><Diffstat add={f.add} del={f.del} /></button>)}</div>
    <div className="file-path"><span className="mono">{cur.path}</span><span className="grow" />
      <IconBtn className="sb-mini" label="复制路径" onClick={() => copyText(full).then(ok => notify(ok ? { text: "已复制文件路径" } : { tone: "info", text: "浏览器没允许复制" }))}><Copy size={13} /></IconBtn>
      <IconBtn className="sb-mini" label="在编辑器里打开" onClick={() => notify({ tone: "info", icon: <SquareArrowOutUpRight size={15} />, text: `演示稿：会用你的编辑器打开 ${cur.name}` })}><SquareArrowOutUpRight size={13} /></IconBtn>
    </div>
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

const WORKS = ["Arc 组件库", "Jarvis 桌面端", "PastaUI 走查"];
function PageMock({ page, after, interjected, marks, compact }: { page: PageKind; after: boolean; interjected: boolean; marks?: boolean; compact?: boolean }) {
  const c = compact ? " is-compact" : "";
  switch (page) {
    case "settings": return <MockSettings after={after} interjected={interjected} marks={marks} compact={compact} />;
    case "home": return <div className={`mock${c}`} aria-hidden>
      <div className="mock-title">首页</div><div className="mock-sub">最近的任务</div>
      <div className="mock-empty">{after
        ? <><b>还没有任务</b><span>说说你想改什么，Jarvis 会先看代码再动手。</span><span className="mock-btn primary">新建任务{marks && <b className="mark">1</b>}</span></>
        : <><b>暂无会话数据</b><span>请先创建一个 Session 以开始。</span></>}</div>
    </div>;
    case "input-dark": return <div className={`mock is-dark${after ? " is-after" : ""}${c}`} aria-hidden>
      <div className="mock-title">设置</div><div className="mock-sub">深色模式</div>
      <label className="mock-field is-focus"><span>名称</span><i>Ludi{marks && after && <b className="mark">1</b>}</i></label>
      {!compact && <label className="mock-field"><span>邮箱</span><i>ludi@example.com</i></label>}
    </div>;
    case "export": return <div className={`mock${c}`} aria-hidden>
      <div className="mock-title">导出</div><div className="mock-sub">PNG · 2 倍图</div>
      <div className="mock-canvas"><span className="mock-shape" /></div>
      <div className="mock-foot"><span className="mock-btn primary">导出 PNG</span></div>
    </div>;
    case "portfolio": return <div className={`mock pf${after ? " is-after" : ""}${c}`} aria-hidden>
      <div className="pf-grid">
        <aside className="pf-side"><div className="mock-title">Ludi Herry</div><div className="mock-sub">UX 设计师</div>{after && <span className="mock-btn">联系我{marks && <b className="mark">1</b>}</span>}</aside>
        <section className="pf-main">{WORKS.slice(0, compact ? 2 : 3).map(w => <div key={w} className="pf-card"><i /><span>{w}</span></div>)}</section>
      </div>
    </div>;
  }
}

const NOTES: Record<PageKind, (interjected: boolean) => { n?: number; title: string; text: string }[]> = {
  settings: i => [{ n: 1, title: "保存按钮", text: "次要样式 → 主按钮（蓝底白字），圆角 6px → 10px" }, ...(i ? [{ n: 2, title: "取消按钮", text: "次要样式 → 文字按钮，圆角 6px → 10px" }] : []), { title: "", text: "输入框没动，圆角本来就是 10px" }],
  home: () => [{ n: 1, title: "新建任务按钮", text: "新加的，点了直接开始" }, { title: "", text: "标题和说明换成了日常说法" }],
  "input-dark": () => [{ n: 1, title: "输入框边框", text: "改用主题的边框变量，聚焦时多一圈浅色光环" }],
  export: () => [],
  portfolio: () => [{ n: 1, title: "首页布局", text: "单栏 → 两栏，左栏滚动时固定，加了「联系我」" }, { title: "", text: "内容最宽从 720px 放到 1120px" }],
};

function Preview({ d, onShot, onSetUrl }: { d: PanelData; onShot: (a: Attachment) => void; onSetUrl: () => void }) {
  const notify = useNotify();
  const [view, setView] = useState<"before" | "compare" | "after">("compare");
  const [vp, setVp] = useState<"desktop" | "mobile">("desktop");
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (!d.project.previewUrl) return <div className="panel-empty"><Globe size={20} /><h4>还没设置预览地址</h4><p>填上 {d.project.name} 本机开发服务器的地址（比如 http://localhost:4321），改完界面就能在这里直接看效果。</p><Button size="sm" variant="secondary" onClick={onSetUrl}><Settings2 size={14} />去设置</Button></div>;
  const pending = d.pending && !d.applied;
  const has = (d.applied || d.pending) && !d.reverted && d.files.length > 0;
  const v = has ? view : "before";
  const host = d.project.previewUrl.replace(/^https?:\/\//, "");
  const full = `${d.project.previewUrl}${d.path}`;
  const reload = () => { if (loading) return; setLoading(true); timer.current = window.setTimeout(() => { setLoading(false); setNonce(n => n + 1); }, 650); };
  const notes = has ? NOTES[d.page](d.interjected) : [];
  return <div className="preview">
    <div className="browser">
      <div className="browser-bar">
        <IconBtn className="sb-mini" label="后退" disabled><ArrowLeft size={14} /></IconBtn>
        <IconBtn className="sb-mini" label="前进" disabled><ArrowRight size={14} /></IconBtn>
        <IconBtn className={`sb-mini${loading ? " is-spinning" : ""}`} label="刷新" onClick={reload}><RotateCw size={14} /></IconBtn>
        <span className="addr"><Globe size={12} className="muted-ico" /><span className="addr-url mono">{host}{d.path}</span>
          <span className={`live-tag${pending ? " is-pending" : ""}`}><i className="dot" />{pending ? "预计效果" : has ? "已自动刷新" : "实时"}</span></span>
        <IconBtn className="sb-mini" label={vp === "desktop" ? "换成手机宽度" : "换成桌面宽度"} onClick={() => setVp(x => x === "desktop" ? "mobile" : "desktop")}>{vp === "desktop" ? <Smartphone size={14} /> : <Monitor size={14} />}</IconBtn>
        <IconBtn className="sb-mini" label="在浏览器中打开" onClick={() => notify({ tone: "info", icon: <ExternalLink size={15} />, text: `演示稿：会用系统浏览器打开 ${full}` })}><ExternalLink size={14} /></IconBtn>
        {loading && <span className="browser-progress" />}
      </div>
      <div key={nonce} className={`browser-stage${v === "compare" ? " is-compare" : ""}${vp === "mobile" ? " is-mobile" : ""}${loading ? " is-loading" : ""}`}>
        {v === "compare" ? <>
          <figure className="cmp-col"><figcaption>改之前</figcaption><div className="cmp-frame"><PageMock page={d.page} after={false} interjected={d.interjected} compact /></div></figure>
          <figure className="cmp-col"><figcaption>{pending ? "改之后（预计）" : "改之后"}</figcaption><div className="cmp-frame"><PageMock page={d.page} after interjected={d.interjected} marks compact /></div></figure>
        </> : <div className="vp"><PageMock page={d.page} after={v === "after"} interjected={d.interjected} marks={v === "after"} /></div>}
      </div>
    </div>
    <div className="preview-bar">
      {has ? <SegmentedControl label="预览方式" value={view} onValueChange={x => setView(x as typeof view)} options={[{ value: "before", label: "改之前" }, { value: "compare", label: "对比" }, { value: "after", label: "改之后" }]} /> : <span className="muted">{d.reverted ? "改动已撤销，显示的是现在的页面" : "还没有改动，显示的是当前页面"}</span>}
      <span className="grow" />
      <Button size="sm" variant="secondary" onClick={() => onShot({ label: `预览截图 · ${PAGE_LABEL[d.page]}`, kind: "image" })}><Camera size={14} />截图发给 Jarvis</Button>
    </div>
    {pending && <p className="pending-note">这是按方案预先渲染的效果，你点「允许」后才会真的改文件。</p>}
    {notes.length > 0 && <ol className="change-notes">{notes.map((x, i) => x.n
      ? <li key={i}><b className="mark">{x.n}</b><span><strong>{x.title}</strong>{x.text}</span></li>
      : <li key={i} className="muted-note">{x.text}</li>)}</ol>}
  </div>;
}

function Terminal({ d }: { d: PanelData }) {
  const notify = useNotify();
  if (!d.runs.length) return <div className="panel-empty"><span className="mono big">&gt;_</span><h4>还没跑过命令</h4><p>Jarvis 跑测试、类型检查时，完整输出都在这里。</p></div>;
  const body = d.runs.map(r => `$ ${r.target}\n${r.status === "running" ? "…" : (r.output ?? []).join("\n")}\n${r.status === "running" ? "" : r.status === "failed" ? "× 没通过（退出码 1）" : "√ 完成"}\n`).join("\n");
  return <div className="term">
    <div className="term-head"><Lock size={12} />只在 {d.project.name} 文件夹里运行<span className="grow" />
      <button type="button" className="term-copy" onClick={() => copyText(body).then(ok => notify(ok ? { text: "已复制终端输出" } : { tone: "info", text: "浏览器没允许复制" }))}><Copy size={12} />复制</button></div>
    <pre className="term-body">{body}</pre>
  </div>;
}

export function SidePanel({ d, tab, setTab, file, setFile, onClose, onShot, onSetUrl }: { d: PanelData; tab: PanelTab; setTab: (t: PanelTab) => void; file: string | null; setFile: (p: string) => void; onClose: () => void; onShot: (a: Attachment) => void; onSetUrl: () => void }) {
  const n = (d.applied || d.pending) && !d.reverted ? d.files.length : 0;
  return <aside className="panel" aria-label="更改、预览和终端">
    <div className="panel-head">
      <SegmentedControl label="面板" value={tab} onValueChange={v => setTab(v as PanelTab)} options={[{ value: "changes", label: "更改", accessory: n ? <span className="seg-count">{n}</span> : undefined }, { value: "preview", label: "预览" }, { value: "terminal", label: "终端" }]} />
      <span className="grow" />
      <IconBtn label="关闭面板" onClick={onClose}><X size={16} /></IconBtn>
    </div>
    <div className="panel-body">
      {tab === "changes" && <Changes d={d} file={file} setFile={setFile} />}
      {tab === "preview" && <Preview key={d.key} d={d} onShot={onShot} onSetUrl={onSetUrl} />}
      {tab === "terminal" && <Terminal d={d} />}
    </div>
  </aside>;
}
