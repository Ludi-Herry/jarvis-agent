import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type EnrichedPartState,
  type MessageState,
} from '@assistant-ui/react';
import { JarvisExternalStoreProvider } from './adapter/jarvis-external-store';
import {
  createInitialDemoState,
  demoReducer,
  type DemoAction,
  type DemoState,
  type EvidenceTab,
} from './demo/demo-reducer';
import { guiRecover17 } from './demo/gui-recover-17';
import { statePresentation } from './demo/presentation';
import { HistoryRail, Topbar } from './components/shell-chrome';

const statusLabels: Record<string, string> = {
  complete: '完成',
  approval: '待批',
  pending: '待办',
  pass: '通过',
  blocked: '阻塞',
  failed: '失败',
  running: '运行中',
};

const toolEvidence: Record<string, EvidenceTab> = {
  read_file: 'context',
  rg: 'context',
  apply_patch: 'diff',
  vitest: 'verification',
};

function createInitialStateFromLocation(): DemoState {
  let state = createInitialDemoState();
  const params = new URLSearchParams(window.location.search);
  const fixture = params.get('fixture');
  if (fixture === 'running' || fixture === 'approval' || fixture === 'failed' || fixture === 'completed') {
    state = demoReducer(state, { type: 'set-fixture', state: fixture });
  }
  if (params.get('review') === 'expanded' && !state.reviewExpanded) {
    state = demoReducer(state, { type: 'toggle-review' });
  }
  return state;
}

