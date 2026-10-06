/**
 * Jarvis-Agent · 对话主导 GUI 原型状态机与交互逻辑 (Round 2 · Gemini)
 * 纯本地内存状态驱动，无任何网络调用与真实副作用
 */

(function () {
  'use strict';

  // 状态常量定义
  const STATES = {
    PENDING_APPROVAL: 'pending_approval',
    APPROVED_RUNNING: 'approved_running',
    COMPLETED_VERIFIED: 'completed_verified',
    REJECTED: 'rejected',
    ADJUSTED: 'adjusted',
    PAUSED: 'paused',
    TERMINATED: 'terminated',
    FAILED: 'failed'
  };

  let currentState = STATES.PENDING_APPROVAL;
  let stateBeforePause = STATES.PENDING_APPROVAL;

  // DOM 元素缓存
  const dom = {
    // 顶部 Task Anchor
    statePill: document.getElementById('statePill'),
    stateSym: document.getElementById('stateSym'),
    stateText: document.getElementById('stateText'),
    verdictPill: document.getElementById('verdictPill'),
    verdictSym: document.getElementById('verdictSym'),
    verdictText: document.getElementById('verdictText'),
    phaseText: document.getElementById('phaseText'),
    btnPauseResume: document.getElementById('btnPauseResume'),
    pauseResumeIcon: document.getElementById('pauseResumeIcon'),
    pauseResumeLabel: document.getElementById('pauseResumeLabel'),
    btnTerminate: document.getElementById('btnTerminate'),
    terminateIcon: document.getElementById('terminateIcon'),
    terminateLabel: document.getElementById('terminateLabel'),
    scenarioSelector: document.getElementById('scenarioSelector'),

    // Reasoning 摘要
    reasoningToggle: document.getElementById('reasoningToggle'),
    reasoningPanel: document.getElementById('reasoningPanel'),
    reasoningIndicator: document.getElementById('reasoningIndicator'),

    // 工具管线
    toolPipelineCount: document.getElementById('toolPipelineCount'),
    pipeApplyPatch: document.getElementById('pipeApplyPatch'),
    patchPipeIcon: document.getElementById('patchPipeIcon'),
    patchPipeBadge: document.getElementById('patchPipeBadge'),
    patchPipeDesc: document.getElementById('patchPipeDesc'),
    pipeVitest: document.getElementById('pipeVitest'),
    vitestPipeIcon: document.getElementById('vitestPipeIcon'),
    vitestPipeBadge: document.getElementById('vitestPipeBadge'),
    vitestPipeDesc: document.getElementById('vitestPipeDesc'),

    // 审批卡片
    gateBlock: document.getElementById('gateBlock'),
    gateBtnRow: document.getElementById('gateBtnRow'),
    gateFeedbackBanner: document.getElementById('gateFeedbackBanner'),
    btnAllowOnce: document.getElementById('btnAllowOnce'),
    btnRequestChanges: document.getElementById('btnRequestChanges'),
    btnReject: document.getElementById('btnReject'),

    // Diff 选项卡
    tabPresentation: document.getElementById('tabPresentation'),
    tabTest: document.getElementById('tabTest'),
    diffPanePresentation: document.getElementById('diffPanePresentation'),
    diffPaneTest: document.getElementById('diffPaneTest'),

    // 验证链
    vItemVitest: document.getElementById('vItemVitest'),
    vItemVitestIcon: document.getElementById('vItemVitestIcon'),
    vItemVitestText: document.getElementById('vItemVitestText'),

    // 消息 3 (完成报告)
    msg3Final: document.getElementById('msg3Final'),
    msg3Content: document.getElementById('msg3Content'),
    msg3Timestamp: document.getElementById('msg3Timestamp'),

    // 底部浮动控制条
    bottomDock: document.getElementById('bottomDock'),
    dockDotSymbol: document.getElementById('dockDotSymbol'),
    dockStatusMsg: document.getElementById('dockStatusMsg'),
    dockRightActions: document.getElementById('dockRightActions'),
    dockBtnAllow: document.getElementById('dockBtnAllow'),
    dockBtnModify: document.getElementById('dockBtnModify'),
    dockBtnReject: document.getElementById('dockBtnReject'),

    // 对话框
    dialogAdjustment: document.getElementById('dialogAdjustment'),
    formAdjustment: document.getElementById('formAdjustment'),
    inputAdjustment: document.getElementById('inputAdjustment'),
    btnCloseAdjDialog: document.getElementById('btnCloseAdjDialog'),
    btnCancelAdj: document.getElementById('btnCancelAdj'),

    dialogTerminate: document.getElementById('dialogTerminate'),
    formTerminate: document.getElementById('formTerminate'),
    btnCloseTermDialog: document.getElementById('btnCloseTermDialog'),
    btnCancelTerm: document.getElementById('btnCancelTerm')
  };

  /**
   * 核心状态渲染器
   */
  function render(state, payload) {
    currentState = state;

    // 联动预设场景下拉框
    if (dom.scenarioSelector) {
      if (['pending_approval', 'completed_verified', 'failed', 'paused', 'terminated'].includes(state)) {
        dom.scenarioSelector.value = state;
      }
    }

    // 重置共有容器
    dom.statePill.setAttribute('data-state', state);
    dom.gateFeedbackBanner.className = 'gate-feedback-banner hidden';
    dom.gateFeedbackBanner.innerHTML = '';
    dom.gateBtnRow.classList.remove('hidden');
    dom.msg3Final.classList.add('hidden');
    dom.dockRightActions.classList.remove('hidden');

    // 重置运行控制按键图标
    dom.pauseResumeIcon.textContent = '⏸';
    dom.pauseResumeLabel.textContent = '暂停';
    dom.terminateIcon.textContent = '⏹';
    dom.terminateLabel.textContent = '终止';

    switch (state) {
      case STATES.PENDING_APPROVAL:
        renderPendingApproval();
        break;

      case STATES.APPROVED_RUNNING:
        renderApprovedRunning();
        break;

      case STATES.COMPLETED_VERIFIED:
        renderCompletedVerified();
        break;

      case STATES.REJECTED:
        renderRejected();
        break;

      case STATES.ADJUSTED:
        renderAdjusted(payload);
        break;

      case STATES.PAUSED:
        renderPaused();
        break;

      case STATES.TERMINATED:
        renderTerminated();
        break;

      case STATES.FAILED:
        renderFailed();
        break;
    }
  }

  // 1. 待审批渲染
  function renderPendingApproval() {
    dom.phaseText.textContent = '修正显示投影';
    dom.stateSym.textContent = '⚠';
    dom.stateText.textContent = '需要审批';

    dom.verdictPill.setAttribute('data-verdict', 'unauthorized');
    dom.verdictSym.textContent = '⊘';
    dom.verdictText.textContent = '完成授权未授予';

    dom.toolPipelineCount.textContent = '2 完成 · 1 待审批 · 1 排队';

    dom.pipeApplyPatch.className = 'pipe-item pipe-pending';
    dom.patchPipeIcon.textContent = '⚠';
    dom.patchPipeBadge.className = 'pipe-badge badge-amber';
    dom.patchPipeBadge.textContent = '待审批';
    dom.patchPipeDesc.innerHTML = '变更规模：<span class="diff-add-txt">+29</span> / <span class="diff-del-txt">−2</span> · 权限保护隔离中';

    dom.pipeVitest.className = 'pipe-item pipe-queued';
    dom.vitestPipeIcon.textContent = '⏳';
    dom.vitestPipeBadge.className = 'pipe-badge badge-gray';
    dom.vitestPipeBadge.textContent = '排队中';
    dom.vitestPipeDesc.textContent = '排队等待写入完成后自动触发';

    dom.vItemVitest.className = 'verify-row verify-wait';
    dom.vItemVitestIcon.textContent = '⏳';
    dom.vItemVitestText.innerHTML = '聚焦单测断言：等待 <code>gui-presentation.test.js</code> 真实执行';

    dom.dockDotSymbol.textContent = '●';
    dom.dockDotSymbol.style.color = 'var(--color-warning)';
    dom.dockStatusMsg.innerHTML = '等待审批：<code>apply_patch</code> (+29 / −2) · 权限隔离保护中';
  }

  // 2. 审批通过执行中
  function renderApprovedRunning() {
    dom.phaseText.textContent = '执行写入与运行单测';
    dom.stateSym.textContent = '⏳';
    dom.stateText.textContent = '执行中';

    dom.verdictPill.setAttribute('data-verdict', 'unauthorized');
    dom.verdictSym.textContent = '⊘';
    dom.verdictText.textContent = '完成授权未授予';

    dom.toolPipelineCount.textContent = '3 完成 · 1 执行中';

    dom.pipeApplyPatch.className = 'pipe-item pipe-done';
    dom.patchPipeIcon.textContent = '✓';
    dom.patchPipeBadge.className = 'pipe-badge badge-green';
    dom.patchPipeBadge.textContent = '已写入';

    dom.pipeVitest.className = 'pipe-item pipe-pending';
    dom.vitestPipeIcon.textContent = '⏳';
    dom.vitestPipeBadge.className = 'pipe-badge badge-amber';
    dom.vitestPipeBadge.textContent = '运行中';
    dom.vitestPipeDesc.textContent = '正在运行 vitest run test/surfaces/gui/gui-presentation.test.js...';

    dom.gateBtnRow.classList.add('hidden');
    dom.gateFeedbackBanner.className = 'gate-feedback-banner feedback-allowed';
    dom.gateFeedbackBanner.innerHTML = '<span>✓</span> <strong>已授予单次写权限：</strong> 变更已应用至工作区，正在触发聚焦测试...';

    dom.dockDotSymbol.textContent = '⏳';
    dom.dockDotSymbol.style.color = 'var(--color-primary)';
    dom.dockStatusMsg.innerHTML = '正在运行测试套件 <code>gui-presentation.test.js</code>...';
    dom.dockRightActions.classList.add('hidden');
  }

  // 3. 验收通过 (Verified)
  function renderCompletedVerified() {
    dom.phaseText.textContent = '验收通过 · 已对齐';
    dom.stateSym.textContent = '✓';
    dom.stateText.textContent = '已完成';

    // 核心判定标语
    dom.verdictPill.setAttribute('data-verdict', 'verified');
    dom.verdictSym.textContent = '✓';
    dom.verdictText.textContent = 'decideVerdict · verified（模拟）';

    dom.toolPipelineCount.textContent = '4/4 全部完成';

    dom.pipeApplyPatch.className = 'pipe-item pipe-done';
    dom.patchPipeIcon.textContent = '✓';
    dom.patchPipeBadge.className = 'pipe-badge badge-green';
    dom.patchPipeBadge.textContent = '已完成';

    dom.pipeVitest.className = 'pipe-item pipe-done';
    dom.vitestPipeIcon.textContent = '✓';
    dom.vitestPipeBadge.className = 'pipe-badge badge-green';
    dom.vitestPipeBadge.textContent = '测试通过 (2/2)';
    dom.vitestPipeDesc.textContent = '单测全部通过 · 耗时 184ms · 覆盖 session:resumed 与 task:restored';

    dom.vItemVitest.className = 'verify-row verify-ok';
    dom.vItemVitestIcon.textContent = '✓';
    dom.vItemVitestText.innerHTML = '聚焦单测断言：<code>gui-presentation.test.js</code> 全部通过 (2 passed)';

    dom.gateBtnRow.classList.add('hidden');
    dom.gateFeedbackBanner.className = 'gate-feedback-banner feedback-allowed';
    dom.gateFeedbackBanner.innerHTML = '<span>✓</span> <strong>一次性写操作已落地并验证通过：</strong> Git 工作区保持干净投影。';

    // 消息 3 展开
    dom.msg3Final.classList.remove('hidden');
    dom.msg3Timestamp.textContent = '19:29:28';
    dom.msg3Content.innerHTML = `
      <div class="result-card result-ok">
        <div class="result-top-line">
          <div class="result-heading">
            <span>✓</span> 任务验证通过：decideVerdict · verified（模拟）
          </div>
          <span class="result-mono-meta mono">Session: GUI-RECOVER-17</span>
        </div>
        <div class="result-evidence-body">
          <p><strong>交付证据摘要：</strong></p>
          <ul style="padding-left: 18px; margin-top: 6px; line-height: 1.6;">
            <li>已在 <code>src/surfaces/gui/assets/presentation.js</code> 显式监听会话恢复事件，消除时序竞争。</li>
            <li>新增 <code>test/surfaces/gui/gui-presentation.test.js</code> 聚焦回归测试，两项断言均为绿灯。</li>
            <li>现有 <code>createPresentationPipeline</code> API 接口及完成授权机制保持零破坏。</li>
          </ul>
          <pre><code>✓ test/surfaces/gui/gui-presentation.test.js (2 tests) 184ms
  ✓ presentation pipeline recovery sync > should immediately sync diff projection when session:resumed fires
  ✓ presentation pipeline recovery sync > should retain clean state when no stored diff

Test Files  1 passed (1)
     Tests  2 passed (2)
  Duration  312ms</code></pre>
        </div>
      </div>
    `;

    dom.dockDotSymbol.textContent = '✓';
    dom.dockDotSymbol.style.color = 'var(--color-success)';
    dom.dockStatusMsg.innerHTML = '任务验证完成 · <strong>decideVerdict · verified（模拟）</strong> · 证据链完备';
    dom.dockRightActions.classList.add('hidden');
  }

  // 4. 拒绝执行
  function renderRejected() {
    dom.phaseText.textContent = '写操作已拦截';
    dom.stateSym.textContent = '⊘';
    dom.stateText.textContent = '已拒绝';

    dom.verdictPill.setAttribute('data-verdict', 'unauthorized');
    dom.verdictSym.textContent = '⊘';
    dom.verdictText.textContent = '完成授权未授予';

    dom.toolPipelineCount.textContent = '2 完成 · 1 已拒绝 · 1 已取消';

    dom.pipeApplyPatch.className = 'pipe-item pipe-error';
    dom.patchPipeIcon.textContent = '⊘';
    dom.patchPipeBadge.className = 'pipe-badge badge-red';
    dom.patchPipeBadge.textContent = '用户拒绝';

    dom.pipeVitest.className = 'pipe-item pipe-queued';
    dom.vitestPipeIcon.textContent = '—';
    dom.vitestPipeBadge.className = 'pipe-badge badge-gray';
    dom.vitestPipeBadge.textContent = '已跳过';
    dom.vitestPipeDesc.textContent = '因前置写入被拒绝，测试未执行';

    dom.gateBtnRow.classList.add('hidden');
    dom.gateFeedbackBanner.className = 'gate-feedback-banner feedback-rejected';
    dom.gateFeedbackBanner.innerHTML = '<span>⊘</span> <strong>用户已拒绝一次性写入授权：</strong> 未对本地工作区进行任何文件修改。';

    dom.msg3Final.classList.remove('hidden');
    dom.msg3Timestamp.textContent = '19:29:22';
    dom.msg3Content.innerHTML = `
      <div class="result-card result-err">
        <div class="result-top-line">
          <div class="result-heading">
            <span>⊘</span> 执行已挂起：写权限未被授予
          </div>
          <span class="result-mono-meta mono">完成授权未授予</span>
        </div>
        <div class="result-evidence-body">
          <p>已中止本次补丁写入流程。工作区未发生任何改动。请在对话框输入新的指令或修正方案。</p>
        </div>
      </div>
    `;

    dom.dockDotSymbol.textContent = '⊘';
    dom.dockDotSymbol.style.color = 'var(--color-danger)';
    dom.dockStatusMsg.innerHTML = '已拒绝写入 · 工作区无改动 · 完成授权未授予';
    dom.dockRightActions.classList.add('hidden');
  }

  // 5. 调整中
  function renderAdjusted(feedbackText) {
    const feedback = feedbackText || '要求在 sessionStore 层做聚合收敛，而非直接暴露 emit';
    dom.phaseText.textContent = '重新审视补丁设计';
    dom.stateSym.textContent = '✎';
    dom.stateText.textContent = '调整中';

    dom.verdictPill.setAttribute('data-verdict', 'unauthorized');
    dom.verdictSym.textContent = '⊘';
    dom.verdictText.textContent = '完成授权未授予';

    dom.gateBtnRow.classList.add('hidden');
    dom.gateFeedbackBanner.className = 'gate-feedback-banner feedback-modified';
    dom.gateFeedbackBanner.innerHTML = `<span>✎</span> <strong>用户要求调整：</strong> "${escapeHtml(feedback)}"。Jarvis 正在重新推导最小变更...`;

    dom.dockDotSymbol.textContent = '✎';
    dom.dockDotSymbol.style.color = 'var(--color-primary)';
    dom.dockStatusMsg.innerHTML = '已接收调整意见 · 正在重新规划变更方案';
    dom.dockRightActions.classList.add('hidden');
  }

  // 6. 暂停
  function renderPaused() {
    dom.stateSym.textContent = '⏸';
    dom.stateText.textContent = '已暂停';
    dom.verdictPill.setAttribute('data-verdict', 'unauthorized');
    dom.verdictSym.textContent = '⊘';
    dom.verdictText.textContent = '完成授权未授予';

    dom.pauseResumeIcon.textContent = '▶';
    dom.pauseResumeLabel.textContent = '继续';

    dom.dockDotSymbol.textContent = '⏸';
    dom.dockDotSymbol.style.color = 'var(--text-muted)';
    dom.dockStatusMsg.innerHTML = 'Agent 执行循环已暂停 · 状态已封存';
  }

  // 7. 终止
  function renderTerminated() {
    dom.phaseText.textContent = '任务已人工终止';
    dom.stateSym.textContent = '⏹';
    dom.stateText.textContent = '已终止';

    dom.verdictPill.setAttribute('data-verdict', 'unauthorized');
    dom.verdictSym.textContent = '⊘';
    dom.verdictText.textContent = '完成授权未授予';

    dom.terminateIcon.textContent = '↺';
    dom.terminateLabel.textContent = '恢复';

    dom.gateBtnRow.classList.add('hidden');
    dom.gateFeedbackBanner.className = 'gate-feedback-banner feedback-rejected';
    dom.gateFeedbackBanner.innerHTML = '<span>⏹</span> <strong>任务已被人工终止：</strong> 释放所有锁与资源。';

    dom.dockDotSymbol.textContent = '⏹';
    dom.dockDotSymbol.style.color = 'var(--color-danger)';
    dom.dockStatusMsg.innerHTML = '任务已终止 · 完成授权未授予';
    dom.dockRightActions.classList.add('hidden');
  }

  // 8. 失败场景
  function renderFailed() {
    dom.phaseText.textContent = '单测断言失败';
    dom.stateSym.textContent = '✕';
    dom.stateText.textContent = '执行失败';

    dom.verdictPill.setAttribute('data-verdict', 'unauthorized');
    dom.verdictSym.textContent = '⊘';
    dom.verdictText.textContent = '完成授权未授予';

    dom.toolPipelineCount.textContent = '3 完成 · 1 失败';

    dom.pipeApplyPatch.className = 'pipe-item pipe-done';
    dom.patchPipeIcon.textContent = '✓';
    dom.patchPipeBadge.className = 'pipe-badge badge-green';
    dom.patchPipeBadge.textContent = '已写入';

    dom.pipeVitest.className = 'pipe-item pipe-error';
    dom.vitestPipeIcon.textContent = '✕';
    dom.vitestPipeBadge.className = 'pipe-badge badge-red';
    dom.vitestPipeBadge.textContent = '单测失败 (1/2)';
    dom.vitestPipeDesc.textContent = '断言失败：expected diff to contain presentation.js (AssertionError)';

    dom.vItemVitest.className = 'verify-row verify-ng';
    dom.vItemVitestIcon.textContent = '✕';
    dom.vItemVitestText.innerHTML = '聚焦单测断言：<code>gui-presentation.test.js</code> 发生 1 项断言失败';

    dom.gateBtnRow.classList.add('hidden');
    dom.gateFeedbackBanner.className = 'gate-feedback-banner feedback-rejected';
    dom.gateFeedbackBanner.innerHTML = '<span>✕</span> <strong>测试未通过：</strong> 触发安全熔断，完成授权保持未授予。';

    dom.msg3Final.classList.remove('hidden');
    dom.msg3Timestamp.textContent = '19:29:26';
    dom.msg3Content.innerHTML = `
      <div class="result-card result-err">
        <div class="result-top-line">
          <div class="result-heading">
            <span>✕</span> 验证链断言失败 · 完成授权未授予
          </div>
          <span class="result-mono-meta mono">Status: FAILED</span>
        </div>
        <div class="result-evidence-body">
          <p><strong>失败原因与排查依据：</strong></p>
          <p style="color: var(--color-danger); margin: 6px 0;">AssertionError: expected null not to be null (diff property missing in restored state)</p>
          <pre><code>FAIL test/surfaces/gui/gui-presentation.test.js > presentation pipeline recovery sync
  AssertionError: expected null not to be null
   ❯ test/surfaces/gui/gui-presentation.test.js:93:47
   ❯ runTest (vitest/runtime.js:144:12)</code></pre>
          <p style="margin-top: 8px;">根据完成授权铁律，未满足全部验证前，系统拒绝签署完成授权。</p>
        </div>
      </div>
    `;

    dom.dockDotSymbol.textContent = '✕';
    dom.dockDotSymbol.style.color = 'var(--color-danger)';
    dom.dockStatusMsg.innerHTML = '单测失败 · <strong>完成授权未授予</strong> · 请审阅失败调用栈';
    dom.dockRightActions.classList.add('hidden');
  }

  function escapeHtml(str) {
    return str.replace(/[&<>'"]/g, tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag));
  }

  /**
   * 绑定所有交互事件
   */
  function bindEvents() {
    // 审批操作（卡片内）
    dom.btnAllowOnce.addEventListener('click', () => {
      render(STATES.APPROVED_RUNNING);
      setTimeout(() => render(STATES.COMPLETED_VERIFIED), 650);
    });
    dom.btnReject.addEventListener('click', () => render(STATES.REJECTED));
    dom.btnRequestChanges.addEventListener('click', () => {
      dom.dialogAdjustment.showModal();
      dom.inputAdjustment.focus();
    });

    // 审批操作（底部 Dock）
    dom.dockBtnAllow.addEventListener('click', () => {
      render(STATES.APPROVED_RUNNING);
      setTimeout(() => render(STATES.COMPLETED_VERIFIED), 650);
    });
    dom.dockBtnReject.addEventListener('click', () => render(STATES.REJECTED));
    dom.dockBtnModify.addEventListener('click', () => {
      dom.dialogAdjustment.showModal();
      dom.inputAdjustment.focus();
    });

    // 调整弹窗
    dom.btnCloseAdjDialog.addEventListener('click', () => dom.dialogAdjustment.close());
    dom.btnCancelAdj.addEventListener('click', () => dom.dialogAdjustment.close());
    dom.formAdjustment.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = dom.inputAdjustment.value.trim();
      dom.dialogAdjustment.close();
      render(STATES.ADJUSTED, val);
    });

    // 终止弹窗
    dom.btnTerminate.addEventListener('click', () => {
      if (currentState === STATES.TERMINATED) {
        render(STATES.PENDING_APPROVAL);
      } else {
        dom.dialogTerminate.showModal();
      }
    });
    dom.btnCloseTermDialog.addEventListener('click', () => dom.dialogTerminate.close());
    dom.btnCancelTerm.addEventListener('click', () => dom.dialogTerminate.close());
    dom.formTerminate.addEventListener('submit', (e) => {
      e.preventDefault();
      dom.dialogTerminate.close();
      render(STATES.TERMINATED);
    });

    // 暂停/继续
    dom.btnPauseResume.addEventListener('click', () => {
      if (currentState === STATES.PAUSED) {
        render(stateBeforePause || STATES.PENDING_APPROVAL);
      } else {
        stateBeforePause = currentState;
        render(STATES.PAUSED);
      }
    });

    // 预设场景切换
    dom.scenarioSelector.addEventListener('change', (e) => {
      const selected = e.target.value;
      if (selected === STATES.APPROVED_RUNNING) {
        render(STATES.APPROVED_RUNNING);
        setTimeout(() => render(STATES.COMPLETED_VERIFIED), 650);
      } else {
        render(selected);
      }
    });

    // Reasoning 折叠展开
    dom.reasoningToggle.addEventListener('click', () => {
      const isExp = dom.reasoningToggle.getAttribute('aria-expanded') === 'true';
      dom.reasoningToggle.setAttribute('aria-expanded', !isExp);
      dom.reasoningPanel.classList.toggle('hidden', isExp);
      dom.reasoningIndicator.textContent = isExp ? '展开 ▼' : '收起 ▲';
    });

    // Diff 选项卡切换
    dom.tabPresentation.addEventListener('click', () => {
      dom.tabPresentation.classList.add('active');
      dom.tabPresentation.setAttribute('aria-selected', 'true');
      dom.tabTest.classList.remove('active');
      dom.tabTest.setAttribute('aria-selected', 'false');
      dom.diffPanePresentation.classList.remove('hidden');
      dom.diffPaneTest.classList.add('hidden');
    });

    dom.tabTest.addEventListener('click', () => {
      dom.tabTest.classList.add('active');
      dom.tabTest.setAttribute('aria-selected', 'true');
      dom.tabPresentation.classList.remove('active');
      dom.tabPresentation.setAttribute('aria-selected', 'false');
      dom.diffPaneTest.classList.remove('hidden');
      dom.diffPanePresentation.classList.add('hidden');
    });

    // 键盘快捷键 (A/R/M/Space/Esc)
    window.addEventListener('keydown', (e) => {
      const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
      if (activeTag === 'textarea' || activeTag === 'input') {
        if (e.key === 'Escape') {
          if (dom.dialogAdjustment.open) dom.dialogAdjustment.close();
          if (dom.dialogTerminate.open) dom.dialogTerminate.close();
        }
        return;
      }

      if (e.key === 'a' || e.key === 'A') {
        if (currentState === STATES.PENDING_APPROVAL) {
          e.preventDefault();
          dom.btnAllowOnce.click();
        }
      } else if (e.key === 'r' || e.key === 'R') {
        if (currentState === STATES.PENDING_APPROVAL) {
          e.preventDefault();
          dom.btnReject.click();
        }
      } else if (e.key === 'm' || e.key === 'M') {
        if (currentState === STATES.PENDING_APPROVAL) {
          e.preventDefault();
          dom.btnRequestChanges.click();
        }
      } else if (e.code === 'Space') {
        e.preventDefault();
        dom.btnPauseResume.click();
      } else if (e.key === 'Escape') {
        if (dom.dialogAdjustment.open) dom.dialogAdjustment.close();
        if (dom.dialogTerminate.open) dom.dialogTerminate.close();
      }
    });
  }

  // 初始化
  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    render(STATES.PENDING_APPROVAL);
  });
})();
