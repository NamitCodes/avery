import { z } from 'zod';
import { notFound } from './errors.js';

export const uuid = z.string().uuid();

export const reason = z.string().trim().min(3, 'Please give a reason (at least 3 characters).').max(500);

/** Validate a UUID route parameter; responds 404 rather than leaking a DB error. */
export function uuidParam(value: unknown, what = 'Record'): string {
  const r = uuid.safeParse(value);
  if (!r.success) throw notFound('NOT_FOUND', `${what} not found.`);
  return r.data;
}

/** Read an optional single-valued query string parameter. */
export function queryString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return v === '' ? undefined : v;
}
