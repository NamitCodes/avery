import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Location, type Session, type SessionListItem } from '../../api';
import { BigQr, DemoPageShell, DemoStep, usePolling, usePresenter } from '../../components/demoKit';
import { ErrorMessage } from '../../components/ui';
import { formatTimeWithSeconds } from '../../format';

const VENUE_NAME = 'Demo Hall';

interface Row {
  id: string;
  volunteer_name: string;
  volunteer_code: string;
  tapped_in_at: string;
  source: string;
}

const hhmm = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Laptop creates a session and shows the venue QR; a phone checks in; the laptop shows it live. */
export function DemoVolunteerPage() {
  const { demo, error: signInError, ready } = usePresenter();
  const [venue, setVenue] = useState<Location | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [title, setTitle] = useState(`Food bank shift ${hhmm()}`);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // Find (or create) the demo venue and any session already open there.
  const setup = useCallback(async () => {
    try {
      const { locations } = await api.get<{ locations: Location[] }>('/admin/locations');
      let v = locations.find((l) => l.name === VENUE_NAME) ?? null;
      if (!v) v = (await api.post<{ location: Location }>('/admin/locations', { name: VENUE_NAME, address: 'Live demo venue', timezone: 'Asia/Singapore' })).location;
      if (!v.active_qr) await api.post(`/admin/locations/${v.id}/qr-codes`, { reason: 'Demo' });
      const fresh = (await api.get<{ location: Location }>(`/admin/locations/${v.id}`)).location;
      setVenue(fresh);
      const { sessions } = await api.get<{ sessions: SessionListItem[] }>(`/admin/sessions?location_id=${v.id}&status=OPEN`);
      setSession(sessions[0] ?? null);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    if (ready) void setup();
  }, [ready, setup]);

  async function createSession() {
    if (!venue) return;
    setBusy(true);
    setError(null);
    try {
      // Keep it simple for the audience: only one open session at the demo venue.
      const { sessions } = await api.get<{ sessions: SessionListItem[] }>(`/admin/sessions?location_id=${venue.id}&status=OPEN`);
      for (const s of sessions) await api.post(`/admin/sessions/${s.id}/close`, { reason: 'Replaced by a new demo session' });
      const now = Date.now();
      const iso = (min: number) => new Date(now + min * 60_000).toISOString();
      const res = await api.post<{ session: Session }>('/admin/sessions', {
        location_id: venue.id,
        title,
        description: 'Live demo session',
        start_at: iso(0),
        end_at: iso(120),
        checkin_opens_at: iso(-5),
        checkin_closes_at: iso(180),
        publish: true,
      });
      setSession(res.session);
      setRows([]);
      setTitle(`Food bank shift ${hhmm()}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  usePolling(
    async () => {
      if (!session) return;
      const { attendance } = await api.get<{ attendance: Row[] }>(`/admin/sessions/${session.id}/attendance`);
      setRows(attendance.slice().reverse());
    },
    3000,
    !!session,
  );

  const tz = venue?.timezone;
  const volunteers = demo?.seeded ? demo.accounts.filter((a) => a.role === 'VOLUNTEER') : [];

  return (
    <DemoPageShell
      title="Volunteer check-in"
      intro="Every venue has one printed QR code. Volunteers scan it with their phone, pick their activity, and the organiser sees them arrive instantly."
      demo={demo}
      error={signInError}
    >
      <ErrorMessage error={error} />
      <DemoStep n={1} who="Laptop" title="Create today’s session">
        {session ? (
          <p>
            Open now at <strong>{VENUE_NAME}</strong>: <strong>{session.title}</strong>.{' '}
            <span className="muted">Check-in is accepted for the next few hours.</span>
          </p>
        ) : (
          <p className="muted">No session is open at {VENUE_NAME} yet.</p>
        )}
        <div className="row">
          <input value={title} onChange={(e) => setTitle(e.target.value)} style={{ maxWidth: 320 }} aria-label="Session title" />
          <button onClick={createSession} disabled={busy || !venue || !title.trim()}>
            {session ? 'Create another session' : 'Create & open session'}
          </button>
        </div>
      </DemoStep>

      <DemoStep n={2} who="Screen" title="Put the venue QR on screen">
        {venue?.active_qr ? (
          <div className="demo-split">
            <BigQr
              src={`/api/admin/qr-codes/${venue.active_qr.id}/image?format=svg`}
              url={venue.active_qr.url}
              caption={<strong>{VENUE_NAME} — scan to check in</strong>}
            />
            <div>
              <p>This is the poster that hangs at the venue all year. It only identifies the venue — no passwords, no session details.</p>
              <p>
                <Link to={`/admin/qr/${venue.active_qr.id}/print`}>Open the printable poster</Link>
              </p>
            </div>
          </div>
        ) : (
          <p className="muted">Preparing the venue QR…</p>
        )}
      </DemoStep>

      <DemoStep n={3} who="Phone" title="Scan it and check in">
        <ol className="demo-list">
          <li>Open the phone camera and point it at the QR. Tap the link.</li>
          <li>
            On the sign-in page, tap a demo volunteer — e.g. <strong>{volunteers[0]?.name ?? 'Priya Raman'}</strong> (password <code className="mono">{demo?.seeded ? demo.password : ''}</code> if typing).
          </li>
          <li>
            The session is preselected. Tap <strong>Confirm attendance</strong>. The phone shows the activity, venue and the server’s tap-in time.
          </li>
        </ol>
      </DemoStep>

      <DemoStep n={4} who="Laptop" title="See the volunteer tracked — live">
        {!session ? (
          <p className="muted">Create a session first.</p>
        ) : (
          <>
            <div className="row" style={{ alignItems: 'baseline', gap: '1.5rem' }}>
              <div className="stat">
                <div className="value">{rows.length}</div>
                <div className="label">checked in to “{session.title}”</div>
              </div>
              <span className="small muted">Updates every 3 seconds</span>
            </div>
            {rows.length === 0 ? (
              <p className="muted" style={{ marginTop: '1rem' }}>
                Waiting for the first scan…
              </p>
            ) : (
              <table style={{ marginTop: '1rem' }}>
                <thead>
                  <tr>
                    <th>Volunteer</th>
                    <th>ID</th>
                    <th>Tap-in time</th>
                    <th>How</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.id} className={i === 0 ? 'demo-new' : undefined}>
                      <td>
                        <strong>{r.volunteer_name}</strong>
                      </td>
                      <td className="mono">{r.volunteer_code}</td>
                      <td>{formatTimeWithSeconds(r.tapped_in_at, tz)}</td>
                      <td>{r.source === 'QR' ? 'Scanned QR' : 'Added by admin'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="small" style={{ marginTop: '1rem' }}>
              Try: scan again on the phone → it shows the <em>original</em> time, no duplicate. <Link to={`/admin/sessions/${session.id}`}>Open the full session page</Link> for
              corrections and CSV export.
            </p>
          </>
        )}
      </DemoStep>
    </DemoPageShell>
  );
}
