import { createApp } from './app.js';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { connectDatabase } from './db.js';
import { createMailer } from './mailer.js';
import { demoFixtures, seedDemo } from './demo/seed.js';
import { runMigrations } from './migrate.js';
import { processDeliveries } from './services/events/deliveries.js';
import { runSessionScheduler } from './services/sessions.js';
import { applyDemoFlag } from './scripts/demo-flag.js';

async function main() {
  applyDemoFlag();
  const config = loadConfig();
  if (config.demoMode) console.log('DEMO MODE: demo guide at /demo (never use with real data).');
  const db = await connectDatabase(config);
  // Migrations are idempotent and transactional per file. Run them on start for
  // the embedded database, and for PostgreSQL unless MIGRATE_ON_START=false
  // (e.g. if you run `npm run migrate:prod` as a separate release step).
  if (!config.databaseUrl || process.env.MIGRATE_ON_START !== 'false') {
    const applied = await runMigrations(db);
    if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
  }
  if (!config.databaseUrl) {
    console.log(`Using embedded PGlite database at ${config.pgliteDataDir} (set DATABASE_URL for PostgreSQL).`);
  }
  const ctx: AppContext = { db, config, clock: systemClock, mailer: createMailer(config) };
  if (config.demoMode && !(await demoFixtures(db))) {
    console.log('Demo mode: loading demo data…');
    await seedDemo(ctx);
    console.log('Demo data loaded. Guide: %s/demo', config.publicBaseUrl);
  }
  const app = createApp(ctx);

  const tick = async () => {
    try {
      const { opened, closed } = await runSessionScheduler(ctx);
      if (opened || closed) console.log(`Scheduler: opened ${opened}, closed ${closed} session(s)`);
      // Picks up queued pass emails (e.g. after a restart) in addition to on-demand kicks.
      const { sent, failed } = await processDeliveries(ctx);
      if (sent || failed) console.log(`Pass emails: sent ${sent}, failed ${failed}`);
    } catch (err) {
      console.error('Scheduler run failed', err);
    }
  };
  await tick();
  const timer = setInterval(tick, config.schedulerIntervalSeconds * 1000);

  const server = app.listen(config.port, () => {
    console.log(`Volunteer attendance API listening on http://localhost:${config.port}`);
  });

  const shutdown = () => {
    clearInterval(timer);
    server.close(() => {
      db.close().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
