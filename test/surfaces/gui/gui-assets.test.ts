import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const asset = (name: string) => resolve('src', 'surfaces', 'gui', 'assets', name);

describe('G2.1 GUI shell assets', () => {
  it('keeps the existing runtime ids inside a three-region desktop shell', async () => {
    const [html, js] = await Promise.all([
      readFile(asset('index.html'), 'utf8'),
      readFile(asset('app.js'), 'utf8'),
    ]);

    expect(html).toContain('class="rail"');
    expect(html).toContain('class="workspace"');
    expect(html).toContain('class="context-rail"');
    expect(html).toContain('href="#current-run"');
    expect(html).toContain('href="#human-review"');
    expect(html).toContain('href="#activity-log"');
    for (const id of ['authority', 'goals', 'loops', 'approvals', 'stop-state', 'stop-button', 'updated-at', 'run-state', 'attention-strip', 'attention-title', 'attention-label', 'attention-action', 'attention-action-label', 'latest-goal', 'latest-goal-meta', 'budget-label', 'budget', 'budget-progress', 'budget-caption', 'unique-tokens', 'goal-tokens', 'loop-tokens', 'token-coverage', 'nav-review-count', 'review-count', 'human-reviews', 'timeline']) {
      expect(html.match(new RegExp(`id="${id}"`, 'gu'))).toHaveLength(1);
    }
    const selectors = [...js.matchAll(/document\.querySelector\('#([^']+)'\)/gu)].map((match) => match[1]);
    expect(selectors.length).toBeGreaterThan(0);
    for (const id of selectors) {
      expect(html.match(new RegExp(`id="${id}"`, 'gu'))).toHaveLength(1);
    }
    expect(html).not.toContain('aria-current="page"');
    expect(html).toContain('class="run-overview"');
    expect(html).toContain('class="attention-strip"');
    expect(html).toContain('class="goal-focus"');
    expect(html).toContain('class="usage-disclosure"');
    expect(html).toContain('class="t-learn"');
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(html).toContain('aria-labelledby="budget-label budget-caption"');
  });

  it('uses the approved Jarvis warm-paper tokens without wide ghost-card shadows', async () => {
    const css = await readFile(asset('app.css'), 'utf8');

    expect(css).toContain('--bg: #f5efe4');
    expect(css).toContain('--panel: #fbf7ee');
    expect(css).toContain('--sidebar: #efe8db');
    expect(css).toContain('--ink: #2a2622');
    expect(css).toContain('--accent: #537d96');
    expect(css).toContain('grid-template-columns: var(--rail-width) minmax(540px, 1fr) var(--context-width)');
    expect(css).toContain('overflow-y: auto');
    expect(css).not.toMatch(/box-shadow:\s*0\s+\d+px\s+(?:1[6-9]|[2-9]\d)px/gu);
    expect(css).not.toContain('animation: item-in');
  });

  it('keeps responsive and reduced-motion failure paths visible', async () => {
    const [css, js] = await Promise.all([
      readFile(asset('app.css'), 'utf8'),
      readFile(asset('app.js'), 'utf8'),
    ]);
    const tabletCss = css.slice(
      css.indexOf('@media (max-width: 1080px)'),
      css.indexOf('@media (max-width: 760px)'),
    );
    const mobileCss = css.slice(
      css.indexOf('@media (max-width: 760px)'),
      css.indexOf('@media (prefers-reduced-motion: reduce)'),
    );

    expect(css).toContain('@media (max-width: 1080px)');
    expect(css).toContain('@media (max-width: 760px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(tabletCss).toMatch(/\.rail \{[^}]*display: grid;/u);
    expect(tabletCss).not.toMatch(/\.rail \{[^}]*display: none;/u);
    expect(tabletCss).toMatch(/\.section-nav \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/u);
    expect(mobileCss).toMatch(/\.stop-panel \{[^}]*position: fixed;[^}]*right: 12px;[^}]*bottom: 12px;[^}]*left: 12px;[^}]*z-index: 20;/u);
    expect(mobileCss).toMatch(/body \{[^}]*height: auto;[^}]*overflow: auto;/u);
    expect(mobileCss).toMatch(/\.workspace \{[^}]*padding: 18px 14px 116px;[^}]*overflow: visible;/u);
    expect(css).toContain('outline: 2px solid var(--accent-hover)');
    expect(js).toContain("navReviewCount: document.querySelector('#nav-review-count')");
    expect(js).toContain("payload.stop.unreadable ? '状态未知' : payload.stop.requested ? '已急停' : '待命'");
  });
});
