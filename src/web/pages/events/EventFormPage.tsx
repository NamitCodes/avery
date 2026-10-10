import { useState, type FormEvent } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { api } from '../../api';
import { ErrorMessage, ReasonDialog } from '../../components/ui';
import { toLocalInput } from '../../format';
import { TIMEZONES } from '../admin/LocationsPage';
import type { EventContext } from './EventLayout';
import { POLICY_LABEL, type EventRecord } from './types';

const NEXT_STATUS: Record<string, { status: string; label: string }[]> = {
  DRAFT: [{ status: 'ACTIVE', label: 'Activate (open registration & scanning)' }],
  ACTIVE: [{ status: 'CLOSED', label: 'Close event' }],
  CLOSED: [
    { status: 'ACTIVE', label: 'Reactivate' },
    { status: 'ARCHIVED', label: 'Archive' },
  ],
  ARCHIVED: [],
};

/** Create an event, or edit its policy (rendered under /admin/events/:id/settings). */
export function EventFormPage() {
  const ctx = useOutletContext<EventContext | undefined>();
  const existing = ctx?.event;
  const navigate = useNavigate();
  const tz0 = existing?.timezone ?? 'Asia/Singapore';
  const [f, setF] = useState({
    name: existing?.name ?? '',
    description: existing?.description ?? '',
    venue_text: existing?.venue_text ?? '',
    timezone: tz0,
    starts_at: existing ? toLocalInput(existing.starts_at, tz0) : '',
    ends_at: existing ? toLocalInput(existing.ends_at, tz0) : '',
    capacity: existing?.capacity?.toString() ?? '',
    advance_registration_enabled: existing?.advance_registration_enabled ?? false,
    walk_ins_enabled: existing?.walk_ins_enabled ?? false,
    pause_registration_at_capacity: existing?.pause_registration_at_capacity ?? false,
    reentry_enabled: existing?.reentry_enabled ?? true,
    print_badges: existing?.print_badges ?? true,
    contact_requirement: existing?.contact_requirement ?? 'EMAIL',
    verification_policy: existing?.verification_policy ?? 'BASIC_REGISTRATION',
    id_check_mode: existing?.id_check_mode ?? 'NOT_USED',
    instructions: existing?.instructions ?? '',
  });
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusChange, setStatusChange] = useState<string | null>(null);
  const [redact, setRedact] = useState(false);

  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });
  const text = (k: keyof typeof f) => (e: { target: { value: string } }) => set(k, e.target.value as never);
  const check = (k: keyof typeof f) => (e: { target: { checked: boolean } }) => set(k, e.target.checked as never);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const body = { ...f, capacity: f.capacity ? Number(f.capacity) : null, id_check_mode: f.verification_policy === 'IN_PERSON_ID_CHECK' ? 'MANDATORY' : f.id_check_mode };
    try {
      if (existing) {
        await api.patch(`/admin/events/${existing.id}`, body);
        await ctx!.reload();
        setSaved(true);
      } else {
        const res = await api.post<{ event: EventRecord }>('/admin/events', body);
        navigate(`/admin/events/${res.event.id}`);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const locked = existing?.status === 'ARCHIVED';
  return (
    <div style={{ maxWidth: 720 }}>
      {!existing && <h1>New event</h1>}
      {existing && (
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <div className="spread">
            <div>
              <strong>Status: {existing.status}</strong>
              <p className="small muted" style={{ margin: 0 }}>
                Gates and public registration only work while the event is ACTIVE.
              </p>
            </div>
            <div className="row">
              {NEXT_STATUS[existing.status].map((s) => (
                <button key={s.status} className="btn-secondary" onClick={() => setStatusChange(s.status)}>
                  {s.label}
                </button>
              ))}
              {existing.status === 'ARCHIVED' && !existing.redacted_at && (
                <button className="btn-danger" onClick={() => setRedact(true)}>
                  Redact personal data
                </button>
              )}
            </div>
          </div>
          {existing.advance_registration_enabled && existing.status === 'ACTIVE' && (
            <p className="small" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
              Public registration link: <a href={`/events/${existing.id}/register`}>{`${location.origin}/events/${existing.id}/register`}</a>
            </p>
          )}
        </div>
      )}
      <form onSubmit={submit}>
        <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0 }}>
          <label>
            Event name
            <input value={f.name} onChange={text('name')} required />
          </label>
          <label>
            Description
            <textarea rows={2} value={f.description} onChange={text('description')} />
          </label>
          <div className="form-grid">
            <label>
              Venue
              <input value={f.venue_text} onChange={text('venue_text')} />
            </label>
            <label>
              Time zone
              <select value={f.timezone} onChange={text('timezone')}>
                {TIMEZONES.map((tz) => (
                  <option key={tz}>{tz}</option>
                ))}
              </select>
            </label>
            <label>
              Starts
              <input type="datetime-local" value={f.starts_at} onChange={text('starts_at')} required />
            </label>
            <label>
              Ends
              <input type="datetime-local" value={f.ends_at} onChange={text('ends_at')} required />
            </label>
            <label>
              Capacity <span className="muted">(optional)</span>
              <input type="number" min={1} value={f.capacity} onChange={text('capacity')} />
            </label>
          </div>

          <h2>Admission</h2>
          <label className="check">
            <input type="checkbox" checked={f.reentry_enabled} onChange={check('reentry_enabled')} />
            Track entry and exit (attendees may leave and re-enter)
          </label>
          <label className="check">
            <input type="checkbox" checked={f.advance_registration_enabled} onChange={check('advance_registration_enabled')} />
            Allow online advance registration (public link)
          </label>
          <label className="check">
            <input type="checkbox" checked={f.walk_ins_enabled} onChange={check('walk_ins_enabled')} />
            Allow walk-in registration at the desk
          </label>
          <label className="check">
            <input type="checkbox" checked={f.pause_registration_at_capacity} onChange={check('pause_registration_at_capacity')} />
            Pause registration when capacity is reached
          </label>
          <label className="check">
            <input type="checkbox" checked={f.print_badges} onChange={check('print_badges')} />
            Print badges / paper passes at the desk
          </label>

          <h2>Identity assurance</h2>
          <div className="form-grid">
            <label>
              Verification policy
              <select value={f.verification_policy} onChange={text('verification_policy')}>
                {Object.entries(POLICY_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Photo ID checks
              <select
                value={f.verification_policy === 'IN_PERSON_ID_CHECK' ? 'MANDATORY' : f.id_check_mode}
                disabled={f.verification_policy === 'IN_PERSON_ID_CHECK'}
                onChange={text('id_check_mode')}
              >
                <option value="NOT_USED">Not used</option>
                <option value="CONDITIONAL">Conditional (staff discretion)</option>
                <option value="MANDATORY">Mandatory</option>
              </select>
            </label>
            <label>
              Contact details required
              <select value={f.contact_requirement} onChange={text('contact_requirement')}>
                <option value="NONE">None (name only)</option>
                <option value="EMAIL">Email</option>
                <option value="PHONE">Phone</option>
                <option value="EMAIL_OR_PHONE">Email or phone</option>
              </select>
            </label>
          </div>
          <p className="small muted">
            Contact verification proves access to an email address, not legal identity. Walk-ins without a phone or email can be registered by desk staff
            using the documented “no contact details” fallback.
          </p>
          <label>
            Instructions printed on passes
            <textarea rows={2} value={f.instructions} onChange={text('instructions')} />
          </label>
          <ErrorMessage error={error} />
          {saved && <div className="alert alert-ok">Saved.</div>}
          <div className="actions">
            <button disabled={busy}>{existing ? 'Save settings' : 'Create event'}</button>
          </div>
        </fieldset>
      </form>
      {statusChange && existing && (
        <ReasonDialog
          title={`Change status to ${statusChange}`}
          confirmLabel="Confirm"
          optional
          onClose={() => setStatusChange(null)}
          onConfirm={async (reason) => {
            await api.patch(`/admin/events/${existing.id}`, { status: statusChange, reason: reason || undefined });
            await ctx!.reload();
          }}
        />
      )}
      {redact && existing && (
        <ReasonDialog
          title="Redact personal data"
          danger
          confirmLabel="Redact permanently"
          description={<p>Names, emails and phone numbers of all participants will be irreversibly removed. Counts and anonymised history are kept.</p>}
          onClose={() => setRedact(false)}
          onConfirm={async (reason) => {
            await api.post(`/admin/events/${existing.id}/redact`, { reason });
            await ctx!.reload();
          }}
        />
      )}
    </div>
  );
}
