/**
 * Batch 4 §阅读: a small, safe Markdown subset for live message text. Pure and deterministic —
 * no HTML interpretation (a `<tag>` stays literal text; React escaping keeps the output safe),
 * no entity folding, no side effects. Correctness of the supported subset beats completeness.
 */

export type MdBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; inline: MdInline[] }
  | { kind: 'paragraph'; inline: MdInline[] }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'quote'; blocks: MdBlock[] }
  | { kind: 'list'; ordered: boolean; items: MdInline[][] }
  | { kind: 'table'; header: MdInline[][]; rows: MdInline[][][] }
  | { kind: 'rule' };

export type MdInline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; inner: MdInline[] }
  | { kind: 'italic'; inner: MdInline[] }
  | { kind: 'link'; text: string; href: string }; // href already sanitized

/** One URL split as the full match plus its capture spans (see LINK_PATTERN below). */
interface SplitPart {
  readonly raw: string;
  readonly groups: readonly (string | undefined)[];
}

function pushText(out: MdInline[], text: string): void {
  if (text === '') return;
  const last = out[out.length - 1];
  if (last?.kind === 'text') last.text += text;
  else out.push({ kind: 'text', text });
}

function safeHref(url: string): string | null {
  const trimmed = url.trim();
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/u.exec(trimmed);
  if (match === null) return null; // relative/bare or scheme-less URLs stay literal text too
  return ['https', 'http', 'mailto'].includes(match[1].toLowerCase()) ? trimmed : null;
}

/** Scan `input` with `pattern` (global, one capturing group per token) and return either the
 *  literal text between matches or the match spans, in order. */
function splitBy(input: string, pattern: RegExp): (string | SplitPart)[] {
  const out: (string | SplitPart)[] = [];
  let last = 0;
  for (const match of input.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) out.push(input.slice(last, index));
    out.push({ raw: match[0], groups: match.slice(1) });
    last = index + match[0].length;
  }
  if (last < input.length) out.push(input.slice(last));
  return out;
}

const LINK_PATTERN = /\[([^\]\n]*)\]\(([^)\s]*)\)/gu;
const BOLD_PATTERN = /\*\*([^*\n]+)\*\*/gu;
const ITALIC_PATTERN = /(^|[^\w])(?:\*([^*\n]+)\*|_([^_\n]+)_)(?![\w])/gu;

function fromLinks(parts: (string | SplitPart)[]): MdInline[] {
  const out: MdInline[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      pushText(out, part);
      continue;
    }
    const [text, url] = part.groups;
    const href = url !== undefined ? safeHref(url) : null;
    // A disallowed/relative href degrades to the literal markdown source, never to a node with an unsafe target.
    if (href === null || text === undefined) pushText(out, part.raw);
    else out.push({ kind: 'link', text, href });
  }
  return out;
}

function fromItalic(parts: (string | SplitPart)[]): MdInline[] {
  const out: MdInline[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      out.push(...fromLinks(splitBy(part, LINK_PATTERN)));
      continue;
    }
    const [lead, star, under] = part.groups;
    const inner = star ?? under ?? '';
    if (lead !== undefined && lead !== '') out.push(...fromLinks(splitBy(lead, LINK_PATTERN)));
    out.push({ kind: 'italic', inner: fromLinks(splitBy(inner, LINK_PATTERN)) });
  }
  return out;
}

function fromBold(parts: (string | SplitPart)[]): MdInline[] {
  const out: MdInline[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      out.push(...fromItalic(splitBy(part, ITALIC_PATTERN)));
      continue;
    }
    const inner = part.groups[0] ?? '';
    out.push({ kind: 'bold', inner: fromItalic(splitBy(inner, ITALIC_PATTERN)) });
  }
  return out;
}

/** Inline parsing precedence: `code` spans first (no nesting), then **bold**, then *italic* /
 *  _italic_ (word-boundary guarded so snake_case stays code-like text), then [text](url). */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  for (const part of splitBy(text, /`([^`\n]+)`/gu)) {
    if (typeof part === 'string') {
      out.push(...fromBold(splitBy(part, BOLD_PATTERN)));
    } else {
      out.push({ kind: 'code', text: part.groups[0] ?? '' });
    }
  }
  return out;
}

/** Split a pipe-table line into trimmed cells; one optional leading and trailing pipe are dropped. */
function tableCells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  return body.split('|').map((cell) => cell.trim());
}

/** A table separator row: every cell is only dashes/colons, at least one dash, ≥2 cells. */
function isTableSeparator(line: string): boolean {
  const cells = tableCells(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{1,}:?$/u.test(cell));
}

function isTableHeader(line: string): boolean {
  return line.trim() !== '' && tableCells(line).length >= 2;
}

export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: 'paragraph', inline: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];

    const fence = /^\s*```\s*([^\s`]*)\s*$/u.exec(line);
    if (fence !== null) {
      flushParagraph();
      const codeLines: string[] = [];
      index += 1;
      // An unterminated fence honestly keeps the rest of the text as code content.
      while (index < lines.length && !/^\s*```\s*$/u.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1; // consume the closing fence
      blocks.push({ kind: 'code', lang: fence[1] ?? '', code: codeLines.join('\n') });
      continue;
    }

    if (/^\s*(?:\*\s*\*\s*\*|-\s*-\s*-)\s*$/u.test(line) && line.trim() !== '') {
      flushParagraph();
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    const heading = /^\s*(#{1,4})\s+(.*?)\s*$/u.exec(line);
    if (heading !== null) {
      flushParagraph();
      blocks.push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3 | 4, inline: parseInline(heading[2].replace(/\s*#+\s*$/u, '')) });
      index += 1;
      continue;
    }

    if (/^\s*>/u.test(line)) {
      flushParagraph();
      const inner: string[] = [];
      while (index < lines.length && /^\s*>/u.test(lines[index])) {
        inner.push(lines[index].replace(/^\s*>[ \t]?/u, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', blocks: parseMarkdown(inner.join('\n')) });
      continue;
    }

    const plainItem = /^(\s*)([-*]|\d+\.)\s+(.*)$/u.exec(line);
    if (plainItem !== null) {
      flushParagraph();
      const ordered = /^\d/u.test(plainItem[2]);
      const indent = plainItem[1].length;
      const items: string[] = [plainItem[3]];
      index += 1;
      for (;;) {
        const next = index < lines.length ? /^(\s*)([-*]|\d+\.)\s+(.*)$/u.exec(lines[index]) : null;
        if (next === null || next[1].length !== indent || /^\d/u.test(next[2]) !== ordered) break;
        items.push(next[3]);
        index += 1;
      }
      blocks.push({ kind: 'list', ordered, items: items.map((item) => parseInline(item)) });
      continue;
    }

    if (isTableHeader(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      flushParagraph();
      const header = tableCells(line);
      const body: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim() !== '' && isTableHeader(lines[index])) {
        body.push(tableCells(lines[index]));
        index += 1;
      }
      blocks.push({ kind: 'table', header: header.map((cell) => parseInline(cell)), rows: body.map((row) => row.map((cell) => parseInline(cell))) });
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      index += 1;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  return blocks;
}
