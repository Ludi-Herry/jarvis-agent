/**
 * `jarvis a0` — the frozen A0 evaluation surface. `run` executes the corpus
 * against a verifier model and writes immutable observations + manifest;
 * `report` replays recorded observations through the pure report. Both are
 * observation-only: an A0 verdict is an evaluation gate, never goal or loop
 * completion authority.
 */
import type { ModelResult } from '../../core/model/types.js';
import { createProvider } from '../../core/model/create-provider.js';
import { loadDoubaoConfig } from '../../core/model/config.js';
import {
  reportA0Evaluation,
  runA0Evaluation,
  type A0ReportResult,
  type A0RunResult,
} from '../../capabilities/eval/a0-runner.js';
import type { A0Report } from '../../capabilities/eval/a0-contract.js';
import { safeInline } from './approval.js';
import { CLI_EXIT, type CliExitCode } from './exit-codes.js';

export const A0_AUTHORITY = Object.freeze({
  mode: 'observation-only' as const,
  canCompleteGoals: false as const,
  canCompleteLoops: false as const,
});

export const DEFAULT_A0_CORPUS = 'eval/a0/eval-cases.jsonl';
export const DEFAULT_A0_PROMPT = 'eval/a0/prompts/a0-leg3-v2.md';

export interface A0RunOptions {
  cwd: string;
  corpusPath: string;
  promptPath: string;
  outputDir: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
}

export async function runA0Command(options: A0RunOptions): Promise<{ result: A0RunResult; exitCode: CliExitCode }> {
  const env = options.env ?? process.env;
  const config = loadDoubaoConfig(env, options.model === undefined ? {} : { model: options.model });
  const provider = createProvider(config);
  const result = await runA0Evaluation({
    cwd: options.cwd,
    corpusPath: options.corpusPath,
    promptPath: options.promptPath,
    model: config.model,
    outputDir: options.outputDir,
    call: async (messages) => {
      let finished: ModelResult | undefined;
      const stream = provider.call(messages, []);
      for (;;) {
        const step = await stream.next();
        if (step.done) {
          finished = step.value;
          break;
        }
      }
      if (finished === undefined) throw new Error('verifier stream ended without a result');
      return {
        text: finished.text,
        inputTokens: finished.usage.inputTokens,
        outputTokens: finished.usage.outputTokens,
      };
    },
  });
  return { result, exitCode: result.report.verdict === 'GO' ? CLI_EXIT.SUCCESS : CLI_EXIT.NEEDS_HUMAN };
}

export async function reportA0Command(input: {
  cwd: string;
  corpusPath: string;
  observationsPath: string;
}): Promise<{ result: A0ReportResult; exitCode: CliExitCode }> {
  const result = await reportA0Evaluation(input);
  const exitCode = result.provenanceIssues.length > 0
    ? CLI_EXIT.STATE_CORRUPT
    : result.report.verdict === 'GO'
      ? CLI_EXIT.SUCCESS
      : CLI_EXIT.NEEDS_HUMAN;
  return { result, exitCode };
}

export function formatA0RunResult(result: A0RunResult): string {
  const lines = [
    'A0 run complete (observation-only)',
    `observations: ${safeInline(result.observationsPath)}`,
    `manifest: ${safeInline(result.manifestPath)}`,
    `verifier model: ${safeInline(result.manifest.policy.model)}`,
    `prompt: ${safeInline(result.manifest.policy.promptVersion)} (${result.manifest.policy.promptSha256.slice(0, 12)}…)`,
    ...formatA0ReportBody(result.report),
  ];
  if (result.parseFailures.length > 0) {
    lines.push(`verifier parse failures (parked as cannotVerify): ${result.parseFailures.length}`);
  }
  lines.push('completion authority: none', '');
  return `${lines.join('\n')}\n`;
}

export function formatA0ReportResult(result: A0ReportResult): string {
  const lines = [
    'A0 report (observation-only)',
    ...formatA0ReportBody(result.report),
  ];
  if (result.manifest === null) {
    lines.push('provenance: no run manifest found; provenance is unverified');
  } else {
    lines.push(`provenance: run manifest ${result.manifest.policy.model} @ ${safeInline(result.manifest.startedAt)}`);
  }
  for (const issue of result.provenanceIssues) lines.push(`provenance issue: ${safeInline(issue)}`);
  lines.push('completion authority: none', '');
  return `${lines.join('\n')}\n`;
}

export function a0CommandErrorExitCode(err: unknown): CliExitCode {
  const message = err instanceof Error ? err.message : String(err);
  if (/ARK_API_KEY is not set/u.test(message)) return CLI_EXIT.USAGE;
  if (/ENOENT/u.test(message) && /stat|open|no such file/iu.test(message)) return CLI_EXIT.USAGE;
  if (/is not a regular file|EISDIR/u.test(message)) return CLI_EXIT.USAGE;
  if (/is not set\b|must be|requires one|already exists and is immutable/u.test(message)) return CLI_EXIT.USAGE;
  if (/does not match the run manifest|drifted after the run|invalid observations file|invalid run manifest|references unknown case|duplicate observation/u.test(message)) {
    return CLI_EXIT.STATE_CORRUPT;
  }
  if (/status \d|network|fetch|failed to connect|timeout/iu.test(message)) return CLI_EXIT.RUNTIME;
  // Unknown failures are runtime problems; only the provenance/corruption
  // patterns above may claim STATE_CORRUPT.
  return CLI_EXIT.RUNTIME;
}

/** The manifest comes from operator-controlled artifacts; its strings are
 *  single-lined and stripped of terminal/bidi controls before any output mode
 *  (JSON.stringify alone does not escape U+2028/2029 or bidi overrides). */
export function sanitizeA0Manifest<T>(value: T): T {
  if (typeof value === 'string') return safeInline(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeA0Manifest(item)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeA0Manifest(child);
    }
    return out as T;
  }
  return value;
}

function formatA0ReportBody(report: A0Report): string[] {
  const lines = [
    `coverage: ${report.coverage.observations} observations across ${report.coverage.cases} cases, complete=${String(report.coverage.complete)}`,
    `verdict: ${report.verdict}`,
    `bad-case miss rate: ${report.metrics.badCaseMissRate}`,
    `good-case false-positive rate: ${report.metrics.goodCaseFalsePositiveRate}`,
    `park rate: ${report.metrics.parkRate}`,
    `repeat consistency: ${report.metrics.repeatConsistency}`,
    `mean tokens per case: ${report.metrics.meanTokensPerCase}`,
    `p95 latency: ${report.metrics.p95LatencyMs} ms`,
    `request reconstructability: ${report.metrics.requestReconstructabilityRate}`,
    `orphan side effects: ${report.metrics.orphanSideEffects} | receiptless attempts: ${report.metrics.receiptlessAttempts} | stale recall actions: ${report.metrics.staleRecallActions}`,
    `failures: ${report.failures.length === 0 ? 'none' : report.failures.length.toString()}`,
  ];
  for (const failure of report.failures) lines.push(`- ${safeInline(failure)}`);
  return lines;
}
