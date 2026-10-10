import { Router } from 'express';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { adminAddAttendance } from '../services/attendance.js';
import {
  checkinAvailability,
  getSessionOrThrow,
  transitionSession,
  type SessionAction,
  type SessionRow,
  type SessionStatus,
} from '../services/sessions.js';
import { checkInUrl, type LocationRow, type QrCodeRow } from '../services/venues.js';
import { addMinutes, parseDateTimeInZone, startOfDay } from '../time.js';
import { queryString, reason, uuid, uuidParam } from '../validation.js';

const STATUSES: SessionStatus[] = ['DRAFT', 'SCHEDULED', 'OPEN', 'CLOSED', 'CANCELLED', 'ARCHIVED'];
const dateTime = z.string().min(1).max(40);

const createBody = z.object({
  location_id: uuid,
  title: z.string().trim().min(1, 'Activity title is required.').max(200),
  description: z.string().trim().max(2000).default(''),
  start_at: dateTime,
  end_at: dateTime,
  checkin_opens_at: dateTime.optional(),
  checkin_closes_at: dateTime.optional(),
  publish: z.boolean().default(false),
});

const updateBody = z
  .object({
    location_id: uuid,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000),
    start_at: dateTime,
    end_at: dateTime,
    checkin_opens_at: dateTime,
    checkin_closes_at: dateTime,
    reason: reason,
  })
  .partial();

const actionBody = z.object({
  reason: reason.optional(),
  checkin_closes_at: dateTime.optional(),
});

const addAttendanceBody = z.object({
  volunteer_id: uuid,
  tapped_in_at: dateTime.optional(),
  reason,
});

