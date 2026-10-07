import { useMemo, useState, type ChangeEvent, type FormEvent, type RefObject } from 'react';
import { ComposerPrimitive, ThreadPrimitive } from '@assistant-ui/react';
import type { GuiLiveOverview, GuiLiveSnapshot, GuiModelsResponse, GuiWorkspacePresets, GuiWorkspaceProbe } from '../../../live-types.js';
import type { GuiFreeTaskInput } from '../live/api.js';
import { DecisionBar, type DecisionKind } from './active-stage.js';
import type { ControlState, ComposerIntent, RunControls as RunControlState } from './controls.js';
import { CreateTaskPanel } from './create-task-panel.js';
import { shortObjective, statusPresentation, workspaceName } from './format.js';
import { ArrowDownIcon, FolderIcon, PanelIcon, StopIcon } from './icons.js';
import { MessageView } from './message-item.js';
import type { EvidenceTab } from './prefs.js';
import { describeRunVitals, RUN_VITALS_STATUSES } from './run-vitals.js';
import type { WorkbenchNotices, WorkbenchProvenance, HumanReviewDecision } from './types.js';
import type { HistoryGeometryApi } from './use-history-geometry.js';

function Notice({ tone = 'info', children }: { readonly tone?: string; readonly children: string }) {
  return (
    <section className="unknown-event live-notice wb-notice" data-tone={tone} role="status">
      <span className="unknown-mark" aria-hidden="true">!</span>
      <p>{children}</p>
    </section>
  );
}

interface RunAction {
  readonly label: string;
  readonly state: ControlState;
  readonly danger?: boolean;
  readonly onClick: () => void;
}

function RunActions({ actions }: { readonly actions: readonly RunAction[] }) {
  const visible = actions.filter((action) => action.state.available);
  if (visible.length === 0) return null;
  return (
    <div className="run-controls wb-run-controls" role="group" aria-label="运行控制">
      {visible.map((action) => (
        <button
          key={action.label}
          type="button"
          className={action.danger ? 'danger wb-stop' : undefined}
          onClick={action.onClick}
          title={action.label}
        >
          {action.danger ? <StopIcon /> : null}
          {action.label}
        </button>
      ))}
    </div>
  );
}

/** The textarea grows with its content up to the CSS cap, then it scrolls. */
function growComposer(event: FormEvent<HTMLTextAreaElement>): void {
  const node = event.currentTarget;
  node.style.height = 'auto';
  node.style.height = `${Math.min(node.scrollHeight, 164)}px`;
}

export interface ConversationPaneProps {
  readonly overview: GuiLiveOverview | null;
  readonly snapshot: GuiLiveSnapshot | null;
  readonly notices: WorkbenchNotices;
  readonly connection: string;
  readonly actionPending: string | null;
  readonly provenance: WorkbenchProvenance;
  readonly models: GuiModelsResponse | null;
  readonly gate: ControlState;
  readonly canStart: ControlState;
  readonly controls: RunControlState;
  readonly decideState: ControlState;
  readonly composerState: ControlState;
  readonly composerIntent: ComposerIntent | null;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  readonly historyRef: (node: HTMLDivElement | null) => void;
  readonly geometry: HistoryGeometryApi;
  readonly composerStorageKey: string;
  readonly detailOpen: boolean;
  readonly latestAssistantId: string | null;
  readonly onComposerChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  readonly onEvidence: (toolId: string, tab: EvidenceTab) => void;
  readonly onOpenEvidence: (tab: EvidenceTab) => void;
  readonly onPause: () => void;
  readonly onContinue: () => void;
  readonly onResume: () => void;
  readonly onStop: () => void;
  readonly onPrepareDecision: (kind: DecisionKind, requestId: string) => void;
  readonly onAllow: () => void;
  readonly onSubmitReview: (decisions: readonly HumanReviewDecision[]) => void;
  readonly onToggleDetail: () => void;
  readonly onValidateTask: (input: GuiFreeTaskInput) => Promise<{ ok: boolean; errors: Array<{ field: string; message: string }> }>;
  readonly onCreateTask: (input: GuiFreeTaskInput) => Promise<GuiLiveSnapshot>;
  readonly onCreateAndStart: (input: GuiFreeTaskInput) => Promise<unknown>;
  readonly onStart: () => void;
  readonly onBranch?: (messageId: string) => void;
  readonly onSavePresets: (wsId: string, input: Omit<GuiWorkspacePresets, 'savedAt'>) => Promise<unknown>;
  readonly onProbeCommands: (wsId: string) => Promise<GuiWorkspaceProbe>;
}

