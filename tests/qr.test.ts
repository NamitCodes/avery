import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  countAttendance,
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

beforeAll(async () => {
  env = await createTestEnv();
  admin = await loginAdmin(env);
});
afterAll(() => env.close());

const checkIn = (c: Client, venueId: string, sessionId: string) =>
  c.post('/api/check-in', { venue_id: venueId, session_id: sessionId });

describe('venue QR codes', () => {
  it('each venue gets a unique, non-sequential QR encoding only a check-in URL', async () => {
    const a = await createVenue(admin, 'Venue 1');
    const b = await createVenue(admin, 'Venue 2');
    expect(a.active_qr.public_identifier).not.toBe(b.active_qr.public_identifier);
    expect(a.active_qr.public_identifier).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.active_qr.url).toBe(`https://att.example.org/check-in/v/${a.active_qr.public_identifier}`);

    const list = (await admin.get('/api/admin/locations')).body.locations;
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it('serves a printable PNG and SVG', async () => {
    const v = await createVenue(admin, 'Printable');
    const png = await admin.get(`/api/admin/qr-codes/${v.active_qr.id}/image?download=1`);
    expect(png.status).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['content-disposition']).toContain('Printable-attendance-qr.png');
    expect(png.body.subarray(0, 4).toString('hex')).toBe('89504e47');
    const svg = await admin.get(`/api/admin/qr-codes/${v.active_qr.id}/image?format=svg`);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
  });

  it('revoking immediately blocks new check-ins, keeps existing records, and a replacement works', async () => {
    env.clock.set('2026-12-01T01:00:00Z');
    const v = await createVenue(admin, 'Revocable');
    const s = await createSession(admin, v.id, { start: '2026-12-01T09:00', end: '2026-12-01T10:00' });
    const early = await registerVolunteer(env);
    const late = await registerVolunteer(env);
    const oldQr = v.active_qr.public_identifier;

    expect((await checkIn(early, oldQr, s.id)).status).toBe(201);

    const revoke = await admin.post(`/api/admin/qr-codes/${v.active_qr.id}/revoke`, { reason: 'Photo shared online' });
    expect(revoke.status).toBe(200);
    expect(revoke.body.qr_code.status).toBe('REVOKED');

    const page = await late.get(`/api/check-in/venues/${oldQr}`);
    expect(page.status).toBe(410);
    expect(page.body.error.code).toBe('QR_REVOKED');
    const blocked = await checkIn(late, oldQr, s.id);
    expect(blocked.status).toBe(410);
    expect(blocked.body.error.code).toBe('QR_REVOKED');

    // Existing attendance is untouched.
    expect(await countAttendance(env, s.id)).toBe(1);

    const replacement = await admin.post(`/api/admin/locations/${v.id}/qr-codes`);
    expect(replacement.status).toBe(201);
    const newQr = replacement.body.qr_code.public_identifier;
    expect(newQr).not.toBe(oldQr);
    expect((await checkIn(late, newQr, s.id)).status).toBe(201);
    // Old code stays revoked.
    expect((await late.get(`/api/check-in/venues/${oldQr}`)).status).toBe(410);

    const audit = (await admin.get(`/api/admin/audit-logs?entity_id=${v.active_qr.id}`)).body.audit_logs;
    expect(audit.find((a: { action: string }) => a.action === 'qr.revoke').reason).toBe('Photo shared online');
  });

  it('generating a replacement auto-revokes the previous active code', async () => {
    const v = await createVenue(admin, 'Replace');
    const r = await admin.post(`/api/admin/locations/${v.id}/qr-codes`, { reason: 'Damaged print' });
    expect(r.status).toBe(201);
    const detail = (await admin.get(`/api/admin/locations/${v.id}`)).body;
    expect(detail.qr_codes).toHaveLength(2);
    expect(detail.qr_codes.filter((q: { status: string }) => q.status === 'ACTIVE')).toHaveLength(1);
    expect(detail.location.active_qr.id).toBe(r.body.qr_code.id);
  });

  it('a deactivated venue rejects check-ins even with an active QR', async () => {
    env.clock.set('2026-12-02T01:00:00Z');
    const v = await createVenue(admin, 'Closing down');
    const s = await createSession(admin, v.id, { start: '2026-12-02T09:00', end: '2026-12-02T10:00' });
    await admin.patch(`/api/admin/locations/${v.id}`, { status: 'INACTIVE' });
    const vol = await registerVolunteer(env);
    const res = await checkIn(vol, v.active_qr.public_identifier, s.id);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('VENUE_INACTIVE');
    expect(await countAttendance(env, s.id)).toBe(0);
  });

  it('cannot revoke twice', async () => {
    const v = await createVenue(admin, 'Twice');
    await admin.post(`/api/admin/qr-codes/${v.active_qr.id}/revoke`);
    const again = await admin.post(`/api/admin/qr-codes/${v.active_qr.id}/revoke`);
    expect(again.status).toBe(409);
  });
});
