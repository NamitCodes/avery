import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../src/server/services/events/import.js';
import { b64, createEvent, importCsv, participants } from './eventHelpers.js';
import { createTestEnv, loginAdmin, registerVolunteer, type Client, type TestEnv } from './helpers.js';

let env: TestEnv;
let admin: Client;

beforeAll(async () => {
  env = await createTestEnv();
  admin = await loginAdmin(env);
});
afterAll(() => env.close());

const CSV = [
  'Full Name,Country,Email Address',
  'José Álvarez,España,jose@example.org',
  '王小明,中国,wang@example.cn',
  '"Müller, Anna",Deutschland,ANNA@Example.de',
  'Missing Email,France,',
  'Bad Email,France,not-an-email',
  '王小明,中国,wang@example.cn',
  'Wang Family,中国,wang@example.cn',
].join('\r\n');

describe('participant import', () => {
  it('parses quoted CSV with embedded commas, quotes and newlines', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n"multi\nline",z\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', 'z'],
    ]);
    expect(parseCsv('\uFEFFname;country;email\nA;B;c@d.ef')).toEqual([['name', 'country', 'email'], ['A', 'B', 'c@d.ef']]);
  });

  it('previews with auto-mapped columns, row errors, duplicates and flags — without writing anything', async () => {
    const ev = await createEvent(admin);
    const res = await admin.post(`/api/admin/events/${ev.id}/participants/import/preview`, { file_base64: b64(CSV) });
    expect(res.status).toBe(200);
    expect(res.body.mapping).toEqual({ name: 0, country: 1, email: 2 });
    expect(res.body.summary).toMatchObject({ total: 7, create: 4, skip: 1, error: 2, flagged: 1 });
    const byRow = Object.fromEntries(res.body.rows.map((r: { row: number }) => [r.row, r]));
    expect(byRow[2].name).toBe('José Álvarez');
    expect(byRow[5].errors).toEqual(['EMAIL_REQUIRED']);
    expect(byRow[6].errors).toEqual(['EMAIL_INVALID']);
    expect(byRow[7]).toMatchObject({ action: 'SKIP', flags: ['DUPLICATE_OF_ROW_3'] });
    expect(byRow[8].flags).toContain('EMAIL_SHARED_WITH_DIFFERENT_NAME');
    expect(await participants(admin, ev.id)).toHaveLength(0);
  });

  it('commits, preserves Unicode, records a summary, and is safe to retry', async () => {
    const ev = await createEvent(admin);
    const volunteersBefore = (await env.ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM volunteers')).rows[0].n;
    const first = await importCsv(admin, ev.id, CSV);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ created: 4, updated: 0, skipped: 1, failed: 2, flagged: 1 });
    expect(first.body.errors).toEqual([
      { row: 5, errors: ['EMAIL_REQUIRED'] },
      { row: 6, errors: ['EMAIL_INVALID'] },
    ]);

    const list = await participants(admin, ev.id);
    expect(list.map((p) => p.name).sort()).toEqual(['José Álvarez', 'Müller, Anna', 'Wang Family', '王小明'].sort());
    expect(new Set(list.map((p) => p.registration_reference)).size).toBe(4);
    for (const p of list) expect(p.registration_reference).toMatch(/^R[A-Z2-9]{3}-[A-Z2-9]{4}$/);

    // Same file again: nothing new.
    const retry = await importCsv(admin, ev.id, CSV);
    expect(retry.body).toMatchObject({ created: 0, updated: 0, failed: 2 });
    expect(await participants(admin, ev.id)).toHaveLength(4);

    // Update policy: a changed country for an existing person updates in place.
    const changed = await importCsv(admin, ev.id, 'Name,Country,Email\nJosé Álvarez,Spain,jose@example.org\n', { existing_policy: 'UPDATE' });
    expect(changed.body).toMatchObject({ created: 0, updated: 1 });
    expect(await participants(admin, ev.id)).toHaveLength(4);

    // Participants are not volunteers.
    const volunteersAfter = (await env.ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM volunteers')).rows[0].n;
    expect(volunteersAfter).toBe(volunteersBefore);

    const imports = (await admin.get(`/api/admin/events/${ev.id}/imports`)).body.imports;
    expect(imports).toHaveLength(3);
    expect(imports[2]).toMatchObject({ rows_created: 4, source_filename: 'list.csv', uploaded_by: admin.user.id });

    // Shared-email person is flagged for review, not merged.
    const flagged = await participants(admin, ev.id, '?needs_review=1');
    expect(flagged.map((p) => p.name)).toEqual(['Wang Family']);
  });

  it('searches Unicode names, partial matches and references', async () => {
    const ev = await createEvent(admin);
    await importCsv(admin, ev.id, CSV);
    expect((await participants(admin, ev.id, `?q=${encodeURIComponent('müller')}`)).map((p) => p.name)).toEqual(['Müller, Anna']);
    expect((await participants(admin, ev.id, `?q=${encodeURIComponent('小明')}`)).map((p) => p.name)).toEqual(['王小明']);
    const ref = (await participants(admin, ev.id))[0].registration_reference;
    expect(await participants(admin, ev.id, `?q=${ref.toLowerCase()}`)).toHaveLength(1);
    expect(await participants(admin, ev.id, '?q=example.de')).toHaveLength(1);
  });

  it('rejects non-UTF-8 files and asks for a mapping when columns cannot be guessed', async () => {
    const ev = await createEvent(admin);
    const latin1 = Buffer.from('name,country,email\nJos\xe9,Spain,j@x.org\n', 'latin1').toString('base64');
    const bad = await admin.post(`/api/admin/events/${ev.id}/participants/import/preview`, { file_base64: latin1 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_ENCODING');

    const unmapped = await admin.post(`/api/admin/events/${ev.id}/participants/import/preview`, { file_base64: b64('a,b,c\n1,2,3@x.org\n') });
    expect(unmapped.status).toBe(400);
    expect(unmapped.body.error.code).toBe('MAPPING_REQUIRED');
    const mapped = await admin.post(`/api/admin/events/${ev.id}/participants/import/preview`, {
      file_base64: b64('a,b,c\nAnn,UK,ann@x.org\n'),
      mapping: { name: 0, country: 1, email: 2 },
    });
    expect(mapped.body.summary.create).toBe(1);
  });

  it('only event managers can import or export; volunteers cannot see participant data', async () => {
    const ev = await createEvent(admin);
    const vol = await registerVolunteer(env);
    const deskUser = await loginAdmin(env, 'EXCEPTION_DESK');
    const gate = await loginAdmin(env, 'GATE_OPERATOR');
    for (const c of [vol, deskUser, gate]) {
      expect((await c.post(`/api/admin/events/${ev.id}/participants/import/commit`, { file_base64: b64(CSV) })).status).toBe(403);
      expect((await c.get(`/api/admin/events/${ev.id}/participants/export.csv`)).status).toBe(403);
    }
    expect((await vol.get(`/api/admin/events/${ev.id}/participants`)).status).toBe(403);
    expect((await gate.get(`/api/admin/events/${ev.id}/participants`)).status).toBe(403);

    // Desk staff see masked contact details; managers see them in full.
    await importCsv(admin, ev.id, CSV);
    const masked = (await deskUser.get(`/api/admin/events/${ev.id}/participants?q=jose`)).body.participants[0];
    expect(masked.email).toBe('j•••e@example.org');
    const full = (await admin.get(`/api/admin/events/${ev.id}/participants?q=jose`)).body.participants[0];
    expect(full.email).toBe('jose@example.org');
  });
});
