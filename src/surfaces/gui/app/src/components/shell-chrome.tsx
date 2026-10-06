import type { RefObject } from 'react';
import type { DemoAction, DemoState } from '../demo/demo-reducer.js';
import { guiRecover17 } from '../demo/gui-recover-17.js';
import { statePresentation } from '../demo/presentation.js';

export function HistoryRail({
  state,
  dispatch,
  announce,
}: {
  readonly state: DemoState;
  readonly dispatch: (action: DemoAction) => void;
  readonly announce: (message: string) => void;
}) {
  const fixtureSelected = ['running', 'approval', 'failed', 'completed'].includes(state.runState)
    ? state.runState
    : null;

  return (
    <aside className="history-rail" aria-label="任务与会话">
      <header className="brand-block">
        <div className="brand-mark" aria-hidden="true">J</div>
        <div>
          <strong>Jarvis</strong>
          <span>Conversation workspace</span>
        </div>
      </header>

      <div className="prototype-note">
        <span className="prototype-dot" aria-hidden="true" />
        <div>
          <strong>React P2 Spike</strong>
          <span>模拟事件 · 无 Runtime · 无真实写入</span>
        </div>
      </div>

      <nav className="session-nav" aria-label="会话列表">
        <p className="rail-label">当前任务</p>
        {guiRecover17.sessions.map((session, index) => (
          <div key={session.id} className={index === 1 ? 'session-divider' : undefined}>
            {index === 1 ? <p className="rail-label rail-label-spaced">最近会话</p> : null}
            <button
              className={`session-row${session.current ? ' is-current' : ''}`}
              type="button"
              aria-current={session.current ? 'page' : undefined}
              onClick={() =>
                announce(
                  session.current
                    ? '当前模拟会话保持选中。'
                    : `P2 只验证当前会话；“${session.title}”保留为导航证据。`,
                )
              }
            >
              <span className={`session-state is-${session.status}`} aria-hidden="true" />
              <span>
                <strong>{session.title}</strong>
                <small>{session.detail}</small>
              </span>
            </button>
          </div>
        ))}
      </nav>

      <section className="state-lab" aria-labelledby="state-lab-title">
        <div className="rail-label-row">
          <p id="state-lab-title" className="rail-label">状态演示</p>
          <button type="button" onClick={() => dispatch({ type: 'reset' })}>重置</button>
        </div>
        <div className="state-options">
          {([
            ['running', '运行'],
            ['approval', '待批'],
            ['completed', '完成'],
            ['failed', '失败'],
          ] as const).map(([fixture, label]) => (
            <button
              key={fixture}
              type="button"
              aria-pressed={fixtureSelected === fixture}
              data-selected={fixtureSelected === fixture}
              onClick={() => dispatch({ type: 'set-fixture', state: fixture })}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={state.unknownEvent !== null}
            data-selected={state.unknownEvent !== null}
            onClick={() => dispatch({ type: 'show-unknown', eventType: 'future.gui.event' })}
          >
            未知事件
          </button>
        </div>
      </section>

      <footer className="rail-footer">
        <span>{guiRecover17.meta.workspace}</span>
        <strong>{guiRecover17.meta.branch}</strong>
      </footer>
    </aside>
  );
}

function RunControls({
  state,
  dispatch,
  openTerminate,
  recoverButtonRef,
  announce,
}: {
  readonly state: DemoState;
  readonly dispatch: (action: DemoAction) => void;
  readonly openTerminate: () => void;
  readonly recoverButtonRef: RefObject<HTMLButtonElement | null>;
  readonly announce: (message: string) => void;
}) {
  const pauseEnabled = ['running', 'approval', 'validating'].includes(state.runState);
  const continueEnabled = state.runState === 'paused' || state.runState === 'restored';
  const recoverEnabled = state.runState === 'failed' || state.runState === 'interrupted';
  const terminateEnabled = state.runState !== 'completed' && state.runState !== 'interrupted';

  return (
    <div className="run-controls" aria-label="运行控制">
      <button
        type="button"
        disabled={!pauseEnabled}
        onClick={() => {
          dispatch({ type: 'pause' });
          announce('模拟运行已暂停；当前现场保持原位。');
        }}
      >
        暂停
      </button>
      <button
        type="button"
        disabled={!continueEnabled}
        onClick={() => {
          dispatch({ type: 'continue' });
          announce('模拟运行已从原阶段继续。');
        }}
      >
        继续
      </button>
      <button
        ref={recoverButtonRef}
        type="button"
        disabled={!recoverEnabled}
        onClick={() => {
          dispatch({ type: 'recover' });
          announce('模拟现场已恢复；请检查位置与草稿后继续。');
        }}
      >
        恢复
      </button>
      <button className="danger" type="button" disabled={!terminateEnabled} onClick={openTerminate}>
        终止
      </button>
    </div>
  );
}

export function Topbar({
  state,
  dispatch,
  openTerminate,
  recoverButtonRef,
  announce,
}: {
  readonly state: DemoState;
  readonly dispatch: (action: DemoAction) => void;
  readonly openTerminate: () => void;
  readonly recoverButtonRef: RefObject<HTMLButtonElement | null>;
  readonly announce: (message: string) => void;
}) {
  const presentation = statePresentation[state.runState];
  return (
    <header className="conversation-topbar">
      <div className="topbar-copy">
        <span className="eyebrow">{guiRecover17.task.id}</span>
        <h1>{guiRecover17.task.objective}</h1>
      </div>
      <div className="run-status" data-tone={presentation.tone} role="status" aria-live="polite">
        <span className="run-status-dot" aria-hidden="true" />
        <span>
          <strong>{presentation.label}</strong>
          <small>{presentation.detail}</small>
        </span>
      </div>
      <div
        className="authority-seal"
        data-tone={state.verified ? 'success' : presentation.tone}
        aria-label={
          state.verified
            ? '完成授权已由 decideVerdict 授予（模拟）'
            : '完成授权未授予'
        }
      >
        <span>完成授权</span>
        <strong>{state.verified ? '已授权' : '未授予'}</strong>
      </div>
      <RunControls
        state={state}
        dispatch={dispatch}
        openTerminate={openTerminate}
        recoverButtonRef={recoverButtonRef}
        announce={announce}
      />
    </header>
  );
}
