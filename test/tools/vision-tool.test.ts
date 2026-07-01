import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVisionTool } from '../../src/core/tools/vision-tool.js';
import type { VisionComplete, VisionContentPart } from '../../src/core/model/vision.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'harness-vision-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A fake VLM call that records the parts it received and returns a canned answer. */
function fakeComplete(answer = 'OBJECTS:\ncat: [10, 20, 110, 220]\nANSWER: one cat at [10,20,110,220].'): {
  complete: VisionComplete;
  parts: () => VisionContentPart[] | undefined;
  calls: () => number;
} {
  let seen: VisionContentPart[] | undefined;
  let calls = 0;
  const complete: VisionComplete = async (parts) => {
    calls++;
    seen = parts;
    return answer;
  };
  return { complete, parts: () => seen, calls: () => calls };
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP_BYTES = Buffer.from('RIFFxxxxWEBP', 'ascii');
const GIF_BYTES = Buffer.from('GIF89a', 'ascii');
const BMP_BYTES = Buffer.from([0x42, 0x4d, 0x00, 0x00]);

describe('vision tool — happy path', () => {
  it('reads the image, sends the structured prompt + a data URL, and returns the VLM answer', async () => {
    await writeFile(join(dir, 'shot.png'), PNG_BYTES);
    const fake = fakeComplete();
    const tool = createVisionTool(fake.complete);

    const out = await tool.run({ image: 'shot.png', question: 'how many cats?' }, { cwd: dir });

    expect(out.error).toBeUndefined();
    expect(out.content).toContain('cat: [10, 20, 110, 220]');
    expect(fake.calls()).toBe(1);
    const parts = fake.parts()!;
    // part 0: the structured prompt + the question
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect((parts[0] as { text: string }).text).toContain('how many cats?');
    expect((parts[0] as { text: string }).text).toMatch(/bounding box|x_min/i); // the coordinate contract
    // part 1: the image as a base64 data URL with the right mime + the exact bytes
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BYTES.toString('base64')}` } });
  });

  it('sniffs the MIME from image bytes, not the extension', async () => {
    await writeFile(join(dir, 'mislabeled.png'), JPG_BYTES);
    const fake = fakeComplete();
    await createVisionTool(fake.complete).run({ image: 'mislabeled.png', question: 'q' }, { cwd: dir });
    const url = (fake.parts()![1] as { image_url: { url: string } }).image_url.url;
    expect(url.startsWith(`data:image/jpeg;base64,`)).toBe(true);
  });

  it('maps supported magic bytes to the right MIME', async () => {
    for (const [name, bytes, mime] of [
      ['a.jpg', JPG_BYTES, 'image/jpeg'],
      ['a.jpeg', JPG_BYTES, 'image/jpeg'],
      ['a.webp', WEBP_BYTES, 'image/webp'],
      ['a.gif', GIF_BYTES, 'image/gif'],
      ['a.bmp', BMP_BYTES, 'image/bmp'],
    ] as const) {
      await writeFile(join(dir, name), bytes);
      const fake = fakeComplete();
      await createVisionTool(fake.complete).run({ image: name, question: 'q' }, { cwd: dir });
      const url = (fake.parts()![1] as { image_url: { url: string } }).image_url.url;
      expect(url.startsWith(`data:${mime};base64,`)).toBe(true);
    }
  });

  it('returns a placeholder (not empty) when the VLM returns no text', async () => {
    await writeFile(join(dir, 'shot.png'), PNG_BYTES);
    const out = await createVisionTool(fakeComplete('').complete).run({ image: 'shot.png', question: 'q' }, { cwd: dir });
    expect(out.error).toBeUndefined();
    expect(out.content).toMatch(/no description/i);
  });
});

describe('vision tool — guards (the VLM is never called on a rejected input)', () => {
  it('rejects unsupported image bytes and never calls the VLM', async () => {
    await writeFile(join(dir, 'fake.png'), Buffer.from('not an image', 'utf8'));
    const fake = fakeComplete();
    const out = await createVisionTool(fake.complete).run({ image: 'fake.png', question: 'q' }, { cwd: dir });
    expect(out.error).toMatch(/Unsupported image type/);
    expect(fake.calls()).toBe(0);
  });

  it('rejects a path that escapes cwd (safeResolve) and never calls the VLM', async () => {
    const fake = fakeComplete();
    const out = await createVisionTool(fake.complete).run({ image: '../outside.png', question: 'q' }, { cwd: dir });
    expect(out.error).toMatch(/Cannot read image/);
    expect(fake.calls()).toBe(0);
  });

  it('reports a missing file as an error, not a crash', async () => {
    const fake = fakeComplete();
    const out = await createVisionTool(fake.complete).run({ image: 'gone.png', question: 'q' }, { cwd: dir });
    expect(out.error).toBeTruthy();
    expect(fake.calls()).toBe(0); // stat fails before the VLM call
  });

  it('surfaces a VLM error as a tool error (not a thrown turn)', async () => {
    await writeFile(join(dir, 'shot.png'), PNG_BYTES);
    const complete: VisionComplete = async () => {
      throw new Error('vision endpoint 503');
    };
    const out = await createVisionTool(complete).run({ image: 'shot.png', question: 'q' }, { cwd: dir });
    expect(out.error).toMatch(/Vision failed.*503/);
  });

  it('is a network tool (it sends the image out → gated as ask, not auto-allowed)', () => {
    expect(createVisionTool(vi.fn()).capability).toBe('network');
  });
});
