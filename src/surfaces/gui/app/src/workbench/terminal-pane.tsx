import { useCallback, useState } from 'react';
import type { GuiLiveSnapshot, GuiTerminalEntry } from '../../../live-types.js';
import { formatTimestamp } from './format.js';

export const TERMINAL_COMMAND_MAX_LENGTH = 2000;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : '操作未完成，请检查当前状态后重试。';
}

/** The open row is the projection's last history entry while a command runs (batch 3 §D14 fold). */
function entryStatus(entry: GuiTerminalEntry, open: boolean): string {
  if (open) return '运行中';
  // Batch 5 §恢复: a journaled cancel cause distinguishes timeout from a user cancel.
  if (entry.canceled) return entry.cause === 'timeout' ? '超时自动结束' : entry.cause === 'interrupted' ? '宿主退出，命令中断' : '已取消';
  if (entry.code !== null) return `完成 · 退出码 ${entry.code}`;
  return '超时/中断';
}

/**
 * Batch 3 §D14–§D18 UI: the attended desk-side terminal. Everything rendered comes from
 * `snapshot.terminal` (folded from gui_terminal journal events); the running row streams via SSE.
 * Terminal output is observation only — it never enters the evidence/checks/diff authority (§D18).
 */
export function TerminalPane({ snapshot, pending, runTerminal, cancelTerminal }: {
  readonly snapshot: GuiLiveSnapshot | null;
  readonly pending: boolean;
  readonly runTerminal: (command: string) => Promise<unknown>;
  readonly cancelTerminal: () => Promise<unknown>;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(() => {
    const command = draft.trim();
    if (command === '') return;
    setError(null);
    void runTerminal(command)
      .then(() => setDraft(''))
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [draft, runTerminal]);

  const cancel = useCallback(() => {
    setError(null);
    void cancelTerminal().catch((cause: unknown) => setError(errorMessage(cause)));
  }, [cancelTerminal]);

  if (snapshot === null) {
    return <div className="live-evidence-pane wb-terminal-pane"><p className="live-muted">先选择任务。</p></div>;
  }

  const terminal = snapshot.terminal ?? { running: null, history: [] };
  const running = terminal.running !== null;
  const lastIndex = terminal.history.length - 1;
  const rows = terminal.history
    .map((entry, index) => ({ entry, open: running && index === lastIndex }))
    .reverse();

  return (
    <div className="live-evidence-pane wb-terminal-pane">
      <div className="wb-terminal-bar">
        <input
          type="text"
          value={draft}
          maxLength={TERMINAL_COMMAND_MAX_LENGTH}
          spellCheck={false}
          placeholder="在任务工作区运行桌边命令"
          aria-label="桌边命令"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
        />
        <button type="button" disabled={draft.trim() === '' || running || pending} onClick={submit}>运行</button>
        <button type="button" disabled={!running || pending} onClick={cancel}>取消</button>
      </div>

      {running ? <p className="wb-terminal-running">正在运行：<code>{terminal.running?.command}</code>（输出随实时刷新追加）</p> : null}
      {error !== null ? <p className="wb-terminal-error" role="alert">{error}</p> : null}

      {rows.length === 0 ? (
        <p className="live-muted">还没有桌边命令记录。命令在任务工作区内运行，输出留痕于此，不进入验证与 Diff 证据链。</p>
      ) : (
        <ul className="wb-terminal-list">
          {rows.map(({ entry, open }, index) => (
            <li key={`${index}:${entry.command}:${entry.at}`} data-open={open}>
              <div className="wb-terminal-row-head">
                <code>{entry.command}</code>
                <strong>{entryStatus(entry, open)}</strong>
                <time>{formatTimestamp(entry.at)}</time>
              </div>
              {entry.output !== '' ? <pre>{entry.output}</pre> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
