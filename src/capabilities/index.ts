/**
 * capabilities layer — SkillRegistry (A5) · RuleResolver (B5); SubagentManager · Hooks (later).
 *
 * A5 lands the SkillRegistry (skills/) — three-level progressive disclosure (plan §3.7).
 * B5 lands the RuleResolver (rules/) — three-layer rule merge feeding the gate (plan §3.6).
 */
export { SkillRegistry, loadSkills } from './skills/skill-registry.js';
export type { Skill } from './skills/skill-registry.js';
export { parseFrontmatter } from './skills/frontmatter.js';
export type { ParsedDocument } from './skills/frontmatter.js';
export * from './rules/index.js';
