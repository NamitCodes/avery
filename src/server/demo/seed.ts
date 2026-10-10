/**
 * Demo data for presenting all three workflows. Times are relative to "now" so
 * live sessions and events are open when the demo starts; `refreshDemoTimes`
 * re-centres them later. Never used in production (see config).
 */
import { DateTime } from 'luxon';
import { generateVolunteerCode, hashPassword, type AuthUser } from '../auth.js';
import type { Clock } from '../clock.js';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db.js';
import type { Mailer, MailMessage } from '../mailer.js';
import { gateScan, staffAccess } from '../services/events/access.js';
import { issueCredential } from '../services/events/credentials.js';
import { processDeliveries, queueDelivery } from '../services/events/deliveries.js';
import { commitImport } from '../services/events/import.js';
import { registerOnline, registerWalkIn } from '../services/events/registration.js';
import { recordStaffVerification } from '../services/events/verification.js';
import { adminCorrectAttendance } from '../services/attendance.js';
import { issueQrCode } from '../services/venues.js';

export const DEMO_PASSWORD = 'demo1234';
const TZ = 'Asia/Singapore';

export const DEMO_ACCOUNTS = [
  { key: 'admin', email: 'admin@demo.org', name: 'Avery Admin', role: 'ADMIN', label: 'Administrator — everything' },
  { key: 'events', email: 'events@demo.org', name: 'Eli Events', role: 'EVENT_ADMIN', label: 'Event administrator' },
  { key: 'desk', email: 'desk@demo.org', name: 'Dana Desk', role: 'EXCEPTION_DESK', label: 'Exception desk' },
  { key: 'gate', email: 'gate@demo.org', name: 'Gabe Gate', role: 'GATE_OPERATOR', label: 'Gate operator (Planned-visits gates only)' },
  { key: 'priya', email: 'priya@demo.org', name: 'Priya Raman', role: 'VOLUNTEER', label: 'Volunteer — not checked in yet' },
  { key: 'tom', email: 'tom@demo.org', name: 'Tom Okoro', role: 'VOLUNTEER', label: 'Volunteer — already checked in to “Wednesday Seva”' },
  { key: 'mei', email: 'mei@demo.org', name: 'Mei Tan', role: 'VOLUNTEER', label: 'Volunteer — has attendance history' },
] as const;

const EXTRA_VOLUNTEERS = [
  'Arif Hakim', 'Bea Santos', 'Chen Jun', 'Devi Pillai', 'Ethan Ng', 'Farah Aziz', 'Gopal Iyer', 'Hui Min Lee', 'Isaac Koh', 'Jasmine Wong',
];

const SUMMIT_PEOPLE: [string, string][] = [
  ['Amara Okafor', 'Nigeria'], ['Lucas Silva', 'Brazil'], ['Sofia Rossi', 'Italy'], ['Hiroshi Tanaka', 'Japan'], ['Aisha Rahman', 'Bangladesh'],
  ['Mateo García', 'Spain'], ['Chloé Dubois', 'France'], ['Lukas Müller', 'Germany'], ['Ngozi Eze', 'Nigeria'], ['Arjun Mehta', 'India'],
  ['Sipho Ndlovu', 'South Africa'], ['Emma Johansson', 'Sweden'], ['Nguyễn Văn An', 'Vietnam'], ['王芳', 'China'], ['김민준', 'South Korea'],
  ['Fatima Al-Sayed', 'Egypt'], ['Olivia Brown', 'Australia'], ['Diego Hernández', 'Mexico'], ['Ana Kovač', 'Croatia'], ['Mehmet Yılmaz', 'Türkiye'],
  ['Siti Nurhaliza', 'Malaysia'], ['Juan dela Cruz', 'Philippines'], ['Kwame Mensah', 'Ghana'], ['Isabella Costa', 'Portugal'], ['Noah Williams', 'Canada'],
  ['Leila Haddad', 'Lebanon'], ['Tariq Hussain', 'Pakistan'], ['Elena Petrova', 'Bulgaria'], ['Mia Jensen', 'Denmark'], ['Rangi Parata', 'New Zealand'],
  ['Dmitri Ivanov', 'Kazakhstan'], ['Zanele Dlamini', 'Eswatini'], ['Priyanka Das', 'India'], ['Ahmed Benali', 'Morocco'], ['Sakura Ito', 'Japan'],
  ['Carlos Mendoza', 'Peru'], ['Hana Novák', 'Czechia'], ['Omar Farouk', 'Jordan'],
];

