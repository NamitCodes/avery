import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processDeliveries } from '../src/server/services/events/deliveries.js';
import { createEvent, createGate, occupancy, scan } from './eventHelpers.js';
import { createTestEnv, loginAdmin, type Client, type TestEnv } from './helpers.js';

let env: TestEnv;
let admin: Client;
let deskUser: Client;

beforeAll(async () => {
  env = await createTestEnv();
  admin = await loginAdmin(env);
  deskUser = await loginAdmin(env, 'EXCEPTION_DESK');
});
afterAll(() => env.close());

const publicPost = (url: string, body: object) => request(env.app).post(url).set('X-Requested-With', 'fetch').send(body);

const OPEN_EVENT = {
  name: 'Community Fair',
  advance_registration_enabled: true,
  walk_ins_enabled: true,
  reentry_enabled: false,
  contact_requirement: 'EMAIL_OR_PHONE',
};

describe('open event configuration', () => {
  it('validates policy combinations', async () => {
    const bad = await admin.post('/api/admin/events', {
      name: 'x', timezone: 'Asia/Singapore', starts_at: '2026-10-10T08:00', ends_at: '2026-10-10T18:00',
      verification_policy: 'CONTACT_VERIFIED', contact_requirement: 'PHONE',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_POLICY');
    const id = await admin.post('/api/admin/events', {
      name: 'x', timezone: 'Asia/Singapore', starts_at: '2026-10-10T08:00', ends_at: '2026-10-10T18:00',
      verification_policy: 'IN_PERSON_ID_CHECK',
    });
    expect(id.body.event.id_check_mode).toBe('MANDATORY');
  });

  it('draft events are invisible publicly', async () => {
    const res = await admin.post('/api/admin/events', { name: 'Hidden', timezone: 'UTC', starts_at: '2026-10-10T08:00', ends_at: '2026-10-10T18:00' });
    expect((await request(env.app).get(`/api/public/events/${res.body.event.id}`)).status).toBe(404);
  });
});

describe('advance registration', () => {
  it('registers without an account, issues a pass, and emails it', async () => {
    const ev = await createEvent(admin, OPEN_EVENT);
    const status = await request(env.app).get(`/api/public/events/${ev.id}/registration-status`);
    expect(status.body).toMatchObject({ open: true, capacity_reached: false });

    const res = await publicPost(`/api/public/events/${ev.id}/registrations`, { name: 'Ana Lima', email: 'ana@example.org' });
    expect(res.status).toBe(201);
    expect(res.body.registration.registration_reference).toMatch(/^R/);
    expect(res.body.pass.pass_url).toMatch(/\/pass\/EVP1\./);
    expect(res.body.contact_verification_required).toBe(false);
    env.mailer.sent = [];
    await processDeliveries(env.ctx);
    expect(env.mailer.sent.map((m) => m.to)).toEqual(['ana@example.org']);

    // Submitting again does not create a duplicate; it re-sends to the address on file.
    const again = await publicPost(`/api/public/events/${ev.id}/registrations`, { name: 'Ana L.', email: 'ANA@example.org' });
    expect(again.status).toBe(200);
    expect(again.body.existing).toBe(true);
    expect(again.body).not.toHaveProperty('pass');
    const list = (await admin.get(`/api/admin/events/${ev.id}/registrations`)).body;
    expect(list.total).toBe(1);
  });

  it('a phone-only attendee can register when policy allows', async () => {
    const ev = await createEvent(admin, OPEN_EVENT);
    const res = await publicPost(`/api/public/events/${ev.id}/registrations`, { name: 'No Email', phone: '+65 9123 4567' });
    expect(res.status).toBe(201);
    const none = await publicPost(`/api/public/events/${ev.id}/registrations`, { name: 'Nothing' });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('CONTACT_REQUIRED');
  });

  it('contact verification: pass is withheld until the email code is confirmed', async () => {
    const ev = await createEvent(admin, { ...OPEN_EVENT, contact_requirement: 'EMAIL', verification_policy: 'CONTACT_VERIFIED' });
    env.mailer.sent = [];
    const res = await publicPost(`/api/public/events/${ev.id}/registrations`, { name: 'Bo', email: 'bo@example.org' });
    expect(res.status).toBe(201);
    expect(res.body.contact_verification_required).toBe(true);
    expect(res.body.pass).toBeNull();
    expect(res.body.verification.sent_to).toBe('b•••@example.org');
    const code = /code is (\d{6})/.exec(env.mailer.sent[0].text)![1];
    const id = res.body.registration.id;

    const wrong = await publicPost(`/api/public/event-registrations/${id}/verify-contact`, { action: 'confirm', code: code === '000000' ? '111111' : '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('CODE_INCORRECT');

    const ok = await publicPost(`/api/public/event-registrations/${id}/verify-contact`, { action: 'confirm', code });
    expect(ok.body).toMatchObject({ verified: true, pass_issued: true });
    expect(ok.body.message).toContain('access to the email address only');
    await processDeliveries(env.ctx);
    expect(env.mailer.sent.at(-1)!.subject).toBe('Your pass for Community Fair');

    // Single use.
    const reuse = await publicPost(`/api/public/event-registrations/${id}/verify-contact`, { action: 'confirm', code });
    expect(reuse.body.already).toBe(true);
  });

  it('pauses registration at capacity', async () => {
    const ev = await createEvent(admin, { ...OPEN_EVENT, capacity: 1, pause_registration_at_capacity: true });
    expect((await publicPost(`/api/public/events/${ev.id}/registrations`, { name: 'A', email: 'a@x.org' })).status).toBe(201);
    const full = await publicPost(`/api/public/events/${ev.id}/registrations`, { name: 'B', email: 'b@x.org' });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('CAPACITY_REACHED');
  });
});

describe('walk-ins and check-in', () => {
  it('searches for duplicates before creating, then registers, prints a pass and checks in', async () => {
    const ev = await createEvent(admin, OPEN_EVENT);
    await publicPost(`/api/public/events/${ev.id}/registrations`, { name: 'Chen Wei', email: 'chen@example.org' });
    const gate = await createGate(admin, ev.id, 'Fast lane', 'ENTRY');

    const walkIn = (body: object) => deskUser.post(`/api/admin/events/${ev.id}/walk-ins`, body);
    const dup = await walkIn({ name: '  chen   WEI ', email: 'other@example.org' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('POSSIBLE_DUPLICATES');
    expect(dup.body.error.candidates[0]).toMatchObject({ name: 'Chen Wei', match: ['NAME'], email: 'c•••n@example.org' });

    const created = await walkIn({ name: 'Chen Wei', email: 'other@example.org', confirm_new: true });
    expect(created.status).toBe(201);
    expect(created.body.pass.qr_data_url).toMatch(/^data:image\/png;base64,/);

    // Fast check-in by scanning the printed pass.
    const first = await scan(deskUser, gate.id, created.body.pass.pass_url);
    expect(first.body).toMatchObject({ result: 'ACCEPTED', event_type: 'CHECK_IN' });
    // Re-entry disabled: repeated scans warn and don't inflate counts.
    const again = await scan(deskUser, gate.id, created.body.pass.pass_url);
    expect(again.body).toMatchObject({ result: 'REJECTED', code: 'ALREADY_CHECKED_IN' });
    expect(again.body.participant.checked_in_at).toBe(first.body.occurred_at);

    const exitGate = await createGate(admin, ev.id, 'Exit', 'EXIT');
    expect((await scan(deskUser, exitGate.id, created.body.pass.pass_url)).body.code).toBe('EXIT_NOT_ENABLED');

    const occ = await occupancy(admin, ev.id);
    expect(occ).toMatchObject({ checked_in_unique: 1, source_online: 1, source_walk_in: 1, total_participants: 2 });
  });

  it('attendees without phone or email can still be registered and checked in', async () => {
    const ev = await createEvent(admin, OPEN_EVENT);
    const noContact = await deskUser.post(`/api/admin/events/${ev.id}/walk-ins`, { name: 'Elder Tan' });
    expect(noContact.status).toBe(400);
    const ok = await deskUser.post(`/api/admin/events/${ev.id}/walk-ins`, { name: 'Elder Tan', contact_unavailable: true });
    expect(ok.status).toBe(201);
    const checkIn = await deskUser.post(`/api/admin/events/${ev.id}/participants/${ok.body.participant.id}/manual-access`, { direction: 'IN' });
    expect(checkIn.body).toMatchObject({ result: 'ACCEPTED', event_type: 'CHECK_IN' });
    // Every admitted attendee has a registration and an accepted check-in record.
    const { rows } = await env.ctx.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM event_participants p WHERE p.event_id = $1 AND p.checked_in_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM event_access_events a WHERE a.participant_id = p.id AND a.result = 'ACCEPTED')`,
      [ev.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('rejects walk-ins when disabled or at capacity', async () => {
    const off = await createEvent(admin, { ...OPEN_EVENT, walk_ins_enabled: false });
    const r1 = await deskUser.post(`/api/admin/events/${off.id}/walk-ins`, { name: 'X', email: 'x@x.org' });
    expect(r1.body.error.code).toBe('WALK_INS_DISABLED');

    const full = await createEvent(admin, { ...OPEN_EVENT, capacity: 1 });
    const a = await deskUser.post(`/api/admin/events/${full.id}/walk-ins`, { name: 'A', email: 'a@x.org' });
    const b = await deskUser.post(`/api/admin/events/${full.id}/walk-ins`, { name: 'B', email: 'b@x.org' });
    const gate = await createGate(admin, full.id, 'Gate', 'ENTRY');
    expect((await scan(deskUser, gate.id, a.body.pass.pass_url)).body.result).toBe('ACCEPTED');
    expect((await scan(deskUser, gate.id, b.body.pass.pass_url)).body.code).toBe('CAPACITY_REACHED');
  });

  it('mandatory ID checks cannot be bypassed; overrides need desk authority and a reason', async () => {
    const ev = await createEvent(admin, { ...OPEN_EVENT, verification_policy: 'IN_PERSON_ID_CHECK' });
    const gate = await createGate(admin, ev.id, 'Gate', 'ENTRY');
    const op = await loginAdmin(env, 'GATE_OPERATOR');
    await admin.post(`/api/admin/event-gates/${gate.id}/operators`, { email: op.user.email });

    const a = await deskUser.post(`/api/admin/events/${ev.id}/walk-ins`, { name: 'Ida', email: 'ida@x.org' });
    const url = a.body.pass.pass_url;
    const pid = a.body.participant.id;
    expect((await scan(op, gate.id, url)).body.code).toBe('ID_CHECK_REQUIRED');

    // Gate operator cannot override…
    expect((await op.post(`/api/admin/event-registrations/${pid}/verify-identity`, { outcome: 'OVERRIDDEN', reason: 'trust me' })).status).toBe(409);
    // …but can record a failed check, which routes to the desk.
    await op.post(`/api/admin/event-registrations/${pid}/verify-identity`, { outcome: 'FAILED' });
    env.clock.advance(1);
    expect((await scan(op, gate.id, url)).body.code).toBe('ID_CHECK_FAILED');
    // Desk override without reason is rejected; with reason it is recorded.
    expect((await deskUser.post(`/api/admin/event-registrations/${pid}/verify-identity`, { outcome: 'OVERRIDDEN' })).status).toBe(400);
    await deskUser.post(`/api/admin/event-registrations/${pid}/verify-identity`, { outcome: 'OVERRIDDEN', reason: 'Supervisor confirmed via alternate ID' });
    expect((await scan(op, gate.id, url)).body.result).toBe('ACCEPTED');

    const b = await deskUser.post(`/api/admin/events/${ev.id}/walk-ins`, { name: 'Jo', email: 'jo@x.org' });
    await op.post(`/api/admin/event-registrations/${b.body.participant.id}/verify-identity`, { outcome: 'CHECKED' });
    expect((await scan(op, gate.id, b.body.pass.pass_url)).body.result).toBe('ACCEPTED');

    const detail = (await admin.get(`/api/admin/events/${ev.id}/participants/${pid}`)).body;
    expect(detail.verifications.map((v: { outcome: string }) => v.outcome)).toEqual(['OVERRIDDEN', 'FAILED']);
    expect(detail.verifications[0].reason).toBe('Supervisor confirmed via alternate ID');

    const occ = await occupancy(admin, ev.id);
    expect(occ).toMatchObject({ id_checked: 1, id_overridden: 1, checked_in_unique: 2 });
  });

  it('exports attendance distinguishing registered, verified, ID-checked and checked-in', async () => {
    const ev = await createEvent(admin, OPEN_EVENT);
    await publicPost(`/api/public/events/${ev.id}/registrations`, { name: 'Reg Only', email: 'r@x.org' });
    const w = await deskUser.post(`/api/admin/events/${ev.id}/walk-ins`, { name: 'Walk In', email: 'w@x.org' });
    await deskUser.post(`/api/admin/events/${ev.id}/participants/${w.body.participant.id}/manual-access`, { direction: 'IN' });
    const csv = await admin.get(`/api/admin/events/${ev.id}/attendance.csv`);
    const lines = csv.text.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toContain('Contact verification,ID check,Checked in');
    expect(lines.find((l) => l.includes('Reg Only'))).toContain(',ONLINE,ACTIVE,');
    expect(lines.find((l) => l.includes('Reg Only'))).toContain(',no,');
    expect(lines.find((l) => l.includes('Walk In'))).toContain(',WALK_IN,ACTIVE,');
    expect(lines.find((l) => l.includes('Walk In'))).toContain(',yes,');
    expect((await deskUser.get(`/api/admin/events/${ev.id}/attendance.csv`)).status).toBe(403);
  });
});
