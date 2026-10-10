import { writeAudit } from '../audit.js';
import type { AuthUser } from '../auth.js';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { checkinAvailability, getSessionOrThrow, type SessionRow } from './sessions.js';
import { resolveVenue, type LocationRow } from './venues.js';

export interface AttendanceRow {
  id: string;
  session_id: string;
  volunteer_id: string;
  tapped_in_at: Date;
  source: 'QR' | 'ADMIN';
  status: 'ACTIVE' | 'VOIDED';
  qr_code_id: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CheckInResult {
  created: boolean;
  attendance: AttendanceRow;
  session: SessionRow;
  location: LocationRow;
}

async function findAttendance(q: Queryable, sessionId: string, volunteerId: string) {
  const { rows } = await q.query<AttendanceRow>(
    'SELECT * FROM attendance_records WHERE session_id = $1 AND volunteer_id = $2',
    [sessionId, volunteerId],
  );
  return rows[0];
}

/**
 * Record a volunteer's QR check-in. Every input is revalidated on the server and
 * the timestamp is generated here. Idempotent: a retry for the same session
 * returns the original record instead of creating a duplicate.
 */
export async function checkIn(
  ctx: AppContext,
  volunteer: AuthUser,
  input: { venueId: string; sessionId: string },
): Promise<CheckInResult> {
  if (volunteer.status !== 'ACTIVE') {
    throw new AppError(403, 'VOLUNTEER_INACTIVE', 'Your volunteer account is inactive. Please contact an organiser.');
  }
  return ctx.db.transaction(async (tx) => {
    const now = ctx.clock.now();
    const { qr, location } = await resolveVenue(tx, input.venueId);

    // FOR SHARE: a concurrent admin close/cancel waits for this check-in (or vice versa).
    const { rows } = await tx.query<SessionRow>('SELECT * FROM sessions WHERE id = $1 FOR SHARE', [input.sessionId]);
    const session = rows[0];
    if (!session || session.location_id !== location.id || session.status === 'DRAFT') {
      throw new AppError(422, 'INVALID_SESSION', 'The selected activity is not available at this venue. Please choose again.');
    }

    // Retries (e.g. after a response timeout) return the original record, even if
    // the window has since closed.
    const existing = await findAttendance(tx, session.id, volunteer.id);
    if (existing) {
      if (existing.status === 'VOIDED') {
        throw conflict('ATTENDANCE_VOIDED', 'Your attendance for this activity was removed by an organiser. Please speak to an organiser.');
      }
      return { created: false, attendance: existing, session, location };
    }

    switch (checkinAvailability(session, now)) {
      case 'NOT_YET_OPEN':
        throw conflict('SESSION_NOT_OPEN', 'Check-in for this activity has not opened yet.', {
          checkin_opens_at: session.checkin_opens_at,
        });
      case 'CLOSED':
        throw conflict('SESSION_CLOSED', 'Check-in for this activity has closed. Please speak to an organiser.');
      case 'CANCELLED':
        throw conflict('SESSION_CANCELLED', 'This activity has been cancelled.');
      case 'DRAFT':
        throw new AppError(422, 'INVALID_SESSION', 'The selected activity is not available at this venue.');
      case 'AVAILABLE':
        break;
    }

    const inserted = await tx.query<AttendanceRow>(
      `INSERT INTO attendance_records
         (session_id, volunteer_id, tapped_in_at, source, qr_code_id, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, 'QR', $4, $2, $3, $3)
       ON CONFLICT ON CONSTRAINT attendance_records_session_volunteer_uq DO NOTHING
       RETURNING *`,
      [session.id, volunteer.id, now, qr.id],
    );
    if (inserted.rows[0]) return { created: true, attendance: inserted.rows[0], session, location };

    // Lost a race with a concurrent request for the same volunteer/session.
    const winner = await findAttendance(tx, session.id, volunteer.id);
    return { created: false, attendance: winner, session, location };
  });
}

function validateAdminTimestamp(session: SessionRow, tappedInAt: Date, now: Date) {
  if (tappedInAt > now) throw badRequest('INVALID_TAP_IN_TIME', 'Tap-in time cannot be in the future.');
  if (tappedInAt < session.checkin_opens_at) {
    throw badRequest('INVALID_TAP_IN_TIME', 'Tap-in time cannot be before the session’s check-in opened.');
  }
}

const NON_ATTENDABLE = ['DRAFT', 'CANCELLED', 'ARCHIVED'];

/** Admin-assisted attendance (e.g. volunteer had no phone, or arrived after closure). */
export async function adminAddAttendance(
  ctx: AppContext,
  actorId: string,
  sessionId: string,
  input: { volunteerId: string; tappedInAt?: Date; reason: string },
): Promise<AttendanceRow> {
  return ctx.db.transaction(async (tx) => {
    const now = ctx.clock.now();
    const session = await getSessionOrThrow(tx, sessionId, 'FOR SHARE');
    if (NON_ATTENDABLE.includes(session.status)) {
      throw conflict('SESSION_NOT_ATTENDABLE', `Attendance cannot be added to a ${session.status.toLowerCase()} session.`);
    }
    const { rows: vols } = await tx.query<{ id: string; status: string }>('SELECT id, status FROM volunteers WHERE id = $1', [
      input.volunteerId,
    ]);
    if (!vols[0]) throw notFound('VOLUNTEER_NOT_FOUND', 'Volunteer not found.');
    if (vols[0].status !== 'ACTIVE') throw conflict('VOLUNTEER_INACTIVE', 'This volunteer account is inactive.');

    const tappedInAt = input.tappedInAt ?? now;
    validateAdminTimestamp(session, tappedInAt, now);

    const { rows } = await tx.query<AttendanceRow>(
      `INSERT INTO attendance_records
         (session_id, volunteer_id, tapped_in_at, source, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, 'ADMIN', $4, $5, $5)
       ON CONFLICT ON CONSTRAINT attendance_records_session_volunteer_uq DO NOTHING
       RETURNING *`,
      [sessionId, input.volunteerId, tappedInAt, actorId, now],
    );
    if (!rows[0]) {
      const existing = await findAttendance(tx, sessionId, input.volunteerId);
      throw conflict(
        'DUPLICATE_ATTENDANCE',
        existing?.status === 'VOIDED'
          ? 'This volunteer has a voided record for this session. Restore it instead of adding a new one.'
          : 'This volunteer is already checked in to this session.',
        { attendance: existing },
      );
    }
    await writeAudit(
      tx,
      { actorId, action: 'attendance.add', entityType: 'attendance_record', entityId: rows[0].id, after: rows[0], reason: input.reason },
      now,
    );
    return rows[0];
  });
}

/** Correct a record's tap-in time and/or void/restore it. The original is preserved in the audit log. */
export async function adminCorrectAttendance(
  ctx: AppContext,
  actorId: string,
  attendanceId: string,
  input: { tappedInAt?: Date; status?: 'ACTIVE' | 'VOIDED'; reason: string },
): Promise<AttendanceRow> {
  return ctx.db.transaction(async (tx) => {
    const now = ctx.clock.now();
    const { rows } = await tx.query<AttendanceRow>('SELECT * FROM attendance_records WHERE id = $1 FOR UPDATE', [attendanceId]);
    const before = rows[0];
    if (!before) throw notFound('ATTENDANCE_NOT_FOUND', 'Attendance record not found.');
    const session = await getSessionOrThrow(tx, before.session_id);
    if (session.status === 'ARCHIVED') {
      throw conflict('SESSION_ARCHIVED', 'Attendance for archived sessions cannot be changed.');
    }
    if (input.tappedInAt) validateAdminTimestamp(session, input.tappedInAt, now);

    const tappedInAt = input.tappedInAt ?? before.tapped_in_at;
    const status = input.status ?? before.status;
    if (tappedInAt.getTime() === before.tapped_in_at.getTime() && status === before.status) {
      throw badRequest('NO_CHANGES', 'No changes were made to this record.');
    }
    const { rows: updated } = await tx.query<AttendanceRow>(
      `UPDATE attendance_records SET tapped_in_at = $2, status = $3, updated_at = $4 WHERE id = $1 RETURNING *`,
      [attendanceId, tappedInAt, status, now],
    );
    const after = updated[0];
    await writeAudit(
      tx,
      {
        actorId,
        action: status !== before.status ? (status === 'VOIDED' ? 'attendance.void' : 'attendance.restore') : 'attendance.correct',
        entityType: 'attendance_record',
        entityId: attendanceId,
        before: { tapped_in_at: before.tapped_in_at, status: before.status },
        after: { tapped_in_at: after.tapped_in_at, status: after.status },
        reason: input.reason,
      },
      now,
    );
    return after;
  });
}
