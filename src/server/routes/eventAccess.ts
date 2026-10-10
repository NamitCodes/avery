import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { DESK_STAFF, EVENT_MANAGERS, GATE_STAFF, requireRoles } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { csvCell } from './adminReports.js';
import { publicCredential } from './adminEvents.js';
import { assertGateAccess, correctAccessEvent, gateScan, staffAccess } from '../services/events/access.js';
import { gateView, getEvent, getParticipant, type EventRow, type GateRow, type ParticipantRow } from '../services/events/common.js';
import { buildPass, decryptToken, issueCredential, revokeCredential, type CredentialRow } from '../services/events/credentials.js';
import { kickDeliveries, queueDelivery, retryDelivery } from '../services/events/deliveries.js';
import { registerWalkIn } from '../services/events/registration.js';
import { recordStaffVerification, startContactVerification, confirmContactVerification } from '../services/events/verification.js';
import { addMinutes, formatInZone, startOfDay } from '../time.js';
import { queryString, reason, uuid, uuidParam } from '../validation.js';

const managers = requireRoles(EVENT_MANAGERS);
const desk = requireRoles(DESK_STAFF);
const gateStaff = requireRoles(GATE_STAFF);

const scanBody = z.object({
  gate_id: uuid,
  // Raw scanner output: the pass URL or token. Anything else is rejected as unknown.
  credential: z.string().min(1).max(500),
  idempotency_key: z.string().min(8).max(100).optional(),
});

