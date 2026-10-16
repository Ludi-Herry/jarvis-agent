/**
 * Time budgets for tests that start real CLI processes (`node --import tsx …`).
 *
 * One such start takes about 1.5 s on an idle GitHub Windows runner and several times that
 * while the other Vitest workers are starting processes too, so budgets sized on Linux turned
 * into random Windows timeouts — a different test on each run. Windows therefore gets four
 * times the budget; Linux and macOS keep the original numbers. Only waiting time changes,
 * never an assertion, and every child process keeps a hard timeout of its own.
 */
const WINDOWS_SPAWN_SLOWDOWN = 4;

export function spawnBudget(ms: number): number {
  return process.platform === 'win32' ? ms * WINDOWS_SPAWN_SLOWDOWN : ms;
}
