/* global document, fetch, window */

import {
  advanceMutationBarrier,
  buildRunPresentation,
  buildTimelineProjection,
  commitMutationThenRefresh,
  reconcileReviewExpansion,
  reconcileExpandedTimeline,
  reviewDecisionKey,
  reviewDecisionKeys,
  reviewQueueSnapshot,
  settleSequencedRefresh,
  timelineProjectionSnapshot,
} from '/presentation.js';

const state = {
  busy: false,
  activeDraftKey: undefined,
  drafts: new Map(),
  expandedReviews: new Set(),
  reviewQueueInitialized: false,
  reviewSnapshot: undefined,
  activeReviewForm: undefined,
  refreshSequence: 0,
  appliedRefreshSequence: 0,
  timelineSnapshot: undefined,
  expandedTimeline: new Set(),
  timelineArchiveOpen: false,
  timer: undefined,
};

const TIMELINE_KIND_LABELS = Object.freeze({
  approval: '审批',
  authority: '权限',
  budget: '预算',
  contract: '合同',
  control: '控制',
  cron: '定时',
  'cron-daemon': '守护进程',
  goal: 'Goal',
  loop: 'Loop',
  sandbox: '沙箱',
  session: '会话',
  worktree: '工作区',
});

const nodes = {
  authority: document.querySelector('#authority'),
  goals: document.querySelector('#goals'),
  loops: document.querySelector('#loops'),
  approvals: document.querySelector('#approvals'),
  stopState: document.querySelector('#stop-state'),
  stopButton: document.querySelector('#stop-button'),
  updatedAt: document.querySelector('#updated-at'),
  runState: document.querySelector('#run-state'),
  attentionStrip: document.querySelector('#attention-strip'),
  attentionTitle: document.querySelector('#attention-title'),
  attentionLabel: document.querySelector('#attention-label'),
  attentionAction: document.querySelector('#attention-action'),
  attentionActionLabel: document.querySelector('#attention-action-label'),
  latestGoal: document.querySelector('#latest-goal'),
  latestGoalMeta: document.querySelector('#latest-goal-meta'),
  budget: document.querySelector('#budget'),
  budgetProgress: document.querySelector('#budget-progress'),
  budgetCaption: document.querySelector('#budget-caption'),
  uniqueTokens: document.querySelector('#unique-tokens'),
  goalTokens: document.querySelector('#goal-tokens'),
  loopTokens: document.querySelector('#loop-tokens'),
  tokenCoverage: document.querySelector('#token-coverage'),
  navReviewCount: document.querySelector('#nav-review-count'),
  reviewCount: document.querySelector('#review-count'),
  humanReviews: document.querySelector('#human-reviews'),
  timeline: document.querySelector('#timeline'),
};

nodes.stopButton.addEventListener('click', async () => {
  if (state.busy) return;
  setBusy(true);
  try {
    const result = await commitMutationThenRefresh({
      request: () => fetch('/api/emergency-stop', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-jarvis-gui': '1' },
        body: JSON.stringify({ reason: 'GUI emergency stop' }),
      }),
      commit: applyMutationBarrier,
      refresh,
    });
    if (result.refreshError !== undefined) {
      nodes.updatedAt.textContent = `急停已记录，刷新失败：${errorMessage(result.refreshError)}`;
    }
  } catch (err) {
    nodes.updatedAt.textContent = `急停失败：${errorMessage(err)}`;
  } finally {
    setBusy(false);
  }
});

async function refresh() {
  const sequence = ++state.refreshSequence;
  const result = await settleSequencedRefresh(
    sequence,
    async () => {
      const [statusResponse, reviewsResponse] = await Promise.all([
        fetch('/api/status', { cache: 'no-store' }),
        fetch('/api/human-reviews', { cache: 'no-store' }),
      ]);
      if (!statusResponse.ok) throw new Error(`status ${statusResponse.status}`);
      if (!reviewsResponse.ok) throw new Error(`reviews ${reviewsResponse.status}`);
      const payload = await statusResponse.json();
      const reviewsPayload = await reviewsResponse.json();
      return { ...payload, reviews: reviewsPayload.reviews || [] };
    },
    () => state.appliedRefreshSequence,
  );
  if (!result.accepted) return;
  state.appliedRefreshSequence = sequence;
  render(result.value);
}

