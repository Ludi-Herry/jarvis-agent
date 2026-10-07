import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GuiFileView, GuiGitStatus, GuiLiveOverviewSession, GuiLiveSnapshot, GuiMessage, GuiTaskValidateResponse } from '../../../live-types.js';
import type { GuiCreateTaskInput, GuiMetaPatch, GuiWorkspaceInput } from '../live/api.js';
import { findFixture, workbenchFixtures, type WorkbenchFixture } from './fixtures.js';
import type { WorkbenchCommands, WorkbenchInput } from './types.js';

/**
 * Local specimen driver. It only mutates in-memory state so the workbench can be clicked through
 * without a runtime, a model or a file write. Completion is granted only when the specimen's own
 * deterministic checks passed and every review item was approved, mirroring the real chain's shape.
 */

const RUNNING_CAPABILITIES = { submit: true, pause: true, continue: false, stop: true, resume: false };

function nowIso(): string {
  return new Date('2026-09-26T09:10:00.000Z').toISOString();
}

/** Batch 4 §阅读: deterministic file previews for fixture artifact paths (no disk reads here). */
const FIXTURE_FILES: Record<string, { kind: 'text' | 'image'; content: string; mime?: string; truncated: false; sizeBytes: number }> = {
  'fixture/answer.mjs': {
    kind: 'text',
    content: 'export const label = "从左侧选择任务，中间描述目标；写入前会在右侧请求你的批准。";\n',
    truncated: false,
    sizeBytes: 96,
  },
  'fixture/v13-shot.png': {
    kind: 'image',
    content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==',
    mime: 'image/png',
    truncated: false,
    sizeBytes: 67,
  },
};

function asUserMessage(text: string, index: number): GuiMessage {
  return { id: `fixture-input-${index}`, role: 'user', text, at: nowIso(), status: 'complete', toolIds: [] };
}

export interface FixtureSession extends WorkbenchInput {
  readonly fixture: WorkbenchFixture;
  readonly selectFixture: (id: string) => void;
  readonly simulateReconnect: () => void;
}

