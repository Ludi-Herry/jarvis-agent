import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGuiServer,
  hasGuiCsrfHeader,
  isAllowedGuiHostHeader,
  isLoopbackBindHost,
} from '../../../src/surfaces/gui/gui-server.js';
import {
  composeVerifierReport,
  decideVerdict,
  serializeGoalRecord,
  serializeLoopRecord,
  type DeterministicChecks,
  type PinnedRequirement,
} from '../../../src/capabilities/goal/index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jarvis-gui-server-'));
  await mkdir(join(dir, 'data'), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('GUI server security guard', () => {
  it('rejects non-loopback Host headers before serving observation data', async () => {
    const server = createGuiServer({ cwd: dir, dataDir: join(dir, 'data') });
    const base = await listen(server);
    try {
      const result = await httpJson(base.port, {
        path: '/api/status',
        method: 'GET',
        headers: { host: 'evil.example.test' },
      });

      expect(result.status).toBe(403);
      expect(result.body).toEqual({ error: 'forbidden host' });
    } finally {
      await close(server);
    }
  });

  it('requires a GUI-only header before accepting emergency stop POSTs', async () => {
    const server = createGuiServer({ cwd: dir, dataDir: join(dir, 'data') });
    const base = await listen(server);
    try {
      const missingHeader = await httpJson(base.port, {
        path: '/api/emergency-stop',
        method: 'POST',
        headers: { host: `127.0.0.1:${base.port}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'cross-site form post' }),
      });

      expect(missingHeader.status).toBe(403);
      expect(missingHeader.body).toEqual({ error: 'missing x-jarvis-gui header' });

      const allowed = await httpJson(base.port, {
        path: '/api/emergency-stop',
        method: 'POST',
        headers: {
          host: `127.0.0.1:${base.port}`,
          'content-type': 'application/json',
          'x-jarvis-gui': '1',
        },
        body: JSON.stringify({ reason: 'operator stop' }),
      });

      expect(allowed.status).toBe(200);
      expect(allowed.body).toMatchObject({
        record: { reason: 'operator stop', source: 'gui' },
        stop: { requested: true },
      });
    } finally {
      await close(server);
    }
  });

  it('keeps normal same-origin status reads available', async () => {
    const server = createGuiServer({ cwd: dir, dataDir: join(dir, 'data') });
    const base = await listen(server);
    try {
      const result = await httpJson(base.port, {
        path: '/api/status',
        method: 'GET',
        headers: { host: `localhost:${base.port}` },
      });

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        report: { authority: { mode: 'observation-only' } },
        stop: { requested: false },
        timeline: expect.any(Array),
      });
    } finally {
      await close(server);
    }
  });

  it('exposes an interrupted effective goal state without changing observation authority', async () => {
    await writeInterruptedLoopGoal('L-stop', 'L-stop-g0');
    const server = createGuiServer({ cwd: dir, dataDir: join(dir, 'data') });
    const base = await listen(server);
    try {
      const result = await httpJson(base.port, {
        path: '/api/status',
        method: 'GET',
        headers: { host: `127.0.0.1:${base.port}` },
      });

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        report: {
          authority: { mode: 'observation-only', canCompleteGoals: false, canCompleteLoops: false },
          status: {
            latestGoal: {
              id: 'L-stop-g0',
              state: 'active',
              recordedState: 'active',
              effectiveState: 'interrupted',
              effectiveReason: 'emergency-stop',
              effectiveSource: { kind: 'loop-halt', loopId: 'L-stop' },
            },
          },
          usage: { uniqueTotalTokens: 0, coverage: 'partial' },
        },
      });
    } finally {
      await close(server);
    }
  });

  it('returns an empty favicon response instead of a noisy browser 404', async () => {
    const server = createGuiServer({ cwd: dir, dataDir: join(dir, 'data') });
    const base = await listen(server);
    try {
      const result = await httpJson(base.port, {
        path: '/favicon.ico',
        method: 'GET',
        headers: { host: `127.0.0.1:${base.port}` },
      });

      expect(result.status).toBe(204);
      expect(result.body).toBeUndefined();
    } finally {
      await close(server);
    }
  });

  it('lists and applies human-review decisions through the GUI control API', async () => {
    await writeParkedHumanGoal('g-human');
    const server = createGuiServer({ cwd: dir, dataDir: join(dir, 'data') });
    const base = await listen(server);
    try {
      const list = await httpJson(base.port, {
        path: '/api/human-reviews',
        method: 'GET',
        headers: { host: `127.0.0.1:${base.port}` },
      });

      expect(list.status).toBe(200);
      expect(list.body).toMatchObject({
        reviews: [{ goalId: 'g-human', requirements: [{ requirementId: 'r1' }] }],
      });

      const missingHeader = await httpJson(base.port, {
        path: '/api/human-reviews/g-human/decide',
        method: 'POST',
        headers: { host: `127.0.0.1:${base.port}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          decisions: [{ requirementId: 'r1', decision: 'approve', note: 'Looks good.' }],
        }),
      });
      expect(missingHeader.status).toBe(403);

      const decided = await httpJson(base.port, {
        path: '/api/human-reviews/g-human/decide',
        method: 'POST',
        headers: {
          host: `127.0.0.1:${base.port}`,
          'content-type': 'application/json',
          'x-jarvis-gui': '1',
        },
        body: JSON.stringify({
          reviewer: 'Ludi',
          decisions: [{ requirementId: 'r1', decision: 'approve', note: 'Looks good.' }],
        }),
      });

      expect(decided.status).toBe(200);
      expect(decided.body).toMatchObject({
        result: { state: 'complete', verdict: { outcome: 'verified' } },
      });
    } finally {
      await close(server);
    }
  });

  it('rejects encoded path traversal in human-review goal ids', async () => {
    const server = createGuiServer({ cwd: dir, dataDir: join(dir, 'data') });
    const base = await listen(server);
    try {
      const result = await httpJson(base.port, {
        path: '/api/human-reviews/%2e%2e%2fg-human/decide',
        method: 'POST',
        headers: {
          host: `127.0.0.1:${base.port}`,
          'content-type': 'application/json',
          'x-jarvis-gui': '1',
        },
        body: JSON.stringify({
          decisions: [{ requirementId: 'r1', decision: 'approve', note: 'Looks good.' }],
        }),
      });

      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: 'goal id must be a safe log filename' });
    } finally {
      await close(server);
    }
  });

  it('rejects malformed URL encoding in human-review goal ids without a 500', async () => {
    const server = createGuiServer({ cwd: dir, dataDir: join(dir, 'data') });
    const base = await listen(server);
    try {
      const result = await httpJson(base.port, {
        path: '/api/human-reviews/%E0%A4%A/decide',
        method: 'POST',
        headers: {
          host: `127.0.0.1:${base.port}`,
          'content-type': 'application/json',
          'x-jarvis-gui': '1',
        },
        body: JSON.stringify({
          decisions: [{ requirementId: 'r1', decision: 'approve', note: 'Looks good.' }],
        }),
      });

      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: 'goal id must be valid URL encoding' });
    } finally {
      await close(server);
    }
  });
});

