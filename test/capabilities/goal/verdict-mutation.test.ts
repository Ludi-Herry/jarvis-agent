/**
 * 变异测试补强（2026-10）：Stryker 发现这些"改坏 verdict.ts"的方式原测试抓不住。
 * 重点是"放行方向"——任何能把不合格证据判成 verified 的改动都必须被抓住。
 * 输入里的 `as never` 是故意的：verifier 报告来自模型输出，运行时可能出现类型之外的值，
 * decideVerdict 末尾的 fail-closed 兜底就是为它们准备的（AGENTS.md：兜底必须有触发路径单测）。
 */
import { describe, expect, it } from 'vitest';
import { decideVerdict } from '../../../src/capabilities/goal/verdict.js';
import type {
  DeterministicChecks,
  PinnedRequirement,
  VerifierReport,
  WorktreeStatusCheck,
} from '../../../src/capabilities/goal/goal.js';

function checks(over: Partial<DeterministicChecks> = {}): DeterministicChecks {
  return { objectiveChecksPassed: true, results: [], testTamper: 'clean', tamperReason: '', ...over };
}

const PINNED: PinnedRequirement[] = [
  { id: 'r1', text: 'first requirement' },
  { id: 'r2', text: 'second requirement' },
];

function report(over: Partial<VerifierReport> = {}): VerifierReport {
  return {
    feature: 'works',
    expected: 'x',
    observed: 'observed-text',
    evidence: 'ran it',
    perRequirement: [
      { requirementId: 'r1', strength: 'proves', scope: 'matched' },
      { requirementId: 'r2', strength: 'proves', scope: 'matched' },
    ],
    couldNotVerify: [],
    rationale: 'proven',
    ...over,
  };
}

function worktree(over: Partial<WorktreeStatusCheck> = {}): WorktreeStatusCheck {
  return {
    command: 'git status --porcelain --untracked-files=all',
    baseline: '',
    current: '',
    policy: 'forbid',
    changed: true,
    changedEntries: [],
    ...over,
  };
}

describe('decideVerdict — 未知取值一律 fail-closed，绝不 verified', () => {
  it('基线：全部 proves + matched + works → verified', () => {
    expect(decideVerdict(checks(), report(), PINNED).outcome).toBe('verified');
  });

  it('只要有一条需求的 strength 不认识，就不能 verified（every 不能被换成 some）', () => {
    const v = decideVerdict(
      checks(),
      report({
        perRequirement: [
          { requirementId: 'r1', strength: 'proves', scope: 'matched' },
          { requirementId: 'r2', strength: 'probably' as never, scope: 'matched' },
        ],
      }),
      PINNED,
    );
    expect(v.outcome).toBe('couldNotVerify');
    expect(v.rationale).toContain('failing closed');
  });

  it('strength 是 proves 但 scope 不认识 → 不能 verified', () => {
    const v = decideVerdict(
      checks(),
      report({
        perRequirement: [
          { requirementId: 'r1', strength: 'proves', scope: 'matched' },
          { requirementId: 'r2', strength: 'proves', scope: 'broaderThanClaim' as never },
        ],
      }),
      PINNED,
    );
    expect(v.outcome).toBe('couldNotVerify');
  });

  it('feature 既不是 works 也不是 broken → 不能 verified', () => {
    expect(decideVerdict(checks(), report({ feature: 'unclear' as never }), PINNED).outcome).toBe('couldNotVerify');
  });

  it('verified 时沿用 verifier 的说明；说明为空时给出默认说明', () => {
    expect(decideVerdict(checks(), report({ rationale: 'judge says ok' }), PINNED).rationale).toBe('judge says ok');
    expect(decideVerdict(checks(), report({ rationale: '' }), PINNED).rationale).toBe(
      'every pinned requirement proven, scope matched, checks clean',
    );
  });
});

