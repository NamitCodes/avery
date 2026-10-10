import { useState } from 'react';
import { api, qs, type AuditLog } from '../../api';
import { ErrorMessage, useLoad } from '../../components/ui';
import { formatDateTime } from '../../format';

const ENTITY_TYPES = [
  'session', 'location', 'venue_qr_code', 'attendance_record', 'volunteer',
  'event', 'event_participant', 'event_credential', 'event_gate', 'event_import', 'event_access_event', 'event_pass_delivery',
];

function Diff({ before, after }: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) {
  if (!before && !after) return null;
  const keys = Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])).filter(
    (k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]) && !['updated_at', 'normalized_name', 'normalized_email', 'normalized_phone'].includes(k),
  );
  if (keys.length === 0) return null;
  return (
    <div className="small mono muted" style={{ marginTop: '0.25rem' }}>
      {keys.slice(0, 8).map((k) => (
        <div key={k}>
          {k}: {before && k in before ? JSON.stringify(before[k]) : '∅'} → {after && k in after ? JSON.stringify(after[k]) : '∅'}
        </div>
      ))}
    </div>
  );
}

export function AuditPage() {
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const { data, error } = useLoad(
    () => api.get<{ audit_logs: AuditLog[] }>(`/admin/audit-logs${qs({ entity_type: entityType, action, limit: '300' })}`),
    [entityType, action],
  );
  return (
    <>
      <h1>Audit log</h1>
      <div className="filters">
        <label>
          Record type
          <select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            <option value="">All</option>
            {ENTITY_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          Action starts with
          <input placeholder="e.g. attendance." value={action} onChange={(e) => setAction(e.target.value)} />
        </label>
      </div>
      <ErrorMessage error={error} />
      {data && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {data.audit_logs.map((a) => (
                <tr key={a.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(a.created_at)}</td>
                  <td>{a.actor_name ?? <span className="muted">system</span>}</td>
                  <td>
                    <span className="mono">{a.action}</span>
                    <Diff before={a.before_data} after={a.after_data} />
                  </td>
                  <td>{a.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
