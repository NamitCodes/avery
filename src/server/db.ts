import pg from 'pg';

export interface QueryResult<T> {
  rows: T[];
}

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Database extends Queryable {
  /** Run `fn` inside a single transaction; rolls back if it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Execute a multi-statement SQL script (no parameters). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export function createPgDatabase(connectionString: string): Database {
  const pool = new pg.Pool({ connectionString });
  return {
    async query<T>(text: string, params?: unknown[]) {
      const res = await pool.query(text, params);
      return { rows: res.rows as T[] };
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: Queryable = {
          async query<R>(text: string, params?: unknown[]) {
            const res = await client.query(text, params);
            return { rows: res.rows as R[] };
          },
        };
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async close() {
      await pool.end();
    },
  };
}

/** In-process Postgres (WASM). Used for tests and zero-config local development. */
export async function createPgliteDatabase(dataDir?: string): Promise<Database> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  return {
    async query<T>(text: string, params?: unknown[]) {
      const res = await db.query<T>(text, params);
      return { rows: res.rows };
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return db.transaction(async (t) =>
        fn({
          async query<R>(text: string, params?: unknown[]) {
            const res = await t.query<R>(text, params);
            return { rows: res.rows };
          },
        }),
      );
    },
    async exec(sql: string) {
      await db.exec(sql);
    },
    async close() {
      await db.close();
    },
  };
}

export async function connectDatabase(opts: { databaseUrl?: string; pgliteDataDir?: string }): Promise<Database> {
  if (opts.databaseUrl) return createPgDatabase(opts.databaseUrl);
  if (opts.pgliteDataDir) {
    const fs = await import('node:fs');
    fs.mkdirSync(opts.pgliteDataDir, { recursive: true });
  }
  return createPgliteDatabase(opts.pgliteDataDir);
}

/** Postgres unique_violation, optionally for a specific constraint/index. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  if (!e || e.code !== '23505') return false;
  return constraint ? e.constraint === constraint : true;
}
