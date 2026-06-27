/**
 * A5 milestone demo — "it can use a skill".
 *
 * Proves progressive disclosure end-to-end against REAL Doubao:
 *  1. L1 catalog is always available (cheap: name + description).
 *  2. The git-commit skill's full body loads ONLY for a commit-related message — shown as
 *     the addendum length difference vs an unrelated message (the §5.6 token gap).
 *  3. A live run: asked to write a commit message (with a diff), Doubao follows the loaded
 *     skill — English message + the mandated Co-Authored-By trailer.
 *
 * Uses runAgent directly (not the line-based REPL) so the multi-line diff stays one message.
 *
 * Run:  npm run demo:a5   (needs ARK_API_KEY in the environment)
 */
import { existsSync } from 'node:fs';
import {
  buildDefaultRegistry,
  createProvider,
  loadDoubaoConfig,
  runAgent,
  type Message,
} from '../src/core/index.js';
import { SkillRegistry } from '../src/capabilities/index.js';
import { InMemoryEventBus, type Event } from '../src/runtime/index.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const DIFF = [
  'diff --git a/src/util/clamp.ts b/src/util/clamp.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/util/clamp.ts',
  '@@ -0,0 +1,3 @@',
  '+export function clamp(n: number, lo: number, hi: number): number {',
  '+  return Math.max(lo, Math.min(hi, n));',
  '+}',
].join('\n');

const REQUEST = `帮我写个 commit message。下面是 git diff --staged 的输出：\n\n${DIFF}`;
const COAUTHOR = 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>';

async function main(): Promise<void> {
  const config = loadDoubaoConfig();
  const provider = createProvider(config).withThinking('off');
  const tools = buildDefaultRegistry();
  const skills = await SkillRegistry.load('skills');

  console.log(`model: ${config.model}`);
  console.log('--- L1 catalog (always injected) ---');
  console.log(skills.catalog() || '(no skills installed)');

  // §5.6: the body loads only when the message is relevant.
  const relevant = skills.systemAddendum(REQUEST);
  const unrelated = skills.systemAddendum('今天天气怎么样？');
  console.log('\n--- progressive disclosure (addendum length) ---');
  console.log(`commit request: ${relevant.length} chars (catalog + git-commit body)`);
  console.log(`weather  query: ${unrelated.length} chars (catalog only)`);
  console.log(`body disclosed only when relevant: ${relevant.length > unrelated.length}`);

  const bus = new InMemoryEventBus();
  bus.subscribe((e: Event) => {
    if (e.type === 'message_delta') process.stdout.write(e.text);
  });

  const messages: Message[] = [
    { role: 'system', content: '你是一个在终端里运行的编码助手。回答简洁。' },
    { role: 'user', content: REQUEST },
  ];

  console.log('\n--- live run: Doubao writes the commit (git-commit skill active) ---');
  const outcome = await runAgent({
    model: provider,
    tools,
    bus,
    messages,
    toolCtx: { cwd: process.cwd() },
    budget: { maxTurns: 4 },
    systemAddendum: relevant,
  });

  const answer = outcome.finalText ?? '';
  const followedSkill = answer.includes(COAUTHOR);
  console.log('\n\n--- A5 close-out ---');
  console.log(`message in a code block: ${answer.includes('```')}`);
  console.log(`carries the mandated Co-Authored-By trailer: ${followedSkill}`);
  const ok = relevant.length > unrelated.length && followedSkill;
  console.log(`A5 closed loop (disclosure works + model followed the skill): ${ok}`);
  if (!ok) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error('\n[demo failed]', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
