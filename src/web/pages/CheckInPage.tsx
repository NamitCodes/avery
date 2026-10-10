import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { formatDate, formatRange, formatTime, formatTimeWithSeconds } from '../format';
import { Button } from '../components/fui';

interface VenueSession {
  id: string;
  title: string;
  description: string;
  start_at: string;
  end_at: string;
  already_checked_in_at: string | null;
}
interface VenueResponse {
  venue: { name: string; address: string; timezone: string };
  sessions: VenueSession[];
  message?: string;
}
interface CheckInResponse {
  status: 'CHECKED_IN' | 'ALREADY_CHECKED_IN';
  attendance: { id: string; tapped_in_at: string };
  session: { title: string; start_at: string; end_at: string };
  venue: { name: string; timezone: string };
}

type Step =
  | { kind: 'loading' }
  | { kind: 'error'; error: ApiError }
  | { kind: 'choose' }
  | { kind: 'confirm'; session: VenueSession }
  | { kind: 'submitting'; session: VenueSession }
  | { kind: 'failed'; session: VenueSession; error: ApiError }
  | { kind: 'done'; result: CheckInResponse };

/**
 * Venue QR landing page. Success is shown ONLY after the server confirms the
 * record; on network failure we say plainly that attendance was not confirmed.
 */
export function CheckInPage() {
  const { venueId = '' } = useParams();
  const [data, setData] = useState<VenueResponse | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStep({ kind: 'loading' });
    try {
      const res = await api.get<VenueResponse>(`/check-in/venues/${encodeURIComponent(venueId)}`);
      setData(res);
      if (res.sessions.length === 1) {
        setSelected(res.sessions[0].id);
        setStep({ kind: 'confirm', session: res.sessions[0] });
      } else setStep({ kind: 'choose' });
    } catch (err) {
      setStep({ kind: 'error', error: err as ApiError });
    }
  }, [venueId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirm(session: VenueSession) {
    setStep({ kind: 'submitting', session });
    try {
      // Retrying is safe: the server returns the existing record instead of duplicating it.
      const result = await api.post<CheckInResponse>('/check-in', { venue_id: venueId, session_id: session.id });
      setStep({ kind: 'done', result });
    } catch (err) {
      setStep({ kind: 'failed', session, error: err as ApiError });
    }
  }

  const tz = data?.venue.timezone;

  if (step.kind === 'loading') return <p className="muted">Loading venue…</p>;
  if (step.kind === 'error') {
    return (
      <>
        <h1>Can’t check in here</h1>
        <div className="alert alert-error">{step.error.message}</div>
        {step.error.isNetwork && (
          <Button variant="subtle" onClick={load}>
            Try again
          </Button>
        )}
      </>
    );
  }

  if (step.kind === 'done') {
    const r = step.result;
    return (
      <>
        <p className="muted small">{r.status === 'ALREADY_CHECKED_IN' ? 'Already recorded' : 'Recorded'}</p>
        <h1>You’re checked in</h1>
        <dl className="kv card">
          <dt>Activity</dt>
          <dd>{r.session.title}</dd>
          <dt>Date</dt>
          <dd>{formatDate(r.session.start_at, r.venue.timezone)}</dd>
          <dt>Venue</dt>
          <dd>{r.venue.name}</dd>
          <dt>Tap-in time</dt>
          <dd>{formatTimeWithSeconds(r.attendance.tapped_in_at, r.venue.timezone)}</dd>
        </dl>
        {r.status === 'ALREADY_CHECKED_IN' && (
          <p className="muted small" style={{ marginTop: '1rem' }}>
            You had already checked in to this activity; your original tap-in time is shown.
          </p>
        )}
        <p style={{ marginTop: '1.5rem' }}>
          <Link to="/me/attendance">View my attendance</Link>
        </p>
      </>
    );
  }

  const venueHeader = (
    <>
      <p className="muted small">{data?.venue.address}</p>
      <h1>{data?.venue.name}</h1>
    </>
  );

  if (!data || data.sessions.length === 0) {
    return (
      <>
        {venueHeader}
        <div className="alert">There are no activities currently accepting attendance at this venue.</div>
        <Button variant="subtle" onClick={load}>
          Refresh
        </Button>
      </>
    );
  }

  if (step.kind === 'choose') {
    return (
      <>
        {venueHeader}
        <p>Choose the activity you are attending:</p>
        {data.sessions.map((s) => (
          <button key={s.id} type="button" className={`choice ${selected === s.id ? 'selected' : ''}`} onClick={() => setSelected(s.id)}>
            <strong>{s.title}</strong>
            <div className="small muted">
              {data.venue.name} · {formatRange(s.start_at, s.end_at, tz)}
            </div>
            {s.description && <div className="small">{s.description}</div>}
            {s.already_checked_in_at && <div className="small">Checked in at {formatTime(s.already_checked_in_at, tz)}</div>}
          </button>
        ))}
        <Button variant="solid" size="lg"
          className="w-full"
          style={{ marginTop: '1rem' }}
          disabled={!selected}
          onClick={() => setStep({ kind: 'confirm', session: data.sessions.find((s) => s.id === selected)! })}
        >
          Continue
        </Button>
      </>
    );
  }

  const session = step.session;
  return (
    <>
      {venueHeader}
      <div className="card">
        <p className="muted small">You are checking in to</p>
        <h2 style={{ margin: '0 0 0.25rem' }}>{session.title}</h2>
        <p className="small">
          {data.venue.name} · {formatRange(session.start_at, session.end_at, tz)}
        </p>
        {session.description && <p className="small muted">{session.description}</p>}
      </div>

      {step.kind === 'failed' && (
        <div className="alert alert-error" style={{ marginTop: '1rem' }} role="alert">
          {step.error.isNetwork ? (
            <>
              <strong>Attendance not confirmed.</strong> We couldn’t reach the server, so we can’t confirm your check-in. Try again — it
              won’t create a duplicate. If it keeps failing, ask an organiser to record your attendance.
            </>
          ) : (
            step.error.message
          )}
        </div>
      )}

      <Button variant="solid" size="lg" className="w-full" style={{ marginTop: '1rem' }} disabled={step.kind === 'submitting'} onClick={() => confirm(session)}>
        {step.kind === 'submitting' ? 'Confirming…' : step.kind === 'failed' && step.error.isNetwork ? 'Try again' : 'Confirm attendance'}
      </Button>
      {data.sessions.length > 1 && step.kind !== 'submitting' && (
        <Button variant="ghost" style={{ marginTop: '1rem' }} onClick={() => setStep({ kind: 'choose' })}>
          Choose a different activity
        </Button>
      )}
    </>
  );
}
