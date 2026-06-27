import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InMemoryToolRegistry } from '../../src/core/tools/registry.js';
import type { ToolDefinition, ToolRunCtx } from '../../src/core/tools/types.js';

const ctx: ToolRunCtx = { cwd: '.' };

const echoTool: ToolDefinition<{ msg: string }> = {
  name: 'echo',
  description: 'echo a message',
  inputSchema: z.object({ msg: z.string() }),
  capability: 'read-only',
  run: async (input) => ({ content: `echo: ${input.msg}` }),
};

const boomTool: ToolDefinition<Record<string, never>> = {
  name: 'boom',
  description: 'always throws',
  inputSchema: z.object({}),
  capability: 'read-only',
  run: async () => {
    throw new Error('kaboom');
  },
};

function registry(): InMemoryToolRegistry {
  const r = new InMemoryToolRegistry();
  r.register(echoTool);
  r.register(boomTool);
  return r;
}

describe('InMemoryToolRegistry.schemasForModel', () => {
  it('advertises each tool with normalized parameters (no $defs)', () => {
    const schemas = registry().schemasForModel();
    const echo = schemas.find((s) => s.name === 'echo');
    expect(echo?.description).toBe('echo a message');
    expect(echo?.parameters).toMatchObject({ type: 'object', properties: { msg: { type: 'string' } } });
    expect(JSON.stringify(echo?.parameters)).not.toContain('$defs');
  });
});

describe('InMemoryToolRegistry.run', () => {
  it('runs a valid call and returns the tool content', async () => {
    const out = await registry().run({ id: 'c1', name: 'echo', arguments: '{"msg":"hi"}' }, ctx);
    expect(out).toEqual({ callId: 'c1', content: 'echo: hi' });
  });

  it('returns an error (never throws) for an unknown tool name', async () => {
    const out = await registry().run({ id: 'c2', name: 'nope', arguments: '{}' }, ctx);
    expect(out.error).toMatch(/Unknown tool/);
    expect(out.content).toBe('');
  });

  it('returns an error for unparseable JSON arguments', async () => {
    const out = await registry().run({ id: 'c3', name: 'echo', arguments: '{bad' }, ctx);
    expect(out.error).toMatch(/Invalid JSON/);
  });

  it('returns a structured error when arguments fail zod validation', async () => {
    const out = await registry().run({ id: 'c4', name: 'echo', arguments: '{"msg":123}' }, ctx);
    expect(out.error).toMatch(/Invalid arguments/);
    expect(out.error).toMatch(/msg/);
  });

  it('catches a throwing tool and reports it as an error', async () => {
    const out = await registry().run({ id: 'c5', name: 'boom', arguments: '{}' }, ctx);
    expect(out.error).toMatch(/threw/);
    expect(out.error).toMatch(/kaboom/);
  });

  it('truncates an over-long tool_call_id to <= 64 chars (ARK constraint)', async () => {
    const out = await registry().run(
      { id: 'x'.repeat(100), name: 'echo', arguments: '{"msg":"hi"}' },
      ctx,
    );
    expect(out.callId).toHaveLength(64);
  });
});

describe('InMemoryToolRegistry.register', () => {
  it('rejects a duplicate tool name instead of silently overwriting', () => {
    const r = new InMemoryToolRegistry();
    r.register(echoTool);
    expect(() => r.register(echoTool)).toThrow(/already registered/);
  });
});
