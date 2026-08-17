/**
 * CLI builders for the write-side session mutations
 * (`jarvis sessions fork|rename|archive|unarchive`).
 *
 * These commands change session state (create/move files) but grant no
 * completion authority and never delete or rewrite existing log bytes. All
 * behavior decisions live in runtime/session/mutations.ts; this file only
 * maps results to reports, text, and exit codes.
 *
 * Exit contract: 0 created/moved/renamed; 2 usage errors (unsafe or unknown
 * id, target exists, wrong archived state); 3 refused/blocked/partial
 * (pending effects, partial composition, drift, live writer, half-done
 * rename); 5 runtime I/O or audit failure; 7 corrupt source.
 *
 * JSON contract: versioned (schemaVersion 1), additive-only, no ANSI. The
 * authority block is `mutation` — state-changing but completion-less.
 */
import { join } from 'node:path';
import {
  forkSession,
  moveSession,
  renameSession,
  type ForkSessionResult,
  type MoveSessionResult,
  type RenameSessionResult,
  type SessionMutationKind,
} from '../../runtime/session/mutations.js';
import { safeInline } from './approval.js';
import { CLI_EXIT, type CliExitCode } from './exit-codes.js';

export interface SessionMutationAuthority {
  mode: 'mutation';
  canCompleteGoals: false;
  canCompleteLoops: false;
}

const MUTATION_AUTHORITY: SessionMutationAuthority = {
  mode: 'mutation',
  canCompleteGoals: false,
  canCompleteLoops: false,
};

export interface SessionMutationReport {
  schemaVersion: 1;
  authority: SessionMutationAuthority;
  source: { cwd: string; dataDir: string };
  generatedAt: string;
  kind: SessionMutationKind;
  result: ForkSessionResult | MoveSessionResult | RenameSessionResult;
}

export interface SessionMutationCliOutcome {
  report: SessionMutationReport;
  exitCode: CliExitCode;
}

export async function runSessionsFork(input: {
  cwd: string;
  sessionId: string;
  newId?: string;
  generatedAt?: string;
}): Promise<SessionMutationCliOutcome> {
  const result = await forkSession({
    cwd: input.cwd,
    sourceSessionId: input.sessionId,
    ...(input.newId === undefined ? {} : { targetSessionId: input.newId }),
  });
  return {
    report: baseReport(input, 'fork', result),
    exitCode: mutationExitCode(result.status),
  };
}

export async function runSessionsRename(input: {
  cwd: string;
  sessionId: string;
  newId: string;
  generatedAt?: string;
}): Promise<SessionMutationCliOutcome> {
  const result = await renameSession({
    cwd: input.cwd,
    sourceSessionId: input.sessionId,
    newSessionId: input.newId,
  });
  return {
    report: baseReport(input, 'rename', result),
    exitCode: mutationExitCode(result.status),
  };
}

export async function runSessionsMove(input: {
  cwd: string;
  sessionId: string;
  direction: 'archive' | 'unarchive';
  generatedAt?: string;
}): Promise<SessionMutationCliOutcome> {
  const result = await moveSession({
    cwd: input.cwd,
    sessionId: input.sessionId,
    direction: input.direction,
  });
  return {
    report: baseReport(input, input.direction, result),
    exitCode: mutationExitCode(result.status),
  };
}

export function formatSessionMutationReport(report: SessionMutationReport): string {
  const lines = [
    `Sessions ${report.kind}: ${report.result.status}`,
    `source: ${inline(report.source.dataDir)}`,
  ];
  const result = report.result;
  if ('reason' in result && result.reason !== undefined) lines.push(`reason: ${inline(result.reason)}`);
  if (result.status === 'created') {
    lines.push(`fork: ${inline(result.forkSessionId)}`);
    lines.push(`path: ${inline(result.path)}`);
    lines.push(
      `records copied: ${result.recordCount} (receipts preserved`
        + `${result.format === 'v2' ? '; forkedFrom recorded in the v2 header' : '; v1 lineage is in the mutation audit only'})`,
    );
  }
  if (result.status === 'moved') {
    lines.push(`session: ${inline(result.sessionId)}`);
    lines.push(`from: ${inline(result.from)}`);
    lines.push(`to: ${inline(result.to)}`);
    if (result.pendingToolEffects !== undefined) {
      lines.push(`warning: ${result.pendingToolEffects} pending tool effect(s) remain unresolved in the ${report.kind === 'archive' ? 'archive' : 'restored session'}`);
    }
    for (const warning of result.warnings) lines.push(`warning: ${inline(warning)}`);
  }
  if (result.status === 'partial') {
    lines.push(`fork kept: ${inline(result.forkSessionId)}`);
  }
  if (result.status === 'renamed') {
    lines.push(`renamed: ${inline(result.from)} -> ${inline(result.to)}`);
    lines.push(`new session: ${inline(result.forkPath)}`);
    lines.push(`original archived at: ${inline(result.archivedPath)}`);
    for (const warning of result.warnings) lines.push(`warning: ${inline(warning)}`);
  }
  lines.push('audit: data/session-mutations.jsonl');
  lines.push('completion authority: none (mutation audit only)');
  return `${lines.join('\n')}\n`;
}

export function mutationExitCode(status: string): CliExitCode {
  switch (status) {
    case 'created':
    case 'moved':
    case 'renamed':
      return CLI_EXIT.SUCCESS;
    case 'invalid':
    case 'not-found':
      return CLI_EXIT.USAGE;
    case 'refused':
    case 'blocked':
    case 'partial':
      return CLI_EXIT.NEEDS_HUMAN;
    case 'corrupt':
      return CLI_EXIT.STATE_CORRUPT;
    default:
      return CLI_EXIT.RUNTIME;
  }
}

function baseReport(
  input: { cwd: string; generatedAt?: string },
  kind: SessionMutationKind,
  result: ForkSessionResult | MoveSessionResult | RenameSessionResult,
): SessionMutationReport {
  return {
    schemaVersion: 1,
    authority: MUTATION_AUTHORITY,
    source: { cwd: input.cwd, dataDir: join(input.cwd, 'data') },
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    kind,
    result,
  };
}

function inline(value: string | undefined, fallback = '-'): string {
  if (value === undefined) return fallback;
  const safe = safeInline(value);
  return safe === '' ? fallback : safe;
}
