import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/runtime/permission/decide.js';
import {
  JarvisConfigError,
  buildConfigPermissionPolicy,
  resolveJarvisConfig,
  type ResolveJarvisConfigInput,
} from '../../src/runtime/config/index.js';

const cwd = 'workspace';
const userHome = 'home';
const userConfigPath = join(userHome, '.jarvis', 'config.toml');
const projectConfigPath = join(cwd, '.jarvis', 'config.toml');
const projectLocalConfigPath = join(cwd, '.jarvis', 'config.local.toml');

type FileFixture = string | Error;

function missingFile(): Error {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

function fixtureInput(
  files: Record<string, FileFixture> = {},
  overrides: Partial<Omit<ResolveJarvisConfigInput, 'cwd' | 'userHome' | 'readText'>> = {},
): { input: ResolveJarvisConfigInput; reads: string[] } {
  const reads: string[] = [];
  return {
    input: {
      cwd,
      userHome,
      env: {},
      cli: {},
      readText: async (path) => {
        reads.push(path);
        const fixture = files[path];
        if (fixture === undefined) throw missingFile();
        if (fixture instanceof Error) throw fixture;
        return fixture;
      },
      ...overrides,
    },
    reads,
  };
}

async function expectConfigFailure(work: () => Promise<unknown>): Promise<JarvisConfigError> {
  try {
    await work();
  } catch (error) {
    expect(error).toBeInstanceOf(JarvisConfigError);
    return error as JarvisConfigError;
  }
  throw new Error('Expected configuration resolution to fail');
}

describe('resolveJarvisConfig', () => {
  it('resolves values by precedence and records their JSON-safe sources', async () => {
    const { input } = fixtureInput(
      {
        [userConfigPath]: [
          'schemaVersion = 1',
          'preset = "inspect"',
          '',
          '[model]',
          'id = "user-model"',
          'baseURL = "https://user.example/v1"',
          '',
          '[permissions]',
          'network = "deny"',
        ].join('\n'),
        [projectConfigPath]: ['schemaVersion = 1', '', '[permissions]', 'writesFiles = "deny"'].join('\n'),
        [projectLocalConfigPath]: ['schemaVersion = 1', '', '[permissions]', 'executesCode = "deny"'].join('\n'),
      },
      {
        env: { ARK_MODEL: 'env-model', ARK_BASE_URL: 'https://env.example/v1' },
        cli: { model: 'cli-model', baseURL: 'https://cli.example/v1', preset: 'safe' },
      },
    );

    const config = await resolveJarvisConfig(input);

    expect(config).toMatchObject({
      schemaVersion: 1,
      provider: 'doubao',
      model: 'cli-model',
      baseURL: 'https://cli.example/v1',
      preset: 'safe',
      sources: {
        provider: 'built-in',
        model: 'cli',
        baseURL: 'cli',
        preset: 'cli',
      },
    });
    expect(config.permissions.deniedCapabilities).toEqual(['writes-files', 'executes-code', 'network']);
    expect(config.permissions.sources).toEqual({
      'writes-files': ['project'],
      'executes-code': ['project-local'],
      network: ['user'],
    });
    expect(config.files).toEqual([
      { layer: 'user', path: userConfigPath, status: 'loaded' },
      { layer: 'project', path: projectConfigPath, status: 'loaded' },
      { layer: 'project-local', path: projectLocalConfigPath, status: 'loaded' },
    ]);
    expect(JSON.parse(JSON.stringify(config))).toEqual(config);
  });

  it('uses nonblank environment compatibility fields over user fields, while blank values do not override', async () => {
    const { input } = fixtureInput(
      {
        [userConfigPath]: [
          'schemaVersion = 1',
          '',
          '[model]',
          'id = "user-model"',
          'baseURL = "https://user.example/v1"',
        ].join('\n'),
      },
      { env: { ARK_MODEL: 'env-model', ARK_BASE_URL: '   ' } },
    );

    const config = await resolveJarvisConfig(input);

    expect(config.model).toBe('env-model');
    expect(config.sources.model).toBe('environment');
    expect(config.baseURL).toBe('https://user.example/v1');
    expect(config.sources.baseURL).toBe('user');
  });

  it('rejects project-layer model/preset fields and attempts to widen a permission', async () => {
    const withPreset = fixtureInput({
      [projectConfigPath]: 'schemaVersion = 1\npreset = "safe"',
    });
    await expect(expectConfigFailure(() => resolveJarvisConfig(withPreset.input))).resolves.toMatchObject({
      code: 'project-scope',
    });

    const withWidening = fixtureInput({
      [projectLocalConfigPath]: ['schemaVersion = 1', '', '[permissions]', 'readOnly = "allow"'].join('\n'),
    });
    await expect(expectConfigFailure(() => resolveJarvisConfig(withWidening.input))).resolves.toMatchObject({
      code: 'invalid-value',
    });
  });

  it('rejects credential-like keys case- and separator-insensitively without exposing the credential value', async () => {
    const credential = 'do-not-echo-this-value';
    const { input } = fixtureInput({
      [userConfigPath]: `schemaVersion = 1\napi_key = "${credential}"`,
    });

    const error = await expectConfigFailure(() => resolveJarvisConfig(input));

    expect(error.code).toBe('credential-key');
    expect(error.message).not.toContain(credential);
    expect(JSON.stringify(error)).not.toContain(credential);

    const dottedKey = fixtureInput({
      [userConfigPath]: `schemaVersion = 1\nApi.Key = "${credential}"`,
    });
    const dottedError = await expectConfigFailure(() => resolveJarvisConfig(dottedKey.input));
    expect(dottedError.code).toBe('credential-key');
    expect(dottedError.message).not.toContain(credential);
  });

  it('warns for unknown keys by default and rejects them in strict mode', async () => {
    const files = { [userConfigPath]: 'schemaVersion = 1\nextraOption = true' };
    const relaxed = fixtureInput(files);
    const config = await resolveJarvisConfig(relaxed.input);

    expect(config.warnings).toEqual([
      { code: 'unknown-key', file: 'user', keyPath: 'extraOption' },
    ]);

    const strict = fixtureInput(files, { strict: true });
    await expect(expectConfigFailure(() => resolveJarvisConfig(strict.input))).resolves.toMatchObject({
      code: 'unknown-key',
    });
  });

  it('does not read the user path when ignoreUser is set and records that boundary', async () => {
    const { input, reads } = fixtureInput(
      { [userConfigPath]: 'schemaVersion = 1\npreset = "inspect"' },
      { ignoreUser: true },
    );

    const config = await resolveJarvisConfig(input);

    expect(reads).not.toContain(userConfigPath);
    expect(reads).toEqual([projectConfigPath, projectLocalConfigPath]);
    expect(config.files[0]).toEqual({ layer: 'user', path: userConfigPath, status: 'ignored' });
    expect(config.preset).toBeNull();
  });

  it('fails closed for malformed TOML and non-ENOENT read failures', async () => {
    const malformed = fixtureInput({ [userConfigPath]: 'schemaVersion =' });
    await expect(expectConfigFailure(() => resolveJarvisConfig(malformed.input))).resolves.toMatchObject({
      code: 'parse',
    });

    const unreadable = Object.assign(new Error('access denied'), { code: 'EACCES' });
    const unreadableFixture = fixtureInput({ [projectConfigPath]: unreadable });
    await expect(expectConfigFailure(() => resolveJarvisConfig(unreadableFixture.input))).resolves.toMatchObject({
      code: 'read',
    });
  });

  it('validates base URLs and model ids at every accepted source', async () => {
    const badProtocol = fixtureInput(
      { [userConfigPath]: 'schemaVersion = 1\n[model]\nbaseURL = "ftp://example.test"' },
    );
    await expect(expectConfigFailure(() => resolveJarvisConfig(badProtocol.input))).resolves.toMatchObject({
      code: 'invalid-value',
    });

    const embeddedCredential = fixtureInput(
      { [userConfigPath]: 'schemaVersion = 1\n[model]\nbaseURL = "https://name:pass@example.test"' },
    );
    await expect(expectConfigFailure(() => resolveJarvisConfig(embeddedCredential.input))).resolves.toMatchObject({
      code: 'invalid-value',
    });

    for (const baseURL of ['https://example.test/v1?token=secret', 'https://example.test/v1#secret']) {
      const hiddenCredentialChannel = fixtureInput(
        { [userConfigPath]: `schemaVersion = 1\n[model]\nbaseURL = "${baseURL}"` },
      );
      await expect(expectConfigFailure(() => resolveJarvisConfig(hiddenCredentialChannel.input))).resolves.toMatchObject({
        code: 'invalid-value',
      });
    }

    const emptyCliModel = fixtureInput({}, { cli: { model: '   ' } });
    await expect(expectConfigFailure(() => resolveJarvisConfig(emptyCliModel.input))).resolves.toMatchObject({
      code: 'invalid-value',
    });

    const longCliModel = fixtureInput({}, { cli: { model: 'm'.repeat(257) } });
    await expect(expectConfigFailure(() => resolveJarvisConfig(longCliModel.input))).resolves.toMatchObject({
      code: 'invalid-value',
    });
  });

  it('rejects control-bearing or unbounded provider endpoints', async () => {
    for (const baseURL of [
      'https://example.test/a\nb',
      `https://example.test/${'x'.repeat(2_048)}`,
    ]) {
      const fixture = fixtureInput({}, { cli: { baseURL } });
      await expect(expectConfigFailure(() => resolveJarvisConfig(fixture.input))).resolves.toMatchObject({
        code: 'invalid-value',
      });
    }
  });

  it('rejects oversized config text before parsing it', async () => {
    const fixture = fixtureInput({
      [projectConfigPath]: `schemaVersion = 1\n# ${'x'.repeat(300_000)}`,
    });

    await expect(expectConfigFailure(() => resolveJarvisConfig(fixture.input))).resolves.toMatchObject({
      code: 'invalid-value',
    });
  });

  it('bounds unknown-key warning count and key length in non-strict mode', async () => {
    const tooMany = Array.from({ length: 65 }, (_, index) => `unknown${index} = true`).join('\n');
    const manyFixture = fixtureInput({
      [projectConfigPath]: `schemaVersion = 1\n${tooMany}`,
    });
    const longFixture = fixtureInput({
      [projectConfigPath]: `schemaVersion = 1\n"${'k'.repeat(257)}" = true`,
    });

    await expect(expectConfigFailure(() => resolveJarvisConfig(manyFixture.input))).resolves.toMatchObject({
      code: 'invalid-value',
    });
    await expect(expectConfigFailure(() => resolveJarvisConfig(longFixture.input))).resolves.toMatchObject({
      code: 'invalid-value',
    });
  });

  it.each(['__proto__', 'constructor', 'toString'])(
    'treats inherited object property names as unknown permission keys: %s',
    async (key) => {
      const text = `schemaVersion = 1\n[permissions]\n"${key}" = "deny"`;
      const relaxed = fixtureInput({ [projectConfigPath]: text });
      const strict = fixtureInput({ [projectConfigPath]: text }, { strict: true });

      const config = await resolveJarvisConfig(relaxed.input);
      expect(config.permissions.deniedCapabilities).toEqual([]);
      expect(config.warnings).toContainEqual({
        code: 'unknown-key',
        file: 'project',
        keyPath: `permissions.${key}`,
      });
      await expect(expectConfigFailure(() => resolveJarvisConfig(strict.input))).resolves.toMatchObject({
        code: 'unknown-key',
      });
    },
  );

  it('accumulates permission denies from every layer without a later widening path', async () => {
    const { input } = fixtureInput({
      [userConfigPath]: ['schemaVersion = 1', '', '[permissions]', 'writesFiles = "deny"'].join('\n'),
      [projectConfigPath]: ['schemaVersion = 1', '', '[permissions]', 'writesFiles = "deny"'].join('\n'),
      [projectLocalConfigPath]: ['schemaVersion = 1', '', '[permissions]', 'network = "deny"'].join('\n'),
    });

    const config = await resolveJarvisConfig(input);

    expect(config.permissions.deniedCapabilities).toEqual(['writes-files', 'network']);
    expect(config.permissions.sources['writes-files']).toEqual(['user', 'project']);
    expect(config.permissions.sources.network).toEqual(['project-local']);
  });
});

describe('buildConfigPermissionPolicy', () => {
  it('applies inspect/safe defaults and removes allow rules under either preset', async () => {
    const inspectInput = fixtureInput({ [userConfigPath]: 'schemaVersion = 1\npreset = "inspect"' });
    const inspectConfig = await resolveJarvisConfig(inspectInput.input);
    const rules = [
      { action: 'allow' as const, tool: 'write', pattern: 'src/*' },
      { action: 'deny' as const, tool: 'write', pattern: '*.env' },
    ];
    const inspectPolicy = buildConfigPermissionPolicy(inspectConfig, rules);

    expect(inspectPolicy.capabilityDefault).toEqual({
      'read-only': 'allow',
      'writes-files': 'deny',
      'executes-code': 'deny',
      network: 'deny',
    });
    expect(inspectPolicy.rules).toEqual([rules[1]]);

    const safeInput = fixtureInput({ [userConfigPath]: 'schemaVersion = 1\npreset = "safe"' });
    const safeConfig = await resolveJarvisConfig(safeInput.input);
    const safePolicy = buildConfigPermissionPolicy(safeConfig, rules);

    expect(safePolicy.capabilityDefault).toEqual({
      'read-only': 'allow',
      'writes-files': 'ask',
      'executes-code': 'ask',
      network: 'ask',
    });
    expect(safePolicy.rules).toEqual([rules[1]]);
  });

  it('places configured capability denies before existing allow rules', async () => {
    const { input } = fixtureInput({
      [userConfigPath]: ['schemaVersion = 1', '', '[permissions]', 'writesFiles = "deny"'].join('\n'),
    });
    const config = await resolveJarvisConfig(input);
    const policy = buildConfigPermissionPolicy(config, [
      { action: 'allow', tool: 'write', pattern: 'src/*' },
    ]);

    expect(policy.capabilityDefault['writes-files']).toBe('deny');
    expect(decide({ toolName: 'write', capability: 'writes-files', args: { path: 'src/app.ts' } }, policy)).toMatchObject({
      action: 'deny',
      source: 'capability',
    });
  });
});
