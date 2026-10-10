import { writeAudit } from '../../audit.js';
import type { AuthUser } from '../../auth.js';
import type { AppContext } from '../../context.js';
import { isUniqueViolation, type Queryable } from '../../db.js';
import { AppError, conflict, notFound } from '../../errors.js';
import { admittedCount, gateView, getEvent, type EventRow, type GateRow, type ParticipantRow } from './common.js';
import { extractToken, hashToken, type CredentialRow } from './credentials.js';

export type Direction = 'IN' | 'OUT';
export type AccessSource = 'QR' | 'DESK' | 'MANUAL';
export type EventType = 'CHECK_IN' | 'ENTRY' | 'EXIT' | 'CORRECTION';

export interface AccessEventRow {
  id: string;
  event_id: string;
  participant_id: string | null;
  credential_id: string | null;
  gate_id: string | null;
  event_type: EventType;
  result: 'ACCEPTED' | 'REJECTED';
  reject_code: string | null;
  source: AccessSource;
  operator_id: string | null;
  occurred_at: Date;
  idempotency_key: string | null;
  reason: string | null;
  corrects_event_id: string | null;
  created_at: Date;
}

/** Operator-facing instructions for each outcome. */
export const OUTCOME_MESSAGES: Record<string, string> = {
  ACCEPTED_ENTRY: 'Entry accepted.',
  ACCEPTED_EXIT: 'Exit accepted.',
  ACCEPTED_CHECK_IN: 'Checked in.',
  ALREADY_INSIDE: 'Already inside — entry NOT recorded. If they say they left, send them to the exception desk.',
  ALREADY_OUTSIDE: 'Not recorded as inside — exit NOT recorded. Send to the exception desk.',
  ALREADY_CHECKED_IN: 'Already checked in — do not count again. Check the original time shown.',
  UNKNOWN_CREDENTIAL: 'Pass not recognised. Send to the exception desk.',
  REVOKED_CREDENTIAL: 'This pass has been revoked or replaced. Send to the exception desk.',
  WRONG_EVENT: 'This pass is for a different event. Send to the exception desk.',
  PARTICIPANT_INACTIVE: 'This registration is not active. Send to the exception desk.',
  EVENT_NOT_ACTIVE: 'This event is not open for admission.',
  GATE_INACTIVE: 'This gate is not active. Contact your supervisor.',
  EXIT_NOT_ENABLED: 'This event does not track exits.',
  CAPACITY_REACHED: 'Event capacity reached — do not admit. Escalate to a supervisor.',
  CONTACT_VERIFICATION_REQUIRED: 'Contact verification required before admission. Send to the exception desk.',
  ID_CHECK_REQUIRED: 'Photo ID check required. Check ID and record the result, then scan again.',
  ID_CHECK_FAILED: 'ID check failed. Send to the exception desk / supervisor.',
};

export interface AccessOutcome {
  result: 'ACCEPTED' | 'REJECTED';
  code: string;
  message: string;
  event_type: EventType;
  access_event_id: string;
  occurred_at: Date;
  replay: boolean;
  participant: ReturnType<typeof gateView> | null;
  gate: { id: string; name: string; mode: string } | null;
}

interface TransitionInput {
  event: EventRow;
  participant: ParticipantRow; // must be locked FOR UPDATE by the caller
  direction: Direction;
  source: AccessSource;
  operatorId: string | null;
  gate: GateRow | null;
  credentialId: string | null;
  idempotencyKey: string | null;
  reason: string | null;
  /** Bypass verification and capacity checks (authorised manual admission only). */
  override: boolean;
  now: Date;
}

