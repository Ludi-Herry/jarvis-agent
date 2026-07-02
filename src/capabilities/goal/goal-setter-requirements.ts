import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import type { ReadText } from '../rules/index.js';
import { validateSandboxInspectionCommand } from '../../core/tools/sandboxed-inspection-command.js';
import type { PinnedRequirement } from './goal.js';
import type { SandboxedRequirementCommand } from './sandboxed-check-config.js';

export type GoalSetterRequirementRoute = 'sandbox-command' | 'llm' | 'human';
export type GoalSetterRequirementsRealPath = (path: string) => Promise<string | null>;

export interface GoalSetterRequirement {
  readonly id: string;
  readonly text: string;
  readonly route: GoalSetterRequirementRoute;
  readonly command?: string;
}

export interface GoalSetterRequirementsPlan {
  readonly version: 1;
  readonly requirements: GoalSetterRequirement[];
}

export interface GoalSetterRequirementsReference {
  readonly path: string;
  readonly hash: string;
}

export interface LoadedGoalSetterRequirements extends GoalSetterRequirementsPlan, GoalSetterRequirementsReference {
  readonly pinned: PinnedRequirement[];
  readonly routes: Map<string, GoalSetterRequirementRoute>;
  readonly commands: SandboxedRequirementCommand[];
}

export interface LoopGoalSetterRequirementsMapEntry {
  readonly index: number;
  readonly requirements: GoalSetterRequirement[];
}

export interface LoopGoalSetterRequirementsMap {
  readonly version: 1;
  readonly goals: LoopGoalSetterRequirementsMapEntry[];
}

export interface LoadedLoopGoalSetterRequirementsMap extends LoopGoalSetterRequirementsMap, GoalSetterRequirementsReference {}

export interface LoopGoalSetterRequirementsPlan {
  readonly pinnedByIndex: Map<number, PinnedRequirement[]>;
  readonly routesByIndex: Map<number, Map<string, GoalSetterRequirementRoute>>;
  readonly commandsByIndex: Map<number, SandboxedRequirementCommand[]>;
  readonly overrideCount: number;
}

export function parseGoalSetterRequirementsPlan(text: string): GoalSetterRequirementsPlan {
  const raw = parseJsonObject(stripUtf8Bom(text), 'goal-setter requirements');
  const unknownTop = Object.keys(raw).filter((key) => key !== 'version' && key !== 'requirements');
  if (unknownTop.length > 0) throw new Error(`unknown goal-setter requirements keys: ${unknownTop.join(', ')}`);
  if (raw.version !== 1) throw new Error('goal-setter requirements .version must be 1');
  return { version: 1, requirements: parseRequirements(raw.requirements, 'requirements', true) };
}

export async function loadGoalSetterRequirementsPlan(deps: {
  path: string;
  cwd: string;
  forbiddenRoots?: readonly string[];
  readText: ReadText;
  realpath?: GoalSetterRequirementsRealPath;
}): Promise<LoadedGoalSetterRequirements> {
  const source = deps.path.trim();
  if (source === '') throw new Error('goal-setter requirements path is blank');

  const canonPath = deps.realpath ? await deps.realpath(source) : resolve(source);
  if (canonPath === null) throw new Error(`goal-setter requirements cannot be read: ${source}`);
  await assertOutsideForbiddenRoots(canonPath, deps.cwd, deps.forbiddenRoots, deps.realpath, 'goal-setter requirements');

  const text = await deps.readText(canonPath);
  if (text === null) throw new Error(`goal-setter requirements cannot be read: ${canonPath}`);
  const normalized = stripUtf8Bom(text);
  const plan = parseGoalSetterRequirementsPlan(normalized);
  return { ...loadedFromPlan(plan), path: canonPath, hash: hashRequirementText(normalized) };
}

