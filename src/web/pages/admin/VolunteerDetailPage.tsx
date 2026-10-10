import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ROLE_LABEL, type Role, type User } from '../../api';
import { useAuth } from '../../auth';
import { ErrorMessage, ReasonDialog, StatusBadge, useLoad } from '../../components/ui';
import { formatDate, formatTime } from '../../format';

interface Row {
  id: string;
  tapped_in_at: string;
  source: string;
  status: string;
  session_id: string;
  title: string;
  start_at: string;
  venue_name: string;
  timezone: string;
}

export function VolunteerDetailPage() {
  const { id = '' } = useParams();
  const { user: me } = useAuth();
  const { data, error, reload } = useLoad(() => api.get<{ volunteer: User; attendance: Row[] }>(`/admin/volunteers/${id}/attendance`), [id]);
  const [change, setChange] = useState<{ status?: string; role?: Role } | null>(null);

  if (error) return <ErrorMessage error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  const v = data.volunteer;
  const isMe = me?.id === v.id;

  return (
    <>
      <p className="small muted">
        <Link to="/admin/volunteers">People</Link> /
      </p>
      <h1>
        {v.name} <StatusBadge status={v.status} />
      </h1>
      <dl className="kv">
        <dt>ID</dt>
        <dd className="mono">{v.volunteer_code}</dd>
        <dt>Email</dt>
        <dd>{v.email}</dd>
        <dt>Role</dt>
        <dd>
          <select
            value={v.role}
            disabled={isMe}
            onChange={(e) => setChange({ role: e.target.value as Role })}
            style={{ width: 'auto', padding: '0.2rem 0.4rem' }}
          >
            {Object.entries(ROLE_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </dd>
      </dl>
      {!isMe && (
        <div className="row" style={{ marginTop: '1rem' }}>
          {v.status === 'ACTIVE' ? (
            <button className="btn-secondary" onClick={() => setChange({ status: 'INACTIVE' })}>
              Deactivate
            </button>
          ) : (
            <button className="btn-secondary" onClick={() => setChange({ status: 'ACTIVE' })}>
              Reactivate
            </button>
          )}
        </div>
      )}

      <div className="section">
        <h2>Sessions attended ({data.attendance.filter((a) => a.status === 'ACTIVE').length})</h2>
        {data.attendance.length === 0 ? (
          <p className="muted">No attendance recorded.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Activity</th>
                  <th>Venue</th>
                  <th>Tap-in</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {data.attendance.map((a) => (
                  <tr key={a.id} className={a.status === 'VOIDED' ? 'dim' : undefined}>
                    <td>{formatDate(a.start_at, a.timezone)}</td>
                    <td>
                      <Link to={`/admin/sessions/${a.session_id}`}>{a.title}</Link>
                      {a.status === 'VOIDED' && (
                        <>
                          {' '}
                          <StatusBadge status="VOIDED" />
                        </>
                      )}
                    </td>
                    <td>{a.venue_name}</td>
                    <td>{formatTime(a.tapped_in_at, a.timezone)}</td>
                    <td>{a.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {change && (
        <ReasonDialog
          title={change.role ? `Change role to ${ROLE_LABEL[change.role]}` : change.status === 'INACTIVE' ? 'Deactivate account' : 'Reactivate account'}
          confirmLabel="Confirm"
          optional
          description={change.status === 'INACTIVE' ? <p>Inactive accounts cannot check in. Their history is kept.</p> : undefined}
          onClose={() => setChange(null)}
          onConfirm={async (reason) => {
            await api.patch(`/admin/volunteers/${id}`, { ...change, reason: reason || undefined });
            await reload();
          }}
        />
      )}
    </>
  );
}
