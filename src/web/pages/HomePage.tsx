import { Link } from 'react-router-dom';
import { DESK_STAFF, GATE_STAFF, ROLE_LABEL } from '../api';
import { useAuth } from '../auth';
import { useDemo } from '../demoInfo';

export function HomePage() {
  const { user, loading } = useAuth();
  const demo = useDemo();
  if (loading) return null;
  const demoCard = demo && (
    <div className="card" style={{ marginBottom: '1.5rem' }}>
      <strong>This is a demo.</strong>{' '}
      <span className="muted">Step-by-step scripts, one-click sign-in for every role and sample passes are in the </span>
      <Link to="/demo">demo guide</Link>.
    </div>
  );
  if (!user) {
    return (
      <div style={{ maxWidth: 520 }}>
        {demoCard}
        <h1>Volunteer attendance</h1>
        <p className="muted">Scan the QR code displayed at your venue to record your attendance at an activity.</p>
        <div className="row">
          <Link className="btn" to="/login">
            Sign in
          </Link>
          <Link className="btn btn-secondary" to="/register">
            Create account
          </Link>
        </div>
      </div>
    );
  }
  return (
    <>
      {demoCard}
      <h1>Hello, {user.name}</h1>
      <p className="muted">
        {ROLE_LABEL[user.role]} · ID <span className="mono">{user.volunteer_code}</span>
      </p>
      <div className="grid" style={{ marginTop: '1.5rem' }}>
        <Link className="card" to="/me/attendance" style={{ textDecoration: 'none' }}>
          <strong>My attendance</strong>
          <p className="muted small">Sessions you have checked in to.</p>
        </Link>
        {user.role === 'ADMIN' && (
          <>
            <Link className="card" to="/admin/sessions" style={{ textDecoration: 'none' }}>
              <strong>Sessions</strong>
              <p className="muted small">Schedule activities and view live attendance.</p>
            </Link>
            <Link className="card" to="/admin/venues" style={{ textDecoration: 'none' }}>
              <strong>Venues & QR codes</strong>
              <p className="muted small">Print, revoke and replace venue QR codes.</p>
            </Link>
          </>
        )}
        {DESK_STAFF.includes(user.role) && (
          <Link className="card" to="/admin/events" style={{ textDecoration: 'none' }}>
            <strong>Events</strong>
            <p className="muted small">Participants, passes, gates and occupancy.</p>
          </Link>
        )}
        {GATE_STAFF.includes(user.role) && (
          <Link className="card" to="/staff" style={{ textDecoration: 'none' }}>
            <strong>Scanning stations</strong>
            <p className="muted small">Open a gate scanner or the exception desk.</p>
          </Link>
        )}
      </div>
      <p className="muted small" style={{ marginTop: '2rem' }}>
        To check in, scan the QR code displayed at the venue with your phone camera.
      </p>
    </>
  );
}
