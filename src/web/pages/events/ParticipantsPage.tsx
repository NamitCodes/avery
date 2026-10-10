import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../api';
import { ErrorMessage, StatusBadge, TableWrap, useLoad } from '../../components/ui';
import { useEventContext } from './EventLayout';
import { SOURCE_LABEL, stateLabel, type Participant } from './types';
import { Button, buttonClass, Input, Select } from '../../components/fui';

export function ParticipantsPage() {
  const { event: e, canManage } = useEventContext();
  const [params, setParams] = useSearchParams();
  const filters = {
    q: params.get('q') ?? '',
    country: params.get('country') ?? '',
    state: params.get('state') ?? '',
    pass_status: params.get('pass_status') ?? '',
    source: params.get('source') ?? '',
    needs_review: params.get('needs_review') ?? '',
    page: params.get('page') ?? '1',
  };
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };
  const [search, setSearch] = useState(filters.q);
  const { data, error } = useLoad(
    () => api.get<{ participants: Participant[]; total: number; page: number; page_size: number }>(`/admin/events/${e.id}/participants${qs(filters)}`),
    [e.id, params.toString()],
  );
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <>
      <form
        className="filters"
        onSubmit={(ev) => {
          ev.preventDefault();
          set('q', search);
        }}
      >
        <label style={{ flex: 2 }}>
          Search
          <Input placeholder="Name, reference, email or phone" value={search} onChange={(ev) => setSearch(ev.target.value)} />
        </label>
        <label>
          Country
          <Input defaultValue={filters.country} onBlur={(ev) => set('country', ev.target.value)} />
        </label>
        <label>
          State
          <Select value={filters.state} onChange={(ev) => set('state', ev.target.value)}>
            <option value="">Any</option>
            <option value="NOT_CHECKED_IN">Not checked in</option>
            <option value="CHECKED_IN">Checked in</option>
            {e.reentry_enabled && <option value="INSIDE">Inside now</option>}
            {e.reentry_enabled && <option value="OUTSIDE">Outside</option>}
          </Select>
        </label>
        <label>
          Pass
          <Select value={filters.pass_status} onChange={(ev) => set('pass_status', ev.target.value)}>
            <option value="">Any</option>
            <option value="ACTIVE">Has active pass</option>
            <option value="NONE">No active pass</option>
          </Select>
        </label>
        <label>
          Source
          <Select value={filters.source} onChange={(ev) => set('source', ev.target.value)}>
            <option value="">Any</option>
            {Object.entries(SOURCE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </label>
        <label className="check" style={{ minWidth: 0, flex: 0, whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={filters.needs_review === '1'} onChange={(ev) => set('needs_review', ev.target.checked ? '1' : '')} />
          Needs review
        </label>
        <Button variant="subtle">Search</Button>
      </form>
      <div className="spread" style={{ marginBottom: '0.5rem' }}>
        <span className="muted small">{data ? `${data.total} participant${data.total === 1 ? '' : 's'}` : ''}</span>
        {canManage && (
          <div className="row">
            <a className={buttonClass({ variant: 'subtle', size: 'sm' })} href={`/api/admin/events/${e.id}/participants/export.csv${qs({ ...filters, page: undefined })}`}>
              Export participants
            </a>
            <a className={buttonClass({ variant: 'subtle', size: 'sm' })} href={`/api/admin/events/${e.id}/attendance.csv`}>
              Export attendance
            </a>
          </div>
        )}
      </div>
      <ErrorMessage error={error} />
      {data && (
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Reference</th>
                <th>Country</th>
                <th>Contact</th>
                <th>Pass</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {data.participants.map((p) => (
                <tr key={p.id} className={p.status !== 'ACTIVE' ? 'dim' : undefined}>
                  <td>
                    <Link to={`/admin/events/${e.id}/participants/${p.id}`}>{p.name}</Link>
                    <div className="small muted">
                      {SOURCE_LABEL[p.registration_source]}
                      {p.status !== 'ACTIVE' && ` · ${p.status.toLowerCase()}`}
                      {p.needs_review && ' · needs review'}
                    </div>
                  </td>
                  <td className="mono">{p.registration_reference}</td>
                  <td>{p.country}</td>
                  <td className="small">
                    {p.email}
                    {p.phone && <div>{p.phone}</div>}
                  </td>
                  <td>
                    {p.active_credential_id ? <StatusBadge status="ACTIVE" /> : <span className="muted small">none</span>}
                    {p.last_delivery_status && <div className="small muted">email {p.last_delivery_status.toLowerCase()}</div>}
                  </td>
                  <td>{stateLabel(p, e.reentry_enabled)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {pages > 1 && (
        <div className="row" style={{ justifyContent: 'center', marginTop: '1rem' }}>
          <Button variant="subtle" size="sm" disabled={Number(filters.page) <= 1} onClick={() => set('page', String(Number(filters.page) - 1))}>
            Previous
          </Button>
          <span className="small muted">
            Page {filters.page} of {pages}
          </span>
          <Button variant="subtle" size="sm" disabled={Number(filters.page) >= pages} onClick={() => set('page', String(Number(filters.page) + 1))}>
            Next
          </Button>
        </div>
      )}
    </>
  );
}
