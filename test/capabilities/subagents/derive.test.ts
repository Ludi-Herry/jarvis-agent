import { describe, expect, it } from 'vitest';
import {
  deriveBudget,
  deriveCapabilities,
  deriveDepth,
  deriveTools,
  type ToolMeta,
} from '../../../src/capabilities/subagents/derive.js';
import type { ToolCapability } from '../../../src/core/tools/types.js';

// A representative parent: the REPL's registry — read/grep (read-only), write (writes-files),
// bash (executes-code). `task` (the delegate tool) is itself read-only.
const PARENT_TOOLS: ToolMeta[] = [
  { name: 'read', capability: 'read-only' },
  { name: 'grep', capability: 'read-only' },
  { name: 'write', capability: 'writes-files' },
  { name: 'bash', capability: 'executes-code' },
  { name: 'task', capability: 'read-only' },
];
const PARENT_CAPS: ToolCapability[] = ['read-only', 'writes-files', 'executes-code'];

describe('deriveCapabilities', () => {
  it('intersects parent with requested', () => {
    expect(deriveCapabilities(PARENT_CAPS, ['read-only', 'writes-files'])).toEqual([
      'read-only',
      'writes-files',
    ]);
  });

  it('defaults to read-only (least privilege) when nothing is requested', () => {
    expect(deriveCapabilities(PARENT_CAPS, undefined)).toEqual(['read-only']);
    expect(deriveCapabilities(PARENT_CAPS, [])).toEqual(['read-only']);
  });

  it('drops a requested capability the parent does not have (subset only)', () => {
    expect(deriveCapabilities(['read-only'], ['read-only', 'executes-code', 'network'])).toEqual([
      'read-only',
    ]);
  });

  it('de-duplicates and follows parent order', () => {
    expect(deriveCapabilities(PARENT_CAPS, ['executes-code', 'read-only', 'read-only'])).toEqual([
      'read-only',
      'executes-code',
    ]);
  });
});

describe('deriveTools', () => {
  it('keeps only tools whose effect class is in the derived capabilities', () => {
    const caps = deriveCapabilities(PARENT_CAPS, ['read-only']);
    expect(deriveTools(PARENT_TOOLS, undefined, caps).sort()).toEqual(['grep', 'read', 'task']);
  });

  it('R1: a child narrowed to read-only never gets bash, even if the role lists bash', () => {
    const caps = deriveCapabilities(PARENT_CAPS, ['read-only']);
    // The role explicitly requested bash by name — the capability filter still excludes it.
    expect(deriveTools(PARENT_TOOLS, ['read', 'bash'], caps)).toEqual(['read']);
    expect(deriveTools(PARENT_TOOLS, ['read', 'bash'], caps)).not.toContain('bash');
  });

  it('intersects the requested name subset with the parent', () => {
    const caps = deriveCapabilities(PARENT_CAPS, ['read-only', 'writes-files', 'executes-code']);
    expect(deriveTools(PARENT_TOOLS, ['read', 'write', 'nonexistent'], caps).sort()).toEqual([
      'read',
      'write',
    ]);
  });

  it('drops a tool whose effect class the child was not granted', () => {
    const caps = deriveCapabilities(PARENT_CAPS, ['read-only']); // no writes-files
    expect(deriveTools(PARENT_TOOLS, ['write'], caps)).toEqual([]);
  });
});

describe('deriveDepth', () => {
  it('is parent − 1 when nothing is requested', () => {
    expect(deriveDepth(2)).toBe(1);
    expect(deriveDepth(1)).toBe(0);
  });

  it('takes min(requested, parent − 1)', () => {
    expect(deriveDepth(3, 1)).toBe(1);
    expect(deriveDepth(3, 5)).toBe(2); // cannot exceed parent − 1
  });

  it('floors at 0 (no negative depth, a request below 0 is clamped)', () => {
    expect(deriveDepth(0)).toBe(0);
    expect(deriveDepth(1, 5)).toBe(0);
    expect(deriveDepth(3, -1)).toBe(0);
  });
});

describe('deriveBudget', () => {
  it('defaults to half the parent, floored, ≥1', () => {
    expect(deriveBudget({ maxTurns: 24 })).toEqual({ maxTurns: 12 });
    expect(deriveBudget({ maxTurns: 5 })).toEqual({ maxTurns: 2 });
    expect(deriveBudget({ maxTurns: 2 })).toEqual({ maxTurns: 1 });
  });

  it('caps a request at parent − 1 (strictly smaller than the parent)', () => {
    expect(deriveBudget({ maxTurns: 10 }, 100)).toEqual({ maxTurns: 9 });
    expect(deriveBudget({ maxTurns: 10 }, 3)).toEqual({ maxTurns: 3 });
  });

  it('a child is strictly smaller than a parent with room to nest (maxTurns ≥ 2)', () => {
    for (const maxTurns of [2, 5, 10, 24, 100]) {
      expect(deriveBudget({ maxTurns }).maxTurns).toBeLessThan(maxTurns);
      expect(deriveBudget({ maxTurns }, 9999).maxTurns).toBeLessThan(maxTurns);
    }
  });
});

describe('never_escalates (property: every narrowing yields a subset of the parent)', () => {
  const REQUESTS: (ToolCapability[] | undefined)[] = [
    undefined,
    [],
    ['read-only'],
    ['writes-files'],
    ['executes-code'],
    ['network'], // parent lacks it
    ['read-only', 'writes-files', 'executes-code', 'network'],
  ];
  const NAME_REQUESTS: (string[] | undefined)[] = [
    undefined,
    ['bash'],
    ['read', 'write', 'bash', 'task'],
    ['nonexistent'],
  ];

  it('derived capabilities are always a subset of the parent', () => {
    for (const req of REQUESTS) {
      const caps = deriveCapabilities(PARENT_CAPS, req);
      for (const c of caps) expect(PARENT_CAPS).toContain(c);
    }
  });

  it('derived tools are always a subset of the parent AND only of granted capabilities', () => {
    const parentNames = new Set(PARENT_TOOLS.map((t) => t.name));
    const capOf = new Map(PARENT_TOOLS.map((t) => [t.name, t.capability] as const));
    for (const capReq of REQUESTS) {
      const caps = deriveCapabilities(PARENT_CAPS, capReq);
      for (const nameReq of NAME_REQUESTS) {
        const tools = deriveTools(PARENT_TOOLS, nameReq, caps);
        for (const name of tools) {
          expect(parentNames.has(name)).toBe(true); // never a tool the parent lacks
          expect(caps).toContain(capOf.get(name)); // never a tool outside granted capabilities
        }
      }
    }
  });
});
