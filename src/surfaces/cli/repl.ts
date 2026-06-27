/**
 * The terminal REPL shell — the thin imperative layer over the agent loop.
 *
 * Read a line → append it as a user turn → run the agent, streaming events through the pure
 * {@link renderEvent} formatter to the output → re-prompt. The conversation (`messages`) and
 * the context manager persist across turns, so it's one continuous session. Streams are
 * injected (default stdin/stdout) so the whole REPL runs against fake streams in a test, no
 * TTY required.
 *
 * Ctrl-C aborts an in-flight run via AbortSignal (the provider passes it to the wire);
 * pressing it while idle exits. An aborted run is caught and the session continues.
 */
import { createInterface } from 'node:readline';
import type { Message } from '../../core/types.js';
import type { ModelProvider } from '../../core/model/types.js';
import type { ToolRegistry } from '../../core/tools/types.js';
import type { ContextManager } from '../../core/context/context-manager.js';
import type { SkillRegistry } from '../../capabilities/skills/skill-registry.js';
import { runAgent } from '../../core/loop/run-agent.js';
import { InMemoryEventBus } from '../../runtime/event-bus.js';
import { initialRenderState, renderEvent } from './render.js';

export interface ReplDeps {
  model: ModelProvider;
  tools: ToolRegistry;
  context?: ContextManager;
  /** Optional skills (A5). Each user turn, the catalog + any activated skill bodies are
   *  folded into the model's system message for that run. */
  skills?: SkillRegistry;
  /** Base directory tool paths resolve against. */
  cwd: string;
  /** Shown in the banner. */
  modelName: string;
  systemPrompt: string;
  maxTurns: number;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export async function startRepl(deps: ReplDeps): Promise<void> {
  const out = deps.output ?? process.stdout;
  const rl = createInterface({
    input: deps.input ?? process.stdin,
    output: out,
    prompt: '› ',
  });

  const messages: Message[] = [{ role: 'system', content: deps.systemPrompt }];
  let activeRun: AbortController | null = null;

  // With piped/test input, the stream EOFs and readline closes mid-loop; calling prompt()
  // on a closed interface throws. Track closure and make prompt() a no-op once closed.
  let closed = false;
  rl.on('close', () => {
    closed = true;
  });
  const prompt = (): void => {
    if (!closed) rl.prompt();
  };

  rl.on('SIGINT', () => {
    if (activeRun) {
      activeRun.abort(); // interrupt the in-flight run; the catch below resumes the REPL
    } else {
      rl.close();
    }
  });

  out.write(`Jarvis-Agent · ${deps.modelName}\n输入消息,Ctrl-C 退出(/exit 也可)\n\n`);
  prompt();

  for await (const line of rl) {
    const text = line.trim();
    if (text === '') {
      prompt();
      continue;
    }
    if (text === '/exit' || text === '/quit') break;

    messages.push({ role: 'user', content: text });

    const bus = new InMemoryEventBus();
    let rstate = initialRenderState();
    const unsubscribe = bus.subscribe((event) => {
      const { output, state } = renderEvent(rstate, event);
      rstate = state;
      if (output) out.write(output);
    });

    activeRun = new AbortController();
    try {
      await runAgent({
        model: deps.model,
        tools: deps.tools,
        bus,
        messages,
        toolCtx: { cwd: deps.cwd },
        budget: { maxTurns: deps.maxTurns },
        context: deps.context,
        // Progressive disclosure: only this turn's message decides which skill bodies load.
        systemAddendum: deps.skills?.systemAddendum(text),
        signal: activeRun.signal,
      });
    } catch (err) {
      out.write(
        activeRun.signal.aborted
          ? '\n  · (已中断)\n'
          : `\n  · 出错: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    } finally {
      unsubscribe();
      activeRun = null;
    }

    out.write('\n');
    prompt();
  }

  rl.close();
}
