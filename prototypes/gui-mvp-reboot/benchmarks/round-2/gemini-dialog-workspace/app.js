// Jarvis-Agent · Desktop Dialog Workspace Interactive Simulator

(function () {
  'use strict';

  // State Definition (Strictly in-memory prototype simulation)
  const state = {
    task: {
      id: 'GUI-RECOVER-17',
      goal: '修复会话恢复后消息状态与最新 Diff 不同步',
      stage: '修正显示投影',
      status: '需要审批', // 需要审批 | 执行中 | 全链已通过 | 审批已拒绝 | 待调整 | 已暂停 | 已终止
      permission: 'workspace.write',
      files: [
        { path: 'src/surfaces/gui/assets/presentation.js', add: 21, del: 2 },
        { path: 'test/surfaces/gui/gui-presentation.test.js', add: 8, del: 0 }
      ],
      completionGranted: false,
      isPaused: false,
      isTerminated: false
    }
  };

  // DOM Elements
  const currentStageText = document.getElementById('currentStageText');
  const currentStatusText = document.getElementById('currentStatusText');
  const headerStatusBadge = document.getElementById('headerStatusBadge');
  const btnPauseResume = document.getElementById('btnPauseResume');
  const pauseResumeLabel = document.getElementById('pauseResumeLabel');
  const pauseResumeIcon = document.getElementById('pauseResumeIcon');
  const btnStopRestore = document.getElementById('btnStopRestore');
  const stopRestoreLabel = document.getElementById('stopRestoreLabel');
  const stopRestoreIcon = document.getElementById('stopRestoreIcon');

  const dialogStream = document.getElementById('dialogStream');
  const dynamicMessages = document.getElementById('dynamicMessages');
  const reasoningDetails = document.getElementById('reasoningDetails');
  const toolGroupCard = document.getElementById('toolGroupCard');
  const toolOverallStatus = document.getElementById('toolOverallStatus');
  const applyPatchBadge = document.getElementById('applyPatchBadge');
  const vitestBadge = document.getElementById('vitestBadge');
  const toolItemApplyPatch = document.getElementById('toolItemApplyPatch');
  const toolItemVitest = document.getElementById('toolItemVitest');

  const composerInput = document.getElementById('composerInput');
  const composerForm = document.getElementById('composerForm');
  const btnClearComposer = document.getElementById('btnClearComposer');

  const btnAllowOnce = document.getElementById('btnAllowOnce');
  const btnReject = document.getElementById('btnReject');
  const btnRequestChanges = document.getElementById('btnRequestChanges');

  const tabPresentation = document.getElementById('tabPresentation');
  const tabTest = document.getElementById('tabTest');
  const diffPresentation = document.getElementById('diffPresentation');
  const diffTest = document.getElementById('diffTest');

  const verdictPill = document.getElementById('verdictPill');
  const dotVitest = document.getElementById('dotVitest');
  const statusVitestText = document.getElementById('statusVitestText');
  const completionVerdictBox = document.getElementById('completionVerdictBox');
  const verdictIcon = document.getElementById('verdictIcon');
  const verdictHeadline = document.getElementById('verdictHeadline');
  const verdictDetail = document.getElementById('verdictDetail');

  // Quick Action buttons
  const btnQuickAllow = document.getElementById('btnQuickAllow');
  const btnQuickExplain = document.getElementById('btnQuickExplain');
  const btnQuickAddTest = document.getElementById('btnQuickAddTest');
  const btnToggleReasoning = document.getElementById('btnToggleReasoning');
  const btnToggleTools = document.getElementById('btnToggleTools');

  // Sim Preset Buttons
  const simInitial = document.getElementById('simInitial');
  const simApproved = document.getElementById('simApproved');
  const simVerified = document.getElementById('simVerified');
  const simRejected = document.getElementById('simRejected');
  const simPaused = document.getElementById('simPaused');
  const simTerminated = document.getElementById('simTerminated');

  // Tab Switching
  tabPresentation.addEventListener('click', () => switchTab('presentation'));
  tabTest.addEventListener('click', () => switchTab('test'));

  function switchTab(tabName) {
    if (tabName === 'presentation') {
      tabPresentation.classList.add('active');
      tabPresentation.setAttribute('aria-selected', 'true');
      tabTest.classList.remove('active');
      tabTest.setAttribute('aria-selected', 'false');
      diffPresentation.style.display = 'flex';
      diffTest.style.display = 'none';
    } else {
      tabTest.classList.add('active');
      tabTest.setAttribute('aria-selected', 'true');
      tabPresentation.classList.remove('active');
      tabPresentation.setAttribute('aria-selected', 'false');
      diffPresentation.style.display = 'none';
      diffTest.style.display = 'flex';
    }
  }

  // Toggle Reasoning & Tools
  btnToggleReasoning.addEventListener('click', () => {
    reasoningDetails.open = !reasoningDetails.open;
    btnToggleReasoning.classList.toggle('active', !reasoningDetails.open);
    btnToggleReasoning.textContent = reasoningDetails.open ? '折叠思考' : '展开思考';
  });

  btnToggleTools.addEventListener('click', () => {
    const list = toolGroupCard.querySelector('.tool-list');
    if (list.style.display === 'none') {
      list.style.display = 'flex';
      btnToggleTools.classList.remove('active');
      btnToggleTools.textContent = '折叠工具';
    } else {
      list.style.display = 'none';
      btnToggleTools.classList.add('active');
      btnToggleTools.textContent = '展开工具';
    }
  });

  // Approval Actions
  btnAllowOnce.addEventListener('click', applyApproval);
  btnReject.addEventListener('click', applyRejection);
  btnRequestChanges.addEventListener('click', applyRequestChanges);

  function applyApproval() {
    state.task.status = '执行中 · 写入与单测';
    state.task.stage = '执行补丁与验证';
    updateHeaderBadges('status-blue', '执行中');
    currentStageText.textContent = state.task.stage;

    // Update Tool Status in Message
    toolOverallStatus.textContent = '补丁写入中...';
    toolItemApplyPatch.className = 'tool-item tool-done';
    toolItemApplyPatch.querySelector('.tool-status-icon').textContent = '✓';
    applyPatchBadge.className = 'tool-badge-done';
    applyPatchBadge.textContent = '写入完成 · 15ms';

    // Simulate Step 2: Running vitest
    setTimeout(() => {
      toolOverallStatus.textContent = '聚焦单测运行中...';
      toolItemVitest.className = 'tool-item tool-done';
      toolItemVitest.querySelector('.tool-status-icon').textContent = '✓';
      vitestBadge.className = 'tool-badge-done';
      vitestBadge.textContent = '通过 (1 passed) · 280ms';

      // Update Completion Status to Verified
      applyVerifiedCompletion();
    }, 500);
  }

  function applyVerifiedCompletion() {
    state.task.status = '全链已通过';
    state.task.stage = '完成验收 (decideVerdict)';
    state.task.completionGranted = true;

    updateHeaderBadges('status-green', '通过 · 已验证');
    currentStageText.textContent = state.task.stage;

    // Update Right Inspector Completion Box
    verdictPill.textContent = 'verified（模拟）';
    verdictPill.className = 'verdict-pill verified';

    dotVitest.className = 'v-dot done';
    statusVitestText.textContent = '1 passed (100% 覆盖)';
    statusVitestText.style.color = 'var(--color-green-light)';

    completionVerdictBox.querySelector('.verdict-status-title').className = 'verdict-status-title verified';
    verdictIcon.textContent = '✓';
    verdictHeadline.textContent = 'decideVerdict · verified（模拟）';
    verdictDetail.innerHTML = '聚焦单测 <code>gui-presentation.test.js</code> 与既有验证链全部通过。投影层已如期同步最新 Diff 引用。';

    // Add Agent Completion Message
    appendAgentMessage('🎉 补丁写入与聚焦单测均已执行完毕并通过验证。状态投影层已修复，Artifact 与会话快照恢复事实一致。完成授权已就绪。');
  }

  function applyRejection() {
    state.task.status = '审批已拒绝';
    state.task.stage = '等待用户新指令';
    state.task.completionGranted = false;

    updateHeaderBadges('status-red', '已拒绝写入');
    currentStageText.textContent = state.task.stage;

    toolOverallStatus.textContent = '已被用户拒绝写入';
    applyPatchBadge.className = 'tool-badge-queued';
    applyPatchBadge.textContent = '已拦截 (未写入)';

    appendAgentMessage('⚠️ 收到拒绝指令。未对 <code>presentation.js</code> 和 <code>gui-presentation.test.js</code> 进行任何文件写入。等待您的进一步指示。');
  }

  function applyRequestChanges() {
    state.task.status = '待调整';
    updateHeaderBadges('status-amber', '等待调整指令');
    composerInput.value = '请针对 presentation.js 的缓存失效边界做进一步补充处理，并调整单测覆盖。';
    composerInput.focus();
  }

  // Header Badges Helper
  function updateHeaderBadges(statusClass, statusText) {
    headerStatusBadge.className = 'status-pill ' + statusClass;
    currentStatusText.textContent = statusText;
  }

  // Pause / Resume
  btnPauseResume.addEventListener('click', () => {
    state.task.isPaused = !state.task.isPaused;
    if (state.task.isPaused) {
      pauseResumeLabel.textContent = '继续';
      pauseResumeIcon.textContent = '▶';
      updateHeaderBadges('status-amber', '已暂停');
    } else {
      pauseResumeLabel.textContent = '暂停';
      pauseResumeIcon.textContent = '⏸';
      updateHeaderBadges('status-amber', '需要审批');
    }
  });

  // Stop / Restore
  btnStopRestore.addEventListener('click', () => {
    state.task.isTerminated = !state.task.isTerminated;
    if (state.task.isTerminated) {
      stopRestoreLabel.textContent = '恢复';
      stopRestoreIcon.textContent = '↺';
      btnStopRestore.className = 'btn btn-sm btn-subtle';
      updateHeaderBadges('status-red', '已终止');
      appendAgentMessage('⏹ 任务已由人工终止。会话上下文已冻结，点击顶部「恢复」可重新激活。');
    } else {
      stopRestoreLabel.textContent = '终止';
      stopRestoreIcon.textContent = '⏹';
      btnStopRestore.className = 'btn btn-sm btn-danger-subtle';
      updateHeaderBadges('status-amber', '需要审批');
      appendAgentMessage('↺ 任务已从断点恢复，当前处于等待审批状态。');
    }
  });

  // Quick Action Buttons
  btnQuickAllow.addEventListener('click', applyApproval);

  btnQuickExplain.addEventListener('click', () => {
    composerInput.value = '请详细解释 presentation.js 中 resolveLatestArtifactDiff 的容错机制。';
    composerInput.focus();
  });

  btnQuickAddTest.addEventListener('click', () => {
    composerInput.value = '在 gui-presentation.test.js 中追加一条并发恢复场景的测试用例。';
    composerInput.focus();
  });

  // Composer Form
  composerForm.addEventListener('submit', handleSendMessage);
  composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  });

  btnClearComposer.addEventListener('click', () => {
    composerInput.value = '';
    composerInput.focus();
  });

  function handleSendMessage() {
    const text = composerInput.value.trim();
    if (!text) return;

    appendUserMessage(text);
    composerInput.value = '';

    setTimeout(() => {
      appendAgentMessage(`收到指令：“${escapeHtml(text)}”。已在内存中模拟解析，当前处于比稿静态工作区环境，不进行外部网络交互。`);
    }, 350);
  }

  function appendUserMessage(text) {
    const msg = document.createElement('article');
    msg.className = 'chat-message msg-user';
    const now = new Date().toTimeString().slice(0, 8);
    msg.innerHTML = `
      <div class="msg-header">
        <span class="avatar-badge user-avatar">L</span>
        <span class="msg-author">Ludi</span>
        <span class="msg-time">${now}</span>
        <span class="msg-badge">用户补充指令</span>
      </div>
      <div class="msg-body">
        <p>${escapeHtml(text)}</p>
      </div>
    `;
    dynamicMessages.appendChild(msg);
    scrollToBottom();
  }

  function appendAgentMessage(text) {
    const msg = document.createElement('article');
    msg.className = 'chat-message msg-jarvis';
    const now = new Date().toTimeString().slice(0, 8);
    msg.innerHTML = `
      <div class="msg-header">
        <span class="avatar-badge jarvis-avatar">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5">
            <polygon points="12 2 2 7 2 17 12 22 22 17 22 7 12 2"></polygon>
          </svg>
        </span>
        <span class="msg-author">Jarvis</span>
        <span class="msg-time">${now}</span>
        <span class="msg-badge msg-badge-agent">Agent 回复</span>
      </div>
      <div class="msg-body">
        <p>${text}</p>
      </div>
    `;
    dynamicMessages.appendChild(msg);
    scrollToBottom();
  }

  function scrollToBottom() {
    dialogStream.scrollTop = dialogStream.scrollHeight;
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Simulation Presets Switcher
  function setSimActive(btn) {
    document.querySelectorAll('.btn-sim').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  simInitial.addEventListener('click', () => {
    setSimActive(simInitial);
    resetToInitial();
  });

  simApproved.addEventListener('click', () => {
    setSimActive(simApproved);
    applyApproval();
  });

  simVerified.addEventListener('click', () => {
    setSimActive(simVerified);
    applyVerifiedCompletion();
  });

  simRejected.addEventListener('click', () => {
    setSimActive(simRejected);
    applyRejection();
  });

  simPaused.addEventListener('click', () => {
    setSimActive(simPaused);
    state.task.isPaused = true;
    pauseResumeLabel.textContent = '继续';
    pauseResumeIcon.textContent = '▶';
    updateHeaderBadges('status-amber', '已暂停');
  });

  simTerminated.addEventListener('click', () => {
    setSimActive(simTerminated);
    state.task.isTerminated = true;
    stopRestoreLabel.textContent = '恢复';
    stopRestoreIcon.textContent = '↺';
    updateHeaderBadges('status-red', '已终止');
  });

  function resetToInitial() {
    state.task.status = '需要审批';
    state.task.stage = '修正显示投影';
    state.task.completionGranted = false;
    state.task.isPaused = false;
    state.task.isTerminated = false;

    currentStageText.textContent = state.task.stage;
    updateHeaderBadges('status-amber', '需要审批');

    pauseResumeLabel.textContent = '暂停';
    pauseResumeIcon.textContent = '⏸';
    stopRestoreLabel.textContent = '终止';
    stopRestoreIcon.textContent = '⏹';
    btnStopRestore.className = 'btn btn-sm btn-danger-subtle';

    toolOverallStatus.textContent = '1 项阻塞等待审批';
    toolItemApplyPatch.className = 'tool-item tool-pending';
    toolItemApplyPatch.querySelector('.tool-status-icon').textContent = '⏳';
    applyPatchBadge.className = 'tool-badge-pending';
    applyPatchBadge.textContent = '待审批 (workspace.write)';

    toolItemVitest.className = 'tool-item tool-queued';
    toolItemVitest.querySelector('.tool-status-icon').textContent = '⏱';
    vitestBadge.className = 'tool-badge-queued';
    vitestBadge.textContent = '排队中 (等待写入后执行)';

    verdictPill.textContent = '未授权';
    verdictPill.className = 'verdict-pill';

    dotVitest.className = 'v-dot';
    statusVitestText.textContent = '排队等待写入';
    statusVitestText.style.color = 'var(--text-muted)';

    completionVerdictBox.querySelector('.verdict-status-title').className = 'verdict-status-title';
    verdictIcon.textContent = '⏳';
    verdictHeadline.textContent = '完成授权未授予';
    verdictDetail.innerHTML = '依据 Brief 原则：只有聚焦测试和既有验证链全部通过，界面才会显示 <code>decideVerdict · verified（模拟）</code>。';

    dynamicMessages.innerHTML = '';
  }

})();
