import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processDeliveries } from '../src/server/services/events/deliveries.js';
import { accessEventCount, createEvent, createGate, importCsv, issuePass, occupancy, participants, scan } from './eventHelpers.js';
import { createTestEnv, loginAdmin, type Client, type TestEnv } from './helpers.js';

let env: TestEnv;
let admin: Client;

beforeAll(async () => {
  env = await createTestEnv();
  admin = await loginAdmin(env);
});
afterAll(() => env.close());

let n = 0;
/** Event with N imported participants, an entry gate and an exit gate. */
async function setup(count = 2, overrides: Record<string, unknown> = {}) {
  const ev = await createEvent(admin, { name: `Summit ${++n}`, ...overrides });
  const rows = Array.from({ length: count }, (_, i) => `Person ${n}-${i},Kenya,p${n}-${i}@example.org`);
  await importCsv(admin, ev.id, ['name,country,email', ...rows].join('\n'));
  const entry = await createGate(admin, ev.id, 'North Entry', 'ENTRY');
  const exit = await createGate(admin, ev.id, 'North Exit', 'EXIT');
  const people = await participants(admin, ev.id);
  return { ev, entry, exit, people };
}

describe('passes and email', () => {
  it('issues opaque passes, emails them, and tracks delivery status', async () => {
    const { ev, people } = await setup(3);
    env.mailer.sent = [];
    const send = await admin.post(`/api/admin/events/${ev.id}/passes/send`, {});
    expect(send.body).toEqual({ issued: 3, queued: 3 });
    // Re-sending does not duplicate queued/sent emails.
    expect((await admin.post(`/api/admin/events/${ev.id}/passes/send`, {})).body).toEqual({ issued: 0, queued: 0 });

    expect(await processDeliveries(env.ctx)).toEqual({ sent: 3, failed: 0 });
    expect(env.mailer.sent).toHaveLength(3);
    const msg = env.mailer.sent.find((m) => m.to === 'p1-0@example.org')!;
    expect(msg.subject).toBe('Your pass for Summit 1');
    expect(msg.text).toContain('PRINT');
    expect(msg.attachments?.[0].cid).toBe('pass-qr');

    // The QR/pass URL contains only an opaque token — no personal data.
    const pass = (await admin.get(`/api/admin/event-credentials/${(await participants(admin, ev.id))[0].active_credential_id}/pass`)).body.pass;
    expect(pass.pass_url).toMatch(/^https:\/\/att\.example\.org\/pass\/EVP1\.[A-Za-z0-9_-]{43}$/);
    for (const p of people) {
      expect(pass.pass_url).not.toContain(p.name.split(' ')[0]);
      expect(pass.pass_url).not.toContain('Kenya');
    }
    // The raw token is never stored.
    const { rows } = await env.ctx.db.query<{ token_hash: string; token_ciphertext: string }>('SELECT token_hash, token_ciphertext FROM event_credentials');
    const token = pass.pass_url.split('/pass/')[1];
    for (const r of rows) {
      expect(r.token_hash).not.toContain(token);
      expect(r.token_ciphertext).not.toContain(token);
    }

    // Public pass page works for the token holder.
    const pub = await admin.agent.get(`/api/public/passes/${token}`);
    expect(pub.status).toBe(200);
    expect(pub.body.pass.participant.registration_reference).toBe(pass.participant.registration_reference);
  });

  it('records failures with sanitised errors and supports retry', async () => {
    const { ev } = await setup(1);
    await admin.post(`/api/admin/events/${ev.id}/passes/send`, {});
    env.mailer.failWith = 'SMTP 550 mailbox p2-0@example.org unavailable';
    expect(await processDeliveries(env.ctx)).toEqual({ sent: 0, failed: 1 });
    env.mailer.failWith = null;
    const list = (await admin.get(`/api/admin/events/${ev.id}/deliveries?status=FAILED`)).body;
    expect(list.counts).toEqual({ FAILED: 1 });
    expect(list.deliveries[0].last_error).toBe('SMTP 550 mailbox [address] unavailable');
    expect(list.deliveries[0].attempt_count).toBe(1);

    const retry = await admin.post(`/api/admin/event-pass-deliveries/${list.deliveries[0].id}/retry`);
    expect(retry.body.delivery.delivery_status).toBe('QUEUED');
    expect(await processDeliveries(env.ctx)).toEqual({ sent: 1, failed: 0 });
    const after = (await admin.get(`/api/admin/events/${ev.id}/deliveries`)).body.deliveries[0];
    expect(after).toMatchObject({ delivery_status: 'SENT', attempt_count: 2 });
  });
});

