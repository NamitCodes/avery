import { writeAudit } from '../../audit.js';
import type { AppContext } from '../../context.js';
import { isUniqueViolation, type Queryable } from '../../db.js';
import { AppError, badRequest, conflict } from '../../errors.js';
import {
  EMAIL_PATTERN,
  generateRegistrationReference,
  getEvent,
  initialVerification,
  maskEmail,
  maskPhone,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  registrationCount,
  type EventRow,
  type ParticipantRow,
} from './common.js';
import { buildPass, issueCredential } from './credentials.js';
import { kickDeliveries, queueDelivery } from './deliveries.js';

export interface AttendeeInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
}

function validateContact(event: EventRow, input: AttendeeInput, allowMissingContact: boolean) {
  const email = input.email?.trim() || null;
  const phone = input.phone?.trim() || null;
  if (email && !EMAIL_PATTERN.test(email)) throw badRequest('EMAIL_INVALID', 'Enter a valid email address.');
  if (phone && !normalizePhone(phone)) throw badRequest('PHONE_INVALID', 'Enter a valid phone number.');
  if (allowMissingContact) return { email, phone };
  const req = event.contact_requirement;
  if (req === 'EMAIL' && !email) throw badRequest('EMAIL_REQUIRED', 'An email address is required for this event.');
  if (req === 'PHONE' && !phone) throw badRequest('PHONE_REQUIRED', 'A phone number is required for this event.');
  if (req === 'EMAIL_OR_PHONE' && !email && !phone) {
    throw badRequest('CONTACT_REQUIRED', 'Please give an email address or a phone number.');
  }
  return { email, phone };
}

/** Likely existing registrations for the same person in this event. Never auto-merged. */
export async function findDuplicateCandidates(q: Queryable, eventId: string, input: AttendeeInput) {
  const nEmail = normalizeEmail(input.email);
  const nPhone = normalizePhone(input.phone);
  const nName = normalizeName(input.name);
  const { rows } = await q.query<ParticipantRow>(
    `SELECT * FROM event_participants
     WHERE event_id = $1 AND (normalized_name = $2 OR ($3::text IS NOT NULL AND normalized_email = $3)
                              OR ($4::text IS NOT NULL AND normalized_phone = $4))
     ORDER BY registered_at LIMIT 20`,
    [eventId, nName, nEmail, nPhone],
  );
  return rows.map((p) => ({
    participant: p,
    match: [
      nEmail && p.normalized_email === nEmail ? 'EMAIL' : null,
      nPhone && p.normalized_phone === nPhone ? 'PHONE' : null,
      p.normalized_name === nName ? 'NAME' : null,
    ].filter(Boolean) as string[],
  }));
}

async function assertRegistrationOpen(q: Queryable, event: EventRow) {
  if (event.status !== 'ACTIVE') throw conflict('EVENT_NOT_ACTIVE', 'Registration for this event is not open.');
  if (event.capacity !== null && event.pause_registration_at_capacity && (await registrationCount(q, event.id)) >= event.capacity) {
    throw conflict('CAPACITY_REACHED', 'This event has reached capacity. Registration is paused.');
  }
}

async function insertRegistration(
  tx: Queryable,
  event: EventRow,
  input: AttendeeInput & { email: string | null; phone: string | null },
  source: 'ONLINE' | 'WALK_IN' | 'ADMIN',
  actorId: string | null,
  now: Date,
  review: string | null,
): Promise<ParticipantRow> {
  const v = initialVerification(event);
  for (let attempt = 0; ; attempt++) {
    try {
      await tx.query('SAVEPOINT reg');
      const { rows } = await tx.query<ParticipantRow>(
        `INSERT INTO event_participants
           (event_id, name, normalized_name, country, email, normalized_email, phone, normalized_phone, registration_reference,
            registration_source, contact_verification, id_check, needs_review, review_note, created_by, registered_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16, $16) RETURNING *`,
        [
          event.id, input.name.trim(), normalizeName(input.name), input.country?.trim() ?? '', input.email, normalizeEmail(input.email),
          input.phone, normalizePhone(input.phone), generateRegistrationReference(), source, v.contact_verification, v.id_check,
          review !== null, review, actorId, now,
        ],
      );
      await tx.query('RELEASE SAVEPOINT reg');
      return rows[0];
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT reg');
      if (!isUniqueViolation(err) || attempt >= 4) throw err;
    }
  }
}

/**
 * Public advance registration. No account is created. If the same email/phone
 * is already registered, nothing new is created; the existing pass is re-sent
 * to the address on file (never revealed to the requester).
 */
