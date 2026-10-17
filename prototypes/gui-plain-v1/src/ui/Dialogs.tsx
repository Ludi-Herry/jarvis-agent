import { useEffect, useState } from "react";
import { BookOpen, Cpu, FolderPlus, Globe, Palette, SlidersHorizontal, Trash2, Wallet } from "lucide-react";
import { Dialog, DialogContent } from "../arc/dialog/dialog";
import { Button } from "../arc/button/button";
import { Switch } from "../arc/switch/switch";
import SegmentedControl from "../arc/segmented-control/segmented-control";
import { checkPreviewUrl, PERMISSIONS, type Mode, type Project } from "../scenario";
import { MOD, type Prefs, type ThemePref } from "../prefs";
import type { SettingsSection } from "./Sidebar";
import { useNotify } from "./feedback";

const SECTIONS: { value: SettingsSection; label: string; icon: any }[] = [
  { value: "general", label: "通用", icon: SlidersHorizontal },
  { value: "appearance", label: "外观", icon: Palette },
  { value: "projects", label: "项目", icon: Globe },
  { value: "usage", label: "模型与用量", icon: Wallet },
  { value: "about", label: "关于", icon: BookOpen },
];

function Row({ title, desc, children, stack }: { title: string; desc?: string; children: React.ReactNode; stack?: boolean }) {
  return <div className={`set-row${stack ? " is-stack" : ""}`}><div className="set-text"><div className="set-title">{title}</div>{desc && <div className="set-desc">{desc}</div>}</div><div className="set-ctl">{children}</div></div>;
}

function ProjectCard({ p, focus, onSave, onRemove, canRemove }: { p: Project; focus: boolean; onSave: (url: string | undefined) => void; onRemove: () => void; canRemove: boolean }) {
  const [v, setV] = useState(p.previewUrl ?? "");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setV(p.previewUrl ?? ""); setErr(null); }, [p.previewUrl]);
  const dirty = v.trim() !== (p.previewUrl ?? "");
  const save = () => {
    if (!v.trim()) { onSave(undefined); setErr(null); return; }
    const r = checkPreviewUrl(v);
    if (!r.ok) { setErr(r.reason); return; }
    setErr(null); setV(r.url); onSave(r.url);
  };
  return <div className={`proj-card${focus ? " is-focus" : ""}`}>
    <div className="proj-head"><span className="proj-name">{p.name}</span><span className="proj-path mono">{p.path}</span>
      {canRemove && <Button size="sm" variant="ghost" onClick={onRemove} aria-label={`移除 ${p.name}`}><Trash2 size={14} />移除</Button>}
    </div>
    <label className="field">
      <span className="field-label">预览地址</span>
      <span className={`field-row${err ? " is-error" : ""}`}>
        <input value={v} autoFocus={focus} onChange={e => { setV(e.target.value); setErr(null); }} onKeyDown={e => { if (e.key === "Enter") save(); }} placeholder="http://localhost:5173" aria-invalid={!!err} aria-label={`${p.name} 的预览地址`} />
        <Button size="sm" variant={dirty ? "primary" : "secondary"} disabled={!dirty} onClick={save}>保存</Button>
      </span>
      <span className={`field-hint${err ? " tone-danger" : ""}`}>{err ?? (p.previewUrl ? "改了界面文件后，预览会自动打开这个本机页面" : "填上本机开发服务器的地址后，改了界面才能自动看预览")}</span>
    </label>
  </div>;
}

