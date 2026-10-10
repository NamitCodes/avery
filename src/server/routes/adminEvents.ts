import { Router } from 'express';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { DESK_STAFF, EVENT_MANAGERS, requireRoles } from '../auth.js';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { csvCell } from './adminReports.js';
import {
  getEvent,
  getParticipant,
  likeEscape,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  staffView,
  EMAIL_PATTERN,
  type EventRow,
  type GateRow,
  type ParticipantRow,
} from '../services/events/common.js';
import { CREDENTIAL_PUBLIC_COLUMNS, issueCredential, type CredentialRow } from '../services/events/credentials.js';
import { kickDeliveries, queueDelivery } from '../services/events/deliveries.js';
import { analyzeImport, commitImport, decodeUpload } from '../services/events/import.js';
import { formatInZone, isValidTimezone, parseDateTimeInZone } from '../time.js';
import { queryString, reason, uuid, uuidParam } from '../validation.js';

const managers = requireRoles(EVENT_MANAGERS);
const desk = requireRoles(DESK_STAFF);

const eventFields = {
  name: z.string().trim().min(1, 'Event name is required.').max(200),
  description: z.string().trim().max(5000),
  location_id: uuid.nullable(),
  venue_text: z.string().trim().max(500),
  timezone: z.string().refine(isValidTimezone, 'Choose a valid time zone.'),
  starts_at: z.string().min(1).max(40),
  ends_at: z.string().min(1).max(40),
  capacity: z.number().int().positive().nullable(),
  advance_registration_enabled: z.boolean(),
  walk_ins_enabled: z.boolean(),
  pause_registration_at_capacity: z.boolean(),
  reentry_enabled: z.boolean(),
  print_badges: z.boolean(),
  contact_requirement: z.enum(['NONE', 'EMAIL', 'PHONE', 'EMAIL_OR_PHONE']),
  verification_policy: z.enum(['BASIC_REGISTRATION', 'CONTACT_VERIFIED', 'IN_PERSON_ID_CHECK']),
  id_check_mode: z.enum(['NOT_USED', 'CONDITIONAL', 'MANDATORY']),
  instructions: z.string().trim().max(2000),
};
const createEventBody = z.object({
  ...eventFields,
  description: eventFields.description.default(''),
  location_id: eventFields.location_id.default(null),
  venue_text: eventFields.venue_text.default(''),
  capacity: eventFields.capacity.default(null),
  advance_registration_enabled: eventFields.advance_registration_enabled.default(false),
  walk_ins_enabled: eventFields.walk_ins_enabled.default(false),
  pause_registration_at_capacity: eventFields.pause_registration_at_capacity.default(false),
  reentry_enabled: eventFields.reentry_enabled.default(true),
  print_badges: eventFields.print_badges.default(true),
  contact_requirement: eventFields.contact_requirement.default('EMAIL'),
  verification_policy: eventFields.verification_policy.default('BASIC_REGISTRATION'),
  id_check_mode: eventFields.id_check_mode.default('NOT_USED'),
  instructions: eventFields.instructions.default(''),
});
const updateEventBody = z.object({ ...eventFields, status: z.enum(['DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED']), reason }).partial();

const EVENT_STATUS_FLOW: Record<string, string[]> = {
  DRAFT: ['ACTIVE'],
  ACTIVE: ['CLOSED'],
  CLOSED: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: [],
};

/** Normalise and validate a full event configuration. */
function checkEventConfig(e: Pick<EventRow, 'verification_policy' | 'id_check_mode' | 'contact_requirement' | 'starts_at' | 'ends_at'>) {
  if (e.ends_at <= e.starts_at) throw badRequest('INVALID_TIMES', 'The event must end after it starts.');
  if (e.verification_policy === 'IN_PERSON_ID_CHECK' && e.id_check_mode !== 'MANDATORY') {
    throw badRequest('INVALID_POLICY', 'The in-person ID check policy requires ID checks to be mandatory.');
  }
  if (e.verification_policy === 'CONTACT_VERIFIED' && e.contact_requirement !== 'EMAIL') {
    throw badRequest('INVALID_POLICY', 'Contact verification is by email code, so an email address must be required.');
  }
}

const participantUpdateBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    country: z.string().trim().max(100),
    email: z.string().trim().max(320).nullable(),
    phone: z.string().trim().max(40).nullable(),
    status: z.enum(['ACTIVE', 'INACTIVE', 'CANCELLED']),
    needs_review: z.boolean(),
    review_note: z.string().trim().max(500).nullable(),
  })
  .partial()
  .extend({ reason });

const importBody = z.object({
  file_base64: z.string().min(1),
  filename: z.string().max(255).nullable().default(null),
  mapping: z.object({ name: z.number().int(), country: z.number().int(), email: z.number().int() }).partial().optional(),
  existing_policy: z.enum(['SKIP', 'UPDATE']).default('SKIP'),
});

const gateBody = z.object({
  name: z.string().trim().min(1).max(100),
  mode: z.enum(['ENTRY', 'EXIT']),
  location_description: z.string().trim().max(300).default(''),
});
const gateUpdateBody = z
  .object({ name: z.string().trim().min(1).max(100), mode: z.enum(['ENTRY', 'EXIT']), location_description: z.string().trim().max(300), status: z.enum(['ACTIVE', 'INACTIVE']) })
  .partial();

const showContact = (role: string) => EVENT_MANAGERS.includes(role as never);

function participantFilters(eventId: string, query: Record<string, unknown>) {
  const where = ['p.event_id = $1'];
  const params: unknown[] = [eventId];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace(/\?/g, `$${params.length}`));
  };
  const q = queryString(query.q);
  if (q) {
    // Unicode-aware partial matching on name, reference, email and phone.
    const parts: string[] = [];
    const like = (sql: string, v: string) => {
      params.push(`%${likeEscape(v)}%`);
      parts.push(`${sql} $${params.length}`);
    };
    like('p.normalized_name LIKE', normalizeName(q));
    like('p.registration_reference ILIKE', q);
    like('p.normalized_email LIKE', normalizeEmail(q)!);
    const phone = normalizePhone(q)?.replace('+', '');
    if (phone && phone.length >= 4) like('p.normalized_phone LIKE', phone);
    where.push(`(${parts.join(' OR ')})`);
  }
  const country = queryString(query.country);
  if (country) add('lower(p.country) = lower(?)', country);
  const state = queryString(query.state);
  if (state === 'INSIDE' || state === 'OUTSIDE') add('p.current_access_state = ?', state);
  if (state === 'NOT_CHECKED_IN') where.push('p.checked_in_at IS NULL');
  if (state === 'CHECKED_IN') where.push('p.checked_in_at IS NOT NULL');
  const pass = queryString(query.pass_status);
  if (pass === 'ACTIVE') where.push(`EXISTS (SELECT 1 FROM event_credentials c WHERE c.participant_id = p.id AND c.status = 'ACTIVE')`);
  if (pass === 'NONE') where.push(`NOT EXISTS (SELECT 1 FROM event_credentials c WHERE c.participant_id = p.id AND c.status = 'ACTIVE')`);
  const source = queryString(query.source);
  if (source) add('p.registration_source = ?', source);
  const status = queryString(query.status);
  if (status) add('p.status = ?', status);
  if (query.needs_review === '1') where.push('p.needs_review');
  return { where: where.join(' AND '), params };
}

