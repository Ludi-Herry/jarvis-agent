/**
 * rules barrel — public face of `src/capabilities/rules` (B5, plan §3.6).
 *
 * The composition root builds the gate's policy from {@link loadRuleLayers}; the pure
 * {@link mergeRules} / {@link parseRuleDocument} stay exported for direct testing.
 */
export {
  loadRuleLayers,
  mergeRules,
  parseRuleDocument,
  resolveImports,
  type RuleLayer,
  type ResolvedRules,
  type ReadText,
} from './rule-resolver.js';
