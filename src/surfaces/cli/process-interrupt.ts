export type ProcessSignal = 'SIGINT' | 'SIGTERM';

export interface ProcessSignalHost {
  on(event: ProcessSignal, listener: () => void): unknown;
  off(event: ProcessSignal, listener: () => void): unknown;
}

export interface ReadlineSignalHost {
  on(event: 'SIGINT', listener: () => void): unknown;
  off(event: 'SIGINT', listener: () => void): unknown;
}

export interface ProcessInterruptSignal {
  readonly signal: AbortSignal;
  received(): ProcessSignal | undefined;
  dispose(): void;
}

export function createProcessInterruptSignal(options: {
  host?: ProcessSignalHost;
  input?: ReadlineSignalHost;
  onInterrupt?: (signal: ProcessSignal) => void;
} = {}): ProcessInterruptSignal {
  const host = options.host ?? process;
  const controller = new AbortController();
  let received: ProcessSignal | undefined;

  const interrupt = (signal: ProcessSignal): void => {
    if (controller.signal.aborted) return;
    received = signal;
    controller.abort(new Error(`process interrupted by ${signal}`));
    options.onInterrupt?.(signal);
  };
  const onSigint = (): void => interrupt('SIGINT');
  const onSigterm = (): void => interrupt('SIGTERM');
  host.on('SIGINT', onSigint);
  host.on('SIGTERM', onSigterm);
  options.input?.on('SIGINT', onSigint);

  return {
    signal: controller.signal,
    received: () => received,
    dispose: () => {
      host.off('SIGINT', onSigint);
      host.off('SIGTERM', onSigterm);
      options.input?.off('SIGINT', onSigint);
    },
  };
}

export async function persistInterruptedGoal(options: {
  goalId: string;
  store: { recordState(state: 'blocked', at: string): Promise<void> };
  bus: { emit(event: { type: 'goal_state'; goalId: string; state: 'blocked' }): void };
  now?: () => Date;
}): Promise<void> {
  const at = (options.now ?? (() => new Date()))().toISOString();
  await options.store.recordState('blocked', at);
  options.bus.emit({ type: 'goal_state', goalId: options.goalId, state: 'blocked' });
}
