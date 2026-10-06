(() => {
  'use strict';

  const body = document.body;
  const evidencePanel = document.querySelector('#evidence-panel');
  const reviewToggle = document.querySelector('#review-size-toggle');
  const authoritySeal = document.querySelector('[data-authority-seal]');
  const authorityShort = document.querySelector('[data-authority-short]');

  const evidenceTabs = Object.fromEntries(
    [...document.querySelectorAll('[data-tab-target]')].map((button) => [button.dataset.tabTarget, button]),
  );

  function setReviewExpanded(expanded) {
    body.classList.toggle('review-expanded', expanded);
    reviewToggle?.setAttribute('aria-pressed', String(expanded));
    if (reviewToggle) reviewToggle.textContent = expanded ? '收起审阅' : '展开审阅';
  }

  function flashEvidence() {
    if (!evidencePanel) return;
    evidencePanel.classList.remove('is-linked');
    void evidencePanel.offsetWidth;
    evidencePanel.classList.add('is-linked');
    window.setTimeout(() => evidencePanel.classList.remove('is-linked'), 700);
  }

  function activateEvidence(name, { expand = true } = {}) {
    const tab = evidenceTabs[name];
    if (!tab) return;
    tab.click();
    if (expand) setReviewExpanded(true);
    if (evidencePanel) evidencePanel.scrollTop = 0;
    flashEvidence();
  }

  function updateAuthoritySeal() {
    const state = body.dataset.runState || 'approval';
    const granted = state === 'completed';
    if (authorityShort) authorityShort.textContent = granted ? '已授权' : '未授予';
    if (authoritySeal) {
      authoritySeal.setAttribute('aria-label', granted ? '完成授权已由 decideVerdict 授予（模拟）' : '完成授权未授予');
    }
  }

  reviewToggle?.addEventListener('click', () => {
    setReviewExpanded(!body.classList.contains('review-expanded'));
  });

  document.querySelectorAll('[data-approval-action="approve-once"]').forEach((button) => {
    button.addEventListener('click', () => {
      window.setTimeout(() => activateEvidence('verification'), 0);
    });
  });

  const toolEvidence = {
    read_file: 'context',
    rg: 'context',
    apply_patch: 'diff',
    vitest: 'verification',
  };

  document.querySelectorAll('.tool-item').forEach((item) => {
    const name = item.querySelector('code')?.textContent?.trim();
    const target = toolEvidence[name];
    if (!target) return;
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.setAttribute('aria-label', `查看 ${name} 关联证据`);
    item.addEventListener('click', () => activateEvidence(target));
    item.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activateEvidence(target);
    });
  });

  const stateObserver = new MutationObserver(updateAuthoritySeal);
  stateObserver.observe(body, { attributes: true, attributeFilter: ['data-run-state'] });

  updateAuthoritySeal();
  setReviewExpanded(false);

  window.JARVIS_REFINED = Object.freeze({
    activateEvidence,
    setReviewExpanded,
  });
})();