function render(payload) {
  const report = payload.report;
  const run = buildRunPresentation(report, payload.stop, payload.reviews.length);
  nodes.authority.textContent = report.authority.mode;
  nodes.goals.textContent = `${report.status.goals.total}`;
  nodes.loops.textContent = `${report.status.loops.total}`;
  nodes.approvals.textContent = `${report.audit.approvals.requests}/${report.audit.approvals.results}`;
  nodes.stopState.textContent = payload.stop.unreadable ? '状态未知' : payload.stop.requested ? '已急停' : '待命';
  nodes.updatedAt.textContent = shortTime(report.meta.generatedAt);
  nodes.runState.textContent = run.state.label;
  nodes.runState.dataset.tone = run.state.tone;
  nodes.attentionStrip.dataset.tone = run.attention.tone;
  nodes.attentionTitle.textContent = run.attention.title;
  nodes.attentionLabel.textContent = run.attention.label;
  nodes.attentionAction.hidden = run.attention.href === undefined;
  if (run.attention.href !== undefined) {
    nodes.attentionAction.href = run.attention.href;
    nodes.attentionActionLabel.textContent = run.attention.action;
  }
  nodes.latestGoal.textContent = run.goal.title;
  nodes.latestGoalMeta.textContent = run.goal.meta;
  nodes.budget.textContent = run.budget.label;
  nodes.budgetProgress.max = run.budget.max;
  nodes.budgetProgress.value = run.budget.value;
  nodes.budgetProgress.hidden = !run.budget.available;
  nodes.budgetCaption.textContent = run.budget.caption;
  nodes.uniqueTokens.textContent = `${run.usage.unique}`;
  nodes.goalTokens.textContent = `${run.usage.goal}`;
  nodes.loopTokens.textContent = `${run.usage.loop}`;
  nodes.tokenCoverage.textContent = `覆盖 ${run.usage.coverage} · 未计量 ${run.usage.unmetered}`;
  nodes.navReviewCount.textContent = `${payload.reviews.length}`;
  nodes.reviewCount.textContent = `${payload.reviews.length}`;
  renderReviewQueue(payload.reviews);
  renderTimeline(payload.timeline);
}

function renderTimeline(items) {
  const nextSnapshot = timelineProjectionSnapshot(items);
  if (nextSnapshot === state.timelineSnapshot) return;
  state.timelineSnapshot = nextSnapshot;

  const focusedKey = document.activeElement?.dataset?.timelineFocusKey;
  state.expandedTimeline = new Set(reconcileExpandedTimeline(
    items.map((item) => item.id),
    [...state.expandedTimeline],
  ));
  const projection = buildTimelineProjection(items);
  const sections = [
    renderTimelineGroup({
      title: '当前快照',
      description: '由现有记录聚合出的状态投影，仅用于观察。',
      source: 'snapshot',
      items: projection.snapshots,
    }),
    renderTimelineGroup({
      title: '持久化事件',
      description: '来自 activity.recent 对应的 JSONL 事实。',
      source: 'persistent',
      items: projection.events.visible,
      hiddenItems: projection.events.hidden,
      total: projection.events.total,
    }),
  ];
  nodes.timeline.replaceChildren(...sections);
  if (focusedKey !== undefined) {
    const nextFocused = [...nodes.timeline.querySelectorAll('[data-timeline-focus-key]')]
      .find((element) => element.dataset.timelineFocusKey === focusedKey);
    nextFocused?.focus();
  }
}

