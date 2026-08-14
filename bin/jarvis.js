#!/usr/bin/env node
import 'tsx/esm';

const { runJarvisCli } = await import('../src/surfaces/cli/jarvis.ts');
await runJarvisCli();