async function insertAccessEvent(
  tx: Queryable,
  e: Omit<AccessEventRow, 'id' | 'created_at' | 'corrects_event_id'> & { corrects_event_id?: string | null },
) {
  const { rows } = await tx.query<AccessEventRow>(
    `INSERT INTO event_access_events
       (event_id, participant_id, credential_id, gate_id, event_type, result, reject_code, source, operator_id,
        occurred_at, idempotency_key, reason, corrects_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
    [
      e.event_id, e.participant_id, e.credential_id, e.gate_id, e.event_type, e.result, e.reject_code, e.source,
      e.operator_id, e.occurred_at, e.idempotency_key, e.reason, e.corrects_event_id ?? null,
    ],
  );
  return rows[0];
}

function eventTypeFor(event: EventRow, direction: Direction): EventType {
  if (!event.reentry_enabled) return 'CHECK_IN';
  return direction === 'IN' ? 'ENTRY' : 'EXIT';
}

/** Decide whether a transition is allowed. Returns a reject code, or null to accept. */
async function evaluate(tx: Queryable, t: TransitionInput): Promise<string | null> {
  const { event, participant: p, direction } = t;
  if (event.status !== 'ACTIVE') return 'EVENT_NOT_ACTIVE';
  if (t.gate && t.gate.status !== 'ACTIVE') return 'GATE_INACTIVE';
  if (p.status !== 'ACTIVE') return 'PARTICIPANT_INACTIVE';
  if (direction === 'OUT') {
    if (!event.reentry_enabled) return 'EXIT_NOT_ENABLED';
    return p.current_access_state === 'INSIDE' ? null : 'ALREADY_OUTSIDE';
  }
  if (event.reentry_enabled ? p.current_access_state === 'INSIDE' : p.checked_in_at !== null) {
    return event.reentry_enabled ? 'ALREADY_INSIDE' : 'ALREADY_CHECKED_IN';
  }
  if (!t.override) {
    if (event.verification_policy === 'CONTACT_VERIFIED' && !['VERIFIED', 'OVERRIDDEN'].includes(p.contact_verification)) {
      return 'CONTACT_VERIFICATION_REQUIRED';
    }
    if (p.id_check === 'FAILED') return 'ID_CHECK_FAILED';
    if (event.id_check_mode === 'MANDATORY' && !['CHECKED', 'OVERRIDDEN'].includes(p.id_check)) return 'ID_CHECK_REQUIRED';
    if (event.capacity !== null) {
      // Serialise admissions for capacity-limited events so concurrent scans can't overshoot.
      await tx.query('SELECT id FROM events WHERE id = $1 FOR UPDATE', [event.id]);
      if ((await admittedCount(tx, event)) >= event.capacity) return 'CAPACITY_REACHED';
    }
  }
  return null;
}

/**
 * Apply an entry/exit/check-in for one participant. Accepted transitions update
 * the participant's state and append history in the same transaction; rejected
 * attempts are logged without touching state.
 */
async function transition(tx: Queryable, t: TransitionInput): Promise<AccessEventRow> {
  const rejectCode = await evaluate(tx, t);
  const base = {
    event_id: t.event.id,
    participant_id: t.participant.id,
    credential_id: t.credentialId,
    gate_id: t.gate?.id ?? null,
    event_type: eventTypeFor(t.event, t.direction),
    source: t.source,
    operator_id: t.operatorId,
    occurred_at: t.now,
    idempotency_key: t.idempotencyKey,
    reason: t.reason,
  };
  if (rejectCode) return insertAccessEvent(tx, { ...base, result: 'REJECTED', reject_code: rejectCode });

  const from = t.direction === 'IN' ? 'OUTSIDE' : 'INSIDE';
  const to = t.direction === 'IN' ? 'INSIDE' : 'OUTSIDE';
  // Conditional update guards against stale state even if a caller forgot the row lock.
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE event_participants
     SET current_access_state = $2, last_access_at = $3, checked_in_at = COALESCE(checked_in_at, $3), updated_at = $3
     WHERE id = $1 AND current_access_state = $4 RETURNING id`,
    [t.participant.id, to, t.now, from],
  );
  if (!rows[0]) throw new AppError(409, 'STATE_CHANGED', 'The participant’s state changed during the scan. Please scan again.');
  const accepted = await insertAccessEvent(tx, { ...base, result: 'ACCEPTED', reject_code: null });
  if (t.source !== 'QR') {
    await writeAudit(
      tx,
      {
        actorId: t.operatorId,
        action: t.override ? 'event_access.manual_override' : 'event_access.desk',
        entityType: 'event_access_event',
        entityId: accepted.id,
        after: { participant_id: t.participant.id, event_type: accepted.event_type, state: to },
        reason: t.reason,
      },
      t.now,
    );
  }
  return accepted;
}

async function findByIdempotencyKey(q: Queryable, key: string) {
  const { rows } = await q.query<AccessEventRow>('SELECT * FROM event_access_events WHERE idempotency_key = $1', [key]);
  return rows[0];
}

async function describe(q: Queryable, ev: AccessEventRow, replay: boolean): Promise<AccessOutcome> {
  const { rows: ps } = ev.participant_id
    ? await q.query<ParticipantRow>('SELECT * FROM event_participants WHERE id = $1', [ev.participant_id])
    : { rows: [] as ParticipantRow[] };
  const { rows: gs } = ev.gate_id
    ? await q.query<GateRow>('SELECT * FROM event_gates WHERE id = $1', [ev.gate_id])
    : { rows: [] as GateRow[] };
  const code = ev.result === 'ACCEPTED' ? `ACCEPTED_${ev.event_type}` : ev.reject_code!;
  return {
    result: ev.result,
    code: ev.result === 'ACCEPTED' ? 'ACCEPTED' : ev.reject_code!,
    message: OUTCOME_MESSAGES[code] ?? code,
    event_type: ev.event_type,
    access_event_id: ev.id,
    occurred_at: ev.occurred_at,
    replay,
    participant: ps[0] ? gateView(ps[0]) : null,
    gate: gs[0] ? { id: gs[0].id, name: gs[0].name, mode: gs[0].mode } : null,
  };
}

