import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Location, type QrCode } from '../../api';
import { ErrorMessage, ReasonDialog, StatusBadge, useLoad } from '../../components/ui';
import { formatDateTime } from '../../format';
import { TIMEZONES } from './LocationsPage';

export function LocationDetailPage() {
  const { id = '' } = useParams();
  const detail = useLoad(() => api.get<{ location: Location; qr_codes: QrCode[] }>(`/admin/locations/${id}`), [id]);
  const [form, setForm] = useState({ name: '', address: '', timezone: '', status: 'ACTIVE' });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<'revoke' | 'replace' | null>(null);

  useEffect(() => {
    const l = detail.data?.location;
    if (l) setForm({ name: l.name, address: l.address, timezone: l.timezone, status: l.status });
  }, [detail.data]);

  if (detail.error) return <ErrorMessage error={detail.error} />;
  if (!detail.data) return <p className="muted">Loading…</p>;
  const { location, qr_codes } = detail.data;
  const active = location.active_qr;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await api.patch(`/admin/locations/${id}`, form);
      setSaved(true);
      await detail.reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <>
      <p className="small muted">
        <Link to="/admin/venues">Venues</Link> /
      </p>
      <h1>
        {location.name} <StatusBadge status={location.status} />
      </h1>

      <div className="card">
        <div className="spread">
          <h2 style={{ margin: 0 }}>Venue QR code</h2>
          {active ? <StatusBadge status="ACTIVE" /> : <StatusBadge status="REVOKED" />}
        </div>
        {active ? (
          <>
            <div className="row" style={{ marginTop: '1rem', alignItems: 'flex-start' }}>
              <img src={`/api/admin/qr-codes/${active.id}/image?format=svg`} alt="Venue QR code" width={160} height={160} />
              <div className="small">
                <p className="mono" style={{ wordBreak: 'break-all' }}>{active.url}</p>
                <p className="muted">Issued {formatDateTime(active.created_at)}</p>
              </div>
            </div>
            <div className="row" style={{ marginTop: '1rem' }}>
              <Link className="btn" to={`/admin/qr/${active.id}/print`}>
                Print
              </Link>
              <a className="btn btn-secondary" href={`/api/admin/qr-codes/${active.id}/image?download=1`}>
                Download PNG
              </a>
              <button className="btn-secondary" onClick={() => setDialog('replace')}>
                Replace
              </button>
              <button className="btn-danger" onClick={() => setDialog('revoke')}>
                Revoke
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted">No active QR code. Volunteers cannot check in at this venue until you generate one.</p>
            <button onClick={() => setDialog('replace')}>Generate QR code</button>
          </>
        )}
      </div>

      <div className="section" style={{ maxWidth: 560 }}>
        <h2>Details</h2>
        <form onSubmit={save}>
          <label>
            Name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </label>
          <label>
            Address
            <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </label>
          <label>
            Time zone
            <select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {TIMEZONES.map((tz) => (
                <option key={tz}>{tz}</option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive (blocks check-ins)</option>
            </select>
          </label>
          <ErrorMessage error={error} />
          {saved && <div className="alert alert-ok">Saved.</div>}
          <button>Save</button>
        </form>
      </div>

      <div className="section">
        <h2>QR history</h2>
        <table>
          <thead>
            <tr>
              <th>Issued</th>
              <th>Status</th>
              <th>Revoked</th>
            </tr>
          </thead>
          <tbody>
            {qr_codes.map((q) => (
              <tr key={q.id}>
                <td>{formatDateTime(q.created_at)}</td>
                <td>
                  <StatusBadge status={q.status} />
                </td>
                <td>{q.revoked_at ? formatDateTime(q.revoked_at) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {dialog === 'revoke' && active && (
        <ReasonDialog
          title="Revoke QR code"
          danger
          optional
          confirmLabel="Revoke now"
          description={<p>New check-ins through this printed code will be blocked immediately. Existing attendance is kept.</p>}
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            await api.post(`/admin/qr-codes/${active.id}/revoke`, { reason: reason || undefined });
            await detail.reload();
          }}
        />
      )}
      {dialog === 'replace' && (
        <ReasonDialog
          title={active ? 'Replace QR code' : 'Generate QR code'}
          optional
          confirmLabel={active ? 'Replace' : 'Generate'}
          description={active ? <p>The current code will stop working immediately. Print and put up the new one.</p> : undefined}
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            await api.post(`/admin/locations/${id}/qr-codes`, { reason: reason || undefined });
            await detail.reload();
          }}
        />
      )}
    </>
  );
}
