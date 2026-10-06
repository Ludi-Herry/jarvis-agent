(() => {
  'use strict';

  const scenario = window.JARVIS_SCENARIO;
  if (!scenario) throw new Error('JARVIS_SCENARIO is required');

  const stateCopy = Object.freeze({
    running: {
      label: '运行中',
      detail: '正在修正显示投影',
      tone: 'info',
      completion: '完成授权：未授予',
      outcome: '当前仍在执行；界面没有完成权。',
    },
    approval: {
      label: '需要审批',
      detail: '一次性写入 2 个现有文件',
      tone: 'warning',
      completion: '完成授权：未授予',
      outcome: '高影响动作已停在人工 gate。',
    },
    paused: {
      label: '已暂停',
      detail: '执行现场已保留，可继续或终止',
      tone: 'muted',
      completion: '完成授权：未授予',
      outcome: 'Session 与待处理动作保持原位。',
    },
    interrupted: {
      label: '已终止',
      detail: '运行已中断，现场可恢复',
      tone: 'danger',
      completion: '完成授权：未授予',
      outcome: '终止只影响模拟状态；恢复入口保持可达。',
    },
    restored: {
      label: '已恢复现场',
      detail: '从 sequence 128 继续',
      tone: 'info',
      completion: '完成授权：未授予',
      outcome: '已恢复消息、工具与审批上下文。',
    },
    completed: {
      label: '已完成',
      detail: '聚焦测试通过，验证链已授权',
      tone: 'success',
      completion: '完成授权：decideVerdict · verified（模拟）',
      outcome: scenario.terminal.success,
    },
    failed: {
      label: '运行失败',
      detail: '聚焦测试失败，保留原始证据',
      tone: 'danger',
      completion: '完成授权：未授予',
      outcome: scenario.terminal.failure,
    },
  });

  const statusWords = Object.freeze({
    complete: '完成',
    approval: '待批',
    pending: '待办',
    pass: '通过',
    blocked: '阻塞',
    modified: '修改',
  });

  let currentState = document.body.dataset.runState || 'approval';
  let toastTimer;

  function valueAtPath(path) {
    return path.split('.').reduce((value, key) => value?.[key], scenario);
  }

  function bindScenarioText() {
    document.querySelectorAll('[data-bind]').forEach((node) => {
      const value = valueAtPath(node.dataset.bind || '');
      if (value !== undefined && value !== null) node.textContent = String(value);
    });
  }

  function makeStatus(status) {
    const mark = document.createElement('span');
    mark.className = 'status-word';
    mark.dataset.status = status;
    mark.textContent = statusWords[status] || status;
    return mark;
  }

  function renderMessages() {
    document.querySelectorAll('[data-message-list]').forEach((container) => {
      const limit = Number.parseInt(container.dataset.messageLimit || '', 10);
      const messages = Number.isFinite(limit) ? scenario.messages.slice(-limit) : scenario.messages;
      container.replaceChildren(...messages.map((message) => {
        const article = document.createElement('article');
        article.className = 'message-item';
        article.dataset.role = message.role;
        const meta = document.createElement('div');
        meta.className = 'message-meta';
        const author = document.createElement('strong');
        author.textContent = message.name;
        const time = document.createElement('time');
        time.textContent = message.time;
        meta.append(author, time);
        const body = document.createElement('p');
        body.textContent = message.body;
        article.append(meta, body);
        return article;
      }));
    });
  }

  function renderReasoning() {
    document.querySelectorAll('[data-reasoning-list]').forEach((container) => {
      container.replaceChildren(...scenario.reasoning.map((line, index) => {
        const item = document.createElement('li');
        const number = document.createElement('span');
        number.textContent = String(index + 1).padStart(2, '0');
        const copy = document.createElement('p');
        copy.textContent = line;
        item.append(number, copy);
        return item;
      }));
    });
  }

  function renderPlan() {
    document.querySelectorAll('[data-plan-list]').forEach((container) => {
      container.replaceChildren(...scenario.plan.map((step) => {
        const item = document.createElement('li');
        item.className = 'plan-item';
        item.dataset.status = step.status;
        const number = document.createElement('span');
        number.className = 'plan-number';
        number.textContent = step.id;
        const copy = document.createElement('div');
        copy.className = 'plan-copy';
        const label = document.createElement('strong');
        label.textContent = step.label;
        const detail = document.createElement('span');
        detail.textContent = step.detail;
        copy.append(label, detail);
        item.append(number, copy, makeStatus(step.status));
        return item;
      }));
    });
  }

  function renderTools() {
    document.querySelectorAll('[data-tool-list]').forEach((container) => {
      container.replaceChildren(...scenario.tools.map((tool) => {
        const item = document.createElement('li');
        item.className = 'tool-item';
        item.dataset.status = tool.status;
        const name = document.createElement('code');
        name.textContent = tool.name;
        const target = document.createElement('span');
        target.className = 'tool-target';
        target.textContent = tool.target;
        const detail = document.createElement('span');
        detail.className = 'tool-detail';
        detail.textContent = tool.detail;
        item.append(makeStatus(tool.status), name, target, detail);
        return item;
      }));
    });
  }

  function renderArtifacts() {
    document.querySelectorAll('[data-file-list]').forEach((container) => {
      container.replaceChildren(...scenario.artifacts.map((artifact) => {
        const item = document.createElement('li');
        item.className = 'file-item';
        const path = document.createElement('span');
        path.textContent = artifact.path;
        const delta = document.createElement('strong');
        delta.textContent = artifact.delta;
        item.append(path, delta);
        return item;
      }));
    });
  }

  function renderChecks() {
    document.querySelectorAll('[data-check-list]').forEach((container) => {
      container.replaceChildren(...scenario.checks.map((check) => {
        const item = document.createElement('li');
        item.className = 'check-item';
        item.dataset.status = check.status;
        const label = document.createElement('span');
        label.textContent = check.label;
        const value = document.createElement('strong');
        value.textContent = check.value;
        item.append(label, value);
        return item;
      }));
    });
  }

  function renderDiff() {
    document.querySelectorAll('[data-diff-lines]').forEach((container) => {
      container.replaceChildren(...scenario.diff.map((line) => {
        const row = document.createElement('div');
        row.className = 'diff-row';
        row.dataset.kind = line.kind;
        const oldLine = document.createElement('span');
        oldLine.className = 'diff-gutter';
        oldLine.textContent = line.old;
        const nextLine = document.createElement('span');
        nextLine.className = 'diff-gutter';
        nextLine.textContent = line.next;
        const code = document.createElement('code');
        code.textContent = line.text || ' ';
        row.append(oldLine, nextLine, code);
        return row;
      }));
    });
  }

  function updateControls(state) {
    document.querySelectorAll('[data-action="pause"]').forEach((button) => {
      button.disabled = !['running', 'approval', 'restored'].includes(state);
    });
    document.querySelectorAll('[data-action="resume"]').forEach((button) => {
      button.disabled = state !== 'paused';
    });
    document.querySelectorAll('[data-action="recover"]').forEach((button) => {
      button.disabled = !['failed', 'interrupted'].includes(state);
    });
    document.querySelectorAll('[data-action="terminate"]').forEach((button) => {
      button.disabled = ['completed', 'interrupted'].includes(state);
    });
  }

  function setState(state, { announce = true } = {}) {
    const presentation = stateCopy[state];
    if (!presentation) return;
    currentState = state;
    document.body.dataset.runState = state;
    document.querySelectorAll('[data-run-label]').forEach((node) => { node.textContent = presentation.label; });
    document.querySelectorAll('[data-run-detail]').forEach((node) => { node.textContent = presentation.detail; });
    document.querySelectorAll('[data-run-tone]').forEach((node) => { node.dataset.tone = presentation.tone; });
    document.querySelectorAll('[data-completion-copy]').forEach((node) => { node.textContent = presentation.completion; });
    document.querySelectorAll('[data-outcome-copy]').forEach((node) => { node.textContent = presentation.outcome; });
    document.querySelectorAll('[data-state-option]').forEach((button) => {
      const selected = button.dataset.stateOption === state;
      button.setAttribute('aria-pressed', String(selected));
      button.dataset.selected = String(selected);
    });
    updateControls(state);
    if (state === 'approval') setApproval('pending', '等待你的决定');
    if (announce) showToast(`模拟状态：${presentation.label}。${presentation.detail}`);
  }

  function setApproval(state, label) {
    document.querySelectorAll('[data-approval-state]').forEach((node) => {
      node.dataset.state = state;
      node.textContent = label;
    });
  }

  function showToast(message) {
    const toast = document.querySelector('[data-toast]');
    if (!toast) return;
    toast.textContent = message;
    toast.dataset.open = 'true';
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.dataset.open = 'false'; }, 2600);
  }

  function wireStateOptions() {
    document.querySelectorAll('[data-state-option]').forEach((button) => {
      button.addEventListener('click', () => setState(button.dataset.stateOption || 'approval'));
    });
  }

  function wireRunControls() {
    document.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.action;
        if (action === 'pause') setState('paused');
        if (action === 'resume') setState('running');
        if (action === 'recover') {
          setState('restored');
          window.setTimeout(() => setState('running', { announce: false }), 900);
        }
        if (action === 'terminate') {
          const dialog = document.querySelector('[data-terminate-dialog]');
          if (dialog instanceof HTMLDialogElement) dialog.showModal();
        }
      });
    });

    document.querySelectorAll('[data-close-dialog]').forEach((button) => {
      button.addEventListener('click', () => button.closest('dialog')?.close());
    });
    document.querySelectorAll('[data-confirm-terminate]').forEach((button) => {
      button.addEventListener('click', () => {
        button.closest('dialog')?.close();
        setState('interrupted');
      });
    });
  }

  function wireApproval() {
    document.querySelectorAll('[data-approval-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.approvalAction;
        if (action === 'approve-once') {
          setApproval('allowed', '已允许一次（模拟）');
          setState('running');
        }
        if (action === 'reject') {
          setApproval('denied', '已拒绝（模拟）');
          setState('failed');
        }
        if (action === 'revise') {
          setApproval('revised', '已要求调整（模拟）');
          setState('paused');
        }
      });
    });
  }

  function wireTabs() {
    document.querySelectorAll('[data-tabs]').forEach((tabset) => {
      const buttons = [...tabset.querySelectorAll('[data-tab-target]')];
      const owner = tabset.closest('[data-tab-scope]') || document;
      const panels = [...owner.querySelectorAll('[data-tab-panel]')];
      buttons.forEach((button) => {
        button.addEventListener('click', () => {
          const target = button.dataset.tabTarget;
          buttons.forEach((candidate) => {
            const selected = candidate === button;
            candidate.setAttribute('aria-selected', String(selected));
            candidate.dataset.selected = String(selected);
          });
          panels.forEach((panel) => { panel.hidden = panel.dataset.tabPanel !== target; });
        });
      });
    });
  }

  function wireArtifactAnnotations() {
    document.querySelectorAll('[data-comment-anchor]').forEach((button) => {
      button.addEventListener('click', () => {
        const input = document.querySelector('.annotation-composer input');
        if (input instanceof HTMLInputElement) input.focus();
        showToast('批注已锚定到 presentation.js : 123（模拟）');
      });
    });
  }

  function cssMilliseconds(name, fallback) {
    const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
    return Number.isFinite(value) ? value : fallback;
  }

  function startThinkingStates(box) {
    const states = (box.dataset.thinkStates || '').split('|').map((item) => item.trim()).filter(Boolean);
    if (states.length < 2) return;
    let live = box.querySelector('.t-think-text');
    if (!live) return;
    let index = 0;

    const cycle = () => {
      window.setTimeout(() => {
        const swap = cssMilliseconds('--think-swap', 150);
        const gap = cssMilliseconds('--think-gap', 50);
        const leaving = live;
        index = (index + 1) % states.length;
        leaving.classList.add('is-exit');

        const next = document.createElement('span');
        next.className = 't-think-text is-enter-start';
        next.textContent = states[index];
        next.setAttribute('data-text', states[index]);
        box.appendChild(next);
        live = next;

        const release = () => {
          void next.offsetWidth;
          next.classList.remove('is-enter-start');
        };
        if (gap > 0) window.setTimeout(release, gap);
        else release();

        window.setTimeout(() => {
          leaving.remove();
          cycle();
        }, swap + gap);
      }, cssMilliseconds('--think-hold', 2400));
    };
    cycle();
  }

  bindScenarioText();
  renderMessages();
  renderReasoning();
  renderPlan();
  renderTools();
  renderArtifacts();
  renderChecks();
  renderDiff();
  wireStateOptions();
  wireRunControls();
  wireApproval();
  wireTabs();
  wireArtifactAnnotations();
  document.querySelectorAll('.t-think').forEach(startThinkingStates);
  setState(currentState, { announce: false });
  document.documentElement.dataset.prototypeReady = 'true';

  window.JARVIS_PROTOTYPE = Object.freeze({
    scenario,
    getState: () => currentState,
    setState,
  });
})();
