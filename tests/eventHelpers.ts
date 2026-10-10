import type { Client, TestEnv } from './helpers.js';

export async function createEvent(admin: Client, overrides: Record<string, unknown> = {}) {
  const res = await admin.post('/api/admin/events', {
    name: 'World Summit',
    timezone: 'Asia/Singapore',
    starts_at: '2026-10-10T08:00',
    ends_at: '2026-10-12T18:00',
    venue_text: 'Expo Hall',
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`create event failed: ${res.status} ${JSON.stringify(res.body)}`);
  const event = res.body.event as { id: string; status: string };
  const act = await admin.patch(`/api/admin/events/${event.id}`, { status: 'ACTIVE' });
  if (act.status !== 200) throw new Error(`activate failed: ${JSON.stringify(act.body)}`);
  return act.body.event as { id: string; status: string };
}

export async function createGate(admin: Client, eventId: string, name: string, mode: 'ENTRY' | 'EXIT') {
  const res = await admin.post(`/api/admin/events/${eventId}/gates`, { name, mode });
  if (res.status !== 201) throw new Error(`create gate failed: ${JSON.stringify(res.body)}`);
  return res.body.gate as { id: string; name: string; mode: string };
}

export const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

export async function importCsv(admin: Client, eventId: string, csv: string, extra: object = {}) {
  return admin.post(`/api/admin/events/${eventId}/participants/import/commit`, { file_base64: b64(csv), filename: 'list.csv', ...extra });
}

export async function participants(admin: Client, eventId: string, query = '') {
  const res = await admin.get(`/api/admin/events/${eventId}/participants${query}`);
  return res.body.participants as { id: string; name: string; registration_reference: string; current_access_state: string; active_credential_id: string | null }[];
}

/** Issue a pass and return the raw token (via the desk reprint endpoint, as staff would). */
export async function issuePass(admin: Client, eventId: string, participantId: string) {
  const res = await admin.post(`/api/admin/events/${eventId}/participants/${participantId}/credentials`, {});
  if (res.status !== 201) throw new Error(`issue failed: ${JSON.stringify(res.body)}`);
  const pass = await admin.get(`/api/admin/event-credentials/${res.body.credential.id}/pass`);
  return { credentialId: res.body.credential.id as string, url: pass.body.pass.pass_url as string };
}

export const scan = (c: Client, gateId: string, credential: string, idempotencyKey?: string) =>
  c.post('/api/gate-scan', { gate_id: gateId, credential, idempotency_key: idempotencyKey });

export async function occupancy(admin: Client, eventId: string) {
  return (await admin.get(`/api/admin/events/${eventId}/occupancy`)).body;
}

export async function accessEventCount(env: TestEnv, eventId: string, result?: 'ACCEPTED' | 'REJECTED') {
  const { rows } = await env.ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM event_access_events WHERE event_id = $1 ${result ? 'AND result = $2' : ''}`,
    result ? [eventId, result] : [eventId],
  );
  return rows[0].n;
}
