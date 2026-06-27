/**
 * Pure zod → OpenAI-compatible tool-parameters conversion (kimi-code gotcha, knowledge
 * base Part8 §3.3).
 *
 * WHY this exists: strict OpenAI-compatible endpoints — Moonshot, and very likely
 * Doubao/ARK — REJECT JSON Schema that carries `$defs`/`$ref`; they don't resolve
 * internal refs. So we can't hand the model whatever a zod→JSON-Schema conversion
 * emits. We normalize:
 *   1. inline every `$ref` into its `$defs` definition (deref), dropping `$defs`
 *   2. drop the top-level `$schema` dialect marker (noise the model doesn't need)
 *   3. ensure the root carries a `type` (strict endpoints want it)
 *
 * zod v4's `z.toJSONSchema` already inlines reused NON-recursive subschemas (verified),
 * so in practice `$defs` only shows up for recursive schemas — which tool inputs never
 * are. We still deref defensively: the contract is "no `$defs`/`$ref`/`$schema` ever
 * reaches the wire", and the test asserts exactly that, independent of zod's current
 * behavior. Kept pure (no I/O, no mutation of inputs) so it carries single-test coverage.
 */
import { z } from 'zod';
import type { ZodType } from 'zod';

/** Convert a zod schema into the normalized JSON Schema `parameters` object the model
 *  sees. The single entry point built-in tools use via the registry. */
export function zodToParameters(schema: ZodType): Record<string, unknown> {
  return normalizeJsonSchema(z.toJSONSchema(schema) as Record<string, unknown>);
}

/** Normalize an already-built JSON Schema: deref `$ref`/`$defs`, strip `$schema`, and
 *  guarantee a root `type`. Separated from {@link zodToParameters} so the deref logic
 *  can be tested directly against a hand-built `$defs` schema (the exact shape a strict
 *  endpoint would reject), not just whatever zod happens to emit today. */
export function normalizeJsonSchema(raw: Record<string, unknown>): Record<string, unknown> {
  const defs = (raw.$defs as Record<string, unknown> | undefined) ?? {};
  const inlined = derefNode(raw, defs, new Set<string>()) as Record<string, unknown>;
  if (typeof inlined.type !== 'string') {
    inlined.type = 'object';
  }
  return inlined;
}

/**
 * Recursively rebuild a schema node with every `$ref` inlined and all `$defs`/`$schema`
 * bookkeeping keys dropped. `inlining` tracks the refs currently being expanded so a
 * recursive schema degrades to a bare `{type:'object'}` instead of looping forever
 * (tool inputs are never recursive — this is just a guard that the test exercises).
 */
function derefNode(node: unknown, defs: Record<string, unknown>, inlining: Set<string>): unknown {
  if (Array.isArray(node)) {
    return node.map((n) => derefNode(n, defs, inlining));
  }
  if (node === null || typeof node !== 'object') {
    return node;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === 'string') {
    const name = refName(obj.$ref);
    if (name === undefined || inlining.has(name) || !(name in defs)) {
      return { type: 'object' }; // unresolvable or cyclic → safe degrade
    }
    inlining.add(name);
    const resolved = derefNode(defs[name], defs, inlining);
    inlining.delete(name);
    return resolved;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === '$defs' || key === '$schema') continue; // drop bookkeeping at any depth
    out[key] = derefNode(value, defs, inlining);
  }
  return out;
}

/** Extract `Name` from a `#/$defs/Name` JSON-pointer ref; undefined if it's some other
 *  ref shape we don't inline (degrades safely in the caller). */
function refName(ref: string): string | undefined {
  const match = /^#\/\$defs\/(.+)$/.exec(ref);
  return match ? match[1] : undefined;
}
