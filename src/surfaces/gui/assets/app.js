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
  timeline: document.querySelector('#timeline'),
};

nodes.stopButton.addEventListener('click', async () => {
  if (state.busy) return;
  state.busy = true;
  nodes.stopButton.disabled = true;
  try {
    await fetch('/api/emergency-stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jarvis-gui': '1' },
      body: JSON.stringify({ reason: 'GUI emergency stop' }),
    });
    await refresh();
  } finally {
    state.busy = false;
    nodes.stopButton.disabled = false;
  }
});

async function refresh() {
  const response = await fetch('/api/status', { cache: 'no-store' });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const payload = await response.json();
  render(payload);
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
  nodes.timeline.replaceChildren(...payload.timeline.map(renderItem));
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
