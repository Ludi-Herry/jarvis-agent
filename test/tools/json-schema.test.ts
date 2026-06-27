import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { normalizeJsonSchema, zodToParameters } from '../../src/core/tools/json-schema.js';

describe('zodToParameters', () => {
  it('emits a flat object schema with type filled and no dialect/bookkeeping keys', () => {
    const params = zodToParameters(z.object({ msg: z.string(), n: z.number().optional() }));
    expect(params).toMatchObject({
      type: 'object',
      properties: { msg: { type: 'string' }, n: { type: 'number' } },
    });
    const json = JSON.stringify(params);
    expect(json).not.toContain('$schema');
    expect(json).not.toContain('$defs');
    expect(json).not.toContain('$ref');
  });
});

describe('normalizeJsonSchema', () => {
  it('inlines a $ref into its $defs definition and drops $defs/$ref/$schema', () => {
    // The exact shape a strict endpoint (Doubao/ARK) would reject — built by hand so the
    // deref is tested independently of whatever zod happens to emit today.
    const raw = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { point: { $ref: '#/$defs/Point' } },
      $defs: {
        Point: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
      },
    };
    const out = normalizeJsonSchema(raw);
    expect(out).toEqual({
      type: 'object',
      properties: {
        point: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
      },
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain('$defs');
    expect(json).not.toContain('$ref');
    expect(json).not.toContain('$schema');
  });

  it('fills a root `type` when the schema omits it (strict endpoints want it)', () => {
    const out = normalizeJsonSchema({ properties: {} });
    expect(out.type).toBe('object');
  });

  it('degrades a recursive $ref to a bare object instead of looping forever', () => {
    const raw = {
      type: 'object',
      properties: { next: { $ref: '#/$defs/Node' } },
      $defs: {
        Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' } } },
      },
    };
    const out = normalizeJsonSchema(raw);
    // Outer ref inlines once; the self-reference inside degrades to { type: 'object' }.
    expect(out).toEqual({
      type: 'object',
      properties: {
        next: { type: 'object', properties: { next: { type: 'object' } } },
      },
    });
  });

  it('drops $defs/$schema appearing at a nested depth, not just the root', () => {
    const raw = {
      type: 'object',
      properties: {
        inner: { type: 'object', $schema: 'x', properties: { a: { type: 'string' } } },
      },
    };
    const out = normalizeJsonSchema(raw);
    expect(JSON.stringify(out)).not.toContain('$schema');
  });
});
