import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type Location } from '../../api';
import { ErrorMessage, StatusBadge, TableWrap, useLoad } from '../../components/ui';
import { Button, Input, Select } from '../../components/fui';

export const TIMEZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['Asia/Singapore', 'UTC'];
  }
})();

export function LocationsPage() {
  const list = useLoad(() => api.get<{ locations: Location[] }>('/admin/locations'), []);
  const [form, setForm] = useState({ name: '', address: '', timezone: 'Asia/Singapore' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/admin/locations', form);
      setForm({ ...form, name: '', address: '' });
      await list.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Venues</h1>
      <p className="muted">Each venue has one reusable printed QR code. The QR identifies the venue only; volunteers must still sign in.</p>
      <ErrorMessage error={list.error} />
      {list.data && (
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Venue</th>
                <th>Time zone</th>
                <th>Status</th>
                <th>QR code</th>
                <th className="right">Sessions</th>
              </tr>
            </thead>
            <tbody>
              {list.data.locations.map((l) => (
                <tr key={l.id}>
                  <td>
                    <Link to={`/admin/venues/${l.id}`}>{l.name}</Link>
                    <div className="small muted">{l.address}</div>
                  </td>
                  <td>{l.timezone}</td>
                  <td>
                    <StatusBadge status={l.status} />
                  </td>
                  <td>
                    {l.active_qr ? (
                      <Link to={`/admin/qr/${l.active_qr.id}/print`}>Print QR</Link>
                    ) : (
                      <span className="muted">None active</span>
                    )}
                  </td>
                  <td className="right">{l.session_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}

      <div className="section" style={{ maxWidth: 560 }}>
        <h2>Add a venue</h2>
        <form onSubmit={create}>
          <label>
            Name
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </label>
          <label>
            Address
            <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </label>
          <label>
            Time zone
            <Select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {TIMEZONES.map((tz) => (
                <option key={tz}>{tz}</option>
              ))}
            </Select>
          </label>
          <ErrorMessage error={error} />
          <Button variant="solid" disabled={busy}>Create venue & QR code</Button>
        </form>
      </div>
    </>
  );
}
