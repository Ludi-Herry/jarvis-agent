/**
 * vision tool — the agent's "eyes" (Phase E multimodal, first slice).
 *
 * A READ-ONLY tool that takes an image PATH + a question, delegates to a VLM (model/vision.ts), and
 * returns the VLM's STRUCTURED, coordinate-anchored description as text the text model reasons over.
 * The main conversation stays text-only; this is the heterogeneous-delegation seam (project memory
 * openhanako-outer-vision-multimodal).
 *
 * Path handling mirrors the read tool: {@link safeResolve} confines the image to cwd and rejects a
 * symlink that escapes it or lands on a secret. Registered ONLY when a vision model is configured
 * (ARK_VISION_MODEL → resolveVisionConfig), like bash is registered only behind a gate.
 *
 * Capability is `network`, NOT `read-only`: the tool reads a local file AND SENDS IT to a remote VLM
 * endpoint. That outbound egress of local data is the stricter effect (read + network → the gate takes
 * the stricter), so it routes to `ask` — sending an image out should be approved, never silently
 * auto-allowed. With no approver (unattended) it fails closed, so no silent image egress.
 */
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { z } from 'zod';
import { safeResolve } from './safe-path.js';
import { buildVisionParts, type VisionComplete } from '../model/vision.js';
import type { ToolDefinition } from './types.js';

/** Cap the image size (bytes) before reading — base64 inflates ~33% and feeds a paid VLM call, so a
 *  huge file shouldn't be slurped. 10 MB covers screenshots/photos with margin. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Extension → MIME for the data URL. An unknown extension is rejected rather than guessed. */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

function imageMime(path: string): string | undefined {
  return IMAGE_MIME[extname(path).toLowerCase()];
}

/**
 * Build the vision tool over an injected VLM call. `complete` is the network seam — production passes
 * {@link createVisionComplete}; tests pass a fake so the read/encode/prompt logic is verified offline.
 */
export function createVisionTool(complete: VisionComplete): ToolDefinition<{ image: string; question: string }> {
  return {
    name: 'vision',
    description:
      'Look at an image file and get a STRUCTURED, coordinate-anchored answer (object names + pixel ' +
      'bounding boxes + a direct answer). Use for screenshots, photos, diagrams, or any visual the text ' +
      'tools cannot read. The image path is relative to the project root. Sends the image to the vision ' +
      'service, so the call requires approval.',
    capability: 'network',
    inputSchema: z.object({
      image: z.string().describe('Image file path, relative to the project root (.png/.jpg/.jpeg/.webp/.gif/.bmp).'),
      question: z.string().describe('What to look for or determine in the image.'),
    }),
    run: async ({ image, question }, ctx) => {
      const mime = imageMime(image);
      if (mime === undefined) {
        return { content: '', error: `Unsupported image type for ${image} (use .png/.jpg/.jpeg/.webp/.gif/.bmp).` };
      }
      const safe = await safeResolve(ctx.cwd, image);
      if (!safe.ok) return { content: '', error: `Cannot read image ${image}: ${safe.reason}` };
      try {
        // stat is a fast pre-filter so a huge file isn't read into memory; the post-read length check
        // below is the authoritative one (closes the stat→read TOCTOU — a concurrent swap can't push an
        // over-cap blob through).
        const info = await stat(safe.abs);
        if (info.size > MAX_IMAGE_BYTES) {
          return { content: '', error: `Image ${image} is ${info.size} bytes — over the ${MAX_IMAGE_BYTES}-byte limit.` };
        }
        const buf = await readFile(safe.abs);
        if (buf.length > MAX_IMAGE_BYTES) {
          return { content: '', error: `Image ${image} is ${buf.length} bytes — over the ${MAX_IMAGE_BYTES}-byte limit.` };
        }
        const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
        const answer = await complete(buildVisionParts(dataUrl, question), ctx.signal);
        return { content: answer.trim() === '' ? '(the vision model returned no description)' : answer };
      } catch (err) {
        return { content: '', error: `Vision failed for ${image}: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}