async function loadGate(q: Queryable, id: string) {
  const { rows } = await q.query<GateRow>('SELECT * FROM event_gates WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('GATE_NOT_FOUND', 'Gate not found.');
  return rows[0];
}

export function adminEventRoutes(ctx: AppContext) {
  const r = Router();

  // ---- Events ------------------------------------------------------------

  r.post('/events', managers, async (req, res) => {
    const body = createEventBody.parse(req.body);
    const starts = parseDateTimeInZone(body.starts_at, body.timezone, 'starts_at');
    const ends = parseDateTimeInZone(body.ends_at, body.timezone, 'ends_at');
    const cfg = { ...body, starts_at: starts, ends_at: ends };
    if (cfg.verification_policy === 'IN_PERSON_ID_CHECK') cfg.id_check_mode = 'MANDATORY';
    checkEventConfig(cfg);
    const now = ctx.clock.now();
    const event = await ctx.db.transaction(async (tx) => {
      const { rows } = await tx.query<EventRow>(
        `INSERT INTO events (name, description, location_id, venue_text, timezone, starts_at, ends_at, capacity,
            advance_registration_enabled, walk_ins_enabled, pause_registration_at_capacity, reentry_enabled, print_badges,
            contact_requirement, verification_policy, id_check_mode, instructions, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19) RETURNING *`,
        [
          cfg.name, cfg.description, cfg.location_id, cfg.venue_text, cfg.timezone, starts, ends, cfg.capacity,
          cfg.advance_registration_enabled, cfg.walk_ins_enabled, cfg.pause_registration_at_capacity, cfg.reentry_enabled,
          cfg.print_badges, cfg.contact_requirement, cfg.verification_policy, cfg.id_check_mode, cfg.instructions, req.user!.id, now,
        ],
      );
      await writeAudit(tx, { actorId: req.user!.id, action: 'event.create', entityType: 'event', entityId: rows[0].id, after: rows[0] }, now);
      return rows[0];
    });
    res.status(201).json({ event });
  });

  r.get('/events', desk, async (_req, res) => {
    const { rows } = await ctx.db.query(
      `SELECT e.*,
         (SELECT count(*)::int FROM event_participants p WHERE p.event_id = e.id) AS participant_count,
         (SELECT count(*)::int FROM event_participants p WHERE p.event_id = e.id AND p.current_access_state = 'INSIDE') AS inside_count,
         (SELECT count(*)::int FROM event_participants p WHERE p.event_id = e.id AND p.checked_in_at IS NOT NULL) AS checked_in_count
       FROM events e ORDER BY e.starts_at DESC LIMIT 200`,
    );
    res.json({ events: rows });
  });

  r.get('/events/:eventId', desk, async (req, res) => {
    const event = await getEvent(ctx.db, uuidParam(req.params.eventId, 'Event'));
    res.json({ event });
  });

  r.patch('/events/:eventId', managers, async (req, res) => {
    const id = uuidParam(req.params.eventId, 'Event');
    const { reason: why, ...changes } = updateEventBody.parse(req.body);
    if (Object.keys(changes).length === 0) throw badRequest('NO_CHANGES', 'Nothing to update.');
    const now = ctx.clock.now();
    const event = await ctx.db.transaction(async (tx) => {
      const before = await getEvent(tx, id, 'FOR UPDATE');
      if (before.status === 'ARCHIVED') throw conflict('EVENT_ARCHIVED', 'Archived events cannot be changed.');
      if (changes.status && changes.status !== before.status && !EVENT_STATUS_FLOW[before.status].includes(changes.status)) {
        throw conflict('INVALID_TRANSITION', `Cannot change an event from ${before.status} to ${changes.status}.`);
      }
      const tz = changes.timezone ?? before.timezone;
      const next: EventRow = {
        ...before,
        ...changes,
        starts_at: changes.starts_at ? parseDateTimeInZone(changes.starts_at, tz, 'starts_at') : before.starts_at,
        ends_at: changes.ends_at ? parseDateTimeInZone(changes.ends_at, tz, 'ends_at') : before.ends_at,
      } as EventRow;
      if (next.verification_policy === 'IN_PERSON_ID_CHECK') next.id_check_mode = 'MANDATORY';
      checkEventConfig(next);
      const { rows } = await tx.query<EventRow>(
        `UPDATE events SET name=$2, description=$3, location_id=$4, venue_text=$5, timezone=$6, starts_at=$7, ends_at=$8,
           capacity=$9, advance_registration_enabled=$10, walk_ins_enabled=$11, pause_registration_at_capacity=$12,
           reentry_enabled=$13, print_badges=$14, contact_requirement=$15, verification_policy=$16, id_check_mode=$17,
           instructions=$18, status=$19, updated_at=$20
         WHERE id = $1 RETURNING *`,
        [
          id, next.name, next.description, next.location_id, next.venue_text, next.timezone, next.starts_at, next.ends_at,
          next.capacity, next.advance_registration_enabled, next.walk_ins_enabled, next.pause_registration_at_capacity,
          next.reentry_enabled, next.print_badges, next.contact_requirement, next.verification_policy, next.id_check_mode,
          next.instructions, next.status, now,
        ],
      );
      await writeAudit(
        tx,
        { actorId: req.user!.id, action: changes.status && changes.status !== before.status ? `event.${changes.status.toLowerCase()}` : 'event.update', entityType: 'event', entityId: id, before, after: rows[0], reason: why },
        now,
      );
      return rows[0];
    });
    res.json({ event });
  });

  /** Retention: irreversibly redact participant personal data for an archived event. */
  r.post('/events/:eventId/redact', requireRoles(['ADMIN']), async (req, res) => {
    const id = uuidParam(req.params.eventId, 'Event');
    const why = reason.parse(req.body?.reason);
    const now = ctx.clock.now();
    const result = await ctx.db.transaction(async (tx) => {
      const event = await getEvent(tx, id, 'FOR UPDATE');
      if (event.status !== 'ARCHIVED') throw conflict('EVENT_NOT_ARCHIVED', 'Only archived events can be redacted.');
      if (event.redacted_at) throw conflict('ALREADY_REDACTED', 'This event has already been redacted.');
      const { rows } = await tx.query<{ n: number }>(
        `WITH u AS (
           UPDATE event_participants SET name = 'Redacted', normalized_name = 'redacted', email = NULL, normalized_email = NULL,
             phone = NULL, normalized_phone = NULL, review_note = NULL, updated_at = $2
           WHERE event_id = $1 RETURNING 1)
         SELECT count(*)::int AS n FROM u`,
        [id, now],
      );
      await tx.query(`DELETE FROM event_contact_challenges WHERE participant_id IN (SELECT id FROM event_participants WHERE event_id = $1)`, [id]);
      await tx.query(`UPDATE event_pass_deliveries SET last_error = NULL WHERE event_id = $1`, [id]);
      await tx.query(`UPDATE events SET redacted_at = $2, updated_at = $2 WHERE id = $1`, [id, now]);
      await writeAudit(tx, { actorId: req.user!.id, action: 'event.redact', entityType: 'event', entityId: id, after: { participants: rows[0].n }, reason: why }, now);
      return { participants_redacted: rows[0].n };
    });
    res.json(result);
  });

  // ---- Participants --------------------------------------------------------

  // §26 alias: an open event's registrations are its participants.
  r.get(['/events/:eventId/participants', '/events/:eventId/registrations'], desk, async (req, res) => {
    const eventId = uuidParam(req.params.eventId, 'Event');
    await getEvent(ctx.db, eventId);
    const { where, params } = participantFilters(eventId, req.query);
    const pageSize = Math.min(Math.max(Number.parseInt(String(req.query.page_size ?? '50'), 10) || 50, 1), 200);
    const page = Math.max(Number.parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
    const { rows: total } = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM event_participants p WHERE ${where}`, params);
    const { rows } = await ctx.db.query<ParticipantRow & { active_credential_id: string | null; last_delivery_status: string | null }>(
      `SELECT p.*,
         (SELECT c.id FROM event_credentials c WHERE c.participant_id = p.id AND c.status = 'ACTIVE') AS active_credential_id,
         (SELECT d.delivery_status FROM event_pass_deliveries d WHERE d.participant_id = p.id ORDER BY d.created_at DESC LIMIT 1) AS last_delivery_status
       FROM event_participants p WHERE ${where}
       ORDER BY p.normalized_name, p.registration_reference
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    );
    const show = showContact(req.user!.role);
    res.json({
      participants: rows.map((p) => ({ ...staffView(p, show), active_credential_id: p.active_credential_id, last_delivery_status: p.last_delivery_status })),
      total: total[0].n,
      page,
      page_size: pageSize,
    });
  });
  r.get('/events/:eventId/participants/export.csv', managers, async (req, res) => {
    const eventId = uuidParam(req.params.eventId, 'Event');
    const event = await getEvent(ctx.db, eventId);
    const { where, params } = participantFilters(eventId, req.query);
    const { rows } = await ctx.db.query<ParticipantRow & { pass_status: string | null }>(
      `SELECT p.*, (SELECT 'ACTIVE' FROM event_credentials c WHERE c.participant_id = p.id AND c.status = 'ACTIVE') AS pass_status
       FROM event_participants p WHERE ${where} ORDER BY p.normalized_name`,
      params,
    );
    const header = ['Registration reference', 'Name', 'Country', 'Email', 'Phone', 'Source', 'Status', 'Pass', 'Contact verification', 'ID check', 'Current state', `Checked in (${event.timezone})`, 'Needs review'];
    const lines = [header.map(csvCell).join(',')];
    for (const p of rows) {
      lines.push(
        [
          p.registration_reference, p.name, p.country, p.email, p.phone, p.registration_source, p.status, p.pass_status ?? 'NONE',
          p.contact_verification, p.id_check, p.current_access_state,
          p.checked_in_at ? formatInZone(p.checked_in_at, event.timezone, 'yyyy-MM-dd HH:mm:ss') : '', p.needs_review ? 'yes' : '',
        ].map(csvCell).join(','),
      );
    }
    await writeAudit(ctx.db, { actorId: req.user!.id, action: 'event.export_participants', entityType: 'event', entityId: eventId, after: { rows: rows.length } }, ctx.clock.now());
    res.attachment(`participants-${eventId.slice(0, 8)}.csv`).type('text/csv; charset=utf-8').send(`\uFEFF${lines.join('\r\n')}\r\n`);
  });

  r.get('/events/:eventId/participants/:participantId', desk, async (req, res) => {
    const eventId = uuidParam(req.params.eventId, 'Event');
    const p = await getParticipant(ctx.db, eventId, uuidParam(req.params.participantId, 'Participant'));
    const [credentials, deliveries, access, verifications, audit] = await Promise.all([
      ctx.db.query(`SELECT ${CREDENTIAL_PUBLIC_COLUMNS} FROM event_credentials WHERE participant_id = $1 ORDER BY issued_at DESC`, [p.id]),
      ctx.db.query(`SELECT * FROM event_pass_deliveries WHERE participant_id = $1 ORDER BY created_at DESC`, [p.id]),
      ctx.db.query(
        `SELECT a.*, g.name AS gate_name, o.name AS operator_name FROM event_access_events a
         LEFT JOIN event_gates g ON g.id = a.gate_id LEFT JOIN volunteers o ON o.id = a.operator_id
         WHERE a.participant_id = $1 ORDER BY a.occurred_at DESC, a.created_at DESC LIMIT 200`,
        [p.id],
      ),
      ctx.db.query(
        `SELECT v.*, o.name AS verified_by_name FROM event_verifications v LEFT JOIN volunteers o ON o.id = v.verified_by
         WHERE v.participant_id = $1 ORDER BY v.verified_at DESC`,
        [p.id],
      ),
      ctx.db.query(
        `SELECT a.*, v.name AS actor_name FROM audit_logs a LEFT JOIN volunteers v ON v.id = a.actor_id
         WHERE a.entity_id = $1 ORDER BY a.created_at DESC LIMIT 100`,
        [p.id],
      ),
    ]);
    res.json({
      participant: staffView(p, showContact(req.user!.role)),
      credentials: credentials.rows,
      deliveries: deliveries.rows,
      access_events: access.rows,
      verifications: verifications.rows,
      audit: audit.rows,
    });
  });

  /** Registration corrections (desk staff may make approved corrections; always audited with a reason). */
  r.patch('/events/:eventId/participants/:participantId', desk, async (req, res) => {
    const eventId = uuidParam(req.params.eventId, 'Event');
    const pid = uuidParam(req.params.participantId, 'Participant');
    const { reason: why, ...changes } = participantUpdateBody.parse(req.body);
    if (Object.keys(changes).length === 0) throw badRequest('NO_CHANGES', 'Nothing to update.');
    if (changes.email && !EMAIL_PATTERN.test(changes.email)) throw badRequest('EMAIL_INVALID', 'Enter a valid email address.');
    const now = ctx.clock.now();
    const participant = await ctx.db.transaction(async (tx) => {
      const before = await getParticipant(tx, eventId, pid, 'FOR UPDATE');
      const event = await getEvent(tx, eventId);
      const next = { ...before, ...changes };
      const emailChanged = 'email' in changes && normalizeEmail(changes.email) !== before.normalized_email;
      // A new address has not been verified.
      const contact = emailChanged && event.verification_policy === 'CONTACT_VERIFIED' ? 'PENDING' : before.contact_verification;
      const { rows } = await tx.query<ParticipantRow>(
        `UPDATE event_participants SET name=$2, normalized_name=$3, country=$4, email=$5, normalized_email=$6, phone=$7,
           normalized_phone=$8, status=$9, needs_review=$10, review_note=$11, contact_verification=$12, updated_at=$13
         WHERE id = $1 RETURNING *`,
        [
          pid, next.name, normalizeName(next.name), next.country, next.email || null, normalizeEmail(next.email), next.phone || null,
          normalizePhone(next.phone), next.status, next.needs_review, next.review_note, contact, now,
        ],
      );
      await writeAudit(tx, { actorId: req.user!.id, action: 'event_participant.update', entityType: 'event_participant', entityId: pid, before, after: rows[0], reason: why }, now);
      return rows[0];
    });
    res.json({ participant: staffView(participant, showContact(req.user!.role)) });
  });

  // ---- Import ------------------------------------------------------------

  r.post('/events/:eventId/participants/import/preview', managers, async (req, res) => {
    const eventId = uuidParam(req.params.eventId, 'Event');
    await getEvent(ctx.db, eventId);
    const body = importBody.parse(req.body);
    const text = decodeUpload(body.file_base64, ctx.config.importMaxBytes);
    const analysis = await analyzeImport(ctx.db, eventId, text, body.mapping, body.existing_policy);
    res.json({
      ...analysis,
      // Return problem rows in full and a sample of the rest; the full file stays client-side.
      rows: analysis.rows.filter((r, i) => i < 50 || r.action === 'ERROR' || r.flags.length > 0).slice(0, 1000),
    });
  });

  r.post('/events/:eventId/participants/import/commit', managers, async (req, res) => {
    const eventId = uuidParam(req.params.eventId, 'Event');
    const body = importBody.parse(req.body);
    const text = decodeUpload(body.file_base64, ctx.config.importMaxBytes);
    const result = await commitImport(ctx, req.user!.id, eventId, { text, filename: body.filename, mapping: body.mapping, existingPolicy: body.existing_policy });
    res.status(201).json(result);
  });

  r.get('/events/:eventId/imports', managers, async (req, res) => {
    const eventId = uuidParam(req.params.eventId, 'Event');
    const { rows } = await ctx.db.query(
      `SELECT i.*, v.name AS uploaded_by_name FROM event_imports i LEFT JOIN volunteers v ON v.id = i.uploaded_by
       WHERE i.event_id = $1 ORDER BY i.created_at DESC`,
      [eventId],
    );
    res.json({ imports: rows });
  });

  // ---- Passes & email --------------------------------------------------------

  r.post('/events/:eventId/participants/:participantId/credentials', desk, async (req, res) => {
    const eventId = uuidParam(req.params.eventId, 'Event');
    const pid = uuidParam(req.params.participantId, 'Participant');
    const body = z.object({ send_email: z.boolean().default(false), reason: reason.optional() }).parse(req.body ?? {});
    const now = ctx.clock.now();
    const credential = await ctx.db.transaction(async (tx) => {
      const p = await getParticipant(tx, eventId, pid, 'FOR UPDATE');
      if (p.status !== 'ACTIVE') throw conflict('PARTICIPANT_INACTIVE', 'Passes can only be issued to active registrations.');
      const { rows } = await tx.query(`SELECT 1 FROM event_credentials WHERE participant_id = $1 AND status = 'ACTIVE'`, [pid]);
      if (rows[0]) throw conflict('CREDENTIAL_EXISTS', 'This participant already has an active pass. Use “replace” instead.');
      const issued = await issueCredential(tx, ctx.config, p, req.user!.id, now, body.reason);
      if (body.send_email && p.email) await queueDelivery(tx, p, issued.credential.id, req.user!.id, now);
      return issued.credential;
    });
    kickDeliveries(ctx);
    res.status(201).json({ credential: publicCredential(credential) });
  });

  /** Issue missing passes and/or queue pass emails in bulk. */
  r.post('/events/:eventId/passes/send', managers, async (req, res) => {
    const eventId = uuidParam(req.params.eventId, 'Event');
    const body = z
      .object({
        scope: z.enum(['UNSENT', 'FAILED']).default('UNSENT'),
        issue_missing: z.boolean().default(true),
        participant_ids: z.array(uuid).max(10000).optional(),
      })
      .parse(req.body ?? {});
    const now = ctx.clock.now();
    const result = await ctx.db.transaction(async (tx) => {
      const event = await getEvent(tx, eventId, 'FOR UPDATE');
      if (event.status === 'ARCHIVED' || event.status === 'CLOSED') throw conflict('EVENT_CLOSED', 'Passes cannot be sent for a closed event.');
      const only = body.participant_ids ? 'AND p.id = ANY($2::uuid[])' : '';
      const params: unknown[] = body.participant_ids ? [eventId, body.participant_ids] : [eventId];
      let issued = 0;
      if (body.issue_missing) {
        const { rows: missing } = await tx.query<ParticipantRow>(
          `SELECT p.* FROM event_participants p
           WHERE p.event_id = $1 AND p.status = 'ACTIVE' ${only}
             AND NOT EXISTS (SELECT 1 FROM event_credentials c WHERE c.participant_id = p.id AND c.status = 'ACTIVE')
             AND (p.contact_verification IN ('NOT_REQUIRED', 'VERIFIED', 'OVERRIDDEN'))`,
          params,
        );
        for (const p of missing) {
          await issueCredential(tx, ctx.config, p, req.user!.id, now);
          issued++;
        }
      }
      const statusFilter =
        body.scope === 'FAILED'
          ? `EXISTS (SELECT 1 FROM event_pass_deliveries d WHERE d.credential_id = c.id AND d.delivery_status = 'FAILED')
             AND NOT EXISTS (SELECT 1 FROM event_pass_deliveries d WHERE d.credential_id = c.id AND d.delivery_status IN ('QUEUED','SENDING','SENT'))`
          : `NOT EXISTS (SELECT 1 FROM event_pass_deliveries d WHERE d.credential_id = c.id AND d.delivery_status IN ('QUEUED','SENDING','SENT'))`;
      const { rows: toSend } = await tx.query<{ participant_id: string; credential_id: string }>(
        `SELECT p.id AS participant_id, c.id AS credential_id FROM event_participants p
         JOIN event_credentials c ON c.participant_id = p.id AND c.status = 'ACTIVE'
         WHERE p.event_id = $1 AND p.status = 'ACTIVE' AND p.email IS NOT NULL ${only} AND ${statusFilter}`,
        params,
      );
      for (const row of toSend) await queueDelivery(tx, { id: row.participant_id, event_id: eventId }, row.credential_id, req.user!.id, now);
      await writeAudit(tx, { actorId: req.user!.id, action: 'event.passes_send', entityType: 'event', entityId: eventId, after: { issued, queued: toSend.length, scope: body.scope } }, now);
      return { issued, queued: toSend.length };
    });
    kickDeliveries(ctx);
    res.json(result);
  });

  r.get('/events/:eventId/deliveries', desk, async (req, res) => {
    const eventId = uuidParam(req.params.eventId, 'Event');
    const status = queryString(req.query.status);
    const params: unknown[] = [eventId];
    if (status) params.push(status);
    const { rows } = await ctx.db.query(
      `SELECT d.*, p.name AS participant_name, p.registration_reference FROM event_pass_deliveries d
       JOIN event_participants p ON p.id = d.participant_id
       WHERE d.event_id = $1 ${status ? 'AND d.delivery_status = $2' : ''}
       ORDER BY d.updated_at DESC LIMIT 500`,
      params,
    );
    const { rows: counts } = await ctx.db.query(
      `SELECT delivery_status, count(*)::int AS n FROM event_pass_deliveries WHERE event_id = $1 GROUP BY delivery_status`,
      [eventId],
    );
    res.json({ deliveries: rows, counts: Object.fromEntries(counts.map((c) => [c.delivery_status as string, c.n])) });
  });

  // ---- Gates -----------------------------------------------------------------

  r.post('/events/:eventId/gates', managers, async (req, res) => {
    const eventId = uuidParam(req.params.eventId, 'Event');
    const body = gateBody.parse(req.body);
    await getEvent(ctx.db, eventId);
    const now = ctx.clock.now();
    const gate = await ctx.db.transaction(async (tx) => {
      const { rows } = await tx.query<GateRow>(
        `INSERT INTO event_gates (event_id, name, mode, location_description, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`,
        [eventId, body.name, body.mode, body.location_description, now],
      );
      await writeAudit(tx, { actorId: req.user!.id, action: 'event_gate.create', entityType: 'event_gate', entityId: rows[0].id, after: rows[0] }, now);
      return rows[0];
    });
    res.status(201).json({ gate });
  });

  r.get('/events/:eventId/gates', desk, async (req, res) => {
    const eventId = uuidParam(req.params.eventId, 'Event');
    const { rows } = await ctx.db.query(
      `SELECT g.*,
         COALESCE((SELECT json_agg(json_build_object('id', v.id, 'name', v.name, 'email', v.email))
                   FROM event_gate_operators o JOIN volunteers v ON v.id = o.operator_id WHERE o.gate_id = g.id), '[]') AS operators
       FROM event_gates g WHERE g.event_id = $1 ORDER BY g.name`,
      [eventId],
    );
    res.json({ gates: rows });
  });

  r.patch('/event-gates/:gateId', managers, async (req, res) => {
    const id = uuidParam(req.params.gateId, 'Gate');
    const changes = gateUpdateBody.parse(req.body);
    const now = ctx.clock.now();
    const gate = await ctx.db.transaction(async (tx) => {
      const before = await loadGate(tx, id);
      const next = { ...before, ...changes };
      const { rows } = await tx.query<GateRow>(
        `UPDATE event_gates SET name=$2, mode=$3, location_description=$4, status=$5, updated_at=$6 WHERE id=$1 RETURNING *`,
        [id, next.name, next.mode, next.location_description, next.status, now],
      );
      await writeAudit(tx, { actorId: req.user!.id, action: 'event_gate.update', entityType: 'event_gate', entityId: id, before, after: rows[0] }, now);
      return rows[0];
    });
    res.json({ gate });
  });

  r.post('/event-gates/:gateId/operators', managers, async (req, res) => {
    const id = uuidParam(req.params.gateId, 'Gate');
    const body = z.object({ email: z.string().trim().toLowerCase(), remove: z.boolean().default(false) }).parse(req.body);
    await loadGate(ctx.db, id);
    const { rows } = await ctx.db.query<{ id: string; role: string }>('SELECT id, role FROM volunteers WHERE lower(email) = $1', [body.email]);
    const op = rows[0];
    if (!op) throw notFound('ACCOUNT_NOT_FOUND', 'No account with that email.');
    const now = ctx.clock.now();
    if (body.remove) {
      await ctx.db.query('DELETE FROM event_gate_operators WHERE gate_id = $1 AND operator_id = $2', [id, op.id]);
    } else {
      if (op.role !== 'GATE_OPERATOR') throw conflict('NOT_GATE_OPERATOR', 'Only gate-operator accounts are assigned to gates (desk staff and managers can use any gate).');
      await ctx.db.query('INSERT INTO event_gate_operators (gate_id, operator_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, op.id, now]);
    }
    await writeAudit(ctx.db, { actorId: req.user!.id, action: body.remove ? 'event_gate.unassign' : 'event_gate.assign', entityType: 'event_gate', entityId: id, after: { operator_id: op.id } }, now);
    res.json({ ok: true });
  });

  return r;
}

export const publicCredential = (c: CredentialRow) => ({
  id: c.id,
  event_id: c.event_id,
  participant_id: c.participant_id,
  status: c.status,
  issued_at: c.issued_at,
  revoked_at: c.revoked_at,
  revoke_reason: c.revoke_reason,
  replaced_by_credential_id: c.replaced_by_credential_id,
});
