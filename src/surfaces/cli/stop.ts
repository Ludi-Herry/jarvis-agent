/**
 * `jarvis stop [--reason <text>]` / `jarvis stop --clear` — CLI producer for
 * the workspace emergency-stop control channel.
 *
 * The channel itself (`runtime/control/emergency-stop.ts`) is unchanged:
 * `data/control/emergency-stop.json` (atomic temp+rename write) plus an
 * append-only audit JSONL. goal/loop/cron/cron-daemon poll it with startedAt
 * gating, so only runs started BEFORE the request halt; later runs are
 * unaffected. This command only writes/clears the signal and reports the
 * read-back state — it grants no completion authority and touches no
 * consumer logic.
 *
 * The stop is workspace-global by design; there is no per-id targeting (an id
 * argument is a usage error with an explanation). `--clear` removes only the
 * control file (a fixed, non-dynamic path) and appends nothing to the audit.
 *
 * Exit contract: 0 stop written / clear done (including "no stop in
 * effect"); 2 usage error; 5 runtime I/O failure. JSON: schemaVersion 1,
 * additive-only, no ANSI.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  emergencyStopAuditPath,
  emergencyStopPath,
  readEmergencyStop,
  requestEmergencyStop,
  type EmergencyStopRecord,
} from '../../runtime/index.js';
import { safeInline } from './approval.js';
import { CLI_EXIT, type CliExitCode } from './exit-codes.js';

const CONTROL_AUTHORITY = {
  mode: 'control',
  canCompleteGoals: false,
  canCompleteLoops: false,
} as const;

export interface StopReport {
  schemaVersion: 1;
  authority: typeof CONTROL_AUTHORITY;
  source: { cwd: string; dataDir: string };
  generatedAt: string;
  action: 'stop' | 'clear';
  requested: boolean;
  record?: EmergencyStopRecord;
  cleared?: boolean;
  path: string;
  auditPath: string;
}

export interface StopOutcome {
  report: StopReport;
  exitCode: CliExitCode;
}

export async function runStop(input: {
  cwd: string;
  reason?: string;
  generatedAt?: string;
}): Promise<StopOutcome> {
  const record = await requestEmergencyStop({
    cwd: input.cwd,
    source: 'cli',
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
  const state = await readEmergencyStop(input.cwd);
  if (!state.requested) {
    throw new Error('emergency stop write did not land: read-back shows no stop in effect');
  }
  return {
    report: {
      schemaVersion: 1,
      authority: CONTROL_AUTHORITY,
      source: { cwd: input.cwd, dataDir: join(input.cwd, 'data') },
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      action: 'stop',
      requested: true,
      record,
      path: emergencyStopPath(input.cwd),
      auditPath: emergencyStopAuditPath(input.cwd),
    },
    exitCode: CLI_EXIT.SUCCESS,
  };
}

export async function runStopClear(input: {
  cwd: string;
  generatedAt?: string;
}): Promise<StopOutcome> {
  const before = await readEmergencyStop(input.cwd);
  let cleared = false;
  if (before.requested) {
    await rm(emergencyStopPath(input.cwd));
    cleared = true;
  }
  const after = await readEmergencyStop(input.cwd);
  if (after.requested) {
    throw new Error('emergency stop clear did not land: read-back still shows a stop in effect');
  }
  return {
    report: {
      schemaVersion: 1,
      authority: CONTROL_AUTHORITY,
      source: { cwd: input.cwd, dataDir: join(input.cwd, 'data') },
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      action: 'clear',
      requested: false,
      cleared,
      path: emergencyStopPath(input.cwd),
      auditPath: emergencyStopAuditPath(input.cwd),
    },
    exitCode: CLI_EXIT.SUCCESS,
  };
}

export function formatStopReport(report: StopReport): string {
  if (report.action === 'clear') {
    const lines = [
      report.cleared === true ? 'Emergency stop cleared (workspace-wide)' : 'No emergency stop in effect',
      `source: ${inline(report.source.dataDir)}`,
      'completion authority: none (control action only)',
    ];
    return `${lines.join('\n')}\n`;
  }
  const record = report.record;
  const lines = [
    'Emergency stop requested (workspace-wide)',
    `source: ${inline(report.source.dataDir)}`,
    `requestedAt: ${inline(record?.requestedAt)}  source: ${inline(record?.source)}  pid: ${record?.pid ?? '-'}`,
    `reason: ${inline(record?.reason)}`,
    'effect: goal/loop/cron runs started before requestedAt halt with emergency-stop; runs started later are unaffected',
    `audit: ${inline(report.auditPath)}`,
    'note: the active stop lives in data/control/emergency-stop.json; jarvis stop --clear removes it',
    'completion authority: none (control action only)',
  ];
  return `${lines.join('\n')}\n`;
}

function inline(value: string | undefined, fallback = '-'): string {
  if (value === undefined) return fallback;
  const safe = safeInline(value);
  return safe === '' ? fallback : safe;
}
