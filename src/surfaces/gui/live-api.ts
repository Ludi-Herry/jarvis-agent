import type { IncomingMessage, ServerResponse } from 'node:http';
import { GuiLiveError, type GuiSessionHost } from './live-session.js';
import type { HumanReviewDecisionInput } from '../../capabilities/goal/human-review.js';

export async function handleLiveApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  host: GuiSessionHost,
  body: () => Promise<Record<string, unknown>>,
): Promise<void> {
  if (req.method === 'GET' && url.pathname === '/api/live') return json(res, await host.overview());
  if (req.method === 'POST' && url.pathname === '/api/live/start') {
    const input = await body();
    return json(res, await host.start(requiredText(input, 'text')));
  }
  const match = /^\/api\/live\/(gui-[a-f0-9-]+)(?:\/(events|input|decision|pause|continue|stop|resume|review))?$/u.exec(url.pathname);
  if (!match) throw new GuiLiveError(404, 'live API not found');
  const [, id, action] = match;
  if (req.method === 'GET' && !action) return json(res, await host.snapshot(id));
  if (req.method === 'GET' && action === 'events') {
    // Verify identity/integrity before opening the stream. Reconnect always receives a full
    // persistent projection; Last-Event-ID never causes missing events to be discarded.
    const first = await host.snapshot(id);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    let closed = false;
    let pending = false;
    let dirty = false;
    let draining = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = (snapshot: typeof first) => {
      if (closed) return;
      const frame = { id: `${id}:${snapshot.sequence}`, sequence: snapshot.sequence, snapshot };
      // false means the frame was accepted but needs drain; it is not a broken connection.
      draining = !res.write(`id: ${frame.id}\nevent: snapshot\ndata: ${JSON.stringify(frame)}\n\n`);
    };
    const flush = async () => {
      timer = undefined;
      if (pending || closed || draining) { dirty = true; return; }
      pending = true;
      dirty = false;
      try { send(await host.snapshot(id)); } catch { res.end(); }
      finally { pending = false; if (dirty && !closed && !draining && !timer) timer = setTimeout(() => { void flush(); }, 80); }
    };
    const unsubscribe = host.subscribe((changedId) => {
      if (changedId !== id || closed) return;
      dirty = true;
      if (!timer && !pending && !draining) timer = setTimeout(() => { void flush(); }, 80);
    });
    res.on('drain', () => {
      draining = false;
      if (dirty && !closed && !pending && !timer) timer = setTimeout(() => { void flush(); }, 80);
    });
    send(first);
    const heartbeat = setInterval(() => { if (!closed && !draining) draining = !res.write(': keep-alive\n\n'); }, 15_000);
    res.on('close', () => { closed = true; unsubscribe(); clearInterval(heartbeat); if (timer) clearTimeout(timer); });
    return;
  }
  if (req.method !== 'POST') throw new GuiLiveError(405, 'method not allowed');
  const input = await body();
  if (action === 'input') return json(res, await host.input(id, requiredText(input, 'text')));
  if (action === 'decision') return json(res, await host.decision(id, requiredText(input, 'requestId'), requiredText(input, 'decision'), typeof input.reason === 'string' ? input.reason : undefined));
  if (action === 'pause' || action === 'continue' || action === 'stop' || action === 'resume') {
    return json(res, await host.control(id, action, typeof input.reason === 'string' ? input.reason : undefined));
  }
  if (action === 'review') {
    if (!Array.isArray(input.decisions)) throw new GuiLiveError(400, 'decisions must be an array');
    const decisions = input.decisions.map((value): HumanReviewDecisionInput => {
      if (!value || typeof value !== 'object') throw new GuiLiveError(400, 'invalid review decision');
      const record = value as Record<string, unknown>;
      const decision = requiredText(record, 'decision');
      if (decision !== 'approve' && decision !== 'reject') throw new GuiLiveError(400, 'invalid review decision');
      return { requirementId: requiredText(record, 'requirementId'), note: requiredText(record, 'note'), decision };
    });
    if (!Number.isInteger(input.sequence)) throw new GuiLiveError(400, 'viewed sequence is required');
    return json(res, await host.review(id, decisions, { sequence: input.sequence as number, evidenceToken: requiredText(input, 'evidenceToken') }));
  }
  throw new GuiLiveError(404, 'live action not found');
}

function requiredText(body: Record<string, unknown>, field: string): string {
  if (typeof body[field] !== 'string' || !body[field].trim()) throw new GuiLiveError(400, `${field} is required`);
  return body[field];
}

function json(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
