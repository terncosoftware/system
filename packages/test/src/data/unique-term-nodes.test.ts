/**
 * One node per IRI and per blank node id (migration 007).
 *
 * Two processes interning the same IRI at once each found nothing and each
 * inserted it, because the only unique index on nodes treats the null columns
 * of an IRI row as distinct. These pin the per-kind unique indexes, that two
 * concurrent transactions interning one IRI end with one row and agree on its
 * id, and that the migration merges duplicates an older database already
 * holds. Postgres gets one fresh database per test.
 */

import { randomUUID } from "node:crypto";
import type { IRI } from "@terncosoftware/core";
import {
    createDataContext,
    DATA_MIGRATION_LEDGER,
    type Knex,
    type PgConfig,
    runDataMigrations,
    TripleStore,
} from "@terncosoftware/data";
import { buildServerContext } from "@terncosoftware/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
    NODES_BLANK_UNIQUE_INDEX,
    NODES_IRI_UNIQUE_INDEX,
} from "../../../data/src/migrations/007_unique_term_nodes.js";

const MIGRATION = "007_unique_term_nodes";

function iri(value: string): IRI {
    return { value } as IRI;
}

describe("unique term nodes — SQLite (in-memory)", () => {
    let knex: Knex;

    beforeEach(async () => {
        knex = await createDataContext({ client: "sqlite", filename: ":memory:" });
    });

    afterEach(async () => {
        await knex.destroy();
    });

    it("creates both indexes on connect and records the migration", async () => {
        const rows = await knex.raw<{ name: string }[]>(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?)",
            [NODES_IRI_UNIQUE_INDEX, NODES_BLANK_UNIQUE_INDEX],
        );
        expect(rows).toHaveLength(2);
        expect(await knex(DATA_MIGRATION_LEDGER).where({ name: MIGRATION }).first()).toBeDefined();
    });

    it("refuses a second row for one IRI", async () => {
        await knex("nodes").insert({ kind: "iri", iri: "urn:test:one" });
        await expect(knex("nodes").insert({ kind: "iri", iri: "urn:test:one" })).rejects.toThrow();
    });

    it("interns an IRI once through the store", async () => {
        const store = new TripleStore(knex);
        const ctx = buildServerContext(store, {});
        const first = await store.ensureNode(ctx, iri("urn:test:interned"));
        const second = await store.ensureNode(ctx, iri("urn:test:interned"));
        expect(second).toBe(first);
    });
});

// Postgres-only: skipped (and reported as skipped) when SYS_PG_URL is unset.
const PG_URL = process.env.SYS_PG_URL ?? "";

function pgConfig(database: string): PgConfig {
    const url = new URL(PG_URL);
    return {
        client: "pg",
        host: url.hostname,
        port: url.port ? Number(url.port) : 5432,
        database,
        user: url.username,
        password: url.password,
    };
}

describe.skipIf(PG_URL === "")("unique term nodes — Postgres", () => {
    let admin: Knex;
    let database: string;
    let knex: Knex;

    beforeAll(async () => {
        admin = await createDataContext(pgConfig(new URL(PG_URL).pathname.slice(1)));
    });

    afterAll(async () => {
        await admin.destroy();
    });

    beforeEach(async () => {
        database = `sys_unique_term_${randomUUID().replace(/-/g, "")}`;
        await admin.raw(`CREATE DATABASE "${database}"`);
        knex = await createDataContext(pgConfig(database));
    });

    afterEach(async () => {
        await knex.destroy();
        await admin.raw(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    });

    async function nodesFor(value: string): Promise<number[]> {
        return knex("nodes").where({ kind: "iri", iri: value }).orderBy("id").pluck("id");
    }

    it("two concurrent transactions interning one IRI end with one row and one id", async () => {
        // Two connections, as two processes are: each transaction's insert is
        // invisible to the other until it commits.
        const other = await createDataContext(pgConfig(database));
        try {
            const storeA = new TripleStore(knex);
            const storeB = new TripleStore(other);
            const trxA = await knex.transaction();
            const trxB = await other.transaction();
            const term = iri("urn:test:raced");

            const idA = await storeA.ensureNode(buildServerContext(storeA, { trx: trxA }), term);
            const pendingB = storeB.ensureNode(buildServerContext(storeB, { trx: trxB }), term);
            await trxA.commit();
            const idB = await pendingB;
            await trxB.commit();

            expect(idB).toBe(idA);
            expect(await nodesFor("urn:test:raced")).toEqual([idA]);
        } finally {
            await other.destroy();
        }
    });

    it("merges the duplicates an older database holds into the lowest id", async () => {
        await knex.raw(`DROP INDEX ${NODES_IRI_UNIQUE_INDEX}`);
        await knex(DATA_MIGRATION_LEDGER).where({ name: MIGRATION }).delete();
        const [keep, dup, predicate, graph, object] = await Promise.all(
            [
                "urn:test:dup",
                "urn:test:dup",
                "urn:test:predicate",
                "urn:test:graph",
                "urn:test:object",
            ].map(async (value) => {
                const [row] = await knex("nodes")
                    .insert({ kind: "iri", iri: value })
                    .returning("id");
                return (row as { id: number }).id;
            }),
        );
        const ids = [keep, dup].sort((a, b) => (a as number) - (b as number)) as number[];
        await knex("edges").insert([
            { subject: ids[1], predicate, object, graph },
            { subject: object, predicate, object: ids[1], graph },
        ]);

        await runDataMigrations(knex);

        expect(await nodesFor("urn:test:dup")).toEqual([ids[0]]);
        expect(await knex("edges").where({ subject: ids[0] }).count("* as n")).toEqual([
            { n: "1" },
        ]);
        expect(await knex("edges").where({ object: ids[0] }).count("* as n")).toEqual([{ n: "1" }]);
        const valid = await knex.raw<{ rows: { valid: boolean }[] }>(
            "SELECT i.indisvalid AS valid FROM pg_index i WHERE i.indexrelid = to_regclass(?)",
            [NODES_IRI_UNIQUE_INDEX],
        );
        expect(valid.rows[0]?.valid).toBe(true);
        expect(await knex(DATA_MIGRATION_LEDGER).pluck("name")).toContain(MIGRATION);
    });
});
