import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api';
import { PassCard } from '../../components/PassCard';
import { ErrorMessage, useLoad } from '../../components/ui';
import { formatRange } from '../../format';
import type { Pass } from '../events/types';

interface PublicEvent {
  event: {
    id: string;
    name: string;
    description: string;
    venue: string;
    timezone: string;
    starts_at: string;
    ends_at: string;
    contact_requirement: 'NONE' | 'EMAIL' | 'PHONE' | 'EMAIL_OR_PHONE';
    verification_policy: string;
    id_check_mode: string;
  };
  registration: { open: boolean; capacity_reached: boolean; reason: string | null };
}
interface RegisterResponse {
  existing: boolean;
  message?: string;
  registration?: { id: string; registration_reference: string; name: string };
  contact_verification_required?: boolean;
  verification?: { sent_to?: string; error?: string } | null;
  pass?: Pass | null;
}

const CLOSED_REASON: Record<string, string> = {
  EVENT_NOT_ACTIVE: 'Registration for this event is not open.',
  REGISTRATION_DISABLED: 'Online registration is not available for this event. You may be able to register at the venue.',
  CAPACITY_REACHED: 'This event is full. Registration is paused.',
};

/** Public advance registration. No account required. */
export function PublicRegistrationPage() {
  const { eventId = '' } = useParams();
  const info = useLoad(() => api.get<PublicEvent>(`/public/events/${eventId}`), [eventId]);
  const [form, setForm] = useState({ name: '', email: '', phone: '', country: '' });
  const [result, setResult] = useState<RegisterResponse | null>(null);
  const [code, setCode] = useState('');
  const [verified, setVerified] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (info.error) return <ErrorMessage error={info.error} />;
  if (!info.data) return <p className="muted">Loading…</p>;
  const { event: e, registration } = info.data;
  const needEmail = e.contact_requirement === 'EMAIL';
  const needPhone = e.contact_requirement === 'PHONE';

  async function submit(evt: FormEvent) {
    evt.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api.post<RegisterResponse>(`/public/events/${eventId}/registrations`, {
          name: form.name,
          email: form.email || null,
          phone: form.phone || null,
          country: form.country || null,
        }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function verify(action: 'start' | 'confirm') {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ message?: string; sent_to?: string }>(`/public/event-registrations/${result!.registration!.id}/verify-contact`, {
        action,
        code: action === 'confirm' ? code : undefined,
      });
      if (action === 'confirm') setVerified(res.message ?? 'Verified.');
      else setResult({ ...result!, verification: { sent_to: res.sent_to } });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <>
      <p className="muted small">{formatRange(e.starts_at, e.ends_at, e.timezone)}</p>
      <h1>{e.name}</h1>
      {e.venue && <p className="muted">{e.venue}</p>}
      {e.description && <p>{e.description}</p>}
    </>
  );

  if (result?.existing) {
    return (
      <>
        {header}
        <div className="alert">{result.message}</div>
      </>
    );
  }

  if (result?.registration) {
    return (
      <>
        {header}
        <div className="alert alert-ok">
          You’re registered. Your reference is <strong className="mono">{result.registration.registration_reference}</strong>.
        </div>
        {result.contact_verification_required && !verified && (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Confirm your email</h2>
            <p className="small">
              {result.verification?.sent_to ? `We sent a 6-digit code to ${result.verification.sent_to}.` : result.verification?.error}
              {' '}Your pass will be emailed after you confirm. This confirms you can access the email address; it is not an identity check.
            </p>
            <div className="row">
              <input inputMode="numeric" maxLength={6} placeholder="123456" value={code} onChange={(evt) => setCode(evt.target.value)} style={{ width: 140 }} />
              <button disabled={busy || code.length !== 6} onClick={() => verify('confirm')}>
                Confirm
              </button>
              <button className="btn-link" disabled={busy} onClick={() => verify('start')}>
                Resend code
              </button>
            </div>
            <ErrorMessage error={error} />
          </div>
        )}
        {verified && <div className="alert alert-ok">{verified}</div>}
        {result.pass && (
          <>
            <p>Print this pass and bring it to the event. {form.email ? 'We have also emailed it to you.' : ''}</p>
            <PassCard pass={result.pass} />
            <div className="actions no-print" style={{ justifyContent: 'center' }}>
              <button onClick={() => window.print()}>Print pass</button>
            </div>
          </>
        )}
        {e.id_check_mode === 'MANDATORY' && <p className="small muted">Bring photo ID: it will be checked at the entrance.</p>}
      </>
    );
  }

  return (
    <>
      {header}
      {!registration.open ? (
        <div className="alert">{CLOSED_REASON[registration.reason ?? ''] ?? 'Registration is closed.'}</div>
      ) : (
        <form onSubmit={submit}>
          <label>
            Full name <span className="required">*</span>
            <input autoComplete="name" value={form.name} onChange={(evt) => setForm({ ...form, name: evt.target.value })} required />
          </label>
          {e.contact_requirement !== 'PHONE' && (
            <label>
              Email {needEmail && <span className="required">*</span>}
              <input type="email" autoComplete="email" value={form.email} onChange={(evt) => setForm({ ...form, email: evt.target.value })} required={needEmail} />
            </label>
          )}
          {e.contact_requirement !== 'EMAIL' && (
            <label>
              Phone {needPhone && <span className="required">*</span>}
              <input type="tel" autoComplete="tel" value={form.phone} onChange={(evt) => setForm({ ...form, phone: evt.target.value })} required={needPhone} />
            </label>
          )}
          {e.contact_requirement === 'EMAIL_OR_PHONE' && <p className="small muted">Please give an email address or a phone number.</p>}
          <label>
            Country <span className="muted">(optional)</span>
            <input autoComplete="country-name" value={form.country} onChange={(evt) => setForm({ ...form, country: evt.target.value })} />
          </label>
          <p className="small muted">We only use these details to manage your registration and admission for this event.</p>
          <ErrorMessage error={error} />
          <button className="btn-block" disabled={busy}>
            {busy ? 'Registering…' : 'Register'}
          </button>
        </form>
      )}
    </>
  );
}
