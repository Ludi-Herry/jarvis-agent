import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  GuiConnectionState,
  GuiLiveOverview,
  GuiLiveSnapshot,
  GuiStreamFrame,
  GuiWorkspacePresets,
} from '../../../live-types.js';
import {
  createLiveTask,
  createLiveWorkspace,
  getLiveFileView,
  getLiveGitStatus,
  getLiveOverview,
  getLiveSnapshot,
  postInputWithdraw,
  postLiveMeta,
  postLiveSnapshot,
  postOpenFileExternal,
  postTerminalCancel,
  postTerminalCommand,
  saveWorkspacePresets as saveWorkspacePresetsApi,
  probeWorkspaceCommands as probeWorkspaceCommandsApi,
  startLiveTask,
  validateLiveTask,
  type GuiCreateTaskInput,
  type GuiMetaPatch,
  type GuiWorkspaceInput,
} from './api.js';

export type LiveConnectionState = GuiConnectionState;

export interface HumanReviewDecision {
  readonly requirementId: string;
  readonly decision: 'approve' | 'reject';
  readonly note: string;
}

const SELECTED_VIEW_KEY = 'jarvis.gui.live.selected-view';

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return '操作未完成，请检查当前状态后重试。';
}

function isStreamFrame(value: unknown): value is GuiStreamFrame {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<GuiStreamFrame>;
  return typeof candidate.id === 'string'
    && typeof candidate.sequence === 'number'
    && typeof candidate.snapshot === 'object'
    && candidate.snapshot !== null;
}