describe('entry, exit and re-entry', () => {
  it('ENTRY then EXIT then re-ENTRY with the same pass; duplicates and invalid exits change nothing', async () => {
    const { ev, entry, exit, people } = await setup(1);
    const { url } = await issuePass(admin, ev.id, people[0].id);

    const badExit = await scan(admin, exit.id, url);
    expect(badExit.body).toMatchObject({ result: 'REJECTED', code: 'ALREADY_OUTSIDE' });

    const in1 = await scan(admin, entry.id, url);
    expect(in1.body).toMatchObject({ result: 'ACCEPTED', event_type: 'ENTRY', participant: { name: people[0].name, current_access_state: 'INSIDE' } });
    expect(in1.body.participant).not.toHaveProperty('email');
    expect(in1.body.gate).toMatchObject({ name: 'North Entry', mode: 'ENTRY' });
    expect((await occupancy(admin, ev.id)).inside).toBe(1);

    const dupIn = await scan(admin, entry.id, url);
    expect(dupIn.body).toMatchObject({ result: 'REJECTED', code: 'ALREADY_INSIDE' });
    expect(dupIn.body.message).toContain('NOT recorded');

    expect((await scan(admin, exit.id, url)).body).toMatchObject({ result: 'ACCEPTED', event_type: 'EXIT' });
    expect((await occupancy(admin, ev.id)).inside).toBe(0);
    expect((await scan(admin, entry.id, url)).body).toMatchObject({ result: 'ACCEPTED', event_type: 'ENTRY' });

    const occ = await occupancy(admin, ev.id);
    expect(occ).toMatchObject({ inside: 1, checked_in_unique: 1, accepted_entries: 2, accepted_exits: 1, rejected_scans: 2 });
    expect(occ.reconciliation).toEqual({ derived_inside: 1, mismatched_participants: 0 });
  });

  it('a raw token scanned by a hardware scanner is accepted too', async () => {
    const { ev, entry, people } = await setup(1);
    const { url } = await issuePass(admin, ev.id, people[0].id);
    const token = url.split('/pass/')[1];
    expect((await scan(admin, entry.id, `${token}\n`)).body.result).toBe('ACCEPTED');
  });

  it('unknown, revoked, wrong-event, inactive-participant and inactive-event scans never change occupancy', async () => {
    const { ev, entry, people } = await setup(3);
    const other = await setup(1);
    const p0 = await issuePass(admin, ev.id, people[0].id);
    const p1 = await issuePass(admin, ev.id, people[1].id);
    const p2 = await issuePass(admin, ev.id, people[2].id);
    const foreign = await issuePass(admin, other.ev.id, other.people[0].id);

    expect((await scan(admin, entry.id, 'https://evil.example/pass/EVP1.' + 'A'.repeat(43))).body.code).toBe('UNKNOWN_CREDENTIAL');
    expect((await scan(admin, entry.id, 'hello world')).body.code).toBe('UNKNOWN_CREDENTIAL');
    expect((await scan(admin, entry.id, foreign.url)).body.code).toBe('WRONG_EVENT');

    await admin.post(`/api/admin/event-credentials/${p0.credentialId}/revoke`, { reason: 'Reported stolen' });
    expect((await scan(admin, entry.id, p0.url)).body.code).toBe('REVOKED_CREDENTIAL');

    await admin.patch(`/api/admin/events/${ev.id}/participants/${people[1].id}`, { status: 'CANCELLED', reason: 'Withdrew' });
    expect((await scan(admin, entry.id, p1.url)).body.code).toBe('PARTICIPANT_INACTIVE');

    await admin.patch(`/api/admin/events/${ev.id}`, { status: 'CLOSED' });
    expect((await scan(admin, entry.id, p2.url)).body.code).toBe('EVENT_NOT_ACTIVE');

    const occ = await occupancy(admin, ev.id);
    expect(occ.inside).toBe(0);
    expect(occ.checked_in_unique).toBe(0);
    expect(await accessEventCount(env, ev.id, 'ACCEPTED')).toBe(0);
    expect(occ.rejected_scans).toBe(6);
  });

  it('retries with the same idempotency key return the original outcome', async () => {
    const { ev, entry, people } = await setup(1);
    const { url } = await issuePass(admin, ev.id, people[0].id);
    const first = await scan(admin, entry.id, url, 'scan-key-0001');
    const retry = await scan(admin, entry.id, url, 'scan-key-0001');
    expect(first.body.result).toBe('ACCEPTED');
    expect(retry.body).toMatchObject({ result: 'ACCEPTED', replay: true, access_event_id: first.body.access_event_id });
    expect(await accessEventCount(env, ev.id)).toBe(1);
  });

  it('simultaneous scans at two entry gates admit exactly once', async () => {
    const { ev, entry, people } = await setup(1);
    const entry2 = await createGate(admin, ev.id, 'South Entry', 'ENTRY');
    const { url } = await issuePass(admin, ev.id, people[0].id);
    const results = await Promise.all([
      scan(admin, entry.id, url),
      scan(admin, entry2.id, url),
      scan(admin, entry.id, url),
      scan(admin, entry2.id, url),
    ]);
    expect(results.filter((r) => r.body.result === 'ACCEPTED')).toHaveLength(1);
    expect(results.filter((r) => r.body.code === 'ALREADY_INSIDE')).toHaveLength(3);
    expect((await occupancy(admin, ev.id)).inside).toBe(1);
  });

  it('replacing a pass revokes the old one and preserves history', async () => {
    const { ev, entry, exit, people } = await setup(1);
    const old = await issuePass(admin, ev.id, people[0].id);
    await scan(admin, entry.id, old.url);
    await scan(admin, exit.id, old.url);

    const noVerify = await admin.post(`/api/admin/event-credentials/${old.credentialId}/replace`, { reason: 'Lost pass' });
    expect(noVerify.status).toBe(400);
    const rep = await admin.post(`/api/admin/event-credentials/${old.credentialId}/replace`, { reason: 'Lost pass', identity_verified: true });
    expect(rep.status).toBe(201);
    const newUrl = rep.body.pass.pass_url;
    expect(newUrl).not.toBe(old.url);

    expect((await scan(admin, entry.id, old.url)).body.code).toBe('REVOKED_CREDENTIAL');
    expect((await scan(admin, entry.id, newUrl)).body.result).toBe('ACCEPTED');

    const detail = (await admin.get(`/api/admin/events/${ev.id}/participants/${people[0].id}`)).body;
    expect(detail.credentials).toHaveLength(2);
    expect(detail.credentials.find((c: { id: string }) => c.id === old.credentialId)).toMatchObject({ status: 'REVOKED', replaced_by_credential_id: rep.body.credential.id });
    expect(detail.access_events.filter((a: { result: string }) => a.result === 'ACCEPTED')).toHaveLength(3);
    expect(detail.credentials[0]).not.toHaveProperty('token_hash');
    expect(detail.credentials[0]).not.toHaveProperty('token_ciphertext');
  });

  it('corrections append a CORRECTION event, revert state, and require a reason', async () => {
    const { ev, entry, people } = await setup(1);
    const { url } = await issuePass(admin, ev.id, people[0].id);
    const accepted = (await scan(admin, entry.id, url)).body;
    expect((await admin.post(`/api/admin/event-access-events/${accepted.access_event_id}/correct`, {})).status).toBe(400);
    const fix = await admin.post(`/api/admin/event-access-events/${accepted.access_event_id}/correct`, { reason: 'Scanned but turned back' });
    expect(fix.status).toBe(201);
    expect((await occupancy(admin, ev.id))).toMatchObject({ inside: 0, checked_in_unique: 0, corrections: 1 });
    // Original remains; it cannot be corrected twice.
    expect((await admin.post(`/api/admin/event-access-events/${accepted.access_event_id}/correct`, { reason: 'again' })).status).toBe(409);
    const log = (await admin.get(`/api/admin/events/${ev.id}/access-events`)).body.access_events;
    expect(log.map((a: { event_type: string }) => a.event_type)).toEqual(['CORRECTION', 'ENTRY']);
    expect(log[1].corrected).toBe(true);
    expect((await occupancy(admin, ev.id)).reconciliation.mismatched_participants).toBe(0);
    // They can now enter for real.
    expect((await scan(admin, entry.id, url)).body.result).toBe('ACCEPTED');
  });

  it('manual admission requires a reason, is a distinct source, and is audited', async () => {
    const { ev, people } = await setup(1);
    const url = `/api/admin/events/${ev.id}/participants/${people[0].id}/manual-access`;
    expect((await admin.post(url, { direction: 'IN', override: true })).status).toBe(400);
    const ok = await admin.post(url, { direction: 'IN', override: true, reason: 'Emergency re-admission approved by supervisor' });
    expect(ok.body).toMatchObject({ result: 'ACCEPTED' });
    const occ = await occupancy(admin, ev.id);
    expect(occ).toMatchObject({ inside: 1, manual_overrides: 1 });
    const audit = (await admin.get(`/api/admin/audit-logs?entity_id=${ok.body.access_event_id}`)).body.audit_logs;
    expect(audit[0]).toMatchObject({ action: 'event_access.manual_override', actor_id: admin.user.id });
  });

  it('exports access history as CSV', async () => {
    const { ev, entry, people } = await setup(1);
    const { url } = await issuePass(admin, ev.id, people[0].id);
    await scan(admin, entry.id, url);
    await scan(admin, entry.id, url);
    const csv = await admin.get(`/api/admin/events/${ev.id}/access-events/export.csv`);
    const lines = csv.text.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(',ENTRY,ACCEPTED,,QR,');
    expect(lines[2]).toContain(',ENTRY,REJECTED,ALREADY_INSIDE,QR,');
  });
});

