import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs, ROLE_LABEL, type Role } from '../../api';
import { ErrorMessage, StatusBadge, TableWrap, useLoad } from '../../components/ui';
import { formatDateTime } from '../../format';
import { Input, Select } from '../../components/fui';

interface Row {
  id: string;
  volunteer_code: string;
  name: string;
  email: string;
  role: Role;
  status: string;
  sessions_attended: number;
  last_tapped_in_at: string | null;
}

/** Account directory. Deliberately shows no "absent" data: volunteers have no attendance obligations. */
export function VolunteersPage() {
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const { data, error } = useLoad(() => api.get<{ volunteers: Row[] }>(`/admin/volunteers${qs({ q, role })}`), [q, role]);
  return (
    <>
      <h1>People</h1>
      <div className="filters">
        <label>
          Search
          <Input placeholder="Name, email or ID" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label>
          Role
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">All roles</option>
            {Object.entries(ROLE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <ErrorMessage error={error} />
      {data && (
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>ID</th>
                <th>Role</th>
                <th>Status</th>
                <th className="right">Sessions attended</th>
                <th>Last tap-in</th>
              </tr>
            </thead>
            <tbody>
              {data.volunteers.map((v) => (
                <tr key={v.id}>
                  <td>
                    <Link to={`/admin/volunteers/${v.id}`}>{v.name}</Link>
                    <div className="small muted">{v.email}</div>
                  </td>
                  <td className="mono">{v.volunteer_code}</td>
                  <td>{ROLE_LABEL[v.role]}</td>
                  <td>
                    <StatusBadge status={v.status} />
                  </td>
                  <td className="right">{v.sessions_attended}</td>
                  <td>{v.last_tapped_in_at ? formatDateTime(v.last_tapped_in_at) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </>
  );
}
