/**
 * JSONL parsing with crash-recovery diagnostics.
 *
 * Append-only stores intentionally recover every complete record around a malformed line. This
 * helper keeps that behavior while retaining enough location data for a read-only observer to
 * distinguish a damaged middle record from a crash-truncated tail.
 */

export type JsonlMalformedLine = {
  kind: 'malformed-middle' | 'malformed-tail' | 'invalid-record';
  line: number;
};

export type JsonlRecordValidator<T> = (value: unknown) => value is T;

export interface JsonlParseResult<T> {
  records: T[];
  malformed: JsonlMalformedLine[];
}

/** Parse valid JSONL records and retain 1-based positions for syntactically or
 * structurally invalid non-blank lines. A store supplies its own shallow schema
 * validator so JSON values such as null, arrays, unknown discriminators, and
 * records missing replay-critical fields never pass through a type assertion. */
export function parseJsonlWithDiagnostics<T>(
  text: string,
  validate?: JsonlRecordValidator<T>,
): JsonlParseResult<T> {
  const lines = text.split('\n');
  const lastContentIndex = findLastContentIndex(lines);
  const records: T[] = [];
  const malformed: JsonlMalformedLine[] = [];

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (validate && !validate(value)) {
        malformed.push({ kind: 'invalid-record', line: index + 1 });
      } else {
        records.push(value as T);
      }
    } catch {
      malformed.push({
        kind: index === lastContentIndex ? 'malformed-tail' : 'malformed-middle',
        line: index + 1,
      });
    }
  }

  return { records, malformed };
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasStringFields(value: Record<string, unknown>, ...fields: string[]): boolean {
  return fields.every((field) => typeof value[field] === 'string');
}

export function hasFiniteNumberFields(value: Record<string, unknown>, ...fields: string[]): boolean {
  return fields.every((field) => typeof value[field] === 'number' && Number.isFinite(value[field]));
}

/** Operational resume may recover a syntactically truncated final append, but
 * must reject middle corruption, structurally invalid records, or a missing
 * replay header. Observation remains best-effort and reports every issue. */
export function assertOperationalJsonlIntegrity(
  kind: string,
  issues: readonly JsonlMalformedLine[],
  hasHeader: boolean,
): void {
  const unsafe = issues.find((issue) => issue.kind !== 'malformed-tail');
  if (unsafe) throw new Error(`${kind} state is corrupt at line ${unsafe.line} (${unsafe.kind})`);
  if (!hasHeader) throw new Error(`${kind} state is corrupt: missing header`);
}

function findLastContentIndex(lines: readonly string[]): number {
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index].trim() !== '') return index;
  }
  return -1;
}
