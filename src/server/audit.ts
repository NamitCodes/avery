import type { Queryable } from './db.js';

export interface AuditEntry {
  /** NULL for system actions (e.g. the scheduler). */
  actorId: string | null;
  action: string;
  entityType:
    | 'session'
    | 'location'
    | 'venue_qr_code'
    | 'attendance_record'
    | 'volunteer'
    | 'event'
    | 'event_participant'
    | 'event_credential'
    | 'event_gate'
    | 'event_import'
    | 'event_access_event'
    | 'event_pass_delivery';
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

export async function writeAudit(q: Queryable, entry: AuditEntry, at: Date): Promise<void> {
  await q.query(
    `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before_data, after_data, reason, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.actorId,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.reason ?? null,
      at,
    ],
  );
}