describe('gate authorisation', () => {
  it('gate operators can only scan at assigned gates and cannot change data', async () => {
    const { ev, entry, exit, people } = await setup(1);
    const op = await loginAdmin(env, 'GATE_OPERATOR');
    const { url, credentialId } = await issuePass(admin, ev.id, people[0].id);

    const denied = await scan(op, entry.id, url);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('GATE_NOT_ASSIGNED');

    await admin.post(`/api/admin/event-gates/${entry.id}/operators`, { email: op.user.email });
    expect((await scan(op, entry.id, url)).body.result).toBe('ACCEPTED');
    expect((await scan(op, exit.id, url)).status).toBe(403);

    const stations = (await op.get('/api/staff/stations')).body;
    expect(stations.gates.map((g: { id: string }) => g.id)).toEqual([entry.id]);

    // No data changes, credential management or overrides.
    expect((await op.patch(`/api/admin/events/${ev.id}/participants/${people[0].id}`, { name: 'X', reason: 'test' })).status).toBe(403);
    expect((await op.post(`/api/admin/event-credentials/${credentialId}/revoke`, { reason: 'test' })).status).toBe(403);
    expect((await op.post(`/api/admin/events/${ev.id}/participants/${people[0].id}/manual-access`, { direction: 'OUT', override: true, reason: 'x y z' })).status).toBe(403);
    expect((await op.get(`/api/admin/events/${ev.id}/participants/${people[0].id}`)).status).toBe(403);
    expect((await op.get('/api/admin/sessions')).status).toBe(403);
  });

  it('volunteers and anonymous users cannot scan', async () => {
    const { entry } = await setup(1);
    const { registerVolunteer } = await import('./helpers.js');
    const vol = await registerVolunteer(env);
    expect((await scan(vol, entry.id, 'x')).status).toBe(403);
  });
});
