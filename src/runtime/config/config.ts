/**
 * Typed, credential-free configuration resolution for the CLI-first v0.1 surface.
 *
 * This module deliberately owns no filesystem access. Callers pass a reader so the
 * precedence and trust boundary stay testable as pure orchestration: a project can
 * only add permission denies, and credentials can never enter the returned shape.
 */
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { DEFAULT_ARK_MODEL } from '../../core/model/config.js';
import { DEFAULT_ARK_BASE_URL } from '../../core/model/doubao-provider.js';
import type { ToolCapability } from '../../core/tools/types.js';
import {
  defaultPolicy,
  type PermissionAction,
  type PermissionPolicy,
  type PermissionRule,
} from '../permission/decide.js';

/** The only preset names admitted by the v0.1 typed TOML schema. */
export type ConfigPresetName = 'inspect' | 'safe';

/** Raw CLI values before this module validates and resolves them. */
export interface ConfigCliOverrides {
  model?: string;
  baseURL?: string;
  preset?: string;
}

/** A minimal, injectable view of the compatibility environment. */
export type ConfigEnvironment = Readonly<Record<string, string | undefined>>;

/** The sole I/O boundary. `ENOENT` means absent; every other failure is fail-closed. */
export type ConfigTextReader = (path: string) => string | Promise<string>;

export interface ResolveJarvisConfigInput {
  cwd: string;
  userHome: string;
  env: ConfigEnvironment;
  cli: ConfigCliOverrides;
  strict?: boolean;
  ignoreUser?: boolean;
  readText: ConfigTextReader;
}

export type ConfigFileLayer = 'user' | 'project' | 'project-local';
export type ConfigFileStatus = 'loaded' | 'absent' | 'ignored';

/** A receipt for every configured location, including locations deliberately ignored. */
export interface ResolvedConfigFile {
  layer: ConfigFileLayer;
  path: string;
  status: ConfigFileStatus;
}

/** The sources eligible to set ordinary model/preset fields. */
export type ConfigValueSource = 'built-in' | 'user' | 'environment' | 'cli';

export interface ConfigValueSources {
  provider: ConfigValueSource;
  model: ConfigValueSource;
  baseURL: ConfigValueSource;
  preset: ConfigValueSource;
}

export interface ConfigWarning {
  code: 'unknown-key';
  file: ConfigFileLayer;
  keyPath: string;
}

export interface ResolvedConfigPermissions {
  /** Capability ceilings accumulated from user, project, and project-local TOML. */
  deniedCapabilities: ToolCapability[];
  /** Every layer that contributed each deny, in precedence-read order. */
  sources: Partial<Record<ToolCapability, ConfigFileLayer[]>>;
}

/**
 * JSON-safe effective configuration. It intentionally has no credential field, and this resolver
 * never reads `ARK_API_KEY`.
 */
export interface ResolvedJarvisConfig {
  schemaVersion: 1;
  provider: 'doubao';
  model: string;
  baseURL: string;
  /** `null` means the built-in PermissionGate default policy remains selected. */
  preset: ConfigPresetName | null;
  sources: ConfigValueSources;
  permissions: ResolvedConfigPermissions;
  files: ResolvedConfigFile[];
  warnings: ConfigWarning[];
}

export type JarvisConfigErrorCode =
  | 'read'
  | 'parse'
  | 'type'
  | 'schema'
  | 'invalid-value'
  | 'project-scope'
  | 'credential-key'
  | 'unknown-key';

/** An intentionally value-free error for TOML trust-boundary failures. */
export class JarvisConfigError extends Error {
  readonly code: JarvisConfigErrorCode;
  readonly path?: string;

  constructor(code: JarvisConfigErrorCode, message: string, path?: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'JarvisConfigError';
    this.code = code;
    this.path = path;
  }
}

/** Model ids are identifiers, never opaque unbounded payloads. */
export const MAX_MODEL_ID_LENGTH = 256;
export const MAX_BASE_URL_LENGTH = 2_048;
export const MAX_CONFIG_TEXT_LENGTH = 256 * 1_024;
export const MAX_CONFIG_WARNINGS_PER_FILE = 64;
export const MAX_CONFIG_KEY_PATH_LENGTH = 256;

const CAPABILITIES: readonly ToolCapability[] = [
  'read-only',
  'writes-files',
  'executes-code',
  'network',
];

const PERMISSION_KEYS: Readonly<Record<string, ToolCapability>> = {
  readOnly: 'read-only',
  writesFiles: 'writes-files',
  executesCode: 'executes-code',
  network: 'network',
};

const ROOT_KEYS = new Set(['schemaVersion', 'preset', 'model', 'permissions']);
const MODEL_KEYS = new Set(['id', 'baseURL']);
const PRESET_NAMES = new Set<ConfigPresetName>(['inspect', 'safe']);

