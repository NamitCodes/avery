-- Event access extension (PLAN §15–27). Purely additive: existing volunteer
-- attendance tables and data are untouched apart from widening the role list.
--
-- One `events` table serves both event workflows via per-event policy flags:
--   * international events: pre-imported participants, printed passes, ENTRY/EXIT re-entry
--   * open events: ONLINE advance registration + WALK_IN registration, configurable assurance
-- Event participants/registrations live in `event_participants`, separate from `volunteers`.

-- Staff roles reuse the existing account table and authentication.
ALTER TABLE volunteers DROP CONSTRAINT volunteers_role_check;
ALTER TABLE volunteers ADD CONSTRAINT volunteers_role_check
  CHECK (role IN ('VOLUNTEER', 'ADMIN', 'EVENT_ADMIN', 'EXCEPTION_DESK', 'GATE_OPERATOR'));

CREATE TABLE events (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                          text NOT NULL,
  description                   text NOT NULL DEFAULT '',
  location_id                   uuid REFERENCES locations (id),
  venue_text                    text NOT NULL DEFAULT '',
  timezone                      text NOT NULL,
  starts_at                     timestamptz NOT NULL,
  ends_at                       timestamptz NOT NULL,
  status                        text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED')),
  capacity                      integer CHECK (capacity IS NULL OR capacity > 0),
  advance_registration_enabled  boolean NOT NULL DEFAULT false,
  walk_ins_enabled              boolean NOT NULL DEFAULT false,
  pause_registration_at_capacity boolean NOT NULL DEFAULT false,
  reentry_enabled               boolean NOT NULL DEFAULT true,
  print_badges                  boolean NOT NULL DEFAULT true,
  -- Which contact details an attendee must give (name is always required).
  contact_requirement           text NOT NULL DEFAULT 'EMAIL'
                                CHECK (contact_requirement IN ('NONE', 'EMAIL', 'PHONE', 'EMAIL_OR_PHONE')),
  verification_policy           text NOT NULL DEFAULT 'BASIC_REGISTRATION'
                                CHECK (verification_policy IN ('BASIC_REGISTRATION', 'CONTACT_VERIFIED', 'IN_PERSON_ID_CHECK')),
  id_check_mode                 text NOT NULL DEFAULT 'NOT_USED' CHECK (id_check_mode IN ('NOT_USED', 'CONDITIONAL', 'MANDATORY')),
  instructions                  text NOT NULL DEFAULT '',
  redacted_at                   timestamptz,
  created_by                    uuid REFERENCES volunteers (id),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (verification_policy <> 'IN_PERSON_ID_CHECK' OR id_check_mode = 'MANDATORY')
);
CREATE INDEX events_status_idx ON events (status, starts_at);

CREATE TABLE event_participants (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                 uuid NOT NULL REFERENCES events (id),
  name                     text NOT NULL,
  normalized_name          text NOT NULL,
  country                  text NOT NULL DEFAULT '',
  email                    text,
  normalized_email         text,
  phone                    text,
  normalized_phone         text,
  registration_reference   text NOT NULL UNIQUE,
  registration_source      text NOT NULL CHECK (registration_source IN ('IMPORT', 'ONLINE', 'WALK_IN', 'ADMIN')),
  status                   text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'CANCELLED')),
  current_access_state     text NOT NULL DEFAULT 'OUTSIDE' CHECK (current_access_state IN ('OUTSIDE', 'INSIDE')),
  -- First accepted admission; NULL = registered but never checked in.
  checked_in_at            timestamptz,
  last_access_at           timestamptz,
  -- Contact verification and identity checks are distinct facts.
  contact_verification     text NOT NULL DEFAULT 'NOT_REQUIRED'
                           CHECK (contact_verification IN ('NOT_REQUIRED', 'PENDING', 'VERIFIED', 'FAILED', 'OVERRIDDEN')),
  id_check                 text NOT NULL DEFAULT 'NOT_REQUIRED'
                           CHECK (id_check IN ('NOT_REQUIRED', 'PENDING', 'CHECKED', 'FAILED', 'OVERRIDDEN')),
  needs_review             boolean NOT NULL DEFAULT false,
  review_note              text,
  created_by               uuid REFERENCES volunteers (id),
  registered_at            timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  -- Supports composite FKs that pin child rows to the participant's own event.
  UNIQUE (id, event_id)
);
-- Emails are deliberately NOT unique: shared addresses are flagged for review instead.
CREATE INDEX event_participants_event_email_idx ON event_participants (event_id, normalized_email);
CREATE INDEX event_participants_event_name_idx ON event_participants (event_id, normalized_name);
CREATE INDEX event_participants_event_phone_idx ON event_participants (event_id, normalized_phone);
CREATE INDEX event_participants_event_country_idx ON event_participants (event_id, country);
CREATE INDEX event_participants_inside_idx ON event_participants (event_id) WHERE current_access_state = 'INSIDE';

