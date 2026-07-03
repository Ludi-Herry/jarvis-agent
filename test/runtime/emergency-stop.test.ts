import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createEmergencyStopSignal,
  emergencyStopAuditPath,
  emergencyStopPath,
  readEmergencyStop,
  requestEmergencyStop,
  shouldHonorEmergencyStop,
  type EmergencyStopState,
} from '../../src/runtime/index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jarvis-emergency-stop-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('emergency stop control file', () => {
  it('writes a stop request and an append-only audit record', async () => {
    const record = await requestEmergencyStop({
      cwd: dir,
      source: 'gui',
      reason: 'operator pressed stop',
      now: () => new Date('2026-07-03T12:00:00.000Z'),
      pid: 42,
    });

    expect(record).toEqual({
      schemaVersion: 1,
      requestedAt: '2026-07-03T12:00:00.000Z',
      source: 'gui',
      reason: 'operator pressed stop',
      pid: 42,
      cwd: dir,
    });
    await expect(readFile(emergencyStopPath(dir), 'utf8')).resolves.toContain('"source": "gui"');
    await expect(readFile(emergencyStopAuditPath(dir), 'utf8')).resolves.toContain('"reason":"operator pressed stop"');

    const state = await readEmergencyStop(dir);
    expect(state).toMatchObject({ requested: true, record });
    expect(shouldHonorEmergencyStop(state, Date.parse('2026-07-03T11:59:59.000Z'))).toBe(true);
    expect(shouldHonorEmergencyStop(state, Date.parse('2026-07-03T12:00:01.000Z'))).toBe(false);
  });

  it('treats a newly corrupt stop file as a stop request instead of ignoring it', async () => {
    await mkdir(join(dir, 'data', 'control'), { recursive: true });
    await writeFile(emergencyStopPath(dir), '{', 'utf8');

    const state = await readEmergencyStop(dir);

    expect(state.requested).toBe(true);
    expect(state.unreadable).toBe(true);
    expect(state.requestedAtMs).toBeTypeOf('number');
  });
});

describe('createEmergencyStopSignal', () => {
  it('aborts when a stop request is newer than the run start', async () => {
    const states: EmergencyStopState[] = [
      { path: 'stop.json', requested: false },
      { path: 'stop.json', requested: true, requestedAtMs: 11, record: {
        schemaVersion: 1,
        requestedAt: '2026-07-03T00:00:00.011Z',
        source: 'test',
        reason: 'stop',
        pid: 1,
        cwd: dir,
      } },
    ];
    const seen: EmergencyStopState[] = [];
    const stop = createEmergencyStopSignal({
      cwd: dir,
      pollMs: 60_000,
      startedAt: new Date(10),
      read: async () => states.shift() ?? seen.at(-1) ?? { path: 'stop.json', requested: false },
      onStop: (state) => seen.push(state),
    });
    try {
      await stop.checkNow();
      expect(stop.signal.aborted).toBe(true);
      expect(seen).toHaveLength(1);
    } finally {
      stop.dispose();
    }
  });

  it('ignores stale stop requests from before this run started', async () => {
    const stop = createEmergencyStopSignal({
      cwd: dir,
      pollMs: 60_000,
      startedAt: new Date(20),
      read: async () => ({ path: 'stop.json', requested: true, requestedAtMs: 10 }),
    });
    try {
      await stop.checkNow();
      expect(stop.signal.aborted).toBe(false);
    } finally {
      stop.dispose();
    }
  });
});
