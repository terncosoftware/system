/**
 * Data migrations ledger (system GH #129).
 *
 * createDataContext used to re-run every migration on each connect, and
 * 002_fix_nodes rewrote every literal node each time. It now records each
 * migration in `sys_data_migrations` and runs it once per database. A database
 * that predates the ledger has every migration applied already, so the first
 * run backfills the ledger from the schema it finds instead of re-running them.
 *
 * Real Postgres, one fresh database per test. Rewrites are detected by a row's
 * xmin, which changes whenever Postgres writes a new version of the row.
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
import { up as migrate002 } from "../../../data/src/migrations/002_fix_nodes.js";

// Same resolution as the other real-infrastructure suites: the env var wins,
// else the shared dev/CI default.
const PG_URL = new URL(process.env.SYS_PG_URL ?? "postgresql://sys:sys@localhost:5432/sys");

function pgConfig(database: string): PgConfig {
    return {
        client: "pg",
        host: PG_URL.hostname,
        port: PG_URL.port ? Number(PG_URL.port) : 5432,
        database,
        user: PG_URL.username,
        password: PG_URL.password,
    };
}

async function ledger(knex: Knex): Promise<string[]> {
    return knex(DATA_MIGRATION_LEDGER).orderBy("name").pluck("name");
}

/** Each node's row version: a rewrite of the row changes its xmin. */
async function nodeVersions(knex: Knex): Promise<Record<number, string>> {
    const rows = (await knex.raw("SELECT id, xmin::text AS xmin FROM nodes ORDER BY id")).rows as {
        id: number;
        xmin: string;
    }[];
    return Object.fromEntries(rows.map((r) => [r.id, r.xmin]));
}

/** Runs `fn` against `knex`, returning every SQL statement it issued. */
async function captureSql(knex: Knex, fn: () => Promise<void>): Promise<string[]> {
    const sql: string[] = [];
    const listener = (event: { sql: string }) => sql.push(event.sql);
    knex.on("query", listener);
    try {
        await fn();
    } finally {
        knex.off("query", listener);
    }
    return sql;
}

async function insertLiterals(knex: Knex, count: number): Promise<void> {
    await knex("nodes").insert(
        Array.from({ length: count }, (_, i) => ({
            kind: "literal",
            value: `ledger-${i}`,
            dt: "http://www.w3.org/2001/XMLSchema#string",
            value_json: JSON.stringify({ v: `ledger-${i}` }),
        })),
    );
}

