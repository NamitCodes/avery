import { writeAudit } from '../audit.js';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db.js';
import { AppError, conflict, notFound } from '../errors.js';
import { addMinutes } from '../time.js';

export type SessionStatus = 'DRAFT' | 'SCHEDULED' | 'OPEN' | 'CLOSED' | 'CANCELLED' | 'ARCHIVED';

export interface SessionRow {
  id: string;
  location_id: string;
  title: string;
  description: string;
  start_at: Date;
  end_at: Date;
  checkin_opens_at: Date;
  checkin_closes_at: Date;
  status: SessionStatus;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function getSession(q: Queryable, id: string, lock: '' | 'FOR UPDATE' | 'FOR SHARE' = '') {
  const { rows } = await q.query<SessionRow>(`SELECT * FROM sessions WHERE id = $1 ${lock}`, [id]);
  return rows[0];
}

export async function getSessionOrThrow(q: Queryable, id: string, lock: '' | 'FOR UPDATE' | 'FOR SHARE' = '') {
  const s = await getSession(q, id, lock);
  if (!s) throw notFound('SESSION_NOT_FOUND', 'Session not found.');
  return s;
}

export type CheckinAvailability = 'AVAILABLE' | 'DRAFT' | 'NOT_YET_OPEN' | 'CLOSED' | 'CANCELLED';

/**
 * Whether an ordinary (QR) check-in is accepted right now. The configured window
 * is authoritative; status SCHEDULED inside the window counts as open so a lagging
 * scheduler never blocks volunteers.
 */
export function checkinAvailability(s: SessionRow, now: Date): CheckinAvailability {
  switch (s.status) {
    case 'DRAFT':
      return 'DRAFT';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'CLOSED':
    case 'ARCHIVED':
      return 'CLOSED';
    case 'SCHEDULED':
    case 'OPEN':
      if (now < s.checkin_opens_at) return 'NOT_YET_OPEN';
      if (now >= s.checkin_closes_at) return 'CLOSED';
      return 'AVAILABLE';
  }
}

/** SQL predicate equivalent to checkinAvailability(...) === 'AVAILABLE'. `$n` is "now". */
export const AVAILABLE_SQL = (alias: string, nowParam: string) =>
  `${alias}.status IN ('SCHEDULED', 'OPEN') AND ${alias}.checkin_opens_at <= ${nowParam} AND ${alias}.checkin_closes_at > ${nowParam}`;

export type SessionAction = 'publish' | 'open' | 'close' | 'reopen' | 'cancel' | 'archive';

const ALLOWED_FROM: Record<SessionAction, SessionStatus[]> = {
  publish: ['DRAFT'],
  open: ['SCHEDULED'],
  close: ['SCHEDULED', 'OPEN'],
  reopen: ['CLOSED'],
  cancel: ['DRAFT', 'SCHEDULED', 'OPEN', 'CLOSED'],
  archive: ['CLOSED', 'CANCELLED'],
};

export interface TransitionOptions {
  reason?: string | null;
  /** New check-in close time for open/reopen when the window has already passed. */
  checkinClosesAt?: Date;
}

/** Apply an admin lifecycle action. Server time is used for every decision. */
export async function transitionSession(
  ctx: AppContext,
  actorId: string,
  sessionId: string,
  action: SessionAction,
  opts: TransitionOptions = {},
): Promise<SessionRow> {
  const now = ctx.clock.now();
  return ctx.db.transaction(async (tx) => {
    const before = await getSessionOrThrow(tx, sessionId, 'FOR UPDATE');
    if (!ALLOWED_FROM[action].includes(before.status)) {
      throw conflict(
        'INVALID_TRANSITION',
        `Cannot ${action} a session that is ${before.status.toLowerCase()}.`,
        { status: before.status },
      );
    }

    let status: SessionStatus;
    let opensAt = before.checkin_opens_at;
    let closesAt = before.checkin_closes_at;

    if (opts.checkinClosesAt && opts.checkinClosesAt <= now) {
      throw new AppError(400, 'INVALID_WINDOW', 'The new check-in closing time must be in the future.');
    }

    switch (action) {
      case 'publish':
        if (now >= closesAt) {
          throw conflict('WINDOW_PASSED', 'The check-in window for this session has already ended. Adjust the times first.');
        }
        status = now >= opensAt ? 'OPEN' : 'SCHEDULED';
        break;
      case 'open':
      case 'reopen':
        // Opening early pulls the window start forward; reopening after the window
        // ended extends it so check-ins are actually accepted.
        if (opensAt > now) opensAt = now;
        if (opts.checkinClosesAt) closesAt = opts.checkinClosesAt;
        else if (closesAt <= now) closesAt = addMinutes(now, ctx.config.reopenExtensionMinutes);
        status = 'OPEN';
        break;
      case 'close':
        status = 'CLOSED';
        break;
      case 'cancel':
        status = 'CANCELLED';
        break;
      case 'archive':
        status = 'ARCHIVED';
        break;
    }

    const { rows } = await tx.query<SessionRow>(
      `UPDATE sessions SET status = $2, checkin_opens_at = $3, checkin_closes_at = $4, updated_at = $5
       WHERE id = $1 RETURNING *`,
      [sessionId, status, opensAt, closesAt, now],
    );
    const after = rows[0];
    await writeAudit(
      tx,
      {
        actorId,
        action: `session.${action}`,
        entityType: 'session',
        entityId: sessionId,
        before: pickLifecycle(before),
        after: pickLifecycle(after),
        reason: opts.reason,
      },
      now,
    );
    return after;
  });
}

const pickLifecycle = (s: SessionRow) => ({
  status: s.status,
  checkin_opens_at: s.checkin_opens_at,
  checkin_closes_at: s.checkin_closes_at,
});

/**
 * Time-based transitions: SCHEDULED -> OPEN when the window opens, and
 * (optionally) SCHEDULED/OPEN -> CLOSED when it ends. Idempotent; safe to run
 * concurrently from several instances because each UPDATE re-checks state.
 */
export async function runSessionScheduler(ctx: AppContext): Promise<{ opened: number; closed: number }> {
  const now = ctx.clock.now();
  return ctx.db.transaction(async (tx) => {
    const closed = ctx.config.autoCloseSessions
      ? (
          await tx.query<SessionRow>(
            `UPDATE sessions SET status = 'CLOSED', updated_at = $1
             WHERE status IN ('SCHEDULED', 'OPEN') AND checkin_closes_at <= $1 RETURNING *`,
            [now],
          )
        ).rows
      : [];
    const opened = (
      await tx.query<SessionRow>(
        `UPDATE sessions SET status = 'OPEN', updated_at = $1
         WHERE status = 'SCHEDULED' AND checkin_opens_at <= $1 AND checkin_closes_at > $1 RETURNING *`,
        [now],
      )
    ).rows;
    for (const s of opened) {
      await writeAudit(
        tx,
        { actorId: null, action: 'session.auto_open', entityType: 'session', entityId: s.id, before: { status: 'SCHEDULED' }, after: { status: 'OPEN' } },
        now,
      );
    }
    for (const s of closed) {
      await writeAudit(
        tx,
        { actorId: null, action: 'session.auto_close', entityType: 'session', entityId: s.id, after: { status: 'CLOSED' } },
        now,
      );
    }
    return { opened: opened.length, closed: closed.length };
  });
}
