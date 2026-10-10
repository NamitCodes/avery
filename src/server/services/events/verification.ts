import crypto from 'node:crypto';
import { writeAudit } from '../../audit.js';
import type { AppContext } from '../../context.js';
import type { Queryable } from '../../db.js';
import { AppError, badRequest, conflict } from '../../errors.js';
import { addMinutes } from '../../time.js';
import { getEvent, type ParticipantRow } from './common.js';
import { issueCredential } from './credentials.js';
import { kickDeliveries, queueDelivery } from './deliveries.js';

const CODE_TTL_MINUTES = 15;
const MAX_ATTEMPTS = 5;

const hashCode = (participantId: string, code: string) =>
  crypto.createHash('sha256').update(`${participantId}:${code}`).digest('hex');

async function recordVerification(
  tx: Queryable,
  p: ParticipantRow,
  type: 'EMAIL' | 'PHONE' | 'IN_PERSON_ID',
  outcome: 'VERIFIED' | 'CHECKED' | 'FAILED' | 'OVERRIDDEN',
  actorId: string | null,
  reason: string | null,
  now: Date,
) {
  await tx.query(
    `INSERT INTO event_verifications (event_id, participant_id, verification_type, outcome, verified_by, verified_at, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [p.event_id, p.id, type, outcome, actorId, now, reason],
  );
}

/**
 * Send a single-use 6-digit code to the participant's email. This proves access
 * to the mailbox only — never legal identity.
 */
export async function startContactVerification(ctx: AppContext, participantId: string) {
  const now = ctx.clock.now();
  const { participant, event } = await ctx.db.transaction(async (tx) => {
    const { rows } = await tx.query<ParticipantRow>('SELECT * FROM event_participants WHERE id = $1 FOR UPDATE', [participantId]);
    const p = rows[0];
    if (!p) throw new AppError(404, 'REGISTRATION_NOT_FOUND', 'Registration not found.');
    if (!p.email) throw badRequest('NO_EMAIL', 'This registration has no email address to verify.');
    if (p.contact_verification === 'VERIFIED') throw conflict('ALREADY_VERIFIED', 'This email address is already verified.');
    const { rows: recent } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM event_contact_challenges WHERE participant_id = $1 AND created_at > $2`,
      [p.id, addMinutes(now, -60)],
    );
    if (recent[0].n >= 5) throw new AppError(429, 'TOO_MANY_CODES', 'Too many codes requested. Please try again later.');
    return { participant: p, event: await getEvent(tx, p.event_id) };
  });
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await ctx.db.query(
    `INSERT INTO event_contact_challenges (participant_id, channel, code_hash, expires_at, created_at) VALUES ($1, 'EMAIL', $2, $3, $4)`,
    [participant.id, hashCode(participant.id, code), addMinutes(now, CODE_TTL_MINUTES), now],
  );
  await ctx.mailer.send({
    to: participant.email!,
    subject: `Your verification code for ${event.name}`,
    text: `Your verification code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes.\n\nIf you did not register for ${event.name}, ignore this email.`,
    html: `<p>Your verification code is <strong style="font-size:20px">${code}</strong>.</p><p>It expires in ${CODE_TTL_MINUTES} minutes. If you did not register for this event, ignore this email.</p>`,
  });
  return { sent_to: participant.email!.replace(/^(.).*(@.*)$/, '$1•••$2'), expires_in_minutes: CODE_TTL_MINUTES };
}

/** After contact verification succeeds, issue a pass if the event withheld it until now. */
async function issuePassIfMissing(ctx: AppContext, tx: Queryable, p: ParticipantRow, now: Date) {
  const { rows } = await tx.query(`SELECT 1 FROM event_credentials WHERE participant_id = $1 AND status = 'ACTIVE'`, [p.id]);
  if (rows[0]) return null;
  const issued = await issueCredential(tx, ctx.config, p, null, now, 'Issued after contact verification');
  if (p.email) await queueDelivery(tx, p, issued.credential.id, null, now);
  return issued;
}