export function SettingsDialog({ open, onOpenChange, section, setSection, focusProject, prefs, patch, themePref, setThemePref, projects, onPreviewUrl, onRemoveProject, onAddProject, onOpenDock }: {
  open: boolean; onOpenChange: (v: boolean) => void; section: SettingsSection; setSection: (s: SettingsSection) => void; focusProject?: string;
  prefs: Prefs; patch: (p: Partial<Prefs>) => void; themePref: ThemePref; setThemePref: (t: ThemePref) => void;
  projects: Project[]; onPreviewUrl: (id: string, url: string | undefined) => void; onRemoveProject: (id: string) => void; onAddProject: () => void; onOpenDock: () => void;
}) {
  const notify = useNotify();
  const cur = SECTIONS.find(x => x.value === section)!;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="settings-dialog" title="设置" description="改动马上生效，只保存在这台电脑上。">
      <div className="settings">
        <nav className="set-nav" aria-label="设置分类">{SECTIONS.map(x => <button key={x.value} type="button" className={`set-nav-item${x.value === section ? " is-active" : ""}`} aria-current={x.value === section ? "page" : undefined} onClick={() => setSection(x.value)}><x.icon size={15} />{x.label}</button>)}</nav>
        <div className="set-body" key={section}>
          <h4 className="set-h">{cur.label}</h4>
          {section === "general" && <>
            <Row title="新任务默认可以做什么" desc="只影响之后新建的任务；正在做的任务在输入框里切。" stack>
              <SegmentedControl label="默认权限" value={prefs.defaultMode} onValueChange={v => patch({ defaultMode: v as Mode })} options={PERMISSIONS.map(p => ({ value: p.value, label: p.label }))} />
            </Row>
            <Row title="改完界面后自动打开预览" desc="只在改了界面文件、项目设置了本机预览地址时打开。"><Switch checked={prefs.autoPreview} onCheckedChange={v => patch({ autoPreview: v })} aria-label="改完界面后自动打开预览" /></Row>
            <Row title="发送消息" desc={prefs.sendKey === "enter" ? "Enter 发送，Shift Enter 换行" : `${MOD} Enter 发送，Enter 换行`} stack>
              <SegmentedControl label="发送方式" value={prefs.sendKey} onValueChange={v => patch({ sendKey: v as Prefs["sendKey"] })} options={[{ value: "enter", label: "Enter 发送" }, { value: "mod-enter", label: `${MOD} Enter 发送` }]} />
            </Row>
          </>}
          {section === "appearance" && <>
            <Row title="主题" desc="跟随系统时，会随 Windows 的深浅色一起切换。" stack>
              <SegmentedControl label="主题" value={themePref} onValueChange={v => setThemePref(v as ThemePref)} options={[{ value: "light", label: "浅色" }, { value: "dark", label: "深色" }, { value: "system", label: "跟随系统" }]} />
            </Row>
          </>}
          {section === "projects" && <>
            <p className="set-note">预览地址只接受本机地址（localhost、127.0.0.1），Jarvis 不会自己打开外网页面。</p>
            {projects.map(p => <ProjectCard key={p.id} p={p} focus={p.id === focusProject} canRemove={projects.length > 1} onSave={url => { onPreviewUrl(p.id, url); notify({ text: url ? `已保存 ${p.name} 的预览地址` : `已清空 ${p.name} 的预览地址` }); }} onRemove={() => onRemoveProject(p.id)} />)}
            <Button size="sm" variant="secondary" onClick={onAddProject}><FolderPlus size={14} />添加项目</Button>
          </>}
          {section === "usage" && <>
            <Row title="模型" desc="DeepSeek V4.1 Flash · 目前唯一接入的模型。"><span className="set-value"><Cpu size={14} />V4.1 Flash</span></Row>
            <Row title="每个任务的预算" desc="花到预算就自动停下，已改的文件都保留。" stack>
              <SegmentedControl label="每个任务的预算" value={String(prefs.budget)} onValueChange={v => patch({ budget: Number(v) })} options={[{ value: "1", label: "¥1" }, { value: "2", label: "¥2" }, { value: "5", label: "¥5" }]} />
            </Row>
            <Row title="最近 7 天" desc="演示数据"><span className="set-value">¥0.73 · 4 个任务</span></Row>
          </>}
          {section === "about" && <div className="about">
            <p><b>Jarvis 新界面对照稿（plain-v1）</b>。用来签收新界面的说法和交互，不连 Jarvis：对话、改动、预览、终端都是一条演示剧本。</p>
            <ul>
              <li>右上角「走查台」：切 6 个状态、拖动对照旧版、从头自动演示。</li>
              <li>左栏的历史任务只回放记录；只有「保存按钮改成主按钮样式」能真的跑一遍。</li>
              <li>设置会存在这台电脑的浏览器里，刷新后还在。</li>
            </ul>
            <div className="about-foot"><span className="muted">2026-10-15 · 组件：PastaUI 布局、Arc 控件</span><span className="grow" /><Button size="sm" variant="secondary" onClick={() => { onOpenChange(false); onOpenDock(); }}>打开走查台</Button></div>
          </div>}
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}

