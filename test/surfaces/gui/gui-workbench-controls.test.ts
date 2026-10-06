import { describe, expect, it } from 'vitest';
import type { GuiLiveOverview, GuiLiveSnapshot } from '../../../src/surfaces/gui/live-types.js';
import {
  resolveCanStart,
  resolveComposer,
  resolveDecide,
  resolveGate,
  resolveRunControls,
  resolveSessionSwitch,
} from '../../../src/surfaces/gui/app/src/workbench/controls.js';
import {
  MAP_MIN_GUTTER,
  MAP_MIN_SCROLLABLE,
  MAP_MIN_WINDOW_WIDTH,
  currentTurnIndex,
  selectStickyTurn,
  shouldShowConversationMap,
  tickFractions,
} from '../../../src/surfaces/gui/app/src/workbench/scroll-rules.js';

function snapshot(patch: Partial<GuiLiveSnapshot> = {}): GuiLiveSnapshot {
  return {
    id: 'gui-test', sequence: 4, objective: '测试目标', cwd: 'H:\\jarvis-agent', model: 'test-model',
    sessionId: 'gui-test', goalId: 'gui-test', status: 'running', phase: '运行中', nextAction: '观察',
    startedAt: '2026-09-26T09:00:00.000Z', elapsedMs: 1000, messages: [], tools: [], approval: null,
    approvalHistory: [], pendingInputs: [], completion: { granted: false, verdict: 'none', rationale: '未授予' },
    evidenceToken: null, review: null, checks: [], diff: '', artifacts: [],
    usage: { inputTokens: 0, outputTokens: 0, costCny: null, costNote: '' },
    limits: { maxRounds: 2, maxTurns: 6, turnTimeoutMs: 120_000, wallClockMs: 900_000 },
    sources: { session: 's', goal: 'g', approvals: 'a', events: 'e' }, warnings: [],
    capabilities: { submit: true, pause: true, continue: false, stop: true, resume: false },
    ...patch,
  };
}

function overview(patch: Partial<GuiLiveOverview> = {}): GuiLiveOverview {
  return {
    cwd: 'H:\\jarvis-agent', enabled: true,
    task: { objective: '测试目标', requirements: ['要求一'] }, sessions: [], activeId: null,
    ...patch,
  };
}

const NO_CAPABILITIES = { submit: false, pause: false, continue: false, stop: false, resume: false };

describe('GUI workbench control availability', () => {
  it('disables every dangerous control while the stream is down and restores them from host capabilities', () => {
    const running = snapshot();
    const offline = resolveRunControls(running, resolveGate(overview(), 'disconnected'), false);
    expect(offline.stop.available).toBe(false);
    expect(offline.pause.available).toBe(false);
    expect(offline.stop.reason).toContain('连接已中断');

    const reconnected = resolveRunControls(running, resolveGate(overview(), 'connected'), false);
    expect(reconnected.stop.available).toBe(true);
    expect(reconnected.pause.available).toBe(true);

    const stillOfflineDecide = resolveDecide(snapshot({ approval: { requestId: 'r1', toolName: 'write', capability: 'writes-files', reason: '', detail: '', arguments: '{}' } }), resolveGate(overview(), 'disconnected'), false);
    expect(stillOfflineDecide.available).toBe(false);
  });

  it('never widens a control the runtime did not grant', () => {
    const gate = resolveGate(overview(), 'connected');
    const controls = resolveRunControls(snapshot({ capabilities: NO_CAPABILITIES }), gate, false);
    expect(controls.pause.available).toBe(false);
    expect(controls.stop.available).toBe(false);
    expect(controls.resume.available).toBe(false);
    expect(controls.pause.reason).toContain('Runtime');
  });

  it('keeps terminal scenes read-only instead of offering stop or resume', () => {
    const gate = resolveGate(overview(), 'connected');
    // The host reports every capability false for terminal scenes; the UI must not widen that.
    for (const status of ['interrupted', 'blocked', 'complete'] as const) {
      const controls = resolveRunControls(snapshot({ status, capabilities: NO_CAPABILITIES }), gate, false);
      expect(controls.stop.available).toBe(false);
      expect(controls.resume.available).toBe(false);
      expect(controls.stop.reason).toContain('Runtime');
    }
    // Only a scene the host marked recoverable gets a resume entry.
    const recoverable = resolveRunControls(
      snapshot({ status: 'recoverable', capabilities: { ...NO_CAPABILITIES, resume: true } }),
      gate,
      false,
    );
    expect(recoverable.resume.available).toBe(true);
    const blockedEvenIfGranted = resolveRunControls(
      snapshot({ status: 'blocked', capabilities: { ...NO_CAPABILITIES, resume: true } }),
      gate,
      false,
    );
    expect(blockedEvenIfGranted.resume.available).toBe(false);
    const interruptedEvenIfGranted = resolveRunControls(
      snapshot({ status: 'interrupted', capabilities: { ...NO_CAPABILITIES, resume: true } }),
      gate,
      false,
    );
    expect(interruptedEvenIfGranted.resume.available).toBe(false);
    expect(interruptedEvenIfGranted.resume.reason).toContain('可恢复');
  });

  it('closes the composer when the approval it was answering has changed', () => {
    const gate = resolveGate(overview(), 'connected');
    const waiting = snapshot({ status: 'approval', approval: { requestId: 'r2', toolName: 'write', capability: 'writes-files', reason: '', detail: '', arguments: '{}' } });
    const stale = resolveComposer(waiting, gate, false, { kind: 'revise', requestId: 'r1' }, resolveCanStart(null, overview()));
    expect(stale.available).toBe(false);
    expect(stale.reason).toContain('审批已经变化');
    expect(resolveComposer(waiting, gate, false, { kind: 'revise', requestId: 'r2' }, resolveCanStart(null, overview())).available).toBe(true);
  });

  it('refuses to start a second run when the task contract already has a recorded session', () => {
    const recorded = overview({ sessions: [{ id: 'gui-old', objective: '测试目标', status: 'blocked' }] });
    expect(resolveCanStart(null, recorded).available).toBe(false);
    expect(resolveCanStart(null, overview()).available).toBe(true);
    expect(resolveCanStart(null, overview({ enabled: false })).available).toBe(false);
    expect(resolveCanStart(null, overview({ task: null })).available).toBe(false);
  });

  it('locks session switching to the running scene', () => {
    const busy = overview({ sessions: [{ id: 'gui-run', objective: '正在跑', status: 'running' }, { id: 'gui-old', objective: '旧的', status: 'blocked' }] });
    expect(resolveSessionSwitch('gui-old', busy).available).toBe(false);
    expect(resolveSessionSwitch('gui-run', busy).available).toBe(true);
    expect(resolveSessionSwitch('gui-old', overview({ sessions: [{ id: 'gui-old', objective: '旧的', status: 'blocked' }] })).available).toBe(true);
  });
});

