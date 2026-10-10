import { writeAudit } from '../../audit.js';
import type { AppContext } from '../../context.js';
import type { Queryable } from '../../db.js';
import { badRequest } from '../../errors.js';
import {
  EMAIL_PATTERN,
  generateRegistrationReference,
  getEvent,
  initialVerification,
  normalizeEmail,
  normalizeName,
  type ParticipantRow,
} from './common.js';

/** RFC 4180 CSV parser (quoted fields, embedded commas/quotes/newlines, CRLF). Auto-detects ; or tab delimiters. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const counts = { ',': 0, ';': 0, '\t': 0 } as Record<string, number>;
  for (const ch of firstLine) if (ch in counts) counts[ch]++;
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    : ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/** Decode uploaded bytes as strict UTF-8 (rejects other encodings rather than garbling names). */
export function decodeUpload(base64: string, maxBytes: number): string {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) throw badRequest('EMPTY_FILE', 'The file is empty.');
  if (bytes.length > maxBytes) {
    throw badRequest('FILE_TOO_LARGE', `The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw badRequest('INVALID_ENCODING', 'The file must be saved as UTF-8 CSV ("CSV UTF-8" in Excel).');
  }
}

export interface ColumnMapping {
  name: number;
  country: number;
  email: number;
}

const HEADER_GUESSES: Record<keyof ColumnMapping, RegExp> = {
  name: /^(full[\s_-]*)?name$|participant|attendee|^nom$|^nombre$/i,
  country: /country|nation|pays|pa[ií]s/i,
  email: /e-?mail|courriel|correo/i,
};

export function guessMapping(headers: string[]): Partial<ColumnMapping> {
  const mapping: Partial<ColumnMapping> = {};
  for (const key of Object.keys(HEADER_GUESSES) as (keyof ColumnMapping)[]) {
    const idx = headers.findIndex((h) => HEADER_GUESSES[key].test(h.trim()));
    if (idx >= 0) mapping[key] = idx;
  }
  return mapping;
}

export type RowAction = 'CREATE' | 'UPDATE' | 'SKIP' | 'ERROR';

export interface AnalyzedRow {
  row: number; // 1-based line number in the file, including the header
  name: string;
  country: string;
  email: string;
  action: RowAction;
  errors: string[];
  /** Flags for human review; the row is still imported. */
  flags: string[];
  existing_participant_id: string | null;
}

export interface Analysis {
  headers: string[];
  mapping: ColumnMapping;
  rows: AnalyzedRow[];
  summary: { total: number; create: number; update: number; skip: number; error: number; flagged: number };
}

/**
 * Validate rows and decide what a commit would do, without writing anything.
 * Idempotency key per row: same normalised email AND same normalised name as an
 * existing participant => that participant (skip or update). Same email with a
 * different name is flagged, never merged.
 */
export async function analyzeImport(
  q: Queryable,
  eventId: string,
  text: string,
  mapping: Partial<ColumnMapping> | undefined,
  existingPolicy: 'SKIP' | 'UPDATE',
): Promise<Analysis> {
  const table = parseCsv(text);
  if (table.length < 2) throw badRequest('NO_ROWS', 'The file needs a header row and at least one participant row.');
  const headers = table[0].map((h) => h.trim());
  const guessed = { ...guessMapping(headers), ...mapping };
  if (guessed.name === undefined || guessed.email === undefined || guessed.country === undefined) {
    throw badRequest('MAPPING_REQUIRED', 'Choose which columns contain name, country and email.', { headers, mapping: guessed });
  }
  const map = guessed as ColumnMapping;
  for (const idx of Object.values(map)) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= headers.length) throw badRequest('INVALID_MAPPING', 'Column mapping is invalid.');
  }

  const { rows: existing } = await q.query<Pick<ParticipantRow, 'id' | 'normalized_email' | 'normalized_name' | 'country' | 'name' | 'email'>>(
    'SELECT id, normalized_email, normalized_name, country, name, email FROM event_participants WHERE event_id = $1',
    [eventId],
  );
  const byEmail = new Map<string, typeof existing>();
  const byName = new Map<string, typeof existing>();
  for (const p of existing) {
    if (p.normalized_email) byEmail.set(p.normalized_email, [...(byEmail.get(p.normalized_email) ?? []), p]);
    byName.set(p.normalized_name, [...(byName.get(p.normalized_name) ?? []), p]);
  }

  const seenKeys = new Map<string, number>();
  const seenEmails = new Map<string, number>();
  const seenNames = new Map<string, number>();
  const out: AnalyzedRow[] = [];

  table.slice(1).forEach((cells, i) => {
    const rowNo = i + 2;
    const name = (cells[map.name] ?? '').normalize('NFC').trim();
    const country = (cells[map.country] ?? '').normalize('NFC').trim();
    const email = (cells[map.email] ?? '').trim();
    const r: AnalyzedRow = { row: rowNo, name, country, email, action: 'CREATE', errors: [], flags: [], existing_participant_id: null };

    if (!name) r.errors.push('NAME_REQUIRED');
    if (name.length > 200) r.errors.push('NAME_TOO_LONG');
    if (!country) r.errors.push('COUNTRY_REQUIRED');
    if (!email) r.errors.push('EMAIL_REQUIRED');
    else if (!EMAIL_PATTERN.test(email) || email.length > 320) r.errors.push('EMAIL_INVALID');
    if (r.errors.length) {
      r.action = 'ERROR';
      out.push(r);
      return;
    }

    const nEmail = normalizeEmail(email)!;
    const nName = normalizeName(name);
    const key = `${nEmail}\u0000${nName}`;

    if (seenKeys.has(key)) {
      r.action = 'SKIP';
      r.flags.push(`DUPLICATE_OF_ROW_${seenKeys.get(key)}`);
      out.push(r);
      return;
    }
    seenKeys.set(key, rowNo);

    const match = (byEmail.get(nEmail) ?? []).find((p) => p.normalized_name === nName);
    if (match) {
      r.existing_participant_id = match.id;
      const changed = match.name !== name || match.country !== country || match.email !== email;
      r.action = existingPolicy === 'UPDATE' && changed ? 'UPDATE' : 'SKIP';
      if (r.action === 'SKIP') r.flags.push('ALREADY_IMPORTED');
    } else {
      if (byEmail.has(nEmail) || seenEmails.has(nEmail)) r.flags.push('EMAIL_SHARED_WITH_DIFFERENT_NAME');
      if ((byName.get(nName) ?? []).length || seenNames.has(nName)) r.flags.push('POSSIBLE_DUPLICATE_PERSON');
    }
    seenEmails.set(nEmail, rowNo);
    seenNames.set(nName, rowNo);
    out.push(r);
  });

  const summary = {
    total: out.length,
    create: out.filter((r) => r.action === 'CREATE').length,
    update: out.filter((r) => r.action === 'UPDATE').length,
    skip: out.filter((r) => r.action === 'SKIP').length,
    error: out.filter((r) => r.action === 'ERROR').length,
    flagged: out.filter((r) => r.action !== 'SKIP' && r.flags.length > 0).length,
  };
  return { headers, mapping: map, rows: out, summary };
}

/** Apply an import. Safe to retry: rows already imported are skipped/updated, never duplicated. */
export async function commitImport(
  ctx: AppContext,
  actorId: string,
  eventId: string,
  input: { text: string; filename: string | null; mapping?: Partial<ColumnMapping>; existingPolicy: 'SKIP' | 'UPDATE' },
) {
  return ctx.db.transaction(async (tx) => {
    const now = ctx.clock.now();
    // Serialise concurrent imports for the same event.
    const event = await getEvent(tx, eventId, 'FOR UPDATE');
    if (event.status === 'ARCHIVED' || event.status === 'CLOSED') {
      throw badRequest('EVENT_CLOSED', 'Participants cannot be imported into a closed or archived event.');
    }
    // Re-analyse inside the transaction so the decision reflects committed data.
    const analysis = await analyzeImport(tx, eventId, input.text, input.mapping, input.existingPolicy);
    const verification = initialVerification(event);
    let created = 0;
    let updated = 0;

    for (const r of analysis.rows) {
      if (r.action === 'CREATE') {
        const reviewNote = r.flags.length ? r.flags.join(', ') : null;
        for (let attempt = 0; ; attempt++) {
          try {
            await tx.query('SAVEPOINT ref_attempt');
            await tx.query(
              `INSERT INTO event_participants
                 (event_id, name, normalized_name, country, email, normalized_email, registration_reference,
                  registration_source, contact_verification, id_check, needs_review, review_note, created_by,
                  registered_at, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'IMPORT', $8, $9, $10, $11, $12, $13, $13, $13)`,
              [
                eventId, r.name, normalizeName(r.name), r.country, r.email, normalizeEmail(r.email),
                generateRegistrationReference(), verification.contact_verification, verification.id_check,
                reviewNote !== null, reviewNote, actorId, now,
              ],
            );
            await tx.query('RELEASE SAVEPOINT ref_attempt');
            break;
          } catch (err) {
            await tx.query('ROLLBACK TO SAVEPOINT ref_attempt');
            // Registration reference collision: retry with a fresh reference.
            if ((err as { code?: string }).code !== '23505' || attempt >= 4) throw err;
          }
        }
        created++;
      } else if (r.action === 'UPDATE' && r.existing_participant_id) {
        await tx.query(
          `UPDATE event_participants SET name = $2, normalized_name = $3, country = $4, email = $5, updated_at = $6 WHERE id = $1`,
          [r.existing_participant_id, r.name, normalizeName(r.name), r.country, r.email, now],
        );
        updated++;
      }
    }

    const errors = analysis.rows.filter((r) => r.action === 'ERROR').map((r) => ({ row: r.row, errors: r.errors }));
    const s = analysis.summary;
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO event_imports (event_id, uploaded_by, source_filename, existing_policy, rows_processed, rows_created,
                                  rows_updated, rows_skipped, rows_failed, rows_flagged, errors)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [eventId, actorId, input.filename, input.existingPolicy, s.total, created, updated, s.skip, s.error, s.flagged, JSON.stringify(errors)],
    );
    await writeAudit(
      tx,
      {
        actorId,
        action: 'event_import.commit',
        entityType: 'event_import',
        entityId: rows[0].id,
        after: { event_id: eventId, created, updated, skipped: s.skip, failed: s.error, flagged: s.flagged },
      },
      now,
    );
    return { import_id: rows[0].id, created, updated, skipped: s.skip, failed: s.error, flagged: s.flagged, errors };
  });
}
