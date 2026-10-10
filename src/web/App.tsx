import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { DESK_STAFF, EVENT_MANAGERS, GATE_STAFF } from './api';
import { AppShell, PlainShell } from './components/AppShell';
import { RequireAuth } from './auth';
import { GateScannerPage } from './pages/staff/GateScannerPage';
import { PublicPassPage } from './pages/public/PublicPassPage';
import { PublicRegistrationPage } from './pages/public/PublicRegistrationPage';
import { CheckInPage } from './pages/CheckInPage';
import { DemoPhonePage, DemoSignInPage } from './pages/demo/DemoPhonePages';
import { HomePage } from './pages/HomePage';
import { LoginPage, RegisterPage } from './pages/LoginPage';
import { MyAttendancePage } from './pages/MyAttendancePage';

// Admin, event-management and demo screens load on demand; phone-facing pages stay in the main bundle.
const AuditPage = lazy(() => import('./pages/admin/AuditPage').then((m) => ({ default: m.AuditPage })));
const LocationDetailPage = lazy(() => import('./pages/admin/LocationDetailPage').then((m) => ({ default: m.LocationDetailPage })));
const LocationsPage = lazy(() => import('./pages/admin/LocationsPage').then((m) => ({ default: m.LocationsPage })));
const QrPrintPage = lazy(() => import('./pages/admin/QrPrintPage').then((m) => ({ default: m.QrPrintPage })));
const SessionDetailPage = lazy(() => import('./pages/admin/SessionDetailPage').then((m) => ({ default: m.SessionDetailPage })));
const SessionFormPage = lazy(() => import('./pages/admin/SessionFormPage').then((m) => ({ default: m.SessionFormPage })));
const SessionsPage = lazy(() => import('./pages/admin/SessionsPage').then((m) => ({ default: m.SessionsPage })));
const VolunteerDetailPage = lazy(() => import('./pages/admin/VolunteerDetailPage').then((m) => ({ default: m.VolunteerDetailPage })));
const VolunteersPage = lazy(() => import('./pages/admin/VolunteersPage').then((m) => ({ default: m.VolunteersPage })));
const EventFormPage = lazy(() => import('./pages/events/EventFormPage').then((m) => ({ default: m.EventFormPage })));
const EventLayout = lazy(() => import('./pages/events/EventLayout').then((m) => ({ default: m.EventLayout })));
const EventOverviewPage = lazy(() => import('./pages/events/EventOverviewPage').then((m) => ({ default: m.EventOverviewPage })));
const EventsPage = lazy(() => import('./pages/events/EventsPage').then((m) => ({ default: m.EventsPage })));
const AccessLogPage = lazy(() => import('./pages/events/AccessLogPage').then((m) => ({ default: m.AccessLogPage })));
const DeliveriesPage = lazy(() => import('./pages/events/DeliveriesPage').then((m) => ({ default: m.DeliveriesPage })));
const GatesPage = lazy(() => import('./pages/events/GatesPage').then((m) => ({ default: m.GatesPage })));
const ImportPage = lazy(() => import('./pages/events/ImportPage').then((m) => ({ default: m.ImportPage })));
const ParticipantDetailPage = lazy(() => import('./pages/events/ParticipantDetailPage').then((m) => ({ default: m.ParticipantDetailPage })));
const ParticipantsPage = lazy(() => import('./pages/events/ParticipantsPage').then((m) => ({ default: m.ParticipantsPage })));
const PassPrintPage = lazy(() => import('./pages/events/PassPrintPage').then((m) => ({ default: m.PassPrintPage })));
const DeskPage = lazy(() => import('./pages/staff/DeskPage').then((m) => ({ default: m.DeskPage })));
const StationsPage = lazy(() => import('./pages/staff/StationsPage').then((m) => ({ default: m.StationsPage })));
const DemoPage = lazy(() => import('./pages/DemoPage').then((m) => ({ default: m.DemoPage })));
const DemoIndexPage = lazy(() => import('./pages/demo/DemoIndexPage').then((m) => ({ default: m.DemoIndexPage })));
const DemoOpenEventPage = lazy(() => import('./pages/demo/DemoOpenEventPage').then((m) => ({ default: m.DemoOpenEventPage })));
const DemoSummitPage = lazy(() => import('./pages/demo/DemoSummitPage').then((m) => ({ default: m.DemoSummitPage })));
const DemoVolunteerPage = lazy(() => import('./pages/demo/DemoVolunteerPage').then((m) => ({ default: m.DemoVolunteerPage })));

export function App() {
  return (
    <Suspense fallback={<p className="muted center" style={{ padding: '3rem' }}>Loading…</p>}>
    <Routes>
      {/* Full-screen / print views without the app chrome */}
      <Route path="/admin/qr/:qrId/print" element={<RequireAuth roles={['ADMIN']}><QrPrintPage /></RequireAuth>} />
      <Route path="/admin/event-passes/:credentialId/print" element={<RequireAuth roles={DESK_STAFF}><PassPrintPage /></RequireAuth>} />
      <Route path="/staff/gate/:gateId" element={<RequireAuth roles={GATE_STAFF}><GateScannerPage /></RequireAuth>} />
      <Route path="/pass/:token" element={<PublicPassPage />} />

      <Route element={<PlainShell />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/check-in/v/:venueId" element={<RequireAuth><CheckInPage /></RequireAuth>} />
        <Route path="/events/:eventId/register" element={<PublicRegistrationPage />} />
        <Route path="/demo/signin/:key" element={<DemoSignInPage />} />
        <Route path="/demo/phone" element={<RequireAuth><DemoPhonePage /></RequireAuth>} />
      </Route>

      <Route element={<AppShell />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/demo" element={<DemoIndexPage />} />
        <Route path="/demo/full" element={<DemoPage />} />
        <Route path="/demo/weekly" element={<DemoVolunteerPage />} />
        <Route path="/demo/planned" element={<DemoSummitPage />} />
        <Route path="/demo/surprise" element={<DemoOpenEventPage />} />
        {/* Earlier demo links keep working. */}
        <Route path="/demo/volunteers" element={<Navigate to="/demo/weekly" replace />} />
        <Route path="/demo/summit" element={<Navigate to="/demo/planned" replace />} />
        <Route path="/demo/open-event" element={<Navigate to="/demo/surprise" replace />} />
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
    </Suspense>
  );
}
