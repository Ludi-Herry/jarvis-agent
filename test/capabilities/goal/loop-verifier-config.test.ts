import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildLoopVerifierPlan,
  loadLoopVerifierMap,
  parseLoopVerifierMap,
} from '../../../src/capabilities/goal/loop-verifier-config.js';
import type { DoubaoConfig } from '../../../src/core/model/types.js';

const builder: DoubaoConfig = {
  provider: 'doubao',
  apiKey: 'k',
  baseURL: 'https://example.test/v1',
  model: 'builder-model',
};

describe('parseLoopVerifierMap', () => {
  it('parses strict per-index verifier overrides', () => {
    expect(
      parseLoopVerifierMap(
        JSON.stringify({
          goals: [
            { index: 0, verifierModel: 'judge-a' },
            { index: 2, verifierModel: 'judge-b' },
          ],
        }),
      ),
    ).toEqual({
      goals: [
        { index: 0, verifierModel: 'judge-a' },
        { index: 2, verifierModel: 'judge-b' },
      ],
    });
  });

  it.each([
    ['bad json', 'not-json{'],
    ['top-level array', '[]'],
    ['unknown top-level key', JSON.stringify({ goals: [], extra: true })],
    ['missing goals', JSON.stringify({})],
    ['goals is not array', JSON.stringify({ goals: {} })],
    ['entry is not object', JSON.stringify({ goals: [1] })],
    ['unknown entry key', JSON.stringify({ goals: [{ index: 0, verifierModel: 'judge', extra: true }] })],
    ['negative index', JSON.stringify({ goals: [{ index: -1, verifierModel: 'judge' }] })],
    ['fractional index', JSON.stringify({ goals: [{ index: 1.5, verifierModel: 'judge' }] })],
    ['blank verifier model', JSON.stringify({ goals: [{ index: 1, verifierModel: '   ' }] })],
    ['duplicate index', JSON.stringify({ goals: [{ index: 1, verifierModel: 'a' }, { index: 1, verifierModel: 'b' }] })],
  ])('throws for %s', (_label, text) => {
    expect(() => parseLoopVerifierMap(text)).toThrow();
  });
});

describe('loadLoopVerifierMap trust boundary', () => {
  const cwd = join(tmpdir(), 'jarvis-loop-repo');
  const outside = join(tmpdir(), 'loop-verifiers.json');
  const inside = join(cwd, 'loop-verifiers.json');

  it('loads a trusted file outside cwd after realpath', async () => {
    const text = JSON.stringify({ goals: [{ index: 0, verifierModel: 'judge-a' }] });
    const loaded = await loadLoopVerifierMap({
      path: outside,
      cwd,
      readText: async (p) => (p === resolve(outside) ? text : null),
      realpath: async (p) => resolve(p),
    });
    expect(loaded.goals[0]?.verifierModel).toBe('judge-a');
    expect(loaded.path).toBe(resolve(outside));
  });

  it('refuses a path that canonicalizes inside cwd', async () => {
    await expect(
      loadLoopVerifierMap({
        path: outside,
        cwd,
        readText: async () => JSON.stringify({ goals: [] }),
        realpath: async (p) => (p === outside ? inside : resolve(p)),
      }),
    ).rejects.toThrow(/inside the working directory/);
  });

  it('fails loudly when the explicit file cannot be resolved', async () => {
    await expect(
      loadLoopVerifierMap({
        path: outside,
        cwd,
        readText: async () => null,
        realpath: async () => null,
      }),
    ).rejects.toThrow(/cannot be read/);
  });
});

describe('assertResumeVerifierMapMatches', () => {
  it('fails closed for no-map resume because cwd logs cannot prove the loop was created without a map', async () => {
    const { assertResumeVerifierMapMatches } = await import('../../../src/capabilities/goal/loop-verifier-config.js');
    expect(() => assertResumeVerifierMapMatches(undefined, undefined, true)).toThrow(/trusted empty map/);
  });

  it('fails closed when resume has no verifier-map decision', async () => {
    const { assertResumeVerifierMapMatches } = await import('../../../src/capabilities/goal/loop-verifier-config.js');
    expect(() => assertResumeVerifierMapMatches(undefined, undefined, false)).toThrow(/requires --verifier-map/);
  });

  it('fails closed when a loop created with verifier-map is resumed without one', async () => {
    const { assertResumeVerifierMapMatches } = await import('../../../src/capabilities/goal/loop-verifier-config.js');
    expect(() => assertResumeVerifierMapMatches('C:\\trusted\\map.json', undefined, false)).toThrow(/requires --verifier-map/);
  });

  it('fails closed when a loop created with verifier-map is resumed as no-map', async () => {
    const { assertResumeVerifierMapMatches } = await import('../../../src/capabilities/goal/loop-verifier-config.js');
    expect(() => assertResumeVerifierMapMatches('C:\\trusted\\map.json', undefined, true)).toThrow(/trusted empty map/);
  });

  it('fails closed when resume uses a different verifier-map path', async () => {
    const { assertResumeVerifierMapMatches } = await import('../../../src/capabilities/goal/loop-verifier-config.js');
    expect(() => assertResumeVerifierMapMatches('C:\\trusted\\map-a.json', 'C:\\trusted\\map-b.json', false)).toThrow(/does not match/);
  });

  it('rejects conflicting current map and no-map resume decisions', async () => {
    const { assertResumeVerifierMapMatches } = await import('../../../src/capabilities/goal/loop-verifier-config.js');
    expect(() => assertResumeVerifierMapMatches(undefined, 'C:\\trusted\\map.json', true)).toThrow(/trusted empty map/);
  });
});

describe('buildLoopVerifierPlan', () => {
  it('uses per-index override, then global fallback, then deterministic-only fallback', () => {
    const plan = buildLoopVerifierPlan({
      objectivesCount: 3,
      builderConfig: builder,
      globalVerifier: { enabled: true, config: { ...builder, model: 'global-judge' } },
      map: { goals: [{ index: 1, verifierModel: 'per-goal-judge' }] },
    });
    expect(plan.decisions.map((d) => (d.enabled ? d.config.model : 'off'))).toEqual([
      'global-judge',
      'per-goal-judge',
      'global-judge',
    ]);
  });

  it('uses deterministic-only fallback when neither map nor global verifier enables a goal', () => {
    const plan = buildLoopVerifierPlan({
      objectivesCount: 2,
      builderConfig: builder,
      globalVerifier: { enabled: false, reason: 'off' },
      map: { goals: [{ index: 1, verifierModel: 'per-goal-judge' }] },
    });
    expect(plan.decisions.map((d) => (d.enabled ? d.config.model : 'off'))).toEqual(['off', 'per-goal-judge']);
  });

  it('fails closed when an override points past the objective queue', () => {
    expect(() =>
      buildLoopVerifierPlan({
        objectivesCount: 1,
        builderConfig: builder,
        globalVerifier: { enabled: false, reason: 'off' },
        map: { goals: [{ index: 3, verifierModel: 'judge' }] },
      }),
    ).toThrow(/out of range/);
  });

  it('fails closed when an override equals the builder model', () => {
    expect(() =>
      buildLoopVerifierPlan({
        objectivesCount: 1,
        builderConfig: builder,
        globalVerifier: { enabled: false, reason: 'off' },
        map: { goals: [{ index: 0, verifierModel: 'builder-model' }] },
      }),
    ).toThrow(/equals the builder model/);
  });
});
