import { useEffect, useMemo, useState } from 'react';
import type { GuiApproval, GuiLiveSnapshot } from '../../../live-types.js';
import type { HumanReviewDecision } from '../live/use-live-session.js';
import { buildApprovalPreview } from './approval-diff.js';
import type { ControlState } from './controls.js';
import { parseUnifiedDiff } from './diff.js';
import { statusPresentation, toolKindLabels } from './format.js';
import { ChevronIcon } from './icons.js';
import type { EvidenceTab } from './prefs.js';

export type DecisionKind = 'deny' | 'revise';

interface ReviewDraftItem {
  readonly checked: boolean;
  readonly decision: 'approve' | 'reject' | null;
  readonly note: string;
}

const EMPTY_DRAFT: ReviewDraftItem = { checked: false, decision: null, note: '' };

function GateNote({ gate }: { readonly gate: ControlState }) {
  if (gate.available || gate.reason === '') return null;
  return <p className="wb-gate-note">{gate.reason}</p>;
}

export function ApprovalCard({
  approval,
  gate,
  pending,
  onPrepareDecision,
  onAllow,
  onEvidence,
}: {
  readonly approval: GuiApproval;
  readonly gate: ControlState;
  readonly pending: boolean;
  readonly onPrepareDecision: (kind: DecisionKind, requestId: string) => void;
  readonly onAllow: () => void;
  readonly onEvidence: (tab: EvidenceTab) => void;
}) {
  const disabled = !gate.available || pending;
  // Batch 4 §授权判断: the pending-change preview is computed from the approval arguments only —
  // it is NOT the already-executed diff shown in the Diff tab, and the card says so explicitly.
  const preview = useMemo(() => buildApprovalPreview(approval.toolName, approval.arguments), [approval.toolName, approval.arguments]);
  const previewRows = useMemo(
    () => (preview !== null && (preview.kind === 'write-create' || preview.kind === 'edit') && preview.diff.trim() !== '' ? parseUnifiedDiff(preview.diff) : null),
    [preview],
  );
  return (
    <section className="wb-decision wb-decision-approval" aria-labelledby="wb-approval-title">
      <header>
        <span className="wb-decision-mark" aria-hidden="true" />
        <div>
          <span>需要你处理</span>
          <h2 id="wb-approval-title">{toolKindLabels[approval.toolName] ?? approval.toolName}</h2>
        </div>
        <button type="button" className="wb-link" onClick={() => onEvidence('diff')}>查看改动与证据</button>
      </header>
      <p>{approval.capability === 'writes-files' ? '请检查本次改动。允许一次后，Jarvis 才会真正写入。' : approval.reason}</p>
      <dl>
        <div><dt>操作</dt><dd>{approval.toolName}</dd></div>
        <div><dt>影响</dt><dd>{approval.detail}</dd></div>
      </dl>
      {preview !== null ? (
        <details className="wb-approval-preview">
          <summary>
            <span><strong>即将批准的变更（预览，尚未执行）</strong><code title={preview.kind === 'command' ? preview.command : preview.path}>{preview.kind === 'command' ? preview.command : preview.path}</code></span>
            <ChevronIcon className="wb-chevron" />
          </summary>
          <div className="wb-approval-preview-body">
          <p className="wb-approval-preview-note">与右侧 Diff 页签的已执行改动不是同一份；此内容来自本次工具调用参数。</p>
          {preview.kind === 'edit' && preview.note !== undefined ? <p className="wb-approval-preview-note">{preview.note}</p> : null}
          {previewRows !== null && previewRows.rows.length > 0 ? (
            <pre className="mini-diff wb-diff">
              {previewRows.rows.map((row, index) => (
                <span key={`${index}:${row.kind}`} className="wb-diff-row" data-kind={row.kind}>{row.text || ' '}</span>
              ))}
              {previewRows.truncated ? <span className="wb-diff-row" data-kind="meta">…预览已截断，请检查调用参数</span> : null}
            </pre>
          ) : null}
          {preview.kind === 'write-replace' ? (
            <>
              <code>{preview.path}</code>
              <p className="wb-approval-preview-note">{preview.note}</p>
              <pre className="wb-approval-preview-content">{preview.content}</pre>
            </>
          ) : null}
          {preview.kind === 'command' ? (
            <pre className="wb-approval-preview-content"><code>{preview.command}</code></pre>
          ) : null}
          </div>
        </details>
      ) : null}
      <details className="live-approval-detail">
        <summary>查看调用参数</summary>
        <pre>{approval.arguments}</pre>
      </details>
      <GateNote gate={gate} />
      <div className="approval-actions wb-decision-actions">
        <button type="button" disabled={disabled} onClick={() => onPrepareDecision('deny', approval.requestId)}>
          拒绝
        </button>
        <button type="button" disabled={disabled} onClick={() => onPrepareDecision('revise', approval.requestId)}>
          要求调整
        </button>
        <button className="primary" type="button" disabled={disabled} onClick={onAllow}>
          允许一次
        </button>
      </div>
      <p className="wb-decision-foot">允许一次只推进这一次请求；拒绝与调整的理由会回到 Jarvis。完成授权仍由既有可信链决定。</p>
    </section>
  );
}

