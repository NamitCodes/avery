import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runSessionScheduler } from '../src/server/services/sessions.js';
import {
  Client,
  countAttendance,
  createSession,
  createTestEnv,
  createVenue,
  loginAdmin,
  registerVolunteer,
  type TestEnv,
} from './helpers.js';

let env: TestEnv;
let admin: Client;
let venue: Awaited<ReturnType<typeof createVenue>>;
let otherVenue: Awaited<ReturnType<typeof createVenue>>;
let day = 0;

beforeAll(async () => {
  env = await createTestEnv();
  admin = await loginAdmin(env);
  venue = await createVenue(admin, 'Hall A');
  otherVenue = await createVenue(admin, 'Hall B');
});
afterAll(() => env.close());

/** Each test runs on its own day so sessions don't interfere; clock = 09:00 SGT that day. */
let date: string;
beforeEach(() => {
  day += 1;
  date = `2026-11-${String(day).padStart(2, '0')}`;
  env.clock.set(`${date}T01:00:00Z`);
});

const checkIn = (c: Client, sessionId: string, venueId = venue.active_qr.public_identifier, extra: object = {}) =>
  c.post('/api/check-in', { venue_id: venueId, session_id: sessionId, ...extra });

describe('venue landing page', () => {
  it('requires authentication', async () => {
    const res = await request(env.app).get(`/api/check-in/venues/${venue.active_qr.public_identifier}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('lists only sessions at this venue currently accepting check-ins, including overlaps', async () => {
    const vol = await registerVolunteer(env);
    const a = await createSession(admin, venue.id, { title: 'Morning A', start: `${date}T09:00`, end: `${date}T12:00` });
    const b = await createSession(admin, venue.id, { title: 'Morning B', start: `${date}T09:15`, end: `${date}T11:00` });
    await createSession(admin, venue.id, { title: 'Afternoon', start: `${date}T15:00`, end: `${date}T17:00` });
    await createSession(admin, venue.id, { title: 'Draft', start: `${date}T09:00`, end: `${date}T10:00`, publish: false });
    await createSession(admin, otherVenue.id, { title: 'Elsewhere', start: `${date}T09:00`, end: `${date}T10:00` });

    const res = await vol.get(`/api/check-in/venues/${venue.active_qr.public_identifier}`);
    expect(res.status).toBe(200);
    expect(res.body.venue.name).toBe('Hall A');
    expect(res.body.sessions.map((s: { id: string }) => s.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('explains when nothing is available', async () => {
    const vol = await registerVolunteer(env);
    const res = await vol.get(`/api/check-in/venues/${otherVenue.active_qr.public_identifier}`);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
    expect(res.body.message).toBe('There are no activities currently accepting attendance at this venue.');
  });

  it('returns 404 for unknown or malformed venue identifiers', async () => {
    const vol = await registerVolunteer(env);
    expect((await vol.get('/api/check-in/venues/AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404);
    expect((await vol.get('/api/check-in/venues/..%2F..%2Fetc')).status).toBe(404);
    expect((await vol.get(`/api/check-in/venues/${venue.id}`)).status).toBe(404); // internal id is not the QR id
  });
});

describe('check-in', () => {
  it('rejects unauthenticated submissions without creating a record', async () => {
    const s = await createSession(admin, venue.id, { start: `${date}T09:00`, end: `${date}T10:00` });
    const res = await request(env.app)
      .post('/api/check-in')
      .set('X-Requested-With', 'fetch')
      .send({ venue_id: venue.active_qr.public_identifier, session_id: s.id });
    expect(res.status).toBe(401);
    expect(await countAttendance(env, s.id)).toBe(0);
  });

  it('records attendance with the server timestamp, ignoring client-supplied time and status', async () => {
    const vol = await registerVolunteer(env);
    const s = await createSession(admin, venue.id, { start: `${date}T09:00`, end: `${date}T10:00` });
    env.clock.advance(7);
    const res = await checkIn(vol, s.id, undefined, { tapped_in_at: '2020-01-01T00:00:00Z', status: 'OPEN', source: 'ADMIN' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('CHECKED_IN');
    expect(res.body.attendance.tapped_in_at).toBe(`${date}T01:07:00.000Z`);
    expect(res.body.attendance.source).toBe('QR');
    expect(res.body.session.title).toBe('Sunday Seva');
    expect(res.body.venue.name).toBe('Hall A');
  });

  it('is idempotent: scanning twice / retrying returns the original record', async () => {
    const vol = await registerVolunteer(env);
    const s = await createSession(admin, venue.id, { start: `${date}T09:00`, end: `${date}T10:00` });
    const first = await checkIn(vol, s.id);
    expect(first.status).toBe(201);

    // Simulate a retry after the first response was lost, a few minutes later.
    env.clock.advance(3);
    const retry = await checkIn(vol, s.id);
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('ALREADY_CHECKED_IN');
    expect(retry.body.attendance.id).toBe(first.body.attendance.id);
    expect(retry.body.attendance.tapped_in_at).toBe(first.body.attendance.tapped_in_at);

    // Even after the window closes, a retry still returns the existing record.
    env.clock.advance(120);
    await runSessionScheduler(env.ctx);
    const late = await checkIn(vol, s.id);
    expect(late.status).toBe(200);
    expect(late.body.attendance.id).toBe(first.body.attendance.id);

    expect(await countAttendance(env, s.id)).toBe(1);
  });

  it('concurrent submissions create exactly one record', async () => {
    const vol = await registerVolunteer(env);
    const s = await createSession(admin, venue.id, { start: `${date}T09:00`, end: `${date}T10:00` });
    const results = await Promise.all(Array.from({ length: 6 }, () => checkIn(vol, s.id)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.attendance.id)).size).toBe(1);
    expect(await countAttendance(env, s.id)).toBe(1);
  });

  it('the database enforces one record per (session, volunteer)', async () => {
    const vol = await registerVolunteer(env);
    const s = await createSession(admin, venue.id, { start: `${date}T09:00`, end: `${date}T10:00` });
    await checkIn(vol, s.id);
    await expect(
      env.ctx.db.query(
        `INSERT INTO attendance_records (session_id, volunteer_id, tapped_in_at, source) VALUES ($1, $2, now(), 'QR')`,
        [s.id, vol.user.id],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('the same volunteer can attend two different sessions on the same day', async () => {
    const vol = await registerVolunteer(env);
    const morning = await createSession(admin, venue.id, { title: 'Morning', start: `${date}T09:00`, end: `${date}T10:00` });
    const other = await createSession(admin, otherVenue.id, { title: 'Also morning', start: `${date}T09:10`, end: `${date}T10:00` });
    expect((await checkIn(vol, morning.id)).status).toBe(201);
    expect((await checkIn(vol, other.id, otherVenue.active_qr.public_identifier)).status).toBe(201);

    env.clock.set(`${date}T06:50:00Z`); // 14:50 SGT
    const afternoon = await createSession(admin, venue.id, { title: 'Afternoon', start: `${date}T15:00`, end: `${date}T17:00` });
    expect((await checkIn(vol, afternoon.id)).status).toBe(201);

    const mine = (await vol.get('/api/volunteers/me/attendance')).body.attendance;
    expect(mine).toHaveLength(3);
  });

  it('rejects check-ins before the window opens and after it closes', async () => {
    const vol = await registerVolunteer(env);
    const s = await createSession(admin, venue.id, { start: `${date}T11:00`, end: `${date}T12:00` }); // opens 10:45 SGT
    const early = await checkIn(vol, s.id);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('SESSION_NOT_OPEN');

    env.clock.set(`${date}T04:00:00Z`); // 12:00 SGT, window closed at 12:00 (exclusive)
    const late = await checkIn(vol, s.id);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('SESSION_CLOSED');
    expect(await countAttendance(env, s.id)).toBe(0);
  });

  it('a lagging scheduler does not block check-in once the window has opened', async () => {
    const vol = await registerVolunteer(env);
    const s = await createSession(admin, venue.id, { start: `${date}T09:30`, end: `${date}T10:30` }); // opens 09:15 SGT
    expect(s.status).toBe('SCHEDULED');
    env.clock.advance(20); // 09:20 SGT, scheduler has not run
    expect((await checkIn(vol, s.id)).status).toBe(201);
  });

  it('rejects manually closed and cancelled sessions', async () => {
    const vol = await registerVolunteer(env);
    const closed = await createSession(admin, venue.id, { title: 'Closed', start: `${date}T09:00`, end: `${date}T10:00` });
    const cancelled = await createSession(admin, venue.id, { title: 'Cancelled', start: `${date}T09:00`, end: `${date}T10:00` });
    await admin.post(`/api/admin/sessions/${closed.id}/close`);
    await admin.post(`/api/admin/sessions/${cancelled.id}/cancel`, { reason: 'Rain' });

    const c1 = await checkIn(vol, closed.id);
    expect(c1.status).toBe(409);
    expect(c1.body.error.code).toBe('SESSION_CLOSED');
    const c2 = await checkIn(vol, cancelled.id);
    expect(c2.status).toBe(409);
    expect(c2.body.error.code).toBe('SESSION_CANCELLED');

    // Reopening allows check-in again.
    await admin.post(`/api/admin/sessions/${closed.id}/reopen`);
    expect((await checkIn(vol, closed.id)).status).toBe(201);
  });

  it('rejects draft sessions and sessions that belong to a different venue', async () => {
    const vol = await registerVolunteer(env);
    const draft = await createSession(admin, venue.id, { start: `${date}T09:00`, end: `${date}T10:00`, publish: false });
    const elsewhere = await createSession(admin, otherVenue.id, { start: `${date}T09:00`, end: `${date}T10:00` });
    const r1 = await checkIn(vol, draft.id);
    expect(r1.status).toBe(422);
    expect(r1.body.error.code).toBe('INVALID_SESSION');
    // Scanning Hall A's QR cannot be used to check in to a Hall B session.
    const r2 = await checkIn(vol, elsewhere.id, venue.active_qr.public_identifier);
    expect(r2.status).toBe(422);
    const r3 = await checkIn(vol, '00000000-0000-4000-8000-000000000000');
    expect(r3.status).toBe(422);
    expect(await countAttendance(env, draft.id)).toBe(0);
    expect(await countAttendance(env, elsewhere.id)).toBe(0);
  });

  it('rejects inactive volunteers', async () => {
    const vol = await registerVolunteer(env);
    const s = await createSession(admin, venue.id, { start: `${date}T09:00`, end: `${date}T10:00` });
    await admin.patch(`/api/admin/volunteers/${vol.user.id}`, { status: 'INACTIVE', reason: 'Left the organisation' });
    const res = await checkIn(vol, s.id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('VOLUNTEER_INACTIVE');
    expect(await countAttendance(env, s.id)).toBe(0);
  });

  it('requires the CSRF header on state-changing requests', async () => {
    const vol = await registerVolunteer(env);
    const s = await createSession(admin, venue.id, { start: `${date}T09:00`, end: `${date}T10:00` });
    const res = await vol.agent.post('/api/check-in').send({ venue_id: venue.active_qr.public_identifier, session_id: s.id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('volunteers who do not attend have no attendance records (no absence rows)', async () => {
    const attendee = await registerVolunteer(env);
    await registerVolunteer(env);
    await registerVolunteer(env);
    const s = await createSession(admin, venue.id, { start: `${date}T09:00`, end: `${date}T10:00` });
    await checkIn(attendee, s.id);
    env.clock.advance(180);
    await runSessionScheduler(env.ctx);
    expect(await countAttendance(env, s.id)).toBe(1);
  });
});
