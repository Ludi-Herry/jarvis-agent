import { describe, expect, it } from 'vitest';
import { parseLoopArgs } from '../../src/surfaces/cli/loop-args.js';

describe('parseLoopArgs', () => {
  it('parses the objective file and verifier map without treating the map path as positional', () => {
    expect(parseLoopArgs(['objectives.txt', '--verifier-map', 'C:\\trusted\\loop-verifiers.json'])).toEqual({
      resume: false,
      force: false,
      unattended: false,
      noVerifierMap: false,
      verifierMapPath: 'C:\\trusted\\loop-verifiers.json',
      positional: ['objectives.txt'],
    });
  });

  it('parses resume flags with verifier map', () => {
    expect(parseLoopArgs(['--resume', '--force', '--unattended', '--verifier-map', '/trusted/map.json'])).toEqual({
      resume: true,
      force: true,
      unattended: true,
      noVerifierMap: false,
      verifierMapPath: '/trusted/map.json',
      positional: [],
    });
  });

  it('parses an explicit no-verifier-map resume decision', () => {
    expect(parseLoopArgs(['--resume', '--no-verifier-map'])).toEqual({
      resume: true,
      force: false,
      unattended: false,
      noVerifierMap: true,
      positional: [],
    });
  });

  it('rejects a missing verifier-map value', () => {
    expect(() => parseLoopArgs(['objectives.txt', '--verifier-map'])).toThrow(/requires a path/);
  });

  it('rejects conflicting verifier map decisions', () => {
    expect(() => parseLoopArgs(['--resume', '--verifier-map', '/trusted/map.json', '--no-verifier-map'])).toThrow(/cannot be combined/);
  });

  it('rejects unknown flags so typoed safety config is visible', () => {
    expect(() => parseLoopArgs(['objectives.txt', '--verifier-mpa', '/trusted/map.json'])).toThrow(/unknown flag/);
  });
});
