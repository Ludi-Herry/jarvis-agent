import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  COMPLETION_COMMANDS,
  COMPLETION_GLOBAL_FLAGS,
  COMPLETION_SHELLS,
} from '../../src/surfaces/cli/completion.js';
import { CLI_EXIT } from '../../src/surfaces/cli/exit-codes.js';

const repo = process.cwd();
const entry = join(repo, 'src', 'surfaces', 'cli', 'jarvis.ts');

vi.setConfig({ testTimeout: 15_000 });
afterAll(() => vi.resetConfig());
const KEY_SENTINEL = 'ark-sentinel-key-value-never-print';

describe('jarvis completion', () => {
  it('prints a working script shape for each supported shell', async () => {
    const powershell = await runJarvis(['completion', 'powershell']);
    expect(powershell).toMatchObject({ code: 0 });
    expect(powershell.stdout).toContain('Register-ArgumentCompleter');
    expect(powershell.stdout).toContain('-CommandName jarvis');

    const bash = await runJarvis(['completion', 'bash']);
    expect(bash).toMatchObject({ code: 0 });
    expect(bash.stdout).toContain('complete -F _jarvis_completions jarvis');

    const zsh = await runJarvis(['completion', 'zsh']);
    expect(zsh).toMatchObject({ code: 0 });
    expect(zsh.stdout).toContain('#compdef jarvis');
    expect(zsh.stdout).toContain('compdef _jarvis jarvis');

    for (const result of [powershell, bash, zsh]) {
      expect(result.stdout.includes(String.fromCharCode(27))).toBe(false);
      expect(result.stderr).toBe('');
    }
  });

  it('keeps the completion table in sync with the real command tree in both directions', async () => {
    const rootHelp = await runJarvis(['--help']);
    expect(rootHelp.code).toBe(0);
    const helpCommands = parseHelpSection(rootHelp.stdout, 'Commands:');
    const tableCommands = COMPLETION_COMMANDS.map((command) => command.name);

    for (const name of tableCommands) {
      expect(helpCommands, `table command ${name} missing from --help`).toContain(name);
    }
    for (const name of helpCommands) {
      expect(tableCommands, `--help command ${name} missing from the completion table`).toContain(name);
    }

    const scripts = await Promise.all(COMPLETION_SHELLS.map((shell) => runJarvis(['completion', shell])));
    for (const script of scripts) {
      for (const name of tableCommands) {
        expect(script.stdout).toContain(name);
      }
    }

    // Global flags drift guard: compare the table against the Options: section
    // of the real root help in both directions (asserting that a generated
    // script contains the table's own flags would be self-referential).
    const helpOptions = parseOptionsSection(rootHelp.stdout);
    for (const flag of COMPLETION_GLOBAL_FLAGS) {
      expect(helpOptions, `table flag ${flag} missing from --help options`).toContain(flag);
    }
    for (const flag of helpOptions) {
      expect(COMPLETION_GLOBAL_FLAGS, `--help option ${flag} missing from the completion table`).toContain(flag);
    }

    for (const command of COMPLETION_COMMANDS) {
      if (command.subcommands === undefined) continue;
      // `completion` completes shell names as argument values, not subcommands.
      if (command.name === 'completion') continue;
      // `shadow` forwards log/restore to the shadow-cli entry; they are real
      // completions but not commander subcommands, so group help has no
      // Commands section to cross-check against.
      if (command.name === 'shadow') continue;
      const groupHelp = await runJarvis([command.name, '--help']);
      expect(groupHelp.code, `${command.name} --help exit 0`).toBe(0);
      const helpSubcommands = parseHelpSection(groupHelp.stdout, 'Commands:');
      for (const sub of command.subcommands) {
        expect(helpSubcommands, `table subcommand ${command.name} ${sub} missing from group help`).toContain(sub);
      }
      for (const sub of helpSubcommands) {
        expect(command.subcommands, `group help subcommand ${command.name} ${sub} missing from the completion table`).toContain(sub);
      }
    }
  }, 30_000);

  it('completes subcommands and partial words when the bash/powershell scripts are actually invoked', async () => {
    const bash = await runJarvis(['completion', 'bash']);
    const bashScript = join(tmpdir(), `jarvis-completion-test-${process.pid}.bash`);
    await writeFile(bashScript, bash.stdout, 'utf8');
    const bashProbe = await execShell(
      `source "${bashScript}"; COMP_WORDS=(jarvis sessions ""); COMP_CWORD=2; _jarvis_completions; echo "\${COMPREPLY[*]}"; COMP_WORDS=(jarvis rev); COMP_CWORD=1; _jarvis_completions; echo "\${COMPREPLY[*]}"`,
      'bash',
    );
    const [subLine, partialLine] = bashProbe.trim().split('\n');
    expect(subLine).toContain('archive');
    expect(subLine).toContain('list');
    expect(partialLine).toBe('review');

    const pwsh = await which('pwsh');
    if (pwsh === null) return; // no PowerShell on this machine — syntax-only coverage elsewhere
    const powershell = await runJarvis(['completion', 'powershell']);
    const psScript = join(tmpdir(), `jarvis-completion-test-${process.pid}.ps1`);
    await writeFile(psScript, powershell.stdout, 'utf8');
    const probe = [
      `. '${psScript.replaceAll('\\', '\\\\')}'`,
      '$s = TabExpansion2 "jarvis sessions " 16; if (($s.CompletionMatches.CompletionText -contains "archive")) { "SUB-OK" }',
      '$p = TabExpansion2 "jarvis rev" 10; if ($p.CompletionMatches.Count -eq 1 -and $p.CompletionMatches[0].CompletionText -eq "review") { "PARTIAL-OK" }',
    ].join('; ');
    const psProbe = await execShell(probe, 'pwsh');
    expect(psProbe).toContain('SUB-OK');
    expect(psProbe).toContain('PARTIAL-OK');
  }, 30_000);

  it('rejects unknown shells and missing arguments with exit 2', async () => {
    const missing = await runJarvis(['completion']);
    expect(missing.code).toBe(CLI_EXIT.USAGE);

    const unknown = await runJarvis(['completion', 'fish']);
    expect(unknown.code).toBe(CLI_EXIT.USAGE);
    expect(unknown.stderr).toContain('unknown shell: fish');
    expect(unknown.stdout).toBe('');
  });

  it('never loads a provider or echoes the credential value', async () => {
    const source = await readFile(join(repo, 'src', 'surfaces', 'cli', 'completion.ts'), 'utf8');
    expect(source).not.toMatch(/createProvider|loadDoubaoConfig|loadEnvFile|ARK_API_KEY/u);

    const result = await runJarvis(['completion', 'bash'], KEY_SENTINEL);
    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout).not.toContain(KEY_SENTINEL);
    expect(result.stderr).not.toContain(KEY_SENTINEL);
  });
});

