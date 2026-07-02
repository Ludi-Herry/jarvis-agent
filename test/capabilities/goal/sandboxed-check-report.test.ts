import { describe, expect, it } from 'vitest';
import { decideVerdict } from '../../../src/capabilities/goal/verdict.js';
import { reportFromSandboxedRequirementChecks } from '../../../src/capabilities/goal/sandboxed-check-report.js';
import type { DeterministicChecks, PinnedRequirement } from '../../../src/capabilities/goal/goal.js';
import type { SandboxRunResult } from '../../../src/runtime/index.js';

const pinned: PinnedRequirement[] = [
  { id: 'r1', text: 'CLI prints status' },
  { id: 'r2', text: 'No generated file is left behind' },
];

const cleanChecks: DeterministicChecks = {
  objectiveChecksPassed: true,
  results: [],
  testTamper: 'clean',
  tamperReason: '',
};

describe('reportFromSandboxedRequirementChecks', () => {
  it('maps all passing trusted sandbox checks to a verified verdict', () => {
    const report = reportFromSandboxedRequirementChecks(pinned, [
      { requirementId: 'r1', command: 'git status --short', result: completed(0, 'ok') },
      { requirementId: 'r2', command: 'git diff --check', result: completed(0, '') },
    ]);

    expect(report.feature).toBe('works');
    expect(report.couldNotVerify).toEqual([]);
    expect(report.perRequirement).toEqual([
      { requirementId: 'r1', strength: 'proves', scope: 'matched' },
      { requirementId: 'r2', strength: 'proves', scope: 'matched' },
    ]);
    expect(decideVerdict(cleanChecks, report, pinned).outcome).toBe('verified');
  });

  it('includes sandbox audit context in verifier evidence', () => {
    const report = reportFromSandboxedRequirementChecks([pinned[0]], [
      { requirementId: 'r1', command: 'git status --short', result: completed(0, 'ok') },
    ]);

    expect(report.evidence).toContain('sandbox audit:');
    expect(report.evidence).toContain('"backend": "wsl2-unshare"');
    expect(report.evidence).toContain('"mounts"');
    expect(report.evidence).toContain('"networkMode": "none"');
    expect(report.evidence).toContain('"limits"');
    expect(report.evidence).toContain('"timeoutMs": 1000');
  });

  it('maps sandbox unavailable to cannotVerify and a couldNotVerify verdict', () => {
    const report = reportFromSandboxedRequirementChecks(pinned, [
      { requirementId: 'r1', command: 'git status --short', result: unavailable('wsl missing') },
      { requirementId: 'r2', command: 'git diff --check', result: completed(0, '') },
    ]);

    expect(report.perRequirement[0]).toEqual({ requirementId: 'r1', strength: 'cannotVerify', scope: 'matched' });
    expect(report.couldNotVerify[0]).toContain('wsl missing');
    const verdict = decideVerdict(cleanChecks, report, pinned);
    expect(verdict.outcome).toBe('couldNotVerify');
    expect(verdict.rationale).toContain('could not verify');
  });

  it('maps a non-zero trusted check to contradiction and a rejected verdict', () => {
    const report = reportFromSandboxedRequirementChecks(pinned, [
      { requirementId: 'r1', command: 'git status --short', result: completed(1, '', 'bad') },
      { requirementId: 'r2', command: 'git diff --check', result: completed(0, '') },
    ]);

    expect(report.feature).toBe('broken');
    expect(report.perRequirement[0]).toEqual({ requirementId: 'r1', strength: 'contradicts', scope: 'matched' });
    const verdict = decideVerdict(cleanChecks, report, pinned);
    expect(verdict.outcome).toBe('rejected');
    expect(verdict.rationale).toContain('requirement not met');
  });

  it('fails closed when a pinned requirement has no trusted sandbox check', () => {
    const report = reportFromSandboxedRequirementChecks(pinned, [
      { requirementId: 'r1', command: 'git status --short', result: completed(0, '') },
    ]);

    expect(report.perRequirement[1]).toEqual({ requirementId: 'r2', strength: 'cannotVerify', scope: 'matched' });
    expect(report.couldNotVerify[0]).toContain('no trusted sandboxed check configured');
    expect(decideVerdict(cleanChecks, report, pinned).outcome).toBe('couldNotVerify');
  });

  it('fails closed when checks target unknown or duplicate requirements', () => {
    const unknown = reportFromSandboxedRequirementChecks(pinned, [
      { requirementId: 'unknown', command: 'git status --short', result: completed(0, '') },
    ]);
    const duplicate = reportFromSandboxedRequirementChecks(pinned, [
      { requirementId: 'r1', command: 'git status --short', result: completed(0, '') },
      { requirementId: 'r1', command: 'git diff --stat', result: completed(0, '') },
    ]);

    expect(unknown.couldNotVerify[0]).toContain('unknown requirement');
    expect(duplicate.couldNotVerify[0]).toContain('duplicate sandboxed check');
  });
});

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

function unavailable(reason: string): SandboxRunResult {
  return {
    status: 'unavailable',
    backend: 'wsl2-unshare',
    audit: audit(),
    reason,
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
