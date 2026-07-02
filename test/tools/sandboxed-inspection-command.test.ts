import { describe, expect, it } from 'vitest';
import { validateSandboxInspectionCommand } from '../../src/core/tools/sandboxed-inspection-command.js';

describe('validateSandboxInspectionCommand', () => {
  it.each([
    'git status --short',
    'git diff --stat',
    'git diff --name-only -- src',
    'git log --oneline -5',
    'git log --max-count=3 --color=never',
    'git ls-files src',
    'stat package.json',
    'wc -l README.md',
  ])('allows narrow inspection command: %s', (command) => {
    expect(validateSandboxInspectionCommand(command)).toEqual({ ok: true });
  });

  it.each([
    ['python3 -c "print(1)"', /inline code|not in/],
    ['touch x', /not in/],
    ['cat README.md', /not in/],
    ['find . -type f', /not in/],
    ['git push origin main', /push|subcommand/],
    ['git diff --output=x', /flag/],
    ['git diff -- .env', /secret|project snapshot/],
    ['git diff $(echo src)', /command\/process substitution|shell expansion|unsupported/],
    ['git status; git diff --stat', /one simple/],
    ['git status && git diff --stat', /unsupported|one simple/],
    ['git diff --stat > out.txt', /unsupported/],
    ['wc -l ~/.ssh/id_rsa', /secret|project snapshot/],
    ['stat /etc/passwd', /project snapshot/],
  ])('rejects command outside inspection scope: %s', (command, reason) => {
    const decision = validateSandboxInspectionCommand(command);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(reason);
  });
});
