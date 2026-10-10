import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { writeAudit } from '../../audit.js';
import type { Config } from '../../config.js';
import type { Queryable } from '../../db.js';
import { conflict, notFound } from '../../errors.js';
import type { EventRow, ParticipantRow } from './common.js';

export interface CredentialRow {
  id: string;
  event_id: string;
  participant_id: string;
  token_hash: string;
  token_ciphertext: string;
  status: 'ACTIVE' | 'REVOKED';
  issued_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
  replaced_by_credential_id: string | null;
  created_by: string | null;
}

/** Columns safe to return to clients (never the hash or ciphertext). */
export const CREDENTIAL_PUBLIC_COLUMNS =
  'id, event_id, participant_id, status, issued_at, revoked_at, revoke_reason, replaced_by_credential_id, created_by';

const TOKEN_PREFIX = 'EVP1.';
const TOKEN_PATTERN = /(EVP1\.[A-Za-z0-9_-]{43})/;

/** 256 bits of randomness: infeasible to guess, so a fast hash is sufficient. */
export const generateToken = () => TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** Accepts the raw token or a pass URL that contains it (what the QR encodes). */
export function extractToken(scanned: string): string | null {
  const m = TOKEN_PATTERN.exec(scanned.trim());
  return m ? m[1] : null;
}

export function encryptToken(token: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

export function decryptToken(payload: string, key: Buffer): string {
  const [iv, tag, ct] = payload.split('.').map((p) => Buffer.from(p, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** The QR encodes this URL; it contains only the opaque token. */
export const passUrl = (config: Config, token: string) => `${config.publicBaseUrl}/pass/${token}`;

/**
 * Issue a new active credential, revoking any current one (a replacement).
 * Must run inside a transaction. Returns the raw token for immediate printing.
 */
export async function issueCredential(
  tx: Queryable,
  config: Config,
  participant: Pick<ParticipantRow, 'id' | 'event_id'>,
  actorId: string | null,
  now: Date,
  reason?: string | null,
): Promise<{ credential: CredentialRow; token: string; replaced: CredentialRow | null }> {
  const token = generateToken();
  const { rows: old } = await tx.query<CredentialRow>(
    `UPDATE event_credentials SET status = 'REVOKED', revoked_at = $2, revoke_reason = $3
     WHERE participant_id = $1 AND status = 'ACTIVE' RETURNING *`,
    [participant.id, now, reason ?? 'Replaced'],
  );
  const { rows } = await tx.query<CredentialRow>(
    `INSERT INTO event_credentials (event_id, participant_id, token_hash, token_ciphertext, issued_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [participant.event_id, participant.id, hashToken(token), encryptToken(token, config.credentialKey), now, actorId],
  );
  const credential = rows[0];
  const replaced = old[0] ?? null;
  if (replaced) {
    await tx.query('UPDATE event_credentials SET replaced_by_credential_id = $2 WHERE id = $1', [replaced.id, credential.id]);
    await writeAudit(
      tx,
      {
        actorId,
        action: 'event_credential.replace',
        entityType: 'event_credential',
        entityId: replaced.id,
        before: { status: 'ACTIVE' },
        after: { status: 'REVOKED', replaced_by_credential_id: credential.id },
        reason,
      },
      now,
    );
  }
  await writeAudit(
    tx,
    {
      actorId,
      action: 'event_credential.issue',
      entityType: 'event_credential',
      entityId: credential.id,
      after: { participant_id: participant.id, status: 'ACTIVE' },
      reason,
    },
    now,
  );
  return { credential, token, replaced };
}

export async function revokeCredential(tx: Queryable, credentialId: string, actorId: string, now: Date, reason: string) {
  const { rows } = await tx.query<CredentialRow>('SELECT * FROM event_credentials WHERE id = $1 FOR UPDATE', [credentialId]);
  const before = rows[0];
  if (!before) throw notFound('CREDENTIAL_NOT_FOUND', 'Pass not found.');
  if (before.status === 'REVOKED') throw conflict('CREDENTIAL_ALREADY_REVOKED', 'This pass has already been revoked.');
  const { rows: updated } = await tx.query<CredentialRow>(
    `UPDATE event_credentials SET status = 'REVOKED', revoked_at = $2, revoke_reason = $3 WHERE id = $1 RETURNING *`,
    [credentialId, now, reason],
  );
  // Undelivered emails for a revoked pass must not go out.
  await tx.query(
    `UPDATE event_pass_deliveries SET delivery_status = 'CANCELLED', updated_at = $2
     WHERE credential_id = $1 AND delivery_status IN ('QUEUED', 'FAILED')`,
    [credentialId, now],
  );
  await writeAudit(
    tx,
    { actorId, action: 'event_credential.revoke', entityType: 'event_credential', entityId: credentialId, before: { status: 'ACTIVE' }, after: { status: 'REVOKED' }, reason },
    now,
  );
  return updated[0];
}

export async function qrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width: 480 });
}

export async function qrPng(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 480 });
}

/** Data for a printable pass (also used in the email). */
export async function buildPass(config: Config, event: EventRow, participant: ParticipantRow, token: string) {
  const url = passUrl(config, token);
  return {
    event: {
      name: event.name,
      starts_at: event.starts_at,
      ends_at: event.ends_at,
      timezone: event.timezone,
      venue: event.venue_text,
      instructions: event.instructions,
      reentry_enabled: event.reentry_enabled,
    },
    participant: {
      name: participant.name,
      country: participant.country,
      registration_reference: participant.registration_reference,
    },
    qr_data_url: await qrDataUrl(url),
    pass_url: url,
  };
}