export function AddProjectDialog({ open, onOpenChange, projects, onAdd }: { open: boolean; onOpenChange: (v: boolean) => void; projects: Project[]; onAdd: (p: Project) => void }) {
  const [path, setPath] = useState("");
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<{ path?: string; url?: string }>({});
  useEffect(() => { if (open) { setPath(""); setUrl(""); setErr({}); } }, [open]);
  const name = path.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const submit = () => {
    const e: typeof err = {};
    if (!path.trim()) e.path = "请填项目所在的文件夹";
    else if (!/^([a-zA-Z]:[\\/]|\/|~)/.test(path.trim())) e.path = "请填完整路径，比如 H:\\my-site";
    else if (projects.some(p => p.name === name)) e.path = `已经有一个叫 ${name} 的项目了`;
    let previewUrl: string | undefined;
    if (url.trim()) { const r = checkPreviewUrl(url); if (!r.ok) e.url = r.reason; else previewUrl = r.url; }
    setErr(e);
    if (e.path || e.url) return;
    onAdd({ id: `${name}-${Date.now().toString(36)}`, name, path: path.trim(), previewUrl });
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent title="添加项目" description="Jarvis 只会在这个文件夹里读写文件、跑命令。演示稿不会真的读取你的硬盘。">
      <div className="form">
        <label className="field"><span className="field-label">文件夹路径</span>
          <span className={`field-row${err.path ? " is-error" : ""}`}><input autoFocus value={path} onChange={e => { setPath(e.target.value); setErr(v => ({ ...v, path: undefined })); }} onKeyDown={e => e.key === "Enter" && submit()} placeholder="H:\my-site" aria-invalid={!!err.path} /></span>
          <span className={`field-hint${err.path ? " tone-danger" : ""}`}>{err.path ?? (name ? `会显示为「${name}」` : "粘贴文件夹地址即可")}</span>
        </label>
        <label className="field"><span className="field-label">预览地址（可选）</span>
          <span className={`field-row${err.url ? " is-error" : ""}`}><input value={url} onChange={e => { setUrl(e.target.value); setErr(v => ({ ...v, url: undefined })); }} onKeyDown={e => e.key === "Enter" && submit()} placeholder="http://localhost:5173" aria-invalid={!!err.url} /></span>
          <span className={`field-hint${err.url ? " tone-danger" : ""}`}>{err.url ?? "只接受本机地址；之后也能在设置里改"}</span>
        </label>
      </div>
      <div className="adv-foot"><Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button><Button size="sm" onClick={submit}>添加</Button></div>
    </DialogContent>
  </Dialog>;
}

export const SHORTCUTS: { keys: string[]; label: string; note?: string }[] = [
  { keys: [MOD, "N"], label: "新建任务", note: "在浏览器里打开对照稿时用 Alt N" },
  { keys: [MOD, "K"], label: "搜索任务" },
  { keys: [MOD, "B"], label: "收起 / 展开左栏" },
  { keys: [MOD, "\\"], label: "打开 / 收起更改、预览、终端" },
  { keys: [MOD, ","], label: "设置" },
  { keys: [MOD, "G"], label: "切换对话 / 画布", note: "画布里用方向键走上一步、下一步" },
  { keys: ["Enter"], label: "发送（可在设置里改成 " + MOD + " Enter）" },
  { keys: ["Shift", "Enter"], label: "换行" },
  { keys: ["Esc"], label: "停止正在做的任务" },
  { keys: ["?"], label: "显示这张表" },
];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent title="键盘快捷键" description="输入框里打字时，单键快捷键不会触发。">
      <ul className="keys">{SHORTCUTS.map(k => <li key={k.label}><span className="keys-label">{k.label}{k.note && <small>{k.note}</small>}</span><span className="keys-combo">{k.keys.map(x => <kbd key={x}>{x}</kbd>)}</span></li>)}</ul>
    </DialogContent>
  </Dialog>;
}

export function AdvancedDialog({ open, onOpenChange, project, onEditPreview, budget }: { open: boolean; onOpenChange: (v: boolean) => void; project: Project; onEditPreview: () => void; budget: number }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent title="范围与预算" description="平时不用管：Jarvis 会按任务自动推断。这些限制在后台照常生效。">
      <dl className="adv">
        <div><dt>可以改的文件</dt><dd><code>src/settings/**</code> <code>src/styles/**</code><span className="auto">自动</span></dd></div>
        <div><dt>完成前要跑的检查</dt><dd><code>npm test -- settings</code> <code>npx tsc --noEmit</code><span className="auto">自动</span></dd></div>
        <div><dt>预算</dt><dd>¥{budget.toFixed(2)} · 最长 15 分钟<span className="auto">默认</span></dd></div>
        <div><dt>运行位置</dt><dd>只在 {project.name} 文件夹里</dd></div>
        <div><dt>预览地址</dt><dd>{project.previewUrl ? <code>{project.previewUrl}</code> : <span className="muted">还没设置</span>}<button type="button" className="inline-link" onClick={onEditPreview}>修改</button></dd></div>
      </dl>
      <div className="adv-foot"><Button size="sm" variant="secondary" onClick={() => onOpenChange(false)}>好的</Button></div>
    </DialogContent>
  </Dialog>;
}
