import crypto from 'node:crypto';
import type { Queryable } from '../../db.js';
import { notFound } from '../../errors.js';

export type EventStatus = 'DRAFT' | 'ACTIVE' | 'CLOSED' | 'ARCHIVED';
export type VerificationPolicy = 'BASIC_REGISTRATION' | 'CONTACT_VERIFIED' | 'IN_PERSON_ID_CHECK';

export interface EventRow {
  id: string;
  name: string;
  description: string;
  location_id: string | null;
  venue_text: string;
  timezone: string;
  starts_at: Date;
  ends_at: Date;
  status: EventStatus;
  capacity: number | null;
  advance_registration_enabled: boolean;
  walk_ins_enabled: boolean;
  pause_registration_at_capacity: boolean;
  reentry_enabled: boolean;
  print_badges: boolean;
  contact_requirement: 'NONE' | 'EMAIL' | 'PHONE' | 'EMAIL_OR_PHONE';
  verification_policy: VerificationPolicy;
  id_check_mode: 'NOT_USED' | 'CONDITIONAL' | 'MANDATORY';
  instructions: string;
  redacted_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ParticipantRow {
  id: string;
  event_id: string;
  name: string;
  normalized_name: string;
  country: string;
  email: string | null;
  normalized_email: string | null;
  phone: string | null;
  normalized_phone: string | null;
  registration_reference: string;
  registration_source: 'IMPORT' | 'ONLINE' | 'WALK_IN' | 'ADMIN';
  status: 'ACTIVE' | 'INACTIVE' | 'CANCELLED';
  current_access_state: 'OUTSIDE' | 'INSIDE';
  checked_in_at: Date | null;
  last_access_at: Date | null;
  contact_verification: 'NOT_REQUIRED' | 'PENDING' | 'VERIFIED' | 'FAILED' | 'OVERRIDDEN';
  id_check: 'NOT_REQUIRED' | 'PENDING' | 'CHECKED' | 'FAILED' | 'OVERRIDDEN';
  needs_review: boolean;
  review_note: string | null;
  created_by: string | null;
  registered_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface GateRow {
  id: string;
  event_id: string;
  name: string;
  mode: 'ENTRY' | 'EXIT';
  location_description: string;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: Date;
  updated_at: Date;
}

/** Unicode-aware normalisation for matching (display values are never altered). */
export function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('und');
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const e = email.normalize('NFKC').trim().toLowerCase();
  return e || null;
}

/** Keep digits and a leading "+"; good enough for matching, not for dialling. */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Human-readable, random (non-sequential) registration reference, e.g. "R7KQ-3MXA". Not a secret. */
export function generateRegistrationReference(): string {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const b of bytes) s += REF_ALPHABET[b % REF_ALPHABET.length];
  return `R${s.slice(0, 3)}-${s.slice(3, 7)}`;
}

/** "jane.doe@example.org" -> "j•••e@example.org" */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [user, domain] = email.split('@');
  if (!domain) return '•••';
  const head = user.slice(0, 1);
  const tail = user.length > 2 ? user.slice(-1) : '';
  return `${head}•••${tail}@${domain}`;
}

export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  return phone.length <= 4 ? '•••' : `•••${phone.slice(-4)}`;
}

export async function getEvent(q: Queryable, id: string, lock = ''): Promise<EventRow> {
  const { rows } = await q.query<EventRow>(`SELECT * FROM events WHERE id = $1 ${lock}`, [id]);
  if (!rows[0]) throw notFound('EVENT_NOT_FOUND', 'Event not found.');
  return rows[0];
}

export async function getParticipant(q: Queryable, eventId: string, id: string, lock = ''): Promise<ParticipantRow> {
  const { rows } = await q.query<ParticipantRow>(
    `SELECT * FROM event_participants WHERE id = $1 AND event_id = $2 ${lock}`,
    [id, eventId],
  );
  if (!rows[0]) throw notFound('PARTICIPANT_NOT_FOUND', 'Participant not found.');
  return rows[0];
}

/** Participant fields safe to show to gate operators (no contact details). */
export function gateView(p: ParticipantRow) {
  return {
    id: p.id,
    name: p.name,
    country: p.country,
    registration_reference: p.registration_reference,
    status: p.status,
    current_access_state: p.current_access_state,
    checked_in_at: p.checked_in_at,
    contact_verification: p.contact_verification,
    id_check: p.id_check,
  };
}

/** Participant record with contact details masked unless the viewer may see them. */
export function staffView(p: ParticipantRow, showContact: boolean) {
  return {
    ...p,
    email: showContact ? p.email : maskEmail(p.email),
    phone: showContact ? p.phone : maskPhone(p.phone),
    normalized_email: undefined,
    normalized_phone: undefined,
    normalized_name: undefined,
  };
}

/** Initial verification states for a new registration under the event's policy. */
export function initialVerification(event: EventRow) {
  return {
    contact_verification: event.verification_policy === 'CONTACT_VERIFIED' ? 'PENDING' : 'NOT_REQUIRED',
    id_check: event.id_check_mode === 'MANDATORY' ? 'PENDING' : 'NOT_REQUIRED',
  } as const;
}

/** Count used for capacity: people currently inside (re-entry) or ever checked in. */
export async function admittedCount(q: Queryable, event: EventRow): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    event.reentry_enabled
      ? `SELECT count(*)::int AS n FROM event_participants WHERE event_id = $1 AND current_access_state = 'INSIDE'`
      : `SELECT count(*)::int AS n FROM event_participants WHERE event_id = $1 AND checked_in_at IS NOT NULL`,
    [event.id],
  );
  return rows[0].n;
}

export async function registrationCount(q: Queryable, eventId: string): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM event_participants WHERE event_id = $1 AND status = 'ACTIVE'`,
    [eventId],
  );
  return rows[0].n;
}

export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
