import { describe, expect, it } from 'vitest';
import { hardenSandboxInspectionCommand, validateSandboxInspectionCommand } from '../../src/core/tools/sandboxed-inspection-command.js';

describe('validateSandboxInspectionCommand', () => {
  it.each([
    'git status --short',
    'git diff --stat',
    'git diff --no-ext-diff --stat',
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
    ['git -c diff.external=cat diff --stat', /subcommand/],
    ['git diff --ext-diff --stat', /flag/],
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

  it('keeps parser object errors diagnosable', () => {
    const decision = validateSandboxInspectionCommand('git diff --stat (');

    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/cannot parse command/);
    expect(decision.reason).toMatch(/sandboxed-inspection:1|encountered/);
    expect(decision.reason).not.toContain('[object Object]');
  });

  it('adds --no-ext-diff to allowed git diff commands before sandbox execution', () => {
    expect(hardenSandboxInspectionCommand('git diff --stat')).toBe('git diff --no-ext-diff --stat');
    expect(hardenSandboxInspectionCommand('git diff --no-ext-diff --stat')).toBe('git diff --no-ext-diff --stat');
    expect(hardenSandboxInspectionCommand('git diff -- --no-ext-diff')).toBe('git diff --no-ext-diff -- --no-ext-diff');
    expect(hardenSandboxInspectionCommand("git diff --name-only -- 'dir/file name.txt'")).toBe(
      "git diff --no-ext-diff --name-only -- 'dir/file name.txt'",
    );
    expect(hardenSandboxInspectionCommand('git diff --name-only -- "dir/it\'s ok.txt"')).toBe(
      "git diff --no-ext-diff --name-only -- 'dir/it'\\''s ok.txt'",
    );
    expect(hardenSandboxInspectionCommand('git status --short')).toBe('git status --short');
  });
});
