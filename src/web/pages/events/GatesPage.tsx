import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { ErrorMessage, StatusBadge, TableWrap, useLoad } from '../../components/ui';
import { useEventContext } from './EventLayout';
import { Button, buttonClass, Input, Select } from '../../components/fui';

interface Gate {
  id: string;
  name: string;
  mode: 'ENTRY' | 'EXIT';
  location_description: string;
  status: 'ACTIVE' | 'INACTIVE';
  operators: { id: string; name: string; email: string }[];
}

export function GatesPage() {
  const { event: e } = useEventContext();
  const { data, error, reload } = useLoad(() => api.get<{ gates: Gate[] }>(`/admin/events/${e.id}/gates`), [e.id]);
  const [form, setForm] = useState({ name: '', mode: 'ENTRY', location_description: '' });
  const [assign, setAssign] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<unknown>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setActionError(err);
    }
  };

  async function create(ev: FormEvent) {
    ev.preventDefault();
    await run(() => api.post(`/admin/events/${e.id}/gates`, form));
    setForm({ ...form, name: '', location_description: '' });
  }

  return (
    <>
      <p className="muted">
        Each scanning station is fixed to ENTRY or EXIT mode.{' '}
        {e.reentry_enabled ? 'Use separate gates for entry and exit.' : 'This event uses single check-in, so only ENTRY gates are needed.'} Gate operators can only use
        gates they are assigned to; desk staff and managers can use any gate.
      </p>
      <ErrorMessage error={error ?? actionError} />
      {data && data.gates.length > 0 && (
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Gate</th>
                <th>Mode</th>
                <th>Status</th>
                <th>Operators</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.gates.map((g) => (
                <tr key={g.id}>
                  <td>
                    {g.name}
                    <div className="small muted">{g.location_description}</div>
                  </td>
                  <td>
                    <Select
                      value={g.mode}
                      style={{ width: 'auto', padding: '0.2rem 0.4rem' }}
                      onChange={(ev) => run(() => api.patch(`/admin/event-gates/${g.id}`, { mode: ev.target.value }))}
                    >
                      <option>ENTRY</option>
                      <option>EXIT</option>
                    </Select>
                  </td>
                  <td>
                    <StatusBadge status={g.status} />
                  </td>
                  <td className="small">
                    {g.operators.map((o) => (
                      <div key={o.id}>
                        {o.name}{' '}
                        <Button variant="ghost" className="small" onClick={() => run(() => api.post(`/admin/event-gates/${g.id}/operators`, { email: o.email, remove: true }))}>
                          remove
                        </Button>
                      </div>
                    ))}
                    <form
                      className="row"
                      style={{ marginTop: '0.25rem', flexWrap: 'nowrap' }}
                      onSubmit={(ev) => {
                        ev.preventDefault();
                        void run(() => api.post(`/admin/event-gates/${g.id}/operators`, { email: assign[g.id] ?? '' }));
                        setAssign({ ...assign, [g.id]: '' });
                      }}
                    >
                      <Input
                        placeholder="operator email"
                        value={assign[g.id] ?? ''}
                        onChange={(ev) => setAssign({ ...assign, [g.id]: ev.target.value })}
                        style={{ padding: '0.25rem 0.4rem', minWidth: 160 }}
                      />
                      <Button variant="subtle" size="sm">Assign</Button>
                    </form>
                  </td>
                  <td>
                    <div className="row">
                      <Link className={buttonClass({ variant: 'subtle', size: 'sm' })} to={`/staff/gate/${g.id}`}>
                        Open scanner
                      </Link>
                      <Button variant="subtle" size="sm"
                       
                        onClick={() => run(() => api.patch(`/admin/event-gates/${g.id}`, { status: g.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }))}
                      >
                        {g.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <div className="section" style={{ maxWidth: 560 }}>
        <h2>Add gate</h2>
        <form onSubmit={create}>
          <div className="form-grid">
            <label>
              Name
              <Input value={form.name} onChange={(ev) => setForm({ ...form, name: ev.target.value })} required placeholder="e.g. Participant entry" />
            </label>
            <label>
              Mode
              <Select value={form.mode} onChange={(ev) => setForm({ ...form, mode: ev.target.value })}>
                <option>ENTRY</option>
                {e.reentry_enabled && <option>EXIT</option>}
              </Select>
            </label>
          </div>
          <label>
            Location <span className="muted">(optional)</span>
            <Input value={form.location_description} onChange={(ev) => setForm({ ...form, location_description: ev.target.value })} />
          </label>
          <Button variant="solid">Add gate</Button>
        </form>
      </div>
    </>
  );
}
