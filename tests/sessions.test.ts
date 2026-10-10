import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSessionScheduler } from '../src/server/services/sessions.js';
import { createSession, createTestEnv, createVenue, loginAdmin, type Client, type TestEnv } from './helpers.js';

let env: TestEnv;
let admin: Client;
let venueId: string;

beforeAll(async () => {
  env = await createTestEnv();
  admin = await loginAdmin(env);
  venueId = (await createVenue(admin)).id;
});
afterAll(() => env.close());

describe('session lifecycle', () => {
  it('creates a DRAFT with default check-in window (15 min before, 60 min after start)', async () => {
    const s = await createSession(admin, venueId, { start: '2026-10-11T09:00', end: '2026-10-11T11:00', publish: false });
    expect(s.status).toBe('DRAFT');
    // 09:00 SGT == 01:00Z
    expect(new Date(s.checkin_opens_at).toISOString()).toBe('2026-10-11T00:45:00.000Z');
    expect(new Date(s.checkin_closes_at).toISOString()).toBe('2026-10-11T02:00:00.000Z');
  });

  it('honours per-session window overrides and venue time zone', async () => {
    const s = await createSession(admin, venueId, {
      start: '2026-10-11T14:00',
      end: '2026-10-11T16:00',
      opens: '2026-10-11T13:00',
      closes: '2026-10-11T14:30',
      publish: false,
    });
    expect(new Date(s.checkin_opens_at).toISOString()).toBe('2026-10-11T05:00:00.000Z');
    expect(new Date(s.checkin_closes_at).toISOString()).toBe('2026-10-11T06:30:00.000Z');
  });

  it('rejects inconsistent times', async () => {
    const res = await admin.post('/api/admin/sessions', {
      location_id: venueId,
      title: 'Bad',
      start_at: '2026-10-11T10:00',
      end_at: '2026-10-11T09:00',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TIMES');
  });

  it('publish -> SCHEDULED, scheduler auto-opens at window start and auto-closes at window end', async () => {
    env.clock.set('2026-10-10T01:00:00Z');
    const s = await createSession(admin, venueId, { start: '2026-10-11T09:00', end: '2026-10-11T11:00' });
    expect(s.status).toBe('SCHEDULED');

    env.clock.set('2026-10-11T00:44:00Z');
    await runSessionScheduler(env.ctx);
    expect((await admin.get(`/api/admin/sessions/${s.id}`)).body.session.status).toBe('SCHEDULED');

    env.clock.set('2026-10-11T00:45:00Z');
    await runSessionScheduler(env.ctx);
    expect((await admin.get(`/api/admin/sessions/${s.id}`)).body.session.status).toBe('OPEN');

    env.clock.set('2026-10-11T02:00:00Z');
    await runSessionScheduler(env.ctx);
    const detail = (await admin.get(`/api/admin/sessions/${s.id}`)).body;
    expect(detail.session.status).toBe('CLOSED');
    expect(detail.history.map((h: { action: string }) => h.action)).toEqual(
      expect.arrayContaining(['session.create', 'session.publish', 'session.auto_open', 'session.auto_close']),
    );
  });

  it('publishing inside the window opens immediately; publishing after it ends is rejected', async () => {
    env.clock.set('2026-10-12T01:00:00Z'); // 09:00 SGT
    const open = await createSession(admin, venueId, { start: '2026-10-12T09:00', end: '2026-10-12T10:00' });
    expect(open.status).toBe('OPEN');

    const past = await createSession(admin, venueId, { start: '2026-10-12T05:00', end: '2026-10-12T06:00', publish: false });
    const res = await admin.post(`/api/admin/sessions/${past.id}/publish`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WINDOW_PASSED');
  });

  it('admin can open early, which pulls the window start forward', async () => {
    env.clock.set('2026-10-13T00:00:00Z'); // 08:00 SGT
    const s = await createSession(admin, venueId, { start: '2026-10-13T10:00', end: '2026-10-13T12:00' });
    expect(s.status).toBe('SCHEDULED');
    const res = await admin.post(`/api/admin/sessions/${s.id}/open`);
    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe('OPEN');
    expect(new Date(res.body.session.checkin_opens_at).toISOString()).toBe('2026-10-13T00:00:00.000Z');
  });

  it('close, reopen (extending an expired window), cancel and archive', async () => {
    env.clock.set('2026-10-14T01:00:00Z');
    const s = await createSession(admin, venueId, { start: '2026-10-14T09:00', end: '2026-10-14T10:00' });
    expect((await admin.post(`/api/admin/sessions/${s.id}/close`)).body.session.status).toBe('CLOSED');

    env.clock.set('2026-10-14T05:00:00Z'); // well past the 10:00 SGT close
    const reopened = (await admin.post(`/api/admin/sessions/${s.id}/reopen`, { reason: 'Late group arrived' })).body.session;
    expect(reopened.status).toBe('OPEN');
    expect(new Date(reopened.checkin_closes_at).toISOString()).toBe('2026-10-14T06:00:00.000Z');

    expect((await admin.post(`/api/admin/sessions/${s.id}/cancel`, { reason: 'Weather' })).body.session.status).toBe('CANCELLED');
    expect((await admin.post(`/api/admin/sessions/${s.id}/archive`)).body.session.status).toBe('ARCHIVED');

    const audit = (await admin.get(`/api/admin/audit-logs?entity_type=session&entity_id=${s.id}`)).body.audit_logs;
    const reopenEntry = audit.find((a: { action: string }) => a.action === 'session.reopen');
    expect(reopenEntry.reason).toBe('Late group arrived');
    expect(reopenEntry.before_data.status).toBe('CLOSED');
    expect(reopenEntry.after_data.status).toBe('OPEN');
  });

  it('rejects invalid transitions', async () => {
    const s = await createSession(admin, venueId, { start: '2026-10-20T09:00', end: '2026-10-20T10:00', publish: false });
    const reopen = await admin.post(`/api/admin/sessions/${s.id}/reopen`);
    expect(reopen.status).toBe(409);
    expect(reopen.body.error.code).toBe('INVALID_TRANSITION');
    await admin.post(`/api/admin/sessions/${s.id}/cancel`);
    expect((await admin.post(`/api/admin/sessions/${s.id}/publish`)).status).toBe(409);
    expect((await admin.post(`/api/admin/sessions/${s.id}/open`)).status).toBe(409);
    // Cancelled sessions cannot be edited.
    expect((await admin.patch(`/api/admin/sessions/${s.id}`, { title: 'x' })).status).toBe(409);
  });

  it('allows overlapping sessions at the same venue and lists them with filters', async () => {
    const a = await createSession(admin, venueId, { title: 'Overlap A', start: '2026-10-25T09:00', end: '2026-10-25T12:00' });
    const b = await createSession(admin, venueId, { title: 'Overlap B', start: '2026-10-25T10:00', end: '2026-10-25T11:00' });
    const res = await admin.get(`/api/admin/sessions?from=2026-10-25&to=2026-10-25&location_id=${venueId}`);
    expect(res.status).toBe(200);
    const ids = res.body.sessions.map((s: { id: string }) => s.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(ids).toHaveLength(2);
    expect(res.body.sessions[0]).toHaveProperty('attendance_count', 0);

    const byTitle = await admin.get('/api/admin/sessions?q=Overlap%20B');
    expect(byTitle.body.sessions.map((s: { id: string }) => s.id)).toEqual([b.id]);
  });

  it('edits are audited with before/after values', async () => {
    const s = await createSession(admin, venueId, { start: '2026-10-26T09:00', end: '2026-10-26T10:00', publish: false });
    const res = await admin.patch(`/api/admin/sessions/${s.id}`, { title: 'Renamed', reason: 'Typo' });
    expect(res.status).toBe(200);
    const audit = (await admin.get(`/api/admin/audit-logs?entity_id=${s.id}&action=session.update`)).body.audit_logs;
    expect(audit[0].before_data.title).toBe('Beach clean-up');
    expect(audit[0].after_data.title).toBe('Renamed');
  });
});
