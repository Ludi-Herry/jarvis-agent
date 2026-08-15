import { describe, expect, it } from 'vitest';
import { AgentEventWriter, type AgentCompletion } from '../../src/runtime/agent-events.js';

describe('AgentEventWriter v1', () => {
  it('projects the frozen lifecycle set with contiguous envelopes and no raw terminal controls', () => {
    const lines: string[] = [];
    const writer = new AgentEventWriter({
      invocationId: 'goal-1',
      defaultSessionId: 'session-1',
      root: 'goal',
      cwd: 'H:/repo\u001b[2J\r\nspoof',
      writeLine: (line) => lines.push(line),
      now: () => '2026-08-15T00:00:00.000Z',
    });

    writer.sessionStarted({ sessionId: 'session-1', resumed: false, model: 'model\u001b[31m' });
    writer.accept({
      type: 'model_started', sessionId: 'session-1', modelRunId: 'mr-1', requestId: 'req-1',
      turn: 0, messageCount: 2, toolSchemaCount: 1,
    });
    writer.accept({
      type: 'model_finished', sessionId: 'session-1', modelRunId: 'mr-1', requestId: 'req-1',
      turn: 0, status: 'completed', finishReason: 'tool_calls', rawFinishReason: 'tool_calls',
      inputTokens: 10, outputTokens: 5,
    });
    writer.accept({
      type: 'tool_execution_started', sessionId: 'session-1', modelRunId: 'mr-1', requestId: 'req-1',
      executionId: 'exec-1', toolCallId: 'call-1', toolName: 'write\nspoof',
    });
    writer.accept({
      type: 'tool_execution_finished', sessionId: 'session-1', modelRunId: 'mr-1', requestId: 'req-1',
      executionId: 'exec-1', toolCallId: 'call-1', toolName: 'write\nspoof', outcome: 'denied',
    });
    writer.accept({
      type: 'approval_request', requestId: 'approval-1', sessionId: 'session-1', toolName: 'write',
      capability: 'writes-files', reason: 'ask\u001b[2J', detail: 'secret-command-or-path\r\nforged', at: 't1',
    });
    writer.accept({
      type: 'approval_result', requestId: 'approval-1', sessionId: 'session-1', toolName: 'write',
      decision: 'error', error: 'secret-approver-error', at: 't2',
    });
    writer.accept({
      type: 'check_finished', goalId: 'goal-1', sessionId: 'session-1', checkId: 'canonical:0', kind: 'canonical', status: 'passed', exitCode: 0,
    });
    writer.runFinished({ status: 'completed', exitCode: 0, verdict: 'verified', completion: { granted: true, authority: 'decideVerdict' } });

    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.map((record) => record.type)).toEqual([
      'session.started', 'model.started', 'model.finished', 'tool.started', 'tool.finished',
      'approval.required', 'approval.resolved', 'check.finished', 'run.finished',
    ]);
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(records.every((record) => record.schemaVersion === 1 && record.invocationId === 'goal-1')).toBe(true);
    const envelopeKeys = ['schemaVersion', 'sequence', 'invocationId', 'sessionId', 'cwd', 'timestamp'];
    const exactPayloadKeys = [
      ['type', 'root', 'resumed', 'model'],
      ['type', 'modelRunId', 'turn', 'messageCount', 'toolSchemaCount', 'requestId'],
      [
        'type', 'modelRunId', 'turn', 'status', 'requestId', 'finishReason', 'rawFinishReason',
        'inputTokens', 'outputTokens',
      ],
      ['type', 'modelRunId', 'toolCallId', 'toolName', 'requestId', 'executionId'],
      ['type', 'modelRunId', 'toolCallId', 'toolName', 'outcome', 'requestId', 'executionId'],
      ['type', 'requestId', 'toolName', 'capability', 'reason'],
      ['type', 'requestId', 'toolName', 'decision'],
      ['type', 'goalId', 'checkId', 'kind', 'status', 'exitCode'],
      ['type', 'root', 'status', 'exitCode', 'verdict', 'completion'],
    ];
    expect(records.map((record) => Object.keys(record).sort())).toEqual(
      exactPayloadKeys.map((payloadKeys) => [...envelopeKeys, ...payloadKeys].sort()),
    );
    expect(Object.keys(records[8].completion as Record<string, unknown>).sort()).toEqual(['authority', 'granted']);
    expect(lines.every((line) => !line.includes('\u001b') && !line.includes('\r') && !line.includes('\n'))).toBe(true);
    expect(records[3]).not.toHaveProperty('arguments');
    expect(records[4]).not.toHaveProperty('output');
    expect(JSON.stringify(records)).not.toContain('secret-command-or-path');
    expect(JSON.stringify(records)).not.toContain('secret-approver-error');
  });

  it('fails closed when a non-verdict surface tries to claim completion authority', () => {
    const writer = new AgentEventWriter({
      invocationId: 'run-1', defaultSessionId: 'session-1', root: 'run', cwd: 'H:/repo',
      writeLine: () => undefined, now: () => '2026-08-15T00:00:00.000Z',
    });
    expect(() => writer.runFinished({
      status: 'completed', exitCode: 0,
      completion: { granted: true, authority: 'none' } as unknown as AgentCompletion,
    })).toThrow(/completion authority/);
  });

  it('rejects a dormant decideVerdict authority marker when completion was not granted', () => {
    const writer = new AgentEventWriter({
      invocationId: 'goal-1', defaultSessionId: 'session-1', root: 'goal', cwd: 'H:/repo',
      writeLine: () => undefined, now: () => '2026-08-15T00:00:00.000Z',
    });
    expect(() => writer.runFinished({
      status: 'blocked', exitCode: 3,
      completion: { granted: false, authority: 'decideVerdict' } as unknown as AgentCompletion,
    })).toThrow(/completion authority/);
  });

  it('rejects undocumented nested completion keys at runtime', () => {
    const writer = new AgentEventWriter({
      invocationId: 'run-1', defaultSessionId: 'session-1', root: 'run', cwd: 'H:/repo',
      writeLine: () => undefined, now: () => '2026-08-15T00:00:00.000Z',
    });
    expect(() => writer.runFinished({
      status: 'completed', exitCode: 0,
      completion: { granted: false, authority: 'none', undocumented: true } as unknown as AgentCompletion,
    })).toThrow(/completion shape/);
  });

  it('keeps loop-level sessionId null while preserving per-goal session identity', () => {
    const lines: string[] = [];
    const writer = new AgentEventWriter({
      invocationId: 'loop-1', defaultSessionId: null, root: 'loop', cwd: 'H:/repo',
      writeLine: (line) => lines.push(line), now: () => '2026-08-15T00:00:00.000Z',
    });
    writer.sessionStarted({ sessionId: 'loop-1-g0', resumed: false, model: 'model' });
    writer.accept({
      type: 'approval_request', requestId: 'a1', sessionId: 'loop-1-g0', toolName: 'write',
      capability: 'writes-files', reason: 'approval required', detail: 'path', at: 't1',
    });
    writer.runFinished({ status: 'blocked', exitCode: 3, completion: { granted: false, authority: 'none' } });
    const records = lines.map((line) => JSON.parse(line) as { sessionId: string | null });
    expect(records[0].sessionId).toBe('loop-1-g0');
    expect(records[1].sessionId).toBe('loop-1-g0');
    expect(records[2].sessionId).toBeNull();
  });
});
