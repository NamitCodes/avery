import { Router } from 'express';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { USER_COLUMNS, type AuthUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { adminCorrectAttendance } from '../services/attendance.js';
import { getSessionOrThrow } from '../services/sessions.js';
import { parseDateTimeInZone } from '../time.js';
import { queryString, reason, uuidParam } from '../validation.js';

const correctBody = z.object({
  tapped_in_at: z.string().min(1).max(40).optional(),
  status: z.enum(['ACTIVE', 'VOIDED']).optional(),
  reason,
});

const volunteerUpdateBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    status: z.enum(['ACTIVE', 'INACTIVE']),
    role: z.enum(['VOLUNTEER', 'ADMIN', 'EVENT_ADMIN', 'EXCEPTION_DESK', 'GATE_OPERATOR']),
    reason: reason,
  })
  .partial();

const likeParam = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Attendance corrections, volunteer management, and the audit log. */
export function adminPeopleRoutes(ctx: AppContext) {
  const r = Router();

  r.patch('/attendance/:id', async (req, res) => {
    const id = uuidParam(req.params.id, 'Attendance record');
    const body = correctBody.parse(req.body);
    if (!body.tapped_in_at && !body.status) throw badRequest('NO_CHANGES', 'Nothing to update.');
    let tappedInAt: Date | undefined;
    if (body.tapped_in_at) {
      const { rows } = await ctx.db.query<{ session_id: string }>('SELECT session_id FROM attendance_records WHERE id = $1', [id]);
      if (!rows[0]) throw notFound('ATTENDANCE_NOT_FOUND', 'Attendance record not found.');
      const s = await getSessionOrThrow(ctx.db, rows[0].session_id);
      const { rows: loc } = await ctx.db.query<{ timezone: string }>('SELECT timezone FROM locations WHERE id = $1', [s.location_id]);
      tappedInAt = parseDateTimeInZone(body.tapped_in_at, loc[0].timezone, 'tapped_in_at');
    }
    const attendance = await adminCorrectAttendance(ctx, req.user!.id, id, {
      tappedInAt,
      status: body.status,
      reason: body.reason,
    });
    res.json({ attendance });
  });

  r.get('/attendance/:id/history', async (req, res) => {
    const id = uuidParam(req.params.id, 'Attendance record');
    const { rows } = await ctx.db.query(
      `SELECT a.*, v.name AS actor_name FROM audit_logs a LEFT JOIN volunteers v ON v.id = a.actor_id
       WHERE a.entity_type = 'attendance_record' AND a.entity_id = $1 ORDER BY a.created_at`,
      [id],
    );
    res.json({ history: rows });
  });

  r.get('/volunteers', async (req, res) => {
    const q = queryString(req.query.q);
    const params: unknown[] = [];
    let where = '';
    if (q) {
      params.push(likeParam(q));
      where = 'WHERE (v.name ILIKE $1 OR v.email ILIKE $1 OR v.volunteer_code ILIKE $1)';
    }
    const role = queryString(req.query.role);
    if (role) {
      params.push(role);
      where = `${where ? `${where} AND` : 'WHERE'} v.role = $${params.length}`;
    }
    const { rows } = await ctx.db.query(
      `SELECT v.id, v.volunteer_code, v.name, v.email, v.role, v.status, v.created_at,
              (SELECT count(*)::int FROM attendance_records a WHERE a.volunteer_id = v.id AND a.status = 'ACTIVE') AS sessions_attended,
              (SELECT max(a.tapped_in_at) FROM attendance_records a WHERE a.volunteer_id = v.id AND a.status = 'ACTIVE') AS last_tapped_in_at
       FROM volunteers v ${where}
       ORDER BY v.name LIMIT 500`,
      params,
    );
    res.json({ volunteers: rows });
  });

  r.get('/volunteers/:id', async (req, res) => {
    const id = uuidParam(req.params.id, 'Volunteer');
    const { rows } = await ctx.db.query(`SELECT ${USER_COLUMNS}, created_at FROM volunteers WHERE id = $1`, [id]);
    if (!rows[0]) throw notFound('VOLUNTEER_NOT_FOUND', 'Volunteer not found.');
    res.json({ volunteer: rows[0] });
  });

  r.patch('/volunteers/:id', async (req, res) => {
    const id = uuidParam(req.params.id, 'Volunteer');
    const { reason: why, ...changes } = volunteerUpdateBody.parse(req.body);
    if (Object.keys(changes).length === 0) throw badRequest('NO_CHANGES', 'Nothing to update.');
    if (id === req.user!.id && (changes.status === 'INACTIVE' || (changes.role && changes.role !== 'ADMIN'))) {
      throw conflict('SELF_LOCKOUT', 'You cannot deactivate or demote your own account.');
    }
    const now = ctx.clock.now();
    const volunteer = await ctx.db.transaction(async (tx) => {
      const { rows } = await tx.query<AuthUser>(`SELECT ${USER_COLUMNS} FROM volunteers WHERE id = $1 FOR UPDATE`, [id]);
      const before = rows[0];
      if (!before) throw notFound('VOLUNTEER_NOT_FOUND', 'Volunteer not found.');
      const next = { ...before, ...changes };
      const { rows: updated } = await tx.query<AuthUser>(
        `UPDATE volunteers SET name = $2, status = $3, role = $4, updated_at = $5 WHERE id = $1 RETURNING ${USER_COLUMNS}`,
        [id, next.name, next.status, next.role, now],
      );
      await writeAudit(
        tx,
        { actorId: req.user!.id, action: 'volunteer.update', entityType: 'volunteer', entityId: id, before, after: updated[0], reason: why },
        now,
      );
      return updated[0];
    });
    res.json({ volunteer });
  });

  r.get('/volunteers/:id/attendance', async (req, res) => {
    const id = uuidParam(req.params.id, 'Volunteer');
    const { rows: v } = await ctx.db.query(`SELECT ${USER_COLUMNS} FROM volunteers WHERE id = $1`, [id]);
    if (!v[0]) throw notFound('VOLUNTEER_NOT_FOUND', 'Volunteer not found.');
    const { rows } = await ctx.db.query(
      `SELECT a.id, a.tapped_in_at, a.source, a.status, s.id AS session_id, s.title, s.start_at, s.end_at, s.status AS session_status,
              l.name AS venue_name, l.timezone
       FROM attendance_records a
       JOIN sessions s ON s.id = a.session_id
       JOIN locations l ON l.id = s.location_id
       WHERE a.volunteer_id = $1
       ORDER BY a.tapped_in_at DESC`,
      [id],
    );
    res.json({ volunteer: v[0], attendance: rows });
  });

  r.get('/audit-logs', async (req, res) => {
    const where: string[] = [];
    const params: unknown[] = [];
    const entityType = queryString(req.query.entity_type);
    const entityId = queryString(req.query.entity_id);
    const action = queryString(req.query.action);
    if (entityType) {
      params.push(entityType);
      where.push(`a.entity_type = $${params.length}`);
    }
    if (entityId) {
      params.push(uuidParam(entityId));
      where.push(`a.entity_id = $${params.length}`);
    }
    if (action) {
      params.push(`${action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where.push(`a.action LIKE $${params.length}`);
    }
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '200'), 10) || 200, 1), 1000);
    const { rows } = await ctx.db.query(
      `SELECT a.*, v.name AS actor_name FROM audit_logs a LEFT JOIN volunteers v ON v.id = a.actor_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY a.created_at DESC LIMIT ${limit}`,
      params,
    );
    res.json({ audit_logs: rows });
  });

  return r;
}