describe("data migrations ledger (real Postgres)", () => {
    let admin: Knex;
    let database: string;
    const open: Knex[] = [];

    async function connect(): Promise<Knex> {
        const knex = await createDataContext(pgConfig(database));
        open.push(knex);
        return knex;
    }

    beforeAll(async () => {
        admin = await createDataContext(pgConfig(PG_URL.pathname.slice(1)));
    });

    afterAll(async () => {
        await admin.destroy();
    });

    beforeEach(async () => {
        database = `sys_ledger_${randomUUID().replace(/-/g, "")}`;
        await admin.raw(`CREATE DATABASE "${database}"`);
    });

    afterEach(async () => {
        for (const knex of open.splice(0)) {
            await knex.destroy();
        }
        await admin.raw(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    });

    it("migrates a fresh database and records every migration", async () => {
        const knex = await connect();

        expect(await ledger(knex)).toEqual([...DATA_MIGRATION_NAMES].sort());
        expect(await knex.schema.hasColumn("nodes", "dt")).toBe(true);
        expect(await knex.schema.hasColumn("nodes", "datatype")).toBe(false);
        expect(await knex.schema.hasColumn("nodes", "is_encrypted")).toBe(true);
        expect(await knex.schema.hasTable("sys_job_run")).toBe(true);
        // 001 seeds literals with `dt` inside value_json; 002 strips it.
        const withDt = await knex("nodes")
            .whereRaw("value_json \\? 'dt'")
            .count<{ count: string }[]>("* as count");
        expect(Number(withDt[0]?.count)).toBe(0);
    });

    it("runs no migration SQL when nothing is pending", async () => {
        const first = await connect();
        await insertLiterals(first, 20);
        const before = await nodeVersions(first);

        const second = await connect();
        expect(await nodeVersions(second)).toEqual(before);

        const sql = await captureSql(second, () => runDataMigrations(second));
        // Only the ledger reads: does it exist, and what does it hold.
        expect(sql).toHaveLength(2);
        expect(sql.every((s) => /^select\b/i.test(s.trim()))).toBe(true);
        expect(sql.some((s) => /advisory|nodes|edges|namespaces/i.test(s))).toBe(false);
        expect(await nodeVersions(second)).toEqual(before);
    });

    it("backfills the ledger of a pre-ledger database without rewriting nodes", async () => {
        const knex = await connect();
        await insertLiterals(knex, 50);
        // A database migrated before the ledger existed: all schema, no ledger.
        await knex.schema.dropTable(DATA_MIGRATION_LEDGER);
        const before = await nodeVersions(knex);

        const sql = await captureSql(knex, () => runDataMigrations(knex));

        expect(await ledger(knex)).toEqual([...DATA_MIGRATION_NAMES].sort());
        expect(await nodeVersions(knex)).toEqual(before);
        // The capture sees the ledger lock and the migration transactions too.
        expect(sql.some((s) => /pg_try_advisory_lock/.test(s))).toBe(true);
        const writes = sql.filter((s) =>
            /^\s*(update|delete|alter|drop)\b|create (or replace )?(trigger|function)/i.test(s),
        );
        expect(writes).toEqual([]);

        // And the next connect finds nothing pending.
        const next = await connect();
        expect(await nodeVersions(next)).toEqual(before);
    });

    it("runs a migration whose effects a pre-ledger database lacks", async () => {
        const knex = await connect();
        // A database last migrated before 004: no ledger, no encryption columns.
        await knex.schema.dropTable(DATA_MIGRATION_LEDGER);
        await knex.schema.alterTable("nodes", (t) => {
            t.dropColumn("is_encrypted");
            t.dropColumn("key_id");
        });

        const next = await connect();

        expect(await ledger(next)).toEqual([...DATA_MIGRATION_NAMES].sort());
        expect(await next.schema.hasColumn("nodes", "is_encrypted")).toBe(true);
        expect(await next.schema.hasColumn("nodes", "key_id")).toBe(true);
    });

    it("applies each migration once when connects race on a fresh database", async () => {
        await Promise.all(Array.from({ length: 4 }, () => connect()));

        const knex = await connect();
        // The ledger's primary key would reject a second row for any name.
        expect(await ledger(knex)).toEqual([...DATA_MIGRATION_NAMES].sort());
        const rbac = await knex("namespaces")
            .where({ prefix: "rbac" })
            .count<{ count: string }[]>("* as count");
        expect(Number(rbac[0]?.count)).toBe(1);
    });

    it("002 rewrites only literals that still carry dt", async () => {
        const knex = await connect();
        await insertLiterals(knex, 5);
        const [stale] = await knex("nodes")
            .insert({
                kind: "literal",
                value: "stale",
                dt: "http://www.w3.org/2001/XMLSchema#string",
                value_json: JSON.stringify({
                    v: "stale",
                    dt: "http://www.w3.org/2001/XMLSchema#string",
                }),
            })
            .returning("id");
        const staleId = (stale as { id: number }).id;
        const before = await nodeVersions(knex);

        await migrate002(knex);

        const after = await nodeVersions(knex);
        const row = await knex("nodes").where({ id: staleId }).first("value_json");
        expect(row.value_json).toEqual({ v: "stale" });
        expect(after[staleId]).not.toBe(before[staleId]);
        const { [staleId]: _rewritten, ...untouched } = after;
        const { [staleId]: _original, ...expected } = before;
        expect(untouched).toEqual(expected);

        // A re-run finds nothing to fix and writes nothing.
        await migrate002(knex);
        expect(await nodeVersions(knex)).toEqual(after);
    });
});
