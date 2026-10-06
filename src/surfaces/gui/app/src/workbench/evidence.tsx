import type { GuiLiveOverview, GuiLiveSnapshot, GuiTool } from '../../../live-types.js';
import { diffSummary, parseUnifiedDiff } from './diff.js';
import { formatCost, formatDuration, formatTimestamp, formatTokens, toolStatusLabels } from './format.js';

export function SelectedToolEvidence({ tool }: { readonly tool: GuiTool | null }) {
  if (tool === null) return null;
  return (
    <section className="live-linked-tool" aria-label="所选工具证据">
      <div>
        <span>已联动工具</span>
        <strong>{tool.name}</strong>
        <em data-status={tool.status}>{toolStatusLabels[tool.status]}</em>
      </div>
      {tool.path ? <code>{tool.path}</code> : null}
      {tool.output ? <pre>{tool.output}</pre> : <p>该工具尚未返回可显示的输出。</p>}
    </section>
  );
}

export function DiffEvidence({ snapshot, selectedTool }: {
  readonly snapshot: GuiLiveSnapshot | null;
  readonly selectedTool: GuiTool | null;
}) {
  const diff = snapshot?.diff ?? '';
  const summary = diffSummary(diff);
  const { rows, truncated } = parseUnifiedDiff(diff);
  return (
    <div className="live-evidence-pane wb-diff-pane">
      <SelectedToolEvidence tool={selectedTool} />
      {snapshot === null ? <p className="live-muted">启动任务后显示实际 Diff 与产物。</p> : (
        <>
          <div className="wb-evidence-head">
            <strong>产物</strong>
            <span>{snapshot.artifacts.length} 个文件</span>
            {summary.files > 0 ? <span className="wb-diff-count" data-kind="added">+{summary.added}</span> : null}
            {summary.files > 0 ? <span className="wb-diff-count" data-kind="removed">−{summary.removed}</span> : null}
          </div>
          <ul className="file-list">
            {snapshot.artifacts.length === 0 ? <li><span>暂无产物</span><strong>—</strong></li> : null}
            {snapshot.artifacts.map((artifact, index) => (
              <li key={`${index}:${artifact.path}:${artifact.outcome}`}>
                <span>{artifact.path}</span>
                <strong>{artifact.outcome}</strong>
              </li>
            ))}
          </ul>
          {diff.trim() === '' ? (
            <p className="live-muted">当前没有可显示的 Diff。基线由宿主的私有 Git index 固定，不含你的 index。</p>
          ) : (
            <pre className="mini-diff live-raw-diff wb-diff">
              {rows.map((row, index) => (
                <span key={`${index}:${row.kind}`} className="wb-diff-row" data-kind={row.kind}>{row.text || ' '}</span>
              ))}
              {truncated ? <span className="wb-diff-row" data-kind="meta">…预览已截断，请检查工作区原文件</span> : null}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

export function VerificationEvidence({ snapshot, selectedTool }: {
  readonly snapshot: GuiLiveSnapshot | null;
  readonly selectedTool: GuiTool | null;
}) {
  return (
    <div className="verification-pane live-evidence-pane">
      <SelectedToolEvidence tool={selectedTool} />
      {snapshot === null || snapshot.checks.length === 0 ? (
        <p className="live-muted">尚无验证结果。检查命令由任务合同固定，界面不能增删。</p>
      ) : (
        <ul className="evidence-checks live-checks">
          {snapshot.checks.map((check, index) => (
            <li key={`${check.command}:${index}`} data-status={check.code === 0 ? 'pass' : check.code === null ? 'running' : 'failed'}>
              <div>
                <code>{check.command}</code>
                {check.output ? <pre>{check.output}</pre> : null}
              </div>
              <strong>{check.code === 0 ? '通过' : check.code === null ? '进行中' : `退出码 ${check.code}`}</strong>
            </li>
          ))}
        </ul>
      )}
      {snapshot !== null ? (
        <div className="verification-outcome" data-tone={snapshot.completion.granted ? 'success' : 'muted'}>
          <strong>{snapshot.completion.verdict || '完成授权未授予'}</strong>
          <small>{snapshot.completion.rationale || '验证通过本身不会自动成为完成授权。'}</small>
        </div>
      ) : null}
    </div>
  );
}

export function ContextEvidence({ overview, snapshot, streamWarning }: {
  readonly overview: GuiLiveOverview | null;
  readonly snapshot: GuiLiveSnapshot | null;
  readonly streamWarning: string | null;
}) {
  if (snapshot === null) {
    return (
      <div className="context-pane live-evidence-pane">
        <dl>
          <div><dt>工作区</dt><dd>{overview?.cwd ?? '未取得'}</dd></div>
          <div><dt>任务入口</dt><dd>{overview?.enabled ? '已启用' : '未启用'}</dd></div>
          <div><dt>任务目标</dt><dd>{overview?.task?.objective ?? '未配置'}</dd></div>
        </dl>
      </div>
    );
  }
  return (
    <div className="context-pane live-evidence-pane">
      <dl>
        <div><dt>模型</dt><dd>{snapshot.model || '未知'}（只读，由任务合同与 CLI 配置固定）</dd></div>
        <div><dt>Token</dt><dd>{formatTokens(snapshot.usage.inputTokens)} 输入 / {formatTokens(snapshot.usage.outputTokens)} 输出</dd></div>
        <div><dt>成本</dt><dd>{formatCost(snapshot.usage.costCny)} · {snapshot.usage.costNote || '无估算说明'}</dd></div>
        <div><dt>耗时</dt><dd>{formatDuration(snapshot.elapsedMs)}</dd></div>
        <div><dt>开始时间</dt><dd>{formatTimestamp(snapshot.startedAt)}</dd></div>
        <div><dt>执行上限</dt><dd>{snapshot.limits.maxRounds} rounds / {snapshot.limits.maxTurns} turns / 单轮 {formatDuration(snapshot.limits.turnTimeoutMs)} / 总计 {formatDuration(snapshot.limits.wallClockMs)}</dd></div>
        <div><dt>Session</dt><dd>{snapshot.sessionId}</dd></div>
        <div><dt>Goal</dt><dd>{snapshot.goalId}</dd></div>
        <div><dt>序列</dt><dd>{snapshot.sequence}</dd></div>
        <div><dt>工作区</dt><dd>{snapshot.cwd}</dd></div>
        <div><dt>Session 来源</dt><dd>{snapshot.sources.session}</dd></div>
        <div><dt>Goal 来源</dt><dd>{snapshot.sources.goal}</dd></div>
        <div><dt>审批来源</dt><dd>{snapshot.sources.approvals}</dd></div>
        <div><dt>事件来源</dt><dd>{snapshot.sources.events}</dd></div>
      </dl>
      {streamWarning !== null ? <p className="live-context-warning">{streamWarning}</p> : null}
      {snapshot.warnings.length > 0 ? (
        <ul className="live-warning-list">
          {snapshot.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}
        </ul>
      ) : null}
      {snapshot.approvalHistory.length > 0 ? (
        <details className="live-history-details">
          <summary>审批历史（{snapshot.approvalHistory.length}）</summary>
          <ol>
            {snapshot.approvalHistory.map((item, index) => (
              <li key={`${index}:${item.requestId}:${item.decision}`}>
                <strong>{item.toolName}</strong>
                <span>{item.decision}</span>
                {item.reason ? <p>{item.reason}</p> : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}
