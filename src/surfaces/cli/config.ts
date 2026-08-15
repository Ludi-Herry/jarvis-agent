import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  buildConfigPermissionPolicy,
  resolveJarvisConfig,
  type ConfigTextReader,
  type ResolvedConfigFile,
  type ResolvedJarvisConfig,
} from '../../runtime/config/index.js';
import { safeInline } from './approval.js';
import type { ConfigCliOptions } from './config-options.js';

export const CONFIG_AUTHORITY = Object.freeze({
  mode: 'observation-only' as const,
  canCompleteGoals: false as const,
  canCompleteLoops: false as const,
});

export interface LoadCliConfigInput {
  cwd: string;
  options: ConfigCliOptions;
  env?: Readonly<Record<string, string | undefined>>;
  userHome?: string;
  readText?: ConfigTextReader;
}

export interface ConfigInspectionReport {
  schemaVersion: 1;
  authority: typeof CONFIG_AUTHORITY;
  effective: {
    provider: 'doubao';
    model: string;
    baseURL: string;
    preset: 'inspect' | 'safe' | null;
    permissions: {
      readOnly: string;
      writesFiles: string;
      executesCode: string;
      network: string;
    };
  };
  files: ResolvedConfigFile[];
  warnings: ResolvedJarvisConfig['warnings'];
  sources?: {
    values: ResolvedJarvisConfig['sources'];
    permissionDenies: ResolvedJarvisConfig['permissions']['sources'];
  };
}

export async function loadCliConfig(input: LoadCliConfigInput): Promise<ResolvedJarvisConfig> {
  return resolveJarvisConfig({
    cwd: input.cwd,
    userHome: input.userHome ?? homedir(),
    env: input.env ?? process.env,
    cli: {
      ...(input.options.model === undefined ? {} : { model: input.options.model }),
      ...(input.options.baseURL === undefined ? {} : { baseURL: input.options.baseURL }),
      ...(input.options.preset === undefined ? {} : { preset: input.options.preset }),
    },
    strict: input.options.strict,
    ignoreUser: input.options.ignoreUser,
    readText: input.readText ?? ((path) => readFile(path, 'utf8')),
  });
}

/** Bind explicit typed-config changes into the existing system-prompt hash without schema changes. */
export function appendConfigPermissionBoundary(prompt: string, config: ResolvedJarvisConfig): string {
  const fields: string[] = [];
  if (config.preset !== null || config.permissions.deniedCapabilities.length > 0) {
    const policy = buildConfigPermissionPolicy(config);
    fields.push(
      `preset=${config.preset ?? 'none'}`,
      `read-only=${policy.capabilityDefault['read-only']}`,
      `writes-files=${policy.capabilityDefault['writes-files']}`,
      `executes-code=${policy.capabilityDefault['executes-code']}`,
      `network=${policy.capabilityDefault.network}`,
    );
  }
  if (
    config.sources.model === 'user'
    || config.sources.model === 'cli'
    || config.sources.baseURL === 'user'
    || config.sources.baseURL === 'environment'
    || config.sources.baseURL === 'cli'
  ) {
    const identity = createHash('sha256')
      .update(JSON.stringify({ provider: config.provider, model: config.model, baseURL: config.baseURL }))
      .digest('hex');
    fields.push(`identity-sha256=${identity}`);
  }
  if (fields.length === 0) return prompt;
  return `${prompt}\n[jarvis-config-v1] ${fields.join('; ')}`;
}

export function buildConfigInspectionReport(
  config: ResolvedJarvisConfig,
  includeSources: boolean,
): ConfigInspectionReport {
  const policy = buildConfigPermissionPolicy(config);
  return {
    schemaVersion: 1,
    authority: CONFIG_AUTHORITY,
    effective: {
      provider: config.provider,
      model: config.model,
      baseURL: config.baseURL,
      preset: config.preset,
      permissions: {
        readOnly: policy.capabilityDefault['read-only'],
        writesFiles: policy.capabilityDefault['writes-files'],
        executesCode: policy.capabilityDefault['executes-code'],
        network: policy.capabilityDefault.network,
      },
    },
    files: config.files,
    warnings: config.warnings,
    ...(includeSources
      ? {
          sources: {
            values: config.sources,
            permissionDenies: config.permissions.sources,
          },
        }
      : {}),
  };
}

export function formatConfigInspectionReport(report: ConfigInspectionReport): string {
  const sourceFor = (field: keyof ResolvedJarvisConfig['sources']): string =>
    report.sources === undefined ? '' : ` (${safeInline(report.sources.values[field])})`;
  const lines = [
    `Jarvis config v${report.schemaVersion} [observation-only]`,
    `provider: ${safeInline(report.effective.provider)}${sourceFor('provider')}`,
    `model: ${safeInline(report.effective.model)}${sourceFor('model')}`,
    `baseURL: ${safeInline(report.effective.baseURL)}${sourceFor('baseURL')}`,
    `preset: ${safeInline(report.effective.preset ?? 'none')}${sourceFor('preset')}`,
    'permissions:',
    `  readOnly: ${safeInline(report.effective.permissions.readOnly)}`,
    `  writesFiles: ${safeInline(report.effective.permissions.writesFiles)}`,
    `  executesCode: ${safeInline(report.effective.permissions.executesCode)}`,
    `  network: ${safeInline(report.effective.permissions.network)}`,
    'files:',
    ...report.files.map((file) =>
      `  ${safeInline(file.layer)}: ${safeInline(file.status)} ${safeInline(file.path)}`),
  ];
  if (report.warnings.length > 0) {
    lines.push('warnings:');
    lines.push(...report.warnings.map((warning) =>
      `  ${safeInline(warning.file)}: unknown key ${safeInline(warning.keyPath)}`));
  }
  return `${lines.join('\n')}\n`;
}

export function reportConfigWarnings(
  config: ResolvedJarvisConfig,
  write: (line: string) => unknown = (line) => process.stderr.write(line),
): void {
  for (const warning of config.warnings) {
    write(`[config] ${safeInline(warning.file)} contains unknown key ${safeInline(warning.keyPath)}\n`);
  }
}
