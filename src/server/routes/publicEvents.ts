import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AppError, notFound } from '../errors.js';
import { registrationCount, type EventRow, type ParticipantRow } from '../services/events/common.js';
import { buildPass, extractToken, hashToken, type CredentialRow } from '../services/events/credentials.js';
import { registerOnline } from '../services/events/registration.js';
import { confirmContactVerification, startContactVerification } from '../services/events/verification.js';
import { uuidParam } from '../validation.js';

const registrationBody = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(200),
  email: z.string().trim().max(320).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  country: z.string().trim().max(100).nullable().optional(),
});

async function publicEvent(ctx: AppContext, id: string) {
  const { rows } = await ctx.db.query<EventRow>(`SELECT * FROM events WHERE id = $1 AND status <> 'DRAFT'`, [id]);
  if (!rows[0]) throw notFound('EVENT_NOT_FOUND', 'Event not found.');
  return rows[0];
}

async function registrationStatus(ctx: AppContext, e: EventRow) {
  const full = e.capacity !== null && e.pause_registration_at_capacity && (await registrationCount(ctx.db, e.id)) >= e.capacity;
  return {
    open: e.status === 'ACTIVE' && e.advance_registration_enabled && !full,
    capacity_reached: full,
    reason: e.status !== 'ACTIVE' ? 'EVENT_NOT_ACTIVE' : !e.advance_registration_enabled ? 'REGISTRATION_DISABLED' : full ? 'CAPACITY_REACHED' : null,
  };
}

/** Unauthenticated endpoints. Strictly rate limited; return only what the public needs. */
export function publicEventRoutes(ctx: AppContext, publicLimiter: RequestHandler) {
  const r = Router();
  r.use('/public', publicLimiter);

  r.get('/public/events/:eventId', async (req, res) => {
    const e = await publicEvent(ctx, uuidParam(req.params.eventId, 'Event'));
    res.json({
      event: {
        id: e.id, name: e.name, description: e.description, venue: e.venue_text, timezone: e.timezone,
        starts_at: e.starts_at, ends_at: e.ends_at, contact_requirement: e.contact_requirement,
        verification_policy: e.verification_policy, id_check_mode: e.id_check_mode,
      },
      registration: await registrationStatus(ctx, e),
    });
  });

  r.get('/public/events/:eventId/registration-status', async (req, res) => {
    const e = await publicEvent(ctx, uuidParam(req.params.eventId, 'Event'));
    res.json(await registrationStatus(ctx, e));
  });

  r.post('/public/events/:eventId/registrations', async (req, res) => {
    const eventId = uuidParam(req.params.eventId, 'Event');
    const body = registrationBody.parse(req.body);
    const result = await registerOnline(ctx, eventId, body);
    if (result.existing) return void res.status(200).json(result);
    let verification: { sent_to?: string; error?: string } | null = null;
    if (result.contact_verification_required) {
      try {
        verification = await startContactVerification(ctx, result.registration!.id);
      } catch {
        verification = { error: 'We could not send your verification code. Use “Resend code” to try again.' };
      }
    }
    res.status(201).json({ ...result, verification });
  });

  r.post('/public/event-registrations/:id/verify-contact', async (req, res) => {
    const id = uuidParam(req.params.id, 'Registration');
    const body = z.object({ action: z.enum(['start', 'confirm']), code: z.string().max(10).optional() }).parse(req.body);
    if (body.action === 'start') return void res.json(await startContactVerification(ctx, id));
    const result = await confirmContactVerification(ctx, id, body.code ?? '');
    res.json({ ...result, message: 'Email address confirmed. This confirms access to the email address only — your pass has been emailed to you.' });
  });

  /** Printable pass for the holder of the token (the token is the bearer credential printed on the pass). */
  r.get('/public/passes/:token', async (req, res) => {
    const token = extractToken(String(req.params.token));
    const missing = notFound('PASS_NOT_FOUND', 'This pass is not valid. It may have been replaced — check your latest email or visit the exception desk.');
    if (!token) throw missing;
    const { rows } = await ctx.db.query<{ c: CredentialRow; p: ParticipantRow; e: EventRow }>(
      `SELECT row_to_json(c.*) AS c, row_to_json(p.*) AS p, row_to_json(e.*) AS e
       FROM event_credentials c JOIN event_participants p ON p.id = c.participant_id JOIN events e ON e.id = c.event_id
       WHERE c.token_hash = $1`,
      [hashToken(token)],
    );
    const row = rows[0];
    if (!row) throw missing;
    if (row.c.status !== 'ACTIVE' || row.p.status !== 'ACTIVE') {
      throw new AppError(404, 'PASS_NOT_FOUND', missing.message, { event_id: row.e.id });
    }
    const event = { ...row.e, starts_at: new Date(row.e.starts_at), ends_at: new Date(row.e.ends_at) };
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').json({ pass: await buildPass(ctx.config, event, row.p, token) });
  });

  return r;
}
