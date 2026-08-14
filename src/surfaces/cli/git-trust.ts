export type GitTrustDecision = 'verified-capable' | 'checks-only' | 'reject';

/** Pure policy seam for the autonomous CLI no-Git guardrail. */
export function decideGitTrust(hasBaseline: boolean, allowNoGit: boolean): GitTrustDecision {
  if (hasBaseline) return 'verified-capable';
  return allowNoGit ? 'checks-only' : 'reject';
}
