import { useCallback, useEffect, useRef, useState } from 'react';
import { resolvePreviewSource } from '../../../preview-policy.js';
import { previewHistoryKey, storageGet, storageSet } from './prefs.js';
import {
  canStepPreview,
  currentPreviewAddress,
  initialPreviewHistory,
  parsePreviewHistory,
  pushPreviewAddress,
  serializePreviewHistory,
  stepPreview,
  type PreviewHistory,
} from './preview-state.js';

const LOAD_WATCHDOG_MS = 10_000;

type LoadState = 'idle' | 'loading' | 'loaded' | 'failed';

/**
 * Batch 3 §C9–§C13: the drawer preview tab. Loopback addresses open directly; external http(s)
 * addresses open only after the honest confirmation line; everything else is rejected with the
 * real reason (resolvePreviewSource). Failure is surfaced as-is — iframe error, or no load within
 * 10s — never faked as success, and the address stays in the input for fixing.
 */
export function PreviewPane({ scope }: { readonly scope: string | null }) {
  const storageKey = scope === null ? null : previewHistoryKey(scope);
  const [history, setHistory] = useState<PreviewHistory>(initialPreviewHistory);
  const [draft, setDraft] = useState('');
  const [rejectReason, setRejectReason] = useState<string | null>(null);
  const [pendingExternal, setPendingExternal] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [reloadNonce, setReloadNonce] = useState(0);
  const watchdogRef = useRef<number | null>(null);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) {
      window.clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  const armWatchdog = useCallback(() => {
    clearWatchdog();
    watchdogRef.current = window.setTimeout(() => {
      watchdogRef.current = null;
      setLoadState((state) => (state === 'loading' ? 'failed' : state));
    }, LOAD_WATCHDOG_MS);
  }, [clearWatchdog]);

  useEffect(() => {
    const stored = storageKey === null ? initialPreviewHistory() : parsePreviewHistory(storageGet(storageKey));
    setHistory(stored);
    setRejectReason(null);
    setPendingExternal(null);
    setReloadNonce(0);
    const address = currentPreviewAddress(stored);
    setDraft(address ?? '');
    if (address === null) {
      setLoadState('idle');
    } else {
      setLoadState('loading');
      armWatchdog();
    }
    return clearWatchdog;
  }, [storageKey, armWatchdog, clearWatchdog]);

  const navigate = useCallback((next: PreviewHistory) => {
    setHistory(next);
    if (storageKey !== null) storageSet(storageKey, serializePreviewHistory(next));
    const address = currentPreviewAddress(next);
    setDraft(address ?? '');
    setPendingExternal(null);
    setRejectReason(null);
    if (address === null) {
      setLoadState('idle');
      clearWatchdog();
    } else {
      setLoadState('loading');
      armWatchdog();
    }
  }, [storageKey, armWatchdog, clearWatchdog]);

  const open = useCallback((raw: string) => {
    const source = resolvePreviewSource(raw);
    if (source.kind === 'reject') {
      setRejectReason(source.reason);
      setPendingExternal(null);
      return;
    }
    if (source.kind === 'external-confirm') {
      setPendingExternal(source.normalized);
      setRejectReason(null);
      return;
    }
    navigate(pushPreviewAddress(history, source.normalized));
  }, [history, navigate]);

  const confirmExternal = useCallback(() => {
    if (pendingExternal === null) return;
    navigate(pushPreviewAddress(history, pendingExternal));
  }, [history, navigate, pendingExternal]);

  const refresh = useCallback(() => {
    if (currentPreviewAddress(history) === null) return;
    setReloadNonce((nonce) => nonce + 1);
    setLoadState('loading');
    armWatchdog();
  }, [history, armWatchdog]);

  const markLoaded = useCallback(() => {
    clearWatchdog();
    setLoadState('loaded');
  }, [clearWatchdog]);

  const markFailed = useCallback(() => {
    clearWatchdog();
    setLoadState('failed');
  }, [clearWatchdog]);

  if (scope === null) {
    return <div className="live-evidence-pane wb-preview-pane"><p className="live-muted">先选择任务。</p></div>;
  }

  const current = currentPreviewAddress(history);

  return (
    <div className="live-evidence-pane wb-preview-pane">
      <div className="wb-preview-bar">
        <div className="wb-preview-nav" role="group" aria-label="预览导航">
          <button type="button" disabled={!canStepPreview(history, -1)} onClick={() => navigate(stepPreview(history, -1))}>后退</button>
          <button type="button" disabled={!canStepPreview(history, 1)} onClick={() => navigate(stepPreview(history, 1))}>前进</button>
          <button type="button" disabled={current === null} onClick={refresh}>刷新</button>
        </div>
        <input
          type="text"
          value={draft}
          spellCheck={false}
          placeholder="http://127.0.0.1:端口/路径"
          aria-label="预览地址"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') open(draft); }}
        />
        <button type="button" className="wb-preview-open" disabled={draft.trim() === ''} onClick={() => open(draft)}>打开</button>
      </div>

      {rejectReason !== null ? <p className="wb-preview-reject" role="alert">{rejectReason}</p> : null}

      {pendingExternal !== null ? (
        <div className="wb-preview-confirm">
          <span>外部站点可能拒绝被嵌入，失败会如实显示。</span>
          <button type="button" onClick={confirmExternal}>仍然打开</button>
          <button type="button" onClick={() => setPendingExternal(null)}>取消</button>
        </div>
      ) : null}

      <p className="wb-preview-status">
        当前地址：{current ?? '未打开'}{loadState === 'loading' ? '（载入中…）' : ''}
      </p>

      {current === null ? (
        <p className="live-muted">
          输入本机回环地址（http://127.0.0.1 或 localhost，任意端口）直接打开；外部 http(s) 地址打开前会先向你确认。预览只给你自己看，不代表 Agent 浏览过该页面。
        </p>
      ) : (
        <iframe
          key={`${current}:${reloadNonce}`}
          className="wb-preview-frame"
          src={current}
          title="任务预览"
          onLoad={markLoaded}
          onError={markFailed}
        />
      )}

      {current !== null && loadState === 'failed' ? (
        <p className="wb-preview-fail" role="alert">
          页面未在限定时间加载或拒绝被嵌入（对方可能设置 X-Frame-Options/CSP）。地址已保留在输入框，可修改后重试。
        </p>
      ) : null}
    </div>
  );
}
