import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type { GuiLiveSnapshot, GuiTool } from '../../../live-types.js';
import { LiveJarvisExternalStoreProvider } from '../adapter/jarvis-external-store.js';
import type { GuiFreeTaskInput } from '../live/api.js';
import type { HumanReviewDecision } from '../live/use-live-session.js';
import { ConversationPane } from './conversation-pane.js';
import {
  resolveCanStart,
  resolveComposer,
  resolveDecide,
  resolveGate,
  resolveRunControls,
  resolveSessionSwitch,
  type ComposerIntent,
} from './controls.js';
import { DetailPane } from './detail-pane.js';
import { isActuallyRunning } from './format.js';
import {
  draftKey,
  initialEvidenceTab,
  initialExpanded,
  initialRailCollapsed,
  prefKeys,
  storageGet,
  storageRemove,
  storageSet,
  usePersistentFlag,
  useRememberedScroll,
  type EvidenceTab,
} from './prefs.js';
import { useHistoryGeometry } from './use-history-geometry.js';
import { WorkspaceRail, connectionBadge } from './workspace-rail.js';
import type { WorkbenchInput } from './types.js';
import { StopDialog } from './stop-dialog.js';

export function Workbench({ input }: { readonly input: WorkbenchInput }) {
  const { overview, snapshot, selectedId, connection, actionPending, notices, commands, provenance } = input;

  const [evidenceTab, setEvidenceTab] = useState<EvidenceTab>(initialEvidenceTab);
  const [expanded, setExpanded] = usePersistentFlag(prefKeys.reviewExpanded, initialExpanded);
  const [railCollapsed, setRailCollapsed] = usePersistentFlag(prefKeys.railCollapsed, initialRailCollapsed);
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [composerIntent, setComposerIntent] = useState<ComposerIntent | null>(null);
  const [draftRecoveryToken, setDraftRecoveryToken] = useState(0);
  const [stopAttempted, setStopAttempted] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [branchFor, setBranchFor] = useState<string | null>(null);
  const [branchPending, setBranchPending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const composerRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const evidenceRef = useRef<HTMLElement>(null);
  const stopDialogRef = useRef<HTMLDialogElement>(null);
  const branchDialogRef = useRef<HTMLDialogElement>(null);
  const toastTimer = useRef<number | null>(null);

  const messages = snapshot?.messages ?? [];
  const geometry = useHistoryGeometry(historyRef, messages);
  const scope = selectedId ?? 'new-task';
  const composerStorageKey = draftKey(scope);
  const restoredDraft = storageGet(composerStorageKey) ?? (selectedId === null ? overview?.task?.objective ?? '' : '');
  const composerKey = snapshot?.id ?? (notices.overviewLoading ? 'loading' : overview?.task !== null ? 'new-task-ready' : 'empty');

  const gate = useMemo(() => resolveGate(overview, connection), [overview, connection]);
  const pending = actionPending !== null;
  const canStart = useMemo(() => resolveCanStart(selectedId, overview), [selectedId, overview]);
  const controls = useMemo(() => resolveRunControls(snapshot, gate, pending), [snapshot, gate, pending]);
  const composerState = useMemo(
    () => resolveComposer(snapshot, gate, pending, composerIntent, canStart),
    [snapshot, gate, pending, composerIntent, canStart],
  );
  // With the create panel owning task creation, the composer under an empty view never starts tasks.
  const effectiveComposerState = useMemo(
    () => (snapshot === null && selectedId === null
      ? { available: false, reason: '在上方创建面板确认任务合同后启动' }
      : composerState),
    [snapshot, selectedId, composerState],
  );
  const decideState = useMemo(() => resolveDecide(snapshot, gate, pending), [snapshot, gate, pending]);
  const selectedTool = snapshot?.tools.find((tool) => tool.id === selectedToolId) ?? null;

  const detailScroll = useRememberedScroll(detailRef, 'context', scope);
  const historyScroll = useRememberedScroll(historyRef, 'conversation', scope);
  const historyGeometry = useMemo(() => ({
    ...geometry,
    onScroll: (event: { readonly currentTarget: HTMLElement }) => {
      geometry.onScroll(event);
      historyScroll.onScroll(event);
    },
  }), [geometry, historyScroll]);

  const latestAssistantId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'assistant') return messages[index].id;
    }
    return null;
  }, [messages]);

  const announce = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2800);
  }, []);

  useEffect(() => () => { if (toastTimer.current !== null) window.clearTimeout(toastTimer.current); }, []);

  useEffect(() => {
    const requestId = snapshot?.approval?.requestId;
    if (composerIntent !== null && requestId !== composerIntent.requestId) setComposerIntent(null);
  }, [composerIntent, snapshot?.approval?.requestId]);

  useEffect(() => {
    if (selectedToolId !== null && selectedTool === null) setSelectedToolId(null);
  }, [selectedTool, selectedToolId]);

  const runAction = useCallback((action: () => Promise<unknown>, success: string) => {
    void action().then(() => announce(success)).catch((error: unknown) => {
      announce(error instanceof Error && error.message.trim() !== '' ? error.message : '操作未完成，请检查当前状态后重试。');
    });
  }, [announce]);

  const handleAppend = useCallback(async (text: string) => {
    try {
      if (composerIntent !== null) {
        const approval = snapshot?.approval;
        if (approval === undefined || approval === null || approval.requestId !== composerIntent.requestId) {
          throw new Error('当前审批已经变化，请重新核对后提交。');
        }
        await commands.decide(approval.requestId, 'deny', text);
        announce(composerIntent.kind === 'revise' ? '调整要求已回到当前审批。' : '拒绝理由已提交。');
        setComposerIntent(null);
      } else if (snapshot === null) {
        await commands.start(text);
        announce('真实任务已启动。');
      } else {
        await commands.submitInput(text);
        announce('补充内容已收到，将在下一次处理边界送达。');
      }
      storageRemove(composerStorageKey);
    } catch (error) {
      setDraftRecoveryToken((value) => value + 1);
      throw error;
    }
  }, [announce, commands, composerIntent, composerStorageKey, snapshot]);

  const openEvidence = useCallback((tab: EvidenceTab) => {
    setEvidenceTab(tab);
    storageSet(prefKeys.evidenceTab, tab);
    setDetailOpen(true);
    window.requestAnimationFrame(() => {
      if (detailRef.current !== null) detailRef.current.scrollTop = 0;
    });
  }, []);

  const activateEvidence = useCallback((toolId: string, tab: EvidenceTab) => {
    setSelectedToolId(toolId);
    openEvidence(tab);
  }, [openEvidence]);

  const prepareDecision = useCallback((kind: 'deny' | 'revise', requestId: string) => {
    setComposerIntent({ kind, requestId });
    window.requestAnimationFrame(() => composerRef.current?.focus());
    announce(kind === 'revise'
      ? '请在输入区写明需要怎样调整；当前审批仍保持等待。'
      : '请在输入区写明拒绝理由；当前审批仍保持等待。');
  }, [announce]);

  const allowOnce = useCallback(() => {
    const approval = snapshot?.approval;
    if (approval === undefined || approval === null) return;
    runAction(() => commands.decide(approval.requestId, 'allow-once'), '已允许这一次操作。');
  }, [commands, runAction, snapshot?.approval]);

  const submitReview = useCallback((decisions: readonly HumanReviewDecision[]) => {
    runAction(() => commands.submitReview(decisions), '人工验收已提交，完成状态等待可信链确认。');
  }, [commands, runAction]);

  const openStop = useCallback(() => {
    setStopAttempted(false);
    stopDialogRef.current?.showModal();
  }, []);

  const confirmStop = useCallback(async (reason: string): Promise<boolean> => {
    setStopAttempted(true);
    setStopPending(true);
    try {
      await commands.stop(reason);
      announce('急停请求已提交，等待运行进入已终止状态。');
      return true;
    } catch {
      return false;
    } finally {
      setStopPending(false);
    }
  }, [announce, commands]);

  const onComposerChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    storageSet(composerStorageKey, event.currentTarget.value);
  };

  const onStart = useCallback(() => {
    runAction(() => commands.start(''), '任务已启动。');
  }, [commands, runAction]);

  const handleCreateAndStart = useCallback(async (input: GuiFreeTaskInput): Promise<GuiLiveSnapshot> => {
    const created = await commands.createTask(input);
    await commands.start('');
    return created;
  }, [commands]);

  const openBranch = useCallback((messageId: string) => {
    setBranchFor(messageId);
    branchDialogRef.current?.showModal();
  }, []);

  const confirmBranch = useCallback(async () => {
    if (branchFor === null) return;
    setBranchPending(true);
    try {
      await commands.createBranch(branchFor);
      branchDialogRef.current?.close();
      setBranchFor(null);
      announce('讨论分支已创建；前情已写入新任务，审批与验收不继承。');
    } catch (error) {
      announce(error instanceof Error && error.message.trim() !== '' ? error.message : '分支创建失败。');
    } finally {
      setBranchPending(false);
    }
  }, [branchFor, commands, announce]);

  const badge = connectionBadge(overview, connection, notices.overviewLoading, notices.overviewError !== null);
  const shownBadge = provenance === 'fixture'
    ? { ...badge, label: badge.state === 'danger' ? '试件连接中断' : '试件已连接', detail: '构造数据驱动，不代表真实事件流' }
    : badge;
  const switchState = useCallback((id: string | null) => resolveSessionSwitch(id, overview), [overview]);

  return (
    <div className="wb-root" data-provenance={provenance}>
      <a className="skip-link" href="#conversation-main">跳到当前对话</a>
      <div
        className="conversation-shell wb-shell"
        data-review-expanded={expanded}
        data-detail-open={detailOpen}
        data-rail-collapsed={railCollapsed}
        data-run-state={snapshot?.status ?? 'idle'}
      >
        <WorkspaceRail
          overview={overview}
          selectedId={selectedId}
          badge={shownBadge}
          collapsed={railCollapsed}
          switchState={switchState}
          newTaskState={switchState(null)}
          onSelect={commands.chooseSession}
          onToggleCollapsed={() => setRailCollapsed(!railCollapsed)}
          onUpdateMeta={commands.updateMeta}
          onCreateWorkspace={commands.createWorkspace}
        />

        <LiveJarvisExternalStoreProvider
          messages={messages}
          tools={snapshot?.tools ?? []}
          onAppend={handleAppend}
          isRunning={isActuallyRunning(snapshot?.status)}
          isSendDisabled={!effectiveComposerState.available}
          composerKey={composerKey}
          restoredDraft={restoredDraft}
          draftRecoveryToken={draftRecoveryToken}
        >
          <ConversationPane
            overview={overview}
            snapshot={snapshot}
            notices={notices}
            connection={connection}
            actionPending={actionPending}
            provenance={provenance}
            models={input.models}
            gate={gate}
            canStart={canStart}
            controls={controls}
            decideState={decideState}
            composerState={effectiveComposerState}
            composerIntent={composerIntent}
            composerRef={composerRef}
            historyRef={historyScroll.attach}
            geometry={historyGeometry}
            composerStorageKey={composerStorageKey}
            detailOpen={detailOpen}
            latestAssistantId={latestAssistantId}
            onComposerChange={onComposerChange}
            onEvidence={activateEvidence}
            onOpenEvidence={openEvidence}
            onPause={() => runAction(commands.pause, '暂停请求已提交。')}
            onContinue={() => runAction(commands.continueRun, '继续请求已提交。')}
            onResume={() => runAction(commands.resume, '恢复请求已提交。')}
            onStop={openStop}
            onPrepareDecision={prepareDecision}
            onAllow={allowOnce}
            onSubmitReview={submitReview}
            onToggleDetail={() => setDetailOpen((current) => !current)}
            onValidateTask={commands.validateTask}
            onCreateTask={commands.createTask}
            onCreateAndStart={handleCreateAndStart}
            onStart={onStart}
            onBranch={snapshot === null ? undefined : openBranch}
          />
        </LiveJarvisExternalStoreProvider>

        {detailOpen ? (
          <DetailPane
            overview={overview}
            snapshot={snapshot}
            streamWarning={notices.streamWarning}
            selectedTool={selectedTool as GuiTool | null}
            evidenceTab={evidenceTab}
            detailRef={detailScroll.attach}
            evidenceRef={evidenceRef}
            expanded={expanded}
            taskId={selectedId}
            actionPending={pending}
            runTerminal={commands.runTerminal}
            cancelTerminal={commands.cancelTerminal}
            onTab={(tab) => { setEvidenceTab(tab); storageSet(prefKeys.evidenceTab, tab); }}
            onToggleExpanded={() => setExpanded(!expanded)}
            onClose={() => setDetailOpen(false)}
            onContextScroll={detailScroll.onScroll}
            getGit={commands.getGit}
          />
        ) : null}
      </div>

      <StopDialog
        dialogRef={stopDialogRef}
        pending={stopPending}
        error={stopAttempted ? notices.actionError : null}
        onConfirm={confirmStop}
      />

      <dialog ref={branchDialogRef} className="wb-branch-dialog" aria-label="创建讨论分支">
        <h3>从此处创建讨论分支？</h3>
        <p>复制这条回复之前的对话为前情，写入新任务；新任务独立预算与基线，不继承审批与验收。</p>
        <div className="wb-branch-actions">
          <button type="button" onClick={() => { branchDialogRef.current?.close(); setBranchFor(null); }}>取消</button>
          <button type="button" className="wb-commit" disabled={branchPending} onClick={() => { void confirmBranch(); }}>
            {branchPending ? '创建中…' : '创建分支'}
          </button>
        </div>
      </dialog>

      <div className="prototype-toast live-toast wb-toast" data-open={toast !== null} role="status" aria-live="polite">
        {toast}
      </div>
    </div>
  );
}
