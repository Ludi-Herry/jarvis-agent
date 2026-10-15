import { useEffect, useState, type ReactNode } from 'react';
import type { GuiFileView, GuiGitStatus, GuiLiveOverview, GuiLiveSnapshot, GuiModelsResponse, GuiTool } from '../../../live-types.js';
import { diffSummary, parseUnifiedDiff, splitDiffByFile } from './diff.js';
import { FilePreviewCard, type FilePreviewState } from './file-preview.js';
import { formatCost, formatDuration, formatTimestamp, formatTokens, toolStatusLabels, workspaceName } from './format.js';
import { BranchIcon, CheckIcon, ChevronIcon, DocumentIcon, FolderIcon, GlobeIcon, MonitorIcon, TeamIcon, TerminalIcon } from './icons.js';
import type { EvidenceTab } from './prefs.js';
import { deriveSubagents } from './subagents.js';

/** Read-only git observation rows for the context tab; fetched once per task open, never polled. */
function GitRows({ id, getGit, compact = false }: {
  readonly id: string;
  readonly getGit: (taskId: string) => Promise<GuiGitStatus>;
  readonly compact?: boolean;
}) {
  const [git, setGit] = useState<GuiGitStatus | null>(null);
  useEffect(() => {
    let disposed = false;
    getGit(id).then((value) => { if (!disposed) setGit(value); }).catch(() => {
      // Batch 4 §GitRows 修复: a rejected query must not pin the row on 读取中 forever.
      if (!disposed) setGit({ at: new Date().toISOString(), unavailable: 'git 状态查询失败；请稍后重试' });
    });
    return () => { disposed = true; };
  }, [id, getGit]);
  if (compact) return (
    <div className="wb-inspector-row">
      <BranchIcon />
      <span title={git !== null && 'unavailable' in git ? git.unavailable : undefined}>{git === null ? '读取 Git 分支…' : 'unavailable' in git ? 'Git 状态不可用' : git.branch}</span>
      {git !== null && !('unavailable' in git) ? <small>{git.worktree === 'dirty' ? `${git.uncommitted} 项未提交` : '干净'}</small> : null}
    </div>
  );
  if (git === null) return <div><dt>Git</dt><dd>读取中…</dd></div>;
  if ('unavailable' in git) return <div><dt>Git</dt><dd>不可用：{git.unavailable}</dd></div>;
  return (
    <div>
      <dt>Git</dt>
      <dd>分支 {git.branch} · 未提交 {git.uncommitted} 项{git.ahead > 0 ? ` · 领先 ${git.ahead}` : ''}{git.behind > 0 ? ` · 落后 ${git.behind}` : ''} · {git.worktree === 'dirty' ? '有未提交改动' : '干净'}（只读）</dd>
    </div>
  );
}

function InspectorCard({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <details className="wb-inspector-card" data-section={title} open>
      <summary>{title}<ChevronIcon className="wb-chevron" /></summary>
      <div className="wb-inspector-card-body">{children}</div>
    </details>
  );
}

