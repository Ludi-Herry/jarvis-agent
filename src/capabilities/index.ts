/**
 * capabilities layer — SkillRegistry (A5); SubagentManager · Hooks · RuleResolver (later).
 *
 * A5 lands the SkillRegistry (skills/) — three-level progressive disclosure (plan §3.7).
 */
export { SkillRegistry, loadSkills } from './skills/skill-registry.js';
export type { Skill } from './skills/skill-registry.js';
export { parseFrontmatter } from './skills/frontmatter.js';
export type { ParsedDocument } from './skills/frontmatter.js';
