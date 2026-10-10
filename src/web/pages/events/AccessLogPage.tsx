import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../../api';
import { ErrorMessage, StatusBadge, TableWrap, useLoad } from '../../components/ui';
import { formatDateTime } from '../../format';
import { useEventContext } from './EventLayout';
import { buttonClass, Input, Select } from '../../components/fui';

interface Row {
  id: string;
  participant_id: string | null;
  participant_name: string | null;
  registration_reference: string | null;
  event_type: string;
  result: string;
  reject_code: string | null;
  source: string;
  gate_name: string | null;
  operator_name: string | null;
  occurred_at: string;
  reason: string | null;
  corrected: boolean;
}

export function AccessLogPage() {
  const { event: e, canManage } = useEventContext();
  const [f, setF] = useState({ result: '', event_type: '', source: '', from: '', to: '' });
  const { data, error } = useLoad(() => api.get<{ access_events: Row[] }>(`/admin/events/${e.id}/access-events${qs({ ...f, limit: '500' })}`), [e.id, JSON.stringify(f)]);
  const sel = (k: keyof typeof f, options: string[]) => (
    <Select value={f[k]} onChange={(ev) => setF({ ...f, [k]: ev.target.value })}>
      <option value="">Any</option>
      {options.map((o) => (
        <option key={o}>{o}</option>
      ))}
    </Select>
  );
  return (
    <>
      <div className="filters">
        <label>
          Result
          {sel('result', ['ACCEPTED', 'REJECTED'])}
        </label>
        <label>
          Type
          {sel('event_type', ['CHECK_IN', 'ENTRY', 'EXIT', 'CORRECTION'])}
        </label>
        <label>
          Source
          {sel('source', ['QR', 'DESK', 'MANUAL'])}
        </label>
        <label>
          From
          <Input type="date" value={f.from} onChange={(ev) => setF({ ...f, from: ev.target.value })} />
        </label>
        <label>
          To
          <Input type="date" value={f.to} onChange={(ev) => setF({ ...f, to: ev.target.value })} />
        </label>
        {canManage && (
          <a className={buttonClass({ variant: 'subtle' })} href={`/api/admin/events/${e.id}/access-events/export.csv${qs(f)}`}>
            Export CSV
          </a>
        )}
      </div>
      <ErrorMessage error={error} />
      {data && data.access_events.length === 0 && <p className="muted">No access records.</p>}
      {data && data.access_events.length > 0 && (
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Participant</th>
                <th>Type</th>
                <th>Result</th>
                <th>Gate / source</th>
                <th>Operator</th>
              </tr>
            </thead>
            <tbody>
              {data.access_events.map((a) => (
                <tr key={a.id} className={a.corrected ? 'dim' : undefined}>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(a.occurred_at, e.timezone)}</td>
                  <td>
                    {a.participant_id ? (
                      <Link to={`/admin/events/${e.id}/participants/${a.participant_id}`}>{a.participant_name}</Link>
                    ) : (
                      <span className="muted">Unknown pass</span>
                    )}
                    {a.registration_reference && <div className="small mono muted">{a.registration_reference}</div>}
                  </td>
                  <td>
                    {a.event_type}
                    {a.corrected && <div className="small muted">corrected</div>}
                  </td>
                  <td>
                    <StatusBadge status={a.result} /> {a.reject_code && <span className="small mono">{a.reject_code}</span>}
                    {a.reason && <div className="small muted">“{a.reason}”</div>}
                  </td>
                  <td>{a.gate_name ?? a.source}</td>
                  <td>{a.operator_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </>
  );
}