function renderTimelineGroup({ title, description, source, items, hiddenItems = [], total = items.length }) {
  const section = document.createElement('section');
  section.className = 'timeline-group';
  section.dataset.source = source;

  const heading = document.createElement('div');
  heading.className = 'timeline-group-heading';
  const copy = document.createElement('div');
  const groupTitle = document.createElement('h3');
  groupTitle.textContent = title;
  const groupDescription = document.createElement('p');
  groupDescription.textContent = description;
  copy.append(groupTitle, groupDescription);
  const count = document.createElement('strong');
  count.textContent = `${total}`;
  heading.append(copy, count);

  const list = document.createElement('ol');
  list.className = 'timeline-list';
  list.append(...items.map(renderItem));
  section.append(heading, list);

  if (hiddenItems.length > 0) {
    const archive = document.createElement('details');
    archive.className = 'timeline-archive';
    archive.open = state.timelineArchiveOpen;
    const archiveSummary = document.createElement('summary');
    const updateArchiveLabel = () => {
      archiveSummary.textContent = `${archive.open ? '收起' : '展开'}其余 ${hiddenItems.length} 条持久化事件`;
    };
    archive.addEventListener('toggle', () => {
      state.timelineArchiveOpen = archive.open;
      updateArchiveLabel();
    });
    updateArchiveLabel();
    const archiveList = document.createElement('ol');
    archiveList.className = 'timeline-list timeline-list-archive';
    archiveList.append(...hiddenItems.map(renderItem));
    archive.append(archiveSummary, archiveList);
    section.append(archive);
  }

  return section;
}

function renderReviewQueue(reviews) {
  const validDraftKeys = new Set(reviewDecisionKeys(reviews));
  for (const key of state.drafts.keys()) {
    if (!validDraftKeys.has(key)) state.drafts.delete(key);
  }
  if (state.activeDraftKey !== undefined && !validDraftKeys.has(state.activeDraftKey)) {
    state.activeDraftKey = undefined;
    state.activeReviewForm = undefined;
  }

  const nextSnapshot = reviewQueueSnapshot(reviews);
  if (nextSnapshot === state.reviewSnapshot) return;
  state.reviewSnapshot = nextSnapshot;

  const focusedKey = document.activeElement?.dataset?.reviewFocusKey;
  state.activeReviewForm = undefined;
  nodes.humanReviews.replaceChildren(...renderReviews(reviews));
  if (state.activeDraftKey === undefined && focusedKey !== undefined) {
    const nextFocused = [...nodes.humanReviews.querySelectorAll('[data-review-focus-key]')]
      .find((element) => element.dataset.reviewFocusKey === focusedKey);
    nextFocused?.focus();
  }
}

function renderReviews(reviews) {
  if (reviews.length === 0) {
    state.expandedReviews.clear();
    state.reviewQueueInitialized = false;
    const empty = document.createElement('p');
    empty.className = 'review-empty';
    empty.textContent = '暂无待裁决项';
    return [empty];
  }
  const expansion = reconcileReviewExpansion(
    reviews.map((review) => review.goalId),
    [...state.expandedReviews],
    state.reviewQueueInitialized,
  );
  state.expandedReviews = new Set(expansion.expandedIds);
  state.reviewQueueInitialized = expansion.initialized;
  for (const draft of state.drafts.values()) state.expandedReviews.add(draft.goalId);
  return reviews.map(renderReview);
}

function renderReview(review) {
  const article = document.createElement('details');
  article.className = 'review-card';
  article.open = state.expandedReviews.has(review.goalId);
  article.addEventListener('toggle', () => {
    if (article.open) state.expandedReviews.add(review.goalId);
    else state.expandedReviews.delete(review.goalId);
  });

  const summary = document.createElement('summary');
  summary.className = 'review-summary';
  summary.dataset.reviewFocusKey = `summary:${review.goalId}`;
  const summaryCopy = document.createElement('div');
  summaryCopy.className = 'review-summary-copy';
  const eyebrow = document.createElement('span');
  eyebrow.textContent = `${review.requirements.length} 项待判断`;
  const title = document.createElement('h3');
  title.textContent = review.objective;
  summaryCopy.append(eyebrow, title);
  const summaryMeta = document.createElement('span');
  summaryMeta.className = 'review-summary-meta';
  summaryMeta.textContent = `第 ${review.round} 轮`;
  const chevron = document.createElement('span');
  chevron.className = 'review-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '⌄';
  summary.append(summaryCopy, summaryMeta, chevron);

  const body = document.createElement('div');
  body.className = 'review-card-body';
  const header = document.createElement('div');
  header.className = 'review-card-head';
  const goalId = document.createElement('span');
  goalId.className = 'review-goal-id';
  goalId.textContent = review.goalId;
  const meta = document.createElement('span');
  meta.textContent = review.verdict;
  header.append(goalId, meta);

  const objective = document.createElement('p');
  objective.className = 'review-objective';
  objective.textContent = review.objective;

  const requirements = document.createElement('div');
  requirements.className = 'review-requirements';
  for (const [index, requirement] of review.requirements.entries()) {
    requirements.append(renderRequirement(review.goalId, requirement, index + 1, article));
  }

  body.append(header, objective, requirements);
  article.append(summary, body);
  return article;
}

