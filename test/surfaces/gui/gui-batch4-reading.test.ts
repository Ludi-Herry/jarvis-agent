import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultShellPath, runCommand } from '../../../src/core/index.js';
import type { ModelDelta, ModelProvider, ModelResult } from '../../../src/core/model/types.js';
import { GuiLiveError, GuiSessionHost, type GuiTaskDefinition } from '../../../src/surfaces/gui/live-session.js';
import { parseInline, parseMarkdown, type MdInline } from '../../../src/surfaces/gui/app/src/workbench/markdown-blocks.js';
import { buildApprovalPreview, WRITE_REPLACE_NOTE } from '../../../src/surfaces/gui/app/src/workbench/approval-diff.js';

function model(): ModelProvider {
  const provider: ModelProvider = {
    capability: { maxContextTokens: 100_000, maxOutputTokens: 16_384, thinking: false, toolUse: true, imageIn: false, videoIn: false },
    async *call(): AsyncGenerator<ModelDelta, ModelResult> {
      yield { type: 'text', text: '确定回复' };
      return { text: '确定回复', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'completed', rawFinishReason: 'stop' };
    },
    withThinking: () => provider,
    withMaxCompletionTokens: () => provider,
  };
  return provider;
}

function freeContract(cwd: string, patch: Partial<GuiTaskDefinition> = {}): GuiTaskDefinition {
  return {
    objective: '批四阅读试件：读取工作区文件', cwd,
    requirements: ['界面如实显示读取结果或失败原因'], writePaths: ['answer.mjs'],
    checkCommands: ['node --check answer.mjs'], maxRounds: 1, maxTurns: 6, wallClockMs: 30_000,
    ...patch,
  };
}

/** Git-initialized temp workspace so createTask's workspace gate passes (same as batch-2 tests). */
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), 'jarvis-gui-b4-test-'));
  await writeFile(join(cwd, 'seed.txt'), 'fixture baseline\n', 'utf8');
  await writeFile(join(cwd, '.gitignore'), 'data/\n', 'utf8');
  for (const command of ['git init -q', 'git add -- seed.txt .gitignore', 'git -c user.name=Fixture -c user.email=fixture@example.test commit -qm fixture']) {
    const result = await runCommand(defaultShellPath(), command, cwd, 15_000, 4000);
    expect(result.code, result.output).toBe(0);
  }
  return { cwd, dataDir: join(cwd, 'data') };
}

function freeHost(cwd: string): GuiSessionHost {
  return new GuiSessionHost({ cwd, dataDir: join(cwd, 'data'), provider: model(), modelName: 'deterministic-test' });
}

async function expectGuiError(promise: Promise<unknown>, status: number): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GuiLiveError);
    expect((error as GuiLiveError).status).toBe(status);
    return;
  }
  throw new Error(`expected GuiLiveError(${status})`);
}

function inlineTexts(inline: readonly MdInline[]): string {
  return inline.map((node) => {
    if (node.kind === 'bold' || node.kind === 'italic') return inlineTexts(node.inner);
    return node.text;
  }).join('');
}

