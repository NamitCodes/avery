import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { DEMO_PASSWORD, seedDemo } from '../src/server/demo/seed.js';
import { Client, createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let demo: {
  accounts: { key: string; email: string }[];
  venues: { key: string; public_identifier: string; path: string }[];
  gates: { key: string; id: string }[];
  passes: { key: string; pass_url: string; status: string }[];
  events: { key: string; id: string }[];
};

const signIn = async (key: string) => {
  const c = new Client(env.app);
  const email = demo.accounts.find((a) => a.key === key)!.email;
  const res = await c.post('/api/auth/login', { email, password: DEMO_PASSWORD });
  expect(res.status).toBe(200);
  return c;
};
const pass = (k: string) => demo.passes.find((p) => p.key === k)!.pass_url;
const gate = (k: string) => demo.gates.find((g) => g.key === k)!.id;
const venue = (k: string) => demo.venues.find((v) => v.key === k)!.public_identifier;
const scan = (c: Client, g: string, p: string) => c.post('/api/gate-scan', { gate_id: gate(g), credential: pass(p) });

beforeAll(async () => {
  // Seeding uses real "now", so the test clock is pinned to the current time.
  env = await createTestEnv(new Date().toISOString());
  env.ctx.config.demoMode = true;
  env.app = createApp(env.ctx);
  await seedDemo(env.ctx);
  const res = await request(env.app).get('/api/demo');
  expect(res.body.seeded).toBe(true);
  demo = res.body;
}, 120_000);
afterAll(() => env.close());

describe('demo data matches the demo guide', () => {
  it('exposes accounts, venues, gates and sample passes', () => {
    expect(demo.accounts).toHaveLength(7);
    expect(demo.venues.map((v) => v.key)).toEqual(['tagore', 'amber']);
    expect(demo.passes.map((p) => p.key)).toEqual(['amara', 'lucas', 'hiroshi', 'sofia-old', 'fair-grace', 'fair-peter', 'awards-grace']);
    expect(demo.passes.find((p) => p.key === 'sofia-old')!.status).toBe('REVOKED');
  });

  it('story A: overlapping sessions, preselected session, empty venue, idempotent rescan', async () => {
    const priya = await signIn('priya');
    expect((await priya.get(`/api/check-in/venues/${venue('tagore')}`)).body.sessions.map((s: { title: string }) => s.title)).toEqual(['Wednesday Seva', 'Sunday Seva']);
    expect((await priya.get(`/api/check-in/venues/${venue('amber')}`)).body.sessions).toHaveLength(1);

    const tom = await signIn('tom');
    const food = (await tom.get(`/api/check-in/venues/${venue('tagore')}`)).body.sessions[0];
    const again = await tom.post('/api/check-in', { venue_id: venue('tagore'), session_id: food.id });
    expect(again.body.status).toBe('ALREADY_CHECKED_IN');
  });

  it('story B: gate outcomes for each sample pass', async () => {
    const gabe = await signIn('gate');
    expect((await scan(gabe, 'participant-entry', 'amara')).body).toMatchObject({ result: 'ACCEPTED', event_type: 'ENTRY' });
    expect((await scan(gabe, 'participant-entry', 'amara')).body.code).toBe('ALREADY_INSIDE');
    expect((await scan(gabe, 'participant-entry', 'lucas')).body.code).toBe('ALREADY_INSIDE');
    expect((await scan(gabe, 'participant-entry', 'hiroshi')).body.result).toBe('ACCEPTED');
    expect((await scan(gabe, 'participant-entry', 'sofia-old')).body.code).toBe('REVOKED_CREDENTIAL');
    expect((await scan(gabe, 'participant-entry', 'fair-peter')).body.code).toBe('WRONG_EVENT');
    expect((await scan(gabe, 'fair-lane', 'lucas')).status).toBe(403); // not assigned to other events' gates

    const desk = await signIn('desk');
    expect((await scan(desk, 'participant-exit', 'lucas')).body.result).toBe('ACCEPTED');

    const events = await signIn('events');
    const summit = demo.events.find((e) => e.key === 'summit')!.id;
    const occ = (await events.get(`/api/admin/events/${summit}/occupancy`)).body;
    expect(occ.reconciliation.mismatched_participants).toBe(0);
    expect(occ.inside).toBeGreaterThan(15);
    const failed = (await events.get(`/api/admin/events/${summit}/deliveries?status=FAILED`)).body.deliveries;
    expect(failed).toHaveLength(1);
  });

  it('story C: fast lane counts once; ID check required at the awards door', async () => {
    const desk = await signIn('desk');
    expect((await scan(desk, 'fair-lane', 'fair-grace')).body).toMatchObject({ result: 'ACCEPTED', event_type: 'CHECK_IN' });
    expect((await scan(desk, 'fair-lane', 'fair-grace')).body.code).toBe('ALREADY_CHECKED_IN');
    expect((await scan(desk, 'awards-door', 'awards-grace')).body.code).toBe('ID_CHECK_REQUIRED');
  });

  it('sample import CSV and refresh are available; outbox is readable', async () => {
    const csv = await request(env.app).get('/api/demo/sample-import.csv');
    expect(csv.text).toContain('Valentina Rojas');
    expect((await request(env.app).get('/api/demo/outbox')).status).toBe(200);
    expect((await (await signIn('priya')).post('/api/demo/refresh')).status).toBe(403);
    const r = await (await signIn('admin')).post('/api/demo/refresh');
    expect(r.body.sessions).toBeGreaterThan(0);
  });

  it('reset: admin only; wipes changes, reloads demo data, and ends the old session', async () => {
    const priya = await signIn('priya');
    expect((await priya.post('/api/demo/reset')).status).toBe(403);

    // Make a change that the reset must undo.
    const admin = await signIn('admin');
    const created = await admin.post('/api/admin/locations', { name: 'Temporary venue', timezone: 'Asia/Singapore' });
    expect(created.status).toBe(201);

    const res = await admin.post('/api/demo/reset');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Accounts were recreated, so the old admin session no longer works.
    expect((await admin.get('/api/auth/me')).status).toBe(401);

    demo = (await request(env.app).get('/api/demo')).body;
    const fresh = await signIn('admin');
    const names = (await fresh.get('/api/admin/locations')).body.locations.map((l: { name: string }) => l.name);
    expect(names).toEqual(['Science of the Soul – Amber', 'Science of the Soul – Tagore']);
    expect((await fresh.get('/api/admin/events')).body.events).toHaveLength(4);
  });

  it('demo endpoints do not exist outside demo mode', async () => {
    const plain = createApp({ ...env.ctx, config: { ...env.ctx.config, demoMode: false } });
    expect((await request(plain).get('/api/demo')).status).toBe(404);
  });
});
