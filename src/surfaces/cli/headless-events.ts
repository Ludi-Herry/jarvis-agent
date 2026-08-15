import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeSync } from 'node:fs';
import {
  AgentEventWriter,
  type AgentEventWriterOptions,
  type RunFinishedInput,
} from '../../runtime/agent-events.js';
import { CLI_EXIT, exitCodeForGoal, exitCodeForLoop } from './exit-codes.js';

export const JARVIS_HEADLESS_ENV = 'JARVIS_HEADLESS';
export const JARVIS_AGENT_EVENT_FD_ENV = 'JARVIS_AGENT_EVENT_FD';
export const JARVIS_AGENT_EVENT_AUTH_FD_ENV = 'JARVIS_AGENT_EVENT_AUTH_FD';

type HeadlessEnv = Record<string, string | undefined>;
type WriteFd = (fd: number, text: string) => void;
type ReadFd = (fd: number) => string;

export function isHeadlessAgentEventMode(env: HeadlessEnv = process.env): boolean {
  return env[JARVIS_HEADLESS_ENV] === '1'
    && env[JARVIS_AGENT_EVENT_FD_ENV] !== undefined
    && env[JARVIS_AGENT_EVENT_AUTH_FD_ENV] !== undefined;
}

export function createProcessAgentEventWriter(
  options: Omit<AgentEventWriterOptions, 'writeLine'>,
  env: HeadlessEnv = process.env,
  io: {
    writeFd?: WriteFd;
    readFd?: ReadFd;
  } = {},
): AgentEventWriter | undefined {
  if (!isHeadlessAgentEventMode(env)) return undefined;
  const fd = parseDedicatedDescriptor(env[JARVIS_AGENT_EVENT_FD_ENV], 'agent-event');
  const authFd = parseDedicatedDescriptor(env[JARVIS_AGENT_EVENT_AUTH_FD_ENV], 'agent-event auth');
  if (fd === authFd) throw new Error('headless agent-event and auth descriptors must differ');
  const readFd = io.readFd ?? ((descriptor) => readFileSync(descriptor, 'utf8'));
  const writeFd = io.writeFd ?? ((descriptor, text) => { writeSync(descriptor, text, null, 'utf8'); });
  const secret = readFd(authFd).trim();
  assertTransportSecret(secret);
  return new AgentEventWriter({
    ...options,
    writeLine: (line) => writeFd(fd, `${signAgentEventFrame(secret, line)}\n`),
  });
}

export function verifyAgentEventFrame(secret: string, frame: string): string {
  assertTransportSecret(secret);
  const separator = frame.indexOf('\t');
  if (separator !== 64) throw new Error('headless agent-event frame authentication failed');
  const claimed = frame.slice(0, separator);
  const line = frame.slice(separator + 1);
  if (!/^[a-f0-9]{64}$/u.test(claimed) || line === '') {
    throw new Error('headless agent-event frame authentication failed');
  }
  const expected = hmac(secret, line);
  if (!timingSafeEqual(Buffer.from(claimed, 'hex'), Buffer.from(expected, 'hex'))) {
    throw new Error('headless agent-event frame authentication failed');
  }
  return line;
}

export function scrubHeadlessAgentEventEnv(env: NodeJS.ProcessEnv = process.env): void {
  delete env[JARVIS_HEADLESS_ENV];
  delete env[JARVIS_AGENT_EVENT_FD_ENV];
  delete env[JARVIS_AGENT_EVENT_AUTH_FD_ENV];
}

function signAgentEventFrame(secret: string, line: string): string {
  return `${hmac(secret, line)}\t${line}`;
}

function hmac(secret: string, line: string): string {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(line, 'utf8').digest('hex');
}

function assertTransportSecret(secret: string): void {
  if (!/^[a-f0-9]{64}$/u.test(secret)) throw new Error('headless agent-event auth secret must be 32-byte lowercase hex');
}

function parseDedicatedDescriptor(raw: string | undefined, label: string): number {
  if (raw === undefined || !/^[0-9]+$/u.test(raw)) throw new Error(`headless ${label} descriptor must be an integer`);
  const fd = Number(raw);
  if (!Number.isSafeInteger(fd) || fd < 3) throw new Error(`headless ${label} descriptor must be a dedicated fd >= 3`);
  return fd;
}

export function goalRunFinished(result: {
  state: string;
  outcome?: 'verified' | 'checksOnly' | 'rejected' | 'couldNotVerify';
  haltReason?: string;
}): RunFinishedInput {
  const exitCode = exitCodeForGoal(result);
  return {
    status: agentStatusForExit(exitCode),
    exitCode,
    ...(result.outcome === undefined ? {} : { verdict: result.outcome }),
    completion: result.state === 'complete' && result.outcome === 'verified'
      ? { granted: true, authority: 'decideVerdict' }
      : { granted: false, authority: 'none' },
  };
}

export function loopRunFinished(result: {
  reason: string;
  blocked: number;
  needsVerification: number;
  runtimeFailures: number;
}): RunFinishedInput {
  const exitCode = exitCodeForLoop(result);
  return {
    status: agentStatusForExit(exitCode),
    exitCode,
    completion: { granted: false, authority: 'none' },
  };
}

function agentStatusForExit(exitCode: number): RunFinishedInput['status'] {
  if (exitCode === CLI_EXIT.SUCCESS) return 'completed';
  if (exitCode === CLI_EXIT.UNVERIFIED) return 'unverified';
  if (exitCode === CLI_EXIT.INTERRUPTED) return 'interrupted';
  if (exitCode === CLI_EXIT.RUNTIME) return 'failed';
  return 'needs-human';
}