describe('批4 markdown 解析（受限子集，纯函数）', () => {
  it('parses heading levels 1–4 and strips trailing # markers', () => {
    const blocks = parseMarkdown('# 一级标题\n\n### 三级标题 ###\n\n#### 四级\n');
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'heading', 'heading']);
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1 });
    expect(blocks[1]).toMatchObject({ kind: 'heading', level: 3 });
    expect(blocks[2]).toMatchObject({ kind: 'heading', level: 4 });
    if (blocks[0].kind === 'heading') expect(inlineTexts(blocks[0].inline)).toBe('一级标题');
    if (blocks[1].kind === 'heading') expect(inlineTexts(blocks[1].inline)).toBe('三级标题');
  });

  it('parses a fenced code block with language and keeps an unterminated fence honest', () => {
    expect(parseMarkdown('```js\nconst a = 1;\n```\n')).toEqual([{ kind: 'code', lang: 'js', code: 'const a = 1;' }]);
    expect(parseMarkdown('```\n甲\n乙')).toEqual([{ kind: 'code', lang: '', code: '甲\n乙' }]);
  });

  it('recognizes a pipe table only with a separator line; otherwise plain paragraphs', () => {
    const table = parseMarkdown('| 名称 | 值 |\n| --- | --- |\n| 甲 | 1 |\n');
    expect(table).toHaveLength(1);
    if (table[0].kind !== 'table') throw new Error('expected a table block');
    expect(table[0].header.map((cell) => inlineTexts(cell))).toEqual(['名称', '值']);
    expect(table[0].rows).toHaveLength(1);
    expect(table[0].rows[0].map((cell) => inlineTexts(cell))).toEqual(['甲', '1']);

    const paragraph = parseMarkdown('这行虽然有 | 竖线 |\n但没有分隔行\n');
    expect(paragraph).toHaveLength(1);
    expect(paragraph[0].kind).toBe('paragraph');
    if (paragraph[0].kind === 'paragraph') expect(inlineTexts(paragraph[0].inline)).toBe('这行虽然有 | 竖线 |\n但没有分隔行');
  });

  it('parses unordered and ordered list runs', () => {
    const ul = parseMarkdown('- 甲\n- 乙\n');
    expect(ul[0]).toMatchObject({ kind: 'list', ordered: false });
    if (ul[0].kind === 'list') expect(ul[0].items.map((item) => inlineTexts(item))).toEqual(['甲', '乙']);
    const ol = parseMarkdown('1. 一\n2. 二\n');
    expect(ol[0]).toMatchObject({ kind: 'list', ordered: true });
    if (ol[0].kind === 'list') expect(ol[0].items.map((item) => inlineTexts(item))).toEqual(['一', '二']);
  });

  it('parses blockquotes recursively so constructs nest inside', () => {
    const quote = parseMarkdown('> 引文一行\n> - 列表项\n');
    expect(quote).toHaveLength(1);
    if (quote[0].kind !== 'quote') throw new Error('expected a quote block');
    expect(quote[0].blocks.map((block) => block.kind)).toEqual(['paragraph', 'list']);
  });

  it('keeps inline precedence code > bold > italic > link', () => {
    const inline = parseInline('see `**not_bold**` then **bold `inner_code` here** and *italic [link](https://example.com)* end');
    // Code spans swallow the ** markers literally, so the intended bold around the code span
    // is broken by the code-first pass and no bold node may survive.
    expect(inline.find((node) => node.kind === 'code' && node.text === '**not_bold**')).toBeDefined();
    expect(inline.find((node) => node.kind === 'code' && node.text === 'inner_code')).toBeDefined();
    expect(inline.some((node) => node.kind === 'bold')).toBe(false);
    const italic = inline.find((node) => node.kind === 'italic');
    if (italic?.kind !== 'italic') throw new Error('expected an italic node');
    const link = italic.inner.find((node) => node.kind === 'link');
    expect(link).toMatchObject({ kind: 'link', text: 'link', href: 'https://example.com' });
    // Bold still wraps italic when no code span interferes.
    const wrapped = parseInline('**bold _em_**');
    const bold = wrapped.find((node) => node.kind === 'bold');
    if (bold?.kind !== 'bold') throw new Error('expected a bold node');
    expect(bold.inner.some((node) => node.kind === 'italic')).toBe(true);
  });

  it('renders a javascript: link as its literal markdown source, never as a link node', () => {
    expect(parseInline('[点我](javascript:alert(1))')).toEqual([{ kind: 'text', text: '[点我](javascript:alert(1))' }]);
    expect(parseInline('[好的](https://example.com)')).toEqual([{ kind: 'link', text: '好的', href: 'https://example.com' }]);
  });

  it('leaves raw HTML as literal text nodes (React escaping owns safety)', () => {
    expect(parseInline('<script>alert(1)</script>')).toEqual([{ kind: 'text', text: '<script>alert(1)</script>' }]);
  });

  it('does not italicize snake_case_words', () => {
    expect(parseInline('snake_case_italic')).toEqual([{ kind: 'text', text: 'snake_case_italic' }]);
  });
});

describe('批4 审批变更预览（纯函数）', () => {
  it('write + createOnly produces a /dev/null unified diff of all new lines', () => {
    const preview = buildApprovalPreview('write', JSON.stringify({ path: 'new-file.mjs', content: 'first\nsecond\n', createOnly: true }));
    if (preview?.kind !== 'write-create') throw new Error(`expected write-create, got ${JSON.stringify(preview)}`);
    expect(preview.path).toBe('new-file.mjs');
    expect(preview.diff).toContain('--- /dev/null');
    expect(preview.diff).toContain('+++ b/new-file.mjs');
    expect(preview.diff).toContain('@@ -0,0 +1,3 @@');
    expect(preview.diff).toContain('+first');
    expect(preview.diff).toContain('+second');
  });

  it('write + expectedVersion becomes a full-content replacement preview with the fixed honest note', () => {
    const preview = buildApprovalPreview('write', JSON.stringify({ path: 'answer.mjs', content: 'export const x = 1;\n', expectedVersion: 'v1-hash' }));
    expect(preview).toEqual({ kind: 'write-replace', path: 'answer.mjs', content: 'export const x = 1;\n', note: WRITE_REPLACE_NOTE });
    expect(WRITE_REPLACE_NOTE).toBe('替换后的完整内容；旧文本以工作区当前文件为准。此预览未执行，不代表已生效的改动。');
  });

  it('edit produces a single hunk carrying both -old and +new rows', () => {
    const preview = buildApprovalPreview('edit', JSON.stringify({ path: 'answer.mjs', oldText: 'keep\n旧行\nstay', newText: 'keep\n新行\nstay' }));
    if (preview?.kind !== 'edit') throw new Error(`expected edit, got ${JSON.stringify(preview)}`);
    expect(preview.diff).toContain('--- a/answer.mjs');
    expect(preview.diff).toContain('+++ b/answer.mjs');
    expect(preview.diff).toContain(' keep');
    expect(preview.diff).toContain('-旧行');
    expect(preview.diff).toContain('+新行');
    expect(preview.diff).not.toContain('-新行');
  });

  it('bash-like tools preview the raw command', () => {
    expect(buildApprovalPreview('bash', JSON.stringify({ command: 'npm run lint' })))
      .toEqual({ kind: 'command', command: 'npm run lint' });
    expect(buildApprovalPreview('sandboxed_exec', JSON.stringify({ command: 'node answer.mjs' })))
      .toEqual({ kind: 'command', command: 'node answer.mjs' });
  });

  it('malformed JSON, unknown tools and missing fields degrade to null', () => {
    expect(buildApprovalPreview('write', 'not json {')).toBeNull();
    expect(buildApprovalPreview('unknown_tool', JSON.stringify({ path: 'x' }))).toBeNull();
    expect(buildApprovalPreview('write', JSON.stringify({ path: 'x' }))).toBeNull(); // no content
    expect(buildApprovalPreview('bash', JSON.stringify({}))).toBeNull(); // no command
  });

  it('refuses to compute an LCS past 400 lines per side', () => {
    const oldText = Array.from({ length: 401 }, (_, index) => `old-${index}`).join('\n');
    const newText = Array.from({ length: 401 }, (_, index) => `new-${index}`).join('\n');
    expect(buildApprovalPreview('edit', JSON.stringify({ path: 'big.txt', oldText, newText }))).toBeNull();
  });
});

