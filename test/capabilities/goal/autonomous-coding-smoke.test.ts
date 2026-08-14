import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGoal, type GoalRunDeps, type GoalSpec } from '../../../src/capabilities/goal/goal-loop.js';
import {
  buildDefaultRegistry,
  type ModelDelta,
  type ModelProvider,
  type ModelResult,
  type ToolCall,
} from '../../../src/core/index.js';
import { registerBuilderSandboxTools } from '../../../src/surfaces/cli/builder-sandbox-tools.js';
import { InMemoryEventBus, type SandboxRunRequest, type SandboxRunResult, type SandboxRunner } from '../../../src/runtime/index.js';

describe('autonomous coding smoke', () => {
  it('lets the builder write code, run sandboxed tests red, fix, rerun green, then complete through independent checks', async () => {
    const fixture = await createFixtureProject();
    const sandboxRuns: SandboxRunResult[] = [];
    const independentChecks: NpmRun[] = [];
    const sandboxFeedback: string[] = [];
    const toolResults: string[] = [];
    const bus = new InMemoryEventBus();
    bus.subscribe((event) => {
      if (event.type === 'tool_result') {
        toolResults.push(`${event.out.error ? `ERROR: ${event.out.error}` : event.out.content}`);
        if (event.out.content.includes('[sandboxed check: test]')) {
          sandboxFeedback.push(event.out.content);
        }
      }
    });
    const tools = buildDefaultRegistry();
    registerBuilderSandboxTools(tools, createLocalFixtureSandboxRunner(sandboxRuns));
    const model = codingModel();

    try {
      const result = await runGoal(spec(), {
        model,
        tools,
        bus,
        cwd: fixture.cwd,
        shellPath: 'bash',
        builderSystemPrompt: 'Fix the fixture by editing code and using sandboxed_check for feedback.',
        perRoundMaxTurns: 6,
        check: npmTestCheck(independentChecks),
      });

      expect(
        result.state,
        JSON.stringify(
          {
            verdict: result.finalVerdict,
            toolResults,
            sandboxFeedback,
            independentChecks,
            sawRedBeforeFix: model.sawRedBeforeFix(),
            sawGreenBeforeClaim: model.sawGreenBeforeClaim(),
          },
          null,
          2,
        ),
      ).toBe('complete');
      expect(result.finalVerdict?.outcome).toBe('verified');
      expect(model.sawRedBeforeFix()).toBe(true);
      expect(model.sawGreenBeforeClaim()).toBe(true);
      expect(sandboxFeedback).toHaveLength(2);
      expect(sandboxFeedback[0]).toContain('[exit code: 1]');
      expect(sandboxFeedback[0]).toContain('AssertionError');
      expect(sandboxFeedback[1]).toContain('[exit code: 0]');
      expect(sandboxFeedback[1]).toContain('add test passed');
      expect(sandboxRuns).toHaveLength(2);
      expect(sandboxRuns.every((run) => run.status === 'completed')).toBe(true);
      expect(independentChecks).toHaveLength(1);
      expect(independentChecks[0].code).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it('does not complete from green sandboxed builder feedback without an update_goal claim', async () => {
    const fixture = await createFixtureProject();
    const tools = buildDefaultRegistry();
    registerBuilderSandboxTools(tools, createLocalFixtureSandboxRunner([]));
    const sandboxFeedback: string[] = [];
    const bus = new InMemoryEventBus();
    bus.subscribe((event) => {
      if (event.type === 'tool_result' && event.out.content.includes('[sandboxed check: test]')) {
        sandboxFeedback.push(event.out.content);
      }
    });
    try {
      const result = await runGoal(spec(), {
        model: greenButNoClaimModel(),
        tools,
        bus,
        cwd: fixture.cwd,
        shellPath: 'bash',
        builderSystemPrompt: 'Run a sandboxed test but do not claim completion.',
        perRoundMaxTurns: 4,
        check: npmTestCheck([]),
      });

      expect(result.state).toBe('blocked');
      expect(result.finalVerdict).toBeUndefined();
      expect(sandboxFeedback).toHaveLength(1);
      expect(sandboxFeedback[0]).toContain('[exit code: 0]');
    } finally {
      await fixture.cleanup();
    }
  });
});

function spec(over: Partial<GoalSpec> = {}): GoalSpec {
  return {
    id: 'autonomous-coding-smoke',
    objective: 'Implement add(a, b) so the fixture tests pass.',
    sessionId: 'autonomous-coding-smoke-session',
    budget: { maxRounds: 1 },
    ...over,
  };
}

function codingModel(): ModelProvider & { sawRedBeforeFix(): boolean; sawGreenBeforeClaim(): boolean } {
  let redSeen = false;
  let greenSeen = false;
  const provider: ModelProvider & { sawRedBeforeFix(): boolean; sawGreenBeforeClaim(): boolean } = {
    capability: {
      maxContextTokens: 4_000,
      maxOutputTokens: 500,
      thinking: false,
      toolUse: true,
      imageIn: false,
      videoIn: false,
    },
    async *call(messages, tools): AsyncGenerator<ModelDelta, ModelResult> {
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['write', 'sandboxed_check', 'update_goal']));
      const lastSandboxFeedback = latestToolMessage(messages, '[sandboxed check: test]');
      const updateGoalResult = latestToolMessage(messages, 'Completion claim recorded');
      const currentAddVersion = latestPostVersion(messages);
      let toolCalls: ToolCall[] = [];
      let text = '';

      if (updateGoalResult) {
        text = 'claimed complete after green sandbox feedback';
      } else if (!lastSandboxFeedback) {
        toolCalls = [
          writeCall('write-broken', 'export function add(a, b) {\n  return a - b;\n}\n'),
          sandboxedTestCall('test-red', 'run fixture tests after the first implementation'),
        ];
      } else if (lastSandboxFeedback.includes('[exit code: 1]')) {
        redSeen = true;
        toolCalls = [
          writeCall('write-fix', 'export function add(a, b) {\n  return a + b;\n}\n', currentAddVersion),
          sandboxedTestCall('test-green', 'confirm the fix'),
        ];
      } else if (lastSandboxFeedback.includes('[exit code: 0]')) {
        greenSeen = true;
        toolCalls = [{ id: 'claim', name: 'update_goal', arguments: JSON.stringify({ status: 'complete' }) }];
      }

      yield* [];
      return {
        text,
        toolCalls,
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'completed',
        rawFinishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      };
    },
    withThinking: () => provider,
    withMaxCompletionTokens: () => provider,
    sawRedBeforeFix: () => redSeen,
    sawGreenBeforeClaim: () => greenSeen,
  };
  return provider;
}

function greenButNoClaimModel(): ModelProvider {
  let checked = false;
  const provider: ModelProvider = {
    capability: {
      maxContextTokens: 4_000,
      maxOutputTokens: 500,
      thinking: false,
      toolUse: true,
      imageIn: false,
      videoIn: false,
    },
    async *call(): AsyncGenerator<ModelDelta, ModelResult> {
      const toolCalls = checked
        ? []
        : [
            writeCall('write-correct', 'export function add(a, b) {\n  return a + b;\n}\n'),
            sandboxedTestCall('test-green', 'prove tests are green without claiming completion'),
          ];
      checked = true;
      yield* [];
      return {
        text: toolCalls.length > 0 ? '' : 'green feedback observed, but no claim',
        toolCalls,
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'completed',
        rawFinishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      };
    },
    withThinking: () => provider,
    withMaxCompletionTokens: () => provider,
  };
  return provider;
}

function writeCall(id: string, content: string, expectedVersion?: string): ToolCall {
  return {
    id,
    name: 'write',
    arguments: JSON.stringify(expectedVersion
      ? { path: 'src/add.js', content, expectedVersion }
      : { path: 'src/add.js', content, createOnly: true }),
  };
}

function sandboxedTestCall(id: string, reason: string): ToolCall {
  return { id, name: 'sandboxed_check', arguments: JSON.stringify({ check: 'test', reason }) };
}

function latestToolMessage(messages: readonly { role: string; content?: string }[], needle: string): string {
  return messages
    .filter((message) => message.role === 'tool' && (message.content ?? '').includes(needle))
    .map((message) => message.content ?? '')
    .at(-1) ?? '';
}

function latestPostVersion(messages: readonly { role: string; content?: string }[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const match = messages[i].content?.match(/postVersion=(fv1\.[A-Za-z0-9_-]{43})/);
    if (match) return match[1];
  }
  return undefined;
}

function npmTestCheck(runs: NpmRun[]): NonNullable<GoalRunDeps['check']> {
  return async (deps) => {
    const run = runNpmTest(deps.cwd);
    runs.push(run);
    return {
      objectiveChecksPassed: run.code === 0,
      results: [{ command: 'npm test', code: run.code, output: run.output }],
      testTamper: 'clean',
      tamperReason: '',
      heldOut: {
        passed: run.code === 0,
        results: [{ command: 'npm test', code: run.code, output: run.output }],
      },
    };
  };
}

interface NpmRun {
  readonly code: number | null;
  readonly output: string;
}

function runNpmTest(cwd: string): NpmRun {
  const result = spawnSync(testCommand(), testArgs(), {
    cwd,
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 128_000,
    windowsHide: true,
  });
  return {
    code: result.status,
    output: [`${result.stdout ?? ''}${result.stderr ?? ''}`, result.error ? `spawn error: ${result.error.message}` : '', result.signal ? `signal: ${result.signal}` : '']
      .filter((part) => part !== '')
      .join('\n'),
  };
}

function testCommand(): string {
  return process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
}

function testArgs(): string[] {
  return process.platform === 'win32' ? ['/d', '/s', '/c', 'npm test'] : ['test'];
}

function createLocalFixtureSandboxRunner(runs: SandboxRunResult[]): SandboxRunner {
  return {
    backend: 'wsl2-unshare',
    async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
      const started = Date.now();
      const mount = request.mounts[0];
      const root = await mkdtemp(join(tmpdir(), 'jarvis-autonomous-sandbox-'));
      const workDir = join(root, 'work');
      try {
        await cp(mount.hostPath, workDir, {
          recursive: true,
          filter: (path) => shouldCopyFixturePath(mount.hostPath, path),
        });
        const run = runNpmTest(workDir);
        const result: SandboxRunResult = {
          status: 'completed',
          backend: 'wsl2-unshare',
          audit: {
            backend: 'wsl2-unshare',
            command: [...request.command],
            cwd: request.cwd,
            mounts: request.mounts.map((entry) => ({ ...entry })),
            networkMode: request.networkMode,
            limits: { ...request.limits },
          },
          exitCode: run.code ?? 1,
          stdout: run.output,
          stderr: '',
          durationMs: Date.now() - started,
        };
        runs.push(result);
        return result;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

function shouldCopyFixturePath(root: string, path: string): boolean {
  const rel = relative(root, path).replace(/\\/g, '/');
  if (rel === '') return true;
  const parts = rel.split('/');
  if (parts.includes('.git') || parts.includes('node_modules')) return false;
  if (parts.some((part) => part === '.env' || part.startsWith('.env.'))) return false;
  if (parts.some((part) => part === '.ssh' || part === '.npmrc' || part === '.netrc' || part === '.git-credentials')) return false;
  return !/\.(?:key|pem|p12|pfx|token|crt|cer)$/i.test(rel);
}

async function createFixtureProject(): Promise<{ cwd: string; cleanup(): Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), 'jarvis-autonomous-fixture-'));
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify(
      {
        type: 'module',
        scripts: {
          test: 'node test/add.test.mjs',
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  await mkdir(join(cwd, 'test'), { recursive: true });
  await writeFile(
    join(cwd, 'test', 'add.test.mjs'),
    [
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/add.js';",
      '',
      'assert.equal(add(2, 3), 5);',
      "console.log('add test passed');",
      '',
    ].join('\n'),
    'utf8',
  );
  return {
    cwd,
    cleanup: async () => {
      await rm(cwd, { recursive: true, force: true });
    },
  };
}
