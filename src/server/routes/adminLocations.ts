import { Router } from 'express';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { isValidTimezone } from '../time.js';
import { queryString, reason, uuidParam } from '../validation.js';
import {
  checkInUrl,
  issueQrCode,
  renderQrPng,
  renderQrSvg,
  type LocationRow,
  type QrCodeRow,
} from '../services/venues.js';

const timezone = z.string().refine(isValidTimezone, 'Choose a valid time zone, e.g. Asia/Singapore.');

const createBody = z.object({
  name: z.string().trim().min(1, 'Venue name is required.').max(200),
  address: z.string().trim().max(500).default(''),
  timezone: timezone.optional(),
});

const updateBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    address: z.string().trim().max(500),
    timezone,
    status: z.enum(['ACTIVE', 'INACTIVE']),
    reason: reason.optional(),
  })
  .partial();

const revokeBody = z.object({ reason: reason.optional() });

export function adminLocationRoutes(ctx: AppContext) {
  const r = Router();

  const withQr = (l: LocationRow & { active_qr: QrCodeRow | null }) => ({
    ...l,
    active_qr: l.active_qr ? { ...l.active_qr, url: checkInUrl(ctx.config, l.active_qr.public_identifier) } : null,
  });

  const LOCATION_SELECT = `
    SELECT l.*,
      (SELECT row_to_json(q.*) FROM venue_qr_codes q WHERE q.location_id = l.id AND q.status = 'ACTIVE') AS active_qr,
      (SELECT count(*)::int FROM sessions s WHERE s.location_id = l.id) AS session_count
    FROM locations l`;

  r.post('/locations', async (req, res) => {
    const body = createBody.parse(req.body);
    const now = ctx.clock.now();
    const actor = req.user!.id;
    const result = await ctx.db.transaction(async (tx) => {
      const { rows } = await tx.query<LocationRow>(
        `INSERT INTO locations (name, address, timezone, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4) RETURNING *`,
        [body.name, body.address, body.timezone ?? ctx.config.defaultTimezone, now],
      );
      const location = rows[0];
      await writeAudit(tx, { actorId: actor, action: 'location.create', entityType: 'location', entityId: location.id, after: location }, now);
      // Every venue gets a printable QR as soon as it is created.
      const qr = await issueQrCode(tx, location.id, actor, now);
      return { ...location, active_qr: qr };
    });
    res.status(201).json({ location: withQr(result) });
  });

  r.get('/locations', async (req, res) => {
    const status = queryString(req.query.status);
    const params: unknown[] = [];
    let where = '';
    if (status === 'ACTIVE' || status === 'INACTIVE') {
      params.push(status);
      where = 'WHERE l.status = $1';
    }
    const { rows } = await ctx.db.query<LocationRow & { active_qr: QrCodeRow | null }>(
      `${LOCATION_SELECT} ${where} ORDER BY l.name`,
      params,
    );
    res.json({ locations: rows.map(withQr) });
  });

  r.get('/locations/:id', async (req, res) => {
    const id = uuidParam(req.params.id, 'Venue');
    const { rows } = await ctx.db.query<LocationRow & { active_qr: QrCodeRow | null }>(`${LOCATION_SELECT} WHERE l.id = $1`, [id]);
    if (!rows[0]) throw notFound('LOCATION_NOT_FOUND', 'Venue not found.');
    const { rows: qrCodes } = await ctx.db.query<QrCodeRow>(
      'SELECT * FROM venue_qr_codes WHERE location_id = $1 ORDER BY created_at DESC',
      [id],
    );
    res.json({
      location: withQr(rows[0]),
      qr_codes: qrCodes.map((q) => ({ ...q, url: checkInUrl(ctx.config, q.public_identifier) })),
    });
  });

  r.patch('/locations/:id', async (req, res) => {
    const id = uuidParam(req.params.id, 'Venue');
    const body = updateBody.parse(req.body);
    const { reason: why, ...changes } = body;
    if (Object.keys(changes).length === 0) throw badRequest('NO_CHANGES', 'Nothing to update.');
    const now = ctx.clock.now();
    const location = await ctx.db.transaction(async (tx) => {
      const { rows } = await tx.query<LocationRow>('SELECT * FROM locations WHERE id = $1 FOR UPDATE', [id]);
      const before = rows[0];
      if (!before) throw notFound('LOCATION_NOT_FOUND', 'Venue not found.');
      const next = { ...before, ...changes };
      const { rows: updated } = await tx.query<LocationRow>(
        `UPDATE locations SET name = $2, address = $3, timezone = $4, status = $5, updated_at = $6
         WHERE id = $1 RETURNING *`,
        [id, next.name, next.address, next.timezone, next.status, now],
      );
      await writeAudit(
        tx,
        {
          actorId: req.user!.id,
          action: changes.status && changes.status !== before.status ? `location.${changes.status === 'ACTIVE' ? 'activate' : 'deactivate'}` : 'location.update',
          entityType: 'location',
          entityId: id,
          before,
          after: updated[0],
          reason: why,
        },
        now,
      );
      return updated[0];
    });
    res.json({ location });
  });

  /** Generate a (replacement) QR. Any currently active QR for the venue is revoked. */
  r.post('/locations/:id/qr-codes', async (req, res) => {
    const id = uuidParam(req.params.id, 'Venue');
    const body = revokeBody.parse(req.body ?? {});
    const now = ctx.clock.now();
    const qr = await ctx.db.transaction(async (tx) => {
      const { rows } = await tx.query<LocationRow>('SELECT * FROM locations WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) throw notFound('LOCATION_NOT_FOUND', 'Venue not found.');
      return issueQrCode(tx, id, req.user!.id, now, body.reason);
    });
    res.status(201).json({ qr_code: { ...qr, url: checkInUrl(ctx.config, qr.public_identifier) } });
  });

  r.post('/qr-codes/:id/revoke', async (req, res) => {
    const id = uuidParam(req.params.id, 'QR code');
    const body = revokeBody.parse(req.body ?? {});
    const now = ctx.clock.now();
    const qr = await ctx.db.transaction(async (tx) => {
      const { rows } = await tx.query<QrCodeRow>('SELECT * FROM venue_qr_codes WHERE id = $1 FOR UPDATE', [id]);
      const before = rows[0];
      if (!before) throw notFound('QR_NOT_FOUND', 'QR code not found.');
      if (before.status === 'REVOKED') throw conflict('QR_ALREADY_REVOKED', 'This QR code has already been revoked.');
      const { rows: updated } = await tx.query<QrCodeRow>(
        `UPDATE venue_qr_codes SET status = 'REVOKED', revoked_at = $2, revoked_by = $3 WHERE id = $1 RETURNING *`,
        [id, now, req.user!.id],
      );
      await writeAudit(
        tx,
        {
          actorId: req.user!.id,
          action: 'qr.revoke',
          entityType: 'venue_qr_code',
          entityId: id,
          before: { status: before.status },
          after: { status: 'REVOKED', revoked_at: now },
          reason: body.reason,
        },
        now,
      );
      return updated[0];
    });
    res.json({ qr_code: { ...qr, url: checkInUrl(ctx.config, qr.public_identifier) } });
  });

  /** QR image for printing. ?format=svg|png (default png), ?download=1 to save as a file. */
  r.get('/qr-codes/:id/image', async (req, res) => {
    const id = uuidParam(req.params.id, 'QR code');
    const { rows } = await ctx.db.query<QrCodeRow & { location_name: string }>(
      `SELECT q.*, l.name AS location_name FROM venue_qr_codes q JOIN locations l ON l.id = q.location_id WHERE q.id = $1`,
      [id],
    );
    const qr = rows[0];
    if (!qr) throw notFound('QR_NOT_FOUND', 'QR code not found.');
    const url = checkInUrl(ctx.config, qr.public_identifier);
    const format = req.query.format === 'svg' ? 'svg' : 'png';
    const fileName = `${qr.location_name.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'venue'}-attendance-qr.${format}`;
    if (req.query.download) res.attachment(fileName);
    res.set('Cache-Control', 'private, no-store');
    if (format === 'svg') {
      res.type('image/svg+xml').send(await renderQrSvg(url));
    } else {
      res.type('image/png').send(await renderQrPng(url));
    }
  });

  return r;
}
