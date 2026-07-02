import type { PinnedRequirement, VerifierReport } from './goal.js';
import type { GoalSetterRequirementRoute } from './goal-setter-requirements.js';
import {
  type SandboxedRequirementCheck,
  reportFromSandboxedRequirementChecks,
} from './sandboxed-check-report.js';
import { couldNotVerifyReport } from './verifier.js';

export interface ComposeVerifierReportInput {
  readonly pinned: readonly PinnedRequirement[];
  readonly routes: ReadonlyMap<string, GoalSetterRequirementRoute>;
  readonly sandboxChecks?: readonly SandboxedRequirementCheck[];
  readonly llmReport?: VerifierReport;
}

export function composeVerifierReport(input: ComposeVerifierReportInput): VerifierReport {
  const routeFailure = validateRoutes(input.pinned, input.routes);
  if (routeFailure !== undefined) return routeFailure;

  const sandboxChecks = input.sandboxChecks ?? [];
  const sandboxFailure = validateSandboxChecks(input.pinned, input.routes, sandboxChecks);
  if (sandboxFailure !== undefined) return sandboxFailure;

  const llmFailure = validateLlmReport(input.routes, input.llmReport);
  if (llmFailure !== undefined) return llmFailure;

  const sandboxPinned = input.pinned.filter((requirement) => input.routes.get(requirement.id) === 'sandbox-command');
  const sandboxReport =
    sandboxPinned.length > 0 ? reportFromSandboxedRequirementChecks(sandboxPinned, sandboxChecks) : undefined;
  if (sandboxReport?.perRequirement.length === 0 && sandboxReport.couldNotVerify.length > 0) return sandboxReport;

  const sandboxScores = new Map(sandboxReport?.perRequirement.map((score) => [score.requirementId, score]) ?? []);
  const llmScores = new Map(input.llmReport?.perRequirement.map((score) => [score.requirementId, score]) ?? []);

  const perRequirement: VerifierReport['perRequirement'] = [];
  const couldNotVerify: string[] = [];

  if (sandboxReport !== undefined) couldNotVerify.push(...sandboxReport.couldNotVerify);
  if (input.llmReport !== undefined) couldNotVerify.push(...input.llmReport.couldNotVerify);

  for (const requirement of input.pinned) {
    const route = input.routes.get(requirement.id);
    if (route === 'sandbox-command') {
      const score = sandboxScores.get(requirement.id);
      if (score === undefined) {
        perRequirement.push({ requirementId: requirement.id, strength: 'cannotVerify', scope: 'matched' });
        couldNotVerify.push(`no trusted sandboxed check configured for ${requirement.id}: ${requirement.text}`);
      } else {
        perRequirement.push(score);
      }
      continue;
    }

    if (route === 'llm') {
      const score = llmScores.get(requirement.id);
      if (score === undefined) {
        perRequirement.push({ requirementId: requirement.id, strength: 'cannotVerify', scope: 'matched' });
        couldNotVerify.push(
          input.llmReport === undefined
            ? `no LLM verifier report configured for ${requirement.id}: ${requirement.text}`
            : `LLM report did not score ${requirement.id}: ${requirement.text}`,
        );
      } else {
        perRequirement.push(score);
      }
      continue;
    }

    perRequirement.push({ requirementId: requirement.id, strength: 'cannotVerify', scope: 'matched' });
    couldNotVerify.push(`human verification required for ${requirement.id}: ${requirement.text}`);
  }

  const feature = hasBrokenEvidence(perRequirement, sandboxReport, input.llmReport) ? 'broken' : 'works';

  return {
    feature,
    expected: 'Every goal-setter-authored requirement is verified by its configured route.',
    observed: compactParts([
      sandboxReport ? scopedSection('sandbox verifier observed', sandboxReport.observed) : '',
      input.llmReport ? scopedSection('LLM verifier observed', input.llmReport.observed) : '',
      humanObserved(input.pinned, input.routes),
    ]),
    evidence: compactParts([
      sandboxReport ? scopedSection('sandbox verifier evidence', sandboxReport.evidence) : '',
      input.llmReport ? scopedSection('LLM verifier evidence', input.llmReport.evidence) : '',
    ]),
    perRequirement,
    couldNotVerify,
    rationale: compositeRationale(feature, couldNotVerify.length),
  };
}

