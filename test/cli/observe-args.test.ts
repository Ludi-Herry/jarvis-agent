import { describe, expect, it } from 'vitest';
import { parseObserveArgs } from '../../src/surfaces/cli/observe-args.js';

describe('parseObserveArgs', () => {
  it('defaults to text output and data/ under the current cwd', () => {
    expect(parseObserveArgs([])).toEqual({ format: 'text' });
  });

  it('parses JSON output and an explicit data dir', () => {
    expect(parseObserveArgs(['--json', '--data-dir', 'C:\\runs\\data'])).toEqual({
      format: 'json',
      dataDir: 'C:\\runs\\data',
    });
  });

  it('rejects unknown flags and missing values', () => {
    expect(() => parseObserveArgs(['--wat'])).toThrow(/unknown flag/);
    expect(() => parseObserveArgs(['--data-dir'])).toThrow(/requires a path/);
  });
});