export async function confirmContactVerification(ctx: AppContext, participantId: string, code: string) {
  const result = await ctx.db.transaction(async (tx) => {
    const now = ctx.clock.now();
    const { rows } = await tx.query<ParticipantRow>('SELECT * FROM event_participants WHERE id = $1 FOR UPDATE', [participantId]);
    const p = rows[0];
    if (!p) throw new AppError(404, 'REGISTRATION_NOT_FOUND', 'Registration not found.');
    if (p.contact_verification === 'VERIFIED') return { verified: true, already: true };
    const { rows: ch } = await tx.query<{ id: string; code_hash: string; expires_at: Date; attempts: number }>(
      `SELECT * FROM event_contact_challenges WHERE participant_id = $1 AND consumed_at IS NULL
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [p.id],
    );
    const c = ch[0];
    if (!c || c.expires_at <= now || c.attempts >= MAX_ATTEMPTS) {
      throw badRequest('CODE_EXPIRED', 'This code has expired or been used too many times. Request a new code.');
    }
    const ok = crypto.timingSafeEqual(Buffer.from(c.code_hash), Buffer.from(hashCode(p.id, code.trim())));
    if (!ok) {
      await tx.query('UPDATE event_contact_challenges SET attempts = attempts + 1 WHERE id = $1', [c.id]);
      return { verified: false, attempts_left: MAX_ATTEMPTS - c.attempts - 1 };
    }
    await tx.query('UPDATE event_contact_challenges SET consumed_at = $2 WHERE id = $1', [c.id, now]);
    await tx.query(`UPDATE event_participants SET contact_verification = 'VERIFIED', updated_at = $2 WHERE id = $1`, [p.id, now]);
    await recordVerification(tx, p, 'EMAIL', 'VERIFIED', null, null, now);
    const event = await getEvent(tx, p.event_id);
    const issued = event.verification_policy === 'CONTACT_VERIFIED' ? await issuePassIfMissing(ctx, tx, p, now) : null;
    return { verified: true, pass_issued: Boolean(issued) };
  });
  if (!result.verified) {
    throw badRequest('CODE_INCORRECT', 'That code is not correct.', { attempts_left: result.attempts_left });
  }
  kickDeliveries(ctx);
  return result;
}

/**
 * Staff decisions: an in-person ID check result, or an authorised override of
 * a contact/ID requirement. Overrides require a reason; nothing is silently bypassed.
 */
export async function recordStaffVerification(
  ctx: AppContext,
  actorId: string,
  eventId: string,
  participantId: string,
  input: { kind: 'ID' | 'CONTACT'; outcome: 'CHECKED' | 'FAILED' | 'OVERRIDDEN'; reason: string | null },
) {
  return ctx.db.transaction(async (tx) => {
    const now = ctx.clock.now();
    const { rows } = await tx.query<ParticipantRow>(
      'SELECT * FROM event_participants WHERE id = $1 AND event_id = $2 FOR UPDATE',
      [participantId, eventId],
    );
    const p = rows[0];
    if (!p) throw new AppError(404, 'PARTICIPANT_NOT_FOUND', 'Participant not found.');
    if (input.outcome === 'OVERRIDDEN' && !input.reason) throw badRequest('REASON_REQUIRED', 'An override requires a reason.');
    if (input.kind === 'CONTACT' && input.outcome === 'CHECKED') {
      throw badRequest('INVALID_OUTCOME', 'Contact details are verified by code, not by staff check. Use override if policy allows.');
    }
    const column = input.kind === 'ID' ? 'id_check' : 'contact_verification';
    const status = input.outcome;
    await tx.query(`UPDATE event_participants SET ${column} = $2, updated_at = $3 WHERE id = $1`, [p.id, status, now]);
    await recordVerification(tx, p, input.kind === 'ID' ? 'IN_PERSON_ID' : 'EMAIL', input.outcome, actorId, input.reason, now);
    await writeAudit(
      tx,
      {
        actorId,
        action: `event_participant.${input.kind === 'ID' ? 'id_check' : 'contact'}_${input.outcome.toLowerCase()}`,
        entityType: 'event_participant',
        entityId: p.id,
        before: { [column]: p[column] },
        after: { [column]: status },
        reason: input.reason,
      },
      now,
    );
    const event = await getEvent(tx, eventId);
    if (input.kind === 'CONTACT' && input.outcome === 'OVERRIDDEN' && event.verification_policy === 'CONTACT_VERIFIED') {
      await issuePassIfMissing(ctx, tx, p, now);
    }
    const { rows: after } = await tx.query<ParticipantRow>('SELECT * FROM event_participants WHERE id = $1', [p.id]);
    return after[0];
  });
}
