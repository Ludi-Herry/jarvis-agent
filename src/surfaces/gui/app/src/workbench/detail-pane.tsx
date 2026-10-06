import { type RefObject } from 'react';
import type { GuiLiveOverview, GuiLiveSnapshot, GuiTool } from '../../../live-types.js';
import { ContextEvidence, DiffEvidence, VerificationEvidence } from './evidence.js';
import { ChevronIcon } from './icons.js';
import type { EvidenceTab } from './prefs.js';

const EVIDENCE_TABS = [
  ['diff', 'Diff / 产物'],
  ['verification', '验证'],
  ['context', '上下文'],
] as const;

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
  onTab,
  onToggleExpanded,
  onClose,
  onContextScroll,
}: {
  readonly overview: GuiLiveOverview | null;
  readonly snapshot: GuiLiveSnapshot | null;
  readonly streamWarning: string | null;
  readonly selectedTool: GuiTool | null;
  readonly evidenceTab: EvidenceTab;
  readonly detailRef: (node: HTMLElement | null) => void;
  readonly evidenceRef: RefObject<HTMLElement | null>;
  readonly expanded: boolean;
  readonly onTab: (tab: EvidenceTab) => void;
  readonly onToggleExpanded: () => void;
  readonly onClose: () => void;
  readonly onContextScroll: (event: { readonly currentTarget: HTMLElement }) => void;
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
        {evidenceTab === 'context' ? <ContextEvidence overview={overview} snapshot={snapshot} streamWarning={streamWarning} /> : null}
      </section>
    </aside>
  );
}
