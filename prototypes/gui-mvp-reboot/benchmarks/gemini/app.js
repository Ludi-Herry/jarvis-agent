/**
 * Jarvis-Agent · 对话主导 GUI 原型状态机与交互脚本 (Gemini 比稿)
 * 纯本地内存状态驱动，无任何网络请求与真实副作用
 */

(function () {
  'use strict';

  // 状态定义
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
  let previousStateBeforePause = STATES.PENDING_APPROVAL;

  // DOM 元素缓存
  const els = {
    // 顶部 Anchor
    stateBadge: document.getElementById('stateBadge'),
    stateIcon: document.getElementById('stateIcon'),
    stateText: document.getElementById('stateText'),
    verdictBadge: document.getElementById('verdictBadge'),
    verdictIcon: document.getElementById('verdictIcon'),
    verdictText: document.getElementById('verdictText'),
    phaseText: document.getElementById('phaseText'),
    btnPauseResume: document.getElementById('btnPauseResume'),
    pauseResumeIcon: document.getElementById('pauseResumeIcon'),
    pauseResumeLabel: document.getElementById('pauseResumeLabel'),
    btnTerminate: document.getElementById('btnTerminate'),
    terminateIcon: document.getElementById('terminateIcon'),
    terminateLabel: document.getElementById('terminateLabel'),
    scenarioSelect: document.getElementById('scenarioSelect'),

    // Reasoning 折叠
    reasoningToggle: document.getElementById('reasoningToggle'),
    reasoningContent: document.getElementById('reasoningContent'),
    reasoningIndicator: document.getElementById('reasoningIndicator'),

    // 工具管线
    toolSummary: document.getElementById('toolSummary'),
    toolApplyPatch: document.getElementById('toolApplyPatch'),
    patchToolIcon: document.getElementById('patchToolIcon'),
    patchToolTag: document.getElementById('patchToolTag'),
    patchToolMeta: document.getElementById('patchToolMeta'),
    toolVitest: document.getElementById('toolVitest'),
    vitestIcon: document.getElementById('vitestIcon'),
    vitestTag: document.getElementById('vitestTag'),
    vitestMeta: document.getElementById('vitestMeta'),

    // 审批卡片
    approvalGateCard: document.getElementById('approvalGateCard'),
    gateActionButtons: document.getElementById('gateActionButtons'),
    gateDecisionResult: document.getElementById('gateDecisionResult'),
    btnAllowOnce: document.getElementById('btnAllowOnce'),
    btnRequestChanges: document.getElementById('btnRequestChanges'),
    btnReject: document.getElementById('btnReject'),

    // Diff Tabs
    tabPresentation: document.getElementById('tabPresentation'),
    tabTest: document.getElementById('tabTest'),
    diffPresentation: document.getElementById('diffPresentation'),
    diffTest: document.getElementById('diffTest'),

    // 验证项
    chkVitest: document.getElementById('chkVitest'),
    chkVitestIcon: document.getElementById('chkVitestIcon'),
    chkVitestText: document.getElementById('chkVitestText'),

    // 消息 3
    msg3Final: document.getElementById('msg3Final'),
    msg3Body: document.getElementById('msg3Body'),
    msg3Time: document.getElementById('msg3Time'),

    // 底部 Dock
    persistentDock: document.getElementById('persistentDock'),
    dockDot: document.getElementById('dockDot'),
    dockText: document.getElementById('dockText'),
    dockActionGroup: document.getElementById('dockActionGroup'),
    dockBtnAllow: document.getElementById('dockBtnAllow'),
    dockBtnModify: document.getElementById('dockBtnModify'),
    dockBtnReject: document.getElementById('dockBtnReject'),

    // 对话框
    modalAdjustment: document.getElementById('modalAdjustment'),
    formAdjustment: document.getElementById('formAdjustment'),
    adjInput: document.getElementById('adjInput'),
    btnCloseAdjModal: document.getElementById('btnCloseAdjModal'),
    btnCancelAdj: document.getElementById('btnCancelAdj'),

    modalTerminate: document.getElementById('modalTerminate'),
    formTerminate: document.getElementById('formTerminate'),
    btnCloseTermModal: document.getElementById('btnCloseTermModal'),
    btnCancelTerm: document.getElementById('btnCancelTerm')
  };

  /**
   * 核心状态渲染器
   */
  function renderState(state, payload) {
    currentState = state;

    // 同步场景下拉框
    if (els.scenarioSelect) {
      if (['pending_approval', 'completed_verified', 'failed', 'paused', 'terminated'].includes(state)) {
        els.scenarioSelect.value = state;
      }
    }

    // 基础重置
    els.stateBadge.setAttribute('data-state', state);
    els.gateDecisionResult.className = 'gate-verdict-banner hidden';
    els.gateDecisionResult.innerHTML = '';
    els.gateActionButtons.classList.remove('hidden');
    els.msg3Final.classList.add('hidden');
    els.dockActionGroup.classList.remove('hidden');

    // 运行控制按钮重置
    els.pauseResumeIcon.textContent = '⏸';
    els.pauseResumeLabel.textContent = '暂停';
    els.terminateIcon.textContent = '⏹';
    els.terminateLabel.textContent = '终止';

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

  // 1. 待审批状态渲染
  function renderPendingApproval() {
    els.phaseText.textContent = '修正显示投影';
    els.stateIcon.textContent = '⚠';
    els.stateText.textContent = '需要审批';

    // 明确显示：完成授权未授予
    els.verdictBadge.setAttribute('data-verdict', 'unauthorized');
    els.verdictIcon.textContent = '⊘';
    els.verdictText.textContent = '完成授权未授予';

    els.toolSummary.textContent = '2 完成 · 1 待审批 · 1 排队';

    // 工具状态
    els.toolApplyPatch.className = 'tool-item status-pending';
    els.patchToolIcon.textContent = '⚠';
    els.patchToolTag.className = 'tool-tag tag-warning';
    els.patchToolTag.textContent = '待用户审批';

    els.toolVitest.className = 'tool-item status-queued';
    els.vitestIcon.textContent = '⏳';
    els.vitestTag.className = 'tool-tag tag-muted';
    els.vitestTag.textContent = '排队中';
    els.vitestMeta.textContent = '排队中 · 待 apply_patch 成功写入后自动触发单测';

    // 验证项
    els.chkVitest.className = 'verify-item verify-pending';
    els.chkVitestIcon.textContent = '⏳';
    els.chkVitestText.innerHTML = '聚焦单测断言：等待 <code>gui-presentation.test.js</code> 真实执行';

    // 底部 Dock
    els.dockDot.textContent = '●';
    els.dockDot.style.color = 'var(--color-warning)';
    els.dockText.innerHTML = '等待审批：<code>apply_patch</code> (+29 / −2) · 权限隔离保护中';
  }

  // 2. 审批通过正在执行
  function renderApprovedRunning() {
    els.phaseText.textContent = '执行写入与运行单测';
    els.stateIcon.textContent = '⏳';
    els.stateText.textContent = '执行中';

    els.verdictBadge.setAttribute('data-verdict', 'unauthorized');
    els.verdictIcon.textContent = '⊘';
    els.verdictText.textContent = '完成授权未授予';

    els.toolSummary.textContent = '3 完成 · 1 执行中';

    els.toolApplyPatch.className = 'tool-item status-done';
    els.patchToolIcon.textContent = '✓';
    els.patchToolTag.className = 'tool-tag tag-success';
    els.patchToolTag.textContent = '已写入';

    els.toolVitest.className = 'tool-item status-pending';
    els.vitestIcon.textContent = '⏳';
    els.vitestTag.className = 'tool-tag tag-warning';
    els.vitestTag.textContent = '测试运行中';
    els.vitestMeta.textContent = '正在执行 vitest run test/surfaces/gui/presentation.test.js...';

    els.gateActionButtons.classList.add('hidden');
    els.gateDecisionResult.className = 'gate-verdict-banner verdict-allowed';
    els.gateDecisionResult.innerHTML = '<span>✓</span> <strong>已授权写入：</strong> 变更已应用至工作区，正在触发聚焦测试...';

    els.dockDot.textContent = '⏳';
    els.dockDot.style.color = 'var(--color-accent)';
    els.dockText.innerHTML = '正在运行测试套件 <code>gui-presentation.test.js</code>...';
    els.dockActionGroup.classList.add('hidden');
  }

  // 3. 已验证完成状态 (符合规范要求：decideVerdict · verified（模拟）)
  function renderCompletedVerified() {
    els.phaseText.textContent = '验收通过 · 已对齐';
    els.stateIcon.textContent = '✓';
    els.stateText.textContent = '已完成';

    // 核心要求：显示 decideVerdict · verified（模拟）
    els.verdictBadge.setAttribute('data-verdict', 'verified');
    els.verdictIcon.textContent = '✓';
    els.verdictText.textContent = 'decideVerdict · verified（模拟）';

    els.toolSummary.textContent = '4/4 全部完成';

    els.toolApplyPatch.className = 'tool-item status-done';
    els.patchToolIcon.textContent = '✓';
    els.patchToolTag.className = 'tool-tag tag-success';
    els.patchToolTag.textContent = '已完成';

    els.toolVitest.className = 'tool-item status-done';
    els.vitestIcon.textContent = '✓';
    els.vitestTag.className = 'tool-tag tag-success';
    els.vitestTag.textContent = '测试通过 (2/2)';
    els.vitestMeta.textContent = '单测通过 · 耗时 184ms · 覆盖 session:resumed 与 task:restored';

    els.chkVitest.className = 'verify-item verify-pass';
    els.chkVitestIcon.textContent = '✓';
    els.chkVitestText.innerHTML = '聚焦单测断言：<code>gui-presentation.test.js</code> 全部通过 (2 passed)';

    // 隐藏审批按钮，展示通过状态
    els.gateActionButtons.classList.add('hidden');
    els.gateDecisionResult.className = 'gate-verdict-banner verdict-allowed';
    els.gateDecisionResult.innerHTML = '<span>✓</span> <strong>一次性写操作已落地并验证通过：</strong> Git 工作区保持干净投影。';

    // 展示消息 3：完成报告
    els.msg3Final.classList.remove('hidden');
    els.msg3Time.textContent = '19:14:28';
    els.msg3Body.innerHTML = `
      <div class="verdict-card verdict-success">
        <div class="verdict-header-row">
          <div class="verdict-main-title">
            <span>✓</span> 任务验证通过：decideVerdict · verified（模拟）
          </div>
          <span class="verdict-meta mono">Session: GUI-RECOVER-17</span>
        </div>
        <div class="verdict-detail-box">
          <p><strong>交付证据摘要：</strong></p>
          <ul style="padding-left: 18px; margin-top: 6px; line-height: 1.6;">
            <li>已在 <code>src/surfaces/gui/presentation.js</code> 显式监听会话恢复事件，消除时序竞争。</li>
            <li>新增 <code>test/surfaces/gui/presentation.test.js</code> 聚焦回归测试，两项断言均为绿灯。</li>
            <li>现有 <code>createPresentationPipeline</code> API 接口及完成授权机制保持零破坏。</li>
          </ul>
          <pre><code>✓ test/surfaces/gui/presentation.test.js (2 tests) 184ms
  ✓ presentation pipeline recovery sync > should immediately sync diff projection when session:resumed fires
  ✓ presentation pipeline recovery sync > should retain clean state when no stored diff

Test Files  1 passed (1)
     Tests  2 passed (2)
  Duration  312ms</code></pre>
        </div>
      </div>
    `;

    // 底部 Dock
    els.dockDot.textContent = '✓';
    els.dockDot.style.color = 'var(--color-success)';
    els.dockText.innerHTML = '任务验证完成 · <strong>decideVerdict · verified（模拟）</strong> · 证据链完备';
    els.dockActionGroup.classList.add('hidden');
  }

  // 4. 拒绝执行状态
  function renderRejected() {
    els.phaseText.textContent = '写操作已拦截';
    els.stateIcon.textContent = '⊘';
    els.stateText.textContent = '已拒绝';

    els.verdictBadge.setAttribute('data-verdict', 'unauthorized');
    els.verdictIcon.textContent = '⊘';
    els.verdictText.textContent = '完成授权未授予';

    els.toolSummary.textContent = '2 完成 · 1 已拒绝 · 1 已取消';

    els.toolApplyPatch.className = 'tool-item status-error';
    els.patchToolIcon.textContent = '⊘';
    els.patchToolTag.className = 'tool-tag tag-danger';
    els.patchToolTag.textContent = '用户拒绝';

    els.toolVitest.className = 'tool-item status-queued';
    els.vitestIcon.textContent = '—';
    els.vitestTag.className = 'tool-tag tag-muted';
    els.vitestTag.textContent = '已跳过';
    els.vitestMeta.textContent = '因前置写入被拒绝，未执行测试';

    els.gateActionButtons.classList.add('hidden');
    els.gateDecisionResult.className = 'gate-verdict-banner verdict-rejected';
    els.gateDecisionResult.innerHTML = '<span>⊘</span> <strong>用户已拒绝一次性写入授权：</strong> 未对本地工作区进行任何文件修改。';

    // 消息 3：响应拒绝
    els.msg3Final.classList.remove('hidden');
    els.msg3Time.textContent = '19:14:22';
    els.msg3Body.innerHTML = `
      <div class="verdict-card verdict-failure">
        <div class="verdict-header-row">
          <div class="verdict-main-title">
            <span>⊘</span> 执行已挂起：写权限未被授予
          </div>
          <span class="verdict-meta mono">完成授权未授予</span>
        </div>
        <div class="verdict-detail-box">
          <p>已中止本次补丁写入流程。工作区未发生任何改动。请在对话框输入新的指令或修正方案。</p>
        </div>
      </div>
    `;

    els.dockDot.textContent = '⊘';
    els.dockDot.style.color = 'var(--color-danger)';
    els.dockText.innerHTML = '已拒绝写入 · 工作区无改动 · 完成授权未授予';
    els.dockActionGroup.classList.add('hidden');
  }

  // 5. 要求调整状态
  function renderAdjusted(feedbackText) {
    const feedback = feedbackText || '要求在 sessionStore 层做聚合收敛，而非直接暴露 emit';
    els.phaseText.textContent = '重新审视补丁设计';
    els.stateIcon.textContent = '✎';
    els.stateText.textContent = '调整中';

    els.verdictBadge.setAttribute('data-verdict', 'unauthorized');
    els.verdictIcon.textContent = '⊘';
    els.verdictText.textContent = '完成授权未授予';

    els.gateActionButtons.classList.add('hidden');
    els.gateDecisionResult.className = 'gate-verdict-banner verdict-modified';
    els.gateDecisionResult.innerHTML = `<span>✎</span> <strong>用户要求调整：</strong> "${escapeHtml(feedback)}"。Jarvis 正在重新推导最小变更...`;

    els.dockDot.textContent = '✎';
    els.dockDot.style.color = 'var(--color-accent)';
    els.dockText.innerHTML = '已接收调整意见 · 正在重新规划变更方案';
    els.dockActionGroup.classList.add('hidden');
  }

  // 6. 暂停状态
  function renderPaused() {
    els.stateIcon.textContent = '⏸';
    els.stateText.textContent = '已暂停';
    els.verdictBadge.setAttribute('data-verdict', 'unauthorized');
    els.verdictIcon.textContent = '⊘';
    els.verdictText.textContent = '完成授权未授予';

    els.pauseResumeIcon.textContent = '▶';
    els.pauseResumeLabel.textContent = '继续';

    els.dockDot.textContent = '⏸';
    els.dockDot.style.color = 'var(--text-secondary)';
    els.dockText.innerHTML = 'Agent 执行循环已暂停 · 状态已封存';
  }

  // 7. 终止状态
  function renderTerminated() {
    els.phaseText.textContent = '任务已强行终止';
    els.stateIcon.textContent = '⏹';
    els.stateText.textContent = '已终止';

    els.verdictBadge.setAttribute('data-verdict', 'unauthorized');
    els.verdictIcon.textContent = '⊘';
    els.verdictText.textContent = '完成授权未授予';

    els.terminateIcon.textContent = '↺';
    els.terminateLabel.textContent = '恢复';

    els.gateActionButtons.classList.add('hidden');
    els.gateDecisionResult.className = 'gate-verdict-banner verdict-rejected';
    els.gateDecisionResult.innerHTML = '<span>⏹</span> <strong>任务已被人工终止：</strong> 释放所有锁与资源。';

    els.dockDot.textContent = '⏹';
    els.dockDot.style.color = 'var(--color-danger)';
    els.dockText.innerHTML = '任务已终止 · 完成授权未授予';
    els.dockActionGroup.classList.add('hidden');
  }

  // 8. 失败场景演示
  function renderFailed() {
    els.phaseText.textContent = '单测断言失败';
    els.stateIcon.textContent = '✕';
    els.stateText.textContent = '执行失败';

    els.verdictBadge.setAttribute('data-verdict', 'unauthorized');
    els.verdictIcon.textContent = '⊘';
    els.verdictText.textContent = '完成授权未授予';

    els.toolSummary.textContent = '3 完成 · 1 失败';

    els.toolApplyPatch.className = 'tool-item status-done';
    els.patchToolIcon.textContent = '✓';
    els.patchToolTag.className = 'tool-tag tag-success';
    els.patchToolTag.textContent = '已写入';

    els.toolVitest.className = 'tool-item status-error';
    els.vitestIcon.textContent = '✕';
    els.vitestTag.className = 'tool-tag tag-danger';
    els.vitestTag.textContent = '单测失败 (1/2)';
    els.vitestMeta.textContent = '断言失败：expected diff to contain presentation.js (AssertionError)';

    els.chkVitest.className = 'verify-item verify-fail';
    els.chkVitestIcon.textContent = '✕';
    els.chkVitestText.innerHTML = '聚焦单测断言：<code>gui-presentation.test.js</code> 发生 1 项断言失败';

    els.gateActionButtons.classList.add('hidden');
    els.gateDecisionResult.className = 'gate-verdict-banner verdict-rejected';
    els.gateDecisionResult.innerHTML = '<span>✕</span> <strong>测试未通过：</strong> 触发安全熔断，完成授权保持未授予。';

    // 消息 3：失败证据
    els.msg3Final.classList.remove('hidden');
    els.msg3Time.textContent = '19:14:26';
    els.msg3Body.innerHTML = `
      <div class="verdict-card verdict-failure">
        <div class="verdict-header-row">
          <div class="verdict-main-title">
            <span>✕</span> 验证链断言失败 · 完成授权未授予
          </div>
          <span class="verdict-meta mono">Status: FAILED</span>
        </div>
        <div class="verdict-detail-box">
          <p><strong>失败原因与排查依据：</strong></p>
          <p style="color: var(--color-danger); margin: 6px 0;">AssertionError: expected null not to be null (diff property missing in restored state)</p>
          <pre><code>FAIL test/surfaces/gui/presentation.test.js > presentation pipeline recovery sync
  AssertionError: expected null not to be null
   ❯ test/surfaces/gui/presentation.test.js:93:47
   ❯ runTest (vitest/runtime.js:144:12)</code></pre>
          <p style="margin-top: 8px;">根据完成授权铁律，未满足全部验证前，系统拒绝签署完成授权。</p>
        </div>
      </div>
    `;

    els.dockDot.textContent = '✕';
    els.dockDot.style.color = 'var(--color-danger)';
    els.dockText.innerHTML = '单测失败 · <strong>完成授权未授予</strong> · 请审阅失败调用栈';
    els.dockActionGroup.classList.add('hidden');
  }

  // 工具函数：HTML 转义
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
   * 事件绑定与交互接入
   */
  function initEvents() {
    // 1. 审批按钮（卡片内）
    els.btnAllowOnce.addEventListener('click', () => {
      renderState(STATES.APPROVED_RUNNING);
      setTimeout(() => {
        renderState(STATES.COMPLETED_VERIFIED);
      }, 700);
    });

    els.btnReject.addEventListener('click', () => {
      renderState(STATES.REJECTED);
    });

    els.btnRequestChanges.addEventListener('click', () => {
      els.modalAdjustment.showModal();
      els.adjInput.focus();
    });

    // 2. 审批按钮（底部常驻 Dock）
    els.dockBtnAllow.addEventListener('click', () => {
      renderState(STATES.APPROVED_RUNNING);
      setTimeout(() => {
        renderState(STATES.COMPLETED_VERIFIED);
      }, 700);
    });

    els.dockBtnReject.addEventListener('click', () => {
      renderState(STATES.REJECTED);
    });

    els.dockBtnModify.addEventListener('click', () => {
      els.modalAdjustment.showModal();
      els.adjInput.focus();
    });

    // 3. 模态框：调整意见提交
    els.btnCloseAdjModal.addEventListener('click', () => els.modalAdjustment.close());
    els.btnCancelAdj.addEventListener('click', () => els.modalAdjustment.close());
    els.formAdjustment.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = els.adjInput.value.trim();
      els.modalAdjustment.close();
      renderState(STATES.ADJUSTED, val);
    });

    // 4. 模态框：终止确认
    els.btnTerminate.addEventListener('click', () => {
      if (currentState === STATES.TERMINATED) {
        // 如果已经是终止状态，点击则恢复
        renderState(STATES.PENDING_APPROVAL);
      } else {
        els.modalTerminate.showModal();
      }
    });

    els.btnCloseTermModal.addEventListener('click', () => els.modalTerminate.close());
    els.btnCancelTerm.addEventListener('click', () => els.modalTerminate.close());
    els.formTerminate.addEventListener('submit', (e) => {
      e.preventDefault();
      els.modalTerminate.close();
      renderState(STATES.TERMINATED);
    });

    // 5. 暂停 / 继续切换
    els.btnPauseResume.addEventListener('click', () => {
      if (currentState === STATES.PAUSED) {
        renderState(previousStateBeforePause || STATES.PENDING_APPROVAL);
      } else {
        previousStateBeforePause = currentState;
        renderState(STATES.PAUSED);
      }
    });

    // 6. 场景下拉切换
    els.scenarioSelect.addEventListener('change', (e) => {
      const selected = e.target.value;
      if (selected === STATES.APPROVED_RUNNING) {
        renderState(STATES.APPROVED_RUNNING);
        setTimeout(() => renderState(STATES.COMPLETED_VERIFIED), 700);
      } else {
        renderState(selected);
      }
    });

    // 7. Reasoning 手风琴折叠展开
    els.reasoningToggle.addEventListener('click', () => {
      const isExpanded = els.reasoningToggle.getAttribute('aria-expanded') === 'true';
      els.reasoningToggle.setAttribute('aria-expanded', !isExpanded);
      els.reasoningContent.classList.toggle('hidden', isExpanded);
      els.reasoningIndicator.textContent = isExpanded ? '展开 ▼' : '收起 ▲';
    });

    // 8. Diff 文件标签页切换
    els.tabPresentation.addEventListener('click', () => {
      els.tabPresentation.classList.add('active');
      els.tabPresentation.setAttribute('aria-selected', 'true');
      els.tabTest.classList.remove('active');
      els.tabTest.setAttribute('aria-selected', 'false');
      els.diffPresentation.classList.remove('hidden');
      els.diffTest.classList.add('hidden');
    });

    els.tabTest.addEventListener('click', () => {
      els.tabTest.classList.add('active');
      els.tabTest.setAttribute('aria-selected', 'true');
      els.tabPresentation.classList.remove('active');
      els.tabPresentation.setAttribute('aria-selected', 'false');
      els.diffTest.classList.remove('hidden');
      els.diffPresentation.classList.add('hidden');
    });

    // 9. 全局键盘快捷键
    window.addEventListener('keydown', (e) => {
      // 若当前在 input 或 textarea 中，不拦截普通按键
      const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
      if (activeTag === 'textarea' || activeTag === 'input') {
        if (e.key === 'Escape') {
          if (els.modalAdjustment.open) els.modalAdjustment.close();
          if (els.modalTerminate.open) els.modalTerminate.close();
        }
        return;
      }

      if (e.key === 'a' || e.key === 'A') {
        if (currentState === STATES.PENDING_APPROVAL) {
          e.preventDefault();
          els.btnAllowOnce.click();
        }
      } else if (e.key === 'r' || e.key === 'R') {
        if (currentState === STATES.PENDING_APPROVAL) {
          e.preventDefault();
          els.btnReject.click();
        }
      } else if (e.key === 'm' || e.key === 'M') {
        if (currentState === STATES.PENDING_APPROVAL) {
          e.preventDefault();
          els.btnRequestChanges.click();
        }
      } else if (e.code === 'Space') {
        e.preventDefault();
        els.btnPauseResume.click();
      } else if (e.key === 'Escape') {
        if (els.modalAdjustment.open) els.modalAdjustment.close();
        if (els.modalTerminate.open) els.modalTerminate.close();
      }
    });
  }

  // 初始化入口
  document.addEventListener('DOMContentLoaded', () => {
    initEvents();
    renderState(STATES.PENDING_APPROVAL);
  });
})();