export function useFixtureSession(fixtureId: string | null): FixtureSession {
  const initial = findFixture(fixtureId) ?? workbenchFixtures[0];
  const [fixture, setFixture] = useState<WorkbenchFixture>(initial);
  const [snapshot, setSnapshot] = useState<GuiLiveSnapshot | null>(initial.snapshot);
  const [overview, setOverview] = useState(initial.overview);
  const [connection, setConnection] = useState(initial.connection);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initial.snapshot === null ? null : initial.snapshot.id);
  const timers = useRef<number[]>([]);
  const snapshotRef = useRef<GuiLiveSnapshot | null>(initial.snapshot);
  useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);

  useEffect(() => () => { for (const timer of timers.current) window.clearTimeout(timer); }, []);

  const later = useCallback((delay: number, run: () => void) => {
    timers.current.push(window.setTimeout(run, delay));
  }, []);

  const advance = useCallback((label: string, apply: (draft: GuiLiveSnapshot) => void, settle?: (draft: GuiLiveSnapshot) => void) => {
    setActionPending(label);
    setActionError(null);
    setSnapshot((current) => {
      if (current === null) return current;
      const draft = structuredClone(current);
      draft.sequence += 1;
      apply(draft);
      return draft;
    });
    if (settle === undefined) {
      later(700, () => setActionPending(null));
      return;
    }
    later(900, () => {
      setSnapshot((current) => {
        if (current === null) return current;
        const draft = structuredClone(current);
        draft.sequence += 1;
        settle(draft);
        return draft;
      });
      setActionPending(null);
    });
  }, [later]);

  const requireSnapshot = useCallback((): GuiLiveSnapshot => {
    if (snapshot === null) throw new Error('试件当前没有运行现场。');
    return snapshot;
  }, [snapshot]);

  /** Streams one chunk into the open terminal row, mirroring the gui_terminal 'out' fold. */
  const appendTerminalChunk = useCallback((chunk: string) => {
    setSnapshot((current) => {
      if (current === null) return current;
      const draft = structuredClone(current);
      draft.sequence += 1;
      const entry = draft.terminal?.history.at(-1);
      if (draft.terminal?.running != null && entry !== undefined && entry.code === null && !entry.canceled) {
        entry.output += chunk;
      }
      return draft;
    });
  }, []);

  const createFixtureTask = useCallback(async (input: GuiCreateTaskInput): Promise<GuiLiveSnapshot> => {
    const id = `gui-fixture-created-${Math.abs(Date.now() % 100_000)}`;
    const isFork = 'forkFrom' in input;
    const parentTitle = isFork
      ? overview.sessions.find((session) => session.id === input.forkFrom.parentId)?.title ?? ''
      : '';
    const sourceRef = isFork
      ? { parentId: input.forkFrom.parentId, turnId: input.forkFrom.turnId, summary: `承接「${parentTitle.slice(0, 40)}」的讨论分支（试件示意）` }
      : undefined;
    const objective = isFork ? `承接「${parentTitle.slice(0, 60)}」的讨论分支` : ('objective' in input ? input.objective : '');
    const base = findFixture('running')?.snapshot;
    if (!base) throw new Error('试件基座缺失。');
    const created: GuiLiveSnapshot = {
      ...structuredClone(base),
      id, sequence: 0, objective, cwd: overview.cwd, model: 'deterministic-fixture', thinking: 'off',
      sessionId: id, goalId: id, status: 'idle', phase: '任务已创建，待启动', nextAction: '', startedAt: nowIso(), elapsedMs: 0,
      messages: isFork && snapshot !== null ? snapshot.messages.filter((item) => item.role === 'user' || item.role === 'assistant').slice(0, 4) : [],
      tools: [], approval: null, approvalHistory: [], pendingInputs: [],
      checks: [], diff: '', artifacts: [],
      usage: { inputTokens: 0, outputTokens: 0, costCny: null, costNote: '试件不计费' },
      warnings: [], capabilities: { submit: false, pause: false, continue: false, stop: false, resume: false },
      ...(sourceRef ? { sourceRef } : {}),
    } as GuiLiveSnapshot;
    const row: GuiLiveOverviewSession = {
      id, title: objective.slice(0, 60), objective, status: 'idle',
      workspaceId: isFork
        ? (overview.sessions.find((session) => session.id === input.forkFrom.parentId)?.workspaceId ?? overview.workspaces[0]?.id ?? '')
        : (('workspaceId' in input ? input.workspaceId : undefined) ?? overview.workspaces[0]?.id ?? ''),
      pinned: false, archived: false, updatedAt: nowIso(), lastMessage: '',
      ...(sourceRef ? { sourceRef } : {}),
    };
    setOverview((current) => ({ ...current, sessions: [row, ...current.sessions] }));
    setSelectedId(id);
    snapshotRef.current = created;
    setSnapshot(created);
    return created;
  }, [overview, snapshot]);

  const commands = useMemo<WorkbenchCommands>(() => ({
    chooseSession: (id) => {
      setSelectedId(id);
      setSnapshot(id === null ? null : fixture.snapshot);
      setOverview(id === null ? { ...fixture.overview, sessions: [], activeId: null, activeIds: [] } : fixture.overview);
    },
    start: async (text, taskId) => {
      const running = findFixture('running');
      const base = structuredClone(running?.snapshot ?? requireSnapshot());
      const current = snapshotRef.current;
      if (taskId !== undefined && taskId !== current?.id) throw new Error('启动目标与已创建的任务不一致。');
      // An empty text means "start the currently selected contract" (batch 2 per-task start).
      base.id = current?.id ?? 'gui-fixture-started';
      base.sessionId = base.id;
      base.goalId = base.id;
      if (text.trim() !== '') {
        base.objective = text;
        base.messages = [{ id: 'fixture-start', role: 'user', text, at: nowIso(), status: 'complete', toolIds: [] }, ...base.messages.slice(1)];
      } else if (current !== null) {
        base.objective = current.objective;
        base.messages = current.messages.length > 0 ? base.messages.map((item, index) => index === 0 ? { ...item, text: current.objective } : item) : base.messages;
      }
      setSelectedId(base.id);
      snapshotRef.current = base;
      setSnapshot(base);
      setOverview((current) => ({
        ...current,
        sessions: current.sessions.some((session) => session.id === base.id)
          ? current.sessions.map((session) => session.id === base.id ? { ...session, status: base.status, updatedAt: nowIso() } : session)
          : [{ id: base.id, title: base.objective.slice(0, 60), objective: base.objective, status: base.status, workspaceId: current.workspaces[0]?.id ?? 'ws-fixture-main', pinned: false, archived: false, updatedAt: nowIso(), lastMessage: '' }, ...current.sessions],
        activeId: base.id,
        activeIds: [base.id],
      }));
    },
    submitInput: async (text) => {
      requireSnapshot();
      advance('正在发送', (draft) => { draft.pendingInputs.push(text); }, (draft) => {
        draft.pendingInputs = draft.pendingInputs.filter((item) => item !== text);
        draft.messages = [...draft.messages, asUserMessage(text, draft.messages.length)];
        draft.phase = '补充指令已在处理边界送达';
      });
    },
    pause: async () => advance('正在暂停', (draft) => {
      draft.status = 'pausing';
      draft.phase = '等待下一模型调用边界暂停';
      draft.capabilities = { ...draft.capabilities, pause: false, continue: true };
    }, (draft) => {
      draft.status = 'paused';
      draft.phase = '已在模型调用边界暂停；尚未发送下一请求';
      draft.nextAction = '补充指令后继续，或终止本次运行';
    }),
    continueRun: async () => advance('正在继续', (draft) => {
      draft.status = 'running';
      draft.phase = '继续现有执行；保留原预算';
      draft.capabilities = RUNNING_CAPABILITIES;
    }),
    stop: async (reason) => {
      if (reason.trim() === '') {
        setActionError('请填写终止原因。');
        throw new Error('请填写终止原因。');
      }
      requireSnapshot();
      advance('正在终止', (draft) => {
        draft.status = 'stopping';
        draft.phase = '正在中断在途执行';
        draft.capabilities = { submit: false, pause: false, continue: false, stop: false, resume: false };
      }, (draft) => {
        draft.status = 'interrupted';
        draft.phase = `运行停止：${reason.trim()}`;
        draft.approval = null;
        draft.tools = draft.tools.map((tool) => tool.status === 'proposed' || tool.status === 'running'
          ? { ...tool, status: 'denied', output: '审批因执行中断而失效；副作用未发生' }
          : tool);
        draft.completion = { granted: false, verdict: 'none', rationale: '急停后没有交付；待批写入未发生。' };
        draft.warnings = [...draft.warnings, 'Session 留有未执行工具意图，自动恢复继续被拒绝。'];
      });
    },
    resume: async () => advance('正在恢复', (draft) => {
      draft.status = 'running';
      draft.phase = '已从持久事实恢复；继续原预算';
      draft.capabilities = RUNNING_CAPABILITIES;
    }),
    decide: async (requestId, decision, reason) => {
      const current = requireSnapshot();
      if (current.approval?.requestId !== requestId) {
        setActionError('当前审批已经变化，请重新核对后提交。');
        throw new Error('审批已变化');
      }
      if (decision === 'deny' && (reason ?? '').trim() === '') {
        setActionError('拒绝或要求调整时必须说明理由。');
        throw new Error('缺少理由');
      }
      advance(decision === 'allow-once' ? '正在批准' : '正在提交理由', (draft) => {
        const toolName = draft.approval?.toolName ?? 'write';
        const target = draft.tools.find((tool) => tool.status === 'proposed');
        draft.approvalHistory = [...draft.approvalHistory, { requestId, toolName, decision, ...(reason ? { reason } : {}) }];
        draft.approval = null;
        draft.status = 'running';
        draft.capabilities = RUNNING_CAPABILITIES;
        if (decision === 'allow-once') {
          draft.phase = '写入已执行；继续本次运行';
          draft.tools = draft.tools.map((tool) => tool === target ? { ...tool, status: 'committed', output: `已写入 ${tool.path ?? '目标文件'}` } : tool);
          if (target?.path !== undefined) draft.artifacts = [...draft.artifacts, { path: target.path, outcome: 'written' }];
        } else {
          draft.phase = '拒绝理由已回到模型；等待下一次处理边界';
          draft.tools = draft.tools.map((tool) => tool === target ? { ...tool, status: 'denied', output: `用户要求调整：${reason}` } : tool);
        }
      });
    },
    submitReview: async (decisions) => {
      requireSnapshot();
      if (decisions.length === 0 || decisions.some((item) => item.note.trim() === '')) {
        setActionError('请逐项检查证据并填写验收说明。');
        throw new Error('验收未填写完整');
      }
      advance('正在提交验收', (draft) => {
        const checksPassed = draft.checks.length > 0 && draft.checks.every((check) => check.code === 0);
        const approved = decisions.every((item) => item.decision === 'approve');
        draft.review = null;
        draft.completion = checksPassed && approved
          ? { granted: true, verdict: 'verified', rationale: '（试件）检查通过且人工验收全部通过；真实授权只能来自既有可信链。' }
          : { granted: false, verdict: checksPassed ? 'rejected_by_human_review' : 'failed', rationale: '（试件）检查或人工验收未全部通过，完成授权保持未授予。' };
        draft.status = draft.completion.granted ? 'complete' : 'blocked';
        draft.phase = draft.completion.granted ? '任务交付与验收已完成' : '验收未通过；完成授权未授予';
      });
    },
    updateMeta: async (id: string, patch: GuiMetaPatch) => {
      setOverview((current) => ({
        ...current,
        sessions: current.sessions.map((session) => {
          if (session.id !== id) return session;
          const titlePatch = patch.title;
          const title = titlePatch === undefined ? session.title
            : titlePatch === null || titlePatch === '' ? session.objective.slice(0, 60) : titlePatch;
          return { ...session, title, pinned: patch.pinned ?? session.pinned, archived: patch.archived ?? session.archived, updatedAt: nowIso() };
        }),
      }));
      setSnapshot((live) => {
        if (live === null || live.id !== id) return live;
        const titlePatch = patch.title;
        return { ...live,
          ...(titlePatch !== undefined ? { title: titlePatch === null || titlePatch === '' ? undefined : titlePatch } : {}),
          ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
          ...(patch.archived !== undefined ? { archived: patch.archived } : {}) };
      });
    },
    createWorkspace: async (input: GuiWorkspaceInput) => {
      if (!input.name.trim() || !input.cwd.trim()) { setActionError('名称与路径都要填写。'); throw new Error('缺少工作区字段'); }
      setOverview((current) => current.workspaces.some((item) => item.cwd === input.cwd.trim())
        ? current
        : { ...current, workspaces: [...current.workspaces, { id: `ws-fixture-${current.workspaces.length + 1}`, name: input.name.trim(), cwd: input.cwd.trim(), createdAt: nowIso(), archived: false, sort: current.workspaces.length }] });
    },
    validateTask: async (input: GuiCreateTaskInput): Promise<GuiTaskValidateResponse> => {
      if ('forkFrom' in input) return { ok: true, errors: [] };
      const errors: GuiTaskValidateResponse['errors'] = [];
      if (!input.objective.trim()) errors.push({ field: 'objective', message: '先写清这次要完成什么。' });
      if (input.writePaths.length === 0 || input.writePaths.some((path) => !path.trim())) errors.push({ field: 'writePaths', message: '至少一条相对写入路径。' });
      if (input.checkCommands.length === 0 || input.checkCommands.some((command) => !command.trim())) errors.push({ field: 'checkCommands', message: '至少一条检查命令。' });
      return { ok: errors.length === 0, errors };
    },
    createTask: async (input: GuiCreateTaskInput): Promise<GuiLiveSnapshot> => createFixtureTask(input),
    createBranch: async (turnId: string): Promise<GuiLiveSnapshot> => {
      const parentId = snapshot?.id ?? selectedId ?? 'gui-fixture-0001';
      return createFixtureTask({ forkFrom: { parentId, turnId } });
    },
    getGit: async (): Promise<GuiGitStatus> => ({
      at: nowIso(), branch: 'main', ahead: 1, behind: 0, uncommitted: 2, worktree: 'dirty',
    }),
    saveWorkspacePresets: async (wsId, input) => {
      setOverview((current) => ({
        ...current,
        workspaces: current.workspaces.map((workspace) => (workspace.id === wsId
          ? { ...workspace, presets: { ...input, savedAt: nowIso() } }
          : workspace)),
      }));
      return { workspaces: [] }; // return value unused by the UI; overview state above is the truth
    },
    probeWorkspaceCommands: async () => ({
      candidates: [
        { command: 'npm run test', source: 'package.json scripts' },
        { command: 'npx vitest run', source: 'vite/vitest 配置' },
      ],
      note: '候选来自项目只读文件（package.json / vite·tsconfig）；采用前请自行确认。（试件）',
    }),
    getFileView: async (_taskId: string, path: string): Promise<GuiFileView> => {
      const found = FIXTURE_FILES[path];
      if (!found) throw new Error('试件没有这个文件');
      return { path, kind: found.kind, content: found.content, truncated: found.truncated, sizeBytes: found.sizeBytes, at: nowIso(), ...(found.mime ? { mime: found.mime } : {}) };
    },
    openFileExternal: async (): Promise<{ ok: true }> => ({ ok: true }),
    runTerminal: async (command: string) => {
      requireSnapshot();
      advance('正在运行命令', (draft) => {
        const history = draft.terminal?.history ?? [];
        draft.terminal = {
          running: { command, startedAt: nowIso() },
          history: [...history, { command, code: null, output: '', canceled: false, at: nowIso() }],
        };
      }, (draft) => {
        const entry = draft.terminal?.history.at(-1);
        if (draft.terminal !== undefined && entry !== undefined && entry.code === null && !entry.canceled) {
          entry.code = 0;
          entry.at = nowIso();
          draft.terminal.running = null;
        }
      });
      later(300, () => appendTerminalChunk('（试件）第一段输出：模拟 node -e 逐行打印的前半。\n'));
      later(600, () => appendTerminalChunk('（试件）第二段输出：模拟 node -e 逐行打印的后半，进程将以 exit 0 结束。\n'));
    },
    cancelTerminal: async () => {
      const current = requireSnapshot();
      if (current.terminal?.running == null) {
        setActionError('当前没有运行中的终端命令。');
        throw new Error('当前没有运行中的终端命令');
      }
      advance('正在取消命令', (draft) => {
        const entry = draft.terminal?.history.at(-1);
        if (draft.terminal !== undefined && entry !== undefined && entry.code === null && !entry.canceled) {
          entry.canceled = true;
          entry.at = nowIso();
          entry.output += '（试件）命令已被取消，进程终止。\n';
          draft.terminal.running = null;
        }
      });
    },
  }), [advance, appendTerminalChunk, createFixtureTask, fixture, later, requireSnapshot]);

  const selectFixture = useCallback((id: string) => {
    const next = findFixture(id);
    if (next === undefined) return;
    setFixture(next);
    setSnapshot(next.snapshot);
    setOverview(next.overview);
    setConnection(next.connection);
    setSelectedId(next.snapshot === null ? null : next.snapshot.id);
    setActionPending(null);
    setActionError(null);
  }, []);

  const simulateReconnect = useCallback(() => {
    setConnection((current) => (current === 'disconnected' ? 'connected' : current));
  }, []);

  return {
    overview,
    snapshot,
    selectedId,
    connection,
    actionPending,
    notices: {
      overviewLoading: false,
      overviewError: null,
      connectionNotice: connection === 'disconnected' ? '连接已中断。控制暂时停用，草稿与阅读位置已保留。' : null,
      streamWarning: null,
      actionError,
    },
    commands,
    provenance: 'fixture',
    models: fixture.models,
    fixture,
    selectFixture,
    simulateReconnect,
  };
}
