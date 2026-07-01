import { describe, expect, it } from 'vitest';
import { parseCronDaemonArgs } from '../../src/surfaces/cli/cron-daemon-args.js';

describe('parseCronDaemonArgs', () => {
  it('parses a trusted cron config path with the default poll interval', () => {
    expect(parseCronDaemonArgs(['--cron-map', 'C:\\trusted\\loop-cron.json'])).toEqual({
      cronMapPath: 'C:\\trusted\\loop-cron.json',
      pollMs: 60_000,
    });
  });

  it('parses a custom poll interval', () => {
    expect(parseCronDaemonArgs(['--cron-map', 'C:\\trusted\\loop-cron.json', '--poll-ms', '30000'])).toEqual({
      cronMapPath: 'C:\\trusted\\loop-cron.json',
      pollMs: 30_000,
    });
  });

  it('rejects missing cron-map, unknown flags, and out-of-range poll intervals', () => {
    expect(() => parseCronDaemonArgs([])).toThrow(/--cron-map/);
    expect(() => parseCronDaemonArgs(['--cron-map'])).toThrow(/requires a path/);
    expect(() => parseCronDaemonArgs(['--cron-map', 'C:\\trusted\\loop-cron.json', '--poll-ms'])).toThrow(/requires a value/);
    expect(() => parseCronDaemonArgs(['--cron-map', 'C:\\trusted\\loop-cron.json', '--poll-ms', '9999'])).toThrow(/poll-ms/);
    expect(() => parseCronDaemonArgs(['--cron-map', 'C:\\trusted\\loop-cron.json', '--poll-ms', '3600001'])).toThrow(/poll-ms/);
    expect(() => parseCronDaemonArgs(['--wat'])).toThrow(/unknown flag/);
  });
});
