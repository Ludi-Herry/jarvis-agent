import { describe, expect, it } from 'vitest';
import { composeVerifierReport } from '../../../src/capabilities/goal/composite-verifier-report.js';
import type { DeterministicChecks, PinnedRequirement, VerifierReport } from '../../../src/capabilities/goal/goal.js';
import { decideVerdict } from '../../../src/capabilities/goal/verdict.js';
import type { SandboxRunResult } from '../../../src/runtime/index.js';

const cleanChecks: DeterministicChecks = {
  objectiveChecksPassed: true,
  results: [],
  testTamper: 'clean',
  tamperReason: '',
};

describe('composeVerifierReport', () => {
  it('combines sandbox and LLM routed scores into one verified report', () => {
    const pinned: PinnedRequirement[] = [
      { id: 'r1', text: 'CLI status command succeeds in the sandbox' },
      { id: 'r2', text: 'Documentation names the new sandbox option' },
    ];

    const report = composeVerifierReport({
      pinned,
      routes: new Map([
        ['r1', 'sandbox-command'],
        ['r2', 'llm'],
      ]),
      sandboxChecks: [{ requirementId: 'r1', command: 'git status --short', result: completed(0, '') }],
      llmReport: llmReport([{ requirementId: 'r2', strength: 'proves', scope: 'matched' }], {
        evidence: 'LLM verifier evidence: README contains --sandbox-check-map.',
        observed: 'r2: documentation present',
      }),
    });

    expect(report.feature).toBe('works');
    expect(report.couldNotVerify).toEqual([]);
    expect(report.perRequirement).toEqual([
      { requirementId: 'r1', strength: 'proves', scope: 'matched' },
      { requirementId: 'r2', strength: 'proves', scope: 'matched' },
    ]);
    expect(report.evidence).toContain('sandbox audit:');
    expect(report.evidence).toContain('LLM verifier evidence');
    expect(decideVerdict(cleanChecks, report, pinned).outcome).toBe('verified');
  });

  it('parks human-routed requirements for manual verification', () => {
    const pinned: PinnedRequirement[] = [{ id: 'r1', text: 'Human confirms the UX copy reads naturally' }];

    const report = composeVerifierReport({
      pinned,
      routes: new Map([['r1', 'human']]),
    });

    expect(report.perRequirement).toEqual([{ requirementId: 'r1', strength: 'cannotVerify', scope: 'matched' }]);
    expect(report.couldNotVerify[0]).toContain('human verification required for r1');
    expect(decideVerdict(cleanChecks, report, pinned).outcome).toBe('couldNotVerify');
  });

  it('fails closed when an LLM report scores a command-backed requirement', () => {
    const pinned: PinnedRequirement[] = [
      { id: 'r1', text: 'CLI status command succeeds in the sandbox' },
      { id: 'r2', text: 'Documentation names the new sandbox option' },
    ];

    const report = composeVerifierReport({
      pinned,
      routes: new Map([
        ['r1', 'sandbox-command'],
        ['r2', 'llm'],
      ]),
      sandboxChecks: [{ requirementId: 'r1', command: 'git status --short', result: completed(0, '') }],
      llmReport: llmReport([
        { requirementId: 'r1', strength: 'proves', scope: 'matched' },
        { requirementId: 'r2', strength: 'proves', scope: 'matched' },
      ]),
    });

    expect(report.couldNotVerify[0]).toContain('LLM report scored non-LLM requirement: r1');
    expect(decideVerdict(cleanChecks, report, pinned).outcome).toBe('couldNotVerify');
  });

  it('fails closed when sandbox checks target a non-sandbox or unknown requirement', () => {
    const pinned: PinnedRequirement[] = [{ id: 'r1', text: 'Documentation names the new sandbox option' }];

    const nonSandbox = composeVerifierReport({
      pinned,
      routes: new Map([['r1', 'llm']]),
      sandboxChecks: [{ requirementId: 'r1', command: 'git status --short', result: completed(0, '') }],
      llmReport: llmReport([{ requirementId: 'r1', strength: 'proves', scope: 'matched' }]),
    });
    const unknown = composeVerifierReport({
      pinned,
      routes: new Map([['r1', 'llm']]),
      sandboxChecks: [{ requirementId: 'rx', command: 'git status --short', result: completed(0, '') }],
      llmReport: llmReport([{ requirementId: 'r1', strength: 'proves', scope: 'matched' }]),
    });

    expect(nonSandbox.couldNotVerify[0]).toContain('sandboxed check targets non-sandbox requirement: r1');
    expect(unknown.couldNotVerify[0]).toContain('sandboxed check targets an unknown requirement: rx');
  });

  it('fails closed when a pinned requirement has no route', () => {
    const pinned: PinnedRequirement[] = [{ id: 'r1', text: 'CLI status command succeeds in the sandbox' }];

    const report = composeVerifierReport({
      pinned,
      routes: new Map(),
    });

    expect(report.couldNotVerify[0]).toContain('no verification route configured for r1');
    expect(decideVerdict(cleanChecks, report, pinned).outcome).toBe('couldNotVerify');
  });

  it('fails closed when a persisted pinned route disagrees with the current route map', () => {
    const pinned: PinnedRequirement[] = [
      { id: 'r1', text: 'Human confirms the GUI timeline is readable', route: 'human' },
    ];

    const report = composeVerifierReport({
      pinned,
      routes: new Map([['r1', 'llm']]),
      llmReport: llmReport([{ requirementId: 'r1', strength: 'proves', scope: 'matched' }]),
    });

    expect(report.couldNotVerify[0]).toContain('verification route mismatch for r1: pinned=human current=llm');
    expect(decideVerdict(cleanChecks, report, pinned).outcome).toBe('couldNotVerify');
  });

  it('parks missing sandbox and LLM route results without marking the feature verified', () => {
    const pinned: PinnedRequirement[] = [
      { id: 'r1', text: 'CLI status command succeeds in the sandbox' },
      { id: 'r2', text: 'Documentation names the new sandbox option' },
    ];

    const report = composeVerifierReport({
      pinned,
      routes: new Map([
        ['r1', 'sandbox-command'],
        ['r2', 'llm'],
      ]),
      llmReport: llmReport([]),
    });

    expect(report.perRequirement).toEqual([
      { requirementId: 'r1', strength: 'cannotVerify', scope: 'matched' },
      { requirementId: 'r2', strength: 'cannotVerify', scope: 'matched' },
    ]);
    expect(report.couldNotVerify.join('\n')).toContain('no trusted sandboxed check configured for r1');
    expect(report.couldNotVerify.join('\n')).toContain('LLM report did not score r2');
    expect(decideVerdict(cleanChecks, report, pinned).outcome).toBe('couldNotVerify');
  });

  it('keeps non-zero sandbox checks as rejected contradictions', () => {
    const pinned: PinnedRequirement[] = [{ id: 'r1', text: 'CLI status command succeeds in the sandbox' }];

    const report = composeVerifierReport({
      pinned,
      routes: new Map([['r1', 'sandbox-command']]),
      sandboxChecks: [{ requirementId: 'r1', command: 'git status --short', result: completed(1, '', 'bad') }],
    });

    expect(report.feature).toBe('broken');
    expect(report.perRequirement).toEqual([{ requirementId: 'r1', strength: 'contradicts', scope: 'matched' }]);
    expect(decideVerdict(cleanChecks, report, pinned).outcome).toBe('rejected');
  });
});

function llmReport(
  perRequirement: VerifierReport['perRequirement'],
  overrides: Partial<VerifierReport> = {},
): VerifierReport {
  return {
    feature: 'works',
    expected: 'LLM verifier checks file evidence.',
    observed: '',
    evidence: '',
    perRequirement,
    couldNotVerify: [],
    rationale: 'LLM verifier report.',
    ...overrides,
  };
}

function completed(exitCode: number, stdout: string, stderr = ''): SandboxRunResult {
  return {
    status: 'completed',
    backend: 'wsl2-unshare',
    audit: audit(),
    exitCode,
    stdout,
    stderr,
    durationMs: 12,
  };
}

function audit(): SandboxRunResult['audit'] {
  return {
    backend: 'wsl2-unshare',
    command: ['bash', '--noprofile', '--norc', '-c', 'git status --short'],
    cwd: '/tmp/jarvis-sandbox/project',
    mounts: [{ hostPath: 'H:\\jarvis-agent', sandboxPath: '/tmp/jarvis-sandbox/project', access: 'read-only' }],
    networkMode: 'none',
    limits: { timeoutMs: 1_000, outputBytes: 4_096 },
  };
}