function stringValue(value: unknown, fallback = '—'): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function ReasoningPart({ text }: { readonly text: string }) {
  const [open, setOpen] = useState(true);
  const lines = useMemo(() => text.split('\n').filter(Boolean), [text]);
  return (
    <section className="reasoning-block t-acc" data-open={open}>
      <button
        type="button"
        className="reasoning-head t-acc-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="t-acc-chevron" aria-hidden="true">
          <svg viewBox="0 0 16 16"><path d="M4 6.5L8 10.5L12 6.5" /></svg>
        </span>
        <span>
          <strong>Reasoning 摘要</strong>
          <small>{lines.length} 条 · 隐藏私有思维链</small>
        </span>
        <span className="reasoning-state">核对恢复序列</span>
      </button>
      <div className="t-acc-panel">
        <div className="t-acc-panel-inner">
          <ol>
            {lines.map((line, index) => (
              <li key={line}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <p>{line}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

function ToolPart({
  part,
  onEvidence,
}: {
  readonly part: Extract<EnrichedPartState, { type: 'tool-call' }>;
  readonly onEvidence: (tab: EvidenceTab) => void;
}) {
  const target = stringValue(part.args.target);
  const status = stringValue(part.args.status, 'pending');
  const detail = stringValue(part.args.detail);
  const evidence = toolEvidence[part.toolName] ?? 'context';
  return (
    <button
      type="button"
      className="tool-item"
      data-status={status}
      onClick={() => onEvidence(evidence)}
      aria-label={`查看 ${part.toolName} 关联证据`}
    >
      <span className="status-word" data-status={status}>{statusLabels[status] ?? status}</span>
      <code>{part.toolName}</code>
      <span className="tool-target">{target}</span>
      <span className="tool-detail">{detail}</span>
      <span className="tool-link">查看证据</span>
    </button>
  );
}

function MessageView({
  message,
  onEvidence,
}: {
  readonly message: MessageState;
  readonly onEvidence: (tab: EvidenceTab) => void;
}) {
  const name = stringValue(message.metadata.custom.name, message.role === 'user' ? 'Ludi' : 'Jarvis');
  const time = stringValue(message.metadata.custom.time, '—');
  return (
    <MessagePrimitive.Root className="message-item" data-role={message.role}>
      <div className="message-meta">
        <strong>{name}</strong>
        <time>{time}</time>
      </div>
      <MessagePrimitive.Parts>
        {({ part }) => {
          if (part.type === 'text') return <p className="message-copy">{part.text}</p>;
          if (part.type === 'reasoning') return <ReasoningPart text={part.text} />;
          if (part.type === 'tool-call') {
            return (
              <div className="tool-part">
                {part.toolName === 'read_file' ? (
                  <div className="tool-heading">
                    <span>
                      <strong>工具执行</strong>
                      <small>assistant-ui tool parts · 点击联动证据</small>
                    </span>
                  </div>
                ) : null}
                <ToolPart part={part} onEvidence={onEvidence} />
              </div>
            );
          }
          return <div className="unsupported-part">暂不支持的消息部分：{part.type}</div>;
        }}
      </MessagePrimitive.Parts>
    </MessagePrimitive.Root>
  );
}

function UnknownEventBanner({ eventType, onDismiss }: { readonly eventType: string; readonly onDismiss: () => void }) {
  return (
    <section className="unknown-event" role="status">
      <span className="unknown-mark" aria-hidden="true">?</span>
      <div>
        <strong>暂不支持的事件已保留</strong>
        <code>{eventType}</code>
        <p>显示投影没有识别该类型；消息、权限与完成授权均未改变。</p>
      </div>
      <button type="button" onClick={onDismiss}>收起</button>
    </section>
  );
}

function ConversationMain({
  state,
  dispatch,
  openTerminate,
  recoverButtonRef,
  composerRef,
  conversationRef,
  onEvidence,
  announce,
}: {
  readonly state: DemoState;
  readonly dispatch: (action: DemoAction) => void;
  readonly openTerminate: () => void;
  readonly recoverButtonRef: RefObject<HTMLButtonElement | null>;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  readonly conversationRef: RefObject<HTMLDivElement | null>;
  readonly onEvidence: (tab: EvidenceTab) => void;
  readonly announce: (message: string) => void;
}) {
  const handleAppend = useCallback(
    (text: string) => {
      dispatch({ type: 'append-exchange', text });
      announce(
        state.approval === 'revised'
          ? '调整意见已加入模拟现场；审批请求重新打开。'
          : '补充指令已加入本地模拟会话。',
      );
    },
    [announce, dispatch, state.approval],
  );

  return (
    <main id="conversation-main" className="conversation-main">
      <JarvisExternalStoreProvider messages={state.messages} onAppend={handleAppend}>
        <Topbar
          state={state}
          dispatch={dispatch}
          openTerminate={openTerminate}
          recoverButtonRef={recoverButtonRef}
          announce={announce}
        />
        <ThreadPrimitive.Root className="thread-layout">
          <ThreadPrimitive.Viewport ref={conversationRef} className="conversation-scroll">
            <div className="conversation-intro">
              <span>当前目标</span>
              <p>{guiRecover17.task.scope}</p>
            </div>
            {state.unknownEvent !== null ? (
              <UnknownEventBanner
                eventType={state.unknownEvent}
                onDismiss={() => dispatch({ type: 'dismiss-unknown' })}
              />
            ) : null}
            <div className="message-list">
              <ThreadPrimitive.Messages>
                {({ message }) => <MessageView message={message} onEvidence={onEvidence} />}
              </ThreadPrimitive.Messages>
            </div>
            <article className="assistant-notice">
              <span className="notice-mark" aria-hidden="true" />
              <div>
                <strong>执行权仍在 Jarvis 既有路径</strong>
                <p>assistant-ui 只渲染外部 store；本页按钮只改变模拟投影，不调用工具、权限或完成授权。</p>
              </div>
            </article>
          </ThreadPrimitive.Viewport>

          <ComposerPrimitive.Root className="composer-bar">
            <label htmlFor="conversation-input">
              {state.approval === 'revised' ? '调整意见' : '补充指令'}
            </label>
            <div className="composer-surface">
              <ComposerPrimitive.Input
                ref={composerRef}
                id="conversation-input"
                rows={2}
                submitMode="ctrlEnter"
                addAttachmentOnPaste={false}
                placeholder="告诉 Jarvis 要调整什么；P2 Spike 不会发送到 Runtime"
              />
              <ComposerPrimitive.Send>
                {state.approval === 'revised' ? '提交调整' : '发送'}
              </ComposerPrimitive.Send>
            </div>
            <div className="composer-meta">
              <span>Session <code>{guiRecover17.meta.session}</code></span>
              <span>{state.verified ? '完成授权：已授予（模拟）' : '完成授权：未授予'}</span>
              <span>Ctrl Enter 发送</span>
            </div>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.Root>
      </JarvisExternalStoreProvider>
    </main>
  );
}

function PlanList({ state }: { readonly state: DemoState }) {
  return (
    <ol className="compact-plan">
      {guiRecover17.plan.map((step) => {
        let status: string = step.status;
        if (step.id === '03' && ['validating', 'failed', 'completed'].includes(state.runState)) status = 'complete';
        if (step.id === '04' && state.runState === 'validating') status = 'running';
        if (step.id === '04' && state.runState === 'failed') status = 'failed';
        if (step.id === '04' && state.runState === 'completed') status = 'complete';
        if (step.id === '05' && state.runState === 'completed') status = 'complete';
        return (
          <li key={step.id} className="plan-item" data-status={status}>
            <span className="plan-number">{step.id}</span>
            <span className="plan-copy">
              <strong>{step.label}</strong>
              <small>{step.detail}</small>
            </span>
            <span className="status-word" data-status={status}>{statusLabels[status] ?? status}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ApprovalStage({
  state,
  dispatch,
  composerRef,
  approvalPrimaryRef,
  announce,
}: {
  readonly state: DemoState;
  readonly dispatch: (action: DemoAction) => void;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  readonly approvalPrimaryRef: RefObject<HTMLButtonElement | null>;
  readonly announce: (message: string) => void;
}) {
  const actionable = state.runState === 'approval';
  const decisionCopy = {
    pending: '等待你的决定',
    allowed: '已允许一次（模拟）',
    denied: '已拒绝（模拟）',
    revised: '等待调整意见',
  }[state.approval];

  return (
    <section className="active-stage approval-card" data-stage="approval" aria-labelledby="approval-title">
      <header>
        <span className="approval-knot" aria-hidden="true" />
        <div>
          <span>需要你处理</span>
          <h2 id="approval-title">{guiRecover17.approval.title}</h2>
        </div>
        <strong data-state={state.approval}>{decisionCopy}</strong>
      </header>
      {state.runState === 'paused' ? (
        <p className="stage-hold">现场已暂停。继续后回到审批；Composer 草稿保持可编辑。</p>
      ) : state.runState === 'interrupted' ? (
        <p className="stage-hold">运行已终止。请求与原始证据保持只读，恢复后再决定。</p>
      ) : state.runState === 'restored' ? (
        <p className="stage-hold">审批现场已恢复。核对内容后点击“继续”。</p>
      ) : null}
      <p>{guiRecover17.approval.reason}</p>
      <dl>
        <div><dt>能力</dt><dd>{guiRecover17.approval.capability}</dd></div>
        <div><dt>影响</dt><dd>{guiRecover17.approval.impact}</dd></div>
      </dl>
      <div className="approval-actions">
        <button
          type="button"
          disabled={!actionable}
          onClick={() => {
            dispatch({ type: 'reject' });
            announce('写入已拒绝（模拟）；原始 Diff 继续保留。');
          }}
        >
          拒绝
        </button>
        <button
          type="button"
          disabled={!actionable}
          onClick={() => {
            dispatch({ type: 'revise' });
            requestAnimationFrame(() => composerRef.current?.focus());
            announce('现场已暂停；请在 Composer 输入调整意见。');
          }}
        >
          要求调整
        </button>
        <button
          ref={approvalPrimaryRef}
          className="primary"
          type="button"
          disabled={!actionable}
          onClick={() => {
            dispatch({ type: 'approve-once' });
            announce('已允许一次模拟写入；验证阶段开始，完成授权保持未授予。');
          }}
        >
          允许一次
        </button>
      </div>
    </section>
  );
}

function VerificationStage({
  state,
  dispatch,
  announce,
}: {
  readonly state: DemoState;
  readonly dispatch: (action: DemoAction) => void;
  readonly announce: (message: string) => void;
}) {
  const paused = state.runState === 'paused';
  return (
    <section className="active-stage verification-stage" data-stage="verification" aria-labelledby="verification-title">
      <header>
        <span className="stage-index">04</span>
        <div>
          <span>当前活动阶段</span>
          <h2 id="verification-title">{paused ? '验证已暂停' : '运行聚焦测试'}</h2>
        </div>
        <strong>{paused ? '等待继续' : '验证中（模拟）'}</strong>
      </header>
      <p>一次性写入已允许，`vitest` 正在核对恢复顺序与显示投影。完成授权仍未授予。</p>
      <div className="stage-command"><span>聚焦命令</span><code>{guiRecover17.terminal.command}</code></div>
      <div className="verification-actions">
        <button
          className="danger"
          type="button"
          disabled={paused}
          onClick={() => {
            dispatch({ type: 'validation-failed' });
            announce('聚焦测试失败（模拟）；原始失败证据已保留。');
          }}
        >
          模拟失败
        </button>
        <button
          className="primary"
          type="button"
          disabled={paused}
          onClick={() => {
            dispatch({ type: 'finish-verified' });
            announce('decideVerdict · verified（模拟）已通过；完成授权已授予。');
          }}
        >
          模拟 verified
        </button>
      </div>
    </section>
  );
}

function FailureStage({
  dispatch,
  recoverButtonRef,
  announce,
}: {
  readonly dispatch: (action: DemoAction) => void;
  readonly recoverButtonRef: RefObject<HTMLButtonElement | null>;
  readonly announce: (message: string) => void;
}) {
  return (
    <section className="active-stage failure-stage" data-stage="failure" aria-labelledby="failure-title">
      <header>
        <span className="stage-index">!</span>
        <div>
          <span>验证未通过</span>
          <h2 id="failure-title">恢复顺序仍有冲突</h2>
        </div>
        <strong>完成授权未授予</strong>
      </header>
      <p>{guiRecover17.terminal.failure}</p>
      <div className="failure-facts">
        <span>原始 Diff 可读</span>
        <span>失败输出已保留</span>
        <span>工作区可恢复</span>
      </div>
      <button
        ref={recoverButtonRef}
        type="button"
        onClick={() => {
          dispatch({ type: 'recover' });
          announce('失败现场已恢复；请核对后继续。');
        }}
      >
        恢复现场
      </button>
    </section>
  );
}

function CompletedStage() {
  return (
    <section className="active-stage completed-stage" data-stage="completed" aria-labelledby="completed-title">
      <header>
        <span className="stage-index">✓</span>
        <div>
          <span>可信完成</span>
          <h2 id="completed-title">验证链已通过</h2>
        </div>
        <strong>完成授权 已授予</strong>
      </header>
      <p>{guiRecover17.terminal.success}</p>
      <div className="completion-receipt">
        <span>decideVerdict</span>
        <strong>verified（模拟）</strong>
      </div>
    </section>
  );
}

function ActiveStage({
  state,
  dispatch,
  composerRef,
  recoverButtonRef,
  approvalPrimaryRef,
  announce,
}: {
  readonly state: DemoState;
  readonly dispatch: (action: DemoAction) => void;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  readonly recoverButtonRef: RefObject<HTMLButtonElement | null>;
  readonly approvalPrimaryRef: RefObject<HTMLButtonElement | null>;
  readonly announce: (message: string) => void;
}) {
  if (state.reviewStage === 'completed') return <CompletedStage />;
  if (state.reviewStage === 'failure') {
    return <FailureStage dispatch={dispatch} recoverButtonRef={recoverButtonRef} announce={announce} />;
  }
  if (state.reviewStage === 'verification') {
    return <VerificationStage state={state} dispatch={dispatch} announce={announce} />;
  }
  return (
    <ApprovalStage
      state={state}
      dispatch={dispatch}
      composerRef={composerRef}
      approvalPrimaryRef={approvalPrimaryRef}
      announce={announce}
    />
  );
}

function VerificationPane({ state }: { readonly state: DemoState }) {
  const testValue = state.runState === 'completed'
    ? '17 passed'
    : state.runState === 'failed'
      ? '1 failed'
      : state.runState === 'validating'
        ? '运行中'
        : '等待审批';
  const testStatus = state.runState === 'completed'
    ? 'pass'
    : state.runState === 'failed'
      ? 'failed'
      : state.runState === 'validating'
        ? 'running'
        : 'pending';
  const checks = [
    { label: '持久化序列', value: '单调', status: 'pass' },
    { label: '聚焦测试', value: testValue, status: testStatus },
    { label: '未验证项', value: state.runState === 'completed' ? '0' : '1280 视口', status: state.runState === 'completed' ? 'pass' : 'pending' },
    { label: '完成授权', value: state.verified ? 'verified' : '未授予', status: state.verified ? 'pass' : 'blocked' },
  ];
  return (
    <div className="verification-pane">
      <ul className="evidence-checks">
        {checks.map((check) => (
          <li key={check.label} data-status={check.status}>
            <span>{check.label}</span>
            <strong>{check.value}</strong>
          </li>
        ))}
      </ul>
      <div className="test-command"><span>聚焦命令</span><code>{guiRecover17.terminal.command}</code></div>
      <div className="verification-outcome" data-tone={statePresentation[state.runState].tone}>
        <strong>{statePresentation[state.runState].outcome}</strong>
        <small>{state.verified ? '完成授权：已授予（模拟）' : '完成授权：未授予'}</small>
      </div>
    </div>
  );
}

function EvidencePanel({
  state,
  dispatch,
  linked,
}: {
  readonly state: DemoState;
  readonly dispatch: (action: DemoAction) => void;
  readonly linked: boolean;
}) {
  const tabs: readonly { id: EvidenceTab; label: string }[] = [
    { id: 'diff', label: 'Diff' },
    { id: 'verification', label: '验证' },
    { id: 'context', label: '上下文' },
  ];
  return (
    <section className={`evidence-panel${linked ? ' is-linked' : ''}`} aria-labelledby="evidence-title">
      <header className="panel-heading evidence-heading">
        <div>
          <h2 id="evidence-title">补丁与验证</h2>
        </div>
        <strong>2 files</strong>
      </header>
      <div className="evidence-tabs" role="tablist" aria-label="证据视图">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={state.evidenceTab === tab.id}
            aria-controls={`panel-${tab.id}`}
            data-selected={state.evidenceTab === tab.id}
            onClick={() => dispatch({ type: 'set-evidence-tab', tab: tab.id })}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id={`panel-${state.evidenceTab}`}
        className="evidence-pane"
        role="tabpanel"
        aria-labelledby={`tab-${state.evidenceTab}`}
      >
        {state.evidenceTab === 'diff' ? (
          <>
            <ul className="file-list">
              {guiRecover17.artifacts.map((artifact) => (
                <li key={artifact.path}>
                  <span>{artifact.path}</span>
                  <strong>{artifact.delta}</strong>
                </li>
              ))}
            </ul>
            <div className="mini-diff" aria-label="模拟 Diff 预览">
              {guiRecover17.diff.map((line, index) => (
                <div key={`${line.next}-${index}`} className="diff-row" data-kind={line.kind}>
                  <span className="diff-gutter">{line.old}</span>
                  <span className="diff-gutter">{line.next}</span>
                  <code>{line.text || ' '}</code>
                </div>
              ))}
            </div>
            <p className="artifact-caption">模拟 Diff · 审批前可检查，写入后仍需测试。</p>
          </>
        ) : null}
        {state.evidenceTab === 'verification' ? <VerificationPane state={state} /> : null}
        {state.evidenceTab === 'context' ? (
          <div className="context-pane">
            <dl>
              <div><dt>Workspace</dt><dd>{guiRecover17.meta.workspace}</dd></div>
              <div><dt>Branch</dt><dd>{guiRecover17.meta.branch}</dd></div>
              <div><dt>Session</dt><dd>{guiRecover17.meta.session}</dd></div>
              <div><dt>Scope</dt><dd>{guiRecover17.task.scope}</dd></div>
            </dl>
            <p>持久化事实与显示投影分开；P2 只演示外部 store 到 assistant-ui primitives 的映射。</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ReviewPanel({
  state,
  dispatch,
  reviewRef,
  composerRef,
  recoverButtonRef,
  approvalPrimaryRef,
  linked,
  announce,
}: {
  readonly state: DemoState;
  readonly dispatch: (action: DemoAction) => void;
  readonly reviewRef: RefObject<HTMLElement | null>;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  readonly recoverButtonRef: RefObject<HTMLButtonElement | null>;
  readonly approvalPrimaryRef: RefObject<HTMLButtonElement | null>;
  readonly linked: boolean;
  readonly announce: (message: string) => void;
}) {
  return (
    <aside ref={reviewRef} className="context-panel t-resize" aria-label="任务状态与产物">
      <header className="review-toolbar">
        <div>
          <strong>任务与证据</strong>
        </div>
        <button
          type="button"
          aria-pressed={state.reviewExpanded}
          onClick={() => dispatch({ type: 'toggle-review' })}
        >
          {state.reviewExpanded ? '收起审阅' : '展开审阅'}
        </button>
      </header>
      <section className="task-brief" aria-labelledby="task-title">
        <div className="panel-heading">
          <div>
            <h2 id="task-title">任务现场</h2>
          </div>
          <strong>{guiRecover17.task.progress}</strong>
        </div>
        <p>{guiRecover17.task.request}</p>
        <PlanList state={state} />
      </section>
      <ActiveStage
        state={state}
        dispatch={dispatch}
        composerRef={composerRef}
        recoverButtonRef={recoverButtonRef}
        approvalPrimaryRef={approvalPrimaryRef}
        announce={announce}
      />
      <EvidencePanel state={state} dispatch={dispatch} linked={linked} />
    </aside>
  );
}

export function JarvisApp() {
  const [state, dispatch] = useReducer(demoReducer, undefined, createInitialStateFromLocation);
  const [toast, setToast] = useState<string | null>(null);
  const [linked, setLinked] = useState(false);
  const [dialogMotion, setDialogMotion] = useState<'closed' | 'open' | 'closing'>('closed');
  const toastTimerRef = useRef<number | null>(null);
  const linkTimerRef = useRef<number | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLElement>(null);
  const recoverButtonRef = useRef<HTMLButtonElement>(null);
  const approvalPrimaryRef = useRef<HTMLButtonElement>(null);
  const didInitialFocusRef = useRef(false);

  const announce = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.spikeReady = 'true';
    return () => {
      delete document.documentElement.dataset.spikeReady;
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
      if (linkTimerRef.current !== null) window.clearTimeout(linkTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (didInitialFocusRef.current) return;
    didInitialFocusRef.current = true;
    requestAnimationFrame(() => approvalPrimaryRef.current?.focus());
  }, []);

  const activateEvidence = useCallback(
    (tab: EvidenceTab) => {
      dispatch({ type: 'set-evidence-tab', tab });
      if (!state.reviewExpanded) dispatch({ type: 'toggle-review' });
      requestAnimationFrame(() => {
        if (reviewRef.current !== null) reviewRef.current.scrollTop = 0;
      });
      setLinked(false);
      requestAnimationFrame(() => setLinked(true));
      if (linkTimerRef.current !== null) window.clearTimeout(linkTimerRef.current);
      linkTimerRef.current = window.setTimeout(() => setLinked(false), 700);
    },
    [state.reviewExpanded],
  );

  const openTerminate = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    lastFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    setDialogMotion('open');
  }, []);

  const closeTerminate = useCallback((confirm: boolean) => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    setDialogMotion('closing');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const duration = reduced
      ? 0
      : Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--modal-close-dur'),
        ) || 150;
    window.setTimeout(() => {
      dialog.close();
      setDialogMotion('closed');
      if (confirm) {
        dispatch({ type: 'terminate' });
        announce('模拟运行已终止；消息、工具与审批现场继续保留。');
        requestAnimationFrame(() => recoverButtonRef.current?.focus());
      } else {
        requestAnimationFrame(() => lastFocusRef.current?.focus());
      }
    }, duration);
  }, [announce]);

  return (
    <>
      <a className="skip-link" href="#conversation-main">跳到当前对话</a>
      <div className="conversation-shell" data-review-expanded={state.reviewExpanded} data-run-state={state.runState}>
        <HistoryRail state={state} dispatch={dispatch} announce={announce} />
        <ConversationMain
          state={state}
          dispatch={dispatch}
          openTerminate={openTerminate}
          recoverButtonRef={recoverButtonRef}
          composerRef={composerRef}
          conversationRef={conversationRef}
          onEvidence={activateEvidence}
          announce={announce}
        />
        <ReviewPanel
          state={state}
          dispatch={dispatch}
          reviewRef={reviewRef}
          composerRef={composerRef}
          recoverButtonRef={recoverButtonRef}
          approvalPrimaryRef={approvalPrimaryRef}
          linked={linked}
          announce={announce}
        />
      </div>

      <dialog
        ref={dialogRef}
        className="terminate-dialog"
        aria-labelledby="terminate-title"
        onCancel={(event) => {
          event.preventDefault();
          closeTerminate(false);
        }}
      >
        <div className={`terminate-surface t-modal${dialogMotion === 'open' ? ' is-open' : ''}${dialogMotion === 'closing' ? ' is-closing' : ''}`}>
          <h2 id="terminate-title">终止这次模拟运行？</h2>
          <p>界面会切到“已终止”，消息、工具、审批现场和 Composer 草稿继续保留，并提供恢复入口。</p>
          <div className="dialog-actions">
            <button type="button" onClick={() => closeTerminate(false)}>取消</button>
            <button className="danger" type="button" onClick={() => closeTerminate(true)}>确认终止</button>
          </div>
        </div>
      </dialog>

      <div className="prototype-toast" data-open={toast !== null} role="status" aria-live="polite">
        {toast}
      </div>
    </>
  );
}
