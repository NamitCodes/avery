import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api, ApiError, GATE_STAFF, ROLE_LABEL } from '../../api';
import { useAuth } from '../../auth';
import { signInAsDemo } from '../../components/demoKit';
import { errorOutcome, ResultCard } from '../../components/GateResult';
import { PassCard } from '../../components/PassCard';
import { ErrorMessage, useLoad } from '../../components/ui';
import { useDemo } from '../../demoInfo';
import { newKey, type AccessOutcome, type Pass } from '../events/types';

interface Station {
  id: string;
  name: string;
  mode: 'ENTRY' | 'EXIT';
  event_id: string;
  event_name: string;
  reentry_enabled: boolean;
}

/**
 * Printable pass for the holder of the link. When gate staff open it (e.g. by
 * scanning the pass with the phone's own camera), it also offers the gates they
 * may operate, so any phone can act as a scanner — no in-page camera needed.
 * Invalid passes (revoked/replaced/unknown) still get gate buttons for staff, so
 * the gate shows a proper STOP rather than a dead end.
 */
export function PublicPassPage() {
  const { token = '' } = useParams();
  const { user, setUser } = useAuth();
  const location = useLocation();
  const demo = useDemo();
  const { data, error, loading } = useLoad(() => api.get<{ pass: Pass }>(`/public/passes/${encodeURIComponent(token)}`), [token]);
  const isStaff = !!user && user.status === 'ACTIVE' && GATE_STAFF.includes(user.role);
  const stations = useLoad(
    () => (isStaff ? api.get<{ gates: Station[] }>('/staff/stations') : Promise.resolve({ gates: [] as Station[] })),
    [isStaff],
  );
  const [outcome, setOutcome] = useState<AccessOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastGate, setLastGate] = useState<Station | null>(null);
  const [switchError, setSwitchError] = useState<unknown>(null);

  const invalid = !loading && !data;
  // Show the pass's own event's gates. For an invalid pass the server still says which event it
  // belonged to (if known); a completely unknown QR shows all of the staff member's gates.
  const allGates = stations.data?.gates ?? [];
  const eventId = data?.pass.event.id ?? (error instanceof ApiError ? (error.details.event_id as string | undefined) : undefined);
  const gates = eventId ? allGates.filter((g) => g.event_id === eventId) : allGates;
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // On a phone the result can be below the buttons; bring it into view.
    if (outcome) resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [outcome]);
  const multipleEvents = new Set(gates.map((g) => g.event_id)).size > 1;

  async function scanAt(gate: Station) {
    if (busy) return;
    setLastGate(gate);
    setBusy(true);
    setOutcome(null);
    try {
      // Send exactly what the QR contained; the server decides whether it is valid.
      const credential = data ? data.pass.pass_url : window.location.href;
      setOutcome(await api.post<AccessOutcome>('/gate-scan', { gate_id: gate.id, credential, idempotency_key: newKey() }));
    } catch (err) {
      const e = err as ApiError;
      setOutcome(e.isNetwork ? { ...errorOutcome(e), code: 'NOT_CONFIRMED', message: 'Not confirmed — no connection. Try again; do not admit yet.' } : errorOutcome(e));
    } finally {
      setBusy(false);
    }
  }

  async function switchToGateStaff() {
    if (!demo?.seeded) return;
    setSwitchError(null);
    try {
      await signInAsDemo(demo, 'desk', user, setUser);
    } catch (err) {
      setSwitchError(err);
    }
  }

  const staffPanel = isStaff && (data || invalid) && (
    <div className="no-print gate-actions">
      <p className="small muted">
        Signed in as {user!.name} ({ROLE_LABEL[user!.role]}) — record this pass at a gate:
      </p>
      {!stations.loading && gates.length === 0 && <p className="muted">You have no active gates for this event.</p>}
      {user!.role === 'GATE_OPERATOR' && gates.length > 0 && <p className="small muted">You only see the gates you are assigned to.</p>}
      <div className="row" style={{ justifyContent: 'center' }}>
        {gates.map((g) => (
          <button key={g.id} className={`btn-block gate-btn gate-btn-${g.mode.toLowerCase()}`} disabled={busy} onClick={() => scanAt(g)}>
            {g.name} <span className="small">({g.reentry_enabled ? g.mode : 'CHECK-IN'})</span>
            {multipleEvents && <span className="small" style={{ display: 'block', opacity: 0.8 }}>{g.event_name}</span>}
          </button>
        ))}
      </div>
      {busy && (
        <div className="gate-result pending">
          <div className="verdict">Checking…</div>
        </div>
      )}
      <div ref={resultRef} />
      {outcome && (
        <ResultCard
          outcome={outcome}
          tz={data?.pass.event.timezone}
          reentry={data?.pass.event.reentry_enabled ?? true}
          onIdCheck={async (result) => {
            if (!outcome.participant || !lastGate || !data) return;
            await api.post(`/admin/events/${data.pass.event.id}/participants/${outcome.participant.id}/verify-identity`, { outcome: result });
            if (result === 'CHECKED') await scanAt(lastGate);
            else setOutcome(null);
          }}
        />
      )}
    </div>
  );

  /** Signed out, or signed in without a gate role (e.g. still a volunteer from another demo). */
  const notStaffHint = !isStaff && (data || invalid) && (
    <div className="no-print center" style={{ margin: '1rem 0' }}>
      {user && (
        <p className="small muted">
          Signed in as {user.name} ({ROLE_LABEL[user.role]}) — gate buttons need a gate-staff account.
        </p>
      )}
      <div className="row" style={{ justifyContent: 'center' }}>
        {demo?.seeded && <button onClick={switchToGateStaff}>Demo: sign in as gate staff</button>}
        <Link className="small muted" to={`/login?next=${encodeURIComponent(location.pathname)}`}>
          Staff: sign in to record this pass at a gate
        </Link>
      </div>
      <ErrorMessage error={switchError} />
    </div>
  );

  return (
    <main>
      {error instanceof ApiError && error.code === 'PASS_NOT_FOUND' ? (
        <div className="pass-invalid" role="alert">
          <div className="pass-invalid-title">Invalid pass</div>
          <p>{error.message}</p>
        </div>
      ) : (
        <ErrorMessage error={error} />
      )}
      {staffPanel}
      {data && <PassCard pass={data.pass} />}
      {data && !isStaff && (
        <div className="actions no-print" style={{ justifyContent: 'center' }}>
          <button className="btn-secondary" onClick={() => window.print()}>
            Print pass
          </button>
        </div>
      )}
      {notStaffHint}
    </main>
  );
}
