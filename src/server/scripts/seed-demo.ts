/**
 * Load demo data for presentations.
 *
 *   npm run seed:demo            seed (fails if already seeded)
 *   npm run seed:demo -- --reset wipe the embedded demo database first
 *   npm run demo                 reset + seed + start API and web with the demo guide
 */
import fs from 'node:fs';
import { systemClock } from '../clock.js';
import { loadConfig } from '../config.js';
import { connectDatabase } from '../db.js';
import { DEMO_ACCOUNTS, DEMO_PASSWORD, demoFixtures, seedDemo } from '../demo/seed.js';
import { createMailer } from '../mailer.js';
import { runMigrations } from '../migrate.js';
import { applyDemoFlag } from './demo-flag.js';

applyDemoFlag();
const config = loadConfig();
const reset = process.argv.includes('--reset');

if (reset) {
  if (config.databaseUrl) {
    console.error('--reset only wipes the embedded demo database. Refusing to touch DATABASE_URL; use a fresh database instead.');
    process.exit(1);
  }
  if (config.pgliteDataDir && fs.existsSync(config.pgliteDataDir)) {
    fs.rmSync(config.pgliteDataDir, { recursive: true, force: true });
    console.log(`Removed ${config.pgliteDataDir}`);
  }
}

const db = await connectDatabase(config);
try {
  await runMigrations(db);
  if (await demoFixtures(db)) {
    console.log('Demo data already present (use --reset to start over).');
  } else {
    const started = Date.now();
    await seedDemo({ db, config, clock: systemClock, mailer: createMailer(config) });
    console.log(`Demo data seeded in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  }
  console.log('\nDemo accounts (password for all: %s)', DEMO_PASSWORD);
  for (const a of DEMO_ACCOUNTS) console.log(`  ${a.email.padEnd(18)} ${a.label}`);
  console.log(`\nOpen ${config.publicBaseUrl}/demo for the step-by-step demo guide.`);
} finally {
  await db.close();
}
