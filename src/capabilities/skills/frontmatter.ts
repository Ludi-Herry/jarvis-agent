/**
 * Minimal YAML-frontmatter parser — pure, no dependency.
 *
 * SKILL.md files lead with a `--- … ---` block of `key: value` lines, then a markdown body.
 * We only need scalars (`name`, `description`) and inline arrays (`triggers: [a, b]`), so a
 * full YAML library would be dead weight (AGENTS.md: no abstraction the task hasn't proven).
 * Anything richer than `key: scalar` / `key: [list]` is out of scope by design.
 */

export interface ParsedDocument {
  frontmatter: Record<string, string | string[]>;
  body: string;
}

/** Split a document into its frontmatter map and body. A document with no leading `---`
 *  block parses to an empty map and the whole text as body. */
export function parseFrontmatter(text: string): ParsedDocument {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) return { frontmatter: {}, body: normalized.trim() };

  const [, block, body] = match;
  const frontmatter: Record<string, string | string[]> = {};
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    if (key === '') continue;
    frontmatter[key] = parseValue(trimmed.slice(colon + 1).trim());
  }
  return { frontmatter, body: body.trim() };
}

function parseValue(raw: string): string | string[] {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (inner === '') return [];
    return inner
      .split(',')
      .map((s) => stripQuotes(s.trim()))
      .filter((s) => s !== '');
  }
  return stripQuotes(raw);
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}