/** May this user operate this gate? Gate operators must be assigned; desk staff and managers may use any gate. */
export async function assertGateAccess(q: Queryable, user: AuthUser, gateId: string) {
  if (user.role !== 'GATE_OPERATOR') return;
  const { rows } = await q.query('SELECT 1 FROM event_gate_operators WHERE gate_id = $1 AND operator_id = $2', [gateId, user.id]);
  if (!rows[0]) throw new AppError(403, 'GATE_NOT_ASSIGNED', 'You are not assigned to this gate.');
}

/**
 * Process a QR scan at a gate. The gate determines event and direction; the
 * credential determines the participant. Client-supplied state is never trusted.
 */
export async function gateScan(
  ctx: AppContext,
  user: AuthUser,
  input: { gateId: string; scanned: string; idempotencyKey: string | null; expectMode?: 'ENTRY' | 'EXIT' },
): Promise<AccessOutcome> {
  if (input.idempotencyKey) {
    const prior = await findByIdempotencyKey(ctx.db, input.idempotencyKey);
    if (prior) return describe(ctx.db, prior, true);
  }
  try {
    const ev = await ctx.db.transaction(async (tx) => {
      const now = ctx.clock.now();
      const { rows: gates } = await tx.query<GateRow>('SELECT * FROM event_gates WHERE id = $1', [input.gateId]);
      const gate = gates[0];
      if (!gate) throw notFound('GATE_NOT_FOUND', 'Gate not found.');
      await assertGateAccess(tx, user, gate.id);
      if (input.expectMode && gate.mode !== input.expectMode) {
        throw conflict('GATE_MODE_MISMATCH', `This gate is configured for ${gate.mode}.`);
      }
      const event = await getEvent(tx, gate.event_id);
      const direction: Direction = gate.mode === 'ENTRY' ? 'IN' : 'OUT';
      const reject = (code: string, extra: { participant_id?: string | null; credential_id?: string | null } = {}) =>
        insertAccessEvent(tx, {
          event_id: event.id,
          participant_id: extra.participant_id ?? null,
          credential_id: extra.credential_id ?? null,
          gate_id: gate.id,
          event_type: eventTypeFor(event, direction),
          result: 'REJECTED',
          reject_code: code,
          source: 'QR',
          operator_id: user.id,
          occurred_at: now,
          idempotency_key: input.idempotencyKey,
          reason: null,
        });

      const token = extractToken(input.scanned);
      if (!token) return reject('UNKNOWN_CREDENTIAL');
      const { rows: creds } = await tx.query<CredentialRow>('SELECT * FROM event_credentials WHERE token_hash = $1', [hashToken(token)]);
      const cred = creds[0];
      if (!cred) return reject('UNKNOWN_CREDENTIAL');
      if (cred.event_id !== event.id) return reject('WRONG_EVENT', { credential_id: cred.id });

      // Lock the participant: serialises simultaneous scans at different gates.
      const { rows: ps } = await tx.query<ParticipantRow>('SELECT * FROM event_participants WHERE id = $1 FOR UPDATE', [cred.participant_id]);
      const participant = ps[0];
      if (input.idempotencyKey) {
        const prior = await findByIdempotencyKey(tx, input.idempotencyKey);
        if (prior) return prior;
      }
      if (cred.status !== 'ACTIVE') return reject('REVOKED_CREDENTIAL', { participant_id: participant.id, credential_id: cred.id });

      return transition(tx, {
        event,
        participant,
        direction,
        source: 'QR',
        operatorId: user.id,
        gate,
        credentialId: cred.id,
        idempotencyKey: input.idempotencyKey,
        reason: null,
        override: false,
        now,
      });
    });
    return describe(ctx.db, ev, false);
  } catch (err) {
    // A concurrent retry with the same key won the race: return its outcome.
    if (input.idempotencyKey && isUniqueViolation(err, 'event_access_events_idem_uq')) {
      const prior = await findByIdempotencyKey(ctx.db, input.idempotencyKey);
      if (prior) return describe(ctx.db, prior, true);
    }
    throw err;
  }
}

