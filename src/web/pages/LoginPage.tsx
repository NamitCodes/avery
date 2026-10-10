import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type User } from '../api';
import { useAuth } from '../auth';
import { ErrorMessage } from '../components/ui';
import { useDemo } from '../demoInfo';
import { Button, Input } from '../components/fui';

/** Only allow same-site relative redirects after sign-in. */
function safeNext(next: string | null) {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const demo = useDemo();

  if (user) return <Navigate to={next} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ user: User }>('/auth/login', { email, password });
      setUser(res.user);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Sign in</h1>
      {demo?.seeded && (
        <div className="card demo-quick">
          <p className="small" style={{ marginTop: 0 }}>
            <strong>Demo:</strong> tap an account to sign in (password <code className="mono">{demo.password}</code>).
          </p>
          {demo.accounts.map((a) => (
            <button
              key={a.key}
              type="button"
              className="choice"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const res = await api.post<{ user: User }>('/auth/login', { email: a.email, password: demo.password });
                  setUser(res.user);
                  navigate(next, { replace: true });
                } catch (err) {
                  setError(err);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <strong>{a.name}</strong> <span className="small muted">— {a.label}</span>
            </button>
          ))}
        </div>
      )}
      {next.startsWith('/check-in/') && <p className="muted">Sign in to record your attendance. You’ll return to the check-in page afterwards.</p>}
      <form onSubmit={submit}>
        <label>
          Email
          <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <ErrorMessage error={error} />
        <Button variant="solid" size="lg" className="w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <p className="muted small" style={{ marginTop: '1.25rem' }}>
        New volunteer? <Link to={`/register?next=${encodeURIComponent(next)}`}>Create an account</Link>
      </p>
    </>
  );
}

export function RegisterPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={next} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ user: User }>('/auth/register', form);
      setUser(res.user);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Create volunteer account</h1>
      <form onSubmit={submit}>
        <label>
          Full name
          <Input autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </label>
        <label>
          Email
          <Input type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        </label>
        <label>
          Password <span className="muted">(at least 8 characters)</span>
          <Input
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
          />
        </label>
        <ErrorMessage error={error} />
        <Button variant="solid" size="lg" className="w-full" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </Button>
      </form>
      <p className="muted small" style={{ marginTop: '1.25rem' }}>
        Already registered? <Link to={`/login?next=${encodeURIComponent(next)}`}>Sign in</Link>
      </p>
    </>
  );
}
