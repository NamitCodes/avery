import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { ErrorMessage, StatusBadge, TableWrap, useLoad } from '../../components/ui';
import { formatDateTime } from '../../format';
import { useEventContext } from './EventLayout';
import { Button } from '../../components/fui';

interface Delivery {
  id: string;
  participant_id: string;
  participant_name: string;
  registration_reference: string;
  delivery_status: string;
  attempt_count: number;
  last_error: string | null;
  sent_at: string | null;
  updated_at: string;
}

export function DeliveriesPage() {
  const { event: e, canManage } = useEventContext();
  const [status, setStatus] = useState('');
  const { data, error, reload } = useLoad(
    () => api.get<{ deliveries: Delivery[]; counts: Record<string, number> }>(`/admin/events/${e.id}/deliveries${status ? `?status=${status}` : ''}`),
    [e.id, status],
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const pending = (data?.counts.QUEUED ?? 0) + (data?.counts.SENDING ?? 0);
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void reload(), 5000);
    return () => clearInterval(t);
  }, [pending, reload]);

  async function send(scope: 'UNSENT' | 'FAILED') {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = await api.post<{ issued: number; queued: number }>(`/admin/events/${e.id}/passes/send`, { scope, issue_missing: true });
      setNotice(`${res.issued} pass(es) issued, ${res.queued} email(s) queued.`);
      await reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {canManage && (
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <p style={{ marginTop: 0 }}>
            Issue passes to everyone without one and email them to the address on the participant list. Participants who have already been sent their current
            pass are not emailed again.
          </p>
          <div className="row">
            <Button variant="solid" disabled={busy} onClick={() => send('UNSENT')}>
              Issue & send passes
            </Button>
            <Button variant="subtle" disabled={busy || !data?.counts.FAILED} onClick={() => send('FAILED')}>
              Retry all failed
            </Button>
          </div>
        </div>
      )}
      {notice && <div className="alert alert-ok">{notice}</div>}
      <ErrorMessage error={error ?? actionError} />
      {data && (
        <>
          <div className="row" style={{ marginBottom: '1rem' }}>
            {['', 'QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED'].map((s) => (
              <Button key={s} size="sm" variant={status === s ? 'solid' : 'subtle'} onClick={() => setStatus(s)}>
                {s || 'All'} {s && data.counts[s] ? `(${data.counts[s]})` : ''}
              </Button>
            ))}
          </div>
          {data.deliveries.length === 0 ? (
            <p className="muted">No emails.</p>
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Participant</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Updated</th>
                    <th>Error</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.deliveries.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <Link to={`/admin/events/${e.id}/participants/${d.participant_id}`}>{d.participant_name}</Link>
                        <div className="small mono muted">{d.registration_reference}</div>
                      </td>
                      <td>
                        <StatusBadge status={d.delivery_status} />
                      </td>
                      <td>{d.attempt_count}</td>
                      <td>{formatDateTime(d.sent_at ?? d.updated_at, e.timezone)}</td>
                      <td className="small">{d.last_error}</td>
                      <td>
                        {d.delivery_status === 'FAILED' && (
                          <Button variant="subtle" size="sm"
                           
                            onClick={async () => {
                              try {
                                await api.post(`/admin/event-pass-deliveries/${d.id}/retry`);
                                await reload();
                              } catch (err) {
                                setActionError(err);
                              }
                            }}
                          >
                            Retry
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </>
      )}
    </>
  );
}