/** Compact summaries use host facts only; missing telemetry never becomes a fabricated percentage. */
export function InspectorEvidence({ overview, snapshot, models, getGit, onTab, onOpenWide }: {
  readonly overview: GuiLiveOverview | null;
  readonly snapshot: GuiLiveSnapshot | null;
  readonly models: GuiModelsResponse | null;
  readonly getGit?: (id: string) => Promise<GuiGitStatus>;
  readonly onTab: (tab: EvidenceTab) => void;
  readonly onOpenWide: (path: string) => void;
}) {
  const cwd = snapshot?.cwd ?? overview?.cwd ?? '';
  const model = models?.models.find((item) => item.id === (snapshot?.model ?? models.defaultModel));
  const summary = diffSummary(snapshot?.diff ?? '');
  const inputTokens = snapshot?.usage.inputTokens ?? 0;
  const outputTokens = snapshot?.usage.outputTokens ?? 0;
  const totalTokens = inputTokens + outputTokens;
  const inputShare = totalTokens > 0 ? inputTokens / totalTokens * 100 : 0;
  const subagents = deriveSubagents(snapshot?.tools ?? []);
  const tools = [...new Set(snapshot?.tools.map((tool) => tool.name) ?? [])];
  const session = overview?.sessions.find((item) => item.id === snapshot?.id);
  const workspace = overview?.workspaces.find((item) => item.id === session?.workspaceId);
  return (
    <div className="wb-inspector-stack" aria-label="任务信息面板">
      <InspectorCard title="环境">
        <div className="wb-inspector-row"><MonitorIcon /><span>{workspace?.name ?? workspaceName(cwd)}</span></div>
        <button type="button" className="wb-inspector-row wb-inspector-link" onClick={() => onTab('files')} title={cwd}><FolderIcon /><span>{workspaceName(cwd)}</span><small>{cwd.match(/^[A-Za-z]:/u)?.[0] ?? '工作区'}</small><ChevronIcon className="wb-chevron wb-chevron-right" /></button>
        {snapshot !== null && getGit !== undefined ? <GitRows id={snapshot.id} getGit={getGit} compact /> : <div className="wb-inspector-row"><BranchIcon /><span>Git 分支</span><small>尚未读取</small></div>}
        <div className="wb-inspector-row"><GlobeIcon /><span>远程控制</span><small>未接入</small></div>
      </InspectorCard>

      <InspectorCard title="上下文">
        <div className="wb-inspector-usage-head"><span>当前占用未提供</span><small>{model ? `${formatTokens(model.maxContextTokens)} 窗口` : '容量未提供'}</small></div>
        <div className="wb-inspector-window" aria-hidden="true" />
        <div className="wb-inspector-section-label">本次任务累计</div>
        <div className="wb-inspector-token-bar" aria-label="累计输入与输出比例" data-empty={totalTokens === 0}>
          <span style={{ width: `${inputShare}%` }} /><span style={{ width: `${100 - inputShare}%` }} />
        </div>
        <dl className="wb-inspector-metrics">
          <div><dt><i data-kind="input" />输入 Token</dt><dd>{snapshot ? formatTokens(inputTokens) : '—'}</dd></div>
          <div><dt><i data-kind="output" />输出 Token</dt><dd>{snapshot ? formatTokens(outputTokens) : '—'}</dd></div>
          <div><dt><i />估算成本</dt><dd title={snapshot?.usage.costNote}>{snapshot ? formatCost(snapshot.usage.costCny) : '—'}</dd></div>
          <div><dt><i />模型</dt><dd title={snapshot?.model ?? model?.label}>{snapshot?.model ?? model?.label ?? '未取得'}</dd></div>
          <div><dt><i />思考档位</dt><dd>{snapshot?.thinking ?? 'off'}</dd></div>
          <div><dt><i />执行时间</dt><dd>{snapshot ? formatDuration(snapshot.elapsedMs) : '—'}</dd></div>
          <div><dt><i />时间上限</dt><dd>{snapshot ? formatDuration(snapshot.limits.wallClockMs) : '—'}</dd></div>
        </dl>
        <p className="wb-inspector-note">累计消耗不代表当前窗口占用。</p>
        <button type="button" className="wb-inspector-disclosure" onClick={() => onTab('context')}><ChevronIcon className="wb-chevron wb-chevron-right" /><span>来源与运行记录</span></button>
        <button type="button" className="wb-inspector-disclosure" onClick={() => onTab('subagents')}><ChevronIcon className="wb-chevron wb-chevron-right" /><span>子智能体</span><small>{subagents.length}</small></button>
        <button type="button" className="wb-inspector-disclosure" onClick={() => onTab('verification')}><ChevronIcon className="wb-chevron wb-chevron-right" /><span>验证结果</span><small>{snapshot?.checks.length ?? 0}</small></button>
      </InspectorCard>

      <InspectorCard title="连接器">
        <p className="wb-inspector-note">{tools.length > 3 ? `连接器未提供；工具摘要 3 / ${tools.length}` : tools.length > 0 ? '连接器未提供；以下为本次工具' : '宿主未提供连接器清单。'}</p>
        {tools.length > 0 ? <>
          {tools.slice(0, 3).map((name) => <div className="wb-inspector-row" key={name}><TerminalIcon /><span>{name}</span></div>)}
        </> : null}
      </InspectorCard>

      <InspectorCard title="输出内容">
        {snapshot?.artifacts.length ? snapshot.artifacts.slice(0, 3).map((artifact, index) => (
          <button type="button" className="wb-inspector-row wb-inspector-link" key={`${artifact.path}:${index}`} onClick={() => onOpenWide(artifact.path)} title={artifact.path}><DocumentIcon /><span>{artifact.path.split(/[\\/]/u).at(-1)}</span></button>
        )) : <p className="wb-inspector-note">尚无交付文件</p>}
        {(snapshot?.artifacts.length ?? 0) > 3 ? <button type="button" className="wb-inspector-text-link" onClick={() => onTab('diff')}>查看全部 {snapshot?.artifacts.length} 个文件</button> : null}
      </InspectorCard>

      <InspectorCard title="更改">
        <button type="button" className="wb-inspector-row wb-inspector-link" onClick={() => onTab('diff')}><BranchIcon />{summary.files > 0 ? <span className="wb-inspector-diff"><b>+{formatTokens(summary.added)}</b><em>−{formatTokens(summary.removed)}</em></span> : <span className="wb-inspector-muted">{snapshot?.diff.trim() ? '查看更改详情' : '暂无文件更改'}</span>}<ChevronIcon className="wb-chevron wb-chevron-right" /></button>
      </InspectorCard>

      <InspectorCard title="服务器">
        <button type="button" className="wb-inspector-row wb-inspector-link" onClick={() => onTab('preview')} title="手动打开网页预览；宿主未提供服务列表及健康状态"><GlobeIcon /><span>网页预览</span><small>手动打开</small><ChevronIcon className="wb-chevron wb-chevron-right" /></button>
      </InspectorCard>

      <div className="wb-inspector-utilities" aria-label="工作区工具">
        <button type="button" onClick={() => onTab('files')}><FolderIcon />文件</button>
        <button type="button" onClick={() => onTab('terminal')}><TerminalIcon />终端</button>
        <button type="button" onClick={() => onTab('verification')}><CheckIcon />验证</button>
        <button type="button" onClick={() => onTab('subagents')}><TeamIcon />委派</button>
      </div>
    </div>
  );
}

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