export function useLiveSession() {
  const [overview, setOverview] = useState<GuiLiveOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<GuiLiveSnapshot | null>(null);
  const [connection, setConnection] = useState<LiveConnectionState>('loading');
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);
  const [streamWarning, setStreamWarning] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const selectedIdRef = useRef<string | null>(null);
  const initialSelectionDoneRef = useRef(false);
  const snapshotsRef = useRef(new Map<string, GuiLiveSnapshot>());
  const latestSequenceRef = useRef(new Map<string, number>());
  const actionPendingRef = useRef<string | null>(null);
  const liveEnabled = overview?.enabled ?? false;

  const chooseSession = useCallback((id: string | null) => {
    selectedIdRef.current = id;
    setSelectedId(id);
    if (id === null) {
      window.localStorage.setItem(SELECTED_VIEW_KEY, 'new-task');
      setSnapshot(null);
      return;
    }
    window.localStorage.setItem(SELECTED_VIEW_KEY, id);
    setSnapshot(snapshotsRef.current.get(id) ?? null);
  }, []);

  const syncOverviewSession = useCallback((next: GuiLiveSnapshot, started = false) => {
    setOverview((current) => {
      if (current === null) return current;
      const existing = current.sessions.some((session) => session.id === next.id);
      const sessions = existing
        ? current.sessions.map((session) => session.id === next.id
            ? { ...session, objective: next.objective, status: next.status,
                title: next.title ?? session.title, pinned: next.pinned ?? session.pinned,
                archived: next.archived ?? session.archived, updatedAt: new Date().toISOString() }
            : session)
        : [{ id: next.id, title: next.title ?? next.objective.slice(0, 60), objective: next.objective,
             status: next.status, workspaceId: current.workspaces[0]?.id ?? '', pinned: false,
             archived: false, updatedAt: new Date().toISOString(), lastMessage: '' }, ...current.sessions];
      return {
        ...current,
        sessions,
        ...(started ? { activeId: next.id } : {}),
      };
    });
  }, []);

  const acceptSnapshot = useCallback((next: GuiLiveSnapshot): boolean => {
    if (next.id !== selectedIdRef.current) return false;
    const latest = latestSequenceRef.current.get(next.id) ?? -1;
    if (next.sequence <= latest) return false;
    latestSequenceRef.current.set(next.id, next.sequence);
    snapshotsRef.current.set(next.id, next);
    setSnapshot(next);
    syncOverviewSession(next);
    return true;
  }, [syncOverviewSession]);

  const refreshOverview = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await getLiveOverview(signal);
      setOverview(next);
      setOverviewError(null);
      if (!initialSelectionDoneRef.current) {
        initialSelectionDoneRef.current = true;
        const saved = window.localStorage.getItem(SELECTED_VIEW_KEY);
        const savedSession = next.sessions.some((session) => session.id === saved) ? saved : null;
        const initial = saved === 'new-task' && next.task !== null && next.activeId === null
          ? null
          : savedSession ?? next.activeId ?? (next.task === null ? next.sessions[0]?.id ?? null : null);
        chooseSession(initial);
      }
      if (selectedIdRef.current === null) {
        setConnection(next.enabled ? 'connected' : 'unavailable');
      }
    } catch (error) {
      if (signal?.aborted) return;
      setOverviewError(errorMessage(error));
      setConnection('unavailable');
    } finally {
      if (!signal?.aborted) setOverviewLoading(false);
    }
  }, [chooseSession]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshOverview(controller.signal);
    return () => controller.abort();
  }, [refreshOverview]);

  useEffect(() => {
    if (selectedId === null) {
      setSnapshot(null);
      setConnection(overview === null ? 'loading' : liveEnabled ? 'connected' : 'unavailable');
      setConnectionNotice(null);
      return undefined;
    }

    let disposed = false;
    let opened = false;
    const controller = new AbortController();
    const cached = snapshotsRef.current.get(selectedId);
    setSnapshot(cached ?? null);
    setConnection('connecting');
    setConnectionNotice('正在连接当前会话…');
    setStreamWarning(null);

    const refreshSnapshot = async (fallback = false) => {
      try {
        const next = await getLiveSnapshot(selectedId, controller.signal);
        if (!disposed && next.id === selectedId) {
          acceptSnapshot(next);
          if (fallback) {
            setConnection('connected');
            setConnectionNotice('事件流正在重连，已通过会话接口恢复最新状态。');
          }
        }
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        setConnectionNotice(errorMessage(error));
      }
    };

    void refreshSnapshot();
    const events = new EventSource(`/api/live/${encodeURIComponent(selectedId)}/events`);

    events.onopen = () => {
      if (disposed) return;
      setConnection('connected');
      setConnectionNotice(null);
      if (opened) void refreshSnapshot();
      opened = true;
    };

    events.addEventListener('snapshot', (event) => {
      if (disposed || !(event instanceof MessageEvent)) return;
      try {
        const value: unknown = JSON.parse(String(event.data));
        if (!isStreamFrame(value)) {
          setStreamWarning('收到一条无法识别的实时更新，当前事实未改变。');
          return;
        }
        if (value.snapshot.id !== selectedId || value.snapshot.sequence !== value.sequence) {
          setStreamWarning('实时更新的身份或顺序不一致，已保留当前可信现场。');
          return;
        }
        const expectedEventId = `${value.snapshot.id}:${value.sequence}`;
        if (value.id !== expectedEventId || (event.lastEventId !== '' && event.lastEventId !== expectedEventId)) {
          setStreamWarning('实时更新的续接标识不一致，已忽略这条更新。');
          return;
        }
        acceptSnapshot(value.snapshot);
      } catch {
        setStreamWarning('收到一条损坏的实时更新，当前事实未改变。');
      }
    });

    events.onerror = () => {
      if (disposed) return;
      setConnection('disconnected');
      setConnectionNotice('连接已中断。控制暂时停用，草稿与阅读位置已保留，系统会自动重连。');
      void refreshSnapshot(true);
    };

    return () => {
      disposed = true;
      controller.abort();
      events.close();
    };
  }, [acceptSnapshot, liveEnabled, selectedId]);

  const receiveMutationSnapshot = useCallback((next: GuiLiveSnapshot, started = false) => {
    const latest = latestSequenceRef.current.get(next.id) ?? -1;
    if (next.sequence > latest) {
      latestSequenceRef.current.set(next.id, next.sequence);
      snapshotsRef.current.set(next.id, next);
    }
    if (started || selectedIdRef.current !== next.id) chooseSession(next.id);
    const accepted = snapshotsRef.current.get(next.id) ?? next;
    setSnapshot(accepted);
    syncOverviewSession(accepted, started);
  }, [chooseSession, syncOverviewSession]);

  const runMutation = useCallback(async (
    label: string,
    request: () => Promise<GuiLiveSnapshot>,
    started = false,
  ): Promise<GuiLiveSnapshot> => {
    if (actionPendingRef.current !== null) throw new Error('另一项操作仍在确认中。');
    actionPendingRef.current = label;
    setActionPending(label);
    setActionError(null);
    try {
      const next = await request();
      receiveMutationSnapshot(next, started);
      void refreshOverview();
      return next;
    } catch (error) {
      const message = errorMessage(error);
      setActionError(message);
      throw error;
    } finally {
      actionPendingRef.current = null;
      setActionPending(null);
    }
  }, [receiveMutationSnapshot, refreshOverview]);

  const selectedPath = useCallback((suffix: string) => {
    const id = selectedIdRef.current;
    if (id === null) throw new Error('请先选择一个会话。');
    return `/api/live/${encodeURIComponent(id)}/${suffix}`;
  }, []);

  /** Ref-read so mutations always target the task the operator is actually viewing. */
  const selectedTaskId = useCallback(() => {
    const id = selectedIdRef.current;
    if (id === null) throw new Error('请先选择一个会话。');
    return id;
  }, []);

  // The text argument stays for the pinned-contract legacy call sites; starts now target a task id.
  const start = useCallback(async (text: string, taskId?: string) => {
    void text;
    if (overview === null || !overview.enabled) {
      throw new Error('真实运行入口当前未启用。');
    }
    const id = taskId ?? selectedIdRef.current;
    if (id === null) throw new Error('请先选择要启动的任务；新建任务请在任务创建面板确认合同。');
    // The server is the authority on start readiness; the SSE stream may still be reconnecting.
    return runMutation('正在启动', () => startLiveTask(id), true);
  }, [overview, runMutation]);

  const submitInput = useCallback(async (text: string) => {
    if (overview?.enabled !== true) throw new Error('真实运行入口当前未启用。');
    if (connection !== 'connected') throw new Error('连接已中断，补充内容尚未发送。');
    return runMutation('正在发送', () => postLiveSnapshot(selectedPath('input'), { text }));
  }, [connection, overview?.enabled, runMutation, selectedPath]);

  // Batch 6 §可控: withdraw one queued input; selectedTaskId pins the viewed task like runTerminal.
  const withdrawInput = useCallback(async (index: number) => {
    if (overview?.enabled !== true) throw new Error('真实运行入口当前未启用。');
    if (connection !== 'connected') throw new Error('连接已中断，撤回尚未提交。');
    return runMutation('正在撤回', () => postInputWithdraw(selectedTaskId(), index));
  }, [connection, overview?.enabled, runMutation, selectedTaskId]);

  const pause = useCallback(async () => {
    if (overview?.enabled !== true) throw new Error('真实运行入口当前未启用。');
    if (connection !== 'connected') throw new Error('连接已中断，无法暂停。');
    return runMutation('正在暂停', () => postLiveSnapshot(selectedPath('pause'), {}));
  }, [connection, overview?.enabled, runMutation, selectedPath]);

  const continueRun = useCallback(async () => {
    if (overview?.enabled !== true) throw new Error('真实运行入口当前未启用。');
    if (connection !== 'connected') throw new Error('连接已中断，无法继续。');
    return runMutation('正在继续', () => postLiveSnapshot(selectedPath('continue'), {}));
  }, [connection, overview?.enabled, runMutation, selectedPath]);

  const stop = useCallback(async (reason: string) => {
    if (overview?.enabled !== true) throw new Error('真实运行入口当前未启用。');
    if (connection !== 'connected') throw new Error('连接已中断，无法提交终止请求。');
    const normalized = reason.trim();
    if (normalized === '') throw new Error('请填写终止原因。');
    return runMutation('正在终止', () => postLiveSnapshot(selectedPath('stop'), { reason: normalized }));
  }, [connection, overview?.enabled, runMutation, selectedPath]);

  const resume = useCallback(async () => {
    if (overview?.enabled !== true) throw new Error('真实运行入口当前未启用。');
    if (connection !== 'connected') throw new Error('连接已中断，无法恢复。');
    return runMutation('正在恢复', () => postLiveSnapshot(selectedPath('resume'), {}));
  }, [connection, overview?.enabled, runMutation, selectedPath]);

  const decide = useCallback(async (
    requestId: string,
    decision: 'allow-once' | 'deny',
    reason?: string,
  ) => {
    if (overview?.enabled !== true) throw new Error('真实运行入口当前未启用。');
    if (connection !== 'connected') throw new Error('连接已中断，审批尚未提交。');
    const normalized = reason?.trim();
    if (decision === 'deny' && !normalized) throw new Error('拒绝或要求调整时必须说明理由。');
    return runMutation(
      decision === 'allow-once' ? '正在批准' : '正在提交理由',
      () => postLiveSnapshot(selectedPath('decision'), {
        requestId,
        decision,
        ...(normalized ? { reason: normalized } : {}),
      }),
    );
  }, [connection, overview?.enabled, runMutation, selectedPath]);

  const submitReview = useCallback(async (decisions: readonly HumanReviewDecision[]) => {
    if (overview?.enabled !== true) throw new Error('真实运行入口当前未启用。');
    if (connection !== 'connected') throw new Error('连接已中断，验收尚未提交。');
    if (decisions.length === 0 || decisions.some((item) => item.note.trim() === '')) {
      throw new Error('请逐项检查证据并填写验收说明。');
    }
    return runMutation(
      '正在提交验收',
      () => {
        const viewed = selectedIdRef.current ? snapshotsRef.current.get(selectedIdRef.current) : undefined;
        if (!viewed?.evidenceToken) throw new Error('当前没有可确认的验证证据，请先刷新现场。');
        return postLiveSnapshot(selectedPath('review'), { decisions, sequence: viewed.sequence, evidenceToken: viewed.evidenceToken });
      },
    );
  }, [connection, overview?.enabled, runMutation, selectedPath]);

  const updateMeta = useCallback(async (id: string, patch: GuiMetaPatch) => {
    if (overview?.enabled !== true) throw new Error('真实运行入口当前未启用。');
    const next = await postLiveMeta(id, patch);
    if (next.id === selectedIdRef.current) receiveMutationSnapshot(next);
    void refreshOverview();
  }, [overview?.enabled, receiveMutationSnapshot, refreshOverview]);

  const createWorkspace = useCallback(async (input: GuiWorkspaceInput) => {
    if (overview?.enabled !== true) throw new Error('真实运行入口当前未启用。');
    await createLiveWorkspace(input);
    void refreshOverview();
  }, [overview?.enabled, refreshOverview]);

  // Batch 5 §启动: same enable-check + overview-refresh posture as createWorkspace above.
  const saveWorkspacePresets = useCallback(async (wsId: string, input: Omit<GuiWorkspacePresets, 'savedAt'>) => {
    if (overview?.enabled !== true) throw new Error('真实运行入口当前未启用。');
    const result = await saveWorkspacePresetsApi(wsId, input);
    void refreshOverview();
    return result;
  }, [overview?.enabled, refreshOverview]);

  const probeWorkspaceCommands = useCallback(async (wsId: string) => probeWorkspaceCommandsApi(wsId), []);

  const validateTask = useCallback(async (input: GuiCreateTaskInput) => validateLiveTask(input), []);

  const createTask = useCallback(async (input: GuiCreateTaskInput) => {
    if (overview?.enabled !== true) throw new Error('真实运行入口当前未启用。');
    const next = await createLiveTask(input);
    snapshotsRef.current.set(next.id, next);
    latestSequenceRef.current.set(next.id, next.sequence);
    chooseSession(next.id);
    void refreshOverview();
    return next;
  }, [chooseSession, overview?.enabled, refreshOverview]);

  const createBranch = useCallback(async (turnId: string) => {
    const parentId = selectedIdRef.current;
    if (parentId === null) throw new Error('请先选择一个会话。');
    return createTask({ forkFrom: { parentId, turnId } });
  }, [createTask]);

  const getGit = useCallback(async (id: string) => getLiveGitStatus(id), []);

  const getFileView = useCallback(async (taskId: string, path: string) => getLiveFileView(taskId, path), []);

  const openFileExternal = useCallback(async (taskId: string, path: string) => postOpenFileExternal(taskId, path), []);

  const runTerminal = useCallback(async (command: string) => {
    if (overview?.enabled !== true) throw new Error('真实运行入口当前未启用。');
    if (connection !== 'connected') throw new Error('连接已中断，命令尚未发送。');
    const normalized = command.trim();
    if (normalized === '') throw new Error('请输入要运行的命令。');
    return runMutation('正在运行命令', () => postTerminalCommand(selectedTaskId(), normalized));
  }, [connection, overview?.enabled, runMutation, selectedTaskId]);

  const cancelTerminal = useCallback(async () => {
    if (overview?.enabled !== true) throw new Error('真实运行入口当前未启用。');
    if (connection !== 'connected') throw new Error('连接已中断，无法取消终端命令。');
    return runMutation('正在取消命令', () => postTerminalCancel(selectedTaskId()));
  }, [connection, overview?.enabled, runMutation, selectedTaskId]);

  return {
    overview,
    overviewLoading,
    overviewError,
    selectedId,
    snapshot,
    connection,
    connectionNotice,
    streamWarning,
    actionPending,
    actionError,
    chooseSession,
    refreshOverview,
    start,
    submitInput,
    withdrawInput,
    pause,
    continueRun,
    stop,
    resume,
    decide,
    submitReview,
    updateMeta,
    createWorkspace,
    saveWorkspacePresets,
    probeWorkspaceCommands,
    validateTask,
    createTask,
    createBranch,
    getGit,
    getFileView,
    openFileExternal,
    runTerminal,
    cancelTerminal,
  };
}
