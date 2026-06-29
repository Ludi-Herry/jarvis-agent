/**
 * C2 milestone demo — "it can convene a perspective review panel".
 *
 * Review-panel axis (Phase C) against the REAL Doubao endpoint: three read-only reviewers, each
 * wearing a thinking hat (black = find flaws, yellow = find value, green = alternatives), read the
 * SAME artifact IN PARALLEL and each writes a review from its angle. This is "judge ≠ player" made
 * standing — independent reviewers instead of the author grading itself.
 *
 * Run:  npm run demo:c2   (needs ARK_API_KEY in the environment)
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDefaultRegistry, createProvider, loadDoubaoConfig } from '../src/core/index.js';
import { DefaultPermissionGate } from '../src/runtime/index.js';
import { SIX_HATS, SubagentManager, runPanel } from '../src/capabilities/index.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const ARTIFACT = [
  '产品方案:给所有用户默认开启「AI 自动回复」,无需用户确认即代替用户回消息,',
  '以此提升日活。预计能把日活提升 30%。先全量上线,有问题再说。',
].join('\n');

async function main(): Promise<void> {
  const config = loadDoubaoConfig();
  const provider = createProvider(config).withThinking('off');

  const dir = await mkdtemp(join(tmpdir(), 'c2-demo-'));
  const gate = new DefaultPermissionGate({
    approver: async () => 'allow-once', // read-only never reaches this; here only as a backstop
  });
  const manager = new SubagentManager({
    provider,
    registry: buildDefaultRegistry(),
    gate,
    budget: { maxTurns: 4 },
    roster: [],
    cwd: dir,
    remainingDepth: 1, // reviewers are leaves — no further delegation
  });

  const hats = SIX_HATS.filter((h) => ['black-hat', 'yellow-hat', 'green-hat'].includes(h.name));

  console.log(`model: ${config.model}`);
  console.log(`hats:  ${hats.map((h) => h.name).join(', ')}`);
  console.log(`\n=== artifact under review ===\n${ARTIFACT}`);

  console.log('\n=== convening the panel (parallel, read-only) ===');
  const reviews = await runPanel(manager, hats, ARTIFACT);
  for (const r of reviews) {
    console.log(`\n【${r.hat}】${r.ok ? '' : '(failed) '}`);
    console.log(r.review.trim());
  }

  await rm(dir, { recursive: true, force: true });

  const allOk = reviews.length === hats.length && reviews.every((r) => r.ok && r.review.trim() !== '');
  const black = reviews.find((r) => r.hat === 'black-hat')?.review ?? '';
  const yellow = reviews.find((r) => r.hat === 'yellow-hat')?.review ?? '';
  const distinct = black !== '' && yellow !== '' && black !== yellow; // perspectives diverged
  const ok = allOk && distinct;
  console.log(`\n[assert] every hat returned a non-empty review: ${allOk}`);
  console.log(`[assert] the black-hat and yellow-hat reviews differ (perspectives diverged): ${distinct}`);
  console.log(`\n=== C2 demo ${ok ? 'PASSED' : 'FAILED'} ===`);
  if (!ok) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error('\n[demo failed]', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
