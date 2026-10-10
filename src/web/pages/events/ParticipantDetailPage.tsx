import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type AuditLog } from '../../api';
import { ErrorMessage, ReasonDialog, StatusBadge, useLoad } from '../../components/ui';
import { formatDateTime } from '../../format';
import { useEventContext } from './EventLayout';
import { SOURCE_LABEL, stateLabel, type Participant } from './types';

interface Credential {
  id: string;
  status: string;
  issued_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
}
interface Delivery {
  id: string;
  credential_id: string;
  delivery_status: string;
  attempt_count: number;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
}
interface AccessEvent {
  id: string;
  event_type: string;
  result: string;
  reject_code: string | null;
  source: string;
  occurred_at: string;
  gate_name: string | null;
  operator_name: string | null;
  reason: string | null;
  corrects_event_id: string | null;
}
interface Verification {
  id: string;
  verification_type: string;
  outcome: string;
  verified_by_name: string | null;
  verified_at: string;
  reason: string | null;
}
interface Detail {
  participant: Participant;
  credentials: Credential[];
  deliveries: Delivery[];
  access_events: AccessEvent[];
  verifications: Verification[];
  audit: AuditLog[];
}

type Dialog =
  | { kind: 'revoke'; id: string }
  | { kind: 'replace'; id: string }
  | { kind: 'issue' }
  | { kind: 'access'; direction: 'IN' | 'OUT'; override: boolean }
  | { kind: 'id'; outcome: 'CHECKED' | 'FAILED' | 'OVERRIDDEN' }
  | { kind: 'contact'; action: 'override' | 'fail' }
  | { kind: 'correct'; id: string }
  | { kind: 'edit' }
  | null;

