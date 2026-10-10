import { useEffect } from 'react';
import { api } from '../../api';
import { ErrorMessage, StatusBadge, useLoad } from '../../components/ui';
import { useEventContext } from './EventLayout';
import { POLICY_LABEL } from './types';

interface Occupancy {
  [k: string]: unknown;
  total_participants: number;
  inside: number;
  checked_in_unique: number;
  accepted_entries: number;
  accepted_exits: number;
  rejected_scans: number;
  manual_overrides: number;
  corrections: number;
  needs_review: number;
  reconciliation: { derived_inside: number; mismatched_participants: number };
  rejections: { reject_code: string; n: number }[];
  gates: { id: string; name: string; mode: string; status: string; accepted: number; rejected: number }[];
}

const Stat = ({ label, value }: { label: string; value: number | string }) => (
  <div className="stat">
    <div className="value">{value}</div>
    <div className="label">{label}</div>
  </div>
);

export function EventOverviewPage() {
  const { event: e } = useEventContext();
  const occ = useLoad(() => api.get<Occupancy>(`/admin/events/${e.id}/occupancy`), [e.id]);
  const reload = occ.reload;
  useEffect(() => {
    if (e.status !== 'ACTIVE') return;
    const t = setInterval(() => void reload(), 10_000);
    return () => clearInterval(t);
  }, [e.status, reload]);

  const o = occ.data;
  const n = (k: string) => (o?.[k] as number | undefined) ?? 0;
  return (
    <>
      <ErrorMessage error={occ.error} />
      {o && (
        <>
          <div className="grid">
            {e.reentry_enabled && <Stat label={`Inside now${e.capacity ? ` / ${e.capacity}` : ''}`} value={o.inside} />}
            <Stat label="Registered" value={o.total_participants} />
            <Stat label="Checked in (unique)" value={o.checked_in_unique} />
            <Stat label="Accepted entries" value={o.accepted_entries} />
            {e.reentry_enabled && <Stat label="Accepted exits" value={o.accepted_exits} />}
            <Stat label="Rejected scans" value={o.rejected_scans} />
            <Stat label="Manual overrides" value={o.manual_overrides} />
            <Stat label="Needs review" value={o.needs_review} />
          </div>
          {o.reconciliation.mismatched_participants > 0 && (
            <div className="alert alert-warn" style={{ marginTop: '1rem' }}>
              Occupancy reconciliation: {o.reconciliation.mismatched_participants} participant state(s) differ from the access history (history says{' '}
              {o.reconciliation.derived_inside} inside). Review the access log.
            </div>
          )}

          <div className="section">
            <h2>Registrations & verification</h2>
            <table>
              <tbody>
                <tr>
                  <td>Sources</td>
                  <td>
                    Imported {n('source_import')} · Online {n('source_online')} · Walk-in {n('source_walk_in')}
                  </td>
                </tr>
                <tr>
                  <td>Contact verification</td>
                  <td>
                    Verified {n('contact_verified')} · Pending {n('contact_pending')} · Failed {n('contact_failed')} · Overridden {n('contact_overridden')}
                  </td>
                </tr>
                <tr>
                  <td>Photo ID checks</td>
                  <td>
                    Checked {n('id_checked')} · Pending {n('id_pending')} · Failed {n('id_failed')} · Overridden {n('id_overridden')}
                  </td>
                </tr>
                <tr>
                  <td>Corrections</td>
                  <td>{o.corrections}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="section">
            <h2>Gates</h2>
            {o.gates.length === 0 ? (
              <p className="muted">No gates configured.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Gate</th>
                    <th>Mode</th>
                    <th>Status</th>
                    <th className="right">Accepted</th>
                    <th className="right">Rejected</th>
                  </tr>
                </thead>
                <tbody>
                  {o.gates.map((g) => (
                    <tr key={g.id}>
                      <td>{g.name}</td>
                      <td>{g.mode}</td>
                      <td>
                        <StatusBadge status={g.status} />
                      </td>
                      <td className="right">{g.accepted}</td>
                      <td className="right">{g.rejected}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {o.rejections.length > 0 && (
            <div className="section">
              <h2>Rejected scans by reason</h2>
              <table>
                <tbody>
                  {o.rejections.map((r) => (
                    <tr key={r.reject_code}>
                      <td className="mono">{r.reject_code}</td>
                      <td className="right">{r.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <div className="section">
        <h2>Policy</h2>
        <dl className="kv">
          <dt>Admission</dt>
          <dd>{e.reentry_enabled ? 'Entry/exit tracking with re-entry' : 'Single check-in'}</dd>
          <dt>Registration</dt>
          <dd>
            {[e.advance_registration_enabled ? 'Online advance registration' : 'No online registration', e.walk_ins_enabled ? 'walk-ins allowed' : 'no walk-ins'].join(', ')}
          </dd>
          <dt>Identity assurance</dt>
          <dd>
            {POLICY_LABEL[e.verification_policy]}; photo ID {e.id_check_mode.toLowerCase().replace('_', ' ')}
          </dd>
          <dt>Capacity</dt>
          <dd>{e.capacity ?? 'Not limited'}</dd>
        </dl>
      </div>
    </>
  );
}
