/**
 * Create an administrator, or promote an existing account.
 *
 *   npm run create-admin -- --email admin@example.org --name "Admin" --password "s3cret-pass"
 *
 * Values may also come from ADMIN_EMAIL / ADMIN_NAME / ADMIN_PASSWORD.
 */
import { parseArgs } from 'node:util';
import { generateVolunteerCode, hashPassword } from '../auth.js';
import { loadConfig } from '../config.js';
import { connectDatabase } from '../db.js';
import { runMigrations } from '../migrate.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    password: { type: 'string' },
  },
});
const email = (values.email ?? process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const name = (values.name ?? process.env.ADMIN_NAME ?? 'Administrator').trim();
const password = values.password ?? process.env.ADMIN_PASSWORD ?? '';

if (!email) {
  console.error('An --email is required.');
  process.exit(1);
}

const config = loadConfig();
const db = await connectDatabase(config);
try {
  if (!config.databaseUrl) await runMigrations(db);
  const { rows } = await db.query<{ id: string }>('SELECT id FROM volunteers WHERE lower(email) = $1', [email]);
  if (rows[0]) {
    await db.query(`UPDATE volunteers SET role = 'ADMIN', status = 'ACTIVE', updated_at = now() WHERE id = $1`, [rows[0].id]);
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, after_data, reason)
       VALUES (NULL, 'volunteer.promote', 'volunteer', $1, '{"role":"ADMIN"}', 'create-admin script')`,
      [rows[0].id],
    );
    console.log(`Promoted existing account ${email} to administrator.`);
  } else {
    if (password.length < 8) {
      console.error('A --password of at least 8 characters is required for a new account.');
      process.exit(1);
    }
    await db.query(
      `INSERT INTO volunteers (volunteer_code, name, email, password_hash, role) VALUES ($1, $2, $3, $4, 'ADMIN')`,
      [generateVolunteerCode(), name, email, await hashPassword(password)],
    );
    console.log(`Created administrator ${email}.`);
  }
} finally {
  await db.close();
}
