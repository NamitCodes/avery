import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, qs, type AuditLog, type Location, type QrCode, type Session } from '../../api';
import { ErrorMessage, Modal, ReasonDialog, StatusBadge, TableWrap, useLoad } from '../../components/ui';
import { formatDateTime, formatRange, formatTime, formatTimeWithSeconds, toLocalInput } from '../../format';
import { Button, buttonClass, Crumbs, Input, Select, Textarea } from '../../components/fui';

interface Detail {
  session: Session;
  location: Location;
  active_qr: QrCode | null;
  attendance_count: number;
  checkin_availability: string;
  history: AuditLog[];
}
interface AttendanceRow {
  id: string;
  tapped_in_at: string;
  source: 'QR' | 'ADMIN';
  status: 'ACTIVE' | 'VOIDED';
  volunteer_id: string;
  volunteer_name: string;
  volunteer_code: string;
  created_by_name: string | null;
}
interface VolunteerOption {
  id: string;
  name: string;
  volunteer_code: string;
  email: string;
  status: string;
}

const AVAILABILITY: Record<string, string> = {
  AVAILABLE: 'Accepting check-ins now',
  NOT_YET_OPEN: 'Check-in not open yet',
  CLOSED: 'Check-in closed',
  CANCELLED: 'Cancelled',
  DRAFT: 'Draft — not visible to volunteers',
};

