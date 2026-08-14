import { appendFileSync } from 'node:fs';

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
} else {
  throw new Error(`unknown fixture mode: ${String(mode)}`);
}
