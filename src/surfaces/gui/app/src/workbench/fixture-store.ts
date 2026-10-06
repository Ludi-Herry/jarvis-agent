import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GuiLiveSnapshot, GuiMessage } from '../../../live-types.js';
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

  const commands = useMemo<WorkbenchCommands>(() => ({
    chooseSession: (id) => {
      setSelectedId(id);
      setSnapshot(id === null ? null : fixture.snapshot);
      setOverview(id === null ? { ...fixture.overview, sessions: [], activeId: null } : fixture.overview);
    },
    start: async (text) => {
      const running = findFixture('running');
      const base = structuredClone(running?.snapshot ?? requireSnapshot());
      base.id = 'gui-fixture-started';
      base.sessionId = base.id;
      base.goalId = base.id;
      base.objective = text;
      base.messages = [{ id: 'fixture-start', role: 'user', text, at: nowIso(), status: 'complete', toolIds: [] }, ...base.messages.slice(1)];
      setSelectedId(base.id);
      setSnapshot(base);
      setOverview((current) => ({ ...current, sessions: [{ id: base.id, objective: text, status: base.status }], activeId: base.id }));
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
  }), [advance, fixture, requireSnapshot]);

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
    fixture,
    selectFixture,
    simulateReconnect,
  };
}
