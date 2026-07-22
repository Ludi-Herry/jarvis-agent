/**
 * RuleResolver — parse and merge the trusted rule layers supplied by callers to the
 * PermissionGate (B5, plan §3.6). The CLI auto-loads two project layers:
 * project `AGENTS.md` → path-level `.rules/`, nearest wins. Global `~/AGENTS.md` remains
 * explicit so private cross-tool configuration never enters enforcement silently.
 *
 * Two deliberate boundaries:
 *  - **Markdown is soft.** A rule file's prose body is GUIDANCE (context for the model), never
 *    enforcement. Only its structured frontmatter `allow`/`deny` becomes gate rules — and even
 *    those are applied AFTER the built-in hard checks, so a rule can never unlock a secret path or
 *    a dangerous command (that invariant lives in decide.ts; see the B5 tests).
 *  - **Nearest wins.** Merged rules are ordered most-specific-first, so the gate's first-match
 *    (applyRules) naturally lets a path-level rule override a project one. Callers that explicitly
 *    supply a global layer keep it at the least-specific end.
 *
 * The frontmatter format (reusing A5's zero-dep parser):
 *   ---
 *   allow: [bash:npm test, bash:npm run *, read:*]
 *   deny:  [bash:git push *]
 *   import: ../shared/AGENTS.md      # optional, single linear @import (cycle-detected)
 *   ---
 *   <prose guidance, capped to a per-layer budget>
 *
 * I/O is injected (`readText`) so the merge logic stays pure and testable without touching the
 * real filesystem or the user's private ~/AGENTS.md.
 */
import { dirname, resolve } from 'node:path';
import type { PermissionRule } from '../../runtime/permission/index.js';
import { parseFrontmatter } from '../skills/frontmatter.js';

/** One layer's parsed contribution: structured rules + the (budgeted) prose guidance. */
export interface RuleLayer {
  rules: PermissionRule[];
  guidance: string;
}

/** The merged result handed to the gate (rules) and optionally the model (guidance). */
export interface ResolvedRules {
  /** Nearest-first, so the gate's first-match wins. */
  rules: PermissionRule[];
  /** Concatenated guidance, least-specific first (broad context, then local overrides). */
  guidance: string;
}

/** Default per-layer guidance budget (chars) so a sprawling AGENTS.md can't blow the context. */
const DEFAULT_GUIDANCE_BUDGET = 4_000;

/** Reads a file's text, or returns null if it doesn't exist / can't be read. */
export type ReadText = (path: string) => Promise<string | null>;

/** Parse one rule document's text into a {@link RuleLayer} (no imports resolved here). */
export function parseRuleDocument(text: string, guidanceBudget = DEFAULT_GUIDANCE_BUDGET): RuleLayer {
  const { frontmatter, body } = parseFrontmatter(text);
  const rules = [...toRules(frontmatter.allow, 'allow'), ...toRules(frontmatter.deny, 'deny')];
  const guidance = body.length > guidanceBudget ? body.slice(0, guidanceBudget) : body;
  return { rules, guidance };
}

/** Turn a frontmatter `allow`/`deny` value (`tool:pattern` strings) into rules. A bare entry with
 *  no colon is treated as a tool name matching any subject (`bash` ≡ `bash:*`). */
function toRules(value: string | string[] | undefined, action: 'allow' | 'deny'): PermissionRule[] {
  const entries = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return entries
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const colon = entry.indexOf(':');
      const tool = colon === -1 ? entry : entry.slice(0, colon).trim();
      const pattern = colon === -1 ? '*' : entry.slice(colon + 1).trim() || '*';
      return { action, tool, pattern };
    });
}

/**
 * Resolve one file and its single linear `@import` chain into a layer. Within a layer the imported
 * (base) rules are LESS specific than the importing file's own, so own rules come first
 * (nearest-first). Cycles throw — `@import` is single-source and acyclic by contract.
 */
export async function resolveImports(path: string, readText: ReadText, guidanceBudget = DEFAULT_GUIDANCE_BUDGET): Promise<RuleLayer> {
  return resolveChain(resolve(path), readText, guidanceBudget, new Set());
}

async function resolveChain(absPath: string, readText: ReadText, budget: number, seen: Set<string>): Promise<RuleLayer> {
  if (seen.has(absPath)) {
    throw new Error(`@import cycle detected at ${absPath}`);
  }
  seen.add(absPath);

  const text = await readText(absPath);
  if (text === null) return { rules: [], guidance: '' };

  const { frontmatter } = parseFrontmatter(text);
  const own = parseRuleDocument(text, budget);

  const importValue = frontmatter.import;
  const importPath = Array.isArray(importValue) ? importValue[0] : importValue;
  if (importPath === undefined || importPath.trim() === '') return own;

  const base = await resolveChain(resolve(dirname(absPath), importPath.trim()), readText, budget, seen);
  // own (importing file) is MORE specific than its import → own rules first.
  return {
    rules: [...own.rules, ...base.rules],
    guidance: [base.guidance, own.guidance].filter((g) => g !== '').join('\n\n'),
  };
}

/**
 * Load the ordered layer sources (least specific FIRST: global, project, path) and merge them.
 * Each source is import-resolved independently, then layers are combined nearest-first.
 */
export async function loadRuleLayers(paths: string[], readText: ReadText, guidanceBudget = DEFAULT_GUIDANCE_BUDGET): Promise<ResolvedRules> {
  const layers: RuleLayer[] = [];
  for (const path of paths) {
    layers.push(await resolveImports(path, readText, guidanceBudget));
  }
  return mergeRules(layers);
}

/**
 * Merge layers given LEAST-specific first (global → project → path). The result's `rules` are
 * NEAREST-FIRST (path layer's rules before project's before global's), so the gate's first-match
 * gives path > project > global. Guidance is concatenated least-specific first (broad context
 * then local). Pure — no I/O.
 */
export function mergeRules(layers: RuleLayer[]): ResolvedRules {
  const rules: PermissionRule[] = [];
  for (let i = layers.length - 1; i >= 0; i--) rules.push(...layers[i].rules); // reverse → nearest first
  const guidance = layers
    .map((l) => l.guidance)
    .filter((g) => g !== '')
    .join('\n\n');
  return { rules, guidance };
}
