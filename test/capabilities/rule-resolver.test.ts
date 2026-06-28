import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRuleDocument,
  mergeRules,
  resolveImports,
  loadRuleLayers,
  type ReadText,
  type RuleLayer,
} from '../../src/capabilities/rules/rule-resolver.js';
import { applyRules } from '../../src/runtime/permission/index.js';

describe('parseRuleDocument', () => {
  it('parses allow/deny frontmatter into rules and keeps the body as guidance', () => {
    const layer = parseRuleDocument(
      ['---', 'allow: [bash:npm test, read:*]', 'deny: [bash:git push *]', '---', 'Prefer small diffs.'].join('\n'),
    );
    expect(layer.rules).toEqual([
      { action: 'allow', tool: 'bash', pattern: 'npm test' },
      { action: 'allow', tool: 'read', pattern: '*' },
      { action: 'deny', tool: 'bash', pattern: 'git push *' },
    ]);
    expect(layer.guidance).toBe('Prefer small diffs.');
  });

  it('treats a bare tool entry as matching any subject', () => {
    expect(parseRuleDocument('---\nallow: [grep]\n---').rules).toEqual([{ action: 'allow', tool: 'grep', pattern: '*' }]);
  });

  it('caps guidance to the per-layer budget', () => {
    const layer = parseRuleDocument(`---\nallow: [read:*]\n---\n${'x'.repeat(5000)}`, 100);
    expect(layer.guidance.length).toBe(100);
  });
});

describe('mergeRules — nearest wins', () => {
  it('orders rules most-specific-first so the gate first-match gives path > project > global', () => {
    const global: RuleLayer = { rules: [{ action: 'allow', tool: 'bash', pattern: 'npm *' }], guidance: 'g' };
    const project: RuleLayer = { rules: [{ action: 'deny', tool: 'bash', pattern: 'npm *' }], guidance: 'p' };
    const merged = mergeRules([global, project]); // least-specific first in, nearest-first out
    // project (nearer) rule comes first → applyRules resolves to deny
    expect(applyRules(merged.rules, 'bash', 'npm test')).toBe('deny');
    expect(merged.guidance).toBe('g\n\np'); // guidance least-specific first
  });
});

describe('RuleResolver — @import (single linear source, cycle-detected)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rules-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const read: ReadText = (p) => readFile(p, 'utf8').catch(() => null);

  it('merges an imported base, with the importing file MORE specific (own rules first)', async () => {
    await writeFile(join(dir, 'base.md'), '---\nallow: [bash:npm *]\n---\nbase guidance', 'utf8');
    await writeFile(join(dir, 'a.md'), '---\ndeny: [bash:npm publish*]\nimport: base.md\n---\nlocal guidance', 'utf8');
    const layer = await resolveImports(join(dir, 'a.md'), read);
    // own deny precedes the imported allow → `npm publish` denies, other `npm *` allows
    expect(applyRules(layer.rules, 'bash', 'npm publish')).toBe('deny');
    expect(applyRules(layer.rules, 'bash', 'npm test')).toBe('allow');
    expect(layer.guidance).toBe('base guidance\n\nlocal guidance'); // base first
  });

  it('throws on an @import cycle', async () => {
    await writeFile(join(dir, 'a.md'), '---\nimport: b.md\n---', 'utf8');
    await writeFile(join(dir, 'b.md'), '---\nimport: a.md\n---', 'utf8');
    await expect(resolveImports(join(dir, 'a.md'), read)).rejects.toThrow(/cycle/);
  });

  it('a missing file is an empty layer, not an error', async () => {
    const layer = await resolveImports(join(dir, 'nope.md'), read);
    expect(layer).toEqual({ rules: [], guidance: '' });
  });

  it('loadRuleLayers merges ordered sources (global → project) nearest-first', async () => {
    await writeFile(join(dir, 'global.md'), '---\nallow: [bash:npm *]\n---', 'utf8');
    await writeFile(join(dir, 'project.md'), '---\ndeny: [bash:npm *]\n---', 'utf8');
    const resolved = await loadRuleLayers([join(dir, 'global.md'), join(dir, 'project.md')], read);
    expect(applyRules(resolved.rules, 'bash', 'npm test')).toBe('deny'); // project (nearer) wins
  });
});
