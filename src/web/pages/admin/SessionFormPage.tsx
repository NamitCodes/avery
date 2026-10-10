import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type Location, type Session } from '../../api';
import { ErrorMessage, useLoad } from '../../components/ui';
import { toLocalInput } from '../../format';
import { Button, Input, Select, Textarea } from '../../components/fui';

const empty = { location_id: '', title: '', description: '', start_at: '', end_at: '', checkin_opens_at: '', checkin_closes_at: '' };

/** Create or edit a session. Times are entered in the venue's local time zone. */
export function SessionFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const locations = useLoad(() => api.get<{ locations: Location[] }>('/admin/locations?status=ACTIVE'), []);
  const existing = useLoad(
    () => (id ? api.get<{ session: Session; location: Location }>(`/admin/sessions/${id}`) : Promise.resolve(null)),
    [id],
  );
  const [form, setForm] = useState(empty);
  const [customWindow, setCustomWindow] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = existing.data;
    if (!d) return;
    const tz = d.location.timezone;
    setForm({
      location_id: d.session.location_id,
      title: d.session.title,
      description: d.session.description,
      start_at: toLocalInput(d.session.start_at, tz),
      end_at: toLocalInput(d.session.end_at, tz),
      checkin_opens_at: toLocalInput(d.session.checkin_opens_at, tz),
      checkin_closes_at: toLocalInput(d.session.checkin_closes_at, tz),
    });
    setCustomWindow(true);
  }, [existing.data]);

  const venue = locations.data?.locations.find((l) => l.id === form.location_id) ?? existing.data?.location;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent, publish = false) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = { ...form };
    if (!customWindow) {
      delete body.checkin_opens_at;
      delete body.checkin_closes_at;
    }
    try {
      if (editing) {
        await api.patch(`/admin/sessions/${id}`, { ...body, reason: reason || undefined });
        navigate(`/admin/sessions/${id}`);
      } else {
        const res = await api.post<{ session: Session }>('/admin/sessions', { ...body, publish });
        navigate(`/admin/sessions/${res.session.id}`);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <h1>{editing ? 'Edit session' : 'New session'}</h1>
      <form onSubmit={(e) => submit(e)}>
        <label>
          Venue
          <Select value={form.location_id} onChange={set('location_id')} required>
            <option value="">Choose a venue…</option>
            {locations.data?.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </label>
        <label>
          Activity title
          <Input value={form.title} onChange={set('title')} required maxLength={200} />
        </label>
        <label>
          Description <span className="muted">(optional — helps volunteers pick the right activity)</span>
          <Textarea rows={2} value={form.description} onChange={set('description')} maxLength={2000} />
        </label>
        {venue && <p className="small muted">Times are in the venue’s time zone: {venue.timezone}</p>}
        <div className="form-grid">
          <label>
            Starts
            <Input type="datetime-local" value={form.start_at} onChange={set('start_at')} required />
          </label>
          <label>
            Ends
            <Input type="datetime-local" value={form.end_at} onChange={set('end_at')} required />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={customWindow} onChange={(e) => setCustomWindow(e.target.checked)} />
          Custom check-in window (default: opens 15 min before start, closes 60 min after start)
        </label>
        {customWindow && (
          <div className="form-grid">
            <label>
              Check-in opens
              <Input type="datetime-local" value={form.checkin_opens_at} onChange={set('checkin_opens_at')} required />
            </label>
            <label>
              Check-in closes
              <Input type="datetime-local" value={form.checkin_closes_at} onChange={set('checkin_closes_at')} required />
            </label>
          </div>
        )}
        {editing && (
          <label>
            Reason for change <span className="muted">(optional, recorded in the audit log)</span>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        )}
        <ErrorMessage error={error} />
        <div className="actions">
          <Button variant="subtle" type="button" onClick={() => navigate(-1)}>
            Cancel
          </Button>
          <Button variant="solid" disabled={busy}>{editing ? 'Save changes' : 'Save as draft'}</Button>
          {!editing && (
            <Button variant="solid" type="button" disabled={busy} onClick={(e) => submit(e as unknown as FormEvent, true)}>
              Save & publish
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
