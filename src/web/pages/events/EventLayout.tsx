import { Link, NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom';
import { api, EVENT_MANAGERS } from '../../api';
import { useAuth } from '../../auth';
import { ErrorMessage, StatusBadge, useLoad } from '../../components/ui';
import { formatRange } from '../../format';
import type { EventRecord } from './types';

export interface EventContext {
  event: EventRecord;
  reload(): Promise<void>;
  canManage: boolean;
}

export const useEventContext = () => useOutletContext<EventContext>();

export function EventLayout() {
  const { eventId = '' } = useParams();
  const { user } = useAuth();
  const { data, error, reload } = useLoad(() => api.get<{ event: EventRecord }>(`/admin/events/${eventId}`), [eventId]);
  if (error) return <ErrorMessage error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  const e = data.event;
  const canManage = !!user && EVENT_MANAGERS.includes(user.role);
  const base = `/admin/events/${eventId}`;
  return (
    <>
      <p className="small muted">
        <Link to="/admin/events">Events</Link> /
      </p>
      <div className="spread">
        <h1 style={{ marginBottom: '0.25rem' }}>
          {e.name} <StatusBadge status={e.status} />
        </h1>
        {e.status === 'ACTIVE' && (
          <Link className="btn btn-secondary" to={`/staff/desk/${e.id}`}>
            Exception desk
          </Link>
        )}
      </div>
      <p className="muted small">
        {formatRange(e.starts_at, e.ends_at, e.timezone)} {e.venue_text && `· ${e.venue_text}`}
      </p>
      <nav className="tabs">
        <NavLink end to={base}>
          Overview
        </NavLink>
        <NavLink to={`${base}/participants`}>Participants</NavLink>
        {canManage && <NavLink to={`${base}/import`}>Import</NavLink>}
        <NavLink to={`${base}/deliveries`}>Pass emails</NavLink>
        {canManage && <NavLink to={`${base}/gates`}>Gates</NavLink>}
        <NavLink to={`${base}/access`}>Access log</NavLink>
        {canManage && <NavLink to={`${base}/settings`}>Settings</NavLink>}
      </nav>
      <Outlet context={{ event: e, reload, canManage } satisfies EventContext} />
    </>
  );
}
