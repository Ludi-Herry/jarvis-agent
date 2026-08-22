const GOAL_STATE_LABELS = Object.freeze({
  active: '进行中',
  blocked: '已阻塞',
  complete: '已完成',
  interrupted: '已中断',
});

const GOAL_STATE_TONES = Object.freeze({
  active: 'info',
  blocked: 'warn',
  complete: 'good',
  interrupted: 'warn',
});

export function buildRunPresentation(report, stop, reviewCount) {
  const goal = report.status.latestGoal;
  const effectiveState = goal?.effectiveState || goal?.recordedState || goal?.state;
  const recordedState = goal?.recordedState || goal?.state;
  const state = stop.unreadable
    ? { label: '急停未知', tone: 'danger' }
    : stop.requested
      ? { label: '已急停', tone: 'danger' }
      : { label: goalStateLabel(effectiveState), tone: GOAL_STATE_TONES[effectiveState] || 'neutral' };

  return {
    state,
    attention: buildAttention(stop, reviewCount, effectiveState),
    goal: {
      title: goal?.objective || '当前没有运行中的目标',
      meta: goal === undefined
        ? '等待终端创建新的 goal 或 loop'
        : [
            goal.id,
            effectiveState !== recordedState ? `记录状态 ${goalStateLabel(recordedState)}` : undefined,
            goal.effectiveReason ? `原因 ${goal.effectiveReason}` : undefined,
            goal.effectiveSource?.loopId ? `Loop ${goal.effectiveSource.loopId}` : undefined,
          ].filter(Boolean).join(' · '),
    },
    budget: buildBudget(report.status.latestGoalBudget),
    usage: {
      unique: report.usage.uniqueTotalTokens,
      goal: report.usage.goalTokens,
      loop: report.usage.loopTokens,
      coverage: report.usage.coverage === 'partial' ? '部分' : '完整',
      unmetered: report.usage.coverage === 'partial' ? '未知' : '0',
    },
  };
}

function buildAttention(stop, reviewCount, effectiveState) {
  if (stop.unreadable) {
    return { title: '需要确认', label: '急停状态无法读取', tone: 'danger', href: '#activity-log', action: '查看记录' };
  }
  if (stop.requested) {
    return { title: '运行状态', label: 'Jarvis 已收到急停请求', tone: 'danger', href: '#activity-log', action: '查看记录' };
  }
  if (reviewCount > 0) {
    return { title: '需要你处理', label: `${reviewCount} 项等待人工判断`, tone: 'warn', href: '#human-review', action: '前往处理' };
  }
  if (effectiveState === 'blocked' || effectiveState === 'interrupted') {
    return { title: '运行状态', label: `当前目标${goalStateLabel(effectiveState)}`, tone: 'warn', href: '#activity-log', action: '查看原因' };
  }
  if (effectiveState === 'active') {
    return { title: '运行状态', label: 'Jarvis 正在执行当前目标', tone: 'info' };
  }
  if (effectiveState === 'complete') {
    return { title: '运行状态', label: '最近目标已完成', tone: 'good' };
  }
  return { title: '运行状态', label: '等待新的目标', tone: 'neutral' };
}

function buildBudget(budget) {
  if (budget === undefined) {
    return { available: false, label: '-', value: 0, max: 1, caption: '暂无 goal 预算记录' };
  }
  return {
    available: true,
    label: `${budget.roundsUsed}/${budget.maxRounds} 轮`,
    value: budget.roundsUsed,
    max: budget.maxRounds,
    caption: `${budget.totalTurns} turns · ${budget.totalTokens} tokens`,
  };
}

function goalStateLabel(value) {
  if (value === undefined) return '空闲';
  return GOAL_STATE_LABELS[value] || value;
}