const PNG_1X1_GRAY = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==';

describe('批4 readFileView / openFileExternal（服务端边界）', () => {
  async function createdHost() {
    const { cwd } = await workspace();
    const host = freeHost(cwd);
    const created = await host.createTask(freeContract(cwd));
    return { cwd, host, id: created.id };
  }

  it('reads a small text file with content and truncated=false', async () => {
    const { cwd, host, id } = await createdHost();
    await writeFile(join(cwd, 'note.txt'), '第一行\n第二行\n', 'utf8');
    const view = await host.readFileView(id, 'note.txt');
    expect(view).toMatchObject({ path: 'note.txt', kind: 'text', content: '第一行\n第二行\n', truncated: false });
    expect(view.sizeBytes).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(view.at))).toBe(false);
  });

  it('truncates files past 200 KB and flags it honestly', async () => {
    const { cwd, host, id } = await createdHost();
    await writeFile(join(cwd, 'big.txt'), Buffer.alloc(210 * 1024, 0x61));
    const view = await host.readFileView(id, 'big.txt');
    expect(view.kind).toBe('text');
    expect(view.truncated).toBe(true);
    expect(Buffer.byteLength(view.content, 'utf8')).toBeLessThanOrEqual(200 * 1024);
    expect(view.sizeBytes).toBe(210 * 1024);
  });

  it('refuses a ../ escape with a live error', async () => {
    const { host, id } = await createdHost();
    await expectGuiError(host.readFileView(id, '../outside.txt'), 403);
  });

  it('refuses a sensitive path (.env) even inside the workspace', async () => {
    const { cwd, host, id } = await createdHost();
    await writeFile(join(cwd, '.env'), 'ARK_API_KEY=secret\n', 'utf8');
    await expectGuiError(host.readFileView(id, '.env'), 403);
  });

  it('reports directories with 404 不是文件或不存在', async () => {
    const { cwd, host, id } = await createdHost();
    await mkdir(join(cwd, 'sub'));
    await expectGuiError(host.readFileView(id, 'sub'), 404);
  });

  it('reports nonexistent files with 404', async () => {
    const { host, id } = await createdHost();
    await expectGuiError(host.readFileView(id, 'missing.txt'), 404);
  });

  it('rejects binary content containing NUL with 415', async () => {
    const { cwd, host, id } = await createdHost();
    await writeFile(join(cwd, 'blob.bin'), Buffer.from([0x41, 0x00, 0x42]));
    await expectGuiError(host.readFileView(id, 'blob.bin'), 415);
  });

  it('returns png files as base64 image views', async () => {
    const { cwd, host, id } = await createdHost();
    await writeFile(join(cwd, 'shot.png'), Buffer.from(PNG_1X1_GRAY, 'base64'));
    const view = await host.readFileView(id, 'shot.png');
    expect(view).toMatchObject({ path: 'shot.png', kind: 'image', mime: 'image/png', truncated: false });
    expect(view.content).toBe(PNG_1X1_GRAY);
  });

  it('openFileExternal keeps the same escape and existence boundaries', async () => {
    const { host, id } = await createdHost();
    await expectGuiError(host.openFileExternal(id, '../outside.txt'), 403);
    await expectGuiError(host.openFileExternal(id, 'missing.txt'), 404);
  });
});