function renderRequirement(goalId, requirement, index, reviewCard) {
  const draftKey = reviewDecisionKey(goalId, requirement.requirementId);
  const draft = state.drafts.get(draftKey);
  const row = document.createElement('div');
  row.className = 'review-requirement';

  const indexLabel = document.createElement('span');
  indexLabel.className = 'requirement-index';
  indexLabel.textContent = `${index}`.padStart(2, '0');

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
    reviewButton('通过', 'approve', `approve:${draftKey}`, () => openReviewForm('approve', note.value)),
    reviewButton('驳回', 'reject', `reject:${draftKey}`, () => openReviewForm('reject', note.value)),
  );

  const form = document.createElement('form');
  form.className = 'review-form';
  form.hidden = true;

  const note = document.createElement('textarea');
  note.className = 'review-note';
  note.rows = 2;
  note.maxLength = 1000;
  note.placeholder = '裁决备注';

  const noteField = document.createElement('label');
  noteField.className = 'review-note-field';
  const noteLabel = document.createElement('span');
  noteLabel.textContent = '裁决备注（必填）';
  noteField.append(noteLabel, note);

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
  form.append(noteField, error, formActions);

  const commitStatus = document.createElement('p');
  commitStatus.className = 'review-commit-status';
  commitStatus.hidden = true;
  commitStatus.setAttribute('aria-live', 'polite');

  let pendingDecision = draft?.decision;

  function openReviewForm(decision, currentNote) {
    if (state.activeReviewForm?.key !== draftKey) state.activeReviewForm?.close();
    pendingDecision = decision;
    state.activeDraftKey = draftKey;
    state.drafts.set(draftKey, { goalId, decision, note: currentNote ?? '' });
    state.expandedReviews.add(goalId);
    reviewCard.open = true;
    applyDraftToForm(decision);
    form.hidden = false;
    error.textContent = '';
    state.activeReviewForm = { key: draftKey, close: closeForm };
    note.focus();
  }

  function closeForm() {
    pendingDecision = undefined;
    if (state.activeDraftKey === draftKey) state.activeDraftKey = undefined;
    if (state.activeReviewForm?.key === draftKey) state.activeReviewForm = undefined;
    state.drafts.delete(draftKey);
    form.hidden = true;
    note.value = '';
    error.textContent = '';
  }

  cancel.addEventListener('click', closeForm);

  note.addEventListener('input', () => {
    if (pendingDecision === undefined) return;
    state.drafts.set(draftKey, { goalId, decision: pendingDecision, note: note.value });
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
    await decideHumanReview(goalId, requirement.requirementId, pendingDecision, value, draftKey, {
      onCommit: () => {
        row.dataset.reviewState = 'committed';
        form.hidden = true;
        commitStatus.hidden = false;
        commitStatus.textContent = '裁决已记录，正在刷新队列';
      },
      onRefreshError: () => {
        commitStatus.textContent = '裁决已记录，队列刷新失败；自动刷新会继续重试。';
      },
    });
  });

  if (draft !== undefined) {
    note.value = draft.note;
    applyDraftToForm(draft.decision);
    form.hidden = false;
    if (state.activeDraftKey === draftKey) {
      state.activeReviewForm = { key: draftKey, close: closeForm };
      window.setTimeout(() => note.focus(), 0);
    }
  }

  function applyDraftToForm(decision) {
    submit.textContent = decision === 'approve' ? '确认通过' : '确认驳回';
    form.dataset.decision = decision;
  }

  row.append(indexLabel, copy, actions, form, commitStatus);
  return row;
}