async function loadCredential(ctx: AppContext, id: string) {
  const { rows } = await ctx.db.query<CredentialRow>('SELECT * FROM event_credentials WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('CREDENTIAL_NOT_FOUND', 'Pass not found.');
  return rows[0];
}

export function eventAccessRoutes(ctx: AppContext, scanLimiter: RequestHandler) {
  const r = Router();

  // ---- Stations --------------------------------------------------------------

  /** Events and gates the signed-in staff member may operate. */
  r.get('/staff/stations', gateStaff, async (req, res) => {
    const user = req.user!;
    const { rows } = await ctx.db.query(
      `SELECT g.id, g.name, g.mode, g.location_description, g.status, e.id AS event_id, e.name AS event_name, e.reentry_enabled
       FROM event_gates g JOIN events e ON e.id = g.event_id
       WHERE e.status = 'ACTIVE' AND g.status = 'ACTIVE'
         AND ($1 <> 'GATE_OPERATOR' OR EXISTS (SELECT 1 FROM event_gate_operators o WHERE o.gate_id = g.id AND o.operator_id = $2))
       ORDER BY e.starts_at, g.name`,
      [user.role, user.id],
    );
    const { rows: events } = DESK_STAFF.includes(user.role)
      ? await ctx.db.query(`SELECT id, name, starts_at, timezone, walk_ins_enabled, verification_policy FROM events WHERE status = 'ACTIVE' ORDER BY starts_at`)
      : { rows: [] };
    res.json({ gates: rows, desk_events: events });
  });

  r.get('/staff/gates/:gateId', gateStaff, async (req, res) => {
    const id = uuidParam(req.params.gateId, 'Gate');
    const { rows } = await ctx.db.query<GateRow & { event: EventRow }>(
      `SELECT g.*, row_to_json(e.*) AS event FROM event_gates g JOIN events e ON e.id = g.event_id WHERE g.id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound('GATE_NOT_FOUND', 'Gate not found.');
    await assertGateAccess(ctx.db, req.user!, id);
    const { event, ...gate } = rows[0];
    res.json({
      gate,
      event: {
        id: event.id, name: event.name, status: event.status, reentry_enabled: event.reentry_enabled,
        verification_policy: event.verification_policy, id_check_mode: event.id_check_mode, capacity: event.capacity, timezone: event.timezone,
      },
      operator: { id: req.user!.id, name: req.user!.name },
    });
  });

  // ---- Scanning ---------------------------------------------------------------

  r.post('/gate-scan', gateStaff, scanLimiter, async (req, res) => {
    const body = scanBody.parse(req.body);
    const outcome = await gateScan(ctx, req.user!, { gateId: body.gate_id, scanned: body.credential, idempotencyKey: body.idempotency_key ?? null });
    res.locals.scanRejected = outcome.result === 'REJECTED' && !outcome.replay;
    res.json(outcome);
  });
  // §26 equivalents: same processing, but the gate must be in the matching mode.
  for (const [path, mode] of [['/event-check-in', 'ENTRY'], ['/event-check-out', 'EXIT']] as const) {
    r.post(path, gateStaff, scanLimiter, async (req, res) => {
      const body = scanBody.parse(req.body);
      const outcome = await gateScan(ctx, req.user!, { gateId: body.gate_id, scanned: body.credential, idempotencyKey: body.idempotency_key ?? null, expectMode: mode });
      res.locals.scanRejected = outcome.result === 'REJECTED' && !outcome.replay;
      res.json(outcome);
    });
  }

  /** ID check result recorded at the gate or desk (gate operators may record CHECKED/FAILED, not overrides). */
  r.post(['/admin/events/:eventId/participants/:participantId/verify-identity', '/admin/event-registrations/:participantId/verify-identity'], gateStaff, async (req, res) => {
    const body = z.object({ outcome: z.enum(['CHECKED', 'FAILED', 'OVERRIDDEN']), reason: reason.optional(), event_id: uuid.optional() }).parse(req.body);
    if (body.outcome === 'OVERRIDDEN' && !DESK_STAFF.includes(req.user!.role)) {
      throw conflict('OVERRIDE_NOT_ALLOWED', 'Only exception-desk staff or managers may override an ID check.');
    }
    const pid = uuidParam(req.params.participantId, 'Participant');
    const eventId = req.params.eventId ? uuidParam(req.params.eventId, 'Event') : (await participantEvent(ctx, pid));
    const p = await recordStaffVerification(ctx, req.user!.id, eventId, pid, { kind: 'ID', outcome: body.outcome, reason: body.reason ?? null });
    res.json({ participant: gateView(p) });
  });

  // ---- Desk --------------------------------------------------------------------

  r.post('/admin/events/:eventId/walk-ins', desk, async (req, res) => {
    const eventId = uuidParam(req.params.eventId, 'Event');
    const body = z
      .object({
        name: z.string().trim().min(1, 'Name is required.').max(200),
        email: z.string().trim().max(320).nullable().optional(),
        phone: z.string().trim().max(40).nullable().optional(),
        country: z.string().trim().max(100).nullable().optional(),
        confirm_new: z.boolean().default(false),
        contact_unavailable: z.boolean().default(false),
        send_email: z.boolean().default(false),
      })
      .parse(req.body);
    const result = await registerWalkIn(ctx, req.user!.id, eventId, {
      ...body,
      confirmNew: body.confirm_new,
      contactUnavailable: body.contact_unavailable,
      sendEmail: body.send_email,
    });
    res.status(201).json({ participant: gateView(result.participant), pass: result.pass });
  });

  /** Desk check-in/out (normal policy checks) or an authorised manual override (MANUAL source, reason required). */
  r.post('/admin/events/:eventId/participants/:participantId/manual-access', desk, async (req, res) => {
    const eventId = uuidParam(req.params.eventId, 'Event');
    const pid = uuidParam(req.params.participantId, 'Participant');
    const body = z
      .object({
        direction: z.enum(['IN', 'OUT']),
        override: z.boolean().default(false),
        reason: reason.optional(),
        idempotency_key: z.string().min(8).max(100).optional(),
      })
      .parse(req.body);
    if (body.override && !body.reason) throw badRequest('REASON_REQUIRED', 'A manual override requires a reason.');
    const outcome = await staffAccess(ctx, req.user!, {
      eventId,
      participantId: pid,
      direction: body.direction,
      override: body.override,
      reason: body.reason ?? null,
      idempotencyKey: body.idempotency_key ?? null,
    });
    res.json(outcome);
  });

  r.post('/admin/event-access-events/:id/correct', desk, async (req, res) => {
    const id = uuidParam(req.params.id, 'Access record');
    const why = reason.parse(req.body?.reason);
    const correction = await correctAccessEvent(ctx, req.user!, id, why);
    res.status(201).json({ correction });
  });

  /** Contact verification by desk staff: send a code, confirm it, or override (with reason). */
  r.post(['/admin/events/:eventId/participants/:participantId/verify-contact', '/admin/event-registrations/:participantId/verify-contact'], desk, async (req, res) => {
    const pid = uuidParam(req.params.participantId, 'Participant');
    const eventId = req.params.eventId ? uuidParam(req.params.eventId, 'Event') : await participantEvent(ctx, pid);
    await getParticipant(ctx.db, eventId, pid);
    const body = z.object({ action: z.enum(['start', 'confirm', 'override', 'fail']), code: z.string().max(10).optional(), reason: reason.optional() }).parse(req.body);
    if (body.action === 'start') return void res.json(await startContactVerification(ctx, pid));
    if (body.action === 'confirm') return void res.json(await confirmContactVerification(ctx, pid, body.code ?? ''));
    const p = await recordStaffVerification(ctx, req.user!.id, eventId, pid, {
      kind: 'CONTACT',
      outcome: body.action === 'override' ? 'OVERRIDDEN' : 'FAILED',
      reason: body.reason ?? null,
    });
    kickDeliveries(ctx);
    res.json({ participant: gateView(p) });
  });

  // ---- Credentials ----------------------------------------------------------------

  r.post('/admin/event-registrations/:participantId/credentials', desk, async (req, res) => {
    // §26 alias: issue (or, with replace=true, replace) a pass for a registration.
    const pid = uuidParam(req.params.participantId, 'Registration');
    const eventId = await participantEvent(ctx, pid);
    const body = z.object({ replace: z.boolean().default(false), identity_verified: z.boolean().default(false), reason: reason.optional() }).parse(req.body ?? {});
    const now = ctx.clock.now();
    const out = await ctx.db.transaction(async (tx) => {
      const p = await getParticipant(tx, eventId, pid, 'FOR UPDATE');
      const { rows } = await tx.query(`SELECT 1 FROM event_credentials WHERE participant_id = $1 AND status = 'ACTIVE'`, [pid]);
      if (rows[0] && !body.replace) throw conflict('CREDENTIAL_EXISTS', 'This registration already has an active pass.');
      if (rows[0] && (!body.identity_verified || !body.reason)) {
        throw badRequest('VERIFICATION_REQUIRED', 'Confirm the attendee’s identity was verified and give a reason before replacing a pass.');
      }
      return { p, issued: await issueCredential(tx, ctx.config, p, req.user!.id, now, body.reason) };
    });
    const event = await getEvent(ctx.db, eventId);
    res.status(201).json({ credential: publicCredential(out.issued.credential), pass: await buildPass(ctx.config, event, out.p, out.issued.token) });
  });

  r.post('/admin/event-credentials/:id/revoke', desk, async (req, res) => {
    const id = uuidParam(req.params.id, 'Pass');
    const why = reason.parse(req.body?.reason);
    const credential = await ctx.db.transaction((tx) => revokeCredential(tx, id, req.user!.id, ctx.clock.now(), why));
    res.json({ credential: publicCredential(credential) });
  });

  /**
   * Replace a lost/damaged pass: revokes the old credential and issues a new one
   * for the same participant. Staff must confirm identity was verified first.
   */
  r.post('/admin/event-credentials/:id/replace', desk, async (req, res) => {
    const id = uuidParam(req.params.id, 'Pass');
    const body = z.object({ reason, identity_verified: z.literal(true, { message: 'Confirm the participant’s identity was verified.' }), send_email: z.boolean().default(false) }).parse(req.body);
    const old = await loadCredential(ctx, id);
    if (old.status !== 'ACTIVE') throw conflict('CREDENTIAL_NOT_ACTIVE', 'Only the current active pass can be replaced.');
    const now = ctx.clock.now();
    const out = await ctx.db.transaction(async (tx) => {
      const p = await getParticipant(tx, old.event_id, old.participant_id, 'FOR UPDATE');
      if (p.status !== 'ACTIVE') throw conflict('PARTICIPANT_INACTIVE', 'Passes can only be issued to active registrations.');
      const issued = await issueCredential(tx, ctx.config, p, req.user!.id, now, body.reason);
      if (issued.replaced?.id !== id) throw conflict('CREDENTIAL_CHANGED', 'The pass changed while replacing it. Reload and try again.');
      await tx.query(
        `UPDATE event_pass_deliveries SET delivery_status = 'CANCELLED', updated_at = $2 WHERE credential_id = $1 AND delivery_status IN ('QUEUED','FAILED')`,
        [id, now],
      );
      if (body.send_email && p.email) await queueDelivery(tx, p, issued.credential.id, req.user!.id, now);
      return { p, issued };
    });
    kickDeliveries(ctx);
    const event = await getEvent(ctx.db, old.event_id);
    res.status(201).json({ credential: publicCredential(out.issued.credential), pass: await buildPass(ctx.config, event, out.p, out.issued.token) });
  });

  /** Printable pass data for the current credential (desk reprint). Audited. */
  r.get('/admin/event-credentials/:id/pass', desk, async (req, res) => {
    const c = await loadCredential(ctx, uuidParam(req.params.id, 'Pass'));
    if (c.status !== 'ACTIVE') throw conflict('CREDENTIAL_NOT_ACTIVE', 'This pass has been revoked and cannot be printed.');
    const event = await getEvent(ctx.db, c.event_id);
    const p = await getParticipant(ctx.db, c.event_id, c.participant_id);
    await writeAudit(ctx.db, { actorId: req.user!.id, action: 'event_credential.print', entityType: 'event_credential', entityId: c.id }, ctx.clock.now());
    res.set('Cache-Control', 'no-store').json({ pass: await buildPass(ctx.config, event, p, decryptToken(c.token_ciphertext, ctx.config.credentialKey)) });
  });

  r.post('/admin/event-pass-deliveries/:id/retry', desk, async (req, res) => {
    const delivery = await retryDelivery(ctx, req.user!.id, uuidParam(req.params.id, 'Delivery'));
    kickDeliveries(ctx);
    res.json({ delivery });
  });

  // ---- Monitoring & reports -------------------------------------------------------

  r.get('/admin/events/:eventId/occupancy', desk, async (req, res) => {
    const eventId = uuidParam(req.params.eventId, 'Event');
    const event = await getEvent(ctx.db, eventId);
    const { rows } = await ctx.db.query<Record<string, number>>(
      `SELECT
        count(*)::int AS total_participants,
        count(*) FILTER (WHERE status = 'ACTIVE')::int AS active_participants,
        count(*) FILTER (WHERE current_access_state = 'INSIDE')::int AS inside,
        count(*) FILTER (WHERE checked_in_at IS NOT NULL)::int AS checked_in_unique,
        count(*) FILTER (WHERE registration_source = 'IMPORT')::int AS source_import,
        count(*) FILTER (WHERE registration_source = 'ONLINE')::int AS source_online,
        count(*) FILTER (WHERE registration_source = 'WALK_IN')::int AS source_walk_in,
        count(*) FILTER (WHERE registration_source = 'ADMIN')::int AS source_admin,
        count(*) FILTER (WHERE contact_verification = 'VERIFIED')::int AS contact_verified,
        count(*) FILTER (WHERE contact_verification = 'PENDING')::int AS contact_pending,
        count(*) FILTER (WHERE contact_verification = 'FAILED')::int AS contact_failed,
        count(*) FILTER (WHERE contact_verification = 'OVERRIDDEN')::int AS contact_overridden,
        count(*) FILTER (WHERE id_check = 'CHECKED')::int AS id_checked,
        count(*) FILTER (WHERE id_check = 'PENDING')::int AS id_pending,
        count(*) FILTER (WHERE id_check = 'FAILED')::int AS id_failed,
        count(*) FILTER (WHERE id_check = 'OVERRIDDEN')::int AS id_overridden,
        count(*) FILTER (WHERE needs_review)::int AS needs_review
       FROM event_participants WHERE event_id = $1`,
      [eventId],
    );
    const { rows: ev } = await ctx.db.query<Record<string, number>>(
      `SELECT
        count(*) FILTER (WHERE result = 'ACCEPTED' AND event_type IN ('ENTRY', 'CHECK_IN'))::int AS accepted_entries,
        count(*) FILTER (WHERE result = 'ACCEPTED' AND event_type = 'EXIT')::int AS accepted_exits,
        count(*) FILTER (WHERE result = 'REJECTED')::int AS rejected_scans,
        count(*) FILTER (WHERE source = 'MANUAL' AND event_type <> 'CORRECTION')::int AS manual_overrides,
        count(*) FILTER (WHERE source = 'DESK')::int AS desk_actions,
        count(*) FILTER (WHERE event_type = 'CORRECTION')::int AS corrections
       FROM event_access_events WHERE event_id = $1`,
      [eventId],
    );
    // Reconciliation: recompute state from the append-only history and compare.
    const { rows: derived } = await ctx.db.query<{ inside: number; mismatches: number }>(
      `WITH last AS (
         SELECT DISTINCT ON (e.participant_id) e.participant_id, e.event_type
         FROM event_access_events e
         WHERE e.event_id = $1 AND e.result = 'ACCEPTED' AND e.event_type <> 'CORRECTION'
           AND NOT EXISTS (SELECT 1 FROM event_access_events c WHERE c.corrects_event_id = e.id)
         ORDER BY e.participant_id, e.occurred_at DESC, e.created_at DESC)
       SELECT count(*) FILTER (WHERE l.event_type IN ('ENTRY', 'CHECK_IN'))::int AS inside,
              (SELECT count(*)::int FROM event_participants p LEFT JOIN last l2 ON l2.participant_id = p.id
               WHERE p.event_id = $1 AND (p.current_access_state = 'INSIDE') <> COALESCE(l2.event_type IN ('ENTRY', 'CHECK_IN'), false)) AS mismatches
       FROM last l`,
      [eventId],
    );
    const { rows: rejects } = await ctx.db.query(
      `SELECT reject_code, count(*)::int AS n FROM event_access_events WHERE event_id = $1 AND result = 'REJECTED' GROUP BY reject_code ORDER BY n DESC`,
      [eventId],
    );
    const { rows: gates } = await ctx.db.query(
      `SELECT g.id, g.name, g.mode, g.status,
         count(a.*) FILTER (WHERE a.result = 'ACCEPTED')::int AS accepted,
         count(a.*) FILTER (WHERE a.result = 'REJECTED')::int AS rejected
       FROM event_gates g LEFT JOIN event_access_events a ON a.gate_id = g.id
       WHERE g.event_id = $1 GROUP BY g.id ORDER BY g.name`,
      [eventId],
    );
    res.json({
      event: { id: event.id, name: event.name, capacity: event.capacity, reentry_enabled: event.reentry_enabled, status: event.status },
      ...rows[0],
      ...ev[0],
      reconciliation: { derived_inside: derived[0].inside, mismatched_participants: derived[0].mismatches },
      rejections: rejects,
      gates,
    });
  });

  const accessFilters = (eventId: string, q: Record<string, unknown>, tz: string) => {
    const where = ['a.event_id = $1'];
    const params: unknown[] = [eventId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    const pid = queryString(q.participant_id);
    if (pid) add('a.participant_id = ?', uuidParam(pid, 'Participant'));
    const gid = queryString(q.gate_id);
    if (gid) add('a.gate_id = ?', uuidParam(gid, 'Gate'));
    const result = queryString(q.result);
    if (result === 'ACCEPTED' || result === 'REJECTED') add('a.result = ?', result);
    const type = queryString(q.event_type);
    if (type) add('a.event_type = ?', type);
    const source = queryString(q.source);
    if (source) add('a.source = ?', source);
    const from = queryString(q.from);
    if (from) add('a.occurred_at >= ?', startOfDay(from, tz, 'from'));
    const to = queryString(q.to);
    if (to) add('a.occurred_at < ?', addMinutes(startOfDay(to, tz, 'to'), 24 * 60));
    return { where: where.join(' AND '), params };
  };

  const ACCESS_SELECT = `
    SELECT a.*, p.name AS participant_name, p.registration_reference, g.name AS gate_name, o.name AS operator_name,
      EXISTS (SELECT 1 FROM event_access_events c WHERE c.corrects_event_id = a.id) AS corrected
    FROM event_access_events a
    LEFT JOIN event_participants p ON p.id = a.participant_id
    LEFT JOIN event_gates g ON g.id = a.gate_id
    LEFT JOIN volunteers o ON o.id = a.operator_id`;

  r.get('/admin/events/:eventId/access-events', desk, async (req, res) => {
    const eventId = uuidParam(req.params.eventId, 'Event');
    const event = await getEvent(ctx.db, eventId);
    const { where, params } = accessFilters(eventId, req.query, event.timezone);
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '200'), 10) || 200, 1), 1000);
    const { rows } = await ctx.db.query(`${ACCESS_SELECT} WHERE ${where} ORDER BY a.occurred_at DESC, a.created_at DESC LIMIT ${limit}`, params);
    res.json({ access_events: rows });
  });

  r.get('/admin/events/:eventId/access-events/export.csv', managers, async (req, res) => {
    const eventId = uuidParam(req.params.eventId, 'Event');
    const event = await getEvent(ctx.db, eventId);
    const { where, params } = accessFilters(eventId, req.query, event.timezone);
    const { rows } = await ctx.db.query<Record<string, unknown> & { occurred_at: Date }>(`${ACCESS_SELECT} WHERE ${where} ORDER BY a.occurred_at, a.created_at`, params);
    const header = [`Time (${event.timezone})`, 'Time (UTC)', 'Type', 'Result', 'Reject code', 'Source', 'Registration reference', 'Participant', 'Gate', 'Operator', 'Reason', 'Corrected'];
    const lines = [header.map(csvCell).join(',')];
    for (const a of rows) {
      lines.push(
        [
          formatInZone(a.occurred_at, event.timezone, 'yyyy-MM-dd HH:mm:ss'), a.occurred_at.toISOString(), a.event_type, a.result, a.reject_code,
          a.source, a.registration_reference, a.participant_name, a.gate_name, a.operator_name, a.reason, a.corrected ? 'yes' : '',
        ].map(csvCell).join(','),
      );
    }
    await writeAudit(ctx.db, { actorId: req.user!.id, action: 'event.export_access', entityType: 'event', entityId: eventId, after: { rows: rows.length } }, ctx.clock.now());
    res.attachment(`access-${eventId.slice(0, 8)}.csv`).type('text/csv; charset=utf-8').send(`\uFEFF${lines.join('\r\n')}\r\n`);
  });

  /** Registration + attendance export (§26): distinguishes registered, verified, ID-checked, checked-in and inside. */
  r.get('/admin/events/:eventId/attendance.csv', managers, async (req, res) => {
    const eventId = uuidParam(req.params.eventId, 'Event');
    const event = await getEvent(ctx.db, eventId);
    const { rows } = await ctx.db.query<ParticipantRow>(`SELECT * FROM event_participants WHERE event_id = $1 ORDER BY registered_at`, [eventId]);
    const header = ['Registration reference', 'Name', 'Country', 'Source', 'Registration status', `Registered (${event.timezone})`, 'Contact verification', 'ID check', 'Checked in', `First check-in (${event.timezone})`, 'Currently inside'];
    const lines = [header.map(csvCell).join(',')];
    const fmt = (d: Date | null) => (d ? formatInZone(d, event.timezone, 'yyyy-MM-dd HH:mm:ss') : '');
    for (const p of rows) {
      lines.push(
        [
          p.registration_reference, p.name, p.country, p.registration_source, p.status, fmt(p.registered_at), p.contact_verification, p.id_check,
          p.checked_in_at ? 'yes' : 'no', fmt(p.checked_in_at), event.reentry_enabled ? (p.current_access_state === 'INSIDE' ? 'yes' : 'no') : '',
        ].map(csvCell).join(','),
      );
    }
    await writeAudit(ctx.db, { actorId: req.user!.id, action: 'event.export_attendance', entityType: 'event', entityId: eventId, after: { rows: rows.length } }, ctx.clock.now());
    res.attachment(`attendance-${eventId.slice(0, 8)}.csv`).type('text/csv; charset=utf-8').send(`\uFEFF${lines.join('\r\n')}\r\n`);
  });

  return r;
}

async function participantEvent(ctx: AppContext, participantId: string): Promise<string> {
  const { rows } = await ctx.db.query<{ event_id: string }>('SELECT event_id FROM event_participants WHERE id = $1', [participantId]);
  if (!rows[0]) throw notFound('PARTICIPANT_NOT_FOUND', 'Registration not found.');
  return rows[0].event_id;
}
