import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs, type Location, type SessionListItem } from '../../api';
import { ErrorMessage, ReasonDialog, StatusBadge, TableWrap, useLoad } from '../../components/ui';
import { formatRange, todayIso } from '../../format';
import { Button, buttonClass, Input, Select } from '../../components/fui';

const STATUSES = ['DRAFT', 'SCHEDULED', 'OPEN', 'CLOSED', 'CANCELLED', 'ARCHIVED'];

export function SessionsPage() {
  const [params, setParams] = useSearchParams();
  const filters = {
    from: params.get('from') ?? todayIso(-7),
    to: params.get('to') ?? todayIso(30),
    location_id: params.get('location_id') ?? '',
    q: params.get('q') ?? '',
    status: params.get('status') ?? '',
  };
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (!next.has('from')) next.set('from', filters.from);
    if (!next.has('to')) next.set('to', filters.to);
    setParams(next, { replace: true });
  };

  const locations = useLoad(() => api.get<{ locations: Location[] }>('/admin/locations'), []);
  const sessions = useLoad(() => api.get<{ sessions: SessionListItem[] }>(`/admin/sessions${qs(filters)}`), [params.toString()]);
  const [pending, setPending] = useState<{ s: SessionListItem; action: 'close' | 'cancel' } | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function act(s: SessionListItem, action: string, reason?: string) {
    setError(null);
    try {
      await api.post(`/admin/sessions/${s.id}/${action}`, reason ? { reason } : {});
      await sessions.reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <>
      <div className="spread">
        <h1>Sessions</h1>
        <Link className={buttonClass({ variant: 'solid' })} to="/admin/sessions/new">
          New session
        </Link>
      </div>
      <div className="filters">
        <label>
          From
          <Input type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} />
        </label>
        <label>
          To
          <Input type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} />
        </label>
        <label>
          Venue
          <Select value={filters.location_id} onChange={(e) => set('location_id', e.target.value)}>
            <option value="">All venues</option>
            {locations.data?.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </label>
        <label>
          Activity
          <Input
            placeholder="Search title"
            defaultValue={filters.q}
            onKeyDown={(e) => e.key === 'Enter' && set('q', e.currentTarget.value)}
            onBlur={(e) => set('q', e.target.value)}
          />
        </label>
        <label>
          Status
          <Select value={filters.status} onChange={(e) => set('status', e.target.value)}>
            <option value="">Any (except archived)</option>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </label>
      </div>
      <ErrorMessage error={sessions.error ?? error} />
      {sessions.data && sessions.data.sessions.length === 0 && <p className="muted">No sessions match these filters.</p>}
      {sessions.data && sessions.data.sessions.length > 0 && (
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Activity</th>
                <th>Venue</th>
                <th>Date & time</th>
                <th>Status</th>
                <th className="right">Checked in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.data.sessions.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link to={`/admin/sessions/${s.id}`}>{s.title}</Link>
                  </td>
                  <td>{s.location_name}</td>
                  <td>{formatRange(s.start_at, s.end_at, s.timezone)}</td>
                  <td>
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="right">{s.attendance_count}</td>
                  <td>
                    <div className="row">
                      <Link className={buttonClass({ variant: 'subtle', size: 'sm' })} to={`/admin/sessions/${s.id}`}>
                        View
                      </Link>
                      {!['CANCELLED', 'ARCHIVED'].includes(s.status) && (
                        <Link className={buttonClass({ variant: 'subtle', size: 'sm' })} to={`/admin/sessions/${s.id}/edit`}>
                          Edit
                        </Link>
                      )}
                      {s.status === 'DRAFT' && (
                        <Button variant="subtle" size="sm" onClick={() => act(s, 'publish')}>
                          Publish
                        </Button>
                      )}
                      {['SCHEDULED', 'OPEN'].includes(s.status) && (
                        <Button variant="subtle" size="sm" onClick={() => setPending({ s, action: 'close' })}>
                          Close
                        </Button>
                      )}
                      {!['CANCELLED', 'ARCHIVED'].includes(s.status) && (
                        <Button variant="subtle" size="sm" onClick={() => setPending({ s, action: 'cancel' })}>
                          Cancel
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {pending && (
        <ReasonDialog
          title={pending.action === 'close' ? 'Close check-in' : 'Cancel session'}
          description={<p>{pending.s.title}</p>}
          confirmLabel={pending.action === 'close' ? 'Close check-in' : 'Cancel session'}
          danger={pending.action === 'cancel'}
          optional
          onClose={() => setPending(null)}
          onConfirm={(reason) => act(pending.s, pending.action, reason)}
        />
      )}
    </>
  );
}
