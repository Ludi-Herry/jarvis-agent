import type { GuiFileView } from '../../../live-types.js';
import { CloseIcon } from './icons.js';

/**
 * Batch 7 §工作空间: the shared inline file-preview card. Diff tab (batch 4) and the 文件 tree
 * tab both render the exact same loading/error/truncated/image/external-open behavior through
 * this component; the loading logic stays with each caller.
 */

export interface FilePreviewState {
  readonly path: string;
  readonly status: 'loading' | 'ok' | 'error';
  readonly view?: GuiFileView;
  readonly error?: string;
  readonly externalPending?: boolean;
}

export function FilePreviewCard({ preview, copied, onCopy, onOpenExternal, onClose, onOpenWide }: {
  readonly preview: FilePreviewState;
  readonly copied: boolean;
  readonly onCopy: () => void;
  readonly onOpenExternal: () => void;
  readonly onClose: () => void;
  /** Batch 8 §阅读层: optional wide-reader entry; the inline card always stays as it is. */
  readonly onOpenWide?: () => void;
}) {
  return (
    <section className="wb-file-preview" aria-label={`文件预览 ${preview.path}`}>
      <header>
        <code>{preview.path}</code>
        <span className="wb-file-preview-actions">
          {preview.status === 'ok' && preview.view?.kind === 'text' ? (
            <button type="button" onClick={onCopy}>{copied ? '已复制' : '复制'}</button>
          ) : null}
          {onOpenWide !== undefined ? <button type="button" onClick={onOpenWide}>大视图</button> : null}
          <button type="button" disabled={preview.externalPending === true} onClick={onOpenExternal}>
            {preview.externalPending === true ? '打开中…' : '在外部打开'}
          </button>
          <button type="button" onClick={onClose} aria-label="关闭预览"><CloseIcon /></button>
        </span>
      </header>
      {preview.status === 'loading' ? <p className="live-muted">读取中…</p> : null}
      {preview.status === 'error' ? <p className="wb-file-preview-error">{preview.error ?? '读取文件失败。'}</p> : null}
      {preview.status === 'ok' && preview.view?.kind === 'text' ? (
        <>
          <pre className="wb-file-preview-content">{preview.view.content}</pre>
          {preview.view.truncated ? <p className="live-muted">文件过大，仅显示前 200 KB。</p> : null}
        </>
      ) : null}
      {preview.status === 'ok' && preview.view?.kind === 'image' ? (
        <img className="wb-file-preview-image" alt={preview.view.path} src={`data:${preview.view.mime};base64,${preview.view.content}`} />
      ) : null}
    </section>
  );
}