describe('GUI long-conversation aids', () => {
  const turns = [
    { id: 'q1', questionTop: 0, questionBottom: 60, question: '第一条提问', answer: '第一条回复摘要' },
    { id: 'q2', questionTop: 400, questionBottom: 470, question: '第二条提问', answer: '第二条回复摘要' },
    { id: 'q3', questionTop: 900, questionBottom: 980, question: '第三条提问', answer: '第三条回复摘要' },
  ];

  it('shows the sticky summary only after a whole question scrolled out and hands over to the next one', () => {
    expect(selectStickyTurn(turns, 0)).toBeNull();
    expect(selectStickyTurn(turns, 59)).toBeNull();
    expect(selectStickyTurn(turns, 60)?.id).toBe('q1');
    expect(selectStickyTurn(turns, 470)?.id).toBe('q2');
    expect(selectStickyTurn(turns, 980)?.id).toBe('q3');
    expect(selectStickyTurn(turns, 400)?.id).toBe('q1');
    expect(selectStickyTurn([], 900)).toBeNull();
  });

  it('hides the positioning track when width, gutter, history or scrolling is insufficient', () => {
    const shown = { windowWidth: 1440, gutterWidth: 96, turnCount: 4, scrollablePx: 900, hasScrolled: true };
    expect(shouldShowConversationMap(shown)).toBe(true);
    expect(shouldShowConversationMap({ ...shown, windowWidth: MAP_MIN_WINDOW_WIDTH - 1 })).toBe(false);
    expect(shouldShowConversationMap({ ...shown, gutterWidth: MAP_MIN_GUTTER - 1 })).toBe(false);
    expect(shouldShowConversationMap({ ...shown, turnCount: 0 })).toBe(false);
    expect(shouldShowConversationMap({ ...shown, scrollablePx: MAP_MIN_SCROLLABLE - 1 })).toBe(false);
    expect(shouldShowConversationMap({ ...shown, hasScrolled: false })).toBe(false);
  });

  it('maps ticks and the current turn onto the same history geometry', () => {
    expect(tickFractions(turns, 2000)).toEqual([0, 0.2, 0.45]);
    expect(tickFractions(turns, 0)).toEqual([0, 0, 0]);
    expect(currentTurnIndex(turns, 0, 600)).toBe(0);
    expect(currentTurnIndex(turns, 500, 600)).toBe(1);
    expect(currentTurnIndex(turns, 900, 600)).toBe(2);
    expect(currentTurnIndex([], 0, 600)).toBe(-1);
  });
});
