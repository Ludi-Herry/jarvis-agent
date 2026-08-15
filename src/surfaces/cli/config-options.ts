export type ConfigPresetName = 'inspect' | 'safe';

export interface ConfigCliOptions {
  strict: boolean;
  ignoreUser: boolean;
  preset?: ConfigPresetName;
  model?: string;
  baseURL?: string;
}

export interface ExtractedConfigCliOptions {
  argv: string[];
  options: ConfigCliOptions;
}

/** Extract root-wide config flags without consuming subcommand-specific arguments. */
export function extractConfigCliOptions(argv: readonly string[]): ExtractedConfigCliOptions {
  const rest: string[] = [];
  const options: ConfigCliOptions = { strict: false, ignoreUser: false };
  let strictSeen = false;
  let ignoreUserSeen = false;
  let presetSeen = false;
  let modelSeen = false;
  let baseURLSeen = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? '';
    if (arg === '--') {
      rest.push(...argv.slice(index));
      break;
    }
    if (arg === '--strict-config') {
      if (strictSeen) throw new Error('--strict-config may only be supplied once');
      strictSeen = true;
      options.strict = true;
      continue;
    }
    if (arg === '--ignore-user-config') {
      if (ignoreUserSeen) throw new Error('--ignore-user-config may only be supplied once');
      ignoreUserSeen = true;
      options.ignoreUser = true;
      continue;
    }
    if (arg === '--safe') {
      if (presetSeen) throw new Error('--safe and --preset cannot be combined');
      presetSeen = true;
      options.preset = 'safe';
      continue;
    }
    if (arg === '--preset' || arg.startsWith('--preset=')) {
      if (presetSeen) throw new Error('--preset may only be supplied once and cannot be combined with --safe');
      presetSeen = true;
      options.preset = parsePreset(optionValue(argv, index, arg, '--preset'));
      if (arg === '--preset') index++;
      continue;
    }
    if (arg === '--model' || arg.startsWith('--model=')) {
      if (modelSeen) throw new Error('--model may only be supplied once');
      modelSeen = true;
      options.model = requiredValue(optionValue(argv, index, arg, '--model'), '--model');
      if (arg === '--model') index++;
      continue;
    }
    if (arg === '--base-url' || arg.startsWith('--base-url=')) {
      if (baseURLSeen) throw new Error('--base-url may only be supplied once');
      baseURLSeen = true;
      options.baseURL = requiredValue(optionValue(argv, index, arg, '--base-url'), '--base-url');
      if (arg === '--base-url') index++;
      continue;
    }
    rest.push(arg);
  }

  return { argv: rest, options };
}

/** Canonical arguments forwarded from the root executable to a legacy child entry point. */
export function configCliOptionsToArgs(options: ConfigCliOptions): string[] {
  const args: string[] = [];
  if (options.strict) args.push('--strict-config');
  if (options.ignoreUser) args.push('--ignore-user-config');
  if (options.preset !== undefined) args.push('--preset', options.preset);
  if (options.model !== undefined) args.push('--model', options.model);
  if (options.baseURL !== undefined) args.push('--base-url', options.baseURL);
  return args;
}

function optionValue(argv: readonly string[], index: number, arg: string, name: string): string {
  const value = arg === name ? argv[index + 1] : arg.slice(name.length + 1);
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function requiredValue(value: string, name: string): string {
  if (value.trim() === '') throw new Error(`${name} requires a value`);
  return value;
}

function parsePreset(value: string): ConfigPresetName {
  if (value === 'inspect' || value === 'safe') return value;
  throw new Error('--preset requires inspect or safe');
}
