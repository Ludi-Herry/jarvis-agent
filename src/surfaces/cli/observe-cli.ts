import { resolve } from 'node:path';
import { formatObservationReport, loadWorkspaceObservation } from '../../capabilities/index.js';
import { safeInline } from './approval.js';
import { parseObserveArgs } from './observe-args.js';

async function main(): Promise<void> {
  let args;
  try {
    args = parseObserveArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const dataDir = resolve(process.cwd(), args.dataDir ?? 'data');
  try {
    const report = await loadWorkspaceObservation(dataDir);
    if (args.format === 'json') {
      console.log(JSON.stringify(report, null, 2));
    } else {
      process.stdout.write(formatObservationReport(report));
      console.log(`source: ${safeInline(dataDir)}`);
    }
  } catch (err) {
    console.error(`[observe] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error('\n[observe] fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