/**
 * Presets only choose the built-in capability matrix. User/project TOML permission denies are
 * applied afterwards and therefore cannot be widened by a preset or configured allow rule.
 */
export const CONFIG_PRESETS: Readonly<Record<ConfigPresetName, Readonly<Record<ToolCapability, PermissionAction>>>> = {
  inspect: {
    'read-only': 'allow',
    'writes-files': 'deny',
    'executes-code': 'deny',
    network: 'deny',
  },
  safe: {
    'read-only': 'allow',
    'writes-files': 'ask',
    'executes-code': 'ask',
    network: 'ask',
  },
};

interface ParsedLayer {
  file: ResolvedConfigFile;
  preset?: ConfigPresetName;
  model?: ParsedModel;
  deniedCapabilities: ToolCapability[];
  warnings: ConfigWarning[];
}

interface ParsedModel {
  id?: string;
  baseURL?: string;
}

interface FileSpec {
  layer: ConfigFileLayer;
  path: string;
}

/**
 * Resolve the built-in defaults, optional TOML layers, compatibility environment, and CLI flags.
 * The only permitted read is `input.readText`; `ignoreUser` returns before that reader is called.
 */
export async function resolveJarvisConfig(input: ResolveJarvisConfigInput): Promise<ResolvedJarvisConfig> {
  const files: FileSpec[] = [
    { layer: 'user', path: join(input.userHome, '.jarvis', 'config.toml') },
    { layer: 'project', path: join(input.cwd, '.jarvis', 'config.toml') },
    { layer: 'project-local', path: join(input.cwd, '.jarvis', 'config.local.toml') },
  ];

  const user = await loadLayer(files[0], input);
  const project = await loadLayer(files[1], input);
  const projectLocal = await loadLayer(files[2], input);
  const layers = [user, project, projectLocal];

  let model = DEFAULT_ARK_MODEL;
  let baseURL = DEFAULT_ARK_BASE_URL;
  let preset: ConfigPresetName | null = null;
  const sources: ConfigValueSources = {
    provider: 'built-in',
    model: 'built-in',
    baseURL: 'built-in',
    preset: 'built-in',
  };

  if (user.model?.id !== undefined) {
    model = user.model.id;
    sources.model = 'user';
  }
  if (user.model?.baseURL !== undefined) {
    baseURL = user.model.baseURL;
    sources.baseURL = 'user';
  }
  if (user.preset !== undefined) {
    preset = user.preset;
    sources.preset = 'user';
  }

  const environmentModel = nonblankEnvironmentValue(input.env.ARK_MODEL);
  if (environmentModel !== undefined) {
    model = validateModelId(environmentModel, 'ARK_MODEL');
    sources.model = 'environment';
  }
  const environmentBaseURL = nonblankEnvironmentValue(input.env.ARK_BASE_URL);
  if (environmentBaseURL !== undefined) {
    baseURL = validateBaseURL(environmentBaseURL, 'ARK_BASE_URL');
    sources.baseURL = 'environment';
  }

  if (input.cli.model !== undefined) {
    model = validateModelId(input.cli.model, 'CLI model');
    sources.model = 'cli';
  }
  if (input.cli.baseURL !== undefined) {
    baseURL = validateBaseURL(input.cli.baseURL, 'CLI base URL');
    sources.baseURL = 'cli';
  }
  if (input.cli.preset !== undefined) {
    preset = validatePreset(input.cli.preset, 'CLI preset');
    sources.preset = 'cli';
  }

  const permissions = collectPermissionDenies(layers);
  return {
    schemaVersion: 1,
    provider: 'doubao',
    model,
    baseURL,
    preset,
    sources,
    permissions,
    files: layers.map((layer) => layer.file),
    warnings: layers.flatMap((layer) => layer.warnings),
  };
}

/**
 * Derive the PermissionGate policy from a resolved configuration. The caller supplies existing
 * B5 rules; inspect/safe discard every allow rule, and config-level capability denies are written
 * to `capabilityDefault` so `decide` evaluates them before rules.
 */
export function buildConfigPermissionPolicy(
  config: ResolvedJarvisConfig,
  rules: PermissionRule[] = [],
): PermissionPolicy {
  const base = defaultPolicy();
  const presetDefaults = config.preset === null ? base.capabilityDefault : CONFIG_PRESETS[config.preset];
  const capabilityDefault: Record<ToolCapability, PermissionAction> = {
    ...base.capabilityDefault,
    ...presetDefaults,
  };

  for (const capability of config.permissions.deniedCapabilities) {
    capabilityDefault[capability] = 'deny';
  }

  const effectiveRules =
    config.preset === null ? rules : rules.filter((rule) => rule.action === 'deny');

  return {
    sensitivePaths: [...base.sensitivePaths],
    capabilityDefault,
    rules: effectiveRules.map((rule) => ({ ...rule })),
  };
}

