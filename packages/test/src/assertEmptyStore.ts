import { createDataContext, type DataConfig } from "@terncosoftware/data";
import type { Knex } from "knex";

const STORE_TABLES = ["edges", "nodes", "namespaces"] as const;

const baselines = new WeakMap<Knex, Record<string, number>>();

async function countStore(knex: Knex): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of STORE_TABLES) {
        const [row] = await knex(table).count<{ count: string }[]>("* as count");
        counts[table] = Number(row?.count ?? 0);
    }
    return counts;
}

/**
 * createDataContext for a suite that calls assertEmptyStore: also records the
 * store's row counts as the baseline a clean suite must return to. Counting is
 * a test concern, so createDataContext itself never scans the store.
 */
export async function createTestDataContext(config: DataConfig): Promise<Knex> {
    const knex = await createDataContext(config);
    baselines.set(knex, await countStore(knex));
    return knex;
}

/**
 * Asserts the quad store contains no rows beyond the baseline recorded when
 * createTestDataContext connected.
 *
 * Call this in a DB suite's `afterEach`, AFTER the test transaction has rolled
 * back but BEFORE `knex.destroy()`. Because every test runs inside a
 * transaction that is rolled back, a clean suite returns to the baseline left
 * by migrations. Any count above (or below) baseline means a query committed
 * OUTSIDE the transaction — a leak that silently breaks isolation on a shared
 * database (Postgres) even though SQLite's fresh-:memory:-per-test hides it.
 * Failing loudly here pinpoints the suite.
 */
export async function assertEmptyStore(knex: Knex): Promise<void> {
    const baseline = baselines.get(knex);
    if (!baseline) {
        throw new Error(
            "No store baseline for this connection: open it with createTestDataContext",
        );
    }
    const counts = await countStore(knex);
    const dirty: string[] = [];
    for (const table of STORE_TABLES) {
        if (counts[table] !== baseline[table]) {
            dirty.push(`${table}=${counts[table]}`);
        }
    }
    if (dirty.length > 0) {
        throw new Error(
            `Store not empty after rollback — query(s) leaked outside the test transaction: ${dirty.join(", ")}`,
        );
    }
}

/**
 * Asserts that every node and edge in the store is well-formed.
 *
 * Call this BEFORE rolling back the test transaction so any violation is caught
 * while the data is still visible.  Catches bugs that would otherwise silently
 * produce garbage rows.
 *
 * Invariants checked:
 *   - IRI nodes have a non-null `iri` column
 *   - Blank nodes have a non-null `blank_id` column
 *   - Literal nodes have a non-null `value` column
 *   - No edges have a null `graph` — every quad must be in a named graph
 *     (quads in the RDF default graph use the urn:sys:graph:default node)
 */
export async function assertStoreIntegrity(knex: Knex): Promise<void> {
    const violations: string[] = [];

    const badIri = await knex("nodes")
        .where({ kind: "iri" })
        .whereNull("iri")
        .count<[{ count: string | number }]>("* as count")
        .first();
    if (Number(badIri?.count ?? 0) > 0) {
        violations.push(`${badIri?.count} IRI nodes with null iri`);
    }

    const badBlank = await knex("nodes")
        .where({ kind: "blank" })
        .whereNull("blank_id")
        .count<[{ count: string | number }]>("* as count")
        .first();
    if (Number(badBlank?.count ?? 0) > 0) {
        violations.push(`${badBlank?.count} blank nodes with null blank_id`);
    }

    const badLiteral = await knex("nodes")
        .where({ kind: "literal" })
        .whereNull("value")
        .count<[{ count: string | number }]>("* as count")
        .first();
    if (Number(badLiteral?.count ?? 0) > 0) {
        violations.push(`${badLiteral?.count} literal nodes with null value`);
    }

    const nullGraph = await knex("edges")
        .whereNull("graph")
        .count<[{ count: string | number }]>("* as count")
        .first();
    if (Number(nullGraph?.count ?? 0) > 0) {
        violations.push(`${nullGraph?.count} edges with null graph`);
    }

    if (violations.length > 0) {
        throw new Error(`Store integrity violations: ${violations.join("; ")}`);
    }
}
