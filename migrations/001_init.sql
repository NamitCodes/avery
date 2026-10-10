-- Volunteer attendance system: initial schema.
-- All timestamps are stored as timestamptz (UTC) and converted for display.

CREATE TABLE volunteers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  volunteer_code  text NOT NULL UNIQUE,
  name            text NOT NULL,
  email           text NOT NULL,
  password_hash   text NOT NULL,
  role            text NOT NULL DEFAULT 'VOLUNTEER' CHECK (role IN ('VOLUNTEER', 'ADMIN')),
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX volunteers_email_uq ON volunteers (lower(email));
CREATE INDEX volunteers_name_idx ON volunteers (lower(name));

CREATE TABLE locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  address     text NOT NULL DEFAULT '',
  timezone    text NOT NULL,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE venue_qr_codes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id        uuid NOT NULL REFERENCES locations (id),
  public_identifier  text NOT NULL UNIQUE,
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_by         uuid REFERENCES volunteers (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  revoked_by         uuid REFERENCES volunteers (id),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);
-- At most one active QR per venue; a replacement revokes the previous one.
CREATE UNIQUE INDEX venue_qr_codes_one_active_uq ON venue_qr_codes (location_id) WHERE status = 'ACTIVE';
CREATE INDEX venue_qr_codes_location_idx ON venue_qr_codes (location_id, created_at DESC);

CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id        uuid NOT NULL REFERENCES locations (id),
  title              text NOT NULL,
  description        text NOT NULL DEFAULT '',
  start_at           timestamptz NOT NULL,
  end_at             timestamptz NOT NULL,
  checkin_opens_at   timestamptz NOT NULL,
  checkin_closes_at  timestamptz NOT NULL,
  status             text NOT NULL DEFAULT 'DRAFT'
                     CHECK (status IN ('DRAFT', 'SCHEDULED', 'OPEN', 'CLOSED', 'CANCELLED', 'ARCHIVED')),
  created_by         uuid REFERENCES volunteers (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  CHECK (checkin_closes_at > checkin_opens_at)
);
CREATE INDEX sessions_location_start_idx ON sessions (location_id, start_at);
CREATE INDEX sessions_start_idx ON sessions (start_at);
CREATE INDEX sessions_status_window_idx ON sessions (status, checkin_opens_at, checkin_closes_at);

CREATE TABLE attendance_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES sessions (id),
  volunteer_id  uuid NOT NULL REFERENCES volunteers (id),
  tapped_in_at  timestamptz NOT NULL,
  source        text NOT NULL CHECK (source IN ('QR', 'ADMIN')),
  -- VOIDED records are retained (never deleted) but excluded from counts.
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'VOIDED')),
  qr_code_id    uuid REFERENCES venue_qr_codes (id),
  created_by    uuid REFERENCES volunteers (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_records_session_volunteer_uq UNIQUE (session_id, volunteer_id)
);
CREATE INDEX attendance_records_volunteer_idx ON attendance_records (volunteer_id, tapped_in_at DESC);
CREATE INDEX attendance_records_session_idx ON attendance_records (session_id, tapped_in_at);

CREATE TABLE audit_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id     uuid REFERENCES volunteers (id),  -- NULL = system (scheduler)
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    uuid,
  before_data  jsonb,
  after_data   jsonb,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, created_at);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);