export function parseLoopGoalSetterRequirementsMap(text: string): LoopGoalSetterRequirementsMap {
  const raw = parseJsonObject(stripUtf8Bom(text), 'loop goal-setter requirements map');
  const unknownTop = Object.keys(raw).filter((key) => key !== 'version' && key !== 'goals');
  if (unknownTop.length > 0) throw new Error(`unknown loop goal-setter requirements map keys: ${unknownTop.join(', ')}`);
  if (raw.version !== 1) throw new Error('loop goal-setter requirements map .version must be 1');
  if (!Array.isArray(raw.goals)) throw new Error('loop goal-setter requirements map .goals must be an array');

  const seen = new Set<number>();
  const goals = raw.goals.map((item, index): LoopGoalSetterRequirementsMapEntry => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`goals[${index}] must be an object`);
    }
    const entry = item as Record<string, unknown>;
    const unknown = Object.keys(entry).filter((key) => key !== 'index' && key !== 'requirements');
    if (unknown.length > 0) throw new Error(`goals[${index}] has unknown keys: ${unknown.join(', ')}`);
    if (typeof entry.index !== 'number' || !Number.isInteger(entry.index) || entry.index < 0) {
      throw new Error(`goals[${index}].index must be a non-negative integer`);
    }
    if (seen.has(entry.index)) throw new Error(`duplicate loop goal-setter requirements index: ${entry.index}`);
    seen.add(entry.index);
    return { index: entry.index, requirements: parseRequirements(entry.requirements, `goals[${index}].requirements`, true) };
  });

  return { version: 1, goals };
}

export async function loadLoopGoalSetterRequirementsMap(deps: {
  path: string;
  cwd: string;
  forbiddenRoots?: readonly string[];
  readText: ReadText;
  realpath?: GoalSetterRequirementsRealPath;
}): Promise<LoadedLoopGoalSetterRequirementsMap> {
  const source = deps.path.trim();
  if (source === '') throw new Error('loop goal-setter requirements map path is blank');

  const canonPath = deps.realpath ? await deps.realpath(source) : resolve(source);
  if (canonPath === null) throw new Error(`loop goal-setter requirements map cannot be read: ${source}`);
  await assertOutsideForbiddenRoots(canonPath, deps.cwd, deps.forbiddenRoots, deps.realpath, 'loop goal-setter requirements map');

  const text = await deps.readText(canonPath);
  if (text === null) throw new Error(`loop goal-setter requirements map cannot be read: ${canonPath}`);
  const normalized = stripUtf8Bom(text);
  return { ...parseLoopGoalSetterRequirementsMap(normalized), path: canonPath, hash: hashRequirementText(normalized) };
}

export function buildLoopGoalSetterRequirementsPlan(input: {
  objectivesCount: number;
  map?: LoopGoalSetterRequirementsMap;
}): LoopGoalSetterRequirementsPlan {
  const pinnedByIndex = new Map<number, PinnedRequirement[]>();
  const routesByIndex = new Map<number, Map<string, GoalSetterRequirementRoute>>();
  const commandsByIndex = new Map<number, SandboxedRequirementCommand[]>();

  for (const goal of input.map?.goals ?? []) {
    if (goal.index >= input.objectivesCount) {
      throw new Error(`goal-setter requirements map index ${goal.index} is out of range for ${input.objectivesCount} objectives`);
    }
    const loaded = loadedFromPlan({ version: 1, requirements: goal.requirements });
    pinnedByIndex.set(goal.index, loaded.pinned);
    routesByIndex.set(goal.index, loaded.routes);
    commandsByIndex.set(goal.index, loaded.commands);
  }

  return { pinnedByIndex, routesByIndex, commandsByIndex, overrideCount: pinnedByIndex.size };
}

export function assertResumeGoalSetterRequirementsMatch(
  recorded: GoalSetterRequirementsReference | undefined,
  current: GoalSetterRequirementsReference | undefined,
): void {
  if (recorded === undefined && current === undefined) return;
  if (recorded === undefined) {
    throw new Error(
      `resume log is missing original goal-setter requirements reference; refusing current trusted requirements ${current?.path ?? '(none)'}`,
    );
  }
  if (current === undefined) {
    throw new Error(`resume requires the same trusted goal-setter requirements file: ${recorded.path}`);
  }
  if (current.path !== recorded.path) {
    throw new Error(`resume goal-setter requirements path ${current.path} does not match original path ${recorded.path}`);
  }
  if (current.hash !== recorded.hash) {
    throw new Error(`resume goal-setter requirements hash ${current.hash} does not match original hash ${recorded.hash}`);
  }
}