/** Batch 4 §阅读: inline preview loading helpers; the card itself is shared (batch 7 §工作空间). */
function previewError(error: unknown): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : '读取文件失败。';
}

export function DiffEvidence({ snapshot, selectedTool, taskId, getFileView, openFileExternal, onOpenWide }: {
  readonly snapshot: GuiLiveSnapshot | null;
  readonly selectedTool: GuiTool | null;
  readonly taskId: string | null;
  readonly getFileView: (taskId: string, path: string) => Promise<GuiFileView>;
  readonly openFileExternal: (taskId: string, path: string) => Promise<{ ok: true }>;
  readonly onOpenWide: (path: string) => void;
}) {
  const diff = snapshot?.diff ?? '';
  const summary = diffSummary(diff);
  const { rows, truncated } = parseUnifiedDiff(diff);
  // Batch 7 §工作空间: grouped per-file blocks with collapse defaults (>20 files → first 3 open).
  const diffBlocks = splitDiffByFile(diff);
  const manyFiles = diffBlocks.files.length > 20;
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({});
  const [filePreview, setFilePreview] = useState<FilePreviewState | null>(null);
  const [copied, setCopied] = useState(false);

  const openPreview = (path: string) => {
    if (taskId === null) return;
    setFilePreview({ path, status: 'loading' });
    getFileView(taskId, path)
      .then((view) => setFilePreview((current) => (current?.path === path ? { path, status: 'ok', view } : current)))
      .catch((error: unknown) => setFilePreview((current) => (current?.path === path ? { path, status: 'error', error: previewError(error) } : current)));
  };

  const openExternal = () => {
    if (taskId === null || filePreview === null) return;
    const path = filePreview.path;
    setFilePreview({ ...filePreview, externalPending: true });
    openFileExternal(taskId, path)
      .then(() => setFilePreview((current) => (current?.path === path ? { ...current, externalPending: false } : current)))
      .catch((error: unknown) => setFilePreview((current) => (current?.path === path
        ? { ...current, status: 'error', error: previewError(error), externalPending: false }
        : current)));
  };

  const copyContent = async () => {
    if (filePreview?.view?.kind !== 'text') return;
    try {
      await navigator.clipboard.writeText(filePreview.view.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

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
                <span>
                  {artifact.path}
                  {taskId !== null ? (
                    <button
                      type="button"
                      className="wb-artifact-open"
                      onClick={() => openPreview(artifact.path)}
                      aria-label={`打开 ${artifact.path} 的预览`}
                    >
                      打开
                    </button>
                  ) : null}
                  {taskId !== null ? (
                    <button
                      type="button"
                      className="wb-artifact-open"
                      onClick={() => onOpenWide(artifact.path)}
                      aria-label={`大视图打开 ${artifact.path}`}
                    >
                      大视图
                    </button>
                  ) : null}
                </span>
                <strong>{artifact.outcome}</strong>
              </li>
            ))}
          </ul>
          {filePreview !== null ? (
            <FilePreviewCard
              preview={filePreview}
              copied={copied}
              onCopy={() => { void copyContent(); }}
              onOpenExternal={openExternal}
              onClose={() => setFilePreview(null)}
              onOpenWide={() => onOpenWide(filePreview.path)}
            />
          ) : null}
          {diff.trim() === '' ? (
            <p className="live-muted">当前没有可显示的 Diff。基线由宿主的私有 Git index 固定，不含你的 index。</p>
          ) : diffBlocks.files.length === 0 ? (
            // Non-git output (e.g. the host's honest "Diff 读取失败" note) keeps the flat rendering.
            <pre className="mini-diff live-raw-diff wb-diff">
              {rows.map((row, index) => (
                <span key={`${index}:${row.kind}`} className="wb-diff-row" data-kind={row.kind}>{row.text || ' '}</span>
              ))}
              {truncated ? <span className="wb-diff-row" data-kind="meta">…预览已截断，请检查工作区原文件</span> : null}
            </pre>
          ) : (
            <>
              {diffBlocks.files.map((block, blockIndex) => {
                const collapsed = collapsedMap[block.path] ?? (manyFiles && blockIndex >= 3);
                return (
                  <section className="wb-diff-file" key={block.path}>
                    <header>
                      <button
                        type="button"
                        className="wb-diff-file-toggle"
                        aria-expanded={!collapsed}
                        aria-label={collapsed ? `展开 ${block.path}` : `折叠 ${block.path}`}
                        onClick={() => setCollapsedMap((current) => ({ ...current, [block.path]: !collapsed }))}
                      >
                        <ChevronIcon className="wb-chevron" />
                      </button>
                      <strong>{block.path}</strong>
                      <span className="wb-diff-count" data-kind="added">+{block.added}</span>
                      <span className="wb-diff-count" data-kind="removed">−{block.removed}</span>
                      {block.binary ? <span className="wb-diff-count" data-kind="meta">二进制</span> : null}
                      {taskId !== null ? (
                        <button type="button" className="wb-artifact-open" onClick={() => openPreview(block.path)} aria-label={`打开 ${block.path} 的预览`}>打开</button>
                      ) : null}
                      {taskId !== null ? (
                        <button type="button" className="wb-artifact-open" onClick={() => onOpenWide(block.path)} aria-label={`大视图打开 ${block.path}`}>大视图</button>
                      ) : null}
                    </header>
                    {!collapsed ? (
                      <pre className="mini-diff wb-diff">
                        {block.rows.map((row, rowIndex) => (
                          <span key={`${rowIndex}:${row.kind}`} className="wb-diff-row" data-kind={row.kind}>{row.text || ' '}</span>
                        ))}
                      </pre>
                    ) : null}
                  </section>
                );
              })}
              {diffBlocks.truncated ? <p className="live-muted">…预览已截断，请检查工作区原文件</p> : null}
              {manyFiles ? <p className="live-muted">{`共 ${diffBlocks.files.length} 个文件，已默认折叠后 ${diffBlocks.files.length - 3} 个`}</p> : null}
            </>
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
          <strong>{snapshot.completion.verdict && snapshot.completion.verdict !== 'none' ? snapshot.completion.verdict : '完成授权未授予'}</strong>
          <small>{snapshot.completion.rationale || '验证通过本身不会自动成为完成授权。'}</small>
        </div>
      ) : null}
    </div>
  );
}

