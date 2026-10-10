import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, qs } from '../../api';
import { PassCard } from '../../components/PassCard';
import { ErrorMessage, StatusBadge, useLoad } from '../../components/ui';
import { newKey, POLICY_LABEL, stateLabel, type AccessOutcome, type EventRecord, type Participant, type Pass } from '../events/types';

interface Candidate {
  id: string;
  name: string;
  country: string;
  registration_reference: string;
  email: string | null;
  phone: string | null;
  checked_in_at: string | null;
  match: string[];
}

const emptyWalkIn = { name: '', email: '', phone: '', country: '', contact_unavailable: false, send_email: false };

/** Exception desk / walk-in station: search first, then register only if no match. */
export function DeskPage() {
  const { eventId = '' } = useParams();
  const ev = useLoad(() => api.get<{ event: EventRecord }>(`/admin/events/${eventId}`), [eventId]);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const results = useLoad(
    () => (query ? api.get<{ participants: Participant[] }>(`/admin/events/${eventId}/participants${qs({ q: query, page_size: '20' })}`) : Promise.resolve(null)),
    [eventId, query],
  );
  const [walkIn, setWalkIn] = useState(emptyWalkIn);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [created, setCreated] = useState<{ participant: Participant; pass: Pass } | null>(null);
  const [outcome, setOutcome] = useState<AccessOutcome | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (ev.error) return <ErrorMessage error={ev.error} />;
  if (!ev.data) return <p className="muted">Loading…</p>;
  const e = ev.data.event;

  async function checkIn(participantId: string) {
    setError(null);
    setOutcome(null);
    try {
      setOutcome(await api.post<AccessOutcome>(`/admin/events/${eventId}/participants/${participantId}/manual-access`, { direction: 'IN', idempotency_key: newKey() }));
      await results.reload();
    } catch (err) {
      setError(err);
    }
  }

  async function register(evt: FormEvent | null, confirmNew = false) {
    evt?.preventDefault();
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const res = await api.post<{ participant: Participant; pass: Pass }>(`/admin/events/${eventId}/walk-ins`, {
        name: walkIn.name,
        email: walkIn.email || null,
        phone: walkIn.phone || null,
        country: walkIn.country || null,
        contact_unavailable: walkIn.contact_unavailable,
        send_email: walkIn.send_email,
        confirm_new: confirmNew,
      });
      setCreated(res);
      setCandidates(null);
      setWalkIn(emptyWalkIn);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'POSSIBLE_DUPLICATES') setCandidates(err.details.candidates as Candidate[]);
      else setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="small muted">
        <Link to="/staff">Stations</Link> /
      </p>
      <h1>{e.name} — exception desk</h1>
      <p className="small muted">
        Policy: {POLICY_LABEL[e.verification_policy]} · photo ID {e.id_check_mode.toLowerCase().replace('_', ' ')} ·{' '}
        {e.reentry_enabled ? 'entry/exit tracking' : 'single check-in'} · walk-ins {e.walk_ins_enabled ? 'allowed' : 'not allowed'}
      </p>

      {outcome && (
        <div className={`alert ${outcome.result === 'ACCEPTED' ? 'alert-ok' : 'alert-error'}`}>
          <strong>{outcome.result === 'ACCEPTED' ? 'Accepted' : 'Not admitted'}</strong>
          {outcome.participant && ` — ${outcome.participant.name}`}: {outcome.message}
        </div>
      )}
      <ErrorMessage error={error} />

      <h2>1. Search existing registrations</h2>
      <form
        className="row"
        onSubmit={(evt) => {
          evt.preventDefault();
          setQuery(q.trim());
        }}
      >
        <input style={{ flex: 1, minWidth: 220 }} placeholder="Reference, name, email or phone" value={q} onChange={(evt) => setQ(evt.target.value)} autoFocus />
        <button>Search</button>
      </form>
      {results.data && results.data.participants.length === 0 && <p className="muted" style={{ marginTop: '0.75rem' }}>No matches.</p>}
      {results.data && results.data.participants.length > 0 && (
        <div className="table-wrap" style={{ marginTop: '0.75rem' }}>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Reference</th>
                <th>Contact</th>
                <th>Verification</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {results.data.participants.map((p) => (
                <tr key={p.id} className={p.status !== 'ACTIVE' ? 'dim' : undefined}>
                  <td>
                    {p.name}
                    <div className="small muted">{p.country}</div>
                  </td>
                  <td className="mono">{p.registration_reference}</td>
                  <td className="small">
                    {p.email}
                    {p.phone && <div>{p.phone}</div>}
                  </td>
                  <td className="small">
                    {p.contact_verification !== 'NOT_REQUIRED' && (
                      <div>
                        Contact <StatusBadge status={p.contact_verification} />
                      </div>
                    )}
                    {p.id_check !== 'NOT_REQUIRED' && (
                      <div>
                        ID <StatusBadge status={p.id_check} />
                      </div>
                    )}
                  </td>
                  <td>{stateLabel(p, e.reentry_enabled)}</td>
                  <td>
                    <div className="row">
                      <Link className="btn btn-secondary btn-sm" to={`/admin/events/${eventId}/participants/${p.id}`}>
                        Open
                      </Link>
                      {!p.checked_in_at || (e.reentry_enabled && p.current_access_state === 'OUTSIDE') ? (
                        <button className="btn-sm" onClick={() => checkIn(p.id)}>
                          {e.reentry_enabled ? 'Admit' : 'Check in'}
                        </button>
                      ) : null}
                      {p.active_credential_id && (
                        <Link className="btn btn-secondary btn-sm" to={`/admin/event-passes/${p.active_credential_id}/print`}>
                          Reprint
                        </Link>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted" style={{ marginTop: '0.75rem' }}>
        Lost or damaged pass: open the registration, verify the person’s identity using the approved procedure, then use “Replace”.
      </p>

      <h2>2. Register a walk-in</h2>
      {!e.walk_ins_enabled ? (
        <div className="alert alert-warn">Walk-in registration is not enabled for this event. Escalate to a supervisor; do not admit unregistered people.</div>
      ) : created ? (
        <div>
          <div className="alert alert-ok">
            Registered {created.participant.name} ({created.participant.registration_reference}).
          </div>
          <PassCard pass={created.pass} />
          <div className="actions no-print" style={{ justifyContent: 'center' }}>
            <button className="btn-secondary" onClick={() => window.print()}>
              Print pass
            </button>
            <button onClick={() => checkIn(created.participant.id)}>{e.reentry_enabled ? 'Admit now' : 'Check in now'}</button>
            <button className="btn-secondary" onClick={() => { setCreated(null); setOutcome(null); }}>
              Next walk-in
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={(evt) => register(evt)} style={{ maxWidth: 640 }}>
          <div className="form-grid">
            <label>
              Name <span className="required">*</span>
              <input value={walkIn.name} onChange={(evt) => setWalkIn({ ...walkIn, name: evt.target.value })} required />
            </label>
            <label>
              Country
              <input value={walkIn.country} onChange={(evt) => setWalkIn({ ...walkIn, country: evt.target.value })} />
            </label>
            <label>
              Email
              <input type="email" value={walkIn.email} onChange={(evt) => setWalkIn({ ...walkIn, email: evt.target.value })} />
            </label>
            <label>
              Phone
              <input type="tel" value={walkIn.phone} onChange={(evt) => setWalkIn({ ...walkIn, phone: evt.target.value })} />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={walkIn.contact_unavailable} onChange={(evt) => setWalkIn({ ...walkIn, contact_unavailable: evt.target.checked })} />
            Attendee has no email or phone (recorded in the audit log)
          </label>
          <label className="check">
            <input type="checkbox" checked={walkIn.send_email} onChange={(evt) => setWalkIn({ ...walkIn, send_email: evt.target.checked })} />
            Also email the pass
          </label>
          {candidates && (
            <div className="alert alert-warn">
              <strong>Possible existing registrations</strong> — check with the attendee before creating a new one.
              <table style={{ marginTop: '0.5rem' }}>
                <tbody>
                  {candidates.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.name}
                        <div className="small muted">
                          {c.country} · matched on {c.match.join(', ').toLowerCase()}
                        </div>
                      </td>
                      <td className="mono">{c.registration_reference}</td>
                      <td className="small">{c.email ?? c.phone}</td>
                      <td>
                        <Link className="btn btn-secondary btn-sm" to={`/admin/events/${eventId}/participants/${c.id}`}>
                          Use this
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="actions">
                <button type="button" className="btn-secondary" onClick={() => setCandidates(null)}>
                  Cancel
                </button>
                <button type="button" disabled={busy} onClick={() => register(null, true)}>
                  None of these — create new
                </button>
              </div>
            </div>
          )}
          {!candidates && <button disabled={busy}>{busy ? 'Checking…' : 'Search & register'}</button>}
        </form>
      )}
    </>
  );
}
