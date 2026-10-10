import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { writeAudit } from '../audit.js';
import type { Config } from '../config.js';
import type { Queryable } from '../db.js';
import { AppError } from '../errors.js';

export interface LocationRow {
  id: string;
  name: string;
  address: string;
  timezone: string;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: Date;
  updated_at: Date;
}

export interface QrCodeRow {
  id: string;
  location_id: string;
  public_identifier: string;
  status: 'ACTIVE' | 'REVOKED';
  created_by: string | null;
  created_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
}

/** Opaque, unguessable identifier printed in the venue QR. Carries no credentials. */
export const generatePublicIdentifier = () => crypto.randomBytes(16).toString('base64url');

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export const checkInUrl = (config: Config, publicIdentifier: string) =>
  `${config.publicBaseUrl}/check-in/v/${publicIdentifier}`;

export function renderQrPng(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, { type: 'png', width: 800, margin: 2, errorCorrectionLevel: 'M' });
}

export function renderQrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
}

/**
 * Issue a new active QR for a venue, revoking any current one (a replacement).
 * Must run inside a transaction.
 */
export async function issueQrCode(tx: Queryable, locationId: string, actorId: string, now: Date, reason?: string | null) {
  const { rows: current } = await tx.query<QrCodeRow>(
    `UPDATE venue_qr_codes SET status = 'REVOKED', revoked_at = $2, revoked_by = $3
     WHERE location_id = $1 AND status = 'ACTIVE' RETURNING *`,
    [locationId, now, actorId],
  );
  for (const old of current) {
    await writeAudit(
      tx,
      {
        actorId,
        action: 'qr.revoke',
        entityType: 'venue_qr_code',
        entityId: old.id,
        before: { status: 'ACTIVE' },
        after: { status: 'REVOKED', revoked_at: now },
        reason: reason ?? 'Replaced by a new QR code',
      },
      now,
    );
  }
  const { rows } = await tx.query<QrCodeRow>(
    `INSERT INTO venue_qr_codes (location_id, public_identifier, created_by, created_at)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [locationId, generatePublicIdentifier(), actorId, now],
  );
  const qr = rows[0];
  await writeAudit(
    tx,
    { actorId, action: 'qr.issue', entityType: 'venue_qr_code', entityId: qr.id, after: { location_id: locationId, status: 'ACTIVE' } },
    now,
  );
  return qr;
}

/**
 * Resolve a scanned QR identifier to its venue, enforcing that the QR is not
 * revoked and the venue is active.
 */
export async function resolveVenue(q: Queryable, publicIdentifier: string) {
  const unknown = new AppError(404, 'VENUE_NOT_FOUND', 'This QR code is not recognised. Please check you scanned the venue’s attendance QR code.');
  if (!PUBLIC_ID_PATTERN.test(publicIdentifier)) throw unknown;
  const { rows } = await q.query<QrCodeRow & { location: LocationRow }>(
    `SELECT q.*, row_to_json(l.*) AS location
     FROM venue_qr_codes q JOIN locations l ON l.id = q.location_id
     WHERE q.public_identifier = $1`,
    [publicIdentifier],
  );
  const row = rows[0];
  if (!row) throw unknown;
  if (row.status !== 'ACTIVE') {
    throw new AppError(410, 'QR_REVOKED', 'This QR code is no longer valid. Please ask an organiser for the current attendance QR code.');
  }
  if (row.location.status !== 'ACTIVE') {
    throw new AppError(410, 'VENUE_INACTIVE', 'This venue is not currently accepting attendance.');
  }
  const { location, ...qr } = row;
  return { qr: qr as QrCodeRow, location };
}
