import { isAbsolute, relative, resolve } from 'node:path';
import type { ReadText } from '../rules/index.js';
import type { RealPath } from './loop-verifier-config.js';

export interface LoopCronTask {
  id: string;
  objectivesFile: string;
  intervalMinutes: number;
  nextRunAt: string;
  unattended: boolean;
  verifierMapPath?: string;
}

export interface LoopCronConfig {
  tasks: LoopCronTask[];
}

export interface LoadedLoopCronConfig extends LoopCronConfig {
  path: string;
}

const MAX_INTERVAL_MINUTES = 525_600;

export function parseLoopCronConfig(text: string): LoopCronConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`cron config is not valid JSON: ${message(err)}`, { cause: err });
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('cron config must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;
  const unknownTop = Object.keys(obj).filter((k) => k !== 'tasks');
  if (unknownTop.length > 0) throw new Error(`unknown cron config keys: ${unknownTop.join(', ')}`);
  if (!Array.isArray(obj.tasks)) throw new Error('cron config .tasks must be an array');

  const seen = new Set<string>();
  const tasks = obj.tasks.map((item, i): LoopCronTask => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`tasks[${i}] must be an object`);
    }
    const task = item as Record<string, unknown>;
    const unknown = Object.keys(task).filter(
      (k) => !['id', 'objectivesFile', 'intervalMinutes', 'nextRunAt', 'unattended', 'verifierMapPath'].includes(k),
    );
    if (unknown.length > 0) throw new Error(`tasks[${i}] has unknown keys: ${unknown.join(', ')}`);

    const id = stringField(task.id, `tasks[${i}].id`);
    if (seen.has(id)) throw new Error(`duplicate cron task id: ${id}`);
    seen.add(id);

    const objectivesFile = stringField(task.objectivesFile, `tasks[${i}].objectivesFile`);
    if (objectivesFile.startsWith('--')) {
      throw new Error(`tasks[${i}].objectivesFile must be a file path, not a loop CLI flag`);
    }
    if (typeof task.intervalMinutes !== 'number' || !Number.isInteger(task.intervalMinutes) || task.intervalMinutes < 1 || task.intervalMinutes > MAX_INTERVAL_MINUTES) {
      throw new Error(`tasks[${i}].intervalMinutes must be an integer from 1 to ${MAX_INTERVAL_MINUTES}`);
    }
    const nextRunAt = isoDateField(task.nextRunAt, `tasks[${i}].nextRunAt`);
    if (task.unattended !== true) throw new Error(`tasks[${i}].unattended must be true for cron tasks`);

    const verifierMapPath = task.verifierMapPath === undefined ? undefined : stringField(task.verifierMapPath, `tasks[${i}].verifierMapPath`);
    return verifierMapPath === undefined
      ? { id, objectivesFile, intervalMinutes: task.intervalMinutes, nextRunAt, unattended: task.unattended }
      : { id, objectivesFile, intervalMinutes: task.intervalMinutes, nextRunAt, unattended: task.unattended, verifierMapPath };
  });

  return { tasks };
}

export async function loadLoopCronConfig(deps: {
  path: string;
  cwd: string;
  readText: ReadText;
  realpath?: RealPath;
}): Promise<LoadedLoopCronConfig> {
  const source = deps.path.trim();
  if (source === '') throw new Error('cron config path is blank');

  const canonCwd = (deps.realpath ? await deps.realpath(deps.cwd) : null) ?? resolve(deps.cwd);
  const canonPath = deps.realpath ? await deps.realpath(source) : resolve(source);
  if (canonPath === null) throw new Error(`cron config cannot be read: ${source}`);
  if (isInsideCwd(canonPath, canonCwd)) {
    throw new Error(`cron config is inside the working directory (${canonPath}); refusing repo-controlled cron config`);
  }

  const text = await deps.readText(canonPath);
  if (text === null) throw new Error(`cron config cannot be read: ${canonPath}`);
  const config = parseLoopCronConfig(text);
  await assertVerifierMapsOutsideCwd(config, canonCwd, deps.realpath);
  return { ...config, path: canonPath };
}

async function assertVerifierMapsOutsideCwd(config: LoopCronConfig, canonCwd: string, realpath?: RealPath): Promise<void> {
  for (const task of config.tasks) {
    if (task.verifierMapPath === undefined) continue;
    const canonVerifier = realpath ? await realpath(task.verifierMapPath) : resolve(task.verifierMapPath);
    if (canonVerifier === null) throw new Error(`cron task ${task.id} verifier map cannot be read: ${task.verifierMapPath}`);
    if (isInsideCwd(canonVerifier, canonCwd)) {
      throw new Error(`cron task ${task.id} verifier map is inside the working directory (${canonVerifier}); refusing repo-controlled verifier config`);
    }
    task.verifierMapPath = canonVerifier;
  }
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function isoDateField(value: unknown, name: string): string {
  const raw = stringField(value, name);
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} must be a valid ISO timestamp`);
  return date.toISOString();
}

function isInsideCwd(absPath: string, cwd: string): boolean {
  const rel = relative(resolve(cwd), absPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
