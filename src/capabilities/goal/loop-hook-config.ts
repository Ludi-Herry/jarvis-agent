import { isAbsolute, relative, resolve } from 'node:path';
import type { ReadText } from '../rules/index.js';
import type { RealPath } from './loop-verifier-config.js';

export interface LoopHookMapEntry {
  index: number;
  hookPath: string;
}

export interface LoopHookMap {
  goals: LoopHookMapEntry[];
}

export interface LoadedLoopHookMap extends LoopHookMap {
  path: string;
}

export interface LoopHookPlan {
  hookPathByIndex: Map<number, string>;
  overrideCount: number;
}

export function parseLoopHookMap(text: string): LoopHookMap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`hook map is not valid JSON: ${message(err)}`, { cause: err });
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('hook map must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;
  const unknownTop = Object.keys(obj).filter((k) => k !== 'goals');
  if (unknownTop.length > 0) throw new Error(`unknown hook map keys: ${unknownTop.join(', ')}`);
  if (!Array.isArray(obj.goals)) throw new Error('hook map .goals must be an array');

  const seen = new Set<number>();
  const goals = obj.goals.map((item, i): LoopHookMapEntry => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`goals[${i}] must be an object`);
    }

    const entry = item as Record<string, unknown>;
    const unknown = Object.keys(entry).filter((k) => k !== 'index' && k !== 'hookPath');
    if (unknown.length > 0) throw new Error(`goals[${i}] has unknown keys: ${unknown.join(', ')}`);

    if (typeof entry.index !== 'number' || !Number.isInteger(entry.index) || entry.index < 0) {
      throw new Error(`goals[${i}].index must be a non-negative integer`);
    }
    if (seen.has(entry.index)) throw new Error(`duplicate hook map index: ${entry.index}`);
    seen.add(entry.index);

    if (typeof entry.hookPath !== 'string' || entry.hookPath.trim() === '') {
      throw new Error(`goals[${i}].hookPath must be a non-empty string`);
    }
    return { index: entry.index, hookPath: entry.hookPath.trim() };
  });

  return { goals };
}

export async function loadLoopHookMap(deps: {
  path: string;
  cwd: string;
  readText: ReadText;
  realpath?: RealPath;
}): Promise<LoadedLoopHookMap> {
  const source = deps.path.trim();
  if (source === '') throw new Error('hook map path is blank');

  const canonCwd = (deps.realpath ? await deps.realpath(deps.cwd) : null) ?? resolve(deps.cwd);
  const canonPath = deps.realpath ? await deps.realpath(source) : resolve(source);
  if (canonPath === null) throw new Error(`hook map cannot be read: ${source}`);
  if (isInsideCwd(canonPath, canonCwd)) {
    throw new Error(`hook map is inside the working directory (${canonPath}); refusing repo-controlled hook map`);
  }

  const text = await deps.readText(canonPath);
  if (text === null) throw new Error(`hook map cannot be read: ${canonPath}`);
  const map = parseLoopHookMap(text);
  await canonicalizeHookPaths(map, canonCwd, deps.realpath);
  return { ...map, path: canonPath };
}

export function assertResumeHookMapMatches(recordedPath: string | undefined, currentPath: string | undefined): void {
  if (currentPath === undefined) {
    if (recordedPath === undefined) {
      throw new Error('resume requires --hook-map <path> so per-goal hook mode comes from a trusted file; use a trusted empty map for no per-goal hooks');
    }
    throw new Error(`this loop was created with hook-map ${recordedPath}; resume requires --hook-map with the same trusted file`);
  }
  if (recordedPath === undefined) return;
  if (currentPath !== recordedPath) {
    throw new Error(`resume hook-map ${currentPath} does not match the original hook-map ${recordedPath}`);
  }
}

export function buildLoopHookPlan(input: { objectivesCount: number; map?: LoopHookMap }): LoopHookPlan {
  const hookPathByIndex = new Map(input.map?.goals.map((goal) => [goal.index, goal.hookPath]) ?? []);
  for (const index of hookPathByIndex.keys()) {
    if (index >= input.objectivesCount) {
      throw new Error(`hook map index ${index} is out of range for ${input.objectivesCount} objectives`);
    }
  }
  return { hookPathByIndex, overrideCount: hookPathByIndex.size };
}

async function canonicalizeHookPaths(map: LoopHookMap, canonCwd: string, realpath?: RealPath): Promise<void> {
  for (const goal of map.goals) {
    const canonHook = realpath ? await realpath(goal.hookPath) : resolve(goal.hookPath);
    if (canonHook === null) throw new Error(`hook map index ${goal.index} hook path cannot be read: ${goal.hookPath}`);
    if (isInsideCwd(canonHook, canonCwd)) {
      throw new Error(`hook map index ${goal.index} hook path is inside the working directory (${canonHook}); refusing repo-controlled hook config`);
    }
    goal.hookPath = canonHook;
  }
}

function isInsideCwd(absPath: string, cwd: string): boolean {
  const rel = relative(resolve(cwd), absPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