function validateRoutes(
  pinned: readonly PinnedRequirement[],
  routes: ReadonlyMap<string, GoalSetterRequirementRoute>,
): VerifierReport | undefined {
  const pinnedIds = new Set(pinned.map((requirement) => requirement.id));
  for (const routeId of routes.keys()) {
    if (!pinnedIds.has(routeId)) return couldNotVerifyReport(`verification route targets unknown requirement: ${routeId}`);
  }
  for (const requirement of pinned) {
    const route = routes.get(requirement.id);
    if (route === undefined) return couldNotVerifyReport(`no verification route configured for ${requirement.id}`);
    if (route !== 'sandbox-command' && route !== 'llm' && route !== 'human') {
      return couldNotVerifyReport(`unknown verification route for ${requirement.id}: ${String(route)}`);
    }
  }
  return undefined;
}

function validateSandboxChecks(
  pinned: readonly PinnedRequirement[],
  routes: ReadonlyMap<string, GoalSetterRequirementRoute>,
  sandboxChecks: readonly SandboxedRequirementCheck[],
): VerifierReport | undefined {
  const duplicate = firstDuplicate(sandboxChecks.map((check) => check.requirementId));
  if (duplicate !== undefined) return couldNotVerifyReport(`duplicate sandboxed check for requirement: ${duplicate}`);

  const pinnedIds = new Set(pinned.map((requirement) => requirement.id));
  for (const check of sandboxChecks) {
    if (!pinnedIds.has(check.requirementId)) {
      return couldNotVerifyReport(`sandboxed check targets an unknown requirement: ${check.requirementId}`);
    }
    if (routes.get(check.requirementId) !== 'sandbox-command') {
      return couldNotVerifyReport(`sandboxed check targets non-sandbox requirement: ${check.requirementId}`);
    }
  }
  return undefined;
}

function validateLlmReport(
  routes: ReadonlyMap<string, GoalSetterRequirementRoute>,
  llmReport: VerifierReport | undefined,
): VerifierReport | undefined {
  if (llmReport === undefined) return undefined;
  const duplicate = firstDuplicate(llmReport.perRequirement.map((score) => score.requirementId));
  if (duplicate !== undefined) return couldNotVerifyReport(`duplicate LLM score for requirement: ${duplicate}`);

  for (const score of llmReport.perRequirement) {
    const route = routes.get(score.requirementId);
    if (route === undefined) return couldNotVerifyReport(`LLM report scored unknown requirement: ${score.requirementId}`);
    if (route !== 'llm') return couldNotVerifyReport(`LLM report scored non-LLM requirement: ${score.requirementId}`);
  }
  return undefined;
}

function hasBrokenEvidence(
  perRequirement: VerifierReport['perRequirement'],
  sandboxReport: VerifierReport | undefined,
  llmReport: VerifierReport | undefined,
): boolean {
  if (sandboxReport?.feature === 'broken' || llmReport?.feature === 'broken') return true;
  return perRequirement.some(
    (score) =>
      score.strength === 'contradicts' || score.strength === 'incomplete' || score.strength === 'missing',
  );
}

function compositeRationale(feature: VerifierReport['feature'], couldNotVerifyCount: number): string {
  if (feature === 'broken') return 'At least one routed verifier found a requirement unmet.';
  if (couldNotVerifyCount > 0) return 'Some goal-setter-authored requirements need another verifier route.';
  return 'Every goal-setter-authored requirement was verified by its configured route.';
}

function humanObserved(
  pinned: readonly PinnedRequirement[],
  routes: ReadonlyMap<string, GoalSetterRequirementRoute>,
): string {
  const human = pinned.filter((requirement) => routes.get(requirement.id) === 'human');
  if (human.length === 0) return '';
  return human.map((requirement) => `${requirement.id}: waiting for human verification`).join('\n');
}

function scopedSection(label: string, value: string): string {
  const body = value.trim();
  return body === '' ? '' : `${label}:\n${body}`;
}

function compactParts(parts: readonly string[]): string {
  return parts.filter((part) => part.trim() !== '').join('\n\n');
}

function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}
