import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  clearSession,
  generateVolunteerCode,
  hashPassword,
  issueSession,
  requireAuth,
  USER_COLUMNS,
  verifyPassword,
  type AuthUser,
} from '../auth.js';
import type { AppContext } from '../context.js';
import { isUniqueViolation } from '../db.js';
import { AppError, conflict } from '../errors.js';

const registerBody = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(200),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(320),
  password: z.string().min(8, 'Password must be at least 8 characters.').max(200),
});

const loginBody = z.object({
  email: z.string().trim().toLowerCase().max(320),
  password: z.string().max(200),
});

export function authRoutes(ctx: AppContext, loginLimiter: RequestHandler) {
  const r = Router();

  r.post('/auth/register', loginLimiter, async (req, res) => {
    const body = registerBody.parse(req.body);
    const passwordHash = await hashPassword(body.password);
    const now = ctx.clock.now();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { rows } = await ctx.db.query<AuthUser>(
          `INSERT INTO volunteers (volunteer_code, name, email, password_hash, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $5) RETURNING ${USER_COLUMNS}`,
          [generateVolunteerCode(), body.name, body.email, passwordHash, now],
        );
        issueSession(ctx, res, rows[0].id);
        res.status(201).json({ user: rows[0] });
        return;
      } catch (err) {
        if (isUniqueViolation(err, 'volunteers_email_uq')) {
          throw conflict('EMAIL_TAKEN', 'An account with this email already exists. Please sign in instead.');
        }
        if (!isUniqueViolation(err, 'volunteers_volunteer_code_key')) throw err;
        // Volunteer code collision: retry with a new code.
      }
    }
    throw new Error('Could not allocate a unique volunteer code');
  });

  r.post('/auth/login', loginLimiter, async (req, res) => {
    const body = loginBody.parse(req.body);
    const { rows } = await ctx.db.query<AuthUser & { password_hash: string }>(
      `SELECT ${USER_COLUMNS}, password_hash FROM volunteers WHERE lower(email) = $1`,
      [body.email],
    );
    const row = rows[0];
    if (!row || !(await verifyPassword(body.password, row.password_hash))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');
    }
    const user: AuthUser = { id: row.id, volunteer_code: row.volunteer_code, name: row.name, email: row.email, role: row.role, status: row.status };
    issueSession(ctx, res, user.id);
    res.json({ user });
  });

  r.post('/auth/logout', (_req, res) => {
    clearSession(ctx, res);
    res.status(204).end();
  });

  r.get('/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  return r;
}