export function ReviewCard({
  snapshot,
  gate,
  pending,
  onSubmit,
  onEvidence,
}: {
  readonly snapshot: GuiLiveSnapshot;
  readonly gate: ControlState;
  readonly pending: boolean;
  readonly onSubmit: (decisions: readonly HumanReviewDecision[]) => void;
  readonly onEvidence: (tab: EvidenceTab) => void;
}) {
  const requirements = snapshot.review?.requirements ?? [];
  const [drafts, setDrafts] = useState<Record<string, ReviewDraftItem>>({});

  useEffect(() => {
    setDrafts((current) => Object.fromEntries(requirements.map((requirement) => [
      requirement.requirementId,
      current[requirement.requirementId] ?? EMPTY_DRAFT,
    ])));
  }, [requirements]);

  const update = (id: string, patch: Partial<ReviewDraftItem>) => {
    setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? EMPTY_DRAFT), ...patch } }));
  };

  const ready = requirements.length > 0 && requirements.every((requirement) => {
    const item = drafts[requirement.requirementId];
    return item?.checked === true && item.decision !== null && item.note.trim() !== '';
  });

  const submit = () => {
    if (!ready) return;
    onSubmit(requirements.map((requirement) => {
      const item = drafts[requirement.requirementId];
      if (item === undefined || item.decision === null) throw new Error('验收项尚未填写完整。');
      return { requirementId: requirement.requirementId, decision: item.decision, note: item.note.trim() };
    }));
  };

  return (
    <section className="wb-decision wb-decision-review" aria-labelledby="wb-review-title">
      <header>
        <span className="wb-decision-mark" aria-hidden="true" />
        <div>
          <span>需要人工验收</span>
          <h2 id="wb-review-title">检查交付证据后逐项表态</h2>
        </div>
        <button type="button" className="wb-link" onClick={() => onEvidence('verification')}>查看验证与 Diff</button>
      </header>
      <div className="wb-review-items">
        {requirements.map((requirement) => {
          const item = drafts[requirement.requirementId] ?? EMPTY_DRAFT;
          return (
            <fieldset key={requirement.requirementId}>
              <legend>{requirement.text}</legend>
              <label className="live-review-check">
                <input
                  type="checkbox"
                  checked={item.checked}
                  onChange={(event) => update(requirement.requirementId, { checked: event.currentTarget.checked })}
                />
                我已检查相关证据
              </label>
              <div className="live-review-choice">
                <button type="button" data-selected={item.decision === 'approve'} onClick={() => update(requirement.requirementId, { decision: 'approve' })}>
                  通过
                </button>
                <button type="button" data-selected={item.decision === 'reject'} onClick={() => update(requirement.requirementId, { decision: 'reject' })}>
                  不通过
                </button>
              </div>
              <textarea
                rows={2}
                value={item.note}
                placeholder="写下你看到的证据和判断"
                onChange={(event) => update(requirement.requirementId, { note: event.currentTarget.value })}
              />
            </fieldset>
          );
        })}
      </div>
      {snapshot.evidenceToken === null ? (
        <p className="wb-gate-note">当前没有绑定验证证据；提交会被 Runtime 拒绝，请先刷新现场。</p>
      ) : null}
      <GateNote gate={gate} />
      <button className="primary live-review-submit" type="button" disabled={!gate.available || pending || !ready} onClick={submit}>
        提交验收
      </button>
      <p className="wb-decision-foot">只有这次人工验收会进入现有可信完成链；模型声明与检查通过都不等于完成。</p>
    </section>
  );
}