function loadedFromPlan(plan: GoalSetterRequirementsPlan): Omit<LoadedGoalSetterRequirements, 'path' | 'hash'> {
  const routes = new Map<string, GoalSetterRequirementRoute>();
  const commands: SandboxedRequirementCommand[] = [];
  for (const requirement of plan.requirements) {
    routes.set(requirement.id, requirement.route);
    if (requirement.route === 'sandbox-command') {
      commands.push({ requirementId: requirement.id, command: requirement.command ?? '' });
    }
  }
  return {
    version: 1,
    requirements: plan.requirements,
    pinned: plan.requirements.map((requirement) => ({ id: requirement.id, text: requirement.text })),
    routes,
    commands,
  };
}

function parseRequirements(value: unknown, label: string, requireNonEmpty: boolean): GoalSetterRequirement[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (requireNonEmpty && value.length === 0) throw new Error(`${label} must not be empty`);

  const seen = new Set<string>();
  return value.map((item, index): GoalSetterRequirement => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    const raw = item as Record<string, unknown>;
    const unknown = Object.keys(raw).filter((key) => key !== 'id' && key !== 'text' && key !== 'route' && key !== 'command');
    if (unknown.length > 0) throw new Error(`${label}[${index}] has unknown keys: ${unknown.join(', ')}`);

    const id = asNonEmptyString(raw.id, `${label}[${index}].id`);
    if (seen.has(id)) throw new Error(`duplicate goal-setter requirement id: ${id}`);
    seen.add(id);

    const text = asNonEmptyString(raw.text, `${label}[${index}].text`);
    const route = asRoute(raw.route, `${label}[${index}].route`);
    const command = raw.command === undefined ? undefined : asNonEmptyString(raw.command, `${label}[${index}].command`);

    if (route === 'sandbox-command') {
      if (command === undefined) throw new Error(`${label}[${index}].command is required for sandbox-command route`);
      const decision = validateSandboxInspectionCommand(command);
      if (!decision.ok) throw new Error(`${label}[${index}].command is outside sandbox inspection scope: ${decision.reason ?? 'not allowed'}`);
      return { id, text, route, command };
    }
    if (command !== undefined) throw new Error(`${label}[${index}].command is only allowed for sandbox-command route`);
    return { id, text, route };
  });
}

function hashRequirementText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${message(err)}`, { cause: err });
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return raw as Record<string, unknown>;
}

async function assertOutsideForbiddenRoots(
  canonPath: string,
  cwd: string,
  forbiddenRoots: readonly string[] | undefined,
  realpath: GoalSetterRequirementsRealPath | undefined,
  label: string,
): Promise<void> {
  const roots = forbiddenRoots && forbiddenRoots.length > 0 ? forbiddenRoots : [cwd];
  const canonRoots = await Promise.all(roots.map((root) => canonicalizeRoot(root, realpath)));
  if (canonRoots.some((root) => isInsideRoot(canonPath, root))) {
    throw new Error(`${label} is inside a forbidden working tree (${canonPath}); refusing repo-controlled goal-setter requirements`);
  }
}

async function canonicalizeRoot(path: string, realpath: GoalSetterRequirementsRealPath | undefined): Promise<string> {
  return (realpath ? await realpath(path) : null) ?? resolve(path);
}

function isInsideRoot(absPath: string, root: string): boolean {
  const rel = relative(root, absPath);
  return rel === '' || (!!rel && !rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\') && !/^[A-Za-z]:/.test(rel));
}

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
  return value;
}

function asRoute(value: unknown, label: string): GoalSetterRequirementRoute {
  if (value === 'sandbox-command' || value === 'llm' || value === 'human') return value;
  throw new Error(`${label} must be one of sandbox-command, llm, human`);
}

function stripUtf8Bom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
