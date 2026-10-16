// Scripted demo task. Everything here is fake data for the prototype; copy is the point.
export type Mode = "discuss" | "ask" | "auto";
export type Phase = "empty" | "running" | "approval" | "complete" | "failed" | "interrupted" | "stopped" | "idle";
export type StepType = "read" | "search" | "edit" | "run" | "think";
export interface Step { id: string; type: StepType; label: string; target?: string; ms: number; status: "running" | "done" | "failed"; output?: string[] }
export interface DiffLine { t: "ctx" | "add" | "del" | "hunk"; a?: number; b?: number; text: string }
export interface FileChange { path: string; name: string; dir: string; add: number; del: number; lines: DiffLine[] }

export interface Attachment { label: string; kind: "image" | "file"; url?: string }

export type Item =
  | { kind: "user"; id: string; text: string; interject?: boolean; attachments?: Attachment[] }
  | { kind: "text"; id: string; text: string; animate?: boolean }
  | { kind: "steps"; id: string; steps: Step[] }
  | { kind: "approval"; id: string; resolved?: "allowed" | "denied" | "allowed-all" | "adjusted" }
  | { kind: "result"; id: string; outcome: "done" | "failed"; reverted?: boolean }
  | { kind: "notice"; id: string; tone: "stopped" | "interrupted" | "denied" | "discuss" | "resumed" | "demo" };

export const TASK_PROMPT = "把设置页的「保存」按钮改成主按钮样式，圆角跟输入框一致";
export const INTERJECT = "取消按钮也顺手改成文字按钮";

export function files(interjected: boolean, reverted = false): FileChange[] {
  if (reverted) return [];
  const panel: FileChange = {
    path: "src/settings/SettingsPanel.tsx", name: "SettingsPanel.tsx", dir: "src/settings",
    add: interjected ? 2 : 1, del: interjected ? 2 : 1,
    lines: [
      { t: "hunk", text: "@@ -40,8 +40,8 @@ export function SettingsPanel()" },
      { t: "ctx", a: 40, b: 40, text: "  return (" },
      { t: "ctx", a: 41, b: 41, text: '    <footer className="settings-footer">' },
      ...(interjected
        ? [{ t: "del", a: 42, text: '      <Button variant="secondary" onClick={onCancel}>取消</Button>' } as DiffLine,
           { t: "add", b: 42, text: '      <Button variant="ghost" onClick={onCancel}>取消</Button>' } as DiffLine]
        : [{ t: "ctx", a: 42, b: 42, text: '      <Button variant="secondary" onClick={onCancel}>取消</Button>' } as DiffLine]),
      { t: "del", a: 43, text: '      <Button variant="secondary" onClick={onSave}>保存</Button>' },
      { t: "add", b: 43, text: '      <Button variant="primary" onClick={onSave}>保存</Button>' },
      { t: "ctx", a: 44, b: 44, text: "    </footer>" },
      { t: "ctx", a: 45, b: 45, text: "  );" },
    ],
  };
  const css: FileChange = {
    path: "src/styles/button.css", name: "button.css", dir: "src/styles", add: 6, del: 1,
    lines: [
      { t: "hunk", text: "@@ -12,6 +12,11 @@ .btn" },
      { t: "ctx", a: 12, b: 12, text: ".btn {" },
      { t: "ctx", a: 13, b: 13, text: "  height: 36px;" },
      { t: "del", a: 14, text: "  border-radius: 6px;" },
      { t: "add", b: 14, text: "  border-radius: var(--radius-input); /* 10px，与输入框一致 */" },
      { t: "ctx", a: 15, b: 15, text: "  font-weight: 500;" },
      { t: "ctx", a: 16, b: 16, text: "}" },
      { t: "add", b: 17, text: ".btn-primary {" },
      { t: "add", b: 18, text: "  background: var(--color-primary);" },
      { t: "add", b: 19, text: "  color: #fff;" },
      { t: "add", b: 20, text: "}" },
      { t: "add", b: 21, text: ".btn-primary:hover { background: var(--color-primary-hover); }" },
    ],
  };
  return [panel, css];
}