CREATE TABLE event_credentials (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                   uuid NOT NULL REFERENCES events (id),
  participant_id             uuid NOT NULL,
  -- SHA-256 of the 256-bit random token; used for scan lookups.
  token_hash                 text NOT NULL UNIQUE,
  -- AES-256-GCM encrypted token so passes can be reprinted/re-emailed. Never logged.
  token_ciphertext           text NOT NULL,
  status                     text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  issued_at                  timestamptz NOT NULL DEFAULT now(),
  revoked_at                 timestamptz,
  revoke_reason              text,
  replaced_by_credential_id  uuid REFERENCES event_credentials (id),
  created_by                 uuid REFERENCES volunteers (id),
  FOREIGN KEY (participant_id, event_id) REFERENCES event_participants (id, event_id),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX event_credentials_one_active_uq ON event_credentials (participant_id) WHERE status = 'ACTIVE';
CREATE INDEX event_credentials_participant_idx ON event_credentials (participant_id, issued_at DESC);

CREATE TABLE event_gates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              uuid NOT NULL REFERENCES events (id),
  name                  text NOT NULL,
  mode                  text NOT NULL CHECK (mode IN ('ENTRY', 'EXIT')),
  location_description  text NOT NULL DEFAULT '',
  status                text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_gates_event_idx ON event_gates (event_id);

-- Gate operators may only scan at gates they are assigned to.
CREATE TABLE event_gate_operators (
  gate_id      uuid NOT NULL REFERENCES event_gates (id),
  operator_id  uuid NOT NULL REFERENCES volunteers (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (gate_id, operator_id)
);
CREATE INDEX event_gate_operators_operator_idx ON event_gate_operators (operator_id);

-- Append-only access history: accepted transitions, rejected attempts, overrides, corrections.
CREATE TABLE event_access_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           uuid NOT NULL REFERENCES events (id),
  participant_id     uuid,                       -- NULL for unknown credentials
  credential_id      uuid REFERENCES event_credentials (id),
  gate_id            uuid REFERENCES event_gates (id),
  event_type         text NOT NULL CHECK (event_type IN ('CHECK_IN', 'ENTRY', 'EXIT', 'CORRECTION')),
  result             text NOT NULL CHECK (result IN ('ACCEPTED', 'REJECTED')),
  reject_code        text,
  source             text NOT NULL CHECK (source IN ('QR', 'DESK', 'MANUAL')),
  operator_id        uuid REFERENCES volunteers (id),
  occurred_at        timestamptz NOT NULL,
  idempotency_key    text,
  reason             text,
  corrects_event_id  uuid REFERENCES event_access_events (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (participant_id, event_id) REFERENCES event_participants (id, event_id),
  CHECK ((result = 'REJECTED') = (reject_code IS NOT NULL)),
  CHECK (source <> 'MANUAL' OR reason IS NOT NULL),
  CHECK (event_type <> 'CORRECTION' OR (corrects_event_id IS NOT NULL AND reason IS NOT NULL))
);
CREATE UNIQUE INDEX event_access_events_idem_uq ON event_access_events (idempotency_key) WHERE idempotency_key IS NOT NULL;
-- An accepted event can be corrected at most once.
CREATE UNIQUE INDEX event_access_events_correction_uq ON event_access_events (corrects_event_id) WHERE corrects_event_id IS NOT NULL;
CREATE INDEX event_access_events_participant_idx ON event_access_events (participant_id, occurred_at DESC);
CREATE INDEX event_access_events_gate_idx ON event_access_events (gate_id, occurred_at DESC);
CREATE INDEX event_access_events_event_idx ON event_access_events (event_id, occurred_at DESC);

CREATE TABLE event_verifications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           uuid NOT NULL REFERENCES events (id),
  participant_id     uuid NOT NULL,
  verification_type  text NOT NULL CHECK (verification_type IN ('EMAIL', 'PHONE', 'IN_PERSON_ID')),
  outcome            text NOT NULL CHECK (outcome IN ('VERIFIED', 'CHECKED', 'FAILED', 'OVERRIDDEN')),
  verified_by        uuid REFERENCES volunteers (id),   -- NULL for automated contact verification
  verified_at        timestamptz NOT NULL,
  reason             text,
  FOREIGN KEY (participant_id, event_id) REFERENCES event_participants (id, event_id),
  CHECK (outcome <> 'OVERRIDDEN' OR (verified_by IS NOT NULL AND reason IS NOT NULL))
);
CREATE INDEX event_verifications_participant_idx ON event_verifications (participant_id, verified_at);

-- Single-use email codes. Only a hash of the code is stored.
CREATE TABLE event_contact_challenges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id  uuid NOT NULL REFERENCES event_participants (id),
  channel         text NOT NULL CHECK (channel IN ('EMAIL')),
  code_hash       text NOT NULL,
  expires_at      timestamptz NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_contact_challenges_participant_idx ON event_contact_challenges (participant_id, created_at DESC);

CREATE TABLE event_pass_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events (id),
  participant_id  uuid NOT NULL,
  credential_id   uuid NOT NULL REFERENCES event_credentials (id),
  delivery_status text NOT NULL DEFAULT 'QUEUED' CHECK (delivery_status IN ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED')),
  attempt_count   integer NOT NULL DEFAULT 0,
  last_error      text,
  sent_at         timestamptz,
  created_by      uuid REFERENCES volunteers (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (participant_id, event_id) REFERENCES event_participants (id, event_id)
);
CREATE INDEX event_pass_deliveries_queue_idx ON event_pass_deliveries (delivery_status, created_at);
CREATE INDEX event_pass_deliveries_participant_idx ON event_pass_deliveries (participant_id, created_at DESC);
CREATE INDEX event_pass_deliveries_event_idx ON event_pass_deliveries (event_id, delivery_status);

CREATE TABLE event_imports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events (id),
  uploaded_by      uuid REFERENCES volunteers (id),
  source_filename  text,
  existing_policy  text NOT NULL CHECK (existing_policy IN ('SKIP', 'UPDATE')),
  rows_processed   integer NOT NULL,
  rows_created     integer NOT NULL,
  rows_updated     integer NOT NULL,
  rows_skipped     integer NOT NULL,
  rows_failed      integer NOT NULL,
  rows_flagged     integer NOT NULL,
  -- Row numbers + error codes only; no copies of personal data.
  errors           jsonb NOT NULL DEFAULT '[]',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_imports_event_idx ON event_imports (event_id, created_at DESC);
