/**
 * vision — heterogeneous vision delegation (Phase E multimodal, first slice).
 *
 * The harness's main reasoning model is TEXT-ONLY (Message carries no image parts) — deliberately: a
 * native-multimodal model trades reasoning for image support. So vision is delegated, OpenHanako's
 * "outer vision" pattern (project memory openhanako-outer-vision-multimodal): a separate VLM is the
 * "eyes" — a single stateless call — and its output is fed back to the text model as a normal tool
 * result. The text model never sees pixels; it reasons over the VLM's STRUCTURED, COORDINATE-ANCHORED
 * description. Coordinates use a 0-1024 visual grid because Doubao's live vision output naturally
 * grounds boxes on that grid; the downstream reasoner only needs a stable numeric coordinate system.
 *
 * The coordinate anchoring is the load-bearing idea: the VLM must emit object names + numeric bounding
 * boxes, NOT prose directions ("on the left"). Prose makes the downstream reasoner hallucinate spatial
 * relations; numbers let it do geometry (visual grounding / Set-of-Mark). {@link VISION_PROMPT} pins
 * that contract.
 *
 * This module owns the VLM CALL (an OpenAI-compatible, non-streaming completion with image content) and
 * the prompt. Reading the image off disk + path-confinement live in the tool (tools/vision-tool.ts), so
 * this stays a thin model-layer wire with no filesystem or permission dependency.
 */
import OpenAI from 'openai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import type { DoubaoConfig } from './types.js';
import { DEFAULT_ARK_BASE_URL } from './doubao-provider.js';
import { describeModelError } from './errors.js';

/** One part of the VLM user message: a text instruction or an inline image (a data: URL). Mirrors the
 *  OpenAI-compatible vision content shape ARK accepts. */
export type VisionContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** The injected VLM call — production wires it to the ARK client; tests fake it without a network. */
export type VisionComplete = (parts: VisionContentPart[], signal?: AbortSignal) => Promise<string>;

/**
 * The coordinate-anchoring contract handed to the VLM. English (vision-grounding prompts are most
 * reliable in English) and deliberately demanding STRUCTURE over prose — the whole point of the
 * outer-vision pattern is that the text model reasons over numbers, not vague directions.
 */
export const VISION_PROMPT = [
  'You are the vision module for a text-only reasoning agent. Look at the image and answer the QUESTION below.',
  'Output STRUCTURED text, never prose directions. Specifically:',
  '1. OBJECTS: list each object relevant to the question as `name: [x_min, y_min, x_max, y_max]` —',
  '   integer coordinates on a 0-1024 visual coordinate grid, origin at the TOP-LEFT, x rightward,',
  '   y downward. One per line. All coordinates MUST be within 0-1024.',
  '2. ANSWER: a direct, factual answer to the question that REFERS to objects by name and cites their',
  '   coordinates when spatial. Bind every spatial claim to numbers — never say "on the left"/"above"',
  '   without the box, because the downstream reasoner can only do geometry on the numbers.',
  'If something cannot be determined from the image, say so plainly rather than guessing.',
].join('\n');

/** Build the VLM user-message content: the prompt + the question, then the image as a data URL. */
export function buildVisionParts(dataUrl: string, question: string): VisionContentPart[] {
  return [
    { type: 'text', text: `${VISION_PROMPT}\n\nQUESTION: ${question}` },
    { type: 'image_url', image_url: { url: dataUrl } },
  ];
}

/**
 * Production VLM call: a NON-streaming OpenAI-compatible completion against the configured vision model.
 * Reuses the ARK endpoint/key (a vision model id under the same ARK account). Returns the model's text,
 * or '' if the response carries none.
 */
export function createVisionComplete(config: DoubaoConfig, client?: OpenAI): VisionComplete {
  const http = client ?? new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL ?? DEFAULT_ARK_BASE_URL });
  return async (parts, signal) => {
    const params = {
      model: config.model,
      messages: [{ role: 'user', content: parts }],
      stream: false,
    } as unknown as ChatCompletionCreateParamsNonStreaming;
    try {
      const res = await http.chat.completions.create(params, { signal });
      return res.choices[0]?.message?.content ?? '';
    } catch (err) {
      // A deliberate cancel surfaces as-is. Otherwise route through describeModelError — the SAME
      // redaction the main provider uses — so an endpoint that reflects the Authorization header or the
      // image data URL in its error never leaks a credential / the base64 blob into the model context
      // or the session log (this is a model-facing error channel like doubao-provider's).
      if (signal?.aborted) throw err;
      throw describeModelError(err, config.model);
    }
  };
}