export const READ_STEPS: Step[] = [
  { id: "s1", type: "read", label: "看了设置页", target: "src/settings/SettingsPanel.tsx", ms: 400, status: "done" },
  { id: "s2", type: "read", label: "看了按钮样式", target: "src/styles/button.css", ms: 300, status: "done" },
  { id: "s3", type: "search", label: "查了圆角变量", target: "“radius” · 找到 3 处", ms: 600, status: "done" },
];
export const CHECK_OK: Step = { id: "c1", type: "run", label: "跑了设置页的测试", target: "npm test -- settings", ms: 1800, status: "done", output: ["PASS  src/settings/SettingsPanel.test.tsx", "  √ 渲染保存与取消按钮 (34 ms)", "  √ 保存按钮使用主样式 (12 ms)", "  … 共 12 项", "Tests: 12 passed, 12 total"] };
export const CHECK_TYPES: Step = { id: "c2", type: "run", label: "做了类型检查", target: "npx tsc --noEmit", ms: 2400, status: "done", output: ["没有类型错误"] };
export const CHECK_FAIL: Step = { id: "c1", type: "run", label: "跑了设置页的测试", target: "npm test -- settings", ms: 1900, status: "failed", output: ["FAIL  src/settings/SettingsPanel.test.tsx", "  × 设置页快照 (41 ms)", "    - Snapshot  1", "    + Received  1", '    -   <Button variant="secondary">保存</Button>', '    +   <Button variant="primary">保存</Button>', "Tests: 1 failed, 11 passed, 12 total"] };

export const COPY = {
  ack: "好的。我先看看设置页和按钮样式现在是怎么写的。",
  plan: "保存按钮现在用的是次要样式，圆角 6px；输入框是 10px。我把它换成主按钮，圆角统一用输入框的变量。",
  interjectAck: "收到，取消按钮一起改成文字按钮（ghost 样式）。",
  doneText: "改好了。保存按钮现在是主按钮样式，圆角和输入框一致（10px）。",
  doneTextInterject: "改好了。保存按钮换成了主按钮，取消按钮改成了文字按钮，圆角都和输入框一致（10px）。",
  failText: "改完了，但设置页的快照测试没通过：快照里存的还是旧按钮。这是预期内的变化，更新快照就行。",
  discussText: "只讨论模式下我不会改文件。我的做法是：① 把保存按钮换成 primary；② 圆角改用输入框的 --radius-input（10px）；③ 跑设置页测试确认没破坏别的地方。要我动手吗？",
  fixUser: "帮我修好没通过的测试",
  fixAck: "这是预期内的快照变化，我更新快照后再跑一遍。",
};

export const PERMISSIONS: { value: Mode; label: string; desc: string }[] = [
  { value: "discuss", label: "只讨论", desc: "只看、只聊，不改任何文件" },
  { value: "ask", label: "改之前问我", desc: "改文件前先停下来问你" },
  { value: "auto", label: "自动", desc: "直接改，改完给你看结果，随时能撤销" },
];

export interface Project { id: string; name: string; path: string; previewUrl?: string }
export const PROJECTS: Project[] = [
  { id: "jarvis-agent", name: "jarvis-agent", path: "H:\\jarvis-agent", previewUrl: "http://localhost:5173" },
  { id: "portfolio-site", name: "portfolio-site", path: "H:\\portfolio-site" },
];

/** Earlier tasks in the sidebar. They only replay their record; the prototype has one live script. */
export interface PastTask {
  id: string; project: string; title: string; meta: string; prompt: string; reply: string;
  outcome: "done" | "stopped"; files: FileChange[]; steps: Step[]; cost: number; elapsed: string; previewPath: string;
}

const run = (id: string, label: string, target: string, output: string[], ms = 1600): Step => ({ id, type: "run", label, target, ms, status: "done", output });

