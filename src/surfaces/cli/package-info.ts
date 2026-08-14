import { readFileSync } from 'node:fs';

interface PackageInfo {
  name: string;
  version: string;
}

function loadPackageInfo(): PackageInfo {
  const parsed = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as Partial<PackageInfo>;
  if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
    throw new Error('package.json is missing name or version');
  }
  return { name: parsed.name, version: parsed.version };
}

export const JARVIS_PACKAGE = loadPackageInfo();
export const JARVIS_VERSION = JARVIS_PACKAGE.version;
