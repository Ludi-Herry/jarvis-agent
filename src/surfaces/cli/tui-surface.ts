export type CliSurfaceSelection =
  | { kind: 'machine'; reason: 'headless' }
  | { kind: 'line'; reason: 'disabled' | 'non-tty' | 'renderer-unavailable' }
  | { kind: 'tui'; reason: 'available' };

export interface CliSurfaceInput {
  headless: boolean;
  noTui: boolean;
  inputIsTTY: boolean;
  outputIsTTY: boolean;
  rendererAvailable: boolean;
}

/** Pure surface selection. Machine mode always wins; TUI requires both TTY
 * directions plus an explicitly registered renderer adapter. */
export function selectCliSurface(input: CliSurfaceInput): CliSurfaceSelection {
  if (input.headless) return { kind: 'machine', reason: 'headless' };
  if (input.noTui) return { kind: 'line', reason: 'disabled' };
  if (!input.inputIsTTY || !input.outputIsTTY) return { kind: 'line', reason: 'non-tty' };
  if (!input.rendererAvailable) return { kind: 'line', reason: 'renderer-unavailable' };
  return { kind: 'tui', reason: 'available' };
}
