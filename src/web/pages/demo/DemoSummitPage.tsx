import { useState } from 'react';
import { api } from '../../api';
import { PassCard } from '../../components/PassCard';
import { BigQr, DemoPageShell, DemoStep, qrSrc, usePolling, usePresenter } from '../../components/demoKit';
import { ErrorMessage, StatusBadge } from '../../components/ui';
import { formatTimeWithSeconds } from '../../format';
import type { Participant, Pass } from '../events/types';

interface AccessRow {
  id: string;
  participant_name: string | null;
  event_type: string;
  result: string;
  reject_code: string | null;
  gate_name: string | null;
  occurred_at: string;
}

const COUNTRIES = ['Kenya', 'Brazil', 'Japan', 'Germany', 'India', 'Mexico', 'Ghana', 'France', 'Vietnam', 'Canada'];
const csvField = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const toBase64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/** Laptop issues a pass; a phone acting as the gate scans it; the laptop shows occupancy change. */
export function DemoSummitPage() {
  const { demo, error: signInError, ready } = usePresenter();
  const [name, setName] = useState('');
  const [country, setCountry] = useState(COUNTRIES[0]);
  const [guest, setGuest] = useState<{ participant: Participant; pass: Pass } | null>(null);
  const [inside, setInside] = useState<number | null>(null);
  const [log, setLog] = useState<AccessRow[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const summit = demo?.seeded ? demo.events.find((e) => e.key === 'summit') : undefined;
  const base = demo?.seeded ? demo.public_base_url : '';

  /** Same path as a real import, just one row: participant + printable pass. */
  async function createGuest() {
    if (!summit) return;
    setBusy(true);
    setError(null);
    try {
      const display = name.trim() || `Demo Guest ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      const email = `guest.${Date.now()}@summit.example`;
      const csv = `Name,Country,Email\n${csvField(display)},${csvField(country)},${email}\n`;
      await api.post(`/admin/events/${summit.id}/participants/import/commit`, { file_base64: toBase64(csv), filename: 'demo-guest.csv' });
      const { participants } = await api.get<{ participants: Participant[] }>(`/admin/events/${summit.id}/participants?q=${encodeURIComponent(email)}`);
      const p = participants[0];
      const issued = await api.post<{ credential: { id: string } }>(`/admin/events/${summit.id}/participants/${p.id}/credentials`, {});
      const { pass } = await api.get<{ pass: Pass }>(`/admin/event-credentials/${issued.credential.id}/pass`);
      setGuest({ participant: p, pass });
      setName('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  usePolling(
    async () => {
      if (!summit) return;
      const [occ, acc] = await Promise.all([
        api.get<{ inside: number }>(`/admin/events/${summit.id}/occupancy`),
        api.get<{ access_events: AccessRow[] }>(`/admin/events/${summit.id}/access-events?limit=6`),
      ]);
      setInside(occ.inside);
      setLog(acc.access_events);
      if (guest) {
        const { participants } = await api.get<{ participants: Participant[] }>(
          `/admin/events/${summit.id}/participants?q=${encodeURIComponent(guest.participant.registration_reference)}`,
        );
        if (participants[0]) setGuest((g) => (g ? { ...g, participant: participants[0] } : g));
      }
    },
    3000,
    ready && !!summit,
  );

  const signInUrl = `${base}/demo/signin/desk?next=${encodeURIComponent('/demo/phone')}`;
  const oldPass = demo?.seeded ? demo.passes.find((p) => p.key === 'sofia-old') : undefined;

  return (
    <DemoPageShell
      title="Planned visits — printed passes at the gate"
      intro="Visitors are registered in advance and receive a printable pass. Gate staff scan it at the participant or event-volunteer gates, on the way in and out. The system always knows who is inside."
      demo={demo}
      error={signInError}
    >
      <ErrorMessage error={error} />
      <DemoStep n={1} who="Phone" title="Turn the phone into a gate scanner">
        <div className="demo-split">
          <BigQr src={qrSrc(signInUrl)} url={signInUrl} caption={<strong>Scan to sign this phone in as gate staff</strong>} />
          <p>
            Scan this once with the phone camera. It signs the phone in as <strong>Dana (gate staff)</strong>. In real life staff sign in with their own accounts on a
            scanning device.
          </p>
        </div>
      </DemoStep>

      <DemoStep n={2} who="Laptop" title="Add a participant and print their pass">
        <p className="muted small">Normally a list of thousands is imported from a spreadsheet and passes are emailed. Here we add one person the same way.</p>
        <div className="row">
          <input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 260 }} />
          <select value={country} onChange={(e) => setCountry(e.target.value)} style={{ maxWidth: 180 }}>
            {COUNTRIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <button onClick={createGuest} disabled={busy || !ready}>
            {busy ? 'Creating…' : guest ? 'Create another participant' : 'Create participant & pass'}
          </button>
        </div>
      </DemoStep>

      {guest && (
        <DemoStep n={3} who="Screen" title="This is the printed pass">
          <div className="demo-split">
            <PassCard pass={guest.pass} />
            <div>
              <p>The QR holds only a random code — no name, email or country. No phone or app is needed by the participant.</p>
              <p>
                <strong>Phone:</strong> point the camera at the pass QR and tap the link. Then tap <strong>Participant entry</strong>.
              </p>
              <p className="small muted">
                Then try: tap Participant entry again → <strong>STOP, already inside</strong>. Tap <strong>Participant exit</strong> → exit recorded. Participant entry again → re-entry
                with the same pass.
              </p>
            </div>
          </div>
        </DemoStep>
      )}

      {oldPass && (
        <DemoStep n={guest ? 4 : 3} who="Screen" title="Try an old pass — entry denied">
          <div className="demo-split">
            <BigQr src={oldPass.qr_data_url} url={oldPass.pass_url} caption={<strong>Old pass — replaced after it was reported lost</strong>} />
            <div>
              <p>
                <strong>Phone:</strong> scan this QR and tap <strong>Participant entry</strong>. The gate shows a red <strong>STOP</strong>: this pass was revoked when
                a replacement was issued, so it no longer opens any gate.
              </p>
              <p className="small muted">The same happens for a photocopied or shared pass after it is replaced, a pass for a different event, or any QR that isn’t a pass.</p>
            </div>
          </div>
        </DemoStep>
      )}

      <DemoStep n={(guest ? 4 : 3) + (oldPass ? 1 : 0)} who="Laptop" title="Watch the gate in real time">
        <div className="row" style={{ gap: '1rem', alignItems: 'stretch' }}>
          <div className="stat">
            <div className="value">{inside ?? '—'}</div>
            <div className="label">people inside now</div>
          </div>
          {guest && (
            <div className="stat">
              <div className="value" style={{ fontSize: '1.2rem' }}>
                {guest.participant.current_access_state === 'INSIDE' ? 'Inside' : guest.participant.checked_in_at ? 'Left the venue' : 'Not arrived'}
              </div>
              <div className="label">{guest.participant.name}</div>
            </div>
          )}
        </div>
        <h3>Latest scans</h3>
        {log.length === 0 ? (
          <p className="muted">No scans yet.</p>
        ) : (
          <table>
            <tbody>
              {log.map((a, i) => (
                <tr key={a.id} className={i === 0 ? 'demo-new' : undefined}>
                  <td>{formatTimeWithSeconds(a.occurred_at)}</td>
                  <td>
                    <strong>{a.participant_name ?? 'Unknown pass'}</strong>
                  </td>
                  <td>
                    {a.event_type} at {a.gate_name ?? 'desk'}
                  </td>
                  <td>
                    <StatusBadge status={a.result} /> {a.reject_code && <span className="small mono">{a.reject_code.replace(/_/g, ' ').toLowerCase()}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </DemoStep>
    </DemoPageShell>
  );
}
