import { useEffect, useMemo, useRef, useState } from 'react';
import type { GuiFileView, GuiLiveSnapshot } from '../../../live-types.js';
import { type FilePreviewState } from './file-preview.js';
import { ArrowLeftIcon, ChevronIcon, CloseIcon } from './icons.js';
import { MarkdownBody } from './markdown.js';
import { orderDiffBlocks } from './reader-diff.js';

/**
 * Batch 8 §阅读层 (V1, Owner-signed): the full-width read-only artifact reader. The layer shows
 * the current file beside this task's related Diff blocks — presentation of projections that
 * already exist (readFileView contract + snapshot.diff), never new authority. No approval,
 * review or submission action exists inside the layer; Esc/← always returns to the conversation.
 */

export { orderDiffBlocks } from './reader-diff.js';

function readerError(error: unknown): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : '读取文件失败。';
}

export function ReaderOverlay({ path, snapshot, taskId, getFileView, openFileExternal, onSwitch, onClose }: {
  readonly path: string;
  readonly snapshot: GuiLiveSnapshot | null;
  readonly taskId: string | null;
  readonly getFileView: (taskId: string, path: string) => Promise<GuiFileView>;
  readonly openFileExternal: (taskId: string, path: string) => Promise<{ ok: true }>;
  readonly onSwitch: (path: string) => void;
  readonly onClose: () => void;
}) {
  const [preview, setPreview] = useState<FilePreviewState>({ path, status: 'loading' });
  const [copied, setCopied] = useState(false);
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({});
  const backRef = useRef<HTMLButtonElement>(null);

  const blocks = useMemo(() => orderDiffBlocks(snapshot?.diff ?? '', path), [snapshot?.diff, path]);
  const source = snapshot?.artifacts.some((artifact) => artifact.path === path)
    ? '产物'
    : blocks.files.some((block) => block.path === path)
      ? 'Diff 分块'
      : '文件树';

  useEffect(() => {
    setCopied(false);
    if (taskId === null) {
      setPreview({ path, status: 'error', error: '未选择任务，无法读取文件。' });
      return undefined;
    }
    let disposed = false;
    setPreview({ path, status: 'loading' });
    getFileView(taskId, path)
      .then((view) => { if (!disposed) setPreview({ path, status: 'ok', view }); })
      .catch((error: unknown) => { if (!disposed) setPreview({ path, status: 'error', error: readerError(error) }); });
    return () => { disposed = true; };
  }, [taskId, getFileView, path]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    backRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [onClose]);

  const openExternal = () => {
    if (taskId === null) return;
    setPreview((current) => ({ ...current, externalPending: true }));
    openFileExternal(taskId, path)
      .then(() => setPreview((current) => (current.path === path ? { ...current, externalPending: false } : current)))
      .catch((error: unknown) => setPreview((current) => (current.path === path
        ? { ...current, status: 'error', error: readerError(error), externalPending: false }
        : current)));
  };

  const copyContent = async () => {
    if (preview.view?.kind !== 'text') return;
    try {
      await navigator.clipboard.writeText(preview.view.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const view = preview.view;
  const isMarkdown = path.toLowerCase().endsWith('.md');

  return (
    <div className="wb-reader" role="dialog" aria-modal="true" aria-label={`成果阅读：${path}`}>
      <div className="wb-reader-bar">
        <button type="button" className="wb-reader-back" ref={backRef} onClick={onClose}><ArrowLeftIcon />返回任务对话</button>
        <code className="wb-reader-path">{path}</code>
        <span className="wb-reader-src">{source} · 只读</span>
        <span className="wb-reader-spacer" />
        {preview.status === 'ok' && view?.kind === 'text' ? (
          <button type="button" onClick={() => { void copyContent(); }}>{copied ? '已复制' : '复制'}</button>
        ) : null}
        <button type="button" disabled={preview.externalPending === true || taskId === null} onClick={openExternal}>
          {preview.externalPending === true ? '打开中…' : '在外部打开'}
        </button>
        <button type="button" aria-label="关闭阅读层" onClick={onClose}><CloseIcon /></button>
      </div>
      <div className="wb-reader-body">
        <div className="wb-reader-doc">
          {preview.status === 'loading' ? <p className="live-muted">读取中…</p> : null}
          {preview.status === 'error' ? <p className="wb-file-preview-error">{preview.error ?? '读取文件失败。'}</p> : null}
          {preview.status === 'ok' && view?.kind === 'text' ? (
            <div className="wb-reader-measure">
              {isMarkdown ? (
                <div className="wb-reader-markdown"><MarkdownBody text={view.content} /></div>
              ) : (
                <pre className="wb-reader-text">{view.content}</pre>
              )}
              {view.truncated ? <p className="live-muted">文件过大，仅显示前 200 KB；完整内容请在外部打开。</p> : null}
            </div>
          ) : null}
          {preview.status === 'ok' && view?.kind === 'image' ? (
            <div className="wb-reader-measure">
              <img className="wb-reader-image" alt={view.path} src={`data:${view.mime};base64,${view.content}`} />
            </div>
          ) : null}
        </div>
        <aside className="wb-reader-diff" aria-label="关联 Diff 分块">
          {snapshot === null || blocks.files.length === 0 ? (
            <p className="live-muted">当前任务没有可显示的 Diff。</p>
          ) : (
            <>
              <p className="wb-reader-diff-title">关联 Diff（同任务 {blocks.files.length} 个文件）</p>
              {blocks.files.map((block) => {
                const collapsed = collapsedMap[block.path] ?? (block.path !== path);
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
                      <button type="button" className="wb-artifact-open" onClick={() => onSwitch(block.path)} aria-label={`阅读 ${block.path}`}>阅读</button>
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
              {blocks.truncated ? <p className="live-muted">…预览已截断，请检查工作区原文件</p> : null}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
