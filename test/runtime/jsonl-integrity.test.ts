import { describe, expect, it } from 'vitest';
import { parseJsonlWithDiagnostics } from '../../src/runtime/jsonl-integrity.js';

describe('parseJsonlWithDiagnostics', () => {
  it('recovers valid records and distinguishes malformed middle and tail lines', () => {
    const parsed = parseJsonlWithDiagnostics<{ id: string }>([
      '{"id":"first"}',
      '{not valid json}',
      '{"id":"second"}',
      '{"id":"truncated"',
      '',
    ].join('\n'));

    expect(parsed.records).toEqual([{ id: 'first' }, { id: 'second' }]);
    expect(parsed.malformed).toEqual([
      { kind: 'malformed-middle', line: 2 },
      { kind: 'malformed-tail', line: 4 },
    ]);
  });

  it('does not mark blank lines as damaged', () => {
    const parsed = parseJsonlWithDiagnostics<never>(' \r\n\n');

    expect(parsed).toEqual({ records: [], malformed: [] });
  });

  it.each([null, [], {}, { t: 'unknown' }, { t: 'session' }])(
    'reports syntactically valid but structurally invalid JSON as invalid-record: %j',
    (value) => {
      const parsed = parseJsonlWithDiagnostics(
        `${JSON.stringify(value)}\n`,
        (candidate): candidate is { t: 'session'; id: string } => (
          typeof candidate === 'object'
          && candidate !== null
          && !Array.isArray(candidate)
          && 't' in candidate
          && candidate.t === 'session'
          && 'id' in candidate
          && typeof candidate.id === 'string'
        ),
      );

      expect(parsed).toEqual({ records: [], malformed: [{ kind: 'invalid-record', line: 1 }] });
    },
  );
});
