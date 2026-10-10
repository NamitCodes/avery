import { Link } from 'react-router-dom';
import { api, EVENT_MANAGERS } from '../../api';
import { useAuth } from '../../auth';
import { ErrorMessage, StatusBadge, TableWrap, useLoad } from '../../components/ui';
import { formatRange } from '../../format';
import { POLICY_LABEL, type EventRecord } from './types';
import { buttonClass } from '../../components/fui';

export function EventsPage() {
  const { user } = useAuth();
  const { data, error } = useLoad(() => api.get<{ events: EventRecord[] }>('/admin/events'), []);
  const canManage = !!user && EVENT_MANAGERS.includes(user.role);
  return (
    <>
      <div className="spread">
        <h1>Events</h1>
        {canManage && (
          <Link className={buttonClass({ variant: 'solid' })} to="/admin/events/new">
            New event
          </Link>
        )}
      </div>
      <ErrorMessage error={error} />
      {data && data.events.length === 0 && <p className="muted">No events yet.</p>}
      {data && data.events.length > 0 && (
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>When</th>
                <th>Status</th>
                <th>Mode</th>
                <th className="right">Registered</th>
                <th className="right">Checked in</th>
                <th className="right">Inside now</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link to={`/admin/events/${e.id}`}>{e.name}</Link>
                    <div className="small muted">{POLICY_LABEL[e.verification_policy]}</div>
                  </td>
                  <td>{formatRange(e.starts_at, e.ends_at, e.timezone)}</td>
                  <td>
                    <StatusBadge status={e.status} />
                  </td>
                  <td className="small">
                    {[e.reentry_enabled ? 'Entry/exit' : 'Single check-in', e.advance_registration_enabled && 'Online reg.', e.walk_ins_enabled && 'Walk-ins']
                      .filter(Boolean)
                      .join(' · ')}
                  </td>
                  <td className="right">{e.participant_count}</td>
                  <td className="right">{e.checked_in_count}</td>
                  <td className="right">{e.reentry_enabled ? e.inside_count : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </>
  );
}
