/**
 * Batched edge traversal (ctx.related / EntityStore.related).
 *
 * Loads the far side of an "out" edge for many source records in one round-trip,
 * grouped by source id — the no-N+1 way to walk a level of the graph.
 * Runs against SQLite (always) and Postgres (when SYS_PG_URL is set).
 */

import { IRI } from "@terncosoftware/core";
import { TripleStore } from "@terncosoftware/data";
import { EntitySchema } from "@terncosoftware/entities";
import { buildServerContext, EntityStore, type ServerContext } from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";

const NS = "http://test.dev/rel/";
interface AuthorProps extends Record<string, unknown> {
    name: string;
}
interface BookProps extends Record<string, unknown> {
    title: string;
}
const AuthorSchema = new EntitySchema<AuthorProps>({
    typeIRI: new IRI(`${NS}Author`),
    ns: NS,
    properties: { name: new IRI(`${NS}name`) },
});
const BookSchema = new EntitySchema<BookProps>({
    typeIRI: new IRI(`${NS}Book`),
    ns: NS,
    properties: { title: new IRI(`${NS}title`) },
    edges: {
        author: {
            predicate: new IRI(`${NS}writtenBy`),
            target: () => AuthorSchema,
            cardinality: "one",
            direction: "out",
        },
        // inbound — related() should refuse this
        readers: {
            predicate: new IRI(`${NS}readBy`),
            target: () => AuthorSchema,
            cardinality: "many",
            direction: "in",
        },
    },
});

interface Provider {
    name: string;
    create(): Promise<Knex>;
}
const providers: Provider[] = [
    {
        name: "SQLite",
        create: () => createTestDataContext({ client: "sqlite", filename: ":memory:" }),
    },
];
if (process.env.SYS_PG_URL) {
    const url = new URL(process.env.SYS_PG_URL);
    providers.push({
        name: "Postgres",
        create: () =>
            createTestDataContext({
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
    describe(`ctx.related — ${provider.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let es: EntityStore;
        let ctx: ServerContext;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            const store = new TripleStore(knex);
            es = new EntityStore(store);
            ctx = buildServerContext(store, { trx });
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("batches an out-edge across many records, grouped by source id", async () => {
            const a1 = await es.create(ctx, AuthorSchema, { name: "Author One" });
            const a2 = await es.create(ctx, AuthorSchema, { name: "Author Two" });
            const b1 = await es.create(ctx, BookSchema, { title: "B1", author: a1.id });
            const b2 = await es.create(ctx, BookSchema, { title: "B2", author: a1.id });
            const b3 = await es.create(ctx, BookSchema, { title: "B3", author: a2.id });

            const books = [b1, b2, b3];
            const byId = await ctx.related<AuthorProps>(books, BookSchema, "author");

            expect(byId.get(b1.id)?.map((r) => r.props.name)).toEqual(["Author One"]);
            expect(byId.get(b2.id)?.map((r) => r.props.name)).toEqual(["Author One"]);
            expect(byId.get(b3.id)?.map((r) => r.props.name)).toEqual(["Author Two"]);
        });

        it("returns an empty list for a source with no edge", async () => {
            const orphan = await es.create(ctx, BookSchema, { title: "Orphan" });
            const byId = await ctx.related<AuthorProps>([orphan], BookSchema, "author");
            expect(byId.get(orphan.id)).toEqual([]);
        });

        it("refuses inbound edges (use connectedTo instead)", async () => {
            const b = await es.create(ctx, BookSchema, { title: "X" });
            await expect(ctx.related([b], BookSchema, "readers")).rejects.toThrow(/inbound/);
        });

        it("throws on an undeclared edge", async () => {
            const b = await es.create(ctx, BookSchema, { title: "X" });
            await expect(ctx.related([b], BookSchema, "nope")).rejects.toThrow(/no edge "nope"/);
        });
    });
}
