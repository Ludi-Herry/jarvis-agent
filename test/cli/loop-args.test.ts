import { describe, expect, it } from 'vitest';
import { parseLoopArgs } from '../../src/surfaces/cli/loop-args.js';

describe('parseLoopArgs', () => {
  it('parses the objective file and trusted maps without treating map paths as positional', () => {
    expect(
      parseLoopArgs([
        'objectives.txt',
        '--verifier-map',
        'C:\\trusted\\loop-verifiers.json',
        '--hook-map',
        'C:\\trusted\\loop-hooks.json',
        '--sandbox-check-map',
        'C:\\trusted\\loop-sandbox-checks.json',
      ]),
    ).toEqual({
      resume: false,
      force: false,
      unattended: false,
      noVerifierMap: false,
      allowNoGit: false,
      parallel: 1,
      verifierMapPath: 'C:\\trusted\\loop-verifiers.json',
      hookMapPath: 'C:\\trusted\\loop-hooks.json',
      sandboxCheckMapPath: 'C:\\trusted\\loop-sandbox-checks.json',
      positional: ['objectives.txt'],
    });
  });

  it('parses resume flags with verifier map', () => {
    expect(parseLoopArgs(['--resume', '--force', '--unattended', '--verifier-map', '/trusted/map.json'])).toEqual({
      resume: true,
      force: true,
      unattended: true,
      noVerifierMap: false,
      allowNoGit: false,
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
      allowNoGit: false,
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
      allowNoGit: false,
      parallel: 3,
      worktreeRootPath: 'C:\\jarvis\\worktrees',
      positional: ['objectives.txt'],
    });
  });

  it('parses a trusted goal-setter requirements map path', () => {
    expect(parseLoopArgs(['objectives.txt', '--goal-setter-requirements-map', 'C:\\trusted\\loop-requirements.json'])).toEqual({
      resume: false,
      force: false,
      unattended: false,
      noVerifierMap: false,
      allowNoGit: false,
      parallel: 1,
      goalSetterRequirementsMapPath: 'C:\\trusted\\loop-requirements.json',
      positional: ['objectives.txt'],
    });
  });

  it('parses the explicit fail-on-worktree-change policy', () => {
    expect(parseLoopArgs(['objectives.txt', '--fail-on-worktree-change'])).toEqual({
      resume: false,
      force: false,
      unattended: false,
      noVerifierMap: false,
      allowNoGit: false,
      parallel: 1,
      failOnWorktreeChange: true,
      positional: ['objectives.txt'],
    });
  });

  it('rejects a missing verifier-map value', () => {
    expect(() => parseLoopArgs(['objectives.txt', '--verifier-map'])).toThrow(/requires a path/);
  });

  it('rejects a missing hook-map value', () => {
    expect(() => parseLoopArgs(['objectives.txt', '--hook-map'])).toThrow(/requires a path/);
  });

  it('rejects a missing sandbox-check-map value', () => {
    expect(() => parseLoopArgs(['objectives.txt', '--sandbox-check-map'])).toThrow(/requires a path/);
  });

  it('rejects a missing goal-setter-requirements-map value', () => {
    expect(() => parseLoopArgs(['objectives.txt', '--goal-setter-requirements-map'])).toThrow(/requires a path/);
  });

  it('rejects ambiguous sandbox-only and goal-setter requirements maps', () => {
    expect(() =>
      parseLoopArgs([
        'objectives.txt',
        '--sandbox-check-map',
        '/trusted/sandbox.json',
        '--goal-setter-requirements-map',
        '/trusted/requirements.json',
      ]),
    ).toThrow(/cannot be combined/);
  });

  it('rejects conflicting verifier map decisions', () => {
    expect(() => parseLoopArgs(['--resume', '--verifier-map', '/trusted/map.json', '--no-verifier-map'])).toThrow(/cannot be combined/);
  });

  it('rejects invalid parallel values', () => {
    expect(() => parseLoopArgs(['objectives.txt', '--parallel', '0'])).toThrow(/positive integer/);
    expect(() => parseLoopArgs(['objectives.txt', '--parallel', '5'])).toThrow(/at most 4/);
    expect(() => parseLoopArgs(['objectives.txt', '--parallel', '1.5'])).toThrow(/positive integer/);
  });

  it('parses explicit parallel resume with a trusted worktree root supplied by the current command', () => {
    expect(parseLoopArgs(['--resume', '--parallel', '2', '--worktree-root', 'C:\\trusted\\worktrees', '--verifier-map', '/trusted/map.json'])).toEqual({
      resume: true,
      force: false,
      unattended: false,
      noVerifierMap: false,
      allowNoGit: false,
      parallel: 2,
      worktreeRootPath: 'C:\\trusted\\worktrees',
      verifierMapPath: '/trusted/map.json',
      positional: [],
    });
  });

  it('rejects parallel resume without an explicit worktree root from the current command', () => {
    expect(() => parseLoopArgs(['--resume', '--parallel', '2', '--verifier-map', '/trusted/map.json'])).toThrow(/--worktree-root is required/);
  });

  it('accepts no-Git checks-only mode for a serial loop and rejects it for parallel worktrees', () => {
    expect(parseLoopArgs(['objectives.txt', '--allow-no-git'])).toEqual({
      resume: false,
      force: false,
      unattended: false,
      noVerifierMap: false,
      allowNoGit: true,
      parallel: 1,
      positional: ['objectives.txt'],
    });
    expect(() => parseLoopArgs(['objectives.txt', '--allow-no-git', '--parallel', '2'])).toThrow(/cannot be combined/);
  });

  it('rejects unknown flags so typoed safety config is visible', () => {
    expect(() => parseLoopArgs(['objectives.txt', '--verifier-mpa', '/trusted/map.json'])).toThrow(/unknown flag/);
  });
});
