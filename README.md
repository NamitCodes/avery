# Attendance & Event Access

One application and one PostgreSQL database supporting the three workflows in [UPDATED_PLAN.md](UPDATED_PLAN.md):

1. **Volunteer session attendance** — volunteers scan a printed, reusable venue QR, sign in, pick the session and confirm (§1–14).
2. **International event access** — organiser-supplied participant lists are imported, printable QR passes are issued and emailed, and entry, exit and re-entry are tracked at gates (§15–25).
3. **Open events** — online advance registration plus walk-ins at the venue, with configurable identity assurance and an auditable record for every admitted attendee (§26–27).

Stack: Node 20, TypeScript, Express 5, PostgreSQL (`pg`), React 18 + Vite, Vitest + Supertest.

## Quick start (development)

```bash
npm install
npm run create-admin -- --email you@example.org --name "Your Name" --password "a-long-password"
npm run dev          # API on :3000, web on :5173 (proxying /api)
```

If `DATABASE_URL` is not set, an embedded PostgreSQL (PGlite) is stored in `./.data/pglite` and migrated automatically. Emails are logged to the console rather than sent.

Open http://localhost:5173. To try the volunteer flow:

1. Create a venue under **Venues** and print its QR.
2. Create and publish a session under **Sessions**.
3. Open the QR URL (`/check-in/v/…`) while signed in as a volunteer.

## Demo

```bash
npm run demo          # wipes & reloads the demo database (.data/demo), starts API + web
```

Open http://localhost:5173/demo. It's a menu with **three short laptop + phone demos** (`/demo/weekly`, `/demo/planned`, `/demo/surprise`) and the **detailed demo guide** (`/demo/full`). It has:

- step-by-step scripts for all three workflows, each with what to click and what to point out;
- one-click "sign in as" buttons for every role (password `demo1234`);
- sample passes to paste or scan into the gate scanners;
- the venue QR codes;
- an email outbox showing pass emails and verification codes, since demo mode doesn't send email;
- a *Refresh demo times* button, which re-centres the sessions and events on the current time if you present hours after loading.

Other options:

