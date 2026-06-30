import { describe, expect, it } from 'vitest';
import type OpenAI from 'openai';
import { buildVisionParts, createVisionComplete, VISION_PROMPT } from '../../src/core/model/vision.js';
import { resolveVisionConfig } from '../../src/core/model/config.js';
import type { DoubaoConfig } from '../../src/core/model/types.js';

/** A fake OpenAI client whose completion call throws — to exercise the error path without a network. */
function throwingClient(err: unknown): OpenAI {
  return { chat: { completions: { create: async () => { throw err; } } } } as unknown as OpenAI;
}

const builder: DoubaoConfig = { provider: 'doubao', apiKey: 'secret-key', baseURL: 'https://ark.example/api', model: 'doubao-text-pro' };

describe('resolveVisionConfig', () => {
  it('is disabled when ARK_VISION_MODEL is unset', () => {
    const r = resolveVisionConfig({}, builder);
    expect(r.enabled).toBe(false);
    if (!r.enabled) expect(r.reason).toMatch(/ARK_VISION_MODEL/);
  });

  it('reuses the builder key/baseURL with the vision model when set', () => {
    const r = resolveVisionConfig({ ARK_VISION_MODEL: 'doubao-vision-pro' }, builder);
    expect(r.enabled).toBe(true);
    if (r.enabled) {
      expect(r.config).toEqual({ ...builder, model: 'doubao-vision-pro' });
    }
  });

  it('trims whitespace and treats a blank value as unset', () => {
    expect(resolveVisionConfig({ ARK_VISION_MODEL: '   ' }, builder).enabled).toBe(false);
    const r = resolveVisionConfig({ ARK_VISION_MODEL: '  doubao-vision  ' }, builder);
    expect(r.enabled && r.config.model).toBe('doubao-vision');
  });
});

describe('buildVisionParts', () => {
  it('emits a structured-prompt text part with the question, then the image as a data URL', () => {
    const parts = buildVisionParts('data:image/png;base64,AAAA', 'what is here?');
    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe('text');
    expect((parts[0] as { text: string }).text).toContain('what is here?');
    expect((parts[0] as { text: string }).text).toContain(VISION_PROMPT);
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
  });
});

describe('VISION_PROMPT — the coordinate-anchoring contract (load-bearing)', () => {
  it('demands bounding boxes and forbids vague prose directions', () => {
    expect(VISION_PROMPT).toMatch(/x_min.*y_min.*x_max.*y_max/);
    expect(VISION_PROMPT).toMatch(/STRUCTURED/);
    expect(VISION_PROMPT.toLowerCase()).toContain('on the left'); // the explicit "never say ..." example
  });
});

describe('createVisionComplete — error redaction (a model-facing channel must not re-leak)', () => {
  it('routes a VLM error through describeModelError so an echoed key / data URL is redacted', async () => {
    const complete = createVisionComplete(
      builder,
      throwingClient({ status: 400, message: 'reflected Authorization: Bearer sk-LEAK1234567890 and data:image/png;base64,AAAABBBBCCCC back' }),
    );
    let caught: Error | undefined;
    try {
      await complete([{ type: 'text', text: 'x' }]);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    const msg = caught!.message;
    expect(msg).not.toContain('sk-LEAK1234567890');
    expect(msg).not.toContain('AAAABBBBCCCC');
    expect(msg).toContain('sk-***');
    expect(msg).toContain('data:[redacted base64]');
  });

  it('rethrows a deliberate abort as-is (a cancel is not a failure to wrap)', async () => {
    const ac = new AbortController();
    ac.abort();
    const complete = createVisionComplete(builder, throwingClient(new Error('aborted raw')));
    await expect(complete([{ type: 'text', text: 'x' }], ac.signal)).rejects.toThrow('aborted raw');
  });
});
