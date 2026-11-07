import type { Knex } from "knex";
import { C, T } from "../schema.js";
import type { PgSession } from "./005_nodes_value_index.js";

export const NODES_IRI_UNIQUE_INDEX = "nodes_iri_unique";
export const NODES_BLANK_UNIQUE_INDEX = "nodes_blank_unique";

/** The two interned kinds, each unique on its own column. */
const TERMS = [
    { kind: "iri", column: C.iri, index: NODES_IRI_UNIQUE_INDEX },
    { kind: "blank", column: C.blankId, index: NODES_BLANK_UNIQUE_INDEX },
] as const;

/** A ceiling on build attempts: a duplicate interned between merge and build fails it. */
const MAX_BUILD_ATTEMPTS = 3;

/**
 * One node per IRI and one per blank node id.
 *
 * TripleStore interns an IRI or a blank node by looking it up and inserting it
 * when none is found. The only unique index on nodes, (kind, iri, blank_id,
 * value, dt, lang), never refused a second one: an IRI's other columns are
 * null, and Postgres and SQLite both treat nulls as distinct. Two processes
 * interning the same IRI at once each found nothing and each inserted it.
 * Every lookup of that IRI then resolved to whichever row came back first, so
 * a query keyed on one row missed the edges written under the other. A
 * hermetic E2E run with three workers lost every session that way: the
 * session-token predicate had two rows, and the server read the other one.
 *
 * Each duplicate is merged into the lowest id (its edges repointed, the row
 * deleted), and a partial unique index per kind refuses the next one, which
 * TripleStore's insert then reads back as the winner.
 */
export async function up(knex: Knex): Promise<void> {
    for (const term of TERMS) {
        await mergeDuplicates(
            (sql, values) => knex.raw(sql, (values ?? []) as Knex.RawBinding[]),
            term,
        );
        await knex.raw(
            `CREATE UNIQUE INDEX IF NOT EXISTS ${term.index} ON ${T.nodes} (${term.column}) WHERE ${C.kind} = '${term.kind}'`,
        );
    }
}

/**
 * The Postgres build. CONCURRENTLY, because a plain CREATE INDEX blocks every
 * write to nodes while it scans the table. The merge runs in its own
 * transaction just before each build; a process that interns a duplicate in
 * between fails the build, which leaves an INVALID index, so that one is
 * dropped, the merge repeated and the build retried.
 */
export async function upConcurrently(session: PgSession): Promise<void> {
    const run = (sql: string, values?: readonly unknown[]) => session.query(sql, values);
    for (const term of TERMS) {
        for (let attempt = 1; ; attempt++) {
            if (await indexValid(session, term.index)) {
                break;
            }
            await session.query(`DROP INDEX CONCURRENTLY IF EXISTS ${term.index}`);
            await session.query("BEGIN");
            try {
                await mergeDuplicates(run, term);
                await session.query("COMMIT");
            } catch (e) {
                await session.query("ROLLBACK");
                throw e;
            }
            try {
                await session.query(
                    `CREATE UNIQUE INDEX CONCURRENTLY ${term.index} ON ${T.nodes} (${term.column}) WHERE ${C.kind} = '${term.kind}'`,
                );
            } catch (e) {
                if (attempt >= MAX_BUILD_ATTEMPTS) {
                    throw e;
                }
            }
        }
    }
}

/** True when both indexes exist, and on Postgres are valid. */
export async function isPresent(knex: Knex, pg: boolean): Promise<boolean> {
    for (const term of TERMS) {
        if (pg) {
            const res = await knex.raw<{ rows: { valid: boolean }[] }>(
                "SELECT i.indisvalid AS valid FROM pg_index i WHERE i.indexrelid = to_regclass(?)",
                [term.index],
            );
            if (res.rows[0]?.valid !== true) {
                return false;
            }
        } else {
            const rows = await knex.raw<{ name: string }[]>(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
                [term.index],
            );
            if (rows.length === 0) {
                return false;
            }
        }
    }
    return true;
}

export async function down(knex: Knex): Promise<void> {
    for (const term of TERMS) {
        await knex.raw(`DROP INDEX IF EXISTS ${term.index}`);
    }
}

async function indexValid(session: PgSession, index: string): Promise<boolean> {
    const { rows } = await session.query<{ valid: boolean }>(
        "SELECT i.indisvalid AS valid FROM pg_index i WHERE i.indexrelid = to_regclass($1)",
        [index],
    );
    return rows[0]?.valid === true;
}

/**
 * Repoint every edge from each duplicate of a term to the term's lowest id,
 * then delete the duplicates. Plain SQL both engines run; a no-op when there
 * are none.
 */
async function mergeDuplicates(
    run: (sql: string, values?: readonly unknown[]) => Promise<unknown>,
    term: (typeof TERMS)[number],
): Promise<void> {
    const merge = `merge_${term.kind}_nodes`;
    await run(`DROP TABLE IF EXISTS ${merge}`);
    await run(
        `CREATE TEMPORARY TABLE ${merge} AS
         SELECT d.${C.id} AS dup, k.keep AS keep
         FROM ${T.nodes} d
         JOIN (
             SELECT ${term.column} AS term, MIN(${C.id}) AS keep
             FROM ${T.nodes}
             WHERE ${C.kind} = '${term.kind}'
             GROUP BY ${term.column}
             HAVING COUNT(*) > 1
         ) k ON d.${term.column} = k.term
         WHERE d.${C.kind} = '${term.kind}' AND d.${C.id} <> k.keep`,
    );
    for (const column of [C.subject, C.predicate, C.object, C.graph]) {
        await run(
            `UPDATE ${T.edges}
             SET ${column} = (SELECT keep FROM ${merge} WHERE dup = ${T.edges}.${column})
             WHERE ${column} IN (SELECT dup FROM ${merge})`,
        );
    }
    await run(`DELETE FROM ${T.nodes} WHERE ${C.id} IN (SELECT dup FROM ${merge})`);
    await run(`DROP TABLE ${merge}`);
}