function reviewButton(label, tone, focusKey, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `review-action ${tone}`;
  button.textContent = label;
  button.dataset.reviewFocusKey = focusKey;
  button.addEventListener('click', onClick);
  return button;
}

async function decideHumanReview(goalId, requirementId, decision, note, draftKey, lifecycle) {
  if (state.busy) return;
  setBusy(true);
  try {
    const result = await commitMutationThenRefresh({
      request: () => fetch(`/api/human-reviews/${encodeURIComponent(goalId)}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-jarvis-gui': '1' },
        body: JSON.stringify({
          decisions: [{ requirementId, decision, note }],
        }),
      }),
      commit: () => {
        if (state.activeReviewForm?.key === draftKey) state.activeReviewForm.close();
        else {
          state.drafts.delete(draftKey);
          if (state.activeDraftKey === draftKey) state.activeDraftKey = undefined;
        }
        applyMutationBarrier();
        state.reviewSnapshot = undefined;
        lifecycle.onCommit();
      },
      refresh,
    });
    if (result.refreshError !== undefined) {
      lifecycle.onRefreshError();
      nodes.updatedAt.textContent = `裁决已记录，刷新失败：${errorMessage(result.refreshError)}`;
    }
  } catch (err) {
    nodes.updatedAt.textContent = `裁决失败：${errorMessage(err)}`;
  } finally {
    setBusy(false);
  }
}

function setBusy(value) {
  state.busy = value;
  nodes.stopButton.disabled = value;
  for (const control of document.querySelectorAll('.review-action, .review-note, .review-submit, .review-cancel')) {
    control.disabled = value || control.closest('[data-review-state="committed"]') !== null;
  }
}

function errorMessage(value) {
  return value instanceof Error ? value.message : String(value);
}

function applyMutationBarrier() {
  const next = advanceMutationBarrier(state.refreshSequence, state.appliedRefreshSequence);
  state.refreshSequence = next.refreshSequence;
  state.appliedRefreshSequence = next.appliedRefreshSequence;
  return next.barrier;
}

function renderItem(item) {
  const li = document.createElement('li');
  const disclosure = document.createElement('details');
  disclosure.className = 'timeline-item';
  disclosure.dataset.tone = item.tone;
  disclosure.open = state.expandedTimeline.has(item.id);
  disclosure.addEventListener('toggle', () => {
    if (disclosure.open) state.expandedTimeline.add(item.id);
    else state.expandedTimeline.delete(item.id);
  });

  const summary = document.createElement('summary');
  summary.className = 'timeline-summary';
  summary.dataset.timelineFocusKey = item.id;

  const dot = document.createElement('span');
  dot.className = 'timeline-dot';
  dot.setAttribute('aria-hidden', 'true');

  const kind = document.createElement('span');
  kind.className = 'timeline-kind';
  kind.textContent = TIMELINE_KIND_LABELS[item.kind] || item.kind;

  const summaryCopy = document.createElement('div');
  summaryCopy.className = 'timeline-summary-copy';
  const title = document.createElement('h3');
  title.className = 'timeline-title';
  title.textContent = item.title;
  const preview = document.createElement('span');
  preview.className = 'timeline-preview';
  preview.textContent = item.detail;
  summaryCopy.append(title, preview);

  const time = document.createElement('time');
  time.className = 'timeline-time';
  time.textContent = item.at ? timelineTime(item.at) : '快照';
  if (item.at) time.dateTime = item.at;

  const chevron = document.createElement('span');
  chevron.className = 'timeline-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '⌄';
  summary.append(dot, kind, summaryCopy, time, chevron);

  const body = document.createElement('div');
  body.className = 'timeline-body';

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

  body.append(detail, meta);
  disclosure.append(summary, body);
  li.append(disclosure);
  return li;
}

function timelineTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
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
