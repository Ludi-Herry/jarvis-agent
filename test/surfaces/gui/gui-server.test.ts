import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
