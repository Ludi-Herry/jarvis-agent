import { useState, type RefObject } from 'react';

export function StopDialog({
  dialogRef,
  pending,
  error,
  onConfirm,
}: {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onConfirm: (reason: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState('Ludi 从 Web GUI 紧急终止本次运行。');
  return (
    <dialog ref={dialogRef} className="terminate-dialog live-stop-dialog wb-stop-dialog" aria-labelledby="wb-stop-title">
      <form
        method="dialog"
        className="terminate-surface"
        onSubmit={(event) => {
          event.preventDefault();
          void onConfirm(reason).then((confirmed) => { if (confirmed) dialogRef.current?.close(); });
        }}
      >
        <span className="dialog-eyebrow">紧急控制</span>
        <h2 id="wb-stop-title">确认终止当前运行？</h2>
        <p>Jarvis 会进入停止流程，并阻止后续动作。当前消息、审批和证据继续保留；终态不会自动重跑。</p>
        <label htmlFor="wb-stop-reason">终止原因</label>
        <textarea
          id="wb-stop-reason"
          rows={3}
          required
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
        />
        {error !== null ? <p className="live-dialog-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" disabled={pending} onClick={() => dialogRef.current?.close()}>取消</button>
          <button className="danger" type="submit" disabled={pending || reason.trim() === ''}>
            {pending ? '正在终止' : '确认急停'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
