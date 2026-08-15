import { describe, expect, it } from 'vitest';
import {
  configCliOptionsToArgs,
  extractConfigCliOptions,
} from '../../src/surfaces/cli/config-options.js';

describe('config CLI options', () => {
  it('extracts global config flags wherever they appear before --', () => {
    expect(extractConfigCliOptions([
      'run',
      '--strict-config',
      '--preset=inspect',
      'audit',
      '--ignore-user-config',
      '--model',
      'builder-model',
      '--base-url=https://example.test/v1',
    ])).toEqual({
      argv: ['run', 'audit'],
      options: {
        strict: true,
        ignoreUser: true,
        preset: 'inspect',
        model: 'builder-model',
        baseURL: 'https://example.test/v1',
      },
    });
  });

  it('treats --safe as the safe preset and emits canonical child arguments', () => {
    const extracted = extractConfigCliOptions(['goal', '--safe', 'inspect files']);

    expect(extracted.options.preset).toBe('safe');
    expect(configCliOptionsToArgs(extracted.options)).toEqual(['--preset', 'safe']);
  });

  it('leaves every token after -- untouched', () => {
    expect(extractConfigCliOptions(['run', '--', '--safe', '--model', 'quoted'])).toEqual({
      argv: ['run', '--', '--safe', '--model', 'quoted'],
      options: { strict: false, ignoreUser: false },
    });
  });

  it.each([
    ['--strict-config', '--strict-config'],
    ['--ignore-user-config', '--ignore-user-config'],
    ['--safe', '--preset', 'inspect'],
    ['--model', 'one', '--model=two'],
    ['--base-url', 'https://one.test', '--base-url=https://two.test'],
  ])('rejects duplicate or conflicting config flags: %j', (...args) => {
    expect(() => extractConfigCliOptions(args)).toThrow(/only be supplied once|cannot be combined/u);
  });

  it.each([
    ['--preset'],
    ['--preset', 'unknown'],
    ['--model'],
    ['--model', ''],
    ['--base-url'],
    ['--base-url', ''],
  ])('rejects a missing or invalid value: %j', (...args) => {
    expect(() => extractConfigCliOptions(args)).toThrow(/requires|inspect|safe/u);
  });
});
