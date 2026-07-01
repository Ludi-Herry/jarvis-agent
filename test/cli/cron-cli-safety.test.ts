import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('cron CLI process boundary', () => {
  it('does not load .env before spawning loop-cli children', async () => {
    const source = await readFile('src/surfaces/cli/cron-cli.ts', 'utf8');
    expect(source).not.toContain('process.loadEnvFile');
  });

  it('checks launch-env ARK_API_KEY before spawning npm run loop', async () => {
    const source = await readFile('src/surfaces/cli/cron-cli.ts', 'utf8');
    expect(source).toContain('assertKeyNotInLaunchEnv');
    expect(source).toContain('ARK_KEY_IN_LAUNCH_ENV');
  });
});