const slug = (s: string) =>
  s.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/\s+/g, '.') || `p${Math.abs([...s].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 100000)}`;

/** Session spec relative to seeding time; kept so times can be refreshed later. */
interface SessionSpec {
  id: string;
  startOffsetMin: number;
  durationMin: number;
  opensBeforeMin: number;
  closesAfterMin: number;
  cancelled?: boolean;
}

export interface DemoFixtures {
  seeded_at: string;
  accounts: Record<string, string>; // key -> user id
  venues: { key: string; id: string; name: string; qr_id: string; public_identifier: string; note: string }[];
  sessions: SessionSpec[];
  events: { key: string; id: string; name: string; startOffsetMin: number; durationMin: number }[];
  gates: { key: string; id: string; name: string; mode: string; event_key: string }[];
  passes: { key: string; label: string; note: string; event_key: string; participant_id: string; credential_id: string; expect: string }[];
}

/** Mailer used while seeding: messages are discarded, and "bounce" addresses fail (to demo retries). */
class SeedMailer implements Mailer {
  async send(m: MailMessage) {
    if (m.to.startsWith('bounce')) throw new Error(`550 5.1.1 Mailbox ${m.to} does not exist`);
  }
}

/** Clock that can be pinned to a past moment so history looks realistic. */
class SeedClock implements Clock {
  private pinned: Date | null = null;
  now() {
    return this.pinned ? new Date(this.pinned) : new Date();
  }
  at(minutesFromNow: number) {
    this.pinned = new Date(Date.now() + minutesFromNow * 60_000);
  }
  release() {
    this.pinned = null;
  }
}

export async function demoFixtures(q: Queryable): Promise<DemoFixtures | null> {
  try {
    const { rows } = await q.query<{ value: DemoFixtures }>(`SELECT value FROM demo_fixtures WHERE key = 'demo'`);
    return rows[0]?.value ?? null;
  } catch {
    return null; // table not created: not seeded
  }
}

const sessionTimes = (s: SessionSpec, now = Date.now()) => {
  const start = new Date(now + s.startOffsetMin * 60_000);
  return {
    start,
    end: new Date(start.getTime() + s.durationMin * 60_000),
    opens: new Date(start.getTime() - s.opensBeforeMin * 60_000),
    closes: new Date(start.getTime() + s.closesAfterMin * 60_000),
  };
};

function statusFor(s: SessionSpec, t: ReturnType<typeof sessionTimes>, now = new Date()) {
  if (s.cancelled) return 'CANCELLED';
  if (t.closes <= now) return 'CLOSED';
  return t.opens <= now ? 'OPEN' : 'SCHEDULED';
}