export async function registerOnline(ctx: AppContext, eventId: string, input: AttendeeInput) {
  const result = await ctx.db.transaction(async (tx) => {
    const now = ctx.clock.now();
    const event = await getEvent(tx, eventId, 'FOR UPDATE');
    if (!event.advance_registration_enabled) throw conflict('REGISTRATION_DISABLED', 'Advance registration is not available for this event.');
    await assertRegistrationOpen(tx, event);
    const { email, phone } = validateContact(event, input, false);
    if (!input.name.trim()) throw badRequest('NAME_REQUIRED', 'Name is required.');

    const nEmail = normalizeEmail(email);
    const nPhone = normalizePhone(phone);
    const { rows: existing } = await tx.query<ParticipantRow>(
      `SELECT * FROM event_participants WHERE event_id = $1 AND status = 'ACTIVE'
         AND (($2::text IS NOT NULL AND normalized_email = $2) OR ($3::text IS NOT NULL AND normalized_phone = $3))
       ORDER BY registered_at LIMIT 1`,
      [event.id, nEmail, nPhone],
    );
    if (existing[0]) {
      const p = existing[0];
      const { rows: cred } = await tx.query<{ id: string }>(`SELECT id FROM event_credentials WHERE participant_id = $1 AND status = 'ACTIVE'`, [p.id]);
      if (cred[0] && p.email) await queueDelivery(tx, p, cred[0].id, null, now);
      return { existing: true as const, event };
    }

    // Same name with different contact details: create, but flag for staff review.
    const { rows: sameName } = await tx.query(`SELECT 1 FROM event_participants WHERE event_id = $1 AND normalized_name = $2 LIMIT 1`, [
      event.id, normalizeName(input.name),
    ]);
    const participant = await insertRegistration(tx, event, { ...input, email, phone }, 'ONLINE', null, now, sameName[0] ? 'POSSIBLE_DUPLICATE_PERSON' : null);
    await writeAudit(tx, { actorId: null, action: 'event_participant.register_online', entityType: 'event_participant', entityId: participant.id, after: { event_id: event.id, source: 'ONLINE' } }, now);

    // With contact verification required, the pass is issued once the email is verified.
    const issueNow = event.verification_policy !== 'CONTACT_VERIFIED';
    const issued = issueNow ? await issueCredential(tx, ctx.config, participant, null, now) : null;
    if (issued && participant.email) await queueDelivery(tx, participant, issued.credential.id, null, now);
    return { existing: false as const, event, participant, token: issued?.token ?? null };
  });
  kickDeliveries(ctx);

  if (result.existing) {
    return {
      existing: true,
      message: 'You are already registered for this event. If you gave an email address, we have re-sent your pass to it.',
    };
  }
  const { participant, token, event } = result;
  return {
    existing: false,
    registration: {
      id: participant.id,
      registration_reference: participant.registration_reference,
      name: participant.name,
      contact_verification: participant.contact_verification,
      id_check: participant.id_check,
    },
    contact_verification_required: participant.contact_verification === 'PENDING',
    pass: token ? await buildPass(ctx.config, event, participant, token) : null,
  };
}

/**
 * Walk-in registration by desk staff. Searches for likely existing registrations
 * first; staff must explicitly confirm a new record when candidates exist.
 */
export async function registerWalkIn(
  ctx: AppContext,
  actorId: string,
  eventId: string,
  input: AttendeeInput & { confirmNew: boolean; contactUnavailable: boolean; sendEmail: boolean },
) {
  const result = await ctx.db.transaction(async (tx) => {
    const now = ctx.clock.now();
    const event = await getEvent(tx, eventId, 'FOR UPDATE');
    if (!event.walk_ins_enabled) throw conflict('WALK_INS_DISABLED', 'Walk-in registration is not enabled for this event. Escalate to a supervisor.');
    await assertRegistrationOpen(tx, event);
    if (!input.name.trim()) throw badRequest('NAME_REQUIRED', 'Name is required.');
    // Documented fallback: staff may record that the attendee has no email/phone.
    const { email, phone } = validateContact(event, input, input.contactUnavailable);

    const candidates = await findDuplicateCandidates(tx, eventId, { ...input, email, phone });
    if (candidates.length && !input.confirmNew) {
      throw new AppError(409, 'POSSIBLE_DUPLICATES', 'Possible existing registrations found. Check them before creating a new one.', {
        candidates: candidates.map((c) => ({
          id: c.participant.id,
          name: c.participant.name,
          country: c.participant.country,
          registration_reference: c.participant.registration_reference,
          email: maskEmail(c.participant.email),
          phone: maskPhone(c.participant.phone),
          checked_in_at: c.participant.checked_in_at,
          status: c.participant.status,
          match: c.match,
        })),
      });
    }
    const review = candidates.length ? 'CREATED_DESPITE_POSSIBLE_DUPLICATE' : null;
    const participant = await insertRegistration(tx, event, { ...input, email, phone }, 'WALK_IN', actorId, now, review);
    await writeAudit(
      tx,
      {
        actorId,
        action: 'event_participant.register_walk_in',
        entityType: 'event_participant',
        entityId: participant.id,
        after: { event_id: event.id, source: 'WALK_IN', contact_unavailable: input.contactUnavailable, duplicate_candidates: candidates.length },
      },
      now,
    );
    const issued = await issueCredential(tx, ctx.config, participant, actorId, now);
    if (input.sendEmail && participant.email) await queueDelivery(tx, participant, issued.credential.id, actorId, now);
    return { event, participant, token: issued.token };
  });
  kickDeliveries(ctx);
  return {
    participant: result.participant,
    pass: await buildPass(ctx.config, result.event, result.participant, result.token),
  };
}
