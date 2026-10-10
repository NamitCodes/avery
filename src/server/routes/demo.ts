import { Router } from 'express';
import { requireRoles } from '../auth.js';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { demoOutbox } from '../mailer.js';
import { DEMO_ACCOUNTS, DEMO_PASSWORD, demoFixtures, refreshDemoTimes } from '../demo/seed.js';
import { decryptToken, passUrl, qrDataUrl } from '../services/events/credentials.js';
import { checkInUrl } from '../services/venues.js';

/** Sample CSV for the live import demo: new rows, an already-imported person, a shared email, and invalid rows. */
const SAMPLE_IMPORT = [
  'Name,Country,Email',
  'Valentina Rojas,Colombia,valentina.rojas@summit.example',
  'Yusuf Demir,Türkiye,yusuf.demir@summit.example',
  'Aroha Ngata,New Zealand,aroha.ngata@summit.example',
  'Björn Lindqvist,Sweden,bjorn.lindqvist@summit.example',
  'Amara Okafor,Nigeria,amara.okafor@summit.example',
  'Amara O. Family,Nigeria,amara.okafor@summit.example',
  'Kofi Boateng,Ghana,not-an-email',
  'Lena Fischer,,lena.fischer@summit.example',
  'Valentina Rojas,Colombia,valentina.rojas@summit.example',
].join('\r\n');

/**
 * Demo-only endpoints (mounted only when DEMO_MODE=true): the data behind the
 * in-app demo guide. Exposes demo credentials and pass links by design.
 */
export function demoRoutes(ctx: AppContext) {
  const r = Router();

  r.get('/demo', async (_req, res) => {
    const fx = await demoFixtures(ctx.db);
    if (!fx) {
      res.json({ enabled: true, seeded: false });
      return;
    }
    const venues = await Promise.all(
      fx.venues.map(async (v) => {
        const url = checkInUrl(ctx.config, v.public_identifier);
        return { ...v, checkin_url: url, path: `/check-in/v/${v.public_identifier}`, qr_data_url: await qrDataUrl(url) };
      }),
    );
    const { rows: creds } = await ctx.db.query<{ id: string; token_ciphertext: string; status: string }>(
      'SELECT id, token_ciphertext, status FROM event_credentials WHERE id = ANY($1::uuid[])',
      [fx.passes.map((p) => p.credential_id)],
    );
    const byId = new Map(creds.map((c) => [c.id, c]));
    const passes = await Promise.all(
      fx.passes.map(async (p) => {
        const c = byId.get(p.credential_id);
        const token = c ? decryptToken(c.token_ciphertext, ctx.config.credentialKey) : '';
        const url = passUrl(ctx.config, token);
        return { ...p, status: c?.status, pass_url: url, pass_path: `/pass/${token}`, qr_data_url: await qrDataUrl(url) };
      }),
    );
    res.json({
      enabled: true,
      seeded: true,
      seeded_at: fx.seeded_at,
      refreshed_at: (fx as { refreshed_at?: string }).refreshed_at ?? null,
      password: DEMO_PASSWORD,
      accounts: DEMO_ACCOUNTS.map((a) => ({ ...a, id: fx.accounts[a.key] })),
      venues,
      events: fx.events.map((e) => ({ key: e.key, id: e.id, name: e.name })),
      gates: fx.gates,
      passes,
      public_base_url: ctx.config.publicBaseUrl,
    });
  });

  r.get('/demo/outbox', (_req, res) => {
    res.json({ messages: demoOutbox.messages });
  });

  r.get('/demo/sample-import.csv', (_req, res) => {
    res.attachment('sample-participants.csv').type('text/csv; charset=utf-8').send(`${SAMPLE_IMPORT}\r\n`);
  });

  r.post('/demo/refresh', requireRoles(['ADMIN']), async (_req, res) => {
    if (!(await demoFixtures(ctx.db))) throw notFound('NOT_SEEDED', 'Demo data has not been seeded.');
    res.json(await refreshDemoTimes(ctx));
  });

  return r;
}