export async function seedDemo(baseCtx: AppContext): Promise<DemoFixtures> {
  const clock = new SeedClock();
  const ctx: AppContext = { ...baseCtx, clock, mailer: new SeedMailer() };
  const db = ctx.db;
  await db.exec(`CREATE TABLE IF NOT EXISTS demo_fixtures (key text PRIMARY KEY, value jsonb NOT NULL)`);
  if (await demoFixtures(db)) throw new Error('Demo data already exists. Use --reset to start over.');

  const fx: DemoFixtures = { seeded_at: new Date().toISOString(), accounts: {}, venues: [], sessions: [], events: [], gates: [], passes: [] };
  const hash = await hashPassword(DEMO_PASSWORD);
  const users: Record<string, AuthUser> = {};

  // ---- Accounts --------------------------------------------------------------
  for (const a of DEMO_ACCOUNTS) {
    const { rows } = await db.query<AuthUser>(
      `INSERT INTO volunteers (volunteer_code, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, volunteer_code, name, email, role, status`,
      [generateVolunteerCode(), a.name, a.email, hash, a.role],
    );
    users[a.key] = rows[0];
    fx.accounts[a.key] = rows[0].id;
  }
  const extras: string[] = [];
  for (const name of EXTRA_VOLUNTEERS) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO volunteers (volunteer_code, name, email, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
      [generateVolunteerCode(), name, `${slug(name)}@demo.org`, hash],
    );
    extras.push(rows[0].id);
  }
  const admin = users.admin;

  // ---- Volunteer attendance: venues, sessions, history ------------------------
  const venue = async (key: string, name: string, address: string, note: string) => {
    const result = await db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO locations (name, address, timezone) VALUES ($1,$2,$3) RETURNING id`,
        [name, address, TZ],
      );
      const qr = await issueQrCode(tx, rows[0].id, admin.id, new Date());
      return { id: rows[0].id, qr };
    });
    fx.venues.push({ key, id: result.id, name, qr_id: result.qr.id, public_identifier: result.qr.public_identifier, note });
    return result.id;
  };
  // The organisation's two centres. Tagore: two overlapping open sessions (volunteer
  // picks one). Amber: a single open session (preselected) — also the venue used by
  // the "Weekly check-in" presenter demo.
  const tagore = await venue('tagore', 'Science of the Soul – Tagore', '', 'Two overlapping open sessions → volunteer picks one');
  const amber = await venue('amber', 'Science of the Soul – Amber', '', 'One open session → preselected');

  const session = async (
    locationId: string,
    title: string,
    description: string,
    spec: Omit<SessionSpec, 'id'>,
    keepForRefresh = true,
  ) => {
    const t = sessionTimes(spec as SessionSpec);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO sessions (location_id, title, description, start_at, end_at, checkin_opens_at, checkin_closes_at, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [locationId, title, description, t.start, t.end, t.opens, t.closes, statusFor(spec as SessionSpec, t), admin.id],
    );
    if (keepForRefresh) fx.sessions.push({ id: rows[0].id, ...spec });
    return { id: rows[0].id, ...t };
  };
  const attend = async (sessionId: string, volunteerId: string, at: Date, source: 'QR' | 'ADMIN' = 'QR') => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO attendance_records (session_id, volunteer_id, tapped_in_at, source, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$3,$3) RETURNING id`,
      [sessionId, volunteerId, at, source, source === 'ADMIN' ? admin.id : volunteerId],
    );
    return rows[0].id;
  };
  const minutes = (base: Date, m: number) => new Date(base.getTime() + m * 60_000);

  // Live: wide windows so the demo stays valid for a few hours after seeding.
  const live = { opensBeforeMin: 45, closesAfterMin: 180 };
  // Only the organisation's recurring sessions: Wednesday, Saturday and Sunday Seva.
  // Today's live sessions keep these names whatever weekday the demo runs on, so
  // something is always open to scan; past history sits on real Wed/Sat/Sun dates.
  const wednesdaySeva = await session(tagore, 'Wednesday Seva', 'Kitchen & langar service. Main hall.', { startOffsetMin: -10, durationMin: 150, ...live });
  await session(tagore, 'Sunday Seva', 'Cleaning & setup. Room 2.', { startOffsetMin: 5, durationMin: 120, ...live });
  await session(tagore, 'Saturday Seva', 'Evening shift — sorting donations.', { startOffsetMin: 300, durationMin: 120, opensBeforeMin: 15, closesAfterMin: 60 });
  await session(amber, 'Saturday Seva', 'Parking & traffic marshals.', { startOffsetMin: -5, durationMin: 150, ...live });
  const morningSeva = await session(amber, 'Sunday Seva', 'Morning shift.', { startOffsetMin: -360, durationMin: 120, opensBeforeMin: 15, closesAfterMin: 60 });
  await session(amber, 'Wednesday Seva', 'Cancelled due to weather.', { startOffsetMin: 60, durationMin: 90, opensBeforeMin: 15, closesAfterMin: 60, cancelled: true });

  await attend(wednesdaySeva.id, users.tom.id, minutes(wednesdaySeva.start, -2));
  for (const [i, v] of extras.slice(0, 4).entries()) await attend(wednesdaySeva.id, v, minutes(wednesdaySeva.start, -8 + i));
  for (const [i, v] of [users.mei.id, ...extras.slice(2, 8)].entries()) await attend(morningSeva.id, v, minutes(morningSeva.start, -10 + i * 3));

  // History: every Wednesday, Saturday and Sunday of the last three weeks, 09:00 local
  // (volunteer history page, CSV exports).
  const today = DateTime.now().setZone(TZ).startOf('day');
  const venues = [tagore, amber];
  for (let back = 1, n = 0; back <= 21; back++) {
    const day = today.minus({ days: back }).set({ hour: 9 });
    if (![3, 6, 7].includes(day.weekday)) continue; // Wed, Sat, Sun
    const offset = Math.round((day.toMillis() - Date.now()) / 60_000);
    const past = await session(venues[n % 2], `${day.toFormat('cccc')} Seva`, '', { startOffsetMin: offset, durationMin: 180, opensBeforeMin: 15, closesAfterMin: 60 }, false);
    const people = [users.mei.id, users.tom.id, ...extras.slice(n % 5, (n % 5) + 5)];
    for (const [i, v] of people.entries()) await attend(past.id, v, minutes(past.start, -12 + i * 2));
    n++;
  }

  // A corrected record (audited) on this morning's Sunday Seva.
  const late = await attend(morningSeva.id, extras[9], minutes(morningSeva.start, 55));
  clock.at(-30);
  await adminCorrectAttendance(ctx, admin.id, late, {
    tappedInAt: minutes(morningSeva.start, 2),
    reason: 'Arrived on time but phone battery died; scanned later at the desk',
  });
  clock.release();

  // ---- Events ------------------------------------------------------------------
  const createEvent = async (key: string, f: Record<string, unknown>, startOffsetMin: number, durationMin: number) => {
    const starts = new Date(Date.now() + startOffsetMin * 60_000);
    const ends = new Date(starts.getTime() + durationMin * 60_000);
    const cols = { timezone: TZ, status: 'ACTIVE', created_by: admin.id, starts_at: starts, ends_at: ends, ...f };
    const names = Object.keys(cols);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO events (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(cols),
    );
    fx.events.push({ key, id: rows[0].id, name: String(f.name), startOffsetMin, durationMin });
    return rows[0].id;
  };
  const gate = async (eventKey: string, eventId: string, key: string, name: string, mode: 'ENTRY' | 'EXIT', where = '') => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO event_gates (event_id, name, mode, location_description) VALUES ($1,$2,$3,$4) RETURNING id`,
      [eventId, name, mode, where],
    );
    fx.gates.push({ key, id: rows[0].id, name, mode, event_key: eventKey });
    return rows[0].id;
  };
  const participantByName = async (eventId: string, name: string) =>
    (await db.query<{ id: string }>('SELECT id FROM event_participants WHERE event_id = $1 AND name = $2', [eventId, name])).rows[0].id;

  // 1) Planned visits: imported list, printed passes, entry/exit/re-entry.
  const summit = await createEvent(
    'summit',
    {
      name: 'Global Youth Summit 2026',
      description: 'Three-day international summit. Participants list supplied by organisers.',
      venue_text: 'Marina Expo Centre, Hall B',
      reentry_enabled: true,
      capacity: 4000,
      instructions: 'Bring photo ID. Gates open 08:00 daily.',
    },
    -120,
    3 * 24 * 60,
  );
  const csv = [
    'Full Name,Country,Email',
    ...SUMMIT_PEOPLE.map(([n, c]) => `${n.includes(',') ? `"${n}"` : n},${c},${slug(n)}@summit.example`),
    'Bounce Tester,Chile,bounce@summit.example',
    'No Email Person,Chile,',
    'Hiroshi Tanaka,Japan,hiroshi.tanaka@summit.example',
  ].join('\n');
  clock.at(-3 * 24 * 60);
  await commitImport(ctx, users.events.id, summit, { text: csv, filename: 'summit-participants.csv', existingPolicy: 'SKIP' });

  const { rows: summitPeople } = await db.query<{ id: string; event_id: string; name: string }>(
    `SELECT id, event_id, name FROM event_participants WHERE event_id = $1 ORDER BY registered_at, name`,
    [summit],
  );
  const tokens: Record<string, { token: string; credentialId: string }> = {};
  clock.at(-2 * 24 * 60);
  await db.transaction(async (tx) => {
    for (const p of summitPeople) {
      const issued = await issueCredential(tx, ctx.config, p, users.events.id, clock.now());
      tokens[p.name] = { token: issued.token, credentialId: issued.credential.id };
      await queueDelivery(tx, p, issued.credential.id, users.events.id, clock.now());
    }
  });
  await processDeliveries(ctx);

  const north = await gate('summit', summit, 'participant-entry', 'Participant entry', 'ENTRY', 'Main doors');
  const northExit = await gate('summit', summit, 'participant-exit', 'Participant exit', 'EXIT', 'Main doors');
  const vip = await gate('summit', summit, 'volunteer-entry', 'Event volunteer entry', 'ENTRY', 'Side door');
  const volunteerExit = await gate('summit', summit, 'volunteer-exit', 'Event volunteer exit', 'EXIT', 'Side door');
  for (const g of [north, northExit, vip, volunteerExit]) {
    await db.query('INSERT INTO event_gate_operators (gate_id, operator_id) VALUES ($1, $2)', [g, users.gate.id]);
  }

  // Sofia lost her pass yesterday: replaced at the desk (old pass now revoked).
  const sofiaId = await participantByName(summit, 'Sofia Rossi');
  clock.at(-20 * 60);
  const sofiaOld = tokens['Sofia Rossi'];
  const sofiaNew = await db.transaction((tx) =>
    issueCredential(tx, ctx.config, { id: sofiaId, event_id: summit }, users.desk.id, clock.now(), 'Lost pass — identity verified with passport'),
  );

  // Morning arrivals (everyone except Amara and a few others), some exits and re-entries.
  const arrivals = SUMMIT_PEOPLE.slice(1, 25).map(([n]) => n);
  for (const [i, name] of arrivals.entries()) {
    clock.at(-110 + i * 3);
    const token = name === 'Sofia Rossi' ? sofiaNew.token : tokens[name].token;
    await gateScan(ctx, i % 6 === 0 ? users.admin : users.gate, { gateId: i % 6 === 0 ? vip : north, scanned: token, idempotencyKey: null });
  }
  clock.at(-35);
  await gateScan(ctx, users.gate, { gateId: north, scanned: tokens['Lucas Silva'].token, idempotencyKey: null }); // duplicate entry → rejected
  await gateScan(ctx, users.gate, { gateId: north, scanned: sofiaOld.token, idempotencyKey: null }); // old pass → rejected
  for (const [i, name] of ['Hiroshi Tanaka', 'Aisha Rahman', 'Mateo García', 'Chloé Dubois'].entries()) {
    clock.at(-30 + i * 2);
    await gateScan(ctx, users.desk, { gateId: i === 3 ? volunteerExit : northExit, scanned: tokens[name].token, idempotencyKey: null });
  }
  clock.at(-10);
  await gateScan(ctx, users.gate, { gateId: north, scanned: tokens['Mateo García'].token, idempotencyKey: null }); // re-entry
  clock.release();

  const amaraId = await participantByName(summit, 'Amara Okafor');
  const lucasId = await participantByName(summit, 'Lucas Silva');
  const hiroshiId = await participantByName(summit, 'Hiroshi Tanaka');
  fx.passes.push(
    { key: 'amara', label: 'Amara Okafor — valid pass, outside', note: 'Scan at Participant entry → ENTRY OK. Scan again → ALREADY INSIDE.', event_key: 'summit', participant_id: amaraId, credential_id: tokens['Amara Okafor'].credentialId, expect: 'ENTRY OK' },
    { key: 'lucas', label: 'Lucas Silva — valid pass, inside', note: 'Scan at Participant entry → STOP (already inside). Scan at Participant exit → EXIT OK, then entry works again.', event_key: 'summit', participant_id: lucasId, credential_id: tokens['Lucas Silva'].credentialId, expect: 'STOP — already inside' },
    { key: 'hiroshi', label: 'Hiroshi Tanaka — exited earlier', note: 'Scan at Participant entry → re-entry accepted with the same pass.', event_key: 'summit', participant_id: hiroshiId, credential_id: tokens['Hiroshi Tanaka'].credentialId, expect: 'ENTRY OK (re-entry)' },
    { key: 'sofia-old', label: 'Sofia Rossi — OLD pass (replaced)', note: 'Scan anywhere → STOP: revoked. Her replacement pass works.', event_key: 'summit', participant_id: sofiaId, credential_id: sofiaOld.credentialId, expect: 'STOP — revoked' },
  );

  // 2) Surprise visits (Science of the Soul, Amber Road): online registrations + walk-ins, single check-in.
  const fair = await createEvent(
    'fair',
    {
      name: 'Science of the Soul',
      description: 'Talks and meditation, open to everyone — register online or just walk in.',
      venue_text: 'Amber Road',
      reentry_enabled: false,
      advance_registration_enabled: true,
      walk_ins_enabled: true,
      contact_requirement: 'EMAIL_OR_PHONE',
      capacity: 300,
      instructions: 'Show this pass at the Fast lane. No pass? Visit the Walk-in desk.',
    },
    -60,
    8 * 60,
  );
  const fairGate = await gate('fair', fair, 'fair-lane', 'Fast lane', 'ENTRY', 'Atrium entrance');
  const fairOnline: [string, string | null, string | null][] = [
    ['Rachel Goh', 'rachel.goh@example.com', null], ['Kumar Selvam', 'kumar@example.com', null], ['Linda Chua', null, '+65 9123 4501'],
    ['Wei Ling Ho', 'weiling@example.com', null], ['Ravi Shankar', 'ravi.s@example.com', null], ['Nur Aisyah', null, '+65 9123 4502'],
    ['Peter Lim', 'peter.lim@example.com', null], ['Grace Yeo', 'grace.yeo@example.com', null], ['Samuel Tan', 'sam.tan@example.com', null],
    ['Joyce Ong', 'joyce@example.com', '+65 9123 4503'], ['Hamid Yusof', 'hamid@example.com', null], ['Anita Kaur', 'anita.k@example.com', null],
  ];
  const fairTokens: Record<string, string> = {};
  for (const [i, [name, email, phone]] of fairOnline.entries()) {
    clock.at(-5 * 24 * 60 + i * 300);
    const r = await registerOnline(ctx, fair, { name, email, phone, country: 'Singapore' });
    if (r.pass) fairTokens[name] = r.pass.pass_url;
  }
  for (const [i, name] of ['Rachel Goh', 'Kumar Selvam', 'Linda Chua', 'Wei Ling Ho', 'Ravi Shankar', 'Peter Lim'].entries()) {
    clock.at(-50 + i * 4);
    await gateScan(ctx, users.desk, { gateId: fairGate, scanned: fairTokens[name], idempotencyKey: null });
  }
  for (const [i, w] of [
    { name: 'Mdm Tan Ah Lian', country: 'Singapore', contactUnavailable: true },
    { name: 'Benjamin Cho', email: 'ben.cho@example.com', contactUnavailable: false },
    { name: 'Siew Mei Lau', phone: '+65 9123 4510', contactUnavailable: false },
  ].entries()) {
    clock.at(-40 + i * 6);
    const r = await registerWalkIn(ctx, users.desk.id, fair, { ...w, confirmNew: true, sendEmail: false });
    await staffAccess(ctx, users.desk, { eventId: fair, participantId: r.participant.id, direction: 'IN', override: false, reason: null, idempotencyKey: null });
  }
  clock.release();
  const fairPeter = await participantByName(fair, 'Peter Lim');
  const fairGrace = await participantByName(fair, 'Grace Yeo');
  const credOf = async (pid: string) =>
    (await db.query<{ id: string }>(`SELECT id FROM event_credentials WHERE participant_id = $1 AND status = 'ACTIVE'`, [pid])).rows[0].id;
  fx.passes.push(
    { key: 'fair-grace', label: 'Grace Yeo — registered online, not checked in', note: 'Scan at Fast lane → CHECKED IN. Scan again → already checked in (not counted twice).', event_key: 'fair', participant_id: fairGrace, credential_id: await credOf(fairGrace), expect: 'CHECKED IN' },
    { key: 'fair-peter', label: 'Peter Lim — Science of the Soul pass', note: 'Scan at the Planned-visits Participant entry → STOP: pass is for a different event.', event_key: 'fair', participant_id: fairPeter, credential_id: await credOf(fairPeter), expect: 'STOP — wrong event (at Planned-visits gates)' },
  );

  // 3) Awards night: mandatory in-person photo ID check.
  const awards = await createEvent(
    'awards',
    {
      name: 'Volunteer Awards Night',
      description: 'Invitation-only ceremony. Photo ID is checked at the door.',
      venue_text: 'Civic Centre Auditorium',
      reentry_enabled: false,
      advance_registration_enabled: true,
      walk_ins_enabled: false,
      contact_requirement: 'EMAIL',
      verification_policy: 'IN_PERSON_ID_CHECK',
      id_check_mode: 'MANDATORY',
      capacity: 120,
    },
    -30,
    5 * 60,
  );
  const awardsGate = await gate('awards', awards, 'awards-door', 'Main door', 'ENTRY');
  const awardTokens: Record<string, string> = {};
  for (const [name, email] of [['Grace Lim', 'grace.lim@example.com'], ['Henry Pang', 'henry@example.com'], ['Irene Sim', 'irene@example.com'], ['Joseph Wee', 'joseph@example.com']]) {
    clock.at(-3 * 24 * 60);
    const r = await registerOnline(ctx, awards, { name, email, country: 'Singapore' });
    awardTokens[name] = r.pass!.pass_url;
  }
  clock.at(-20);
  const henryId = await participantByName(awards, 'Henry Pang');
  await recordStaffVerification(ctx, users.desk.id, awards, henryId, { kind: 'ID', outcome: 'CHECKED', reason: null });
  await gateScan(ctx, users.desk, { gateId: awardsGate, scanned: awardTokens['Henry Pang'], idempotencyKey: null });
  clock.release();
  const graceLim = await participantByName(awards, 'Grace Lim');
  fx.passes.push({
    key: 'awards-grace',
    label: 'Grace Lim — awards invitation, ID not yet checked',
    note: 'Scan at Awards “Main door” → STOP: photo ID check required. Click “ID matches — admit” → CHECKED IN.',
    event_key: 'awards',
    participant_id: graceLim,
    credential_id: await credOf(graceLim),
    expect: 'STOP — ID check required',
  });

  // 4) Workshop: contact (email code) verification before a pass is issued.
  const workshop = await createEvent(
    'workshop',
    {
      name: 'Volunteer Leaders Workshop',
      description: 'Half-day training for team leads. Register online — we email you a code to confirm your address.',
      venue_text: 'Online registration demo',
      reentry_enabled: false,
      advance_registration_enabled: true,
      walk_ins_enabled: false,
      contact_requirement: 'EMAIL',
      verification_policy: 'CONTACT_VERIFIED',
      capacity: 40,
    },
    7 * 24 * 60,
    4 * 60,
  );
  clock.at(-2 * 24 * 60);
  await registerOnline(ctx, workshop, { name: 'Kelvin Ang', email: 'kelvin@example.com', country: 'Singapore' });
  clock.release();
  await gate('workshop', workshop, 'workshop-door', 'Registration table', 'ENTRY');
  await processDeliveries(ctx);

  await db.query(`INSERT INTO demo_fixtures (key, value) VALUES ('demo', $1)`, [JSON.stringify(fx)]);
  return fx;
}

/** Re-centre demo sessions and events on "now" so live parts of the demo are open again. */
export async function refreshDemoTimes(ctx: AppContext): Promise<{ sessions: number; events: number }> {
  const fx = await demoFixtures(ctx.db);
  if (!fx) throw new Error('Demo data has not been seeded.');
  const now = new Date();
  await ctx.db.transaction(async (tx) => {
    for (const s of fx.sessions) {
      const t = sessionTimes(s, now.getTime());
      await tx.query(
        `UPDATE sessions SET start_at=$2, end_at=$3, checkin_opens_at=$4, checkin_closes_at=$5, status=$6, updated_at=$7 WHERE id=$1`,
        [s.id, t.start, t.end, t.opens, t.closes, statusFor(s, t, now), now],
      );
    }
    for (const e of fx.events) {
      const starts = new Date(now.getTime() + e.startOffsetMin * 60_000);
      await tx.query(`UPDATE events SET starts_at=$2, ends_at=$3, status='ACTIVE', updated_at=$4 WHERE id=$1`, [
        e.id, starts, new Date(starts.getTime() + e.durationMin * 60_000), now,
      ]);
    }
    await tx.query(`UPDATE demo_fixtures SET value = jsonb_set(value, '{refreshed_at}', to_jsonb($1::text)) WHERE key = 'demo'`, [now.toISOString()]);
  });
  return { sessions: fx.sessions.length, events: fx.events.length };
}
