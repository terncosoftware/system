/**
 * TRN-1117: the literal-lookup index on nodes.value.
 *
 * Without it, interning a literal walks every literal through the unique
 * (kind, iri, ...) index, because literals have a null iri. These tests pin
 * that the index exists, that Postgres actually plans the intern lookup
 * through it, and that the ledger runs it once and heals an INVALID index
 * left by a failed concurrent build. Postgres gets one fresh database per
 * test, since the build runs on connect and the heal test breaks the index.
 */

import { randomUUID } from "node:crypto";
import {
    createDataContext,
    DATA_MIGRATION_LEDGER,
    DATA_MIGRATION_NAMES,
    type Knex,
    type PgConfig,
    runDataMigrations,
} from "@terncosoftware/data";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NODES_VALUE_INDEX } from "../../../data/src/migrations/005_nodes_value_index.js";

const MIGRATION = "005_nodes_value_index";

describe("nodes value index — SQLite (in-memory)", () => {
    let knex: Knex;

    beforeEach(async () => {
        knex = await createDataContext({ client: "sqlite", filename: ":memory:" });
    });

    afterEach(async () => {
        await knex.destroy();
    });

    it("creates the index on connect and records it", async () => {
        const rows = await knex.raw(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
            [NODES_VALUE_INDEX],
        );
        expect(rows).toHaveLength(1);
        expect(await knex(DATA_MIGRATION_LEDGER).where({ name: MIGRATION }).first()).toBeDefined();
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

describe.skipIf(PG_URL === "")("nodes value index — Postgres", () => {
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
        database = `sys_value_idx_${randomUUID().replace(/-/g, "")}`;
        await admin.raw(`CREATE DATABASE "${database}"`);
        knex = await createDataContext(pgConfig(database));
    });

    afterEach(async () => {
        await knex.destroy();
        await admin.raw(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    });

    async function indexState(): Promise<{ valid: boolean; method: string } | undefined> {
        const res = await knex.raw<{ rows: { valid: boolean; method: string }[] }>(
            `SELECT i.indisvalid AS valid, am.amname AS method
               FROM pg_index i
               JOIN pg_class c ON c.oid = i.indexrelid
               JOIN pg_am am ON am.oid = c.relam
              WHERE i.indexrelid = to_regclass(?)`,
            [NODES_VALUE_INDEX],
        );
        return res.rows[0];
    }

    it("creates a valid hash index on connect and records it", async () => {
        expect(await indexState()).toEqual({ valid: true, method: "hash" });
        expect(await knex(DATA_MIGRATION_LEDGER).pluck("name")).toContain(MIGRATION);
    });

    it("plans the intern lookup through the index, not a walk of every literal", async () => {
        const dt = "urn:test:trn-1117:dt";
        const rows = Array.from({ length: 20_000 }, (_, i) => ({
            kind: "literal",
            value: `v-${i}`,
            dt,
        }));
        for (let i = 0; i < rows.length; i += 1_000) {
            await knex("nodes").insert(rows.slice(i, i + 1_000));
        }
        await knex.raw("ANALYZE nodes");

        const res = await knex.raw<{ rows: { "QUERY PLAN": string }[] }>(
            "EXPLAIN SELECT * FROM nodes WHERE kind = ? AND value = ? AND dt = ? AND lang IS NULL LIMIT 1",
            ["literal", "v-12345", dt],
        );
        const plan = res.rows.map((r) => r["QUERY PLAN"]).join("\n");
        expect(plan).toContain(NODES_VALUE_INDEX);
    });

    it("a re-run leaves a valid index alone", async () => {
        const [before] = (
            await knex.raw<{ rows: { oid: number }[] }>("SELECT to_regclass(?)::oid AS oid", [
                NODES_VALUE_INDEX,
            ])
        ).rows;
        await knex(DATA_MIGRATION_LEDGER).where({ name: MIGRATION }).delete();

        await runDataMigrations(knex);

        const [after] = (
            await knex.raw<{ rows: { oid: number }[] }>("SELECT to_regclass(?)::oid AS oid", [
                NODES_VALUE_INDEX,
            ])
        ).rows;
        expect(after?.oid).toBe(before?.oid);
        expect(await indexState()).toEqual({ valid: true, method: "hash" });
        expect(await knex(DATA_MIGRATION_LEDGER).pluck("name")).toContain(MIGRATION);
    });

    it("rebuilds an INVALID index left by a failed concurrent build", async () => {
        // What a crashed CREATE INDEX CONCURRENTLY leaves behind, with no ledger
        // row since the build never finished. IF NOT EXISTS alone would skip it
        // forever. Needs a superuser, as the test role is.
        await knex.raw("UPDATE pg_index SET indisvalid = false WHERE indexrelid = to_regclass(?)", [
            NODES_VALUE_INDEX,
        ]);
        await knex(DATA_MIGRATION_LEDGER).where({ name: MIGRATION }).delete();
        expect((await indexState())?.valid).toBe(false);

        await runDataMigrations(knex);

        expect(await indexState()).toEqual({ valid: true, method: "hash" });
    });

    it("builds the index once when connects race on a fresh database", async () => {
        const fresh = `sys_value_idx_${randomUUID().replace(/-/g, "")}`;
        await admin.raw(`CREATE DATABASE "${fresh}"`);
        const racers: Knex[] = [];
        try {
            // Allocated up front so a failed connect still leaves its siblings
            // to close; each connect migrates, and they contend on one lock.
            const results = await Promise.allSettled(
                Array.from({ length: 4 }, () => createDataContext(pgConfig(fresh))),
            );
            for (const r of results) {
                if (r.status === "fulfilled") {
                    racers.push(r.value);
                }
            }
            expect(results.map((r) => r.status)).toEqual(Array(4).fill("fulfilled"));

            const [first] = racers;
            if (!first) {
                throw new Error("no connect succeeded");
            }
            expect(await first(DATA_MIGRATION_LEDGER).orderBy("name").pluck("name")).toEqual(
                [...DATA_MIGRATION_NAMES].sort(),
            );
            const valid = await first.raw<{ rows: { valid: boolean }[] }>(
                "SELECT i.indisvalid AS valid FROM pg_index i WHERE i.indexrelid = to_regclass(?)",
                [NODES_VALUE_INDEX],
            );
            expect(valid.rows).toEqual([{ valid: true }]);
        } finally {
            for (const r of racers) {
                await r.destroy();
            }
            await admin.raw(`DROP DATABASE IF EXISTS "${fresh}" WITH (FORCE)`);
        }
    });
});
