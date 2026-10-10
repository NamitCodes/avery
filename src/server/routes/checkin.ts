import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import type { AppContext } from '../context.js';
import { checkIn } from '../services/attendance.js';
import { AVAILABLE_SQL, type SessionRow } from '../services/sessions.js';
import { resolveVenue } from '../services/venues.js';

// Unknown keys (e.g. a client-supplied timestamp or status) are stripped and ignored.
const checkInBody = z.object({
  venue_id: z.string().min(1).max(100),
  session_id: z.string().uuid('Please choose an activity.'),
});

const publicSession = (s: SessionRow) => ({
  id: s.id,
  title: s.title,
  description: s.description,
  start_at: s.start_at,
  end_at: s.end_at,
  checkin_closes_at: s.checkin_closes_at,
});

export function checkinRoutes(ctx: AppContext, checkinLimiter: RequestHandler) {
  const r = Router();

  /** Venue info + sessions currently accepting check-ins (the QR landing page). */
  r.get('/check-in/venues/:venueId', requireAuth, checkinLimiter, async (req, res) => {
    const { location } = await resolveVenue(ctx.db, String(req.params.venueId));
    const now = ctx.clock.now();
    const { rows: sessions } = await ctx.db.query<SessionRow>(
      `SELECT s.* FROM sessions s
       WHERE s.location_id = $1 AND ${AVAILABLE_SQL('s', '$2')}
       ORDER BY s.start_at, s.title`,
      [location.id, now],
    );
    const { rows: mine } = await ctx.db.query<{ session_id: string; tapped_in_at: Date }>(
      `SELECT session_id, tapped_in_at FROM attendance_records
       WHERE volunteer_id = $1 AND status = 'ACTIVE' AND session_id = ANY($2::uuid[])`,
      [req.user!.id, sessions.map((s) => s.id)],
    );
    const checkedIn = new Map(mine.map((m) => [m.session_id, m.tapped_in_at]));
    res.json({
      venue: { name: location.name, address: location.address, timezone: location.timezone },
      sessions: sessions.map((s) => ({ ...publicSession(s), already_checked_in_at: checkedIn.get(s.id) ?? null })),
      message: sessions.length === 0 ? 'There are no activities currently accepting attendance at this venue.' : undefined,
    });
  });

  r.post('/check-in', requireAuth, checkinLimiter, async (req, res) => {
    const body = checkInBody.parse(req.body);
    const result = await checkIn(ctx, req.user!, { venueId: body.venue_id, sessionId: body.session_id });
    res.status(result.created ? 201 : 200).json({
      status: result.created ? 'CHECKED_IN' : 'ALREADY_CHECKED_IN',
      attendance: {
        id: result.attendance.id,
        tapped_in_at: result.attendance.tapped_in_at,
        source: result.attendance.source,
      },
      session: publicSession(result.session),
      venue: { name: result.location.name, timezone: result.location.timezone },
    });
  });

  r.get('/volunteers/me/attendance', requireAuth, async (req, res) => {
    const { rows } = await ctx.db.query(
      `SELECT a.id, a.tapped_in_at, a.source, s.id AS session_id, s.title, s.start_at, s.end_at,
              l.name AS venue_name, l.timezone
       FROM attendance_records a
       JOIN sessions s ON s.id = a.session_id
       JOIN locations l ON l.id = s.location_id
       WHERE a.volunteer_id = $1 AND a.status = 'ACTIVE'
       ORDER BY a.tapped_in_at DESC`,
      [req.user!.id],
    );
    res.json({ attendance: rows });
  });

  return r;
}

