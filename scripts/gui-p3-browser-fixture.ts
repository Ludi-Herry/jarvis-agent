/** Deterministic browser verification only. This never loads credentials or a real provider. */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultShellPath, runCommand, type ModelProvider, type ModelDelta, type ModelResult } from '../src/core/index.js';
import { GuiSessionHost } from '../src/surfaces/gui/live-session.js';
import { createGuiServer } from '../src/surfaces/gui/gui-server.js';

/** Optional third argument reuses a retained fixture workspace so a restarted host replays its journal. */
const reusedCwd = process.argv[3] ? resolve(process.argv[3]) : undefined;
const cwd = reusedCwd ?? await mkdtemp(join(tmpdir(), 'jarvis-p3-browser-'));
if (reusedCwd === undefined) {
  await writeFile(join(cwd, 'seed.txt'), 'Deterministic browser fixture; not a product acceptance task.\n', 'utf8');
  for (const command of ['git init -q', 'git add -- seed.txt', 'git -c user.name=Fixture -c user.email=fixture@example.test commit -qm fixture']) {
    const result = await runCommand(defaultShellPath(), command, cwd, 15_000, 4000);
    if (result.code !== 0) throw new Error(result.output);
  }
}
let wave = 0;
const provider: ModelProvider = {
  capability: { maxContextTokens: 100_000, maxOutputTokens: 16_384, thinking: false, toolUse: true, imageIn: false, videoIn: false },
  async *call(messages): AsyncGenerator<ModelDelta, ModelResult> {
    const step = wave++;
    const changed = messages.some((message) => message.role === 'tool' && message.content.includes('清楚'));
    const text = step === 0 ? '我会请求一次写入，等待你审阅。' : changed ? '已接收调整理由，将说明写得更清楚。' : '我正在检查交付。';
    for (const char of text) { yield { type: 'text', text: char }; await new Promise((resolveWait) => setTimeout(resolveWait, 40)); }
    const toolCalls = step < 2 ? [{ id: `fixture-write-${step}`, name: 'write', arguments: JSON.stringify({ path: 'answer.mjs', content: changed ? 'export const label = "说明清楚";\n' : 'export const label = "说明";\n', createOnly: true }) }]
      : step === 2 ? [{ id: 'fixture-claim', name: 'update_goal', arguments: '{"status":"complete"}' }] : [];
    return { text, toolCalls, usage: { inputTokens: 12, outputTokens: 6 }, finishReason: toolCalls.length ? 'tool_calls' : 'completed', rawFinishReason: toolCalls.length ? 'tool_calls' : 'stop' };
  },
  withThinking: () => provider,
  withMaxCompletionTokens: () => provider,
};
const host = new GuiSessionHost({ cwd, dataDir: join(cwd, 'data'), provider, modelName: 'deterministic-browser-fixture', task: {
  cwd, objective: 'P3 确定性浏览器验证：检查流式消息、一次拒绝调整、工具写入与可信验收。此项不计为真实任务。',
  requirements: ['实际文件体现本次调整，语法检查通过；此为确定性测试'], writePaths: ['answer.mjs'], checkCommands: ['node --check answer.mjs'],
  maxRounds: 1, maxTurns: 6, wallClockMs: 900_000,
} });
const server = createGuiServer({ cwd, dataDir: join(cwd, 'data'), liveHost: host, appDir: resolve('src/surfaces/gui/app/dist') });
const port = Number(process.argv[2] ?? 4329);
server.listen(port, '127.0.0.1', () => { console.log(`Deterministic browser fixture: http://127.0.0.1:${port}/app/`); console.log(`Retained evidence: ${cwd}`); console.log(`Fixture PID: ${process.pid}`); });
