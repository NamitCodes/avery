import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Badge } from '../../components/fui';
import { ErrorMessage, useLoad } from '../../components/ui';

interface Station {
  id: string;
  name: string;
  mode: 'ENTRY' | 'EXIT';
  location_description: string;
  event_id: string;
  event_name: string;
}

export function StationsPage() {
  const { data, error } = useLoad(
    () => api.get<{ gates: Station[]; desk_events: { id: string; name: string }[] }>('/staff/stations'),
    [],
  );
  return (
    <>
      <h1>Stations</h1>
      <ErrorMessage error={error} />
      {data && (
        <>
          <h2>Gate scanners</h2>
          {data.gates.length === 0 && <p className="muted">No active gates are assigned to you. Ask an event administrator.</p>}
          <div className="card-grid">
            {data.gates.map((g) => (
              <Link key={g.id} className="card" to={`/staff/gate/${g.id}`} style={{ textDecoration: 'none' }}>
                <div className="small muted">{g.event_name}</div>
                <strong>{g.name}</strong>
                <div style={{ marginTop: '0.5rem' }}>
                  <Badge theme={g.mode === 'ENTRY' ? 'green' : 'gray'} variant="subtle" size="md" label={g.mode} />
                </div>
                {g.location_description && <div className="small muted">{g.location_description}</div>}
              </Link>
            ))}
          </div>
          {data.desk_events.length > 0 && (
            <>
              <h2>Exception desk</h2>
              <div className="card-grid">
                {data.desk_events.map((e) => (
                  <Link key={e.id} className="card" to={`/staff/desk/${e.id}`} style={{ textDecoration: 'none' }}>
                    <strong>{e.name}</strong>
                    <div className="small muted">Search, walk-ins, lost passes</div>
                  </Link>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
