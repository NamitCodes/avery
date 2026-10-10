import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, type User } from '../api';
import { useAuth } from '../auth';
import { loadDemo, type DemoInfo } from '../demoInfo';

/** Sign in as a demo account (no-op if already signed in as it). */
export async function signInAsDemo(demo: DemoInfo, key: string, current: User | null, setUser: (u: User) => void) {
  const acct = demo.accounts.find((a) => a.key === key);
  if (!acct) throw new Error(`Unknown demo account ${key}`);
  if (current?.email === acct.email) return;
  if (current) await api.post('/auth/logout');
  const res = await api.post<{ user: User }>('/auth/login', { email: acct.email, password: demo.password });
  setUser(res.user);
}

/**
 * Presenter pages run as the demo administrator: loads demo info and signs the
 * laptop in as admin if needed. `ready` is true once that has happened.
 */
export function usePresenter() {
  const { user, setUser, loading } = useAuth();
  const [demo, setDemo] = useState<DemoInfo | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    void loadDemo().then(setDemo);
  }, []);
  useEffect(() => {
    if (loading || !demo?.seeded) return;
    signInAsDemo(demo, 'admin', user, setUser).catch(setError);
  }, [demo, user, loading, setUser]);
  const adminEmail = demo?.accounts.find((a) => a.key === 'admin')?.email;
  return { demo, error, ready: !!demo?.seeded && !!user && user.email === adminEmail };
}

/** Run `fn` now and every `ms` while `active`. */
export function usePolling(fn: () => void | Promise<void>, ms: number, active: boolean) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    void ref.current();
    const t = setInterval(() => void ref.current(), ms);
    return () => clearInterval(t);
  }, [ms, active]);
}

export const qrSrc = (text: string) => `/api/demo/qr.svg?text=${encodeURIComponent(text)}`;

export function DemoPageShell({ title, intro, demo, error, children }: { title: string; intro: ReactNode; demo: DemoInfo | null | undefined; error?: unknown; children: ReactNode }) {
  if (demo === undefined) return <p className="muted">Loading…</p>;
  if (!demo?.seeded) {
    return (
      <>
        <h1>{title}</h1>
        <p className="muted">Demo mode is off or demo data is not loaded. Start with <code className="mono">npm run demo</code>.</p>
      </>
    );
  }
  return (
    <div className="simple-demo">
      <p className="small muted">
        <Link to="/demo">Demos</Link> /
      </p>
      <h1>{title}</h1>
      <p className="lead">{intro}</p>
      <PhoneReachability demo={demo} />
      {error ? <div className="alert alert-error">Could not sign in as the demo administrator. Reload the page.</div> : null}
      {children}
    </div>
  );
}

/** Phones can't open "localhost" links; say so before the audience tries. */
export function PhoneReachability({ demo }: { demo: DemoInfo }) {
  if (!/localhost|127\.0\.0\.1/.test(demo.public_base_url)) return null;
  return (
    <div className="alert alert-warn">
      QR codes currently point to <code className="mono">{demo.public_base_url}</code>, which a phone cannot open. Use the Render deployment, or restart with{' '}
      <code className="mono">PUBLIC_BASE_URL=http://&lt;laptop-IP&gt;:5173</code> on the same Wi-Fi.
    </div>
  );
}

export function DemoStep({ n, who, title, children }: { n: number; who: 'Laptop' | 'Phone' | 'Screen'; title: string; children: ReactNode }) {
  return (
    <section className="demo-step">
      <div className="demo-step-head">
        <span className="demo-step-n">{n}</span>
        <span className={`demo-who demo-who-${who.toLowerCase()}`}>{who}</span>
        <h2>{title}</h2>
      </div>
      <div className="demo-step-body">{children}</div>
    </section>
  );
}

export function BigQr({ src, url, caption }: { src: string; url: string; caption?: ReactNode }) {
  return (
    <figure className="big-qr">
      <img src={src} alt={`QR code for ${url}`} />
      {caption && <figcaption>{caption}</figcaption>}
      <div className="small muted mono" style={{ wordBreak: 'break-all' }}>
        {url}
      </div>
    </figure>
  );
}
