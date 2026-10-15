import { useEffect, useState } from 'react';
import type { GuiFileView, GuiWorkspaceTree } from '../../../live-types.js';
import { FilePreviewCard, type FilePreviewState } from './file-preview.js';
import { ChevronIcon, ExternalLinkIcon } from './icons.js';

/**
 * Batch 7 §工作空间: read-only lazy file tree of the task workspace. Each expanded directory is
 * one GET/tree round-trip; expanding a symlinked directory revalidates the boundary server-side
 * through safeResolve (the tree marks links with ↗). Sensitive paths and git metadata are never
 * listed; the preview card below is the same shared component the Diff tab uses.
 */

type DirNode =
  | { readonly status: 'loading' }
  | { readonly status: 'ok'; readonly entries: GuiWorkspaceTree['entries']; readonly truncated: boolean }
  | { readonly status: 'error'; readonly error: string };

type FlatRow =
  | { readonly kind: 'info'; readonly key: string; readonly text: string; readonly depth: number }
  | {
    readonly kind: 'entry';
    readonly path: string;
    readonly name: string;
    readonly entryKind: 'dir' | 'file' | 'other';
    readonly link: boolean;
    readonly depth: number;
  };

function treeError(error: unknown): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : '目录读取失败。';
}

export function FileTreePane({ taskId, getTree, getFileView, openFileExternal, onOpenWide }: {
  readonly taskId: string | null;
  readonly getTree: (taskId: string, path: string) => Promise<GuiWorkspaceTree>;
  readonly getFileView: (taskId: string, path: string) => Promise<GuiFileView>;
  readonly openFileExternal: (taskId: string, path: string) => Promise<{ ok: true }>;
  readonly onOpenWide: (path: string) => void;
}) {
  const [nodes, setNodes] = useState<Record<string, DirNode>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [preview, setPreview] = useState<FilePreviewState | null>(null);
  const [copied, setCopied] = useState(false);

  const loadDir = (dir: string) => {
    if (taskId === null) return;
    setNodes((current) => ({ ...current, [dir]: { status: 'loading' } }));
    getTree(taskId, dir)
      .then((tree) => setNodes((current) => ({ ...current, [dir]: { status: 'ok', entries: tree.entries, truncated: tree.truncated } })))
      .catch((error: unknown) => setNodes((current) => ({ ...current, [dir]: { status: 'error', error: treeError(error) } })));
  };

  useEffect(() => {
    setNodes({});
    setExpanded(new Set());
    setPreview(null);
    if (taskId === null) return;
    setNodes({ '': { status: 'loading' } });
    getTree(taskId, '')
      .then((tree) => setNodes((current) => ({ ...current, '': { status: 'ok', entries: tree.entries, truncated: tree.truncated } })))
      .catch((error: unknown) => setNodes((current) => ({ ...current, '': { status: 'error', error: treeError(error) } })));
  }, [taskId, getTree]);

  const toggleDir = (dir: string) => {
    if (expanded.has(dir)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(dir);
        return next;
      });
      return;
    }
    setExpanded((current) => new Set(current).add(dir));
    if (nodes[dir] === undefined) loadDir(dir);
  };

  const openFile = (path: string) => {
    if (taskId === null) return;
    setPreview({ path, status: 'loading' });
    getFileView(taskId, path)
      .then((view) => setPreview((current) => (current?.path === path ? { path, status: 'ok', view } : current)))
      .catch((error: unknown) => setPreview((current) => (current?.path === path ? { path, status: 'error', error: treeError(error) } : current)));
  };

  const openExternal = () => {
    if (taskId === null || preview === null) return;
    const path = preview.path;
    setPreview({ ...preview, externalPending: true });
    openFileExternal(taskId, path)
      .then(() => setPreview((current) => (current?.path === path ? { ...current, externalPending: false } : current)))
      .catch((error: unknown) => setPreview((current) => (current?.path === path
        ? { ...current, status: 'error', error: treeError(error), externalPending: false }
        : current)));
  };

  const copyContent = async () => {
    if (preview?.view?.kind !== 'text') return;
    try {
      await navigator.clipboard.writeText(preview.view.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const rows: FlatRow[] = [];
  const walk = (dir: string, depth: number): void => {
    const node = nodes[dir];
    if (node === undefined) return;
    if (node.status === 'loading') {
      rows.push({ kind: 'info', key: `${dir}/$loading`, text: '读取中…', depth });
      return;
    }
    if (node.status === 'error') {
      rows.push({ kind: 'info', key: `${dir}/$error`, text: node.error, depth });
      return;
    }
    for (const entry of node.entries) {
      const childPath = dir === '' ? entry.name : `${dir}/${entry.name}`;
      rows.push({ kind: 'entry', path: childPath, name: entry.name, entryKind: entry.kind, link: entry.link, depth });
      if (entry.kind === 'dir' && expanded.has(childPath)) walk(childPath, depth + 1);
    }
    if (node.truncated) rows.push({ kind: 'info', key: `${dir}/$truncated`, text: '条目过多，仅显示前 500 条。', depth });
  };
  if (taskId !== null) walk('', 0);

  return (
    <div className="live-evidence-pane wb-file-tree-pane">
      <p className="live-muted wb-file-tree-note">任务工作区只读浏览；敏感路径与 git 元数据不列出。</p>
      {taskId === null ? <p className="live-muted">先选择任务。</p> : null}
      {taskId !== null ? (
        <div className="wb-file-tree">
          {rows.map((row) => (row.kind === 'info' ? (
            <p key={row.key} className="wb-file-tree-info" style={{ paddingLeft: 8 + row.depth * 14 }}>{row.text}</p>
          ) : row.entryKind === 'dir' ? (
            <button
              key={row.path}
              type="button"
              className="wb-file-tree-row"
              data-open={expanded.has(row.path)}
              style={{ paddingLeft: 8 + row.depth * 14 }}
              onClick={() => toggleDir(row.path)}
              title={row.link ? '链接；展开时将重新校验边界' : undefined}
            >
              <ChevronIcon className="wb-chevron" />
              <span className="wb-file-tree-name">{row.name}{row.link ? <ExternalLinkIcon size={12} /> : null}</span>
            </button>
          ) : row.entryKind === 'file' ? (
            <button
              key={row.path}
              type="button"
              className="wb-file-tree-row"
              style={{ paddingLeft: 8 + row.depth * 14 }}
              onClick={() => openFile(row.path)}
              title={row.link ? '链接；打开时将重新校验边界' : undefined}
            >
              <span className="wb-file-tree-name wb-file-tree-leaf">{row.name}{row.link ? ' ↗' : ''}</span>
            </button>
          ) : (
            <div key={row.path} className="wb-file-tree-row" style={{ paddingLeft: 8 + row.depth * 14 }}>
              <span className="wb-file-tree-name wb-file-tree-leaf">{row.name}{row.link ? <ExternalLinkIcon size={12} /> : null}（无法预览）</span>
            </div>
          )))}
        </div>
      ) : null}
      {preview !== null ? (
        <FilePreviewCard
          preview={preview}
          copied={copied}
          onCopy={() => { void copyContent(); }}
          onOpenExternal={openExternal}
          onClose={() => setPreview(null)}
          onOpenWide={() => onOpenWide(preview.path)}
        />
      ) : null}
    </div>
  );
}
