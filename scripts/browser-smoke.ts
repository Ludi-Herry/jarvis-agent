/**
 * Manual fixed static browser smoke.
 *
 * Runs the builder-only browser_smoke tool against the current cwd. It is feedback/manual evidence
 * only: it does not write verifier reports and cannot mark a goal complete.
 *
 * Run: npm run sandbox:browser-smoke
 * Optional trusted launch env: JARVIS_BROWSER_SMOKE_BROWSER=/usr/bin/chromium
 */
import { createBrowserSmokeTool } from '../src/core/index.js';
import { createWsl2UnshareSandboxRunner } from '../src/runtime/index.js';

async function main(): Promise<void> {
  const tool = createBrowserSmokeTool({
    runner: createWsl2UnshareSandboxRunner({ retainTempDirs: true }),
    browserExecutable: process.env.JARVIS_BROWSER_SMOKE_BROWSER?.trim() || undefined,
  });

  const result = await tool.run(
    { profile: 'static-dist', reason: 'manual fixed static browser smoke' },
    { cwd: process.cwd() },
  );

  if (result.content.trim() !== '') console.log(result.content);
  if (result.error) console.error(result.error);

  const status = statusFromContent(result.content);
  if (status === 'passed') {
    console.log('\n=== browser smoke PASSED ===');
    return;
  }
  if (status === 'unavailable') {
    console.log('\n=== browser smoke SKIPPED: browser unavailable ===');
    return;
  }

  console.log('\n=== browser smoke FAILED ===');
  process.exitCode = 1;
}

function statusFromContent(content: string): string | undefined {
  const match = /^\[status: ([^\]]+)\]$/m.exec(content);
  return match?.[1];
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
