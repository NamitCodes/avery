import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csvCell } from '../src/server/routes/adminReports.js';
import {
  createSession,
  createTestEnv,
  createVenue,
  loginAdmin,
  registerVolunteer,
  type Client,
  type TestEnv,
} from './helpers.js';

let env: TestEnv;
let admin: Client;
let venue: Awaited<ReturnType<typeof createVenue>>;

beforeAll(async () => {
  env = await createTestEnv('2026-10-10T01:00:00Z');
  admin = await loginAdmin(env);
  venue = await createVenue(admin, 'Main Hall');
});
afterAll(() => env.close());

const qr = () => venue.active_qr.public_identifier;

describe('authorization', () => {
  it('anonymous users get 401 and volunteers get 403 on admin endpoints', async () => {
    const vol = await registerVolunteer(env);
    const endpoints = [
      ['get', '/api/admin/sessions'],
      ['get', '/api/admin/locations'],
      ['get', '/api/admin/volunteers'],
      ['get', '/api/admin/audit-logs'],
      ['get', '/api/admin/reports/attendance.csv?from=2026-10-01'],
      ['post', '/api/admin/locations'],
      ['post', '/api/admin/sessions'],
    ] as const;
    for (const [method, url] of endpoints) {
      const anon = await request(env.app)[method](url).set('X-Requested-With', 'fetch');
      expect(anon.status, `${method} ${url}`).toBe(401);
      const asVol = method === 'get' ? await vol.get(url) : await vol.post(url, {});
      expect(asVol.status, `${method} ${url}`).toBe(403);
      expect(asVol.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('a demoted admin loses access immediately', async () => {
    const other = await loginAdmin(env);
    expect((await other.get('/api/admin/sessions')).status).toBe(200);
    await admin.patch(`/api/admin/volunteers/${other.user.id}`, { role: 'VOLUNTEER' });
    expect((await other.get('/api/admin/sessions')).status).toBe(403);
  });

  it('admins cannot lock themselves out', async () => {
    const res = await admin.patch(`/api/admin/volunteers/${admin.user.id}`, { status: 'INACTIVE' });
    expect(res.status).toBe(409);
  });
});

describe('attendance management', () => {
  it('admin sees the session attendance list with volunteer details', async () => {
    env.clock.set('2026-10-10T01:00:00Z');
    const s = await createSession(admin, venue.id, { title: 'Food bank', start: '2026-10-10T09:00', end: '2026-10-10T11:00' });
    const vol = await registerVolunteer(env, 'Alice');
    await vol.post('/api/check-in', { venue_id: qr(), session_id: s.id });

    const list = (await admin.get(`/api/admin/sessions/${s.id}/attendance`)).body.attendance;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ volunteer_name: vol.user.name, volunteer_code: vol.user.volunteer_code, source: 'QR', status: 'ACTIVE' });

    const search = (await admin.get(`/api/admin/sessions/${s.id}/attendance?q=${vol.user.volunteer_code}`)).body.attendance;
    expect(search).toHaveLength(1);
    const none = (await admin.get(`/api/admin/sessions/${s.id}/attendance?q=nobody`)).body.attendance;
    expect(none).toHaveLength(0);

    const detail = (await admin.get(`/api/admin/sessions/${s.id}`)).body;
    expect(detail.attendance_count).toBe(1);
    expect(detail.active_qr.public_identifier).toBe(qr());
  });

  it('manual add requires a reason, is audited, and respects duplicate/session constraints', async () => {
    env.clock.set('2026-10-11T01:00:00Z');
    const s = await createSession(admin, venue.id, { start: '2026-10-11T09:00', end: '2026-10-11T11:00' });
    const vol = await registerVolunteer(env);

    const noReason = await admin.post(`/api/admin/sessions/${s.id}/attendance`, { volunteer_id: vol.user.id });
    expect(noReason.status).toBe(400);

    const ok = await admin.post(`/api/admin/sessions/${s.id}/attendance`, {
      volunteer_id: vol.user.id,
      tapped_in_at: '2026-10-11T08:55',
      reason: 'Phone battery dead',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.attendance.source).toBe('ADMIN');
    expect(ok.body.attendance.created_by).toBe(admin.user.id);
    expect(new Date(ok.body.attendance.tapped_in_at).toISOString()).toBe('2026-10-11T00:55:00.000Z');

    const dup = await admin.post(`/api/admin/sessions/${s.id}/attendance`, { volunteer_id: vol.user.id, reason: 'Again' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_ATTENDANCE');

    // QR check-in after a manual record returns the manual record (no duplicate).
    const scan = await vol.post('/api/check-in', { venue_id: qr(), session_id: s.id });
    expect(scan.status).toBe(200);
    expect(scan.body.attendance.id).toBe(ok.body.attendance.id);

    const future = await admin.post(`/api/admin/sessions/${s.id}/attendance`, {
      volunteer_id: (await registerVolunteer(env)).user.id,
      tapped_in_at: '2026-10-11T23:00',
      reason: 'Typo',
    });
    expect(future.status).toBe(400);
    expect(future.body.error.code).toBe('INVALID_TAP_IN_TIME');

    const audit = (await admin.get(`/api/admin/audit-logs?entity_id=${ok.body.attendance.id}`)).body.audit_logs;
    expect(audit[0]).toMatchObject({ action: 'attendance.add', reason: 'Phone battery dead', actor_id: admin.user.id });
  });

  it('manual add is allowed after closure but not for cancelled sessions', async () => {
    env.clock.set('2026-10-12T01:00:00Z');
    const s = await createSession(admin, venue.id, { start: '2026-10-12T09:00', end: '2026-10-12T10:00' });
    await admin.post(`/api/admin/sessions/${s.id}/close`);
    const vol = await registerVolunteer(env);
    expect((await admin.post(`/api/admin/sessions/${s.id}/attendance`, { volunteer_id: vol.user.id, reason: 'Arrived late' })).status).toBe(201);

    const c = await createSession(admin, venue.id, { start: '2026-10-12T09:00', end: '2026-10-12T10:00' });
    await admin.post(`/api/admin/sessions/${c.id}/cancel`);
    const res = await admin.post(`/api/admin/sessions/${c.id}/attendance`, { volunteer_id: vol.user.id, reason: 'x y z' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SESSION_NOT_ATTENDABLE');
  });

  it('corrections require a reason and preserve the original values in the audit log', async () => {
    env.clock.set('2026-10-13T01:00:00Z');
    const s = await createSession(admin, venue.id, { start: '2026-10-13T09:00', end: '2026-10-13T11:00' });
    const vol = await registerVolunteer(env);
    const rec = (await vol.post('/api/check-in', { venue_id: qr(), session_id: s.id })).body.attendance;
    const original = rec.tapped_in_at;

    const noReason = await admin.patch(`/api/admin/attendance/${rec.id}`, { tapped_in_at: '2026-10-13T08:50' });
    expect(noReason.status).toBe(400);

    env.clock.advance(30);
    const fixed = await admin.patch(`/api/admin/attendance/${rec.id}`, { tapped_in_at: '2026-10-13T08:50', reason: 'Scanned late, arrived on time' });
    expect(fixed.status).toBe(200);
    expect(new Date(fixed.body.attendance.tapped_in_at).toISOString()).toBe('2026-10-13T00:50:00.000Z');

    const voided = await admin.patch(`/api/admin/attendance/${rec.id}`, { status: 'VOIDED', reason: 'Checked in by mistake' });
    expect(voided.body.attendance.status).toBe('VOIDED');
    expect((await admin.get(`/api/admin/sessions/${s.id}`)).body.attendance_count).toBe(0);
    // Voided records remain (not deleted) and block silent re-creation.
    const rescan = await vol.post('/api/check-in', { venue_id: qr(), session_id: s.id });
    expect(rescan.status).toBe(409);
    expect(rescan.body.error.code).toBe('ATTENDANCE_VOIDED');

    const history = (await admin.get(`/api/admin/attendance/${rec.id}/history`)).body.history;
    expect(history.map((h: { action: string }) => h.action)).toEqual(['attendance.correct', 'attendance.void']);
    expect(history[0].before_data.tapped_in_at).toBe(original);
    expect(history[0].reason).toBe('Scanned late, arrived on time');
    expect(history[0].actor_id).toBe(admin.user.id);
  });
});

describe('reports and history', () => {
  it('exports session attendance as CSV', async () => {
    env.clock.set('2026-10-14T01:00:00Z');
    const s = await createSession(admin, venue.id, { title: 'Tutoring', start: '2026-10-14T09:00', end: '2026-10-14T11:00' });
    const a = await registerVolunteer(env, 'Bob');
    const b = await registerVolunteer(env, '=HYPERLINK("x")');
    await a.post('/api/check-in', { venue_id: qr(), session_id: s.id });
    env.clock.advance(2);
    await b.post('/api/check-in', { venue_id: qr(), session_id: s.id });

    const res = await admin.get(`/api/admin/reports/attendance.csv?session_id=${s.id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Activity,Session date,Venue,Volunteer name,Volunteer ID,Tap-in time (venue local),Tap-in time (UTC),Source');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(`Tutoring,2026-10-14,Main Hall,${a.user.name},${a.user.volunteer_code},2026-10-14 09:00:00`);
    expect(lines[1]).toContain('2026-10-14T01:00:00.000Z,QR');
    // Formula injection is neutralised.
    expect(lines[2]).toContain(`"'=HYPERLINK(""x"")`);
  });

  it('requires a filter for exports', async () => {
    expect((await admin.get('/api/admin/reports/attendance.csv')).status).toBe(400);
  });

  it('volunteer history is visible to the volunteer and to admins', async () => {
    env.clock.set('2026-10-15T01:00:00Z');
    const vol = await registerVolunteer(env);
    const s1 = await createSession(admin, venue.id, { title: 'One', start: '2026-10-15T09:00', end: '2026-10-15T10:00' });
    const s2 = await createSession(admin, venue.id, { title: 'Two', start: '2026-10-15T09:00', end: '2026-10-15T10:00' });
    await vol.post('/api/check-in', { venue_id: qr(), session_id: s1.id });
    await vol.post('/api/check-in', { venue_id: qr(), session_id: s2.id });

    const mine = (await vol.get('/api/volunteers/me/attendance')).body.attendance;
    expect(mine.map((m: { title: string }) => m.title).sort()).toEqual(['One', 'Two']);

    const adminView = (await admin.get(`/api/admin/volunteers/${vol.user.id}/attendance`)).body;
    expect(adminView.volunteer.id).toBe(vol.user.id);
    expect(adminView.attendance).toHaveLength(2);

    // A volunteer only ever sees their own history.
    const other = await registerVolunteer(env);
    expect((await other.get('/api/volunteers/me/attendance')).body.attendance).toHaveLength(0);
  });
});

describe('csvCell', () => {
  it('quotes and escapes', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell(null)).toBe('');
  });
});
