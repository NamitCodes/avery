import { Link, NavLink, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { DESK_STAFF, EVENT_MANAGERS, GATE_STAFF } from './api';
import { RequireAuth, useAuth } from './auth';
import { AuditPage } from './pages/admin/AuditPage';
import { LocationDetailPage } from './pages/admin/LocationDetailPage';
import { LocationsPage } from './pages/admin/LocationsPage';
import { QrPrintPage } from './pages/admin/QrPrintPage';
import { SessionDetailPage } from './pages/admin/SessionDetailPage';
import { SessionFormPage } from './pages/admin/SessionFormPage';
import { SessionsPage } from './pages/admin/SessionsPage';
import { VolunteerDetailPage } from './pages/admin/VolunteerDetailPage';
import { VolunteersPage } from './pages/admin/VolunteersPage';
import { EventFormPage } from './pages/events/EventFormPage';
import { EventLayout } from './pages/events/EventLayout';
import { EventOverviewPage } from './pages/events/EventOverviewPage';
import { EventsPage } from './pages/events/EventsPage';
import { AccessLogPage } from './pages/events/AccessLogPage';
import { DeliveriesPage } from './pages/events/DeliveriesPage';
import { GatesPage } from './pages/events/GatesPage';
import { ImportPage } from './pages/events/ImportPage';
import { ParticipantDetailPage } from './pages/events/ParticipantDetailPage';
import { ParticipantsPage } from './pages/events/ParticipantsPage';
import { PassPrintPage } from './pages/events/PassPrintPage';
import { DeskPage } from './pages/staff/DeskPage';
import { GateScannerPage } from './pages/staff/GateScannerPage';
import { StationsPage } from './pages/staff/StationsPage';
import { PublicPassPage } from './pages/public/PublicPassPage';
import { PublicRegistrationPage } from './pages/public/PublicRegistrationPage';
import { CheckInPage } from './pages/CheckInPage';
import { DemoPage } from './pages/DemoPage';
import { DemoIndexPage } from './pages/demo/DemoIndexPage';
import { DemoOpenEventPage } from './pages/demo/DemoOpenEventPage';
import { DemoPhonePage, DemoSignInPage } from './pages/demo/DemoPhonePages';
import { DemoSummitPage } from './pages/demo/DemoSummitPage';
import { DemoVolunteerPage } from './pages/demo/DemoVolunteerPage';
import { useDemo } from './demoInfo';
import { HomePage } from './pages/HomePage';
import { LoginPage, RegisterPage } from './pages/LoginPage';
import { MyAttendancePage } from './pages/MyAttendancePage';

function Layout({ narrow = false }: { narrow?: boolean }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const is = (roles: string[]) => !!user && roles.includes(user.role);
  const demo = useDemo();
  return (
    <>
      {demo && (
        <div className="demo-banner no-print">
          Demo mode — sample data only. <Link to="/demo">Demos</Link>
          {user && (
            <span className="muted">
              {' '}
              · signed in as {user.name}
            </span>
          )}
        </div>
      )}
      <header className="topbar">
        <Link to="/" className="brand">
          Attendance
        </Link>
        <nav>
          {demo && <NavLink to="/demo">Demos</NavLink>}
          {user && <NavLink to="/me/attendance">My attendance</NavLink>}
          {user?.role === 'ADMIN' && (
            <>
              <NavLink to="/admin/sessions">Sessions</NavLink>
              <NavLink to="/admin/venues">Venues</NavLink>
              <NavLink to="/admin/volunteers">People</NavLink>
              <NavLink to="/admin/audit">Audit</NavLink>
            </>
          )}
          {is(DESK_STAFF) && <NavLink to="/admin/events">Events</NavLink>}
          {is(GATE_STAFF) && <NavLink to="/staff">Stations</NavLink>}
          {user ? (
            <button
              className="btn-link"
              onClick={async () => {
                await logout();
                navigate('/login');
              }}
            >
              Sign out
            </button>
          ) : (
            <NavLink to="/login">Sign in</NavLink>
          )}
        </nav>
      </header>
      <main className={narrow ? 'narrow' : undefined}>
        <Outlet />
      </main>
    </>
  );
}

export function App() {
  return (
    <Routes>
      {/* Full-screen / print views without the app chrome */}
      <Route path="/admin/qr/:qrId/print" element={<RequireAuth roles={['ADMIN']}><QrPrintPage /></RequireAuth>} />
      <Route path="/admin/event-passes/:credentialId/print" element={<RequireAuth roles={DESK_STAFF}><PassPrintPage /></RequireAuth>} />
      <Route path="/staff/gate/:gateId" element={<RequireAuth roles={GATE_STAFF}><GateScannerPage /></RequireAuth>} />
      <Route path="/pass/:token" element={<PublicPassPage />} />

      <Route element={<Layout narrow />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/check-in/v/:venueId" element={<RequireAuth><CheckInPage /></RequireAuth>} />
        <Route path="/events/:eventId/register" element={<PublicRegistrationPage />} />
        <Route path="/demo/signin/:key" element={<DemoSignInPage />} />
        <Route path="/demo/phone" element={<RequireAuth><DemoPhonePage /></RequireAuth>} />
      </Route>

      <Route element={<Layout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/demo" element={<DemoIndexPage />} />
        <Route path="/demo/full" element={<DemoPage />} />
        <Route path="/demo/volunteers" element={<DemoVolunteerPage />} />
        <Route path="/demo/summit" element={<DemoSummitPage />} />
        <Route path="/demo/open-event" element={<DemoOpenEventPage />} />
        <Route path="/me/attendance" element={<RequireAuth><MyAttendancePage /></RequireAuth>} />

        <Route path="/admin/sessions" element={<RequireAuth roles={['ADMIN']}><SessionsPage /></RequireAuth>} />
        <Route path="/admin/sessions/new" element={<RequireAuth roles={['ADMIN']}><SessionFormPage /></RequireAuth>} />
        <Route path="/admin/sessions/:id" element={<RequireAuth roles={['ADMIN']}><SessionDetailPage /></RequireAuth>} />
        <Route path="/admin/sessions/:id/edit" element={<RequireAuth roles={['ADMIN']}><SessionFormPage /></RequireAuth>} />
        <Route path="/admin/venues" element={<RequireAuth roles={['ADMIN']}><LocationsPage /></RequireAuth>} />
        <Route path="/admin/venues/:id" element={<RequireAuth roles={['ADMIN']}><LocationDetailPage /></RequireAuth>} />
        <Route path="/admin/volunteers" element={<RequireAuth roles={['ADMIN']}><VolunteersPage /></RequireAuth>} />
        <Route path="/admin/volunteers/:id" element={<RequireAuth roles={['ADMIN']}><VolunteerDetailPage /></RequireAuth>} />
        <Route path="/admin/audit" element={<RequireAuth roles={['ADMIN']}><AuditPage /></RequireAuth>} />

        <Route path="/admin/events" element={<RequireAuth roles={DESK_STAFF}><EventsPage /></RequireAuth>} />
        <Route path="/admin/events/new" element={<RequireAuth roles={EVENT_MANAGERS}><EventFormPage /></RequireAuth>} />
        <Route path="/admin/events/:eventId" element={<RequireAuth roles={DESK_STAFF}><EventLayout /></RequireAuth>}>
          <Route index element={<EventOverviewPage />} />
          <Route path="settings" element={<EventFormPage />} />
          <Route path="participants" element={<ParticipantsPage />} />
          <Route path="participants/:participantId" element={<ParticipantDetailPage />} />
          <Route path="import" element={<ImportPage />} />
          <Route path="gates" element={<GatesPage />} />
          <Route path="access" element={<AccessLogPage />} />
          <Route path="deliveries" element={<DeliveriesPage />} />
        </Route>

        <Route path="/staff" element={<RequireAuth roles={GATE_STAFF}><StationsPage /></RequireAuth>} />
        <Route path="/staff/desk/:eventId" element={<RequireAuth roles={DESK_STAFF}><DeskPage /></RequireAuth>} />
        <Route path="*" element={<p className="muted">Page not found.</p>} />
      </Route>
    </Routes>
  );
}
