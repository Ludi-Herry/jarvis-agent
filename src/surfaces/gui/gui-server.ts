import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkspaceObservation } from '../../capabilities/index.js';
import {
  applyHumanReviewDecision,
  HumanReviewError,
  listHumanReviewHistory,
  listPendingHumanReviews,
  type HumanReviewDecisionInput,
} from '../../capabilities/goal/index.js';
import { readEmergencyStop, requestEmergencyStop } from '../../runtime/index.js';
import { buildGuiTimeline, type GuiStatusPayload } from './timeline.js';

interface GuiArgs {
  host: string;
  port: number;
  dataDir: string;
}

const DEFAULT_PORT = 4317;
const ASSET_DIR = fileURLToPath(new URL('./assets/', import.meta.url));
const GUI_CSRF_HEADER = 'x-jarvis-gui';
const GUI_CSRF_VALUE = '1';

interface GuiServerContext {
  cwd: string;
  dataDir: string;
}

async function main(): Promise<void> {
  const args = parseGuiArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const dataDir = resolve(cwd, args.dataDir);
  const server = createGuiServer({ cwd, dataDir });
  const port = await listenWithFallback(server, args.host, args.port);
  console.log(`Jarvis GUI listening on http://${args.host}:${port}`);
  console.log(`observe source: npm run observe -- --json --data-dir ${dataDir}`);
  if (!isLoopbackBindHost(args.host)) {
    console.warn('[gui] warning: non-loopback host binding exposes this unauthenticated observation/control server to the network.');
  }
}

