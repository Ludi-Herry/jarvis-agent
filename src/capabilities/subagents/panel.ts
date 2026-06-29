/**
 * panel — the review-panel axis: N equal-capability subagents, each wearing a perspective "hat",
 * read the SAME artifact in parallel and each writes a review (Phase C, C4; memory two-axes).
 *
 * This is "judge ≠ player" made standing (blueprint §9): instead of the author grading its own
 * work, independent read-only reviewers each look from a fixed angle. The six-hats set ships here as
 * PRESET DATA (not hardcoded into the harness) — `runPanel` takes any AgentRole[] as the hats, so a
 * caller can use the preset, a subset, or its own perspectives.
 *
 * Every hat is read-only, so the panel is parallel-safe: read-only never reaches the gate's `ask`
 * lane (decide.ts), so concurrent reviewers never contend on the REPL's single approval queue (R7).
 * Concurrency is the ONE place a semaphore is needed (single spawns are already serialized by the
 * parent loop) — fan-out is capped so a big panel can't overrun the budget (R5).
 */
import type { AgentRole } from './roster.js';
import type { SubagentManager } from './subagent-manager.js';

/** One reviewer's verdict. `hat` is the perspective (role name); `review` is its condensed output. */
export interface PanelReview {
  hat: string;
  ok: boolean;
  review: string;
}

/** Default cap on how many reviewers run at once (blueprint §4 concurrency governance). */
export const DEFAULT_PANEL_CONCURRENCY = 4;

/**
 * Run a review panel: each hat reviews `artifact` from its perspective, in parallel up to
 * `maxConcurrency`. Returns one {@link PanelReview} per hat, in the hats' order.
 */
export async function runPanel(
  manager: SubagentManager,
  hats: readonly AgentRole[],
  artifact: string,
  opts: { maxConcurrency?: number; signal?: AbortSignal } = {},
): Promise<PanelReview[]> {
  const limit = Math.max(1, opts.maxConcurrency ?? DEFAULT_PANEL_CONCURRENCY);
  const task = buildReviewTask(artifact);
  const results = await mapWithConcurrency(hats, limit, (hat) =>
    manager.spawnRole(hat, task, opts.signal),
  );
  return results.map((r) => ({ hat: r.role, ok: r.ok, review: r.summary }));
}

/** Wrap the artifact in a review instruction; the hat's systemPrompt supplies the perspective. */
function buildReviewTask(artifact: string): string {
  return [
    'Review the following artifact strictly from your assigned perspective. Be specific and concise;',
    'cite parts of the artifact. Do not rewrite it — only review it.',
    '',
    '--- ARTIFACT START ---',
    artifact,
    '--- ARTIFACT END ---',
  ].join('\n');
}

/** Run `fn` over `items` with at most `limit` in flight at once, preserving result order. The only
 *  concurrency primitive in the subagents module — single spawns are serialized by the parent loop. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * The six-thinking-hats panel as PRESET data — one optional set of perspectives, NOT a structure the
 * harness hardcodes (memory: don't写死六顶帽). Each hat is a read-only reviewer; a caller passes this
 * (or any subset / its own roles) to {@link runPanel}.
 */
export const SIX_HATS: readonly AgentRole[] = [
  {
    name: 'white-hat',
    description: '白帽 · 事实:只陈述事实与数据',
    systemPrompt:
      '你戴白帽。只陈述产物中的客观事实、数据与已知信息,并指出哪些信息缺失或未经证实。不评价好坏,不给意见。',
    capability: ['read-only'],
    reasoningEffort: 'low',
  },
  {
    name: 'red-hat',
    description: '红帽 · 直觉:第一感受与情绪反应',
    systemPrompt:
      '你戴红帽。说出对这份产物的第一直觉、情绪和直接反应,不需要给理由或论证。它给人的感觉是什么。',
    capability: ['read-only'],
    reasoningEffort: 'low',
  },
  {
    name: 'black-hat',
    description: '黑帽 · 挑错:风险、缺陷、为什么行不通',
    systemPrompt:
      '你戴黑帽,是最严苛的批评者。找出这份产物的风险、缺陷、漏洞和为什么可能行不通。逐条指出,引用具体之处。',
    capability: ['read-only'],
    reasoningEffort: 'low',
  },
  {
    name: 'yellow-hat',
    description: '黄帽 · 价值:好处与为什么可行',
    systemPrompt:
      '你戴黄帽。找出这份产物的价值、好处和为什么可行。乐观但要有依据,指出最值得保留的部分。',
    capability: ['read-only'],
    reasoningEffort: 'low',
  },
  {
    name: 'green-hat',
    description: '绿帽 · 替代:改进与新点子',
    systemPrompt:
      '你戴绿帽。提出替代方案、改进方向和新点子,跳出产物现有的框架想可能性。',
    capability: ['read-only'],
    reasoningEffort: 'low',
  },
  {
    name: 'blue-hat',
    description: '蓝帽 · 主持:综合全局与下一步',
    systemPrompt:
      '你戴蓝帽,负责主持。综合全局,给出对这份产物的总体判断和明确的下一步建议。',
    capability: ['read-only'],
    reasoningEffort: 'low',
  },
];