async function loadLayer(spec: FileSpec, input: ResolveJarvisConfigInput): Promise<ParsedLayer> {
  if (spec.layer === 'user' && input.ignoreUser === true) {
    return emptyLayer(spec, 'ignored');
  }

  let text: string;
  try {
    text = await input.readText(spec.path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return emptyLayer(spec, 'absent');
    throw new JarvisConfigError('read', `Could not read configuration file ${spec.path}`, spec.path, error);
  }

  if (typeof text !== 'string') {
    throw new JarvisConfigError('read', `Configuration reader returned invalid text for ${spec.path}`, spec.path);
  }
  if (text.length > MAX_CONFIG_TEXT_LENGTH) {
    throw new JarvisConfigError('invalid-value', `Configuration file ${spec.path} exceeds the size limit`, spec.path);
  }

  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch {
    // Parser messages can echo snippets from TOML; keep config values out of errors entirely.
    throw new JarvisConfigError('parse', `Could not parse configuration file ${spec.path}`, spec.path);
  }

  if (!isTomlTable(parsed)) {
    throw new JarvisConfigError('type', `Configuration file ${spec.path} must contain a TOML table`, spec.path);
  }

  assertNoCredentialLikeKey(parsed, spec);
  return validateLayer(parsed, spec, input.strict === true);
}

function emptyLayer(spec: FileSpec, status: Extract<ConfigFileStatus, 'absent' | 'ignored'>): ParsedLayer {
  return {
    file: { layer: spec.layer, path: spec.path, status },
    deniedCapabilities: [],
    warnings: [],
  };
}

function validateLayer(root: Record<string, unknown>, spec: FileSpec, strict: boolean): ParsedLayer {
  validateSchemaVersion(root, spec);

  if (spec.layer !== 'user' && (hasOwn(root, 'model') || hasOwn(root, 'preset'))) {
    throw new JarvisConfigError(
      'project-scope',
      `Configuration file ${spec.path} may not set model or preset`,
      spec.path,
    );
  }

  const warnings: ConfigWarning[] = [];
  for (const key of Object.keys(root)) {
    if (!ROOT_KEYS.has(key)) addUnknownWarning(warnings, spec, key, strict);
  }

  const model = spec.layer === 'user' ? validateModel(root, spec, warnings, strict) : undefined;
  const preset = spec.layer === 'user' ? validateLayerPreset(root, spec) : undefined;
  const deniedCapabilities = validatePermissions(root, spec, warnings, strict);

  return {
    file: { layer: spec.layer, path: spec.path, status: 'loaded' },
    ...(model === undefined ? {} : { model }),
    ...(preset === undefined ? {} : { preset }),
    deniedCapabilities,
    warnings,
  };
}

function validateSchemaVersion(root: Record<string, unknown>, spec: FileSpec): void {
  if (!hasOwn(root, 'schemaVersion')) {
    throw new JarvisConfigError('schema', `Configuration file ${spec.path} requires schemaVersion = 1`, spec.path);
  }
  const version = root.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version !== 1) {
    throw new JarvisConfigError('schema', `Configuration file ${spec.path} requires schemaVersion = 1`, spec.path);
  }
}

function validateModel(
  root: Record<string, unknown>,
  spec: FileSpec,
  warnings: ConfigWarning[],
  strict: boolean,
): ParsedModel | undefined {
  if (!hasOwn(root, 'model')) return undefined;
  const rawModel = root.model;
  if (!isTomlTable(rawModel)) {
    throw new JarvisConfigError('type', `model in ${spec.path} must be a TOML table`, spec.path);
  }

  for (const key of Object.keys(rawModel)) {
    if (!MODEL_KEYS.has(key)) addUnknownWarning(warnings, spec, `model.${key}`, strict);
  }

  const model: ParsedModel = {};
  if (hasOwn(rawModel, 'id')) model.id = validateModelId(rawModel.id, `model.id in ${spec.path}`);
  if (hasOwn(rawModel, 'baseURL')) model.baseURL = validateBaseURL(rawModel.baseURL, `model.baseURL in ${spec.path}`);
  return model;
}

function validateLayerPreset(root: Record<string, unknown>, spec: FileSpec): ConfigPresetName | undefined {
  if (!hasOwn(root, 'preset')) return undefined;
  return validatePreset(root.preset, `preset in ${spec.path}`);
}

