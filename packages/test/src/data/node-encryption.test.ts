/**
 * TRN-191: nodes encryption-column migration.
 *
 * Verifies the additive `is_encrypted` / `key_id` columns exist with the right
 * defaults, and that the migration is idempotent (re-running it is a no-op, as
 * it must be for a database that predates the migrations ledger). Runs against
 * SQLite always and Postgres when SYS_PG_URL is set.
 */

import { createDataContext } from "@terncosoftware/data";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up as migrate004 } from "../../../data/src/migrations/004_node_encryption.js";

interface Provider {
    name: string;
    create(): Promise<Knex>;
}

const providers: Provider[] = [
    {
        name: "SQLite (in-memory)",
        create: () => createDataContext({ client: "sqlite", filename: ":memory:" }),
    },
];

if (process.env.SYS_PG_URL) {
    const url = new URL(process.env.SYS_PG_URL);
    providers.push({
        name: "Postgres",
        create: () =>
            createDataContext({
                client: "pg",
                host: url.hostname,
                port: url.port ? Number(url.port) : 5432,
                database: url.pathname.slice(1),
                user: url.username,
                password: url.password,
            }),
    });
}

for (const provider of providers) {
    describe(`nodes encryption columns — ${provider.name}`, () => {
        let knex: Knex;

        beforeEach(async () => {
            knex = await provider.create();
        });

        afterEach(async () => {
            await knex.destroy();
        });

        it("adds is_encrypted and key_id to nodes", async () => {
            expect(await knex.schema.hasColumn("nodes", "is_encrypted")).toBe(true);
            expect(await knex.schema.hasColumn("nodes", "key_id")).toBe(true);
        });

        it("defaults is_encrypted to false and key_id to null on insert", async () => {
            const [row] = await knex("nodes")
                .insert({ kind: "literal", value: "plain" })
                .returning(["is_encrypted", "key_id"]);
            // SQLite returns 0/1 for booleans; Postgres returns true/false.
            expect(row.is_encrypted === false || row.is_encrypted === 0).toBe(true);
            expect(row.key_id).toBeNull();
        });

        it("stores an encrypted-literal row with a key id", async () => {
            await knex("nodes").insert({
                kind: "literal",
                value: "v1:deadbeef",
                is_encrypted: true,
                key_id: "k1",
            });
            const row = await knex("nodes").where({ key_id: "k1" }).first();
            expect(row.is_encrypted === true || row.is_encrypted === 1).toBe(true);
            expect(row.value).toBe("v1:deadbeef");
        });

        it("is idempotent — re-running migrate004 does not throw", async () => {
            await migrate004(knex);
            await migrate004(knex);
            expect(await knex.schema.hasColumn("nodes", "is_encrypted")).toBe(true);
        });
    });
}
