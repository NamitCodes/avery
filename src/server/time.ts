import { DateTime, IANAZone } from 'luxon';
import { badRequest } from './errors.js';

export const isValidTimezone = (tz: string) => IANAZone.isValidZone(tz);

/**
 * Parse an admin-supplied date-time. Values with an explicit offset ("Z", "+08:00")
 * are absolute; naive values ("2026-10-11T09:00") are interpreted in the venue's zone.
 */
export function parseDateTimeInZone(value: string, zone: string, field: string): Date {
  const dt = DateTime.fromISO(value, { zone });
  if (!dt.isValid) throw badRequest('INVALID_DATETIME', `${field} is not a valid date and time.`, { field });
  return dt.toJSDate();
}

/** Start of a calendar day (YYYY-MM-DD) in `zone`. */
export function startOfDay(date: string, zone: string, field: string): Date {
  const dt = DateTime.fromISO(date, { zone }).startOf('day');
  if (!dt.isValid) throw badRequest('INVALID_DATE', `${field} must be a date (YYYY-MM-DD).`, { field });
  return dt.toJSDate();
}

export const addMinutes = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60_000);

export function formatInZone(d: Date, zone: string, format: string): string {
  return DateTime.fromJSDate(d, { zone }).toFormat(format);
}