- `npm run demo:start` builds the app and runs it as a single server on :3000 (guide at http://localhost:3000/demo).
- To scan the venue QR codes with a real phone, set `PUBLIC_BASE_URL=http://<laptop-LAN-IP>:5173` before `npm run demo`. Vite listens on the LAN in demo mode.
- Demo mode (`DEMO_MODE=true`, or `--demo`) exposes demo credentials and passes. Startup refuses it with `NODE_ENV=production`, and it uses its own database, so it never touches dev or real data.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | API (tsx watch) + Vite dev server |
| `npm test` | Test suite (in-memory PGlite, no external services needed). Set `TEST_DATABASE_URL=postgres://user@host:5432/postgres` to run it against a real PostgreSQL server; each file gets a throwaway database |
| `npm run test:e2e` | Playwright browser tests against a running demo (`npm run demo` first). Runs in your installed Chrome plus an iPhone/WebKit project (one-time: `npx playwright install webkit`). Set `E2E_BASE_URL` to target another URL |
| `npm run typecheck` | Type-check the server, web and tests |
| `npm run lint` | ESLint |
| `npm run build` | Compile the server to `dist/server` and the SPA to `dist/web` |
| `npm start` | Run the compiled server, which also serves the SPA |
| `npm run migrate` / `npm run migrate:prod` | Apply SQL migrations (`migrations/*.sql`) |
| `npm run create-admin -- --email … [--name …] [--password …]` | Create an administrator, or promote an existing account |

## Environment variables

See [.env.example](.env.example). The following are required in production (startup fails without them):

- `DATABASE_URL`
- `JWT_SECRET`: at least 32 characters.
- `PUBLIC_BASE_URL`: must be `https://`. It is encoded in every QR code, so changing it means reprinting venue QRs and passes.
- `CREDENTIAL_ENCRYPTION_KEY`: 32 bytes, base64-encoded.

Recommended in production:

- `SMTP_URL` and `MAIL_FROM`: without them, pass and verification emails fail and are shown as FAILED, so they can be retried later.
- `FORCE_HTTPS=true` and `TRUST_PROXY=1` when running behind a TLS-terminating proxy.

## Deployment

**Render:** see [DEPLOY_RENDER.md](DEPLOY_RENDER.md). A one-click Blueprint ([render.yaml](render.yaml)) sets up the web service and PostgreSQL.

1. `npm ci && npm run build`
2. `NODE_ENV=production npm run migrate:prod`. Migrations are additive; `002_event_access.sql` only adds tables and widens the role check.
3. `NODE_ENV=production npm start` behind HTTPS.
4. Run `npm run create-admin` once.

Operational notes:

- **Background work.** Each instance runs a scheduler every `SCHEDULER_INTERVAL_SECONDS`. It auto-opens and auto-closes sessions and sends queued pass emails.
  - Both jobs are safe to run on several instances: the state updates are conditional, and email jobs are claimed with `SKIP LOCKED`.
  - Emails stuck in `SENDING` for more than 10 minutes are re-queued automatically.
- **Rate limiting** uses in-memory counters, which are per instance. If you run several instances, put a shared limiter at the proxy, or swap in a Redis store.
- **Gate throughput.** Rehearse with your real scanners and staffing before event day. Scanning stations accept USB/Bluetooth "keyboard" scanners, and also the device camera where the browser supports `BarcodeDetector`.
- **Offline scanning is deliberately not supported.** If the network drops, the scanner shows **NOT CONFIRMED** and offers a retry that reuses the same idempotency key.

## Roles

| Role | Can do |
|---|---|
| `VOLUNTEER` | Check in to sessions; view own history |
| `ADMIN` | Everything: volunteer sessions, venues, people, the audit log, all event functions, and data redaction |
| `EVENT_ADMIN` | Events: configuration, import, passes and email, gates, exports, manual overrides |
| `EXCEPTION_DESK` | Search participants (contact details masked), walk-ins, desk check-in, replace/revoke/reprint passes, verification overrides, corrections, manual overrides, scanning at any gate |
| `GATE_OPERATOR` | Scan only at the gates they are assigned to; record photo-ID check passed/failed. Cannot change data, issue passes or override |

An administrator assigns roles on **People → person**. Every rule is enforced on the server.

## Design decisions and assumptions

### Volunteer attendance

- **The check-in window is authoritative.** An ordinary check-in needs status `SCHEDULED`/`OPEN` *and* `checkin_opens_at ≤ now < checkin_closes_at`, so a lagging scheduler never blocks or admits anyone wrongly.
  - Opening early pulls the window start forward.
  - Reopening after the window has ended extends it by `REOPEN_EXTENSION_MINUTES`, unless a close time is supplied.
- **One record per session.** A `UNIQUE (session_id, volunteer_id)` constraint plus `INSERT … ON CONFLICT DO NOTHING` makes retries return the original record and timestamp, even after the window has closed.
- **Corrections never delete.** Admins can change the tap-in time, or void and restore a record. A reason is always required, and the before/after values go to `audit_logs`. A voided record blocks silent re-creation by QR.
- **One active QR per venue.** Generating a replacement revokes the previous QR. Revoking a QR never touches attendance.
- **Admin-assisted check-ins** (source `ADMIN`) are allowed for open, scheduled and closed sessions, but not for draft, cancelled or archived ones.

### Event access (international and open events)

- **One `events` table with per-event policy flags.** These cover re-entry, advance registration, walk-ins, capacity, verification policy and ID-check mode. The international scenario is an event with imported participants and re-entry enabled; an open event enables registration and walk-ins.
- **One participant table for both event workflows.** Participants and registrations are stored together in `event_participants`, with `registration_source` set to `IMPORT`, `ONLINE` or `WALK_IN`. This table is separate from `volunteers`, and nothing is ever merged automatically.
- **Import idempotency.** The import key is *normalised email + normalised name*.
  - A row matching an existing participant is skipped, or updated if you choose "Update".
  - The same email with a different name is imported but flagged `needs_review` (it is never merged).
  - The same name with a different email is flagged as a possible duplicate.
  - Only row numbers and error codes are kept in `event_imports`; uploaded files are not stored.
- **Passes.**
  - **Token:** each pass token has 256 bits of randomness. Scans look it up by its SHA-256 hash.
  - **Encrypted copy:** an AES-256-GCM copy of the token is kept so desk staff can reprint passes and the worker can re-email them. Without it, a reprint would require a replacement pass.
  - **QR content:** only `PUBLIC_BASE_URL/pass/<token>`. No personal data is encoded.
  - **Bearer credential:** the pass works for whoever holds it. Gate screens show the registered name so staff can follow the ID policy.
- **Access history is append-only.** Each accepted transition and the participant's state update are written in one transaction, with the participant row locked (`FOR UPDATE`). This serialises simultaneous scans at different gates.
  - Retries with the same `idempotency_key` return the original outcome.
  - Rejected attempts are logged but never change state.
  - Mistaken scans are reversed by appending a `CORRECTION` event; the original row is never edited.
  - The occupancy screen recomputes state from history and reports any mismatches.
- **Non-re-entry events** record a single `CHECK_IN`. A repeated scan shows the original time and is not counted again. Exit gates are rejected for these events.
- **Verification facts are stored separately** in `contact_verification`, `id_check` and the `event_verifications` log.
  - Email verification uses a single-use 6-digit code: only its hash is stored, it expires after 15 minutes, and 5 attempts are allowed.
  - Under the `CONTACT_VERIFIED` policy, the pass is withheld until the email address is verified.
  - ID checks record only the outcome, the staff member and the time; no document data is stored.
  - Overrides require desk-level authority and a reason.
- **Walk-ins without email or phone.** Desk staff tick "Attendee has no email or phone", and this is recorded in the audit log. This is the documented fallback for attendees without a phone or email.
- **Capacity.** For re-entry events, capacity is checked against people currently inside; otherwise against people ever checked in. Capacity-limited admissions lock the event row, so the limit cannot be overshot.
- **Data retention.** Once an event is archived, an ADMIN can **redact** it. This irreversibly removes names, emails, phone numbers, verification codes and delivery errors. Counts and anonymised history are kept. How long to wait before redacting is your organisation's policy decision; this tool does not decide it.

### Not implemented

- **XLSX import.** The stack had no spreadsheet library, so only CSV (UTF-8) is supported. In Excel, use *Save As → CSV UTF-8*.
- **Phone or SMS verification.** There is no SMS provider. Phone numbers are stored and searchable, and staff can override with a reason.
- **Offline scanning**, as required by §23.
- **Optional links between a volunteer and an event participant.** §15 marks this as optional and "later".
- **Event-scoped admin permissions.** An `EVENT_ADMIN` can manage all events.
