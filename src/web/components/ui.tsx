import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../api';
import { STATUS_LABEL } from '../format';

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status.toLowerCase()}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof ApiError ? error.message : 'Something went wrong.';
  const issues = error instanceof ApiError ? (error.details.issues as { path: string; message: string }[] | undefined) : undefined;
  return (
    <div className="alert alert-error" role="alert">
      {message}
      {issues && (
        <ul>
          {issues.map((i) => (
            <li key={i.path + i.message}>
              {i.path ? <strong>{i.path}: </strong> : null}
              {i.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Fetch data on mount / when deps change; exposes reload(). */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(loader, deps);
  const reload = useCallback(async () => {
    try {
      setData(await load());
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [load]);
  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);
  return { data, error, loading, reload };
}

export function Modal({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="btn-link" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Prompt for a mandatory reason, then run an action. */
export function ReasonDialog({
  title,
  description,
  confirmLabel,
  optional = false,
  danger = false,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  optional?: boolean;
  danger?: boolean;
  onConfirm(reason: string): Promise<void>;
  onClose(): void;
  children?: ReactNode;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const valid = optional || reason.trim().length >= 3;
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid) return;
          setBusy(true);
          setError(null);
          try {
            await onConfirm(reason.trim());
            onClose();
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        {description && <div className="muted">{description}</div>}
        {children}
        <label>
          Reason {optional ? <span className="muted">(optional)</span> : <span className="required">*</span>}
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} required={!optional} minLength={optional ? undefined : 3} />
        </label>
        <ErrorMessage error={error} />
        <div className="actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={danger ? 'btn-danger' : ''} disabled={busy || !valid}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
