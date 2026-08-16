import { describe, expect, it } from 'vitest';
import { selectCliSurface } from '../../src/surfaces/cli/tui-surface.js';
import { extractGlobalCwd } from '../../src/surfaces/cli/jarvis.js';

describe('CLI surface selection', () => {
  it('keeps headless machine output authoritative over every terminal flag', () => {
    expect(selectCliSurface({
      headless: true,
      noTui: true,
      inputIsTTY: true,
      outputIsTTY: true,
      rendererAvailable: true,
    })).toEqual({ kind: 'machine', reason: 'headless' });
  });

  it('uses line mode for --no-tui, non-TTY streams, or an unavailable renderer', () => {
    expect(selectCliSurface({
      headless: false,
      noTui: true,
      inputIsTTY: true,
      outputIsTTY: true,
      rendererAvailable: true,
    })).toEqual({ kind: 'line', reason: 'disabled' });
    expect(selectCliSurface({
      headless: false,
      noTui: false,
      inputIsTTY: false,
      outputIsTTY: true,
      rendererAvailable: true,
    })).toEqual({ kind: 'line', reason: 'non-tty' });
    expect(selectCliSurface({
      headless: false,
      noTui: false,
      inputIsTTY: true,
      outputIsTTY: true,
      rendererAvailable: false,
    })).toEqual({ kind: 'line', reason: 'renderer-unavailable' });
  });

  it('selects TUI only for a complete TTY pair with a registered renderer', () => {
    expect(selectCliSurface({
      headless: false,
      noTui: false,
      inputIsTTY: true,
      outputIsTTY: true,
      rendererAvailable: true,
    })).toEqual({ kind: 'tui', reason: 'available' });
  });

  it('extracts --no-tui once and leaves a narrow forwarded argv', () => {
    expect(extractGlobalCwd(['--no-tui', 'run', 'hello'], 'H:/workspace')).toMatchObject({
      argv: ['run', 'hello'],
      noTui: true,
    });
    expect(() => extractGlobalCwd(['--no-tui', '--no-tui', 'run'], 'H:/workspace'))
      .toThrow(/--no-tui may only be supplied once/u);
  });
});
