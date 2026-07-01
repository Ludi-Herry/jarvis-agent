import { describe, expect, it } from 'vitest';
import { parseLoopArgs } from '../../src/surfaces/cli/loop-args.js';

describe('parseLoopArgs', () => {
  it('parses the objective file and verifier map without treating the map path as positional', () => {
    expect(parseLoopArgs(['objectives.txt', '--verifier-map', 'C:\\trusted\\loop-verifiers.json', '--hook-map', 'C:\\trusted\\loop-hooks.json'])).toEqual({
      resume: false,
      force: false,
      unattended: false,
      noVerifierMap: false,
      parallel: 1,
      verifierMapPath: 'C:\\trusted\\loop-verifiers.json',
      hookMapPath: 'C:\\trusted\\loop-hooks.json',
      positional: ['objectives.txt'],
    });
  });

  it('parses resume flags with verifier map', () => {
    expect(parseLoopArgs(['--resume', '--force', '--unattended', '--verifier-map', '/trusted/map.json'])).toEqual({
      resume: true,
      force: true,
      unattended: true,
      noVerifierMap: false,
      parallel: 1,
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
      parallel: 1,
      positional: [],
    });
  });

  it('parses parallel worktree options', () => {
    expect(parseLoopArgs(['objectives.txt', '--parallel', '3', '--worktree-root', 'C:\\jarvis\\worktrees'])).toEqual({
      resume: false,
      force: false,
      unattended: false,
      noVerifierMap: false,
      parallel: 3,
      worktreeRootPath: 'C:\\jarvis\\worktrees',
      positional: ['objectives.txt'],
    });
  });

  it('rejects a missing verifier-map value', () => {
    expect(() => parseLoopArgs(['objectives.txt', '--verifier-map'])).toThrow(/requires a path/);
  });

  it('rejects a missing hook-map value', () => {
    expect(() => parseLoopArgs(['objectives.txt', '--hook-map'])).toThrow(/requires a path/);
  });

  it('rejects conflicting verifier map decisions', () => {
    expect(() => parseLoopArgs(['--resume', '--verifier-map', '/trusted/map.json', '--no-verifier-map'])).toThrow(/cannot be combined/);
  });

  it('rejects invalid parallel values', () => {
    expect(() => parseLoopArgs(['objectives.txt', '--parallel', '0'])).toThrow(/positive integer/);
    expect(() => parseLoopArgs(['objectives.txt', '--parallel', '5'])).toThrow(/at most 4/);
    expect(() => parseLoopArgs(['objectives.txt', '--parallel', '1.5'])).toThrow(/positive integer/);
  });

  it('rejects parallel resume until replay/worktree recovery is designed', () => {
    expect(() => parseLoopArgs(['--resume', '--parallel', '2', '--verifier-map', '/trusted/map.json'])).toThrow(/cannot be combined with --resume/);
  });

  it('rejects unknown flags so typoed safety config is visible', () => {
    expect(() => parseLoopArgs(['objectives.txt', '--verifier-mpa', '/trusted/map.json'])).toThrow(/unknown flag/);
  });
});
