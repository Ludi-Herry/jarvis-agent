import { useState } from 'react';
import { useFixtureSession } from './fixture-store.js';
import { workbenchFixtures } from './fixtures.js';
import { prefKeys, storageSet } from './prefs.js';
import { Workbench } from './workbench.js';

// Headless captures cannot click; seed the evidence-pane preference before first render.
// Specimen-only affordance: the live surface never reads this parameter.
if (new URLSearchParams(window.location.search).get('expanded') === '1') {
  storageSet(prefKeys.reviewExpanded, 'true');
}

/**
 * Deterministic specimen entry (`?fixture=`). It renders the same workbench against constructed
 * projections so every state can be inspected without a runtime, a model or a file write.
 */
export function FixtureJarvisApp({ fixtureId }: { readonly fixtureId: string }) {
  const session = useFixtureSession(fixtureId);
  const [open, setOpen] = useState(false);

  return (
    <>
      <Workbench input={session} />
      <section className="wb-fixture-switch" data-open={open} aria-label="确定性试件切换器">
        {open ? (
          <>
            <header>
              <strong>确定性试件</strong>
              <button type="button" onClick={() => setOpen(false)} aria-expanded={open}>收起</button>
            </header>
            <p>本地构造数据：不联网、不落盘、不消耗模型预算，也不构成任何验收结论。</p>
            <div className="wb-fixture-list">
              {workbenchFixtures.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-selected={session.fixture.id === item.id}
                  onClick={() => session.selectFixture(item.id)}
                >
                  <strong>{item.label}</strong>
                  <small>{item.hint}</small>
                </button>
              ))}
            </div>
            {session.connection === 'disconnected' ? (
              <button type="button" className="wb-fixture-reconnect" onClick={session.simulateReconnect}>
                模拟重连（仅试件）
              </button>
            ) : null}
          </>
        ) : (
          <button type="button" className="wb-fixture-pill" onClick={() => setOpen(true)} aria-expanded={open}>
            试件
          </button>
        )}
      </section>
    </>
  );
}
