import { createHash } from 'node:crypto';

/**
 * Opaque logical version for one file body. The token intentionally depends on
 * bytes only: an identical rewrite is the same logical version, while any byte
 * change invalidates a stale write precondition. It grants no permission.
 */
export function fileVersion(bytes: Uint8Array): string {
  return `fv1.${createHash('sha256').update(bytes).digest('base64url')}`;
}

/** Reject malformed/version-future tokens before touching the target file. */
export function isFileVersion(value: string): boolean {
  return /^fv1\.[A-Za-z0-9_-]{43}$/.test(value);
}
