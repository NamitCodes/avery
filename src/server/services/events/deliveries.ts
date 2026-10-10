import { writeAudit } from '../../audit.js';
import type { AppContext } from '../../context.js';
import type { Queryable } from '../../db.js';
import { conflict, notFound } from '../../errors.js';
import { formatInZone } from '../../time.js';
import type { EventRow, ParticipantRow } from './common.js';
import { decryptToken, passUrl, qrPng, type CredentialRow } from './credentials.js';

export interface DeliveryRow {
  id: string;
  event_id: string;
  participant_id: string;
  credential_id: string;
  delivery_status: 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED' | 'CANCELLED';
  attempt_count: number;
  last_error: string | null;
  sent_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function queueDelivery(tx: Queryable, participant: Pick<ParticipantRow, 'id' | 'event_id'>, credentialId: string, actorId: string | null, now: Date) {
  const { rows } = await tx.query<DeliveryRow>(
    `INSERT INTO event_pass_deliveries (event_id, participant_id, credential_id, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
    [participant.event_id, participant.id, credentialId, actorId, now],
  );
  return rows[0];
}

/** Strip anything that looks like an address or token from transport errors before storing them. */
export function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/[^\s@<>"']+@[^\s@<>"']+/g, '[address]')
    .replace(/EVP1\.[A-Za-z0-9_-]+/g, '[token]')
    .slice(0, 300);
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function passEmail(ctx: AppContext, event: EventRow, p: ParticipantRow, token: string, qr: Buffer) {
  const when = `${formatInZone(event.starts_at, event.timezone, 'cccc d LLLL yyyy, HH:mm')} (${event.timezone})`;
  const url = passUrl(ctx.config, token);
  const lines = [
    `Hello ${p.name},`,
    '',
    `Here is your entry pass for ${event.name}.`,
    `When: ${when}`,
    event.venue_text ? `Where: ${event.venue_text}` : '',
    `Registration reference: ${p.registration_reference}`,
    '',
    'Please PRINT this pass and bring it with you. A phone is not required at the gate.',
    event.reentry_enabled ? 'Keep your pass: you will need it to exit and re-enter.' : '',
    event.instructions,
    '',
    `Printable pass: ${url}`,
    '',
    'Lost your pass? Go to the exception desk at the venue with your registration reference and photo ID.',
    'Do not share this pass — anyone holding it can use it.',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;color:#111">
  <h1 style="font-size:20px;font-weight:600">${escapeHtml(event.name)}</h1>
  <p>Hello ${escapeHtml(p.name)}, here is your entry pass.</p>
  <p style="margin:0">${escapeHtml(when)}</p>
  ${event.venue_text ? `<p style="margin:0">${escapeHtml(event.venue_text)}</p>` : ''}
  <p><img src="cid:pass-qr" alt="Entry QR code" width="240" height="240"/></p>
  <p style="font-size:18px;margin:0"><strong>${escapeHtml(p.name)}</strong></p>
  <p style="margin:0">${escapeHtml(p.country)} · Ref ${escapeHtml(p.registration_reference)}</p>
  <p><strong>Please print this pass and bring it with you.</strong> A phone is not required at the gate.
  ${event.reentry_enabled ? 'Keep your pass: you will need it to exit and re-enter.' : ''}</p>
  ${event.instructions ? `<p>${escapeHtml(event.instructions)}</p>` : ''}
  <p><a href="${escapeHtml(url)}">Open a printable version</a></p>
  <p style="color:#555;font-size:13px">Lost your pass? Go to the exception desk with your registration reference and photo ID.
  Do not share this pass — anyone holding it can use it.</p></div>`;
  return {
    to: p.email!,
    subject: `Your pass for ${event.name}`,
    text: lines.join('\n'),
    html,
    attachments: [{ filename: 'pass-qr.png', content: qr, contentType: 'image/png', cid: 'pass-qr' }],
  };
}

/** Send queued pass emails. Claims rows with SKIP LOCKED so several workers can run safely. */
export async function processDeliveries(ctx: AppContext, batchSize = 25): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  // Recover rows left in SENDING by a crashed worker.
  await ctx.db.query(
    `UPDATE event_pass_deliveries SET delivery_status = 'QUEUED', updated_at = $1
     WHERE delivery_status = 'SENDING' AND updated_at < $2`,
    [ctx.clock.now(), new Date(ctx.clock.now().getTime() - 10 * 60_000)],
  );
  for (;;) {
    const now = ctx.clock.now();
    const { rows: batch } = await ctx.db.query<DeliveryRow>(
      `UPDATE event_pass_deliveries SET delivery_status = 'SENDING', attempt_count = attempt_count + 1, updated_at = $2
       WHERE id IN (SELECT id FROM event_pass_deliveries WHERE delivery_status = 'QUEUED'
                    ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [batchSize, now],
    );
    if (batch.length === 0) break;
    for (const d of batch) {
      try {
        const { rows } = await ctx.db.query<{ e: EventRow; p: ParticipantRow; c: CredentialRow }>(
          `SELECT row_to_json(e.*) AS e, row_to_json(p.*) AS p, row_to_json(c.*) AS c
           FROM event_pass_deliveries d
           JOIN events e ON e.id = d.event_id
           JOIN event_participants p ON p.id = d.participant_id
           JOIN event_credentials c ON c.id = d.credential_id
           WHERE d.id = $1`,
          [d.id],
        );
        const { e, p, c } = rows[0];
        if (c.status !== 'ACTIVE') {
          await ctx.db.query(`UPDATE event_pass_deliveries SET delivery_status = 'CANCELLED', last_error = $2, updated_at = $3 WHERE id = $1`, [
            d.id, 'Pass was revoked before sending', ctx.clock.now(),
          ]);
          continue;
        }
        if (!p.email) throw new Error('Participant has no email address');
        const event = { ...e, starts_at: new Date(e.starts_at), ends_at: new Date(e.ends_at) };
        const token = decryptToken(c.token_ciphertext, ctx.config.credentialKey);
        await ctx.mailer.send(passEmail(ctx, event, p, token, await qrPng(passUrl(ctx.config, token))));
        await ctx.db.query(
          `UPDATE event_pass_deliveries SET delivery_status = 'SENT', sent_at = $2, last_error = NULL, updated_at = $2 WHERE id = $1`,
          [d.id, ctx.clock.now()],
        );
        sent++;
      } catch (err) {
        await ctx.db.query(
          `UPDATE event_pass_deliveries SET delivery_status = 'FAILED', last_error = $2, updated_at = $3 WHERE id = $1`,
          [d.id, sanitizeError(err), ctx.clock.now()],
        );
        failed++;
      }
    }
  }
  return { sent, failed };
}

let running: Promise<unknown> | null = null;

/** Kick the worker without waiting (no-op in tests, where the worker is invoked explicitly). */
export function kickDeliveries(ctx: AppContext) {
  if (!ctx.config.runJobsInBackground || running) return;
  running = processDeliveries(ctx)
    .catch((err) => console.error('Delivery worker failed', err))
    .finally(() => {
      running = null;
    });
}

export async function retryDelivery(ctx: AppContext, actorId: string, deliveryId: string) {
  return ctx.db.transaction(async (tx) => {
    const now = ctx.clock.now();
    const { rows } = await tx.query<DeliveryRow>('SELECT * FROM event_pass_deliveries WHERE id = $1 FOR UPDATE', [deliveryId]);
    const d = rows[0];
    if (!d) throw notFound('DELIVERY_NOT_FOUND', 'Delivery not found.');
    if (d.delivery_status !== 'FAILED') throw conflict('NOT_RETRYABLE', 'Only failed deliveries can be retried.');
    const { rows: c } = await tx.query<{ status: string }>('SELECT status FROM event_credentials WHERE id = $1', [d.credential_id]);
    if (c[0]?.status !== 'ACTIVE') throw conflict('CREDENTIAL_REVOKED', 'This pass has been revoked; issue or send the current pass instead.');
    const { rows: updated } = await tx.query<DeliveryRow>(
      `UPDATE event_pass_deliveries SET delivery_status = 'QUEUED', updated_at = $2 WHERE id = $1 RETURNING *`,
      [deliveryId, now],
    );
    await writeAudit(tx, { actorId, action: 'event_pass_delivery.retry', entityType: 'event_pass_delivery', entityId: deliveryId }, now);
    return updated[0];
  });
}