/** Staff-initiated entry/exit for a participant (desk check-in, or authorised manual override). */
export async function staffAccess(
  ctx: AppContext,
  user: AuthUser,
  input: { eventId: string; participantId: string; direction: Direction; override: boolean; reason: string | null; idempotencyKey: string | null },
): Promise<AccessOutcome> {
  if (input.idempotencyKey) {
    const prior = await findByIdempotencyKey(ctx.db, input.idempotencyKey);
    if (prior) return describe(ctx.db, prior, true);
  }
  const ev = await ctx.db.transaction(async (tx) => {
    const now = ctx.clock.now();
    const event = await getEvent(tx, input.eventId);
    const { rows } = await tx.query<ParticipantRow>(
      'SELECT * FROM event_participants WHERE id = $1 AND event_id = $2 FOR UPDATE',
      [input.participantId, input.eventId],
    );
    if (!rows[0]) throw notFound('PARTICIPANT_NOT_FOUND', 'Participant not found.');
    if (input.idempotencyKey) {
      const prior = await findByIdempotencyKey(tx, input.idempotencyKey);
      if (prior) return prior;
    }
    const { rows: creds } = await tx.query<{ id: string }>(
      `SELECT id FROM event_credentials WHERE participant_id = $1 AND status = 'ACTIVE'`,
      [input.participantId],
    );
    return transition(tx, {
      event,
      participant: rows[0],
      direction: input.direction,
      source: input.override ? 'MANUAL' : 'DESK',
      operatorId: user.id,
      gate: null,
      credentialId: creds[0]?.id ?? null,
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
      override: input.override,
      now,
    });
  });
  return describe(ctx.db, ev, false);
}

/**
 * Reverse an accepted transition that did not physically happen (e.g. scanned
 * but turned back). Appends a CORRECTION event; the original is never erased.
 * Only the participant's most recent accepted transition can be corrected.
 */
export async function correctAccessEvent(ctx: AppContext, user: AuthUser, accessEventId: string, reason: string) {
  return ctx.db.transaction(async (tx) => {
    const now = ctx.clock.now();
    const { rows } = await tx.query<AccessEventRow>('SELECT * FROM event_access_events WHERE id = $1', [accessEventId]);
    const original = rows[0];
    if (!original) throw notFound('ACCESS_EVENT_NOT_FOUND', 'Access record not found.');
    if (original.result !== 'ACCEPTED' || original.event_type === 'CORRECTION' || !original.participant_id) {
      throw conflict('NOT_CORRECTABLE', 'Only accepted entries, exits and check-ins can be corrected.');
    }
    const { rows: ps } = await tx.query<ParticipantRow>('SELECT * FROM event_participants WHERE id = $1 FOR UPDATE', [original.participant_id]);
    const participant = ps[0];
    const { rows: latest } = await tx.query<AccessEventRow>(
      `SELECT e.* FROM event_access_events e
       WHERE e.participant_id = $1 AND e.result = 'ACCEPTED' AND e.event_type <> 'CORRECTION'
         AND NOT EXISTS (SELECT 1 FROM event_access_events c WHERE c.corrects_event_id = e.id)
       ORDER BY e.occurred_at DESC, e.created_at DESC LIMIT 1`,
      [participant.id],
    );
    if (!latest[0] || latest[0].id !== original.id) {
      throw conflict('NOT_LATEST', 'Only the participant’s most recent uncorrected entry/exit can be corrected.');
    }
    const revertTo = original.event_type === 'EXIT' ? 'INSIDE' : 'OUTSIDE';
    // Recompute first admission time from the remaining accepted admissions.
    const { rows: firstIn } = await tx.query<{ t: Date | null }>(
      `SELECT min(e.occurred_at) AS t FROM event_access_events e
       WHERE e.participant_id = $1 AND e.result = 'ACCEPTED' AND e.event_type IN ('ENTRY', 'CHECK_IN') AND e.id <> $2
         AND NOT EXISTS (SELECT 1 FROM event_access_events c WHERE c.corrects_event_id = e.id)`,
      [participant.id, original.id],
    );
    await tx.query(
      `UPDATE event_participants SET current_access_state = $2, checked_in_at = $3, updated_at = $4 WHERE id = $1`,
      [participant.id, revertTo, firstIn[0]?.t ?? null, now],
    );
    const correction = await insertAccessEvent(tx, {
      event_id: original.event_id,
      participant_id: participant.id,
      credential_id: null,
      gate_id: null,
      event_type: 'CORRECTION',
      result: 'ACCEPTED',
      reject_code: null,
      source: 'MANUAL',
      operator_id: user.id,
      occurred_at: now,
      idempotency_key: null,
      reason,
      corrects_event_id: original.id,
    });
    await writeAudit(
      tx,
      {
        actorId: user.id,
        action: 'event_access.correct',
        entityType: 'event_access_event',
        entityId: original.id,
        before: { state: participant.current_access_state, checked_in_at: participant.checked_in_at },
        after: { state: revertTo, correction_id: correction.id },
        reason,
      },
      now,
    );
    return correction;
  });
}
