import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth';
import { signInAsDemo } from '../../components/demoKit';
import { ErrorMessage } from '../../components/ui';
import { loadDemo } from '../../demoInfo';

/** /demo/signin/:key?next=… — one scan signs a phone in as a demo account (demo mode only). */
export function DemoSignInPage() {
  const { key = '' } = useParams();
  const [params] = useSearchParams();
  const next = params.get('next');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
  const { user, setUser, loading } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (loading) return;
    void (async () => {
      const demo = await loadDemo();
      if (!demo?.seeded) {
        setError(new Error('Demo mode is off.'));
        return;
      }
      try {
        await signInAsDemo(demo, key, user, setUser);
        navigate(safeNext, { replace: true });
      } catch (err) {
        setError(err);
      }
    })();
    // Run once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  return error ? <ErrorMessage error={error} /> : <p className="muted">Signing in…</p>;
}

/** Landing page for a phone that has just become a gate scanner. */
export function DemoPhonePage() {
  const { user } = useAuth();
  return (
    <div className="center" style={{ paddingTop: '2rem' }}>
      <p className="muted">This phone is signed in as</p>
      <h1>{user?.name ?? '…'}</h1>
      <p className="lead">Now point the camera at a participant’s pass QR and tap the link. You’ll get Entry / Exit buttons.</p>
    </div>
  );
}