export function SessionDetailPage() {
  const { id = '' } = useParams();
  const [q, setQ] = useState('');
  const detail = useLoad(() => api.get<Detail>(`/admin/sessions/${id}`), [id]);
  const attendance = useLoad(() => api.get<{ attendance: AttendanceRow[] }>(`/admin/sessions/${id}/attendance${qs({ q })}`), [id, q]);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<
    | { kind: 'action'; action: string; label: string; danger?: boolean; optional?: boolean }
    | { kind: 'add' }
    | { kind: 'correct'; row: AttendanceRow }
    | null
  >(null);

  // Live view: refresh attendance while check-in is open.
  const live = detail.data?.checkin_availability === 'AVAILABLE';
  const reloadAttendance = attendance.reload;
  const reloadDetail = detail.reload;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      void reloadAttendance();
      void reloadDetail();
    }, 10_000);
    return () => clearInterval(t);
  }, [live, reloadAttendance, reloadDetail]);

  if (detail.error) return <ErrorMessage error={detail.error} />;
  if (!detail.data) return <p className="muted">Loading…</p>;
  const { session: s, location, active_qr } = detail.data;
  const tz = location.timezone;

  async function act(action: string, reason?: string) {
    setError(null);
    await api.post(`/admin/sessions/${id}/${action}`, reason ? { reason } : {});
    await detail.reload();
  }

  return (
    <>
      <Crumbs items={[{ label: 'Sessions', to: "/admin/sessions" }]} current={s.title} />
      <div className="spread">
        <h1>
          {s.title} <StatusBadge status={s.status} />
        </h1>
        <div className="row">
          {!['CANCELLED', 'ARCHIVED'].includes(s.status) && (
            <Link className={buttonClass({ variant: 'subtle' })} to={`/admin/sessions/${id}/edit`}>
              Edit
            </Link>
          )}
          {s.status === 'DRAFT' && <Button variant="solid" onClick={() => act('publish').catch(setError)}>Publish</Button>}
          {s.status === 'SCHEDULED' && (
            <Button variant="solid" onClick={() => setDialog({ kind: 'action', action: 'open', label: 'Open check-in now', optional: true })}>Open early</Button>
          )}
          {['SCHEDULED', 'OPEN'].includes(s.status) && (
            <Button variant="subtle" onClick={() => setDialog({ kind: 'action', action: 'close', label: 'Close check-in', optional: true })}>
              Close
            </Button>
          )}
          {s.status === 'CLOSED' && (
            <Button variant="subtle" onClick={() => setDialog({ kind: 'action', action: 'reopen', label: 'Reopen check-in' })}>
              Reopen
            </Button>
          )}
          {['CLOSED', 'CANCELLED'].includes(s.status) && (
            <Button variant="subtle" onClick={() => act('archive').catch(setError)}>
              Archive
            </Button>
          )}
          {!['CANCELLED', 'ARCHIVED'].includes(s.status) && (
            <Button variant="subtle" onClick={() => setDialog({ kind: 'action', action: 'cancel', label: 'Cancel session', danger: true, optional: true })}>
              Cancel session
            </Button>
          )}
        </div>
      </div>
      <ErrorMessage error={error} />

      <div className="card-grid">
        <div className="stat">
          <div className="value">{detail.data.attendance_count}</div>
          <div className="label">Volunteers checked in</div>
        </div>
        <div className="stat">
          <div className="value" style={{ fontSize: '1rem', paddingTop: '0.5rem' }}>
            {AVAILABILITY[detail.data.checkin_availability]}
          </div>
          <div className="label">{live ? 'Updating every 10 seconds' : 'Check-in status'}</div>
        </div>
      </div>

      <dl className="kv" style={{ marginTop: '1.5rem' }}>
        <dt>Venue</dt>
        <dd>
          {location.name} <span className="muted small">({tz})</span>
        </dd>
        <dt>Scheduled</dt>
        <dd>{formatRange(s.start_at, s.end_at, tz)}</dd>
        <dt>Check-in window</dt>
        <dd>{formatRange(s.checkin_opens_at, s.checkin_closes_at, tz)}</dd>
        {s.description && (
          <>
            <dt>Description</dt>
            <dd>{s.description}</dd>
          </>
        )}
        <dt>Venue QR</dt>
        <dd>
          {active_qr ? (
            <span className="row">
              <StatusBadge status="ACTIVE" />
              <Link to={`/admin/qr/${active_qr.id}/print`}>Print</Link>
              <Link to={`/admin/venues/${location.id}`}>Manage QR</Link>
            </span>
          ) : (
            <span className="row">
              <StatusBadge status="REVOKED" /> No active QR — <Link to={`/admin/venues/${location.id}`}>generate one</Link>
            </span>
          )}
        </dd>
      </dl>

      <div className="section">
        <div className="spread">
          <h2>Attendance</h2>
          <div className="row">
            <Input placeholder="Search name or ID" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
            <a className={buttonClass({ variant: 'subtle' })} href={`/api/admin/reports/attendance.csv?session_id=${id}`}>
              Export CSV
            </a>
            {!['DRAFT', 'CANCELLED', 'ARCHIVED'].includes(s.status) && <Button variant="solid" onClick={() => setDialog({ kind: 'add' })}>Add manually</Button>}
          </div>
        </div>
        <ErrorMessage error={attendance.error} />
        {attendance.data && attendance.data.attendance.length === 0 && <p className="muted">No one has checked in{q ? ' matching that search' : ''}.</p>}
        {attendance.data && attendance.data.attendance.length > 0 && (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Volunteer</th>
                  <th>ID</th>
                  <th>Tap-in</th>
                  <th>Source</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {attendance.data.attendance.map((a) => (
                  <tr key={a.id} className={a.status === 'VOIDED' ? 'dim' : undefined}>
                    <td>
                      <Link to={`/admin/volunteers/${a.volunteer_id}`}>{a.volunteer_name}</Link>
                      {a.status === 'VOIDED' && (
                        <>
                          {' '}
                          <StatusBadge status="VOIDED" />
                        </>
                      )}
                    </td>
                    <td className="mono">{a.volunteer_code}</td>
                    <td>{formatTimeWithSeconds(a.tapped_in_at, tz)}</td>
                    <td>
                      {a.source === 'QR' ? 'QR scan' : 'Admin'}
                      {a.created_by_name && <div className="small muted">by {a.created_by_name}</div>}
                    </td>
                    <td className="right">
                      {s.status !== 'ARCHIVED' && (
                        <Button variant="subtle" size="sm" onClick={() => setDialog({ kind: 'correct', row: a })}>
                          Correct
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </div>

      <div className="section">
        <h2>History</h2>
        <ul className="small" style={{ paddingLeft: '1.1rem' }}>
          {detail.data.history.map((h) => (
            <li key={h.id}>
              {formatDateTime(h.created_at, tz)} — {h.action.replace('session.', '').replace('_', ' ')} by {h.actor_name ?? 'system'}
              {h.reason && <span className="muted"> · “{h.reason}”</span>}
            </li>
          ))}
        </ul>
      </div>

      {dialog?.kind === 'action' && (
        <ReasonDialog
          title={dialog.label}
          confirmLabel={dialog.label}
          danger={dialog.danger}
          optional={dialog.optional}
          description={
            dialog.action === 'reopen' ? <p>If the check-in window has ended it will be extended so volunteers can check in.</p> : undefined
          }
          onClose={() => setDialog(null)}
          onConfirm={(reason) => act(dialog.action, reason)}
        />
      )}
      {dialog?.kind === 'add' && (
        <AddAttendanceDialog
          sessionId={id}
          tz={tz}
          onClose={() => setDialog(null)}
          onDone={() => {
            void attendance.reload();
            void detail.reload();
          }}
        />
      )}
      {dialog?.kind === 'correct' && (
        <CorrectDialog
          row={dialog.row}
          tz={tz}
          onClose={() => setDialog(null)}
          onDone={() => {
            void attendance.reload();
            void detail.reload();
          }}
        />
      )}
    </>
  );
}

function AddAttendanceDialog({ sessionId, tz, onClose, onDone }: { sessionId: string; tz: string; onClose(): void; onDone(): void }) {
  const [search, setSearch] = useState('');
  const [volunteer, setVolunteer] = useState<VolunteerOption | null>(null);
  const [time, setTime] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const results = useLoad(
    () => (search.length >= 2 ? api.get<{ volunteers: VolunteerOption[] }>(`/admin/volunteers${qs({ q: search })}`) : Promise.resolve({ volunteers: [] })),
    [search],
  );
  return (
    <Modal title="Add attendance manually" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!volunteer) return;
          setBusy(true);
          setError(null);
          try {
            await api.post(`/admin/sessions/${sessionId}/attendance`, { volunteer_id: volunteer.id, tapped_in_at: time || undefined, reason });
            onDone();
            onClose();
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        {volunteer ? (
          <p>
            <strong>{volunteer.name}</strong> <span className="mono small">{volunteer.volunteer_code}</span>{' '}
            <Button variant="ghost" type="button" className="small" onClick={() => setVolunteer(null)}>
              change
            </Button>
          </p>
        ) : (
          <label>
            Volunteer
            <Input autoFocus placeholder="Name, email or ID" value={search} onChange={(e) => setSearch(e.target.value)} />
            {results.data?.volunteers.slice(0, 8).map((v) => (
              <button type="button" key={v.id} className="choice" disabled={v.status !== 'ACTIVE'} onClick={() => setVolunteer(v)}>
                {v.name} <span className="mono small muted">{v.volunteer_code}</span>
                {v.status !== 'ACTIVE' && <span className="small muted"> (inactive)</span>}
              </button>
            ))}
          </label>
        )}
        <label>
          Tap-in time <span className="muted">(optional, {tz}; defaults to now)</span>
          <Input type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
        <label>
          Reason <span className="required">*</span>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} />
        </label>
        <ErrorMessage error={error} />
        <div className="actions">
          <Button variant="subtle" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" disabled={busy || !volunteer || reason.trim().length < 3}>Add attendance</Button>
        </div>
      </form>
    </Modal>
  );
}

function CorrectDialog({ row, tz, onClose, onDone }: { row: AttendanceRow; tz: string; onClose(): void; onDone(): void }) {
  const [time, setTime] = useState(toLocalInput(row.tapped_in_at, tz));
  const [status, setStatus] = useState(row.status);
  const history = useLoad(() => api.get<{ history: AuditLog[] }>(`/admin/attendance/${row.id}/history`), [row.id]);
  return (
    <ReasonDialog
      title={`Correct record — ${row.volunteer_name}`}
      confirmLabel="Save correction"
      onClose={onClose}
      description={<p className="small">The original values are kept in the audit history.</p>}
      onConfirm={async (reason) => {
        const changed = time !== toLocalInput(row.tapped_in_at, tz);
        await api.patch(`/admin/attendance/${row.id}`, { tapped_in_at: changed ? time : undefined, status: status !== row.status ? status : undefined, reason });
        onDone();
      }}
    >
      <label>
        Tap-in time ({tz})
        <Input type="datetime-local" step={1} value={time} onChange={(e) => setTime(e.target.value)} />
      </label>
      <label>
        Record status
        <Select value={status} onChange={(e) => setStatus(e.target.value as AttendanceRow['status'])}>
          <option value="ACTIVE">Active</option>
          <option value="VOIDED">Voided (did not attend / recorded in error)</option>
        </Select>
      </label>
      {history.data && history.data.history.length > 0 && (
        <div className="small" style={{ marginBottom: '1rem' }}>
          <strong>Previous corrections</strong>
          <ul style={{ paddingLeft: '1.1rem', margin: '0.25rem 0 0' }}>
            {history.data.history.map((h) => (
              <li key={h.id}>
                {formatDateTime(h.created_at, tz)}: {h.action.replace('attendance.', '')} by {h.actor_name}
                {h.before_data?.tapped_in_at ? ` (was ${formatTime(String(h.before_data.tapped_in_at), tz)})` : ''} — “{h.reason}”
              </li>
            ))}
          </ul>
        </div>
      )}
    </ReasonDialog>
  );
}
