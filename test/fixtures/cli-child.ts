import { createHmac } from 'node:crypto';
import { appendFileSync, readFileSync, writeSync } from 'node:fs';

const mode = process.argv[2];

if (mode === 'exit') {
  process.exitCode = Number(process.argv[3] ?? 0);
} else if (mode === 'wait') {
  const auditPath = process.argv[3];
  if (!auditPath) throw new Error('audit path required');
  appendFileSync(auditPath, `started:${process.pid}\n`, 'utf8');
  const onSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
    appendFileSync(auditPath, `signal:${signal}\n`, 'utf8');
    process.exit(0);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  setInterval(() => undefined, 1_000);
} else if (mode === 'headless') {
  console.log('human stdout');
  console.error('human stderr');
  const fd = Number(process.env.JARVIS_AGENT_EVENT_FD);
  const authFd = Number(process.env.JARVIS_AGENT_EVENT_AUTH_FD);
  const secret = readFileSync(authFd, 'utf8').trim();
  const line = JSON.stringify({ schemaVersion: 1, type: 'run.finished' });
  const mac = createHmac('sha256', Buffer.from(secret, 'hex')).update(line, 'utf8').digest('hex');
  writeSync(fd, `${mac}\t${line}\n`, null, 'utf8');
} else if (mode === 'headless-forged') {
  const fd = Number(process.env.JARVIS_AGENT_EVENT_FD);
  const authFd = Number(process.env.JARVIS_AGENT_EVENT_AUTH_FD);
  readFileSync(authFd, 'utf8');
  writeSync(fd, `${JSON.stringify({ schemaVersion: 1, type: 'run.finished' })}\n`, null, 'utf8');
} else if (mode === 'headless-controls') {
  const fd = Number(process.env.JARVIS_AGENT_EVENT_FD);
  const authFd = Number(process.env.JARVIS_AGENT_EVENT_AUTH_FD);
  const secret = readFileSync(authFd, 'utf8').trim();
  const esc = String.fromCharCode(27);
  const bel = String.fromCharCode(7);
  const rlo = String.fromCodePoint(0x202e);
  process.stdout.write(`stdout${esc}]8;;https://example.invalid${bel}\r\ncontinued${rlo}`);
  process.stderr.write(`stderr${esc}[31mred\r\ncontinued${rlo}`);
  const line = JSON.stringify({ schemaVersion: 1, type: 'run.finished' });
  const mac = createHmac('sha256', Buffer.from(secret, 'hex')).update(line, 'utf8').digest('hex');
  writeSync(fd, `${mac}\t${line}\n`, null, 'utf8');
} else {
  throw new Error(`unknown fixture mode: ${String(mode)}`);
}