export function createGuiServer(context: GuiServerContext): Server {
  return createServer((req, res) => {
    void handleRequest(req, res, context);
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: GuiServerContext,
): Promise<void> {
  try {
    if (!isAllowedGuiHostHeader(req.headers.host)) {
      json(res, 403, { error: 'forbidden host' });
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const payload = await statusPayload(context.cwd, context.dataDir);
      json(res, 200, payload);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/observation') {
      json(res, 200, await loadWorkspaceObservation(context.dataDir, { workspaceCwd: context.cwd }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/human-reviews') {
      const [reviews, history] = await Promise.all([
        listPendingHumanReviews(context.dataDir),
        listHumanReviewHistory(context.dataDir),
      ]);
      json(res, 200, { reviews, history });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/emergency-stop') {
      json(res, 200, await readEmergencyStop(context.cwd));
      return;
    }
    const humanReviewDecision = matchHumanReviewDecisionPath(url.pathname);
    if (req.method === 'POST' && humanReviewDecision !== undefined) {
      if (!hasGuiCsrfHeader(req.headers)) {
        json(res, 403, { error: `missing ${GUI_CSRF_HEADER} header` });
        return;
      }
      const body = await readJsonBody(req);
      const result = await applyHumanReviewDecision({
        dataDir: context.dataDir,
        goalId: humanReviewDecision.goalId,
        reviewer: typeof body.reviewer === 'string' ? body.reviewer : undefined,
        decisions: parseHumanReviewDecisionInputs(body.decisions),
      });
      json(res, 200, { result });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/emergency-stop') {
      if (!hasGuiCsrfHeader(req.headers)) {
        json(res, 403, { error: `missing ${GUI_CSRF_HEADER} header` });
        return;
      }
      const body = await readJsonBody(req);
      const reason = typeof body.reason === 'string' && body.reason.trim() !== '' ? body.reason.trim() : 'GUI emergency stop';
      const record = await requestEmergencyStop({ cwd: context.cwd, source: 'gui', reason });
      json(res, 200, { record, stop: await readEmergencyStop(context.cwd) });
      return;
    }
    if (req.method === 'GET') {
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
        return;
      }
      await serveAsset(url.pathname, res);
      return;
    }
    json(res, 405, { error: 'method not allowed' });
  } catch (err) {
    const status = err instanceof HumanReviewError ? err.status : err instanceof SyntaxError ? 400 : 500;
    json(res, status, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function statusPayload(cwd: string, dataDir: string): Promise<GuiStatusPayload> {
  const report = await loadWorkspaceObservation(dataDir, { workspaceCwd: cwd });
  const stop = report.control.emergencyStop;
  return { report, stop, timeline: buildGuiTimeline(report, stop) };
}

async function serveAsset(pathname: string, res: ServerResponse): Promise<void> {
  const name = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!['index.html', 'app.css', 'app.js', 'presentation.js'].includes(name)) {
    json(res, 404, { error: 'not found' });
    return;
  }
  const file = join(ASSET_DIR, name);
  const content = await readFile(file);
  res.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
  res.end(content);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 4096) throw new Error('request body too large');
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  const parsed = JSON.parse(text) as unknown;
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function matchHumanReviewDecisionPath(pathname: string): { goalId: string } | undefined {
  const match = /^\/api\/human-reviews\/([^/]+)\/decide$/.exec(pathname);
  if (match === null) return undefined;
  try {
    return { goalId: decodeURIComponent(match[1]) };
  } catch {
    throw new HumanReviewError(400, 'goal id must be valid URL encoding');
  }
}

function parseHumanReviewDecisionInputs(value: unknown): HumanReviewDecisionInput[] {
  if (!Array.isArray(value)) throw new HumanReviewError(400, 'decisions must be an array');
  return value.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new HumanReviewError(400, 'decision must be an object');
    }
    const record = item as Record<string, unknown>;
    const decision = record.decision;
    if (decision !== 'approve' && decision !== 'reject') {
      throw new HumanReviewError(400, 'decision must be approve or reject');
    }
    if (typeof record.requirementId !== 'string') {
      throw new HumanReviewError(400, 'requirementId is required');
    }
    if (typeof record.note !== 'string') {
      throw new HumanReviewError(400, 'note is required');
    }
    return { requirementId: record.requirementId, decision, note: record.note };
  });
}

function contentType(path: string): string {
  switch (extname(path)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function parseGuiArgs(argv: string[]): GuiArgs {
  let host = '127.0.0.1';
  let port = DEFAULT_PORT;
  let dataDir = 'data';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--host') host = required(argv, ++i, '--host');
    else if (arg === '--port') port = parsePort(required(argv, ++i, '--port'));
    else if (arg === '--data-dir') dataDir = required(argv, ++i, '--data-dir');
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { host, port, dataDir };
}

function required(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be 1..65535');
  return port;
}

export function isAllowedGuiHostHeader(value: string | undefined): boolean {
  if (value === undefined) return false;
  const host = value.trim().toLowerCase();
  if (['localhost', '127.0.0.1', '[::1]'].includes(host)) return true;
  for (const prefix of ['localhost:', '127.0.0.1:', '[::1]:']) {
    if (host.startsWith(prefix)) return isValidPortText(host.slice(prefix.length));
  }
  return false;
}

export function hasGuiCsrfHeader(headers: IncomingHttpHeaders): boolean {
  const value = headers[GUI_CSRF_HEADER];
  return Array.isArray(value) ? value.includes(GUI_CSRF_VALUE) : value === GUI_CSRF_VALUE;
}

export function isLoopbackBindHost(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host.trim().toLowerCase());
}

function isValidPortText(value: string): boolean {
  if (!/^\d{1,5}$/.test(value)) return false;
  const port = Number.parseInt(value, 10);
  return port >= 1 && port <= 65535;
}

function listenWithFallback(server: ReturnType<typeof createServer>, host: string, startPort: number): Promise<number> {
  return new Promise((resolveListen, reject) => {
    let port = startPort;
    const tryListen = (): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE' && port < startPort + 20) {
          port++;
          tryListen();
          return;
        }
        reject(err);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolveListen(port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    };
    tryListen();
  });
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error('[gui] fatal:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(metaUrl) === resolve(entry);
}
