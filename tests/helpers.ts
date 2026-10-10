import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/server/app.js';
import { generateVolunteerCode, hashPassword } from '../src/server/auth.js';
import { loadConfig } from '../src/server/config.js';
import type { AppContext } from '../src/server/context.js';
import pg from 'pg';
import { createPgDatabase, createPgliteDatabase, type Database } from '../src/server/db.js';
import { MemoryMailer } from '../src/server/mailer.js';
import { runMigrations } from '../src/server/migrate.js';

export class FakeClock {
  constructor(private t: Date) {}
  now() {
    return new Date(this.t);
  }
  set(iso: string) {
    this.t = new Date(iso);
  }
  advance(minutes: number) {
    this.t = new Date(this.t.getTime() + minutes * 60_000);
  }
}

export interface TestEnv {
  ctx: AppContext;
  app: Express;
  clock: FakeClock;
  mailer: MemoryMailer;
  close(): Promise<void>;
}

/**
 * Fresh database with migrations applied: in-memory PGlite by default, or a new
 * throwaway database on a real PostgreSQL server when TEST_DATABASE_URL is set
 * (e.g. postgres://postgres@localhost:5432/postgres).
 */
async function freshDatabase(): Promise<{ db: Database; drop(): Promise<void> }> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    const db = await createPgliteDatabase();
    return { db, drop: () => db.close() };
  }
  const name = `att_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const db = createPgDatabase(url.toString());
  return {
    db,
    async drop() {
      await db.close();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export async function createTestEnv(start = '2026-10-10T01:00:00Z'): Promise<TestEnv> {
  const { db, drop } = await freshDatabase();
  await runMigrations(db);
  const config = loadConfig({ NODE_ENV: 'test', DEFAULT_TIMEZONE: 'Asia/Singapore', PUBLIC_BASE_URL: 'https://att.example.org' });
  config.rateLimitEnabled = false;
  config.runJobsInBackground = false;
  const clock = new FakeClock(new Date(start));
  const mailer = new MemoryMailer();
  const ctx: AppContext = { db, config, clock, mailer };
  return { ctx, app: createApp(ctx), clock, mailer, close: drop };
}

/** A logged-in HTTP client that sends the CSRF header on every request. */
export class Client {
  readonly agent: ReturnType<typeof request.agent>;
  user!: { id: string; volunteer_code: string; name: string; email: string; role: string; status: string };

  constructor(app: Express) {
    this.agent = request.agent(app);
  }
  get(url: string) {
    return this.agent.get(url);
  }
  post(url: string, body?: object) {
    return this.agent.post(url).set('X-Requested-With', 'fetch').send(body ?? {});
  }
  patch(url: string, body?: object) {
    return this.agent.patch(url).set('X-Requested-With', 'fetch').send(body ?? {});
  }
}

let seq = 0;

export async function registerVolunteer(env: TestEnv, name = 'Vol'): Promise<Client> {
  const c = new Client(env.app);
  const email = `vol${++seq}-${Date.now()}@example.org`;
  const res = await c.post('/api/auth/register', { name: `${name} ${seq}`, email, password: 'password123' });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  c.user = res.body.user;
  return c;
}

export async function loginAdmin(env: TestEnv, role = 'ADMIN'): Promise<Client> {
  const email = `${role.toLowerCase()}${++seq}@example.org`;
  await env.ctx.db.query(
    `INSERT INTO volunteers (volunteer_code, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)`,
    [generateVolunteerCode(), `${role} ${seq}`, email, await hashPassword('adminpass123'), role],
  );
  const c = new Client(env.app);
  const res = await c.post('/api/auth/login', { email, password: 'adminpass123' });
  if (res.status !== 200) throw new Error(`admin login failed: ${res.status}`);
  c.user = res.body.user;
  return c;
}

export async function createVenue(admin: Client, name = 'Science of the Soul – Tagore') {
  const res = await admin.post('/api/admin/locations', { name, address: '1 Main St', timezone: 'Asia/Singapore' });
  if (res.status !== 201) throw new Error(`create venue failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.location as { id: string; name: string; active_qr: { id: string; public_identifier: string; url: string } };
}

/**
 * Create a session. Times are naive local (Asia/Singapore, UTC+8) strings.
 * Default clock start 2026-10-10T01:00Z == 09:00 SGT.
 */
export async function createSession(
  admin: Client,
  locationId: string,
  opts: { title?: string; start?: string; end?: string; opens?: string; closes?: string; publish?: boolean } = {},
) {
  const res = await admin.post('/api/admin/sessions', {
    location_id: locationId,
    title: opts.title ?? 'Sunday Seva',
    start_at: opts.start ?? '2026-10-10T09:00',
    end_at: opts.end ?? '2026-10-10T12:00',
    checkin_opens_at: opts.opens,
    checkin_closes_at: opts.closes,
    publish: opts.publish ?? true,
  });
  if (res.status !== 201) throw new Error(`create session failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.session as { id: string; status: string; checkin_opens_at: string; checkin_closes_at: string };
}

export async function countAttendance(env: TestEnv, sessionId?: string): Promise<number> {
  const { rows } = await env.ctx.db.query<{ n: number }>(
    sessionId
      ? 'SELECT count(*)::int AS n FROM attendance_records WHERE session_id = $1'
      : 'SELECT count(*)::int AS n FROM attendance_records',
    sessionId ? [sessionId] : [],
  );
  return rows[0].n;
}
