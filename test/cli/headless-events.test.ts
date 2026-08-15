import { describe, expect, it, vi } from 'vitest';
import {
  createProcessAgentEventWriter,
  goalRunFinished,
  isHeadlessAgentEventMode,
  loopRunFinished,
  scrubHeadlessAgentEventEnv,
  verifyAgentEventFrame,
} from '../../src/surfaces/cli/headless-events.js';

describe('headless agent-event process transport', () => {
  it('requires both the trusted mode marker and distinct valid dedicated descriptors', () => {
    expect(isHeadlessAgentEventMode({})).toBe(false);
    expect(isHeadlessAgentEventMode({ JARVIS_HEADLESS: '1' })).toBe(false);
    expect(isHeadlessAgentEventMode({
      JARVIS_HEADLESS: '1', JARVIS_AGENT_EVENT_FD: '3', JARVIS_AGENT_EVENT_AUTH_FD: '4',
    })).toBe(true);
    expect(() => createProcessAgentEventWriter(
      { invocationId: 'run-1', defaultSessionId: 's1', root: 'run', cwd: 'H:/repo' },
      { JARVIS_HEADLESS: '1', JARVIS_AGENT_EVENT_FD: 'stdout', JARVIS_AGENT_EVENT_AUTH_FD: '4' },
    )).toThrow(/descriptor/);
    expect(() => createProcessAgentEventWriter(
      { invocationId: 'run-1', defaultSessionId: 's1', root: 'run', cwd: 'H:/repo' },
      { JARVIS_HEADLESS: '1', JARVIS_AGENT_EVENT_FD: '2', JARVIS_AGENT_EVENT_AUTH_FD: '4' },
    )).toThrow(/dedicated fd/);
    expect(() => createProcessAgentEventWriter(
      { invocationId: 'run-1', defaultSessionId: 's1', root: 'run', cwd: 'H:/repo' },
      { JARVIS_HEADLESS: '1', JARVIS_AGENT_EVENT_FD: '3', JARVIS_AGENT_EVENT_AUTH_FD: '3' },
    )).toThrow(/must differ/);
  });

  it('authenticates the internal frame while preserving compact public JSONL', () => {
    const secret = 'ab'.repeat(32);
    const writeFd = vi.fn();
    const writer = createProcessAgentEventWriter(
      { invocationId: 'run-1', defaultSessionId: 's1', root: 'run', cwd: 'H:/repo' },
      { JARVIS_HEADLESS: '1', JARVIS_AGENT_EVENT_FD: '3', JARVIS_AGENT_EVENT_AUTH_FD: '4' },
      { writeFd, readFd: vi.fn(() => secret) },
    );
    expect(writer).toBeDefined();
    writer?.sessionStarted({ sessionId: 's1', resumed: false, model: 'm' });
    expect(writeFd).toHaveBeenCalledOnce();
    const frame = writeFd.mock.calls[0]?.[1] as string;
    const line = verifyAgentEventFrame(secret, frame.trimEnd());
    expect(writeFd.mock.calls[0]?.[0]).toBe(3);
    expect(line).toMatch(/^\{"schemaVersion":1,.+\}$/u);
    expect(() => verifyAgentEventFrame(secret, `${frame.trimEnd()}x`)).toThrow(/authentication/);
  });

  it('rejects malformed transport secrets before any event can be written', () => {
    expect(() => createProcessAgentEventWriter(
      { invocationId: 'run-1', defaultSessionId: 's1', root: 'run', cwd: 'H:/repo' },
      { JARVIS_HEADLESS: '1', JARVIS_AGENT_EVENT_FD: '3', JARVIS_AGENT_EVENT_AUTH_FD: '4' },
      { writeFd: vi.fn(), readFd: vi.fn(() => 'not-a-32-byte-lowercase-hex-secret') },
    )).toThrow(/auth secret/);
  });

  it('scrubs every internal transport marker before model or tool execution', () => {
    const env = {
      JARVIS_HEADLESS: '1',
      JARVIS_AGENT_EVENT_FD: '3',
      JARVIS_AGENT_EVENT_AUTH_FD: '4',
      PRESERVED: 'yes',
    };

    scrubHeadlessAgentEventEnv(env);

    expect(env).toEqual({ PRESERVED: 'yes' });
  });

  it('derives goal completion authority only from complete/verified', () => {
    expect(goalRunFinished({ state: 'complete', outcome: 'verified' })).toEqual({
      status: 'completed',
      exitCode: 0,
      verdict: 'verified',
      completion: { granted: true, authority: 'decideVerdict' },
    });
    expect(goalRunFinished({ state: 'blocked', outcome: 'checksOnly' })).toMatchObject({
      status: 'unverified',
      exitCode: 4,
      completion: { granted: false, authority: 'none' },
    });
    expect(goalRunFinished({ state: 'complete', outcome: 'checksOnly' }).completion.granted).toBe(false);
  });

  it('keeps loop terminals observation-only even on a clean queue drain', () => {
    expect(loopRunFinished({ reason: 'queue-empty', blocked: 0, needsVerification: 0, runtimeFailures: 0 })).toEqual({
      status: 'completed',
      exitCode: 0,
      completion: { granted: false, authority: 'none' },
    });
  });
});
