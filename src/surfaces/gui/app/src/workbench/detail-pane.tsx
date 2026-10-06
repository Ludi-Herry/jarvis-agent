import { type RefObject } from 'react';
import type { GuiLiveOverview, GuiLiveSnapshot, GuiTool } from '../../../live-types.js';
import { ContextEvidence, DiffEvidence, VerificationEvidence } from './evidence.js';
import { toolStatusLabels } from './format.js';
import { ChevronIcon } from './icons.js';
import type { EvidenceTab } from './prefs.js';
import { PreviewPane } from './preview-pane.js';
import { deriveSubagents } from './subagents.js';
import { TerminalPane } from './terminal-pane.js';

const EVIDENCE_TABS = [
  ['diff', 'Diff / 产物'],
  ['verification', '验证'],
  ['context', '上下文'],
  ['subagents', '子智能体'],
  ['preview', '预览'],
  ['terminal', '终端'],
] as const;

/** Batch 3 §B7: subagent delegations derived from task tool calls; honest empty state otherwise. */
function SubagentsEvidence({ snapshot }: { readonly snapshot: GuiLiveSnapshot | null }) {
  if (snapshot === null) {
    return <div className="live-evidence-pane"><p className="live-muted">启动任务后显示子智能体委派。</p></div>;
  }
  const subagents = deriveSubagents(snapshot.tools);
  if (subagents.length === 0) {
    return <div className="live-evidence-pane"><p className="live-muted">本次运行还没有委派子智能体。</p></div>;
  }
  return (
    <div className="live-evidence-pane">
      <ul className="wb-subagent-list">
        {subagents.map((agent) => (
          <li key={agent.id}>
            <div className="wb-subagent-head">
              <strong>{agent.role}</strong>
              <em data-status={agent.status}>{toolStatusLabels[agent.status]}</em>
            </div>
            <p>{agent.taskSummary}</p>
            {agent.resultPreview !== '' ? <pre>{agent.resultPreview}</pre> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Evidence drawer: closed by default, opened by clicking a tool, a file or a diff link. */
export function DetailPane({
  overview,
  snapshot,
  streamWarning,
  selectedTool,
  evidenceTab,
  detailRef,
  evidenceRef,
  expanded,
  taskId,
  actionPending,
  runTerminal,
  cancelTerminal,
  onTab,
  onToggleExpanded,
  onClose,
  onContextScroll,
  getGit,
}: {
  readonly overview: GuiLiveOverview | null;
  readonly snapshot: GuiLiveSnapshot | null;
  readonly streamWarning: string | null;
  readonly selectedTool: GuiTool | null;
  readonly evidenceTab: EvidenceTab;
  readonly detailRef: (node: HTMLElement | null) => void;
  readonly evidenceRef: RefObject<HTMLElement | null>;
  readonly expanded: boolean;
  readonly taskId: string | null;
  readonly actionPending: boolean;
  readonly runTerminal: (command: string) => Promise<unknown>;
  readonly cancelTerminal: () => Promise<unknown>;
  readonly onTab: (tab: EvidenceTab) => void;
  readonly onToggleExpanded: () => void;
  readonly onClose: () => void;
  readonly onContextScroll: (event: { readonly currentTarget: HTMLElement }) => void;
  readonly getGit?: (id: string) => Promise<import('../../../live-types.js').GuiGitStatus>;
}) {
  return (
    <aside
      ref={detailRef}
      className="context-panel t-resize wb-detail"
      aria-label="证据详情"
      onScroll={onContextScroll}
    >
      <header className="wb-detail-head">
        <div>
          <strong>证据</strong>
          <span>{selectedTool === null ? '实际现场' : `已联动 ${selectedTool.name}`}</span>
        </div>
        <div className="wb-detail-head-actions">
          <button type="button" aria-pressed={expanded} onClick={onToggleExpanded} title={expanded ? '收窄证据栏' : '加宽证据栏'}>
            {expanded ? '收窄' : '加宽'}
          </button>
          <button type="button" onClick={onClose} title="收起证据栏" aria-label="收起证据栏">
            <ChevronIcon className="wb-chevron wb-chevron-right" />
          </button>
        </div>
      </header>

      <section ref={evidenceRef} className="evidence-panel live-evidence-panel wb-evidence">
        <div className="evidence-tabs" role="tablist" aria-label="证据视图">
          {EVIDENCE_TABS.map(([tab, label]) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={evidenceTab === tab}
              data-selected={evidenceTab === tab}
              onClick={() => onTab(tab)}
            >
              {label}
            </button>
          ))}
        </div>
        {evidenceTab === 'diff' ? <DiffEvidence snapshot={snapshot} selectedTool={selectedTool} /> : null}
        {evidenceTab === 'verification' ? <VerificationEvidence snapshot={snapshot} selectedTool={selectedTool} /> : null}
        {evidenceTab === 'context' ? <ContextEvidence overview={overview} snapshot={snapshot} streamWarning={streamWarning} getGit={getGit} /> : null}
        {evidenceTab === 'subagents' ? <SubagentsEvidence snapshot={snapshot} /> : null}
        {evidenceTab === 'preview' ? <PreviewPane scope={taskId} /> : null}
        {evidenceTab === 'terminal' ? (
          <TerminalPane snapshot={snapshot} pending={actionPending} runTerminal={runTerminal} cancelTerminal={cancelTerminal} />
        ) : null}
      </section>
    </aside>
  );
}
