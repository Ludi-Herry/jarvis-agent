/**
 * capabilities layer — SkillRegistry (A5) · RuleResolver (B5) · SubagentManager (C) · Hooks (slice 1).
 *
 * A5 lands the SkillRegistry (skills/) — three-level progressive disclosure (plan §3.7).
 * B5 lands the RuleResolver (rules/) — three-layer rule merge feeding the gate (plan §3.6).
 * Hooks (hooks/) lands the tool-call PreToolUse/PostToolUse extension point feeding runAgent's seam.
 */
export { SkillRegistry, loadSkills, SKILL_REGISTRY_ADDENDUM_SOURCE } from './skills/skill-registry.js';
export type { Skill } from './skills/skill-registry.js';
export { parseFrontmatter } from './skills/frontmatter.js';
export type { ParsedDocument } from './skills/frontmatter.js';
export * from './rules/index.js';
export * from './subagents/index.js';
export * from './goal/index.js';
export * from './hooks/index.js';
export * from './eval/index.js';
export { ShadowGit, validateShadowRestorePath } from './shadow/shadow-git.js';
export type {
  CheckedRestorePrepareResult,
  CheckedRestorePreview,
  CheckedRestoreResult,
  ShadowGitDeps,
  SnapshotResult,
  RestoreResult,
} from './shadow/shadow-git.js';