export function ConversationPane(props: ConversationPaneProps) {
  const {
    overview, snapshot, notices, connection, actionPending, provenance, models, gate, canStart, controls,
    decideState, composerState, composerIntent, composerRef, historyRef, geometry, composerStorageKey,
    detailOpen, latestAssistantId, onComposerChange, onEvidence, onOpenEvidence, onPause, onContinue,
    onResume, onStop, onPrepareDecision, onAllow, onSubmitReview, onToggleDetail,
    onValidateTask, onCreateTask, onCreateAndStart, onStart, onBranch, onSavePresets, onProbeCommands,
  } = props;
  const [hoveredTick, setHoveredTick] = useState<number | null>(null);
  // Batch 5 §运行状态: the strip only covers live run states; terminal states keep the StatusCard.
  const vitals = useMemo(
    () => (snapshot !== null && RUN_VITALS_STATUSES.includes(snapshot.status) ? describeRunVitals(snapshot) : null),
    [snapshot],
  );

  const presentation = snapshot === null
    ? null
    : snapshot.status === 'complete' && !snapshot.completion.granted
      ? { label: '完成待授权', tone: 'warning' }
      : statusPresentation[snapshot.status];
  const objective = snapshot?.title ?? snapshot?.objective ?? '新任务';
  const cwd = snapshot?.cwd ?? overview?.cwd ?? '';
  const authority = snapshot === null
    ? null
    : snapshot.completion.granted ? '完成已授予' : '完成未授予';

  const composerLabel = composerIntent?.kind === 'revise'
    ? '说明需要怎样调整'
    : composerIntent?.kind === 'deny'
      ? '说明拒绝理由'
      : snapshot === null
        ? '任务目标'
        : '补充指令';

  const placeholder = composerIntent !== null
    ? '写清原因或期望的调整；提交后会作为拒绝理由回到当前审批。'
    : snapshot === null
      ? overview?.task == null
        ? '尚未配置真实任务合同'
        : canStart.available
          ? '确认已固定的任务目标；启动后再补充'
          : canStart.reason
      : composerState.available
        ? '补充信息会在下一次处理边界送达'
        : composerState.reason;

  const sendLabel = composerIntent !== null
    ? '提交理由'
    : snapshot === null
      ? canStart.available ? '启动' : '不可启动'
      : '发送';

  return (
    <main id="conversation-main" className="conversation-main wb-conversation">
      <header className="wb-head">
        <div className="wb-head-title">
          <span className="wb-head-folder" aria-hidden="true">
            <FolderIcon />
          </span>
          <span className="wb-head-workspace wb-sr-only" title={cwd}>{workspaceName(cwd)}</span>
          <h1 title={objective}>{shortObjective(objective)}</h1>
        </div>
        <div className="wb-head-tools">
          {presentation !== null ? (
            <span
              className="wb-status-chip"
              data-tone={presentation.tone}
              role="status"
              aria-live="polite"
              title={actionPending ?? `${presentation.label} · ${authority ?? ''}`}
            >
              <span className="run-status-dot" aria-hidden="true" />
              {actionPending ?? presentation.label}
              <em>{authority}</em>
            </span>
          ) : null}
          <div className="wb-head-tool-group">
            <RunActions actions={[
              { label: '暂停', state: controls.pause, onClick: onPause },
              { label: snapshot?.status === 'pausing' ? '取消暂停' : '继续', state: controls.continueRun, onClick: onContinue },
              { label: '恢复', state: controls.resume, onClick: onResume },
              { label: '急停', state: controls.stop, danger: true, onClick: onStop },
            ]}
            />
            <button
              type="button"
              className="wb-icon-btn"
              aria-pressed={detailOpen}
              onClick={onToggleDetail}
              title={detailOpen ? '收起证据栏' : '打开证据栏'}
              aria-label={detailOpen ? '收起证据栏' : '打开证据栏'}
            >
              <PanelIcon />
            </button>
          </div>
        </div>
      </header>

      {vitals !== null ? (
        <section className="wb-vitals" aria-label="运行状态">
          <div><span>在做什么</span><strong>{vitals.doing}</strong></div>
          <div><span>在等什么</span><strong>{vitals.waiting}</strong></div>
          <div><span>下一步</span><strong>{vitals.next || '—'}</strong></div>
          <div><span>预算</span><strong>{vitals.budget}</strong></div>
        </section>
      ) : null}

      <ThreadPrimitive.Root className="thread-layout wb-thread" data-empty={snapshot === null}>
        <div className="wb-thread-body">
          <ThreadPrimitive.Viewport ref={historyRef} className="conversation-scroll wb-history" onScroll={geometry.onScroll}>
            <div className="wb-history-content" data-history-content data-empty={snapshot === null}>
              {provenance === 'fixture' ? (
                <div className="wb-fixture-notice"><Notice tone="warning">确定性试件：以下现场由本地构造数据驱动，不是真实运行，也不构成任何验收结论。</Notice></div>
              ) : null}

              {snapshot === null ? (
                <CreateTaskPanel
                  overview={overview}
                  models={models}
                  canStart={canStart}
                  pending={actionPending !== null}
                  onValidate={onValidateTask}
                  onCreate={onCreateTask}
                  onCreateAndStart={onCreateAndStart}
                  onSavePresets={onSavePresets}
                  onProbeCommands={onProbeCommands}
                />
              ) : null}

              {snapshot === null ? null : snapshot.status === 'idle' ? (
                <section className="wb-idle-card" aria-label="待启动任务">
                  {snapshot.sourceRef !== undefined ? (
                    <p className="wb-source-ref">来源：来自另一条任务第若干轮的讨论分支；前情已写入新会话，审批与验收不继承。</p>
                  ) : null}
                  <p>{snapshot.objective}</p>
                  <button type="button" className="wb-commit" disabled={actionPending !== null} onClick={onStart}>
                    启动任务
                  </button>
                  <small>启动会捕获当前工作区基线并开始消耗模型；已有运行中任务时会如实提示。</small>
                </section>
              ) : null}

              {snapshot !== null && snapshot.status !== 'idle' && snapshot.sourceRef !== undefined ? (
                <p className="wb-source-ref" role="note">该任务来自另一条任务的讨论分支；审批与验收不继承父任务。</p>
              ) : null}

              {notices.overviewLoading ? <Notice>正在读取本地任务。</Notice> : null}
              {notices.overviewError !== null ? <Notice tone="danger">{notices.overviewError}</Notice> : null}
              {notices.connectionNotice !== null ? <Notice tone="warning">{notices.connectionNotice}</Notice> : null}
              {notices.streamWarning !== null ? <Notice tone="warning">{notices.streamWarning}</Notice> : null}
              {notices.actionError !== null ? <Notice tone="danger">{notices.actionError}</Notice> : null}
              {snapshot?.warnings.map((warning, index) => (
                <Notice key={`${index}:${warning}`} tone="warning">{warning}</Notice>
              ))}

              <div className="message-list wb-message-list">
                <ThreadPrimitive.Messages>
                  {({ message }) => (
                    <div
                      className="wb-turn"
                      data-role={message.role}
                      data-turn-id={message.id}
                      data-message-id={message.id}
                    >
                      <MessageView
                        message={message}
                        isLatestAssistant={message.role === 'assistant' && message.id === latestAssistantId}
                        assistantSubline={snapshot?.model ?? null}
                        onEvidence={onEvidence}
                        onBranch={onBranch}
                      />
                    </div>
                  )}
                </ThreadPrimitive.Messages>
              </div>

              {snapshot !== null && snapshot.pendingInputs.length > 0 ? (
                <article className="assistant-notice live-pending-inputs wb-pending">
                  <span className="notice-mark" aria-hidden="true" />
                  <div>
                    <strong>已收到 {snapshot.pendingInputs.length} 条补充</strong>
                    <p>这些内容会在下一次处理边界送达 Jarvis。</p>
                  </div>
                </article>
              ) : null}
            </div>
          </ThreadPrimitive.Viewport>

          {geometry.sticky !== null ? (
            <button
              type="button"
              className="wb-sticky-prompt"
              onClick={() => geometry.scrollToTurn(geometry.sticky?.id ?? '')}
              title="回到这条提问"
            >
              <strong>{geometry.sticky.question}</strong>
            </button>
          ) : null}

          {geometry.mapVisible ? (
            <nav className="wb-map" aria-label="对话定位刻度" onMouseLeave={() => setHoveredTick(null)}>
              {geometry.turns.map((turn, index) => (
                <button
                  key={turn.id}
                  type="button"
                  className="wb-tick"
                  data-active={index === geometry.activeIndex}
                  style={{ top: `${(geometry.ticks[index] ?? 0) * 100}%` }}
                  aria-label={`回到第 ${index + 1} 轮提问：${turn.question}`}
                  onClick={() => geometry.scrollToTurn(turn.id)}
                  onMouseEnter={() => setHoveredTick(index)}
                  onFocus={() => setHoveredTick(index)}
                  onBlur={() => setHoveredTick(null)}
                >
                  {hoveredTick === index ? (
                    <span className="wb-tick-preview">
                      <em>第 {index + 1} 轮</em>
                      <strong>{turn.question}</strong>
                      <small>{turn.answer}</small>
                    </span>
                  ) : null}
                </button>
              ))}
            </nav>
          ) : null}

          {geometry.scrollable && !geometry.atLatest ? (
            <button type="button" className="wb-to-latest" onClick={geometry.scrollToLatest}>
              <ArrowDownIcon />
              回到最新
            </button>
          ) : null}
        </div>

        <DecisionBar
          snapshot={snapshot}
          gate={gate}
          decideState={decideState}
          resumeState={controls.resume}
          pending={actionPending !== null}
          onPrepareDecision={onPrepareDecision}
          onAllow={onAllow}
          onSubmitReview={onSubmitReview}
          onResume={onResume}
          onEvidence={onOpenEvidence}
        />

        {snapshot !== null ? <ComposerPrimitive.Root className="composer-bar wb-composer">
          <label className="wb-sr-only" htmlFor="wb-conversation-input">{composerLabel}</label>
          <div className="composer-surface">
            <ComposerPrimitive.Input
              ref={composerRef}
              id="wb-conversation-input"
              rows={1}
              submitMode="ctrlEnter"
              addAttachmentOnPaste={false}
              unstable_focusOnRunStart={false}
              unstable_focusOnThreadSwitched={false}
              placeholder={placeholder}
              onChange={onComposerChange}
              onInput={growComposer}
              data-draft-key={composerStorageKey}
            />
            <div className="wb-composer-tools">
              <span className="wb-model-pill" title="模型与思考档在任务创建时确定，由 provider 真实配置生成">
                {snapshot?.model ?? models?.defaultModel ?? '模型加载中'}
              </span>
              <span className="wb-model-pill" title="当前任务的思考档">
                思考：{snapshot?.thinking ?? 'off'}
              </span>
              <ComposerPrimitive.Send className="wb-send-icon" aria-label={sendLabel} title={sendLabel}>
                <ArrowDownIcon style={{ transform: 'rotate(180deg)' }} />
              </ComposerPrimitive.Send>
            </div>
          </div>
          <div className="composer-meta wb-composer-meta">
            {connection !== 'connected' ? <span data-tone="danger">连接未就绪：可继续编辑，发送与控制暂不可用</span> : null}
            <span>Ctrl Enter 发送</span>
          </div>
        </ComposerPrimitive.Root> : null}
      </ThreadPrimitive.Root>
    </main>
  );
}
