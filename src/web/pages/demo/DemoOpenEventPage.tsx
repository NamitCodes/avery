import { useState, type FormEvent } from 'react';
import { api } from '../../api';
import { PassCard } from '../../components/PassCard';
import { BigQr, DemoPageShell, DemoStep, qrSrc, usePolling, usePresenter } from '../../components/demoKit';
import { ErrorMessage } from '../../components/ui';
import { formatTime } from '../../format';
import { newKey, SOURCE_LABEL, type AccessOutcome, type Participant, type Pass } from '../events/types';

/** Phone registers online (no account); laptop checks people in, and registers a walk-in without a phone. */
export function DemoOpenEventPage() {
  const { demo, error: signInError, ready } = usePresenter();
  const [recent, setRecent] = useState<Participant[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [walkIn, setWalkIn] = useState('');
  const [walkInPass, setWalkInPass] = useState<{ participant: Participant; pass: Pass } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const fair = demo?.seeded ? demo.events.find((e) => e.key === 'fair') : undefined;
  const registerUrl = demo?.seeded && fair ? `${demo.public_base_url}/events/${fair.id}/register` : '';

  const refresh = async () => {
    if (!fair) return;
    const [list, occ] = await Promise.all([
      api.get<{ participants: Participant[] }>(`/admin/events/${fair.id}/participants?sort=recent&page_size=8`),
      api.get<Record<string, number>>(`/admin/events/${fair.id}/occupancy`),
    ]);
    setRecent(list.participants);
    setCounts(occ);
  };
  usePolling(refresh, 3000, ready && !!fair);

  async function checkIn(p: { id: string; name: string }) {
    if (!fair) return;
    setError(null);
    try {
      const out = await api.post<AccessOutcome>(`/admin/events/${fair.id}/participants/${p.id}/manual-access`, { direction: 'IN', idempotency_key: newKey() });
      setMessage(out.result === 'ACCEPTED' ? `${p.name} checked in.` : `${p.name}: ${out.message}`);
      await refresh();
    } catch (err) {
      setError(err);
    }
  }

  async function registerWalkIn(e: FormEvent) {
    e.preventDefault();
    if (!fair || !walkIn.trim()) return;
    setError(null);
    try {
      const res = await api.post<{ participant: Participant; pass: Pass }>(`/admin/events/${fair.id}/walk-ins`, {
        name: walkIn.trim(),
        contact_unavailable: true,
        confirm_new: true,
      });
      setWalkInPass(res);
      setWalkIn('');
      await refresh();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <DemoPageShell
      title="Surprise visits — register online or just walk in"
      intro="Anyone can register in advance from their phone, without creating an account. People who just turn up are registered at the desk — even without a phone. Every admitted person gets a check-in record."
      demo={demo}
      error={signInError}
    >
      <ErrorMessage error={error} />
      {message && <div className="alert alert-ok">{message}</div>}

      <DemoStep n={1} who="Screen" title="Show the registration QR">
        <div className="demo-split">
          {registerUrl && <BigQr src={qrSrc(registerUrl)} url={registerUrl} caption={<strong>Science of the Soul, Amber Road — register</strong>} />}
          <p>This is what goes on the flyer or the event website.</p>
        </div>
      </DemoStep>

      <DemoStep n={2} who="Phone" title="Register as a visitor">
        <ol className="demo-list">
          <li>Scan the QR with the phone camera and tap the link.</li>
          <li>Enter a name and a phone number (or email). No account, no password.</li>
          <li>The phone shows a pass with a QR code and a registration reference.</li>
        </ol>
      </DemoStep>

      <DemoStep n={3} who="Laptop" title="Check people in at the door">
        <div className="row" style={{ gap: '1rem' }}>
          <div className="stat">
            <div className="value">{counts.total_participants ?? '—'}</div>
            <div className="label">registered</div>
          </div>
          <div className="stat">
            <div className="value">{counts.checked_in_unique ?? '—'}</div>
            <div className="label">checked in</div>
          </div>
          <div className="stat">
            <div className="value">
              {counts.source_online ?? 0} / {counts.source_walk_in ?? 0}
            </div>
            <div className="label">online / walk-in</div>
          </div>
        </div>
        <h3>Latest registrations</h3>
        <table>
          <tbody>
            {recent.map((p, i) => (
              <tr key={p.id} className={i === 0 ? 'demo-new' : undefined}>
                <td>
                  <strong>{p.name}</strong>
                  <div className="small muted">
                    {SOURCE_LABEL[p.registration_source]} · {p.registration_reference}
                  </div>
                </td>
                <td>{formatTime(p.registered_at)}</td>
                <td className="right">
                  {p.checked_in_at ? (
                    <span>Checked in {formatTime(p.checked_in_at)}</span>
                  ) : (
                    <button className="btn-sm" onClick={() => checkIn(p)}>
                      Check in
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted">Press “Check in” for the person who just registered on the phone. Pressing it twice never counts them twice.</p>
      </DemoStep>

      <DemoStep n={4} who="Laptop" title="Someone walks in without a phone">
        <form className="row" onSubmit={registerWalkIn}>
          <input placeholder="Visitor’s name, e.g. Mdm Wong" value={walkIn} onChange={(e) => setWalkIn(e.target.value)} style={{ maxWidth: 300 }} />
          <button disabled={!walkIn.trim()}>Register walk-in</button>
        </form>
        {walkInPass && (
          <div className="demo-split" style={{ marginTop: '1rem' }}>
            <PassCard pass={walkInPass.pass} />
            <div>
              <p>The desk prints this paper pass. No email or phone was needed.</p>
              <button onClick={() => checkIn(walkInPass.participant)}>Check {walkInPass.participant.name} in</button>
            </div>
          </div>
        )}
      </DemoStep>
    </DemoPageShell>
  );
}
