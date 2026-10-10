import { loadConfig } from '../config.js';
import { connectDatabase } from '../db.js';
import { runMigrations } from '../migrate.js';

const config = loadConfig();
const db = await connectDatabase(config);
try {
  const applied = await runMigrations(db);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
} finally {
  await db.close();
}