export function StatusCard({
  snapshot,
  resumeState,
  onResume,
  onEvidence,
}: {
  readonly snapshot: GuiLiveSnapshot;
  readonly resumeState: ControlState;
  readonly onResume: () => void;
  readonly onEvidence: (tab: EvidenceTab) => void;
}) {
  const completionGranted = snapshot.completion.granted;
  const presentation = snapshot.status === 'complete' && !completionGranted
    ? { label: '完成待授权', tone: 'warning' }
    : statusPresentation[snapshot.status];
  const failedChecks = snapshot.checks.filter((check) => check.code !== 0 && check.code !== null);
  const heading = completionGranted
    ? '交付已获可信授权'
    : snapshot.status === 'blocked'
      ? '任务无法继续'
      : snapshot.status === 'complete'
        ? '完成授权尚未授予'
        : snapshot.status === 'interrupted'
          ? '运行已经停止'
          : snapshot.status === 'recoverable'
            ? '现场可以恢复'
            : snapshot.phase || presentation.label;
  return (
    <section className={`wb-decision wb-decision-status is-${presentation.tone}`} aria-labelledby="wb-status-title">
      <header>
        <span className="wb-decision-mark" aria-hidden="true" />
        <div>
          <span>{presentation.label}</span>
          <h2 id="wb-status-title">{heading}</h2>
        </div>
        <button type="button" className="wb-link" onClick={() => onEvidence('verification')}>查看证据</button>
      </header>
      <p>{completionGranted ? snapshot.completion.rationale : snapshot.nextAction || snapshot.completion.rationale || '等待下一步状态。'}</p>
      {failedChecks.length > 0 ? (
        <div className="failure-facts">
          {failedChecks.map((check, index) => <span key={`${index}:${check.command}`}>{check.command} · 退出码 {check.code}</span>)}
        </div>
      ) : null}
      {resumeState.available || snapshot.status === 'recoverable' ? (
        <>
          <button type="button" disabled={!resumeState.available} onClick={onResume}>恢复现场</button>
          <GateNote gate={resumeState} />
        </>
      ) : null}
      {!snapshot.capabilities.resume && ['interrupted', 'blocked', 'unavailable'].includes(snapshot.status) ? (
        <p className="wb-decision-foot">当前没有可用的恢复入口，这个现场保持只读；消息、审批与证据都已保留。</p>
      ) : null}
    </section>
  );
}

/** The single place a human decision is taken: pinned above the composer so it never hides. */
export function DecisionBar({
  snapshot,
  gate,
  decideState,
  resumeState,
  pending,
  onPrepareDecision,
  onAllow,
  onSubmitReview,
  onResume,
  onEvidence,
}: {
  readonly snapshot: GuiLiveSnapshot | null;
  readonly gate: ControlState;
  readonly decideState: ControlState;
  readonly resumeState: ControlState;
  readonly pending: boolean;
  readonly onPrepareDecision: (kind: DecisionKind, requestId: string) => void;
  readonly onAllow: () => void;
  readonly onSubmitReview: (decisions: readonly HumanReviewDecision[]) => void;
  readonly onResume: () => void;
  readonly onEvidence: (tab: EvidenceTab) => void;
}) {
  if (snapshot === null) return null;
  if (snapshot.approval !== null) {
    return (
      <ApprovalCard
        approval={snapshot.approval}
        gate={decideState}
        pending={pending}
        onPrepareDecision={onPrepareDecision}
        onAllow={onAllow}
        onEvidence={onEvidence}
      />
    );
  }
  if (snapshot.review !== null) {
    return (
      <ReviewCard
        snapshot={snapshot}
        gate={gate}
        pending={pending}
        onSubmit={onSubmitReview}
        onEvidence={onEvidence}
      />
    );
  }
  if (['interrupted', 'blocked', 'recoverable', 'unavailable', 'complete'].includes(snapshot.status)) {
    return <StatusCard snapshot={snapshot} resumeState={resumeState} onResume={onResume} onEvidence={onEvidence} />;
  }
  return null;
}
