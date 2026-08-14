import { describe, expect, it } from 'vitest';
import { decideGitTrust } from '../../src/surfaces/cli/git-trust.js';

describe('autonomous CLI Git trust policy', () => {
  it('rejects a missing tamper baseline by default', () => {
    expect(decideGitTrust(false, false)).toBe('reject');
  });

  it('allows an explicit no-Git run only at checks-only trust', () => {
    expect(decideGitTrust(false, true)).toBe('checks-only');
  });

  it('keeps verified completion reachable when a baseline exists', () => {
    expect(decideGitTrust(true, false)).toBe('verified-capable');
    expect(decideGitTrust(true, true)).toBe('verified-capable');
  });
});
