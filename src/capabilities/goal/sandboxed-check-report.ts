import type { SandboxRunResult } from '../../runtime/sandbox/index.js';
import type { PinnedRequirement, VerifierReport } from './goal.js';
import { couldNotVerifyReport } from './verifier.js';

export interface SandboxedRequirementCheck {
  readonly requirementId: string;
  readonly command: string;
  readonly result: SandboxRunResult;
}

export function reportFromSandboxedRequirementChecks(
  pinned: readonly PinnedRequirement[],
  checks: readonly SandboxedRequirementCheck[],
): VerifierReport {
  const pinnedIds = new Set(pinned.map((requirement) => requirement.id));
  const duplicate = firstDuplicate(checks.map((check) => check.requirementId));
  if (duplicate !== undefined) return couldNotVerifyReport(`duplicate sandboxed check for requirement: ${duplicate}`);

  const unknown = checks.find((check) => !pinnedIds.has(check.requirementId));
  if (unknown !== undefined) return couldNotVerifyReport(`sandboxed check targets an unknown requirement: ${unknown.requirementId}`);

  const checksByRequirement = new Map(checks.map((check) => [check.requirementId, check]));
  const perRequirement: VerifierReport['perRequirement'] = [];
  const couldNotVerify: string[] = [];
  const evidence: string[] = [];
  const observed: string[] = [];
  let feature: VerifierReport['feature'] = 'works';

  for (const requirement of pinned) {
    const check = checksByRequirement.get(requirement.id);
    if (check === undefined) {
      perRequirement.push({ requirementId: requirement.id, strength: 'cannotVerify', scope: 'matched' });
      couldNotVerify.push(`no trusted sandboxed check configured for ${requirement.id}: ${requirement.text}`);
      continue;
    }

    const mapped = mapSandboxResult(requirement, check);
    perRequirement.push(mapped.score);
    evidence.push(mapped.evidence);
    observed.push(mapped.observed);
    if (mapped.couldNotVerify !== undefined) couldNotVerify.push(mapped.couldNotVerify);
    if (mapped.feature === 'broken') feature = 'broken';
  }

  return {
    feature,
    expected: 'Every trusted sandboxed requirement check exits with code 0.',
    observed: observed.join('\n\n'),
    evidence: evidence.join('\n\n'),
    perRequirement,
    couldNotVerify,
    rationale:
      feature === 'broken'
        ? 'At least one trusted sandboxed requirement check failed.'
        : couldNotVerify.length > 0
          ? 'Some trusted sandboxed requirement checks could not run.'
          : 'Every trusted sandboxed requirement check passed.',
  };
}

function mapSandboxResult(
  requirement: PinnedRequirement,
  check: SandboxedRequirementCheck,
): {
  score: VerifierReport['perRequirement'][number];
  feature: VerifierReport['feature'];
  evidence: string;
  observed: string;
  couldNotVerify?: string;
} {
  const prefix = `${requirement.id}: ${requirement.text}\ncommand: ${check.command}`;
  if (check.result.status !== 'completed') {
    const reason = `${check.result.status}: ${check.result.reason}`;
    return {
      score: { requirementId: requirement.id, strength: 'cannotVerify', scope: 'matched' },
      feature: 'works',
      evidence: `${prefix}\nsandbox did not complete: ${reason}`,
      observed: `${requirement.id}: sandbox did not complete`,
      couldNotVerify: `sandboxed check could not verify ${requirement.id}: ${reason}`,
    };
  }

  const output = compactOutput(check.result.stdout, check.result.stderr);
  if (check.result.exitCode === 0) {
    return {
      score: { requirementId: requirement.id, strength: 'proves', scope: 'matched' },
      feature: 'works',
      evidence: `${prefix}\nexitCode: 0\n${output}`,
      observed: `${requirement.id}: sandboxed check passed`,
    };
  }

  return {
    score: { requirementId: requirement.id, strength: 'contradicts', scope: 'matched' },
    feature: 'broken',
    evidence: `${prefix}\nexitCode: ${check.result.exitCode}\n${output}`,
    observed: `${requirement.id}: sandboxed check failed with exit code ${check.result.exitCode}`,
  };
}

function compactOutput(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout.trim() !== '') parts.push(`stdout:\n${stdout.trim()}`);
  if (stderr.trim() !== '') parts.push(`stderr:\n${stderr.trim()}`);
  return parts.length > 0 ? parts.join('\n') : 'output: (empty)';
}

function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}
