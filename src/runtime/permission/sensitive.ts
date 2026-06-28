/**
 * Secret-path policy — the single source of truth for "what counts as a secret", shared by the
 * gate decision (decide.ts), the command analyzer (command.ts), and the grep tool (builtins.ts).
 * Kept in its own module so all three import it without a dependency cycle.
 */

/** Path patterns whose READ or WRITE is always denied — the obvious secret shapes. */
export const SENSITIVE_PATHS: RegExp[] = [
  /(^|\/)\.env(\.|$|\*)/, //      .env, .env.local, .env.production, dir/.env, .env* (glob)
  /\.(key|pem|p12|pfx|token|crt|cer)$/, // private keys / certs / tokens by extension
  /(^|\/)auth\.json$/, //         service-account / auth blobs
  /(^|\/)\.npmrc$/, //            holds registry auth tokens
  /(^|\/)\.netrc$/, //            holds machine credentials
  /(^|\/)\.git-credentials$/, //  git stored credentials
  /(^|\/)\.ssh(\/|$)/, //         anything under an .ssh directory
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/, // ssh private keys (and .pub — conservative)
  /(^|\/)credentials(\.|$)/, //   aws/gcloud credentials files
  /(^|\/)\.\*$/, //               a bare dotfile glob (`.*`) expands to include secrets like .env
];

/** Normalize for matching: forward slashes + lower case, so Windows separators/casing can't slip
 *  a secret past. */
function normalize(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

/** True when a literal path is secret-bearing (read OR write blocked). */
export function isSensitivePath(path: string): boolean {
  const n = normalize(path);
  return SENSITIVE_PATHS.some((re) => re.test(n));
}

/** Representative secret BASENAMES a glob could expand to. dot-secrets only match a glob whose own
 *  basename starts with `.` (bash globbing skips dotfiles by default); the rest (ssh keys, secret
 *  extensions) match any glob basename regardless of a leading dot or directory prefix. */
const DOT_SECRETS = ['.env', '.env.local', '.env.production', '.npmrc', '.netrc', '.git-credentials'];
const ANY_SECRETS = ['x.pem', 'x.key', 'x.p12', 'x.pfx', 'x.token', 'x.crt', 'x.cer', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credentials', 'auth.json'];

/**
 * True when a shell glob could expand to a secret file (`cat .e*`, `cat dir/*.pem`, `cat id_*`).
 * Matches the glob's BASENAME (last path segment) against secret basenames so a directory prefix
 * (`dir/*.pem`, `config/.env*`, `./.e*`) doesn't hide it. Requires at least one literal character
 * (a bare `*` — which bash won't expand to dotfiles — isn't flagged).
 */
export function globMatchesSecret(pattern: string): boolean {
  const norm = normalize(pattern);
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  if (base.replace(/[*?[\]]/g, '') === '') return false; // bare `*`/`?` — too broad
  let re: RegExp;
  try {
    re = globToRegExp(base);
  } catch {
    return true; // an un-parseable glob next to a path is suspicious → fail closed
  }
  if (ANY_SECRETS.some((s) => re.test(s))) return true;
  return base.startsWith('.') && DOT_SECRETS.some((s) => re.test(s));
}

/** Convert a shell glob to an anchored RegExp (`*`→`.*`, `?`→`.`, `[...]` kept as a char class). */
function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') out += '.*';
    else if (c === '?') out += '.';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) { out += '\\['; } else { out += glob.slice(i, end + 1); i = end; }
    } else out += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}
