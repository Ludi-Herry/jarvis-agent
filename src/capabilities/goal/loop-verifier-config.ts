import { isAbsolute, relative, resolve } from 'node:path';
import type { VerifierResolution } from '../../core/model/config.js';
import type { DoubaoConfig } from '../../core/model/types.js';
import type { ReadText } from '../rules/index.js';

export type RealPath = (path: string) => Promise<string | null>;

export interface LoopVerifierMapEntry {
  index: number;
  verifierModel: string;
}

export interface LoopVerifierMap {
  goals: LoopVerifierMapEntry[];
}

export interface LoadedLoopVerifierMap extends LoopVerifierMap {
  path: string;
}

export type LoopVerifierDecision =
  | { enabled: true; config: DoubaoConfig; key: string; source: 'global' | 'map' }
  | { enabled: false; reason: string; source: 'global-disabled' };

export interface LoopVerifierPlan {
  decisions: LoopVerifierDecision[];
  overrideCount: number;
}

export function parseLoopVerifierMap(text: string): LoopVerifierMap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`verifier map is not valid JSON: ${message(err)}`, { cause: err });
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('verifier map must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;
  const unknownTop = Object.keys(obj).filter((k) => k !== 'goals');
  if (unknownTop.length > 0) throw new Error(`unknown verifier map keys: ${unknownTop.join(', ')}`);
  if (!Array.isArray(obj.goals)) throw new Error('verifier map .goals must be an array');

  const seen = new Set<number>();
  const goals = obj.goals.map((item, i): LoopVerifierMapEntry => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`goals[${i}] must be an object`);
    }

    const entry = item as Record<string, unknown>;
    const unknown = Object.keys(entry).filter((k) => k !== 'index' && k !== 'verifierModel');
    if (unknown.length > 0) throw new Error(`goals[${i}] has unknown keys: ${unknown.join(', ')}`);

    if (typeof entry.index !== 'number' || !Number.isInteger(entry.index) || entry.index < 0) {
      throw new Error(`goals[${i}].index must be a non-negative integer`);
    }
    if (seen.has(entry.index)) throw new Error(`duplicate verifier map index: ${entry.index}`);
    seen.add(entry.index);

    if (typeof entry.verifierModel !== 'string' || entry.verifierModel.trim() === '') {
      throw new Error(`goals[${i}].verifierModel must be a non-empty string`);
    }
    return { index: entry.index, verifierModel: entry.verifierModel.trim() };
  });

  return { goals };
}

export async function loadLoopVerifierMap(deps: {
  path: string;
  cwd: string;
  readText: ReadText;
  realpath?: RealPath;
}): Promise<LoadedLoopVerifierMap> {
  const source = deps.path.trim();
  if (source === '') throw new Error('verifier map path is blank');

  const canonCwd = (deps.realpath ? await deps.realpath(deps.cwd) : null) ?? resolve(deps.cwd);
  const canonPath = deps.realpath ? await deps.realpath(source) : resolve(source);
  if (canonPath === null) throw new Error(`verifier map cannot be read: ${source}`);
  if (isInsideCwd(canonPath, canonCwd)) {
    throw new Error(`verifier map is inside the working directory (${canonPath}); refusing repo-controlled verifier config`);
  }

  const text = await deps.readText(canonPath);
  if (text === null) throw new Error(`verifier map cannot be read: ${canonPath}`);
  return { ...parseLoopVerifierMap(text), path: canonPath };
}

export function assertResumeVerifierMapMatches(recordedPath: string | undefined, currentPath: string | undefined, explicitNoMap: boolean): void {
  if (explicitNoMap) {
    throw new Error('--no-verifier-map is unsafe for resume; use --verifier-map <trusted empty map> when deterministic-only resume is intentional');
  }
  if (currentPath === undefined && recordedPath === undefined && !explicitNoMap) {
    throw new Error('resume requires --verifier-map <path> so verifier mode comes from a trusted file; use a trusted empty map for deterministic-only resume');
  }
  if (recordedPath === undefined) return;
  if (currentPath === undefined) {
    throw new Error(`this loop was created with verifier-map ${recordedPath}; resume requires --verifier-map with the same trusted file`);
  }
  if (currentPath !== recordedPath) {
    throw new Error(`resume verifier-map ${currentPath} does not match the original verifier-map ${recordedPath}`);
  }
}

export function buildLoopVerifierPlan(input: {
  objectivesCount: number;
  builderConfig: DoubaoConfig;
  globalVerifier: VerifierResolution;
  map?: LoopVerifierMap;
}): LoopVerifierPlan {
  const overrides = new Map(input.map?.goals.map((goal) => [goal.index, goal.verifierModel]) ?? []);
  for (const index of overrides.keys()) {
    if (index >= input.objectivesCount) {
      throw new Error(`verifier map index ${index} is out of range for ${input.objectivesCount} objectives`);
    }
  }

  const decisions: LoopVerifierDecision[] = [];
  for (let index = 0; index < input.objectivesCount; index++) {
    const override = overrides.get(index);
    if (override !== undefined) {
      if (override === input.builderConfig.model) {
        throw new Error(`verifier map index ${index} equals the builder model (${override})`);
      }
      decisions.push({
        enabled: true,
        config: { ...input.builderConfig, model: override },
        key: `model:${override}`,
        source: 'map',
      });
      continue;
    }

    if (input.globalVerifier.enabled) {
      decisions.push({
        enabled: true,
        config: input.globalVerifier.config,
        key: `model:${input.globalVerifier.config.model}`,
        source: 'global',
      });
    } else {
      decisions.push({ enabled: false, reason: input.globalVerifier.reason, source: 'global-disabled' });
    }
  }

  return { decisions, overrideCount: overrides.size };
}

function isInsideCwd(absPath: string, cwd: string): boolean {
  const rel = relative(resolve(cwd), absPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
