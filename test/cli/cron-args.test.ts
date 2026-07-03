import { describe, expect, it } from 'vitest';
import { buildLoopCronCommand, parseCronArgs } from '../../src/surfaces/cli/cron-args.js';

describe('parseCronArgs', () => {
  it('parses the trusted cron config path', () => {
    expect(parseCronArgs(['--cron-map', 'C:\\trusted\\loop-cron.json'])).toEqual({
      cronMapPath: 'C:\\trusted\\loop-cron.json',
    });
  });

  it('rejects missing cron-map and unknown flags', () => {
    expect(() => parseCronArgs([])).toThrow(/--cron-map/);
    expect(() => parseCronArgs(['--cron-map'])).toThrow(/requires a path/);
    expect(() => parseCronArgs(['--wat'])).toThrow(/unknown flag/);
  });
});

describe('buildLoopCronCommand', () => {
  it('builds a regular loop command with unattended and trusted map flags', () => {
    const command = buildLoopCronCommand({
      id: 't',
      objectivesFile: 'tasks with spaces.txt',
      intervalMinutes: 10,
      nextRunAt: '2026-07-01T00:00:00.000Z',
      unattended: true,
      verifierMapPath: 'C:\\trusted\\map.json',
      goalSetterRequirementsMapPath: 'C:\\trusted\\requirements.json',
    });
    expect(command).toContain('npm run loop --');
    expect(command).toContain('--unattended');
    expect(command).toContain('--verifier-map');
    expect(command).toContain('--goal-setter-requirements-map');
    expect(command).toContain('tasks with spaces.txt');
  });
});
