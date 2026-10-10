import { Dialog } from '@rtcamp/frappe-ui-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api';
import { Button, StatusPill, Textarea } from './fui';

/** Frappe Badge for a status code. */
export function StatusBadge({ status }: { status: string }) {
  return <StatusPill status={status} />;
}

/** Inline error in Frappe's red alert style (with field-level issues if any). */
export function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'Something went wrong.';
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

/** Frappe Dialog that is open while rendered; closing calls onClose. */
export function Modal({ title, onClose, children, size = 'lg' }: { title: string; onClose(): void; children: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} options={{ title, size }}>
      <div className="text-ink-gray-7">{children}</div>
    </Dialog>
  );
}

/** Prompt for a (usually mandatory) reason, then run an action. */
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
        {description && <div className="text-p-base text-ink-gray-7 mb-3">{description}</div>}
        {children}
        <label>
          Reason {optional ? <span className="text-ink-gray-4">(optional)</span> : <span className="required">*</span>}
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        </label>
        <ErrorMessage error={error} />
        <div className="actions">
          <Button type="button" variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="solid" theme={danger ? 'red' : 'gray'} disabled={busy || !valid} loading={busy}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * List table that turns into stacked cards on phones (CSS, ≤640px). Each cell is
 * labelled with its column header (data-label), kept in sync as rows change.
 */
export function TableWrap({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const label = () => {
      const heads = Array.from(el.querySelectorAll('thead th')).map((th) => th.textContent?.trim() ?? '');
      el.querySelectorAll('tbody tr').forEach((tr) =>
        Array.from(tr.children).forEach((td, i) => {
          if (td.getAttribute('data-label') !== (heads[i] ?? '')) td.setAttribute('data-label', heads[i] ?? '');
        }),
      );
    };
    label();
    // Rows load and refresh asynchronously; relabel on structural changes only (no attribute feedback loop).
    const mo = new MutationObserver(label);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
  return (
    <div ref={ref} className="table-wrap stack-mobile">
      {children}
    </div>
  );
}
