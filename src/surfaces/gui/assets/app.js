/* global document, fetch, window */

const state = {
  busy: false,
  timer: undefined,
};

const nodes = {
  authority: document.querySelector('#authority'),
  goals: document.querySelector('#goals'),
  loops: document.querySelector('#loops'),
  approvals: document.querySelector('#approvals'),
  stopState: document.querySelector('#stop-state'),
  stopButton: document.querySelector('#stop-button'),
  updatedAt: document.querySelector('#updated-at'),
  latestGoal: document.querySelector('#latest-goal'),
  budget: document.querySelector('#budget'),
  tokens: document.querySelector('#tokens'),
  reviewCount: document.querySelector('#review-count'),
  humanReviews: document.querySelector('#human-reviews'),
  timeline: document.querySelector('#timeline'),
};

nodes.stopButton.addEventListener('click', async () => {
  if (state.busy) return;
  setBusy(true);
  try {
    await fetch('/api/emergency-stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jarvis-gui': '1' },
      body: JSON.stringify({ reason: 'GUI emergency stop' }),
    });
    await refresh();
  } finally {
    setBusy(false);
  }
});

async function refresh() {
  const [statusResponse, reviewsResponse] = await Promise.all([
    fetch('/api/status', { cache: 'no-store' }),
    fetch('/api/human-reviews', { cache: 'no-store' }),
  ]);
  if (!statusResponse.ok) throw new Error(`status ${statusResponse.status}`);
  if (!reviewsResponse.ok) throw new Error(`reviews ${reviewsResponse.status}`);
  const payload = await statusResponse.json();
  const reviewsPayload = await reviewsResponse.json();
  render({ ...payload, reviews: reviewsPayload.reviews || [] });
}

function render(payload) {
  const report = payload.report;
  nodes.authority.textContent = report.authority.mode;
  nodes.goals.textContent = `${report.status.goals.total}`;
  nodes.loops.textContent = `${report.status.loops.total}`;
  nodes.approvals.textContent = `${report.audit.approvals.requests}/${report.audit.approvals.results}`;
  nodes.stopState.textContent = payload.stop.requested ? 'Stopped' : 'Armed';
  nodes.updatedAt.textContent = shortTime(report.meta.generatedAt);
  nodes.latestGoal.textContent = report.status.latestGoal
    ? `${report.status.latestGoal.state} · ${report.status.latestGoal.verdict || '-'}`
    : '-';
  nodes.budget.textContent = report.status.latestGoalBudget
    ? `${report.status.latestGoalBudget.roundsUsed}/${report.status.latestGoalBudget.maxRounds} rounds`
    : '-';
  nodes.tokens.textContent = `${report.usage.goalTokens + report.usage.loopTokens}`;
  nodes.reviewCount.textContent = `${payload.reviews.length}`;
  nodes.humanReviews.replaceChildren(...renderReviews(payload.reviews));
  nodes.timeline.replaceChildren(...payload.timeline.map(renderItem));
}

function renderReviews(reviews) {
  if (reviews.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'review-empty';
    empty.textContent = '暂无待裁决项';
    return [empty];
  }
  return reviews.map(renderReview);
}

function renderReview(review) {
  const article = document.createElement('article');
  article.className = 'review-card';

  const header = document.createElement('div');
  header.className = 'review-card-head';
  const title = document.createElement('h3');
  title.textContent = review.goalId;
  const meta = document.createElement('span');
  meta.textContent = `${review.verdict} · round ${review.round}`;
  header.append(title, meta);

  const objective = document.createElement('p');
  objective.className = 'review-objective';
  objective.textContent = review.objective;

  const requirements = document.createElement('div');
  requirements.className = 'review-requirements';
  for (const requirement of review.requirements) {
    requirements.append(renderRequirement(review.goalId, requirement));
  }

  article.append(header, objective, requirements);
  return article;
}

function renderRequirement(goalId, requirement) {
  const row = document.createElement('div');
  row.className = 'review-requirement';

  const copy = document.createElement('div');
  copy.className = 'review-copy';
  const text = document.createElement('strong');
  text.textContent = requirement.text;
  const reason = document.createElement('span');
  reason.textContent = requirement.reason;
  copy.append(text, reason);

  const actions = document.createElement('div');
  actions.className = 'review-actions';
  actions.append(
    reviewButton('通过', 'approve', () => decideHumanReview(goalId, requirement.requirementId, 'approve')),
    reviewButton('驳回', 'reject', () => decideHumanReview(goalId, requirement.requirementId, 'reject')),
  );

  row.append(copy, actions);
  return row;
}

function reviewButton(label, tone, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `review-action ${tone}`;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

async function decideHumanReview(goalId, requirementId, decision) {
  if (state.busy) return;
  const note = window.prompt('裁决备注');
  if (note === null || note.trim() === '') return;
  setBusy(true);
  try {
    const response = await fetch(`/api/human-reviews/${encodeURIComponent(goalId)}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jarvis-gui': '1' },
      body: JSON.stringify({
        decisions: [{ requirementId, decision, note }],
      }),
    });
    if (!response.ok) throw new Error(`review ${response.status}`);
    await refresh();
  } catch (err) {
    nodes.updatedAt.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    setBusy(false);
  }
}

function setBusy(value) {
  state.busy = value;
  nodes.stopButton.disabled = value;
  for (const button of document.querySelectorAll('.review-action')) {
    button.disabled = value;
  }
}

function renderItem(item) {
  const li = document.createElement('li');
  li.className = 'timeline-item';
  li.dataset.tone = item.tone;

  const dot = document.createElement('span');
  dot.className = 'timeline-dot';
  dot.setAttribute('aria-hidden', 'true');

  const main = document.createElement('div');
  main.className = 'timeline-main';

  const head = document.createElement('div');
  head.className = 'timeline-head';
  const title = document.createElement('h3');
  title.className = 'timeline-title';
  title.textContent = item.title;
  const time = document.createElement('time');
  time.className = 'timeline-time';
  time.textContent = item.at ? shortTime(item.at) : '-';
  head.append(title, time);

  const detail = document.createElement('p');
  detail.className = 'timeline-detail';
  detail.textContent = item.detail;

  const meta = document.createElement('div');
  meta.className = 'timeline-meta';
  for (const value of item.meta || []) {
    const chip = document.createElement('span');
    chip.textContent = value;
    meta.append(chip);
  }

  main.append(head, detail, meta);
  li.append(dot, main);
  return li;
}

function shortTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

async function tick() {
  try {
    await refresh();
  } catch (err) {
    nodes.updatedAt.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    state.timer = window.setTimeout(tick, 1500);
  }
}

void tick();