/** Commander help lists commands under a "Commands:" heading as two-space
 * indented rows; the row's first token is the (sub)command name. */
function parseHelpSection(help: string, heading: string): string[] {
  const start = help.indexOf(heading);
  expect(start, `help section ${heading} exists in:\n${help.slice(0, 400)}`).toBeGreaterThanOrEqual(0);
  const lines = help.slice(start + heading.length).split('\n').slice(1);
  const names: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') break;
    const match = /^ {2}([a-z][a-z0-9-]*)(?:\s|\[|<|\||$)/u.exec(line);
    if (match !== null) names.push(match[1]);
  }
  return names;
}

/** Root help "Options:" rows hold the long flag as the first --token. */
function parseOptionsSection(help: string): string[] {
  const start = help.indexOf('Options:');
  expect(start, 'root help Options: section exists').toBeGreaterThanOrEqual(0);
  const lines = help.slice(start + 'Options:'.length).split('\n').slice(1);
  const flags: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') break;
    const match = /--[a-z][a-z0-9-]*/u.exec(line);
    if (match !== null) flags.push(match[0]);
  }
  return flags;
}

function execShell(command: string, shell: 'bash' | 'pwsh'): Promise<string> {
  return new Promise((resolveShell, rejectShell) => {
    const args = shell === 'bash' ? ['-c', command] : ['-NoProfile', '-Command', command];
    execFile(shell, args, { encoding: 'utf8', timeout: 20_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error !== null) {
        rejectShell(new Error(`${shell} probe failed: ${stderr || error.message}`));
        return;
      }
      resolveShell(stdout);
    });
  });
}

function which(tool: string): Promise<string | null> {
  return new Promise((resolveWhich) => {
    execFile(tool, ['--version'], { timeout: 10_000, windowsHide: true }, (error) => {
      resolveWhich(error === null ? tool : null);
    });
  });
}

function runJarvis(
  args: string[],
  apiKey: string | null = '',
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ARK_MODEL: 'completion-cli-test-model' };
    delete env.JARVIS_HOOKS;
    delete env.ARK_VISION_MODEL;
    if (apiKey === null) delete env.ARK_API_KEY;
    else env.ARK_API_KEY = apiKey;
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', entry, ...args],
      { cwd: repo, env, encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const rawCode: unknown = error === null ? 0 : (error as { code?: unknown }).code;
        const code = typeof rawCode === 'number' ? rawCode : null;
        done({ code, stdout, stderr });
      },
    );
    child.stdin?.end();
  });
}