describe('GUI server pure guards', () => {
  it('accepts only loopback host headers and bind hosts', () => {
    expect(isAllowedGuiHostHeader('127.0.0.1:4317')).toBe(true);
    expect(isAllowedGuiHostHeader('localhost')).toBe(true);
    expect(isAllowedGuiHostHeader('[::1]:4317')).toBe(true);
    expect(isAllowedGuiHostHeader('localhost.evil.test')).toBe(false);
    expect(isAllowedGuiHostHeader('127.0.0.1.evil.test')).toBe(false);
    expect(isAllowedGuiHostHeader('127.0.0.1:99999')).toBe(false);

    expect(isLoopbackBindHost('127.0.0.1')).toBe(true);
    expect(isLoopbackBindHost('::1')).toBe(true);
    expect(isLoopbackBindHost('0.0.0.0')).toBe(false);
  });

  it('requires the exact GUI CSRF header value', () => {
    expect(hasGuiCsrfHeader({ 'x-jarvis-gui': '1' })).toBe(true);
    expect(hasGuiCsrfHeader({ 'x-jarvis-gui': ['0', '1'] })).toBe(true);
    expect(hasGuiCsrfHeader({ 'x-jarvis-gui': 'true' })).toBe(false);
    expect(hasGuiCsrfHeader({})).toBe(false);
  });
});

