import { Router } from 'express';
import type { AppContext } from '../context.js';
import { badRequest } from '../errors.js';
import { addMinutes, formatInZone, startOfDay } from '../time.js';
import { queryString, uuidParam } from '../validation.js';

/** Quote a CSV cell and neutralise spreadsheet formula injection. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

interface ExportRow {
  title: string;
  start_at: Date;
  venue_name: string;
  timezone: string;
  volunteer_name: string;
  volunteer_code: string;
  tapped_in_at: Date;
  source: string;
}

export function adminReportRoutes(ctx: AppContext) {
  const r = Router();

  /** Attendance CSV. Filter by ?session_id= or by ?from=&to= (YYYY-MM-DD) and optional ?location_id=. */
  r.get('/reports/attendance.csv', async (req, res) => {
    const where = [`a.status = 'ACTIVE'`];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    const sessionId = queryString(req.query.session_id);
    const locationId = queryString(req.query.location_id);
    const from = queryString(req.query.from);
    const to = queryString(req.query.to);
    if (!sessionId && !from && !to && !locationId) {
      throw badRequest('FILTER_REQUIRED', 'Choose a session or a date range to export.');
    }
    const tz = ctx.config.defaultTimezone;
    if (sessionId) add('s.id = ?', uuidParam(sessionId, 'Session'));
    if (locationId) add('s.location_id = ?', uuidParam(locationId, 'Venue'));
    if (from) add('s.start_at >= ?', startOfDay(from, tz, 'from'));
    if (to) add('s.start_at < ?', addMinutes(startOfDay(to, tz, 'to'), 24 * 60));

    const { rows } = await ctx.db.query<ExportRow>(
      `SELECT s.title, s.start_at, l.name AS venue_name, l.timezone,
              v.name AS volunteer_name, v.volunteer_code, a.tapped_in_at, a.source
       FROM attendance_records a
       JOIN sessions s ON s.id = a.session_id
       JOIN locations l ON l.id = s.location_id
       JOIN volunteers v ON v.id = a.volunteer_id
       WHERE ${where.join(' AND ')}
       ORDER BY s.start_at, s.title, a.tapped_in_at`,
      params,
    );
    const header = ['Activity', 'Session date', 'Venue', 'Volunteer name', 'Volunteer ID', 'Tap-in time (venue local)', 'Tap-in time (UTC)', 'Source'];
    const lines = [header.map(csvCell).join(',')];
    for (const row of rows) {
      lines.push(
        [
          row.title,
          formatInZone(row.start_at, row.timezone, 'yyyy-MM-dd'),
          row.venue_name,
          row.volunteer_name,
          row.volunteer_code,
          formatInZone(row.tapped_in_at, row.timezone, 'yyyy-MM-dd HH:mm:ss ZZZZ'),
          row.tapped_in_at.toISOString(),
          row.source,
        ]
          .map(csvCell)
          .join(','),
      );
    }
    const stamp = formatInZone(ctx.clock.now(), tz, 'yyyyMMdd-HHmm');
    res.attachment(`attendance-${stamp}.csv`);
    res.type('text/csv; charset=utf-8');
    // BOM so Excel detects UTF-8 (names with non-ASCII characters).
    res.send(`\uFEFF${lines.join('\r\n')}\r\n`);
  });

  return r;
}
