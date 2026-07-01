import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadLoopCronConfig, parseLoopCronConfig } from '../../../src/capabilities/goal/loop-cron-config.js';

describe('parseLoopCronConfig', () => {
  it('parses strict cron tasks', () => {
    expect(
      parseLoopCronConfig(
        JSON.stringify({
          tasks: [
            {
              id: 'daily',
              objectivesFile: 'docs/tasks.txt',
              intervalMinutes: 60,
              nextRunAt: '2026-07-01T00:00:00.000Z',
              unattended: true,
              verifierMapPath: 'C:\\trusted\\verifiers.json',
            },
          ],
        }),
      ),
    ).toEqual({
      tasks: [
        {
          id: 'daily',
          objectivesFile: 'docs/tasks.txt',
          intervalMinutes: 60,
          nextRunAt: '2026-07-01T00:00:00.000Z',
          unattended: true,
          verifierMapPath: 'C:\\trusted\\verifiers.json',
        },
      ],
    });
  });

  it.each([
    ['bad json', 'not-json'],
    ['top-level array', '[]'],
    ['unknown top-level key', JSON.stringify({ tasks: [], extra: true })],
    ['missing tasks', JSON.stringify({})],
    ['tasks is not array', JSON.stringify({ tasks: {} })],
    ['entry is not object', JSON.stringify({ tasks: [1] })],
    ['unknown task key', JSON.stringify({ tasks: [{ id: 'x', objectivesFile: 'o.txt', intervalMinutes: 1, nextRunAt: '2026-07-01T00:00:00.000Z', unattended: true, extra: true }] })],
    ['blank id', JSON.stringify({ tasks: [{ id: ' ', objectivesFile: 'o.txt', intervalMinutes: 1, nextRunAt: '2026-07-01T00:00:00.000Z', unattended: true }] })],
    ['duplicate id', JSON.stringify({ tasks: [{ id: 'x', objectivesFile: 'a.txt', intervalMinutes: 1, nextRunAt: '2026-07-01T00:00:00.000Z', unattended: true }, { id: 'x', objectivesFile: 'b.txt', intervalMinutes: 1, nextRunAt: '2026-07-01T00:00:00.000Z', unattended: true }] })],
    ['bad interval', JSON.stringify({ tasks: [{ id: 'x', objectivesFile: 'o.txt', intervalMinutes: 0, nextRunAt: '2026-07-01T00:00:00.000Z', unattended: true }] })],
    ['bad nextRunAt', JSON.stringify({ tasks: [{ id: 'x', objectivesFile: 'o.txt', intervalMinutes: 1, nextRunAt: 'tomorrow', unattended: true }] })],
    ['missing unattended', JSON.stringify({ tasks: [{ id: 'x', objectivesFile: 'o.txt', intervalMinutes: 1, nextRunAt: '2026-07-01T00:00:00.000Z' }] })],
    ['attended task', JSON.stringify({ tasks: [{ id: 'x', objectivesFile: 'o.txt', intervalMinutes: 1, nextRunAt: '2026-07-01T00:00:00.000Z', unattended: false }] })],
    ['objectives file as flag', JSON.stringify({ tasks: [{ id: 'x', objectivesFile: '--resume', intervalMinutes: 1, nextRunAt: '2026-07-01T00:00:00.000Z', unattended: true }] })],
  ])('throws for %s', (_label, text) => {
    expect(() => parseLoopCronConfig(text)).toThrow();
  });
});

describe('loadLoopCronConfig trust boundary', () => {
  const cwd = join(tmpdir(), 'jarvis-cron-repo');
  const outside = join(tmpdir(), 'loop-cron.json');
  const inside = join(cwd, 'loop-cron.json');
  const verifierInside = join(cwd, 'verifier-map.json');

  it('loads a trusted cron config outside cwd after realpath', async () => {
    const text = JSON.stringify({
      tasks: [{ id: 't', objectivesFile: 'tasks.txt', intervalMinutes: 5, nextRunAt: '2026-07-01T00:00:00.000Z', unattended: true }],
    });
    const loaded = await loadLoopCronConfig({
      path: outside,
      cwd,
      readText: async (p) => (p === resolve(outside) ? text : null),
      realpath: async (p) => resolve(p),
    });
    expect(loaded.path).toBe(resolve(outside));
    expect(loaded.tasks[0]?.id).toBe('t');
  });

  it('refuses a cron config that canonicalizes inside cwd', async () => {
    await expect(
      loadLoopCronConfig({
        path: outside,
        cwd,
        readText: async () => JSON.stringify({ tasks: [] }),
        realpath: async (p) => (p === outside ? inside : resolve(p)),
      }),
    ).rejects.toThrow(/inside the working directory/);
  });

  it('refuses a verifier map path inside cwd', async () => {
    await expect(
      loadLoopCronConfig({
        path: outside,
        cwd,
        readText: async () =>
          JSON.stringify({
            tasks: [
              {
                id: 't',
                objectivesFile: 'tasks.txt',
                intervalMinutes: 5,
                nextRunAt: '2026-07-01T00:00:00.000Z',
                unattended: true,
                verifierMapPath: verifierInside,
              },
            ],
          }),
        realpath: async (p) => resolve(p),
      }),
    ).rejects.toThrow(/verifier map.*inside the working directory/);
  });
});