async function listen(server: ReturnType<typeof createGuiServer>): Promise<{ port: number }> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return { port: (server.address() as AddressInfo).port };
}

function close(server: ReturnType<typeof createGuiServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function httpJson(
  port: number,
  options: { path: string; method: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolveRequest, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: options.path,
      method: options.method,
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const body = text === '' ? undefined : JSON.parse(text) as unknown;
        resolveRequest({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    if (options.body !== undefined) req.end(options.body);
    else req.end();
  });
}

const cleanChecks: DeterministicChecks = {
  objectiveChecksPassed: true,
  results: [{ command: 'npm test', code: 0, output: 'green' }],
  testTamper: 'clean',
  tamperReason: '',
};

async function writeParkedHumanGoal(goalId: string): Promise<void> {
  await mkdir(join(dir, 'data', 'goals'), { recursive: true });
  const pinned: PinnedRequirement[] = [{ id: 'r1', text: 'Ludi confirms the GUI copy reads naturally', route: 'human' }];
  const report = composeVerifierReport({
    pinned,
    routes: new Map([['r1', 'human']]),
  });
  const verdict = decideVerdict(cleanChecks, report, pinned);
  await writeFile(
    join(dir, 'data', 'goals', `${goalId}.jsonl`),
    serializeGoalRecord({
      t: 'goal-created',
      id: goalId,
      objective: 'Polish GUI copy.',
      objectiveHash: 'hash',
      budget: { maxRounds: 2 },
      pinned,
      sessionId: goalId,
      createdAt: '2026-07-03T17:00:00.000Z',
    }) +
      serializeGoalRecord({
        t: 'goal-round',
        round: 1,
        turns: 1,
        tokens: 1,
        checks: cleanChecks,
        verdict,
        at: '2026-07-03T17:01:00.000Z',
      }) +
      serializeGoalRecord({ t: 'goal-state', state: 'blocked', at: '2026-07-03T17:01:01.000Z' }),
    'utf8',
  );
}

async function writeInterruptedLoopGoal(loopId: string, goalId: string): Promise<void> {
  await mkdir(join(dir, 'data', 'goals'), { recursive: true });
  await mkdir(join(dir, 'data', 'loops'), { recursive: true });
  await writeFile(
    join(dir, 'data', 'goals', `${goalId}.jsonl`),
    serializeGoalRecord({
      t: 'goal-created',
      id: goalId,
      objective: 'Inspect the release evidence.',
      objectiveHash: 'hash',
      budget: { maxRounds: 2 },
      sessionId: goalId,
      createdAt: '2026-07-03T20:01:28.000Z',
    }),
    'utf8',
  );
  await writeFile(
    join(dir, 'data', 'loops', `${loopId}.jsonl`),
    serializeLoopRecord({
      t: 'loop-created',
      id: loopId,
      contract: {
        maxGoals: 1,
        maxTotalTokens: 1000,
        maxWallClockMs: 60_000,
        maxConsecutiveBlocked: 1,
        cnvWindow: 1,
        cnvThreshold: 1,
        perGoalBudget: { maxRounds: 2 },
      },
      objectives: ['Inspect the release evidence.'],
      createdAt: '2026-07-03T20:01:28.000Z',
    }) +
      serializeLoopRecord({ t: 'goal-started', index: 0, goalId, at: '2026-07-03T20:01:28.100Z' }) +
      serializeLoopRecord({ t: 'loop-halted', reason: 'emergency-stop', at: '2026-07-03T20:01:55.000Z' }),
    'utf8',
  );
}
