// Scripted demo task. Everything here is fake data for the prototype; copy is the point.
export type Mode = "discuss" | "ask" | "auto";
export type Phase = "empty" | "running" | "approval" | "complete" | "failed" | "interrupted" | "stopped" | "idle";
export type StepType = "read" | "search" | "edit" | "run" | "think";
export interface Step { id: string; type: StepType; label: string; target?: string; ms: number; status: "running" | "done" | "failed"; output?: string[] }
export interface DiffLine { t: "ctx" | "add" | "del" | "hunk"; a?: number; b?: number; text: string }
export interface FileChange { path: string; name: string; dir: string; add: number; del: number; lines: DiffLine[] }

export type Item =
  | { kind: "user"; id: string; text: string; interject?: boolean }
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

export const OTHER_TASKS = [
  { id: "t2", title: "首页空状态的文案改得更友好", meta: "2 小时前", add: 8, del: 3 },
  { id: "t3", title: "修复深色模式下输入框的边框", meta: "昨天", add: 4, del: 4 },
  { id: "t4", title: "导出 PNG 时保留透明背景", meta: "周一", add: 0, del: 0, stopped: true },
];
