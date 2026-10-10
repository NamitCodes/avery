import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { ErrorMessage, TableWrap, useLoad } from '../../components/ui';
import { formatDateTime } from '../../format';
import { useEventContext } from './EventLayout';
import { Button, Select } from '../../components/fui';

interface Row {
  row: number;
  name: string;
  country: string;
  email: string;
  action: 'CREATE' | 'UPDATE' | 'SKIP' | 'ERROR';
  errors: string[];
  flags: string[];
}
interface Preview {
  headers: string[];
  mapping: { name: number; country: number; email: number };
  rows: Row[];
  summary: { total: number; create: number; update: number; skip: number; error: number; flagged: number };
}
interface ImportRecord {
  id: string;
  created_at: string;
  source_filename: string | null;
  uploaded_by_name: string | null;
  rows_processed: number;
  rows_created: number;
  rows_updated: number;
  rows_skipped: number;
  rows_failed: number;
  rows_flagged: number;
}

const MESSAGES: Record<string, string> = {
  NAME_REQUIRED: 'Name missing',
  NAME_TOO_LONG: 'Name too long',
  COUNTRY_REQUIRED: 'Country missing',
  EMAIL_REQUIRED: 'Email missing',
  EMAIL_INVALID: 'Email invalid',
  ALREADY_IMPORTED: 'Already imported',
  EMAIL_SHARED_WITH_DIFFERENT_NAME: 'Email shared with a different name — flagged for review',
  POSSIBLE_DUPLICATE_PERSON: 'Same name already registered — flagged for review',
};
const describe = (code: string) => MESSAGES[code] ?? code.replace(/^DUPLICATE_OF_ROW_(\d+)$/, 'Duplicate of row $1');

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Upload → preview & map columns → confirm. The server re-validates on commit; re-uploading is safe. */
export function ImportPage() {
  const { event: e } = useEventContext();
  const history = useLoad(() => api.get<{ imports: ImportRecord[] }>(`/admin/events/${e.id}/imports`), [e.id]);
  const [file, setFile] = useState<{ name: string; base64: string } | null>(null);
  const [mapping, setMapping] = useState<Preview['mapping'] | null>(null);
  const [policy, setPolicy] = useState<'SKIP' | 'UPDATE'>('SKIP');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [result, setResult] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function runPreview(f = file, m = mapping, p = policy) {
    if (!f) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.post<Preview>(`/admin/events/${e.id}/participants/import/preview`, {
        file_base64: f.base64,
        filename: f.name,
        mapping: m ?? undefined,
        existing_policy: p,
      });
      setPreview(res);
      setHeaders(res.headers);
      setMapping(res.mapping);
    } catch (err) {
      const details = (err as { details?: { headers?: string[] } }).details;
      if (details?.headers) setHeaders(details.headers);
      setPreview(null);
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!file || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<Record<string, number>>(`/admin/events/${e.id}/participants/import/commit`, {
        file_base64: file.base64,
        filename: file.name,
        mapping,
        existing_policy: policy,
      });
      setResult(res);
      setPreview(null);
      setFile(null);
      await history.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="muted">
        Upload a CSV (UTF-8) with name, country and email columns. Nothing is saved until you confirm. Uploading the same file again will not create
        duplicates.
      </p>
      <div className="row">
        <input
          type="file"
          accept=".csv,text/csv"
          style={{ maxWidth: 360 }}
          onChange={async (ev) => {
            const f = ev.target.files?.[0];
            if (!f) return;
            const next = { name: f.name, base64: await toBase64(f) };
            setFile(next);
            setMapping(null);
            await runPreview(next, null);
          }}
        />
        <label style={{ margin: 0 }}>
          Existing participants
          <Select
            value={policy}
            onChange={(ev) => {
              const p = ev.target.value as 'SKIP' | 'UPDATE';
              setPolicy(p);
              void runPreview(file, mapping, p);
            }}
          >
            <option value="SKIP">Skip (leave unchanged)</option>
            <option value="UPDATE">Update name/country/email</option>
          </Select>
        </label>
      </div>

      {headers.length > 0 && file && (
        <div className="form-grid" style={{ marginTop: '1rem' }}>
          {(['name', 'country', 'email'] as const).map((k) => (
            <label key={k}>
              Column for {k}
              <Select
                value={mapping?.[k] ?? ''}
                onChange={(ev) => {
                  const m = { ...(mapping ?? { name: -1, country: -1, email: -1 }), [k]: Number(ev.target.value) };
                  setMapping(m);
                  if (m.name >= 0 && m.country >= 0 && m.email >= 0) void runPreview(file, m);
                }}
              >
                <option value="">Choose…</option>
                {headers.map((h, i) => (
                  <option key={i} value={i}>
                    {h || `Column ${i + 1}`}
                  </option>
                ))}
              </Select>
            </label>
          ))}
        </div>
      )}

      <ErrorMessage error={error} />
      {busy && <p className="muted">Working…</p>}
      {result && (
        <div className="alert alert-ok">
          Import complete: {result.created} created, {result.updated} updated, {result.skipped} skipped, {result.failed} with errors, {result.flagged} flagged for
          review. <Link to={`/admin/events/${e.id}/participants`}>View participants</Link>
        </div>
      )}

      {preview && (
        <div className="section">
          <div className="spread">
            <h2>Preview</h2>
            <Button variant="solid" disabled={busy || preview.summary.create + preview.summary.update === 0} onClick={commit}>
              Import {preview.summary.create} new{preview.summary.update ? `, update ${preview.summary.update}` : ''}
            </Button>
          </div>
          <p className="small">
            {preview.summary.total} rows · <strong>{preview.summary.create}</strong> new · {preview.summary.update} update · {preview.summary.skip} skip ·{' '}
            <span style={{ color: preview.summary.error ? 'var(--bad)' : undefined }}>{preview.summary.error} errors</span> · {preview.summary.flagged} flagged
          </p>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Name</th>
                  <th>Country</th>
                  <th>Email</th>
                  <th>Action</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.row} className={r.action === 'SKIP' ? 'dim' : undefined}>
                    <td>{r.row}</td>
                    <td>{r.name}</td>
                    <td>{r.country}</td>
                    <td>{r.email}</td>
                    <td>
                      <span className={`badge ${r.action === 'ERROR' ? 'badge-failed' : r.action === 'CREATE' ? 'badge-active' : ''}`}>{r.action}</span>
                    </td>
                    <td className="small">{[...r.errors, ...r.flags].map(describe).join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          {preview.rows.length < preview.summary.total && (
            <p className="small muted">Showing all rows with errors or flags, plus the first 50 rows.</p>
          )}
        </div>
      )}

      <div className="section">
        <h2>Previous imports</h2>
        {history.data?.imports.length === 0 && <p className="muted">None yet.</p>}
        {history.data && history.data.imports.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>File</th>
                <th>By</th>
                <th className="right">Rows</th>
                <th className="right">Created</th>
                <th className="right">Updated</th>
                <th className="right">Skipped</th>
                <th className="right">Failed</th>
              </tr>
            </thead>
            <tbody>
              {history.data.imports.map((i) => (
                <tr key={i.id}>
                  <td>{formatDateTime(i.created_at, e.timezone)}</td>
                  <td>{i.source_filename}</td>
                  <td>{i.uploaded_by_name}</td>
                  <td className="right">{i.rows_processed}</td>
                  <td className="right">{i.rows_created}</td>
                  <td className="right">{i.rows_updated}</td>
                  <td className="right">{i.rows_skipped}</td>
                  <td className="right">{i.rows_failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
