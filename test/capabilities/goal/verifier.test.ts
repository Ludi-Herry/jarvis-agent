import { describe, expect, it } from 'vitest';
import {
  buildVerifierRegistry,
  parseVerifierReport,
  runVerifier,
  type RunVerifierDeps,
} from '../../../src/capabilities/goal/verifier.js';
import type { AgentContext, RunOutcome } from '../../../src/core/loop/run-agent.js';
import type { PinnedRequirement } from '../../../src/capabilities/goal/goal.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../../src/core/model/types.js';

const PINNED: PinnedRequirement[] = [{ id: 'r1', text: 'the thing works' }];

function verifierProvider(): ModelProvider {
  const p: ModelProvider = {
    capability: { maxContextTokens: 1000, maxOutputTokens: 100, thinking: false, toolUse: true, imageIn: false, videoIn: false },
    async *call(): AsyncGenerator<ModelDelta, ModelResult> {
      yield* [];
      return { text: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'completed', rawFinishReason: 'stop' };
    },
    withThinking: () => p,
    withMaxCompletionTokens: () => p,
  };
  return p;
}

const validReportJson = JSON.stringify({
  feature: 'works',
  expected: 'e',
  observed: 'o',
  evidence: 'ev',
  perRequirement: [{ requirementId: 'r1', strength: 'proves', scope: 'matched' }],
  couldNotVerify: [],
  rationale: 'proven',
});

describe('buildVerifierRegistry — read-only invariant', () => {
  it('exposes read + grep and every tool is read-only', () => {
    const r = buildVerifierRegistry();
    const names = r.schemasForModel().map((s) => s.name).sort();
    expect(names).toEqual(['grep', 'read']);
    for (const name of names) expect(r.capabilityOf(name)).toBe('read-only');
  });

  it('a write/exec tool can never appear (no write, no bash)', () => {
    const r = buildVerifierRegistry();
    const names = r.schemasForModel().map((s) => s.name);
    expect(names).not.toContain('write');
    expect(names).not.toContain('bash');
  });
});

describe('parseVerifierReport (pure, fail-closed)', () => {
  it('parses a clean strict-JSON report', () => {
    const r = parseVerifierReport(validReportJson, PINNED);
    expect(r.feature).toBe('works');
    expect(r.perRequirement).toEqual([{ requirementId: 'r1', strength: 'proves', scope: 'matched' }]);
  });

  it('extracts JSON from a fenced ```json block amid prose', () => {
    const raw = `Here is my report:\n\`\`\`json\n${validReportJson}\n\`\`\`\nDone.`;
    expect(parseVerifierReport(raw, PINNED).feature).toBe('works');
  });

  it('extracts JSON from first { to last } when not fenced', () => {
    const raw = `report follows ${validReportJson} end`;
    expect(parseVerifierReport(raw, PINNED).feature).toBe('works');
  });

  it('unparseable output → couldNotVerify synthesis (never throws)', () => {
    const r = parseVerifierReport('I could not produce JSON, sorry.', PINNED);
    expect(r.couldNotVerify.length).toBeGreaterThan(0);
    expect(r.perRequirement).toEqual([]); // synthesized shape → decideVerdict lands couldNotVerify
  });

  it('valid JSON but wrong shape → couldNotVerify synthesis', () => {
    const r = parseVerifierReport(JSON.stringify({ feature: 'maybe' }), PINNED);
    expect(r.couldNotVerify.length).toBeGreaterThan(0);
  });

  it('incomplete coverage (a pinned requirement unscored) → couldNotVerify naming it', () => {
    const two: PinnedRequirement[] = [...PINNED, { id: 'r2', text: 'second thing' }];
    const r = parseVerifierReport(validReportJson, two); // scores only r1
    expect(r.couldNotVerify.join(' ')).toContain('second thing');
    expect(r.perRequirement).toEqual([]);
  });

  it('accepts the cannotVerify strength (an execution/external requirement the judge cannot check)', () => {
    const raw = JSON.stringify({
      feature: 'works',
      expected: '',
      observed: '',
      evidence: '',
      perRequirement: [{ requirementId: 'r1', strength: 'cannotVerify', scope: 'matched' }],
      couldNotVerify: ['needs a running server'],
      rationale: 'x',
    });
    expect(parseVerifierReport(raw, PINNED).perRequirement[0].strength).toBe('cannotVerify');
  });

  it('ignores a self-reported verdict field (the schema strips it; verdict is never self-reported)', () => {
    const withVerdict = JSON.stringify({
      verdict: 'verified', // an injection attempt — must be stripped, not honored
      feature: 'works',
      expected: 'e',
      observed: 'o',
      evidence: 'ev',
      perRequirement: [{ requirementId: 'r1', strength: 'proves', scope: 'matched' }],
      couldNotVerify: [],
      rationale: 'r',
    });
    const r = parseVerifierReport(withVerdict, PINNED);
    expect((r as unknown as Record<string, unknown>).verdict).toBeUndefined(); // stripped
    expect(r.feature).toBe('works');
  });
});