export const PAST_TASKS: PastTask[] = [
  {
    id: "t2", project: "jarvis-agent", title: "首页空状态的文案改得更友好", meta: "2 小时前", previewPath: "/",
    prompt: "首页空状态的提示文字改得更友好，别用技术词", outcome: "done", cost: 0.21, elapsed: "48 秒",
    reply: "改好了。空状态标题从「暂无会话数据」改成「还没有任务」，说明换成了日常说法，还加了一个「新建任务」按钮。",
    steps: [
      { id: "h21", type: "read", label: "看了空状态组件", target: "src/home/EmptyState.tsx", ms: 300, status: "done" },
      { id: "h22", type: "search", label: "查了文案配置", target: "“empty” · 找到 2 处", ms: 500, status: "done" },
      { id: "h23", type: "edit", label: "改了空状态", target: "EmptyState.tsx", ms: 400, status: "done" },
      { id: "h24", type: "edit", label: "改了文案", target: "zh.json", ms: 300, status: "done" },
      run("h25", "跑了首页的测试", "npm test -- home", ["PASS  src/home/EmptyState.test.tsx", "  √ 显示友好的空状态 (21 ms)", "Tests: 6 passed, 6 total"]),
    ],
    files: [
      { path: "src/home/EmptyState.tsx", name: "EmptyState.tsx", dir: "src/home", add: 5, del: 2, lines: [
        { t: "hunk", text: "@@ -8,6 +8,9 @@ export function EmptyState({ onNew })" },
        { t: "ctx", a: 8, b: 8, text: "  return (" },
        { t: "ctx", a: 9, b: 9, text: '    <div className="empty">' },
        { t: "del", a: 10, text: "      <h2>暂无会话数据</h2>" },
        { t: "del", a: 11, text: "      <p>请先创建一个 Session 以开始。</p>" },
        { t: "add", b: 10, text: '      <h2>{t("empty.title")}</h2>' },
        { t: "add", b: 11, text: '      <p>{t("empty.body")}</p>' },
        { t: "add", b: 12, text: '      <Button variant="primary" onClick={onNew}>' },
        { t: "add", b: 13, text: '        {t("empty.cta")}' },
        { t: "add", b: 14, text: "      </Button>" },
        { t: "ctx", a: 12, b: 15, text: "    </div>" },
      ] },
      { path: "src/i18n/zh.json", name: "zh.json", dir: "src/i18n", add: 3, del: 1, lines: [
        { t: "hunk", text: "@@ -21,3 +21,5 @@" },
        { t: "ctx", a: 21, b: 21, text: '  "nav.settings": "设置",' },
        { t: "del", a: 22, text: '  "empty": "暂无数据"' },
        { t: "add", b: 22, text: '  "empty.title": "还没有任务",' },
        { t: "add", b: 23, text: '  "empty.body": "说说你想改什么，Jarvis 会先看代码再动手。",' },
        { t: "add", b: 24, text: '  "empty.cta": "新建任务"' },
        { t: "ctx", a: 23, b: 25, text: "}" },
      ] },
    ],
  },
  {
    id: "t3", project: "jarvis-agent", title: "修复深色模式下输入框的边框", meta: "昨天", previewPath: "/settings",
    prompt: "深色模式下输入框的边框看不见，帮我修一下", outcome: "done", cost: 0.14, elapsed: "36 秒",
    reply: "修好了。深色模式下输入框改用主题里的边框和背景变量，聚焦时多了一圈浅色光环，不再看不见。",
    steps: [
      { id: "h31", type: "read", label: "看了输入框样式", target: "src/styles/input.css", ms: 300, status: "done" },
      { id: "h32", type: "edit", label: "改了输入框样式", target: "input.css", ms: 400, status: "done" },
      run("h33", "做了类型检查", "npx tsc --noEmit", ["没有类型错误"], 2100),
    ],
    files: [
      { path: "src/styles/input.css", name: "input.css", dir: "src/styles", add: 4, del: 4, lines: [
        { t: "hunk", text: "@@ -30,8 +30,8 @@ .input" },
        { t: "ctx", a: 30, b: 30, text: '[data-theme="dark"] .input {' },
        { t: "del", a: 31, text: "  border-color: #27272a;" },
        { t: "del", a: 32, text: "  background: #18181b;" },
        { t: "add", b: 31, text: "  border-color: var(--border-strong);" },
        { t: "add", b: 32, text: "  background: var(--surface);" },
        { t: "ctx", a: 33, b: 33, text: "}" },
        { t: "ctx", a: 34, b: 34, text: '[data-theme="dark"] .input:focus {' },
        { t: "del", a: 35, text: "  border-color: #3f3f46;" },
        { t: "del", a: 36, text: "  box-shadow: none;" },
        { t: "add", b: 35, text: "  border-color: var(--ring);" },
        { t: "add", b: 36, text: "  box-shadow: 0 0 0 3px var(--ring-subtle);" },
        { t: "ctx", a: 37, b: 37, text: "}" },
      ] },
    ],
  },
  {
    id: "t4", project: "jarvis-agent", title: "导出 PNG 时保留透明背景", meta: "周一", previewPath: "/export",
    prompt: "导出 PNG 的时候背景变成白色了，帮我保留透明背景", outcome: "stopped", cost: 0.06, elapsed: "19 秒",
    reply: "找到原因了：导出前画布先被填成了白色。我打算只在用户选了「白色背景」时才填充。",
    steps: [
      { id: "h41", type: "read", label: "看了导出逻辑", target: "src/export/png.ts", ms: 300, status: "done" },
      { id: "h42", type: "search", label: "查了画布填充", target: "“fillRect” · 找到 2 处", ms: 500, status: "done" },
    ],
    files: [],
  },
  {
    id: "p1", project: "portfolio-site", title: "作品集首页换成两栏布局", meta: "10月8日", previewPath: "/",
    prompt: "作品集首页换成两栏：左边个人介绍固定，右边是作品列表", outcome: "done", cost: 0.32, elapsed: "1 分 12 秒",
    reply: "改好了。首页变成两栏：左边是介绍和联系方式，滚动时固定；右边是作品列表，最宽 1120px。",
    steps: [
      { id: "p11", type: "read", label: "看了首页", target: "src/pages/index.astro", ms: 300, status: "done" },
      { id: "p12", type: "read", label: "看了首页样式", target: "src/styles/home.css", ms: 300, status: "done" },
      { id: "p13", type: "edit", label: "改了首页结构", target: "index.astro", ms: 500, status: "done" },
      { id: "p14", type: "edit", label: "改了首页样式", target: "home.css", ms: 400, status: "done" },
      run("p15", "构建了一遍", "npm run build", ["building 14 pages…", "✓ built in 3.2s"], 3400),
    ],
    files: [
      { path: "src/pages/index.astro", name: "index.astro", dir: "src/pages", add: 6, del: 3, lines: [
        { t: "hunk", text: "@@ -12,5 +12,8 @@" },
        { t: "ctx", a: 12, b: 12, text: '<main class="home">' },
        { t: "del", a: 13, text: "  <Intro />" },
        { t: "del", a: 14, text: "  <ProjectList />" },
        { t: "del", a: 15, text: "  <Contact />" },
        { t: "add", b: 13, text: '  <div class="home-grid">' },
        { t: "add", b: 14, text: '    <aside class="home-side"><Intro /><Contact /></aside>' },
        { t: "add", b: 15, text: '    <section class="home-main">' },
        { t: "add", b: 16, text: "      <ProjectList />" },
        { t: "add", b: 17, text: "    </section>" },
        { t: "add", b: 18, text: "  </div>" },
        { t: "ctx", a: 16, b: 19, text: "</main>" },
      ] },
      { path: "src/styles/home.css", name: "home.css", dir: "src/styles", add: 9, del: 2, lines: [
        { t: "hunk", text: "@@ -1,4 +1,11 @@" },
        { t: "ctx", a: 1, b: 1, text: ".home {" },
        { t: "del", a: 2, text: "  max-width: 720px;" },
        { t: "del", a: 3, text: "  margin: 0 auto;" },
        { t: "add", b: 2, text: "  max-width: 1120px;" },
        { t: "add", b: 3, text: "  margin: 0 auto;" },
        { t: "add", b: 4, text: "  padding: 48px 32px;" },
        { t: "ctx", a: 4, b: 5, text: "}" },
        { t: "add", b: 6, text: ".home-grid {" },
        { t: "add", b: 7, text: "  display: grid;" },
        { t: "add", b: 8, text: "  grid-template-columns: 320px minmax(0, 1fr);" },
        { t: "add", b: 9, text: "  gap: 48px;" },
        { t: "add", b: 10, text: "}" },
        { t: "add", b: 11, text: ".home-side { position: sticky; top: 48px; align-self: start; }" },
      ] },
    ],
  },
];

/** Only a local dev server may open by itself (same rule as the backend preview policy). */
export function checkPreviewUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  const v = raw.trim();
  if (!v) return { ok: false, reason: "请填一个地址，比如 http://localhost:5173" };
  let u: URL;
  try { u = new URL(/^[a-z]+:\/\//i.test(v) ? v : `http://${v}`); } catch { return { ok: false, reason: "这不是一个有效的地址" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "只支持 http 或 https 地址" };
  if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return { ok: false, reason: "自动预览只支持本机地址（localhost / 127.0.0.1）" };
  return { ok: true, url: `${u.protocol}//${u.host}` };
}
