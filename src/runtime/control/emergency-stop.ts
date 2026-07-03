import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface EmergencyStopRecord {
  schemaVersion: 1;
  requestedAt: string;
  source: string;
  reason: string;
  pid: number;
  cwd: string;
}

export interface EmergencyStopState {
  path: string;
  requested: boolean;
  record?: EmergencyStopRecord;
  requestedAtMs?: number;
  unreadable?: boolean;
  error?: string;
}

export interface EmergencyStopSignal {
  signal: AbortSignal;
  path: string;
  startedAtMs: number;
  checkNow(): Promise<EmergencyStopState>;
  dispose(): void;
}

export interface RequestEmergencyStopOptions {
  cwd?: string;
  source?: string;
  reason?: string;
  now?: () => Date;
  pid?: number;
}

export interface EmergencyStopSignalOptions {
  cwd?: string;
  pollMs?: number;
  startedAt?: Date;
  read?: (cwd: string) => Promise<EmergencyStopState>;
  onStop?: (state: EmergencyStopState) => void;
}

const CONTROL_DIR = ['data', 'control'] as const;
const STOP_FILE = 'emergency-stop.json';
const STOP_AUDIT_FILE = 'emergency-stop.jsonl';

export function emergencyStopPath(cwd = process.cwd()): string {
  return join(resolve(cwd), ...CONTROL_DIR, STOP_FILE);
}

export function emergencyStopAuditPath(cwd = process.cwd()): string {
  return join(resolve(cwd), ...CONTROL_DIR, STOP_AUDIT_FILE);
}

export async function requestEmergencyStop(options: RequestEmergencyStopOptions = {}): Promise<EmergencyStopRecord> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const now = options.now ?? (() => new Date());
  const record: EmergencyStopRecord = {
    schemaVersion: 1,
    requestedAt: now().toISOString(),
    source: options.source ?? 'unknown',
    reason: options.reason ?? 'emergency stop requested',
    pid: options.pid ?? process.pid,
    cwd,
  };
  const path = emergencyStopPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await rename(temp, path);
  await appendFile(emergencyStopAuditPath(cwd), `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export async function readEmergencyStop(cwd = process.cwd()): Promise<EmergencyStopState> {
  const path = emergencyStopPath(cwd);
  try {
    const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    const parsed = JSON.parse(text) as unknown;
    if (isEmergencyStopRecord(parsed)) {
      const requestedAtMs = Date.parse(parsed.requestedAt);
      return {
        path,
        requested: true,
        record: parsed,
        requestedAtMs: Number.isFinite(requestedAtMs) ? requestedAtMs : info.mtimeMs,
      };
    }
    return {
      path,
      requested: true,
      requestedAtMs: info.mtimeMs,
      unreadable: true,
      error: 'emergency stop file has an invalid shape',
    };
  } catch (err) {
    if (isNotFound(err)) return { path, requested: false };
    const fallback = await stat(path).catch(() => undefined);
    return {
      path,
      requested: fallback !== undefined,
      requestedAtMs: fallback?.mtimeMs,
      unreadable: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function shouldHonorEmergencyStop(state: EmergencyStopState, startedAtMs: number): boolean {
  return state.requested && state.requestedAtMs !== undefined && state.requestedAtMs >= startedAtMs;
}

export function createEmergencyStopSignal(options: EmergencyStopSignalOptions = {}): EmergencyStopSignal {
  const cwd = resolve(options.cwd ?? process.cwd());
  const startedAtMs = (options.startedAt ?? new Date()).getTime();
  const pollMs = options.pollMs ?? 500;
  const read = options.read ?? readEmergencyStop;
  const controller = new AbortController();
  let disposed = false;
  let checking = false;

  const checkNow = async (): Promise<EmergencyStopState> => {
    const state = await read(cwd);
    if (!controller.signal.aborted && shouldHonorEmergencyStop(state, startedAtMs)) {
      controller.abort(new Error(stopReason(state)));
      options.onStop?.(state);
    }
    return state;
  };

  const timer = setInterval(() => {
    if (disposed || checking || controller.signal.aborted) return;
    checking = true;
    void checkNow().finally(() => {
      checking = false;
    });
  }, pollMs);
  timer.unref?.();
  void checkNow();

  return {
    signal: controller.signal,
    path: emergencyStopPath(cwd),
    startedAtMs,
    checkNow,
    dispose: () => {
      disposed = true;
      clearInterval(timer);
    },
  };
}

function stopReason(state: EmergencyStopState): string {
  return state.record?.reason ?? state.error ?? 'emergency stop requested';
}

function isEmergencyStopRecord(value: unknown): value is EmergencyStopRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.requestedAt === 'string' &&
    typeof record.source === 'string' &&
    typeof record.reason === 'string' &&
    typeof record.pid === 'number' &&
    typeof record.cwd === 'string'
  );
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT';
}