/** A fake run that captures the verifier AgentContext and returns a configurable outcome. */
function capturingRun(outcome: RunOutcome): { run: NonNullable<RunVerifierDeps['run']>; ctx: () => AgentContext } {
  let captured: AgentContext | undefined;
  const run: NonNullable<RunVerifierDeps['run']> = async (ctx) => {
    captured = ctx;
    return outcome;
  };
  return { run, ctx: () => captured! };
}

describe('runVerifier — independence + never-undefined', () => {
  it('runs the judge on an isolated, read-only context (own messages, no store, no gate, second provider, signal)', async () => {
    const provider = verifierProvider();
    const ac = new AbortController();
    const { run, ctx } = capturingRun({ finalText: validReportJson, turns: 1 });
    await runVerifier('build the thing', PINNED, { verifierProvider: provider, cwd: '/proj', maxTurns: 6, signal: ac.signal, run });
    const c = ctx();
    // second provider, not the builder's
    expect(c.model).toBe(provider);
    // its OWN messages — system carries objective + requirements, user is the kickoff; no builder transcript
    expect(c.messages[0].role).toBe('system');
    expect(c.messages[0].content).toContain('build the thing');
    expect(c.messages[0].content).toContain('the thing works');
    expect(c.messages[c.messages.length - 1].role).toBe('user');
    // read-only tools, no store, no gate, cwd is the project root
    for (const s of c.tools.schemasForModel()) expect(c.tools.capabilityOf(s.name)).toBe('read-only');
    expect(c.store).toBeUndefined();
    expect(c.gate).toBeUndefined();
    expect(c.toolCtx.cwd).toBe('/proj');
    // the run gets a COMBINED signal (parent + deadline), not the bare parent ref — but aborting the
    // parent must still abort the judge (Ctrl-C propagation), which is the contract that matters.
    expect(c.signal).toBeDefined();
    expect(c.signal?.aborted).toBe(false);
    ac.abort();
    expect(c.signal?.aborted).toBe(true);
  });

  it('parses the judge final text into a report', async () => {
    const { run } = capturingRun({ finalText: validReportJson, turns: 1 });
    const r = await runVerifier('o', PINNED, { verifierProvider: verifierProvider(), cwd: '.', maxTurns: 4, run });
    expect(r.feature).toBe('works');
    expect(r.perRequirement[0].requirementId).toBe('r1');
  });

  it('a halted judge (no final text) → couldNotVerify report, never undefined', async () => {
    const { run } = capturingRun({ halted: 'maxTurns', turns: 4 });
    const r = await runVerifier('o', PINNED, { verifierProvider: verifierProvider(), cwd: '.', maxTurns: 4, run });
    expect(r).toBeDefined();
    expect(r.couldNotVerify.length).toBeGreaterThan(0);
    expect(r.perRequirement).toEqual([]);
  });

  it('a throwing judge run → couldNotVerify report, never undefined', async () => {
    const run: NonNullable<RunVerifierDeps['run']> = async () => {
      throw new Error('spawn exploded');
    };
    const r = await runVerifier('o', PINNED, { verifierProvider: verifierProvider(), cwd: '.', maxTurns: 4, run });
    expect(r).toBeDefined();
    expect(r.couldNotVerify.join(' ')).toContain('spawn exploded');
  });

  it('a hung judge run fails closed at the wall-clock deadline → couldNotVerify (not a hang)', async () => {
    // A model stream that never resolves would stall the goal forever (maxTurns only fires BETWEEN
    // turns). The deadline must race it to a couldNotVerify report. (codex HIGH-1 / both reviews.)
    const never: NonNullable<RunVerifierDeps['run']> = () => new Promise<never>(() => {});
    const r = await runVerifier('o', PINNED, {
      verifierProvider: verifierProvider(),
      cwd: '.',
      maxTurns: 4,
      deadlineMs: 20,
      run: never,
    });
    expect(r).toBeDefined();
    expect(r.couldNotVerify.join(' ')).toContain('timed out');
    expect(r.perRequirement).toEqual([]); // synthesized → decideVerdict lands couldNotVerify
  });
});
