import type { Knex } from "knex";
import { C, T } from "../schema.js";

export const NODES_VALUE_INDEX = "nodes_value_hash_idx";

/** One pinned Postgres connection: what a statement that refuses a transaction runs on. */
export interface PgSession {
    query<R>(sql: string, values?: readonly unknown[]): Promise<{ rows: R[] }>;
}

/**
 * TRN-1117: index literal lookup by value.
 *
 * TripleStore interns a literal by looking it up first:
 *
 *   select * from nodes where kind = ? and value = ? and dt = ? and lang is null
 *
 * The only index covering `value` is the unique (kind, iri, blank_id, value,
 * dt, lang). Literals have a null `iri`, so that index cannot seek past `kind`
 * and the lookup walks every literal. Its cost grows with the literal count,
 * and every property update adds a literal (old values stay by design), so it
 * gets slower every day: on staging it was 41ms mean over 3.3M calls at 740k
 * literals, the largest CPU consumer on the node.
 *
 * HASH, not btree: a btree entry caps at ~2704 bytes and index keys are not
 * TOASTed, so a btree on `value` would refuse any large literal at INSERT. A
 * hash index stores only the 4-byte hash, and this lookup is pure equality.
 *
 * SQLite has no hash index and no key-size limit, so it gets a plain index.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`CREATE INDEX IF NOT EXISTS ${NODES_VALUE_INDEX} ON ${T.nodes} (${C.value})`);
}

/**
 * The Postgres build. CONCURRENTLY, because it runs against live tables and a
 * plain CREATE INDEX blocks every write to nodes for the build; CONCURRENTLY
 * refuses to run inside a transaction, hence a pinned session rather than the
 * ledger transaction. A failed concurrent build leaves an INVALID index behind
 * that IF NOT EXISTS would then skip forever, so an invalid one is dropped and
 * rebuilt.
 */
export async function upConcurrently(session: PgSession): Promise<void> {
    const { rows } = await session.query<{ valid: boolean }>(
        "SELECT i.indisvalid AS valid FROM pg_index i WHERE i.indexrelid = to_regclass($1)",
        [NODES_VALUE_INDEX],
    );
    const existing = rows[0];
    if (existing?.valid) {
        return;
    }
    if (existing) {
        await session.query(`DROP INDEX CONCURRENTLY IF EXISTS ${NODES_VALUE_INDEX}`);
    }
    await session.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${NODES_VALUE_INDEX} ON ${T.nodes} USING hash (${C.value})`,
    );
}

/** True when the index exists, and on Postgres is valid. */
export async function isPresent(knex: Knex, pg: boolean): Promise<boolean> {
    if (!pg) {
        const rows = await knex.raw<{ name: string }[]>(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
            [NODES_VALUE_INDEX],
        );
        return rows.length > 0;
    }
    const res = await knex.raw<{ rows: { valid: boolean }[] }>(
        "SELECT i.indisvalid AS valid FROM pg_index i WHERE i.indexrelid = to_regclass(?)",
        [NODES_VALUE_INDEX],
    );
    return res.rows[0]?.valid === true;
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP INDEX IF EXISTS ${NODES_VALUE_INDEX}`);
}
