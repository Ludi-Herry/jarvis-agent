/**
 * roster — the agent role registry (Phase C, plan §C1; blueprint §4 role registry).
 *
 * A role is a named, reusable subagent definition: who it is (`systemPrompt`), what the main agent
 * routes on (`description`), which model/effort it prefers, and the UPPER BOUND of what it may
 * touch (`capability`/`tools`) — narrowed against the parent at spawn time by derive.ts, never
 * widened.
 *
 * Two axes share this one shape (memory c-phase-agent-roster-two-axes): a capability-dispatch
 * EXPERT is a single role with a model + capability; a review PANEL is N roles with the same
 * read-only capability and different `systemPrompt`s (perspectives). The six-hats panel ships as
 * preset data (panel.ts), NOT hardcoded here — the harness stays general.
 *
 * `loadRoster` mirrors `loadSkills` (skill-registry.ts): scan `<dir>/<role>/ROLE.md`, parse the
 * frontmatter + markdown body. A missing dir yields `[]` (no roster is not an error).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFrontmatter } from '../skills/frontmatter.js';
import type { ToolCapability } from '../../core/tools/types.js';
import type { ThinkingEffort } from '../../core/model/types.js';

/** Whether a role's subagent may write/run (shared-cwd, serial) or is read-only (parallel-safe). */
export type Isolation = 'read-only' | 'shared-cwd';

export interface AgentRole {
  name: string;
  /** One line the main agent routes on — WHEN to delegate to this role. */
  description: string;
  /** The role's system prompt (the ROLE.md body) — its persona / instructions. */
  systemPrompt: string;
  /** Preferred model id (metadata; C3 falls back to the parent provider until a 2nd endpoint exists). */
  model?: string;
  reasoningEffort?: ThinkingEffort;
  /** Requested capability ceiling — intersected with the parent at spawn (derive.ts). */
  capability?: ToolCapability[];
  /** Requested tool-name subset — intersected with the parent at spawn. */
  tools?: string[];
  /** read-only (default) shares nothing and is parallel-safe; shared-cwd may write and runs serially. */
  isolation?: Isolation;
  /** Requested turn budget (narrowed strictly smaller than the parent at spawn). */
  maxTurns?: number;
  /** Requested nesting depth (narrowed to min(requested, parent−1) at spawn). */
  maxDepth?: number;
}

const TOOL_CAPABILITIES: readonly ToolCapability[] = [
  'read-only',
  'writes-files',
  'executes-code',
  'network',
];
const THINKING_EFFORTS: readonly ThinkingEffort[] = ['off', 'low', 'medium', 'high'];
const ISOLATIONS: readonly Isolation[] = ['read-only', 'shared-cwd'];

/** Scan `dir` for `<dir>/<role>/ROLE.md` and parse each into an {@link AgentRole}. A missing
 *  directory yields `[]`; a folder without a ROLE.md is skipped. Sorted by folder name so the
 *  roster order is stable across runs (readdir order is filesystem-dependent). */
export async function loadRoster(dir: string): Promise<AgentRole[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const roles: AgentRole[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const text = await readFile(join(dir, entry.name, 'ROLE.md'), 'utf8').catch(() => null);
    if (text === null) continue;
    const { frontmatter, body } = parseFrontmatter(text);
    roles.push(toRole(frontmatter, body, entry.name));
  }
  return roles;
}

/** The L1 catalog of roles the main agent can delegate to — `name: description` per line. `''`
 *  when the roster is empty, so callers can fold it into a tool description unconditionally. */
export function rosterCatalog(roles: readonly AgentRole[]): string {
  return roles.map((r) => `- ${r.name}: ${r.description}`).join('\n');
}

/** The role with this exact name, or `undefined`. */
export function findRole(roles: readonly AgentRole[], name: string): AgentRole | undefined {
  return roles.find((r) => r.name === name);
}

/** Build a role from parsed frontmatter, dropping invalid enum values (a bad `capability`/`effort`/
 *  `isolation` is ignored rather than trusted) and coercing `maxTurns`/`maxDepth` to positive ints.
 *  Optional fields are omitted when absent/invalid so `derive.ts` sees a clean `undefined`. */
function toRole(
  fm: Record<string, string | string[]>,
  body: string,
  folderName: string,
): AgentRole {
  const role: AgentRole = {
    name: asString(fm.name) || folderName,
    description: asString(fm.description),
    systemPrompt: body,
  };

  const model = asString(fm.model);
  if (model) role.model = model;

  const effort = asString(fm.reasoningEffort);
  if (isThinkingEffort(effort)) role.reasoningEffort = effort;

  const caps = asArray(fm.capability).filter(isToolCapability);
  if (caps.length > 0) role.capability = caps;

  const tools = asArray(fm.tools);
  if (tools.length > 0) role.tools = tools;

  const iso = asString(fm.isolation);
  if (isIsolation(iso)) role.isolation = iso;

  const maxTurns = toPositiveInt(asString(fm.maxTurns));
  if (maxTurns !== undefined) role.maxTurns = maxTurns;

  const maxDepth = toPositiveInt(asString(fm.maxDepth));
  if (maxDepth !== undefined) role.maxDepth = maxDepth;

  return role;
}

function isToolCapability(s: string): s is ToolCapability {
  return (TOOL_CAPABILITIES as readonly string[]).includes(s);
}
function isThinkingEffort(s: string): s is ThinkingEffort {
  return (THINKING_EFFORTS as readonly string[]).includes(s);
}
function isIsolation(s: string): s is Isolation {
  return (ISOLATIONS as readonly string[]).includes(s);
}

function toPositiveInt(s: string): number | undefined {
  if (s === '') return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function asString(v: string | string[] | undefined): string {
  return typeof v === 'string' ? v : '';
}

function asArray(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v;
  return typeof v === 'string' && v !== '' ? [v] : [];
}
