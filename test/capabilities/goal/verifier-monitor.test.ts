import { describe, expect, it } from 'vitest';
import { VerifierMonitor } from '../../../src/capabilities/goal/verifier-monitor.js';

describe('VerifierMonitor — couldNotVerify-rate health (Part7 §6.3)', () => {
  it('stays ok below the minimum sample count even if every sample is couldNotVerify', () => {
    const m = new VerifierMonitor();
    expect(m.record('couldNotVerify')).toBe('ok'); // 1 sample
    expect(m.record('couldNotVerify')).toBe('ok'); // 2
    expect(m.record('couldNotVerify')).toBe('ok'); // 3 — still under the min
  });

  it('alerts (degraded) when the couldNotVerify rate exceeds the threshold', () => {
    const m = new VerifierMonitor();
    m.record('couldNotVerify');
    m.record('couldNotVerify');
    m.record('couldNotVerify');
    expect(m.record('couldNotVerify')).toBe('degraded'); // 4/4 = 1.0 > 0.6, min samples reached
  });

  it('stays ok when most verdicts are real (verified/rejected dominate)', () => {
    const m = new VerifierMonitor();
    m.record('verified');
    m.record('rejected');
    m.record('verified');
    m.record('couldNotVerify');
    expect(m.record('rejected')).toBe('ok'); // 1/5 couldNotVerify
  });

  it('recovers to ok once recent verdicts improve (sliding window)', () => {
    const m = new VerifierMonitor();
    for (let i = 0; i < 4; i++) m.record('couldNotVerify');
    expect(m.record('couldNotVerify')).toBe('degraded');
    // push enough real verdicts to slide the couldNotVerify ones out of the 10-wide window
    let last: 'ok' | 'degraded' = 'degraded';
    for (let i = 0; i < 10; i++) last = m.record('verified');
    expect(last).toBe('ok');
  });
});