export function ParticipantDetailPage() {
  const { participantId = '' } = useParams();
  const { event: e, canManage } = useEventContext();
  const navigate = useNavigate();
  const base = `/admin/events/${e.id}/participants/${participantId}`;
  const { data, error, reload } = useLoad(() => api.get<Detail>(base), [base]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [edit, setEdit] = useState<Partial<Participant>>({});

  if (error) return <ErrorMessage error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  const p = data.participant;
  const active = data.credentials.find((c) => c.status === 'ACTIVE');
  const tz = e.timezone;
  const latestAccepted = data.access_events.find((a) => a.result === 'ACCEPTED' && a.event_type !== 'CORRECTION' && !data.access_events.some((c) => c.corrects_event_id === a.id));

  const run = async (fn: () => Promise<unknown>, msg?: string) => {
    setActionError(null);
    setNotice(null);
    try {
      await fn();
      if (msg) setNotice(msg);
      await reload();
    } catch (err) {
      setActionError(err);
    }
  };

  return (
    <>
      <p className="small muted">
        <Link to={`/admin/events/${e.id}/participants`}>Participants</Link> /
      </p>
      <div className="spread">
        <h2 style={{ margin: 0 }}>
          {p.name} {p.status !== 'ACTIVE' && <StatusBadge status={p.status === 'CANCELLED' ? 'CANCELLED' : 'INACTIVE'} />}
        </h2>
        <button className="btn-secondary btn-sm" onClick={() => { setEdit({ name: p.name, country: p.country, email: p.email, phone: p.phone, status: p.status, needs_review: p.needs_review, review_note: p.review_note }); setDialog({ kind: 'edit' }); }}>
          Correct details
        </button>
      </div>
      <dl className="kv" style={{ marginTop: '1rem' }}>
        <dt>Reference</dt>
        <dd className="mono">{p.registration_reference}</dd>
        <dt>Country</dt>
        <dd>{p.country || '—'}</dd>
        <dt>Email</dt>
        <dd>{p.email ?? '—'}</dd>
        <dt>Phone</dt>
        <dd>{p.phone ?? '—'}</dd>
        <dt>Source</dt>
        <dd>
          {SOURCE_LABEL[p.registration_source]} · registered {formatDateTime(p.registered_at, tz)}
        </dd>
        <dt>State</dt>
        <dd>
          <strong>{stateLabel(p, e.reentry_enabled)}</strong>
          {p.checked_in_at && <span className="muted small"> · first check-in {formatDateTime(p.checked_in_at, tz)}</span>}
        </dd>
        <dt>Contact verification</dt>
        <dd>
          <StatusBadge status={p.contact_verification} />
        </dd>
        <dt>Photo ID check</dt>
        <dd>
          <StatusBadge status={p.id_check} />
        </dd>
        {p.needs_review && (
          <>
            <dt>Review</dt>
            <dd>Needs review{p.review_note && `: ${p.review_note}`}</dd>
          </>
        )}
      </dl>

      {notice && <div className="alert alert-ok" style={{ marginTop: '1rem' }}>{notice}</div>}
      <ErrorMessage error={actionError} />

      <div className="section">
        <h2>Pass</h2>
        {active ? (
          <div className="row">
            <span>
              <StatusBadge status="ACTIVE" /> issued {formatDateTime(active.issued_at, tz)}
            </span>
            <Link className="btn btn-secondary btn-sm" to={`/admin/event-passes/${active.id}/print`}>
              Print pass
            </Link>
            {p.email && canManage && (
              <button className="btn-secondary btn-sm" onClick={() => run(() => api.post(`/admin/events/${e.id}/passes/send`, { participant_ids: [p.id], issue_missing: false, scope: 'UNSENT' }), 'Email queued (if not already sent).')}>
                Email pass
              </button>
            )}
            <button className="btn-secondary btn-sm" onClick={() => setDialog({ kind: 'replace', id: active.id })}>
              Replace (lost / damaged)
            </button>
            <button className="btn-secondary btn-sm" onClick={() => setDialog({ kind: 'revoke', id: active.id })}>
              Revoke
            </button>
          </div>
        ) : (
          <div className="row">
            <span className="muted">No active pass.</span>
            {p.status === 'ACTIVE' && <button className="btn-sm" onClick={() => setDialog({ kind: 'issue' })}>Issue pass</button>}
          </div>
        )}
        {data.deliveries.length > 0 && (
          <table style={{ marginTop: '1rem' }}>
            <thead>
              <tr>
                <th>Email queued</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Error</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.deliveries.map((d) => (
                <tr key={d.id}>
                  <td>{formatDateTime(d.created_at, tz)}</td>
                  <td>
                    <StatusBadge status={d.delivery_status} />
                  </td>
                  <td>{d.attempt_count}</td>
                  <td className="small">{d.last_error}</td>
                  <td>
                    {d.delivery_status === 'FAILED' && (
                      <button className="btn-secondary btn-sm" onClick={() => run(() => api.post(`/admin/event-pass-deliveries/${d.id}/retry`), 'Retry queued.')}>
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="section">
        <h2>Desk actions</h2>
        <div className="row">
          <button className="btn-secondary btn-sm" onClick={() => setDialog({ kind: 'access', direction: 'IN', override: false })}>
            {e.reentry_enabled ? 'Record entry' : 'Check in'}
          </button>
          {e.reentry_enabled && (
            <button className="btn-secondary btn-sm" onClick={() => setDialog({ kind: 'access', direction: 'OUT', override: false })}>
              Record exit
            </button>
          )}
          <button className="btn-secondary btn-sm" onClick={() => setDialog({ kind: 'access', direction: 'IN', override: true })}>
            Manual override…
          </button>
          {e.id_check_mode !== 'NOT_USED' && (
            <>
              <button className="btn-secondary btn-sm" onClick={() => setDialog({ kind: 'id', outcome: 'CHECKED' })}>
                ID checked
              </button>
              <button className="btn-secondary btn-sm" onClick={() => setDialog({ kind: 'id', outcome: 'FAILED' })}>
                ID check failed
              </button>
              <button className="btn-secondary btn-sm" onClick={() => setDialog({ kind: 'id', outcome: 'OVERRIDDEN' })}>
                Override ID check
              </button>
            </>
          )}
          {p.email && p.contact_verification !== 'VERIFIED' && e.verification_policy === 'CONTACT_VERIFIED' && (
            <>
              <button className="btn-secondary btn-sm" onClick={() => run(() => api.post(`${base}/verify-contact`, { action: 'start' }), 'Verification code sent.')}>
                Send email code
              </button>
              <button className="btn-secondary btn-sm" onClick={() => setDialog({ kind: 'contact', action: 'override' })}>
                Override contact check
              </button>
            </>
          )}
        </div>
      </div>

      <div className="section">
        <h2>Access history</h2>
        {data.access_events.length === 0 ? (
          <p className="muted">No scans yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Result</th>
                  <th>Gate / source</th>
                  <th>Operator</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.access_events.map((a) => (
                  <tr key={a.id}>
                    <td>{formatDateTime(a.occurred_at, tz)}</td>
                    <td>{a.event_type}</td>
                    <td>
                      <StatusBadge status={a.result} /> {a.reject_code && <span className="small mono">{a.reject_code}</span>}
                      {a.reason && <div className="small muted">“{a.reason}”</div>}
                    </td>
                    <td>{a.gate_name ?? a.source}</td>
                    <td>{a.operator_name}</td>
                    <td>
                      {latestAccepted?.id === a.id && (
                        <button className="btn-secondary btn-sm" onClick={() => setDialog({ kind: 'correct', id: a.id })}>
                          Correct
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data.verifications.length > 0 && (
        <div className="section">
          <h2>Verification records</h2>
          <ul className="small" style={{ paddingLeft: '1.1rem' }}>
            {data.verifications.map((v) => (
              <li key={v.id}>
                {formatDateTime(v.verified_at, tz)} — {v.verification_type} {v.outcome.toLowerCase()} {v.verified_by_name ? `by ${v.verified_by_name}` : '(automated)'}
                {v.reason && ` · “${v.reason}”`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.audit.length > 0 && (
        <div className="section">
          <h2>Audit</h2>
          <ul className="small" style={{ paddingLeft: '1.1rem' }}>
            {data.audit.map((a) => (
              <li key={a.id}>
                {formatDateTime(a.created_at, tz)} — <span className="mono">{a.action}</span> by {a.actor_name ?? 'system / self-service'}
                {a.reason && ` · “${a.reason}”`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {dialog?.kind === 'issue' && (
        <ReasonDialog
          title="Issue pass"
          confirmLabel="Issue"
          optional
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            const res = await api.post<{ credential: { id: string } }>(`${base}/credentials`, { reason: reason || undefined });
            navigate(`/admin/event-passes/${res.credential.id}/print`);
          }}
        />
      )}
      {dialog?.kind === 'revoke' && (
        <ReasonDialog
          title="Revoke pass"
          danger
          confirmLabel="Revoke"
          description={<p>The pass will be rejected at all gates immediately.</p>}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => run(() => api.post(`/admin/event-credentials/${dialog.id}/revoke`, { reason }), 'Pass revoked.')}
        />
      )}
      {dialog?.kind === 'replace' && (
        <ReplaceDialog
          onClose={() => setDialog(null)}
          onConfirm={async (reason, sendEmail) => {
            const res = await api.post<{ credential: { id: string } }>(`/admin/event-credentials/${dialog.id}/replace`, { reason, identity_verified: true, send_email: sendEmail });
            navigate(`/admin/event-passes/${res.credential.id}/print`);
          }}
        />
      )}
      {dialog?.kind === 'access' && (
        <ReasonDialog
          title={dialog.override ? 'Manual override (admit)' : dialog.direction === 'IN' ? (e.reentry_enabled ? 'Record entry' : 'Check in') : 'Record exit'}
          confirmLabel="Confirm"
          danger={dialog.override}
          optional={!dialog.override}
          description={
            dialog.override ? (
              <p>Admits the participant even if verification or capacity checks fail. Use only with supervisor authorisation; recorded as MANUAL.</p>
            ) : (
              <p>Normal policy checks apply (verification, capacity, current state).</p>
            )
          }
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            const out = await api.post<{ result: string; message: string }>(`${base}/manual-access`, {
              direction: dialog.direction,
              override: dialog.override,
              reason: reason || undefined,
            });
            setNotice(`${out.result === 'ACCEPTED' ? 'Accepted' : 'Rejected'}: ${out.message}`);
            await reload();
          }}
        />
      )}
      {dialog?.kind === 'id' && (
        <ReasonDialog
          title={dialog.outcome === 'CHECKED' ? 'Record ID check passed' : dialog.outcome === 'FAILED' ? 'Record ID check failed' : 'Override ID check'}
          confirmLabel="Record"
          optional={dialog.outcome !== 'OVERRIDDEN'}
          danger={dialog.outcome === 'OVERRIDDEN'}
          description={<p>Do not record document numbers or images. Only the result, your name and the time are stored.</p>}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => run(() => api.post(`${base}/verify-identity`, { outcome: dialog.outcome, reason: reason || undefined }))}
        />
      )}
      {dialog?.kind === 'contact' && (
        <ReasonDialog
          title="Override contact verification"
          danger
          confirmLabel="Override"
          onClose={() => setDialog(null)}
          onConfirm={(reason) => run(() => api.post(`${base}/verify-contact`, { action: dialog.action, reason }))}
        />
      )}
      {dialog?.kind === 'correct' && (
        <ReasonDialog
          title="Correct access record"
          confirmLabel="Reverse this record"
          description={<p>Use when a scan was accepted but the person did not actually cross the gate. The original record is kept; a correction is added.</p>}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => run(() => api.post(`/admin/event-access-events/${dialog.id}/correct`, { reason }), 'Correction recorded.')}
        />
      )}
      {dialog?.kind === 'edit' && (
        <ReasonDialog
          title="Correct registration details"
          confirmLabel="Save"
          onClose={() => setDialog(null)}
          onConfirm={(reason) => run(() => api.patch(base, { ...edit, reason }), 'Saved.')}
        >
          <label>
            Name
            <input value={edit.name ?? ''} onChange={(ev) => setEdit({ ...edit, name: ev.target.value })} />
          </label>
          <label>
            Country
            <input value={edit.country ?? ''} onChange={(ev) => setEdit({ ...edit, country: ev.target.value })} />
          </label>
          {canManage && (
            <>
              <label>
                Email
                <input value={edit.email ?? ''} onChange={(ev) => setEdit({ ...edit, email: ev.target.value || null })} />
              </label>
              <label>
                Phone
                <input value={edit.phone ?? ''} onChange={(ev) => setEdit({ ...edit, phone: ev.target.value || null })} />
              </label>
            </>
          )}
          <label>
            Status
            <select value={edit.status} onChange={(ev) => setEdit({ ...edit, status: ev.target.value as Participant['status'] })}>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={!!edit.needs_review} onChange={(ev) => setEdit({ ...edit, needs_review: ev.target.checked })} />
            Needs review
          </label>
        </ReasonDialog>
      )}
    </>
  );
}

function ReplaceDialog({ onClose, onConfirm }: { onClose(): void; onConfirm(reason: string, sendEmail: boolean): Promise<void> }) {
  const [verified, setVerified] = useState(false);
  const [sendEmail, setSendEmail] = useState(false);
  return (
    <ReasonDialog
      title="Replace pass"
      confirmLabel={verified ? 'Revoke old & issue new' : 'Confirm identity first'}
      description={<p>The current pass stops working immediately. History is preserved.</p>}
      onClose={onClose}
      onConfirm={async (reason) => {
        if (!verified) throw new Error('Identity not confirmed');
        await onConfirm(reason, sendEmail);
      }}
    >
      <label className="check">
        <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />I verified this person’s identity using the approved procedure
      </label>
      <label className="check">
        <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
        Also email the new pass
      </label>
    </ReasonDialog>
  );
}
