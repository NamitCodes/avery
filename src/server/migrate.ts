import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Resolves from both src/server (tsx) and dist/server (compiled).
export const MIGRATIONS_DIR = path.resolve(here, '../../migrations');

/** Apply pending SQL migrations in filename order. Returns the names applied. */
export async function runMigrations(db: Database, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
  const done = new Set(rows.map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    if (!/^[\w.-]+$/.test(file)) throw new Error(`Unsafe migration file name: ${file}`);
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await db.exec(`BEGIN;\n${sql}\nINSERT INTO schema_migrations (name) VALUES ('${file}');\nCOMMIT;`);
    applied.push(file);
  }
  return applied;
}
