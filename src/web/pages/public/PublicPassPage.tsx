import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api, ApiError, GATE_STAFF } from '../../api';
import { useAuth } from '../../auth';
import { errorOutcome, ResultCard } from '../../components/GateResult';
import { PassCard } from '../../components/PassCard';
import { ErrorMessage, useLoad } from '../../components/ui';
import { newKey, type AccessOutcome, type Pass } from '../events/types';

interface Station {
  id: string;
  name: string;
  mode: 'ENTRY' | 'EXIT';
  event_id: string;
  reentry_enabled: boolean;
}

/**
 * Printable pass for the holder of the link. When gate staff open it (e.g. by
 * scanning the pass with the phone's own camera), it also offers the gates they
 * may operate, so any phone can act as a scanner — no in-page camera needed.
 */
export function PublicPassPage() {
  const { token = '' } = useParams();
  const { user } = useAuth();
  const location = useLocation();
  const { data, error } = useLoad(() => api.get<{ pass: Pass }>(`/public/passes/${encodeURIComponent(token)}`), [token]);
  const isStaff = !!user && GATE_STAFF.includes(user.role);
  const stations = useLoad(
    () => (isStaff ? api.get<{ gates: Station[] }>('/staff/stations') : Promise.resolve({ gates: [] as Station[] })),
    [isStaff],
  );
  const [outcome, setOutcome] = useState<AccessOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastGate, setLastGate] = useState<Station | null>(null);

  async function scanAt(gate: Station) {
    if (busy || !data) return;
    setLastGate(gate);
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(await api.post<AccessOutcome>('/gate-scan', { gate_id: gate.id, credential: data.pass.pass_url, idempotency_key: newKey() }));
    } catch (err) {
      const e = err as ApiError;
      setOutcome(e.isNetwork ? { ...errorOutcome(e), code: 'NOT_CONFIRMED', message: 'Not confirmed — no connection. Try again; do not admit yet.' } : errorOutcome(e));
    } finally {
      setBusy(false);
    }
  }

  const gates = data ? (stations.data?.gates ?? []).filter((g) => g.event_id === data.pass.event.id) : [];

  return (
    <main>
      <ErrorMessage error={error} />
      {data && isStaff && (
        <div className="no-print gate-actions">
          <p className="small muted">
            Signed in as {user!.name} — record this pass at a gate:
          </p>
          {gates.length === 0 && !stations.loading && <p className="muted">You have no active gates for this event.</p>}
          <div className="row" style={{ justifyContent: 'center' }}>
            {gates.map((g) => (
              <button key={g.id} className={`btn-block gate-btn gate-btn-${g.mode.toLowerCase()}`} disabled={busy} onClick={() => scanAt(g)}>
                {g.name} <span className="small">({g.reentry_enabled ? g.mode : 'CHECK-IN'})</span>
              </button>
            ))}
          </div>
          {busy && (
            <div className="gate-result pending">
              <div className="verdict">Checking…</div>
            </div>
          )}
          {outcome && (
            <ResultCard
              outcome={outcome}
              tz={data.pass.event.timezone}
              reentry={data.pass.event.reentry_enabled}
              onIdCheck={async (result) => {
                if (!outcome.participant || !lastGate) return;
                await api.post(`/admin/events/${data.pass.event.id}/participants/${outcome.participant.id}/verify-identity`, { outcome: result });
                if (result === 'CHECKED') await scanAt(lastGate);
                else setOutcome(null);
              }}
            />
          )}
        </div>
      )}
      {data && (
        <>
          <PassCard pass={data.pass} />
          {!isStaff && (
            <div className="actions no-print" style={{ justifyContent: 'center', alignItems: 'center' }}>
              <button onClick={() => window.print()}>Print pass</button>
              <Link className="small muted" to={`/login?next=${encodeURIComponent(location.pathname)}`}>
                Staff: sign in to record this pass at a gate
              </Link>
            </div>
          )}
        </>
      )}
    </main>
  );
}
