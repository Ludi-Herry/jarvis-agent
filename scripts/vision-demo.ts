/**
 * demo:vision — live check of the heterogeneous vision tool (Phase E multimodal).
 *
 * Needs ARK_API_KEY (in .env) + ARK_VISION_MODEL (a vision model id under the same ARK account). Runs the
 * `vision` tool on a real image and prints the structured, coordinate-anchored result.
 *
 * Run:  ARK_VISION_MODEL=<id> npm run demo:vision -- <image-path> ["<question>"]
 */
import { existsSync } from 'node:fs';
import {
  assertKeyNotInLaunchEnv,
  createVisionComplete,
  createVisionTool,
  loadDoubaoConfig,
  resolveVisionConfig,
} from '../src/core/index.js';

const ARK_KEY_IN_LAUNCH_ENV = process.env.ARK_API_KEY !== undefined;
if (existsSync('.env')) process.loadEnvFile('.env');

async function main(): Promise<void> {
  const image = process.argv[2];
  const question = process.argv[3] ?? 'Describe the image and locate every distinct object.';
  if (!image) {
    console.error('用法: ARK_VISION_MODEL=<id> npm run demo:vision -- <图像路径> ["<问题>"]');
    process.exitCode = 1;
    return;
  }

  let config;
  try {
    assertKeyNotInLaunchEnv(ARK_KEY_IN_LAUNCH_ENV);
    config = loadDoubaoConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const vision = resolveVisionConfig(process.env, config);
  if (!vision.enabled) {
    console.error(`vision 未启用: ${vision.reason}\n设 ARK_VISION_MODEL=<vision 模型 id> 后重试。`);
    process.exitCode = 1;
    return;
  }

  console.log(`Jarvis-Agent · vision demo · ${vision.config.model}`);
  console.log(`图像: ${image}\n问题: ${question}\n`);

  const tool = createVisionTool(createVisionComplete(vision.config));
  const result = await tool.run({ image, question }, { cwd: process.cwd() });
  if (result.error) {
    console.error(`[vision] ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(result.content);
}

main().catch((err: unknown) => {
  console.error('\n[vision] fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
