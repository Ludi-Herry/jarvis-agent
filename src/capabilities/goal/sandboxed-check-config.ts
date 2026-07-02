import { isAbsolute, relative, resolve } from 'node:path';
import type { ReadText } from '../rules/index.js';
import type { PinnedRequirement } from './goal.js';
import { validateSandboxInspectionCommand } from '../../core/tools/sandboxed-inspection-command.js';

export type SandboxedCheckRealPath = (path: string) => Promise<string | null>;

export interface SandboxedCheckPlanRequirement {
  readonly id: string;
  readonly text: string;
  readonly command?: string;
}

export interface SandboxedCheckPlan {
  readonly requirements: SandboxedCheckPlanRequirement[];
}

export interface SandboxedRequirementCommand {
  readonly requirementId: string;
  readonly command: string;
}

export interface LoadedSandboxedCheckPlan {
  readonly path: string;
  readonly pinned: PinnedRequirement[];
  readonly commands: SandboxedRequirementCommand[];
}

export function parseSandboxedCheckPlan(text: string): SandboxedCheckPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(stripUtf8Bom(text));
  } catch (err) {
    throw new Error(`sandbox check plan is not valid JSON: ${message(err)}`, { cause: err });
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('sandbox check plan must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;
  const unknownTop = Object.keys(obj).filter((key) => key !== 'requirements');
  if (unknownTop.length > 0) throw new Error(`unknown sandbox check plan keys: ${unknownTop.join(', ')}`);
  if (!Array.isArray(obj.requirements)) throw new Error('sandbox check plan .requirements must be an array');
  if (obj.requirements.length === 0) throw new Error('sandbox check plan .requirements must not be empty');

  const seen = new Set<string>();
  const requirements = obj.requirements.map((item, index): SandboxedCheckPlanRequirement => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`requirements[${index}] must be an object`);
    }
    const req = item as Record<string, unknown>;
    const unknown = Object.keys(req).filter((key) => key !== 'id' && key !== 'text' && key !== 'command');
    if (unknown.length > 0) throw new Error(`requirements[${index}] has unknown keys: ${unknown.join(', ')}`);

    const id = asNonEmptyString(req.id, `requirements[${index}].id`);
    if (seen.has(id)) throw new Error(`duplicate sandbox check requirement id: ${id}`);
    seen.add(id);

    const textValue = asNonEmptyString(req.text, `requirements[${index}].text`);
    const command = req.command === undefined ? undefined : asNonEmptyString(req.command, `requirements[${index}].command`);
    if (command !== undefined) {
      const decision = validateSandboxInspectionCommand(command);
      if (!decision.ok) throw new Error(`requirements[${index}].command is outside sandbox inspection scope: ${decision.reason ?? 'not allowed'}`);
    }
    return command === undefined ? { id, text: textValue } : { id, text: textValue, command };
  });

  return { requirements };
}

export async function loadSandboxedCheckPlan(deps: {
  path: string;
  cwd: string;
  forbiddenRoots?: readonly string[];
  readText: ReadText;
  realpath?: SandboxedCheckRealPath;
}): Promise<LoadedSandboxedCheckPlan> {
  const source = deps.path.trim();
  if (source === '') throw new Error('sandbox check plan path is blank');

  const canonPath = deps.realpath ? await deps.realpath(source) : resolve(source);
  if (canonPath === null) throw new Error(`sandbox check plan cannot be read: ${source}`);
  const roots = deps.forbiddenRoots && deps.forbiddenRoots.length > 0 ? deps.forbiddenRoots : [deps.cwd];
  const canonRoots = await Promise.all(roots.map((root) => canonicalizeRoot(root, deps.realpath)));
  if (canonRoots.some((root) => isInsideRoot(canonPath, root))) {
    throw new Error(`sandbox check plan is inside a forbidden working tree (${canonPath}); refusing repo-controlled sandbox check config`);
  }

  const text = await deps.readText(canonPath);
  if (text === null) throw new Error(`sandbox check plan cannot be read: ${canonPath}`);
  const plan = parseSandboxedCheckPlan(text);
  return {
    path: canonPath,
    pinned: plan.requirements.map((requirement) => ({ id: requirement.id, text: requirement.text })),
    commands: plan.requirements
      .filter((requirement): requirement is SandboxedCheckPlanRequirement & { command: string } => requirement.command !== undefined)
      .map((requirement) => ({ requirementId: requirement.id, command: requirement.command })),
  };
}

async function canonicalizeRoot(path: string, realpath: SandboxedCheckRealPath | undefined): Promise<string> {
  return (realpath ? await realpath(path) : null) ?? resolve(path);
}

function isInsideRoot(absPath: string, root: string): boolean {
  const rel = relative(resolve(root), absPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function stripUtf8Bom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