describe('decideVerdict — 说明文字（给人看的理由要准确）', () => {
  it('测试被篡改但没给原因时，用默认原因', () => {
    const v = decideVerdict(checks({ testTamper: 'weakened-or-deleted', tamperReason: '' }));
    expect(v.outcome).toBe('rejected');
    expect(v.rationale).toBe('tests tampered to go green: weakened/deleted/skipped');
  });

  it('没有 Git 基线（tamper unavailable）→ checksOnly，并且有报告就带上、没报告就不带', () => {
    const withReport = decideVerdict(checks({ testTamper: 'unavailable' }), report(), PINNED);
    expect(withReport.outcome).toBe('checksOnly');
    expect(withReport.report).toBeDefined();
    const without = decideVerdict(checks({ testTamper: 'unavailable' }));
    expect(without.outcome).toBe('checksOnly');
    expect('report' in without).toBe(false);
  });

  it('没有 verifier 报告时的两种说明', () => {
    expect(decideVerdict(checks({ heldOut: { passed: true, results: [] } })).rationale).toBe(
      'deterministic checks and trusted held-out objective checks passed',
    );
    expect(decideVerdict(checks()).rationale).toBe(
      'project checks passed and tests were untampered; no trusted objective evidence was configured',
    );
  });

  it('漏评的需求按"; "拼接列出', () => {
    const v = decideVerdict(checks(), report({ perRequirement: [] }), PINNED);
    expect(v.outcome).toBe('couldNotVerify');
    expect(v.rationale).toBe('verifier did not score every pinned requirement: first requirement; second requirement');
  });

  it('feature broken 时用 verifier 的说明，说明为空则退回 observed', () => {
    expect(decideVerdict(checks(), report({ feature: 'broken', rationale: 'it crashes' }), PINNED).rationale).toBe(
      'verifier observed the feature broken: it crashes',
    );
    expect(decideVerdict(checks(), report({ feature: 'broken', rationale: '' }), PINNED).rationale).toBe(
      'verifier observed the feature broken: observed-text',
    );
  });

  it('verifier 自报无法验证的项按"; "拼接', () => {
    const v = decideVerdict(checks(), report({ couldNotVerify: ['needs a browser', 'needs prod'] }), PINNED);
    expect(v.rationale).toBe('verifier could not verify: needs a browser; needs prod');
  });

  it('tooWeak 走"证据太弱"说明，并引用需求原文；找不到原文时退回 id', () => {
    const weak = decideVerdict(
      checks(),
      report({
        perRequirement: [
          { requirementId: 'r1', strength: 'proves', scope: 'matched' },
          { requirementId: 'r2', strength: 'tooWeak', scope: 'matched' },
        ],
      }),
      PINNED,
    );
    expect(weak.outcome).toBe('couldNotVerify');
    expect(weak.rationale).toBe('evidence too weak or narrower than the claim for: second requirement');
    const contradicts = decideVerdict(
      checks(),
      report({
        perRequirement: [
          { requirementId: 'r1', strength: 'proves', scope: 'matched' },
          { requirementId: 'r2', strength: 'proves', scope: 'matched' },
          { requirementId: 'r9', strength: 'contradicts', scope: 'matched' },
        ],
      }),
      PINNED,
    );
    expect(contradicts.rationale).toBe('requirement not met (contradicts): r9');
  });

  it('工作区被改（forbid）时的说明：error 优先、空列表、最多列 10 条并注明剩余数', () => {
    expect(decideVerdict(checks({ worktreeStatus: worktree({ error: 'git failed' }) })).rationale).toBe(
      'worktree changed after baseline: git failed',
    );
    expect(decideVerdict(checks({ worktreeStatus: worktree() })).rationale).toBe(
      'worktree changed after baseline: status changed but no entry details were available',
    );
    const ten = Array.from({ length: 10 }, (_, i) => `M f${i}`);
    expect(decideVerdict(checks({ worktreeStatus: worktree({ changedEntries: ten }) })).rationale).toBe(
      `worktree changed after baseline: ${ten.join('; ')}`,
    );
    const twelve = Array.from({ length: 12 }, (_, i) => `M f${i}`);
    expect(decideVerdict(checks({ worktreeStatus: worktree({ changedEntries: twelve }) })).rationale).toBe(
      `worktree changed after baseline: ${twelve.slice(0, 10).join('; ')}; ... 2 more`,
    );
  });
});
