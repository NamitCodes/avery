export interface EventRecord {
  id: string;
  name: string;
  description: string;
  venue_text: string;
  timezone: string;
  starts_at: string;
  ends_at: string;
  status: 'DRAFT' | 'ACTIVE' | 'CLOSED' | 'ARCHIVED';
  capacity: number | null;
  advance_registration_enabled: boolean;
  walk_ins_enabled: boolean;
  pause_registration_at_capacity: boolean;
  reentry_enabled: boolean;
  print_badges: boolean;
  contact_requirement: 'NONE' | 'EMAIL' | 'PHONE' | 'EMAIL_OR_PHONE';
  verification_policy: 'BASIC_REGISTRATION' | 'CONTACT_VERIFIED' | 'IN_PERSON_ID_CHECK';
  id_check_mode: 'NOT_USED' | 'CONDITIONAL' | 'MANDATORY';
  instructions: string;
  redacted_at: string | null;
  participant_count?: number;
  inside_count?: number;
  checked_in_count?: number;
}

export interface Participant {
  id: string;
  event_id: string;
  name: string;
  country: string;
  email: string | null;
  phone: string | null;
  registration_reference: string;
  registration_source: 'IMPORT' | 'ONLINE' | 'WALK_IN' | 'ADMIN';
  status: 'ACTIVE' | 'INACTIVE' | 'CANCELLED';
  current_access_state: 'OUTSIDE' | 'INSIDE';
  checked_in_at: string | null;
  last_access_at: string | null;
  contact_verification: string;
  id_check: string;
  needs_review: boolean;
  review_note: string | null;
  registered_at: string;
  active_credential_id?: string | null;
  last_delivery_status?: string | null;
}

export interface Pass {
  event: { id: string; name: string; starts_at: string; ends_at: string; timezone: string; venue: string; instructions: string; reentry_enabled: boolean };
  participant: { name: string; country: string; registration_reference: string };
  qr_data_url: string;
  pass_url: string;
}

export interface AccessOutcome {
  result: 'ACCEPTED' | 'REJECTED';
  code: string;
  message: string;
  event_type: 'CHECK_IN' | 'ENTRY' | 'EXIT';
  access_event_id: string;
  occurred_at: string;
  replay: boolean;
  participant: {
    id: string;
    name: string;
    country: string;
    registration_reference: string;
    current_access_state: string;
    checked_in_at: string | null;
    contact_verification: string;
    id_check: string;
  } | null;
  gate: { id: string; name: string; mode: string } | null;
}

export const POLICY_LABEL: Record<string, string> = {
  BASIC_REGISTRATION: 'Basic registration',
  CONTACT_VERIFIED: 'Contact verified (email code)',
  IN_PERSON_ID_CHECK: 'In-person photo ID check',
};

export const SOURCE_LABEL: Record<string, string> = { IMPORT: 'Imported', ONLINE: 'Online', WALK_IN: 'Walk-in', ADMIN: 'Admin' };

/** Plain-language state of a participant for staff screens. */
export function stateLabel(p: { current_access_state: string; checked_in_at: string | null }, reentry: boolean) {
  if (!p.checked_in_at) return 'Not checked in';
  if (!reentry) return 'Checked in';
  return p.current_access_state === 'INSIDE' ? 'Inside' : 'Outside';
}

export const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
