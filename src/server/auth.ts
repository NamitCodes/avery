import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { CookieOptions, NextFunction, Request, Response } from 'express';
import type { AppContext } from './context.js';
import { AppError } from './errors.js';

export const SESSION_COOKIE = 'va_session';
/** Custom header required on state-changing requests; browsers cannot send it cross-site without CORS. */
export const CSRF_HEADER = 'x-requested-with';

export type Role = 'VOLUNTEER' | 'ADMIN' | 'EVENT_ADMIN' | 'EXCEPTION_DESK' | 'GATE_OPERATOR';

/** Event-access permission tiers (ADMIN is a superset of all). */
export const EVENT_MANAGERS: Role[] = ['ADMIN', 'EVENT_ADMIN'];
export const DESK_STAFF: Role[] = [...EVENT_MANAGERS, 'EXCEPTION_DESK'];
export const GATE_STAFF: Role[] = [...DESK_STAFF, 'GATE_OPERATOR'];
export type AccountStatus = 'ACTIVE' | 'INACTIVE';

export interface AuthUser {
  id: string;
  volunteer_code: string;
  name: string;
  email: string;
  role: Role;
  status: AccountStatus;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export const hashPassword = (password: string) => bcrypt.hash(password, 10);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Human-friendly, non-sequential volunteer identifier, e.g. "V7KQ3MX". */
export function generateVolunteerCode(): string {
  const bytes = crypto.randomBytes(6);
  let code = 'V';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

export function issueSession(ctx: AppContext, res: Response, userId: string): void {
  const token = jwt.sign({ sub: userId }, ctx.config.jwtSecret, {
    expiresIn: ctx.config.sessionTtlHours * 3600,
    algorithm: 'HS256',
  });
  res.cookie(SESSION_COOKIE, token, cookieOptions(ctx, ctx.config.sessionTtlHours * 3600 * 1000));
}

export function clearSession(ctx: AppContext, res: Response): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions(ctx));
}

function cookieOptions(ctx: AppContext, maxAge?: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.nodeEnv === 'production',
    path: '/',
    ...(maxAge ? { maxAge } : {}),
  };
}

export const USER_COLUMNS = 'id, volunteer_code, name, email, role, status';

/** Loads the current user from the session cookie, if any. Never rejects the request. */
export function loadUser(ctx: AppContext) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string' && token) {
      try {
        const payload = jwt.verify(token, ctx.config.jwtSecret, { algorithms: ['HS256'] }) as { sub?: string };
        if (payload.sub) {
          const { rows } = await ctx.db.query<AuthUser>(`SELECT ${USER_COLUMNS} FROM volunteers WHERE id = $1`, [
            payload.sub,
          ]);
          req.user = rows[0];
        }
      } catch {
        // Invalid or expired token: treat as anonymous.
      }
    }
    next();
  };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    next(new AppError(401, 'UNAUTHENTICATED', 'Please sign in to continue.'));
    return;
  }
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    next(new AppError(401, 'UNAUTHENTICATED', 'Please sign in to continue.'));
    return;
  }
  if (req.user.role !== 'ADMIN' || req.user.status !== 'ACTIVE') {
    next(new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action.'));
    return;
  }
  next();
}

/** Allow only active accounts holding one of `roles`. */
export function requireRoles(roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      next(new AppError(401, 'UNAUTHENTICATED', 'Please sign in to continue.'));
      return;
    }
    if (!roles.includes(req.user.role) || req.user.status !== 'ACTIVE') {
      next(new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action.'));
      return;
    }
    next();
  };
}

/** Rejects state-changing requests that lack the custom CSRF header. */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }
  if (!req.get(CSRF_HEADER)) {
    next(new AppError(403, 'CSRF_REJECTED', 'Request rejected. Please reload the page and try again.'));
    return;
  }
  next();
}
