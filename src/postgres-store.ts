import type { EffectRecord, EffectStore } from "./types.js";

/** Anything with pg's `query(text, params)` shape: a `pg` Pool or Client, or a compatible driver. */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface PostgresStoreOptions {
  /** Table name, optionally schema-qualified. Default "verified_tool_effects". */
  table?: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * Effect store for multiple instances sharing one Postgres. Every write is a
 * single statement, so atomicity comes from Postgres itself: claim is
 * INSERT … ON CONFLICT DO NOTHING, and replace/release are UPDATE/DELETE
 * … WHERE owner = $expected.
 *
 * Leases compare `claimedAt` values written by each instance's own clock, so
 * instance clocks must agree to well within `leaseMs` (NTP is plenty).
 */
export function createPostgresStore(
  client: SqlClient,
  options: PostgresStoreOptions = {}
): EffectStore & { migrate(): Promise<void> } {
  const table = options.table ?? "verified_tool_effects";
  if (!IDENTIFIER.test(table)) throw new Error(`Invalid table name: ${table}`);

  const toRecord = (row: any): EffectRecord => ({
    state: row.state,
    owner: row.owner,
    claimedAt: Number(row.claimed_at),
    ...(row.lease_ms == null ? {} : { leaseMs: Number(row.lease_ms) }),
    ...(row.settled_at == null ? {} : { settledAt: Number(row.settled_at) }),
    ...(row.result == null ? {} : { result: row.result }),
  });
  const values = (r: EffectRecord) => [
    r.state,
    r.owner,
    r.claimedAt,
    r.leaseMs ?? null,
    r.settledAt ?? null,
    r.result === undefined ? null : JSON.stringify(r.result),
  ];

  async function get(key: string): Promise<EffectRecord | undefined> {
    const { rows } = await client.query(
      `SELECT state, owner, claimed_at, lease_ms, settled_at, result FROM ${table} WHERE key = $1`,
      [key]
    );
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  return {
    /** Creates the table if it doesn't exist. Or copy the statement into your own migrations. */
    async migrate() {
      try {
        await createTable();
      } catch (error) {
        // CREATE TABLE IF NOT EXISTS isn't safe under concurrency: when several
        // instances boot at once, the losers get unique_violation (23505) or
        // duplicate_table (42P07) even though the table now exists.
        const code = (error as { code?: string }).code;
        if (code !== "23505" && code !== "42P07") throw error;
      }
    },
    get,
    async claim(key, record) {
      for (;;) {
        const { rows } = await client.query(
          `INSERT INTO ${table} (key, state, owner, claimed_at, lease_ms, settled_at, result)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
           ON CONFLICT (key) DO NOTHING
           RETURNING key`,
          [key, ...values(record)]
        );
        if (rows.length === 1) return null;
        const existing = await get(key);
        if (existing) return existing;
        // released between our insert and read; try again
      }
    },
    async replace(key, expectedOwner, next) {
      const { rows } = await client.query(
        `UPDATE ${table}
         SET state = $3, owner = $4, claimed_at = $5, lease_ms = $6, settled_at = $7, result = $8::jsonb
         WHERE key = $1 AND owner = $2
         RETURNING key`,
        [key, expectedOwner, ...values(next)]
      );
      return rows.length === 1;
    },
    async release(key, expectedOwner) {
      const { rows } = await client.query(`DELETE FROM ${table} WHERE key = $1 AND owner = $2 RETURNING key`, [
        key,
        expectedOwner,
      ]);
      return rows.length === 1;
    },
  };

  async function createTable() {
    await client.query(`CREATE TABLE IF NOT EXISTS ${table} (
      key         text PRIMARY KEY,
      state       text NOT NULL CHECK (state IN ('claimed', 'unresolved', 'settled')),
      owner       text NOT NULL,
      claimed_at  bigint NOT NULL,
      lease_ms    bigint,
      settled_at  bigint,
      result      jsonb
    )`);
  }
}