function validatePermissions(
  root: Record<string, unknown>,
  spec: FileSpec,
  warnings: ConfigWarning[],
  strict: boolean,
): ToolCapability[] {
  if (!hasOwn(root, 'permissions')) return [];
  const rawPermissions = root.permissions;
  if (!isTomlTable(rawPermissions)) {
    throw new JarvisConfigError('type', `permissions in ${spec.path} must be a TOML table`, spec.path);
  }

  const denied = new Set<ToolCapability>();
  for (const [key, value] of Object.entries(rawPermissions)) {
    const capability = hasOwn(PERMISSION_KEYS, key) ? PERMISSION_KEYS[key] : undefined;
    if (capability === undefined) {
      addUnknownWarning(warnings, spec, `permissions.${key}`, strict);
      continue;
    }
    if (value !== 'deny') {
      throw new JarvisConfigError(
        'invalid-value',
        `permissions.${key} in ${spec.path} may only be "deny"`,
        spec.path,
      );
    }
    denied.add(capability);
  }
  return CAPABILITIES.filter((capability) => denied.has(capability));
}

function validateModelId(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new JarvisConfigError('invalid-value', `${field} must be a non-empty model id`);
  }
  const model = value.trim();
  if (model.length === 0 || model.length > MAX_MODEL_ID_LENGTH) {
    throw new JarvisConfigError('invalid-value', `${field} must be a non-empty model id within ${MAX_MODEL_ID_LENGTH} characters`);
  }
  return model;
}

function validateBaseURL(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new JarvisConfigError('invalid-value', `${field} must be an http or https URL without credentials`);
  }
  const baseURL = value.trim();
  if (
    baseURL.length === 0
    || baseURL.length > MAX_BASE_URL_LENGTH
    || containsUnsafeInlineControl(baseURL)
  ) {
    throw new JarvisConfigError('invalid-value', `${field} must be an http or https URL without credentials`);
  }
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new JarvisConfigError('invalid-value', `${field} must be an http or https URL without credentials`);
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new JarvisConfigError('invalid-value', `${field} must be an http or https URL without credentials`);
  }
  return baseURL;
}

function containsUnsafeInlineControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint < 32
      || (codePoint >= 127 && codePoint <= 159)
      || codePoint === 0x2028
      || codePoint === 0x2029
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) return true;
  }
  return false;
}

function validatePreset(value: unknown, field: string): ConfigPresetName {
  if (typeof value !== 'string' || !PRESET_NAMES.has(value as ConfigPresetName)) {
    throw new JarvisConfigError('invalid-value', `${field} must be one of the supported preset names`);
  }
  return value as ConfigPresetName;
}

function collectPermissionDenies(layers: ParsedLayer[]): ResolvedConfigPermissions {
  const sources: Partial<Record<ToolCapability, ConfigFileLayer[]>> = {};
  for (const layer of layers) {
    for (const capability of layer.deniedCapabilities) {
      const capabilitySources = sources[capability] ?? [];
      capabilitySources.push(layer.file.layer);
      sources[capability] = capabilitySources;
    }
  }
  return {
    deniedCapabilities: CAPABILITIES.filter((capability) => sources[capability] !== undefined),
    sources,
  };
}

function addUnknownWarning(
  warnings: ConfigWarning[],
  spec: FileSpec,
  keyPath: string,
  strict: boolean,
): void {
  if (strict) {
    throw new JarvisConfigError('unknown-key', `Configuration file ${spec.path} contains an unknown key`, spec.path);
  }
  if (
    keyPath.length > MAX_CONFIG_KEY_PATH_LENGTH
    || warnings.length >= MAX_CONFIG_WARNINGS_PER_FILE
  ) {
    throw new JarvisConfigError(
      'invalid-value',
      `Configuration file ${spec.path} contains too many or oversized unknown keys`,
      spec.path,
    );
  }
  warnings.push({ code: 'unknown-key', file: spec.layer, keyPath });
}

/** Key-name-only scan: values never reach a credential error or output object. */
function assertNoCredentialLikeKey(value: unknown, spec: FileSpec, ancestorKeys: string[] = []): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoCredentialLikeKey(item, spec, ancestorKeys);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const keyPath = [...ancestorKeys, key];
    if (isCredentialLikeKey(keyPath.join(''))) {
      throw new JarvisConfigError(
        'credential-key',
        `Configuration file ${spec.path} contains a credential-like key`,
        spec.path,
      );
    }
    assertNoCredentialLikeKey(child, spec, keyPath);
  }
}

function isCredentialLikeKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return (
    normalized.includes('apikey') ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('password') ||
    normalized.includes('credential') ||
    normalized.includes('arkapikey')
  );
}

function nonblankEnvironmentValue(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `Date` values are valid TOML values but never valid schema tables. */
function isTomlTable(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.code !== 'string') return undefined;
  return error.code;
}
