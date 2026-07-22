/* global document, fetch, window */

const state = {
  busy: false,
  activeDraftKey: undefined,
  drafts: new Map(),
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
  goalTokens: document.querySelector('#goal-tokens'),
  loopTokens: document.querySelector('#loop-tokens'),
  tokenCoverage: document.querySelector('#token-coverage'),
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
  nodes.latestGoal.textContent = formatLatestGoal(report.status.latestGoal);
  nodes.budget.textContent = report.status.latestGoalBudget
    ? `${report.status.latestGoalBudget.roundsUsed}/${report.status.latestGoalBudget.maxRounds} rounds`
    : '-';
  nodes.goalTokens.textContent = `${report.usage.goalTokens}`;
  nodes.loopTokens.textContent = `${report.usage.loopTokens}`;
  nodes.tokenCoverage.textContent = `Unique measured ${report.usage.uniqueTotalTokens} · ${report.usage.coverage} coverage · unmeasured ${report.usage.coverage === 'partial' ? 'unknown' : '0'}`;
  nodes.reviewCount.textContent = `${payload.reviews.length}`;
  nodes.humanReviews.replaceChildren(...renderReviews(payload.reviews));
  nodes.timeline.replaceChildren(...payload.timeline.map(renderItem));
}

function formatLatestGoal(goal) {
  if (!goal) return '-';
  const recordedState = goal.recordedState || goal.state;
  const effectiveState = goal.effectiveState || recordedState;
  const parts = [effectiveState, goal.verdict || '-'];
  if (effectiveState !== recordedState) parts.push(`recorded ${recordedState}`);
  if (goal.effectiveReason) parts.push(goal.effectiveReason);
  if (goal.effectiveSource?.loopId) parts.push(`loop ${goal.effectiveSource.loopId}`);
  return parts.join(' · ');
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
  const draftKey = reviewDraftKey(goalId, requirement.requirementId);
  const draft = state.drafts.get(draftKey);
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
    reviewButton('通过', 'approve', () => openReviewForm('approve', note.value)),
    reviewButton('驳回', 'reject', () => openReviewForm('reject', note.value)),
  );

  const form = document.createElement('form');
  form.className = 'review-form';
  form.hidden = true;

  const note = document.createElement('textarea');
  note.className = 'review-note';
  note.rows = 2;
  note.maxLength = 1000;
  note.placeholder = '裁决备注';

  const error = document.createElement('span');
  error.className = 'review-form-error';
  error.setAttribute('aria-live', 'polite');

  const formActions = document.createElement('div');
  formActions.className = 'review-form-actions';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'review-submit';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'review-cancel';
  cancel.textContent = '取消';
  formActions.append(submit, cancel);
  form.append(note, error, formActions);

  let pendingDecision = draft?.decision;

  function openReviewForm(decision, currentNote) {
    pendingDecision = decision;
    state.activeDraftKey = draftKey;
    state.drafts.set(draftKey, { decision, note: currentNote ?? '' });
    applyDraftToForm(decision);
    form.hidden = false;
    error.textContent = '';
    note.focus();
  }

  cancel.addEventListener('click', () => {
    pendingDecision = undefined;
    if (state.activeDraftKey === draftKey) state.activeDraftKey = undefined;
    state.drafts.delete(draftKey);
    form.hidden = true;
    note.value = '';
    error.textContent = '';
  });

  note.addEventListener('input', () => {
    if (pendingDecision === undefined) return;
    state.drafts.set(draftKey, { decision: pendingDecision, note: note.value });
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = note.value.trim();
    if (pendingDecision === undefined) return;
    if (value === '') {
      error.textContent = '请填写裁决备注';
      note.focus();
      return;
    }
    await decideHumanReview(goalId, requirement.requirementId, pendingDecision, value, draftKey);
  });

  if (draft !== undefined) {
    note.value = draft.note;
    applyDraftToForm(draft.decision);
    form.hidden = false;
    if (state.activeDraftKey === draftKey) {
      window.setTimeout(() => note.focus(), 0);
    }
  }

  function applyDraftToForm(decision) {
    submit.textContent = decision === 'approve' ? '确认通过' : '确认驳回';
    form.dataset.decision = decision;
  }

  row.append(copy, actions, form);
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

function reviewDraftKey(goalId, requirementId) {
  return `${goalId}:${requirementId}`;
}

async function decideHumanReview(goalId, requirementId, decision, note, draftKey) {
  if (state.busy) return;
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
    state.drafts.delete(draftKey);
    if (state.activeDraftKey === draftKey) state.activeDraftKey = undefined;
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
  for (const control of document.querySelectorAll('.review-action, .review-note, .review-submit, .review-cancel')) {
    control.disabled = value;
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
