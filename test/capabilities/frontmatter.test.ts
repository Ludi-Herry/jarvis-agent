import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../../src/capabilities/skills/frontmatter.js';

describe('parseFrontmatter', () => {
  it('parses scalar keys and an inline array, and trims the body', () => {
    const doc = parseFrontmatter(
      ['---', 'name: git-commit', 'description: write a commit', 'triggers: [commit, 提交]', '---', '', 'Body here.', ''].join(
        '\n',
      ),
    );
    expect(doc.frontmatter.name).toBe('git-commit');
    expect(doc.frontmatter.description).toBe('write a commit');
    expect(doc.frontmatter.triggers).toEqual(['commit', '提交']);
    expect(doc.body).toBe('Body here.');
  });

  it('treats a document with no frontmatter as all body', () => {
    const doc = parseFrontmatter('# Just markdown\n\nno frontmatter');
    expect(doc.frontmatter).toEqual({});
    expect(doc.body).toBe('# Just markdown\n\nno frontmatter');
  });

  it('strips surrounding quotes from values', () => {
    const doc = parseFrontmatter(['---', 'name: "quoted"', "description: 'single'", '---', 'b'].join('\n'));
    expect(doc.frontmatter.name).toBe('quoted');
    expect(doc.frontmatter.description).toBe('single');
  });

  it('normalizes CRLF and yields an empty array for []', () => {
    const doc = parseFrontmatter('---\r\nname: x\r\ntriggers: []\r\n---\r\nbody\r\n');
    expect(doc.frontmatter.name).toBe('x');
    expect(doc.frontmatter.triggers).toEqual([]);
    expect(doc.body).toBe('body');
  });
});