async function getLocation(q: Queryable, id: string) {
  const { rows } = await q.query<LocationRow>('SELECT * FROM locations WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('LOCATION_NOT_FOUND', 'Venue not found.');
  return rows[0];
}

function assertTimes(t: { start_at: Date; end_at: Date; checkin_opens_at: Date; checkin_closes_at: Date }) {
  if (t.end_at <= t.start_at) throw badRequest('INVALID_TIMES', 'The end time must be after the start time.');
  if (t.checkin_closes_at <= t.checkin_opens_at) {
    throw badRequest('INVALID_TIMES', 'Check-in must close after it opens.');
  }
}

export function adminSessionRoutes(ctx: AppContext) {
  const r = Router();

  r.post('/sessions', async (req, res) => {
    const body = createBody.parse(req.body);
    const location = await getLocation(ctx.db, body.location_id);
    if (location.status !== 'ACTIVE') throw conflict('VENUE_INACTIVE', 'Sessions cannot be created at an inactive venue.');
    const tz = location.timezone;
    const start = parseDateTimeInZone(body.start_at, tz, 'start_at');
    const times = {
      start_at: start,
      end_at: parseDateTimeInZone(body.end_at, tz, 'end_at'),
      checkin_opens_at: body.checkin_opens_at
        ? parseDateTimeInZone(body.checkin_opens_at, tz, 'checkin_opens_at')
        : addMinutes(start, -ctx.config.checkinOpensBeforeMinutes),
      checkin_closes_at: body.checkin_closes_at
        ? parseDateTimeInZone(body.checkin_closes_at, tz, 'checkin_closes_at')
        : addMinutes(start, ctx.config.checkinClosesAfterMinutes),
    };
    assertTimes(times);
    const now = ctx.clock.now();
    const session = await ctx.db.transaction(async (tx) => {
      const { rows } = await tx.query<SessionRow>(
        `INSERT INTO sessions (location_id, title, description, start_at, end_at, checkin_opens_at, checkin_closes_at,
                               status, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'DRAFT', $8, $9, $9) RETURNING *`,
        [location.id, body.title, body.description, times.start_at, times.end_at, times.checkin_opens_at, times.checkin_closes_at, req.user!.id, now],
      );
      await writeAudit(tx, { actorId: req.user!.id, action: 'session.create', entityType: 'session', entityId: rows[0].id, after: rows[0] }, now);
      return rows[0];
    });
    const result = body.publish ? await transitionSession(ctx, req.user!.id, session.id, 'publish') : session;
    res.status(201).json({ session: result });
  });

  r.get('/sessions', async (req, res) => {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    const tz = ctx.config.defaultTimezone;
    const from = queryString(req.query.from);
    const to = queryString(req.query.to);
    const locationId = queryString(req.query.location_id);
    const q = queryString(req.query.q);
    const status = queryString(req.query.status);
    if (from) add('s.start_at >= ?', startOfDay(from, tz, 'from'));
    if (to) add('s.start_at < ?', addMinutes(startOfDay(to, tz, 'to'), 24 * 60));
    if (locationId) add('s.location_id = ?', uuidParam(locationId, 'Venue'));
    if (q) add(`s.title ILIKE ?`, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    if (status) {
      if (!STATUSES.includes(status as SessionStatus)) throw badRequest('INVALID_STATUS', 'Unknown session status.');
      add('s.status = ?', status);
    } else if (req.query.include_archived !== '1') {
      where.push(`s.status <> 'ARCHIVED'`);
    }
    const { rows } = await ctx.db.query(
      `SELECT s.*, l.name AS location_name, l.timezone,
              (SELECT count(*)::int FROM attendance_records a WHERE a.session_id = s.id AND a.status = 'ACTIVE') AS attendance_count
       FROM sessions s JOIN locations l ON l.id = s.location_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY s.start_at DESC, s.title
       LIMIT 500`,
      params,
    );
    res.json({ sessions: rows });
  });

  r.get('/sessions/:id', async (req, res) => {
    const id = uuidParam(req.params.id, 'Session');
    const session = await getSessionOrThrow(ctx.db, id);
    const location = await getLocation(ctx.db, session.location_id);
    const { rows: qr } = await ctx.db.query<QrCodeRow>(
      `SELECT * FROM venue_qr_codes WHERE location_id = $1 AND status = 'ACTIVE'`,
      [location.id],
    );
    const { rows: counts } = await ctx.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM attendance_records WHERE session_id = $1 AND status = 'ACTIVE'`,
      [id],
    );
    const { rows: history } = await ctx.db.query(
      `SELECT a.*, v.name AS actor_name FROM audit_logs a LEFT JOIN volunteers v ON v.id = a.actor_id
       WHERE a.entity_type = 'session' AND a.entity_id = $1 ORDER BY a.created_at DESC LIMIT 50`,
      [id],
    );
    res.json({
      session,
      location,
      active_qr: qr[0] ? { ...qr[0], url: checkInUrl(ctx.config, qr[0].public_identifier) } : null,
      attendance_count: counts[0].n,
      checkin_availability: checkinAvailability(session, ctx.clock.now()),
      history,
    });
  });

  r.patch('/sessions/:id', async (req, res) => {
    const id = uuidParam(req.params.id, 'Session');
    const body = updateBody.parse(req.body);
    const { reason: why, ...changes } = body;
    if (Object.keys(changes).length === 0) throw badRequest('NO_CHANGES', 'Nothing to update.');
    const now = ctx.clock.now();
    const session = await ctx.db.transaction(async (tx) => {
      const before = await getSessionOrThrow(tx, id, 'FOR UPDATE');
      if (before.status === 'CANCELLED' || before.status === 'ARCHIVED') {
        throw conflict('SESSION_LOCKED', `A ${before.status.toLowerCase()} session cannot be edited.`);
      }
      const locationId = changes.location_id ?? before.location_id;
      const location = await getLocation(tx, locationId);
      if (locationId !== before.location_id) {
        const { rows } = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM attendance_records WHERE session_id = $1', [id]);
        if (rows[0].n > 0) throw conflict('SESSION_HAS_ATTENDANCE', 'The venue cannot be changed after volunteers have checked in.');
        if (location.status !== 'ACTIVE') throw conflict('VENUE_INACTIVE', 'Sessions cannot be moved to an inactive venue.');
      }
      const tz = location.timezone;
      const pick = (field: 'start_at' | 'end_at' | 'checkin_opens_at' | 'checkin_closes_at') =>
        changes[field] ? parseDateTimeInZone(changes[field]!, tz, field) : before[field];
      const next = {
        title: changes.title ?? before.title,
        description: changes.description ?? before.description,
        start_at: pick('start_at'),
        end_at: pick('end_at'),
        checkin_opens_at: pick('checkin_opens_at'),
        checkin_closes_at: pick('checkin_closes_at'),
      };
      assertTimes(next);
      const { rows } = await tx.query<SessionRow>(
        `UPDATE sessions SET location_id = $2, title = $3, description = $4, start_at = $5, end_at = $6,
                checkin_opens_at = $7, checkin_closes_at = $8, updated_at = $9
         WHERE id = $1 RETURNING *`,
        [id, locationId, next.title, next.description, next.start_at, next.end_at, next.checkin_opens_at, next.checkin_closes_at, now],
      );
      await writeAudit(
        tx,
        { actorId: req.user!.id, action: 'session.update', entityType: 'session', entityId: id, before, after: rows[0], reason: why },
        now,
      );
      return rows[0];
    });
    res.json({ session });
  });

  const actions: SessionAction[] = ['publish', 'open', 'close', 'reopen', 'cancel', 'archive'];
  for (const action of actions) {
    r.post(`/sessions/:id/${action}`, async (req, res) => {
      const id = uuidParam(req.params.id, 'Session');
      const body = actionBody.parse(req.body ?? {});
      let checkinClosesAt: Date | undefined;
      if (body.checkin_closes_at) {
        const s = await getSessionOrThrow(ctx.db, id);
        const loc = await getLocation(ctx.db, s.location_id);
        checkinClosesAt = parseDateTimeInZone(body.checkin_closes_at, loc.timezone, 'checkin_closes_at');
      }
      const session = await transitionSession(ctx, req.user!.id, id, action, { reason: body.reason, checkinClosesAt });
      res.json({ session });
    });
  }

  r.get('/sessions/:id/attendance', async (req, res) => {
    const id = uuidParam(req.params.id, 'Session');
    await getSessionOrThrow(ctx.db, id);
    const params: unknown[] = [id];
    let filter = '';
    const q = queryString(req.query.q);
    if (q) {
      params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      filter = `AND (v.name ILIKE $2 OR v.volunteer_code ILIKE $2 OR v.email ILIKE $2)`;
    }
    const { rows } = await ctx.db.query(
      `SELECT a.id, a.tapped_in_at, a.source, a.status, a.created_at, a.updated_at,
              v.id AS volunteer_id, v.name AS volunteer_name, v.volunteer_code, v.email AS volunteer_email,
              c.name AS created_by_name
       FROM attendance_records a
       JOIN volunteers v ON v.id = a.volunteer_id
       LEFT JOIN volunteers c ON c.id = a.created_by AND a.source = 'ADMIN'
       WHERE a.session_id = $1 ${filter}
       ORDER BY a.tapped_in_at`,
      params,
    );
    res.json({ attendance: rows });
  });

  r.post('/sessions/:id/attendance', async (req, res) => {
    const id = uuidParam(req.params.id, 'Session');
    const body = addAttendanceBody.parse(req.body);
    let tappedInAt: Date | undefined;
    if (body.tapped_in_at) {
      const s = await getSessionOrThrow(ctx.db, id);
      const loc = await getLocation(ctx.db, s.location_id);
      tappedInAt = parseDateTimeInZone(body.tapped_in_at, loc.timezone, 'tapped_in_at');
    }
    const attendance = await adminAddAttendance(ctx, req.user!.id, id, {
      volunteerId: body.volunteer_id,
      tappedInAt,
      reason: body.reason,
    });
    res.status(201).json({ attendance });
  });

  return r;
}