export function ContextEvidence({ overview, snapshot, streamWarning, getGit }: {
  readonly overview: GuiLiveOverview | null;
  readonly snapshot: GuiLiveSnapshot | null;
  readonly streamWarning: string | null;
  readonly getGit?: (id: string) => Promise<import('../../../live-types.js').GuiGitStatus>;
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
      <details className="wb-context-section" open>
        <summary>运行环境<ChevronIcon className="wb-chevron" /></summary>
        <dl>
          <div><dt>工作区</dt><dd>{snapshot.cwd}</dd></div>
          <div><dt>模型</dt><dd>{snapshot.model || '未知'}</dd></div>
          <div><dt>思考</dt><dd>{snapshot.thinking || 'off'}</dd></div>
          <div><dt>开始</dt><dd>{formatTimestamp(snapshot.startedAt)}</dd></div>
          {getGit !== undefined ? <GitRows id={snapshot.id} getGit={getGit} /> : null}
        </dl>
      </details>
      <details className="wb-context-section" open>
        <summary>消耗与预算<ChevronIcon className="wb-chevron" /></summary>
        <section className="wb-cost" aria-label="本次任务消耗与预算">
        <ul>
          <li><span>累计 Token</span><b>{formatTokens(snapshot.usage.inputTokens)} 输入 / {formatTokens(snapshot.usage.outputTokens)} 输出</b></li>
          <li><span>估算成本</span><b>{formatCost(snapshot.usage.costCny)}</b>{snapshot.usage.costNote ? <small>{snapshot.usage.costNote}</small> : null}</li>
          <li><span>执行时间</span><b>已用 {formatDuration(snapshot.elapsedMs)} / 上限 {formatDuration(snapshot.limits.wallClockMs)}</b></li>
          <li><span>结构上限</span><b>{snapshot.limits.maxRounds} 轮 × {snapshot.limits.maxTurns} 步</b></li>
        </ul>
        <p className="wb-cost-note">累计 Token 是本次任务全部消耗，不等于当前上下文窗口占用；窗口余量未测量，不显示占比。</p>
        </section>
      </details>
      <details className="wb-context-section">
      <summary>来源与运行记录<ChevronIcon className="wb-chevron" /></summary>
      <dl>
        <div><dt>单步上限</dt><dd>{formatDuration(snapshot.limits.turnTimeoutMs)}</dd></div>
        <div><dt>Session</dt><dd>{snapshot.sessionId}</dd></div>
        <div><dt>Goal</dt><dd>{snapshot.goalId}</dd></div>
        <div><dt>序列</dt><dd>{snapshot.sequence}</dd></div>
        <div><dt>Session 来源</dt><dd>{snapshot.sources.session}</dd></div>
        <div><dt>Goal 来源</dt><dd>{snapshot.sources.goal}</dd></div>
        <div><dt>审批来源</dt><dd>{snapshot.sources.approvals}</dd></div>
        <div><dt>事件来源</dt><dd>{snapshot.sources.events}</dd></div>
      </dl>
      </details>
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
