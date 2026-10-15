import { useRef, type RefObject } from 'react';
import type { GuiFileView, GuiLiveOverview, GuiLiveSnapshot, GuiModelsResponse, GuiTool, GuiWorkspaceTree } from '../../../live-types.js';
import { ContextEvidence, DiffEvidence, InspectorEvidence, VerificationEvidence } from './evidence.js';
import { FileTreePane } from './file-tree-pane.js';
import { toolStatusLabels } from './format.js';
import { BranchIcon, CheckIcon, ChevronIcon, CloseIcon, DocumentIcon, ExpandIcon, FolderIcon, GlobeIcon, TeamIcon, TerminalIcon } from './icons.js';
import type { EvidenceTab } from './prefs.js';
import { PreviewPane } from './preview-pane.js';
import { deriveSubagents } from './subagents.js';
import { TerminalPane } from './terminal-pane.js';

const EVIDENCE_TABS = [
  { id: 'diff', label: 'Diff / 产物', icon: BranchIcon },
  { id: 'verification', label: '验证', icon: CheckIcon },
  { id: 'context', label: '上下文', icon: DocumentIcon },
  { id: 'subagents', label: '子智能体', icon: TeamIcon },
  { id: 'files', label: '文件', icon: FolderIcon },
  { id: 'preview', label: '预览', icon: GlobeIcon },
  { id: 'terminal', label: '终端', icon: TerminalIcon },
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
  models,
  streamWarning,
  selectedTool,
  evidenceTab,
  detailRef,
  evidenceRef,
  expanded,
  open,
  taskId,
  actionPending,
  runTerminal,
  cancelTerminal,
  onTab,
  onToggleExpanded,
  onClose,
  onContextScroll,
  getGit,
  getFileView,
  getTree,
  openFileExternal,
  onOpenWide,
}: {
  readonly overview: GuiLiveOverview | null;
  readonly snapshot: GuiLiveSnapshot | null;
  readonly models: GuiModelsResponse | null;
  readonly streamWarning: string | null;
  readonly selectedTool: GuiTool | null;
  readonly evidenceTab: EvidenceTab;
  readonly detailRef: (node: HTMLElement | null) => void;
  readonly evidenceRef: RefObject<HTMLElement | null>;
  readonly expanded: boolean;
  readonly open: boolean;
  readonly taskId: string | null;
  readonly actionPending: boolean;
  readonly runTerminal: (command: string) => Promise<unknown>;
  readonly cancelTerminal: () => Promise<unknown>;
  readonly onTab: (tab: EvidenceTab) => void;
  readonly onToggleExpanded: () => void;
  readonly onClose: () => void;
  readonly onContextScroll: (event: { readonly currentTarget: HTMLElement }) => void;
  readonly getGit?: (id: string) => Promise<import('../../../live-types.js').GuiGitStatus>;
  readonly getFileView: (taskId: string, path: string) => Promise<GuiFileView>;
  readonly getTree: (taskId: string, path: string) => Promise<GuiWorkspaceTree>;
  readonly openFileExternal: (taskId: string, path: string) => Promise<{ ok: true }>;
  readonly onOpenWide: (path: string) => void;
}) {
  const navRef = useRef<HTMLDivElement>(null);
  const active = EVIDENCE_TABS.find((item) => item.id === evidenceTab);
  const selectTab = (tab: EvidenceTab) => {
    onTab(tab);
    window.requestAnimationFrame(() => {
      const body = navRef.current?.nextElementSibling as HTMLElement | null;
      if (body !== null) body.scrollTop = 0;
      if (tab !== 'overview') navRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)?.focus();
      else evidenceRef.current?.querySelector<HTMLElement>('summary')?.focus();
    });
  };
  return (
    <aside
      className="context-panel wb-detail"
      aria-label="证据详情"
      aria-hidden={!open}
      inert={!open}
      data-open={open}
      data-view={evidenceTab}
    >
      <header className="wb-detail-head">
        <div className="wb-detail-title">
          {evidenceTab !== 'overview' ? (
            <button type="button" className="wb-icon-btn" onClick={() => selectTab('overview')} aria-label="返回信息面板" title="返回信息面板">
              <ChevronIcon className="wb-chevron wb-chevron-left" />
            </button>
          ) : null}
          <strong>{active?.label ?? '任务信息'}</strong>
        </div>
        <div className="wb-detail-head-actions">
          <button type="button" className="wb-icon-btn" aria-pressed={expanded} onClick={onToggleExpanded} aria-label={expanded ? '收窄证据栏' : '加宽证据栏'} title={expanded ? '收窄证据栏' : '加宽证据栏'}>
            <ExpandIcon />
          </button>
          <button type="button" className="wb-icon-btn" onClick={onClose} title="收起证据栏" aria-label="收起证据栏">
            <CloseIcon />
          </button>
        </div>
      </header>
      <div ref={navRef} className="wb-detail-nav" role="tablist" aria-label="证据视图" hidden={evidenceTab === 'overview'}>
          {EVIDENCE_TABS.map(({ id: tab, label, icon: TabIcon }, index) => (
            <button
              key={tab}
              id={`wb-tab-${tab}`}
              data-tab={tab}
              type="button"
              role="tab"
              aria-label={label}
              aria-controls="wb-evidence-content"
              aria-selected={evidenceTab === tab}
              tabIndex={evidenceTab === tab ? 0 : -1}
              data-selected={evidenceTab === tab}
              onClick={() => selectTab(tab)}
              onKeyDown={(event) => {
                let next: number;
                if (event.key === 'ArrowRight') next = (index + 1) % EVIDENCE_TABS.length;
                else if (event.key === 'ArrowLeft') next = (index + EVIDENCE_TABS.length - 1) % EVIDENCE_TABS.length;
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = EVIDENCE_TABS.length - 1;
                else return;
                event.preventDefault();
                selectTab(EVIDENCE_TABS[next].id);
              }}
            >
              <TabIcon />
              <span className="wb-nav-tip" aria-hidden="true">{label}</span>
            </button>
          ))}
      </div>
      <div ref={detailRef} className="wb-detail-body" onScroll={onContextScroll}>
      <section ref={evidenceRef} className="evidence-panel live-evidence-panel wb-evidence" id="wb-evidence-content" role={evidenceTab === 'overview' ? undefined : 'tabpanel'} aria-labelledby={evidenceTab === 'overview' ? undefined : `wb-tab-${evidenceTab}`} tabIndex={evidenceTab === 'overview' ? undefined : 0}>
        {evidenceTab === 'overview' ? (
          <InspectorEvidence overview={overview} snapshot={snapshot} models={models} getGit={getGit} onTab={selectTab} onOpenWide={onOpenWide} />
        ) : null}
        {evidenceTab === 'diff' ? (
          <DiffEvidence
            snapshot={snapshot}
            selectedTool={selectedTool}
            taskId={taskId}
            getFileView={getFileView}
            openFileExternal={openFileExternal}
            onOpenWide={onOpenWide}
          />
        ) : null}
        {evidenceTab === 'verification' ? <VerificationEvidence snapshot={snapshot} selectedTool={selectedTool} /> : null}
        {evidenceTab === 'context' ? <ContextEvidence overview={overview} snapshot={snapshot} streamWarning={streamWarning} getGit={getGit} /> : null}
        {evidenceTab === 'subagents' ? <SubagentsEvidence snapshot={snapshot} /> : null}
        {evidenceTab === 'preview' ? <PreviewPane scope={taskId} /> : null}
        {evidenceTab === 'terminal' ? (
          <TerminalPane snapshot={snapshot} pending={actionPending} runTerminal={runTerminal} cancelTerminal={cancelTerminal} />
        ) : null}
        {evidenceTab === 'files' ? (
          <FileTreePane taskId={taskId} getTree={getTree} getFileView={getFileView} openFileExternal={openFileExternal} onOpenWide={onOpenWide} />
        ) : null}
      </section>
      </div>
    </aside>
  );
}
