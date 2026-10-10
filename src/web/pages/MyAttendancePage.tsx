import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorMessage, useLoad } from '../components/ui';
import { formatDate, formatRange, formatTime } from '../format';

interface Row {
  id: string;
  tapped_in_at: string;
  source: string;
  title: string;
  start_at: string;
  end_at: string;
  venue_name: string;
  timezone: string;
}

export function MyAttendancePage() {
  const { user } = useAuth();
  const { data, error, loading } = useLoad(() => api.get<{ attendance: Row[] }>('/volunteers/me/attendance'), []);
  return (
    <>
      <h1>My attendance</h1>
      <p className="muted">
        Volunteer ID <span className="mono">{user?.volunteer_code}</span>
      </p>
      <ErrorMessage error={error} />
      {loading && <p className="muted">Loading…</p>}
      {data && data.attendance.length === 0 && <p className="muted">You haven’t checked in to any activities yet.</p>}
      {data && data.attendance.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Activity</th>
                <th>Venue</th>
                <th>Tap-in</th>
              </tr>
            </thead>
            <tbody>
              {data.attendance.map((a) => (
                <tr key={a.id}>
                  <td>{formatDate(a.start_at, a.timezone)}</td>
                  <td>
                    {a.title}
                    <div className="small muted">{formatRange(a.start_at, a.end_at, a.timezone)}</div>
                  </td>
                  <td>{a.venue_name}</td>
                  <td>
                    {formatTime(a.tapped_in_at, a.timezone)}
                    {a.source === 'ADMIN' && <div className="small muted">recorded by organiser</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
